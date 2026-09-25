use crate::api::{
    ApiError, AppState, compress, decompress, profile_user, rate_limit, token_hash, user,
};
use crate::connectome::NeuralState;
use crate::save_validation::{
    generated_instance_id, species_available_in_version, valid_field_record,
    valid_reward_ledger, valid_world_record, validate_save,
};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::Engine;
use flate2::read::GzDecoder;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_ITEM_STOCK: i64 = 1_000_000_000;
/// Checkpoint bounds of the local neural API (`local.rs`), which the receiver's next step enforces.
const MAX_CHECKPOINT_COMPRESSED: usize = 1_500_000;
const MAX_CHECKPOINT_EXPANDED: u64 = 2_000_000;
/// Base64 text of the largest checkpoint that API accepts.
const MAX_CHECKPOINT_TEXT: usize = MAX_CHECKPOINT_COMPRESSED * 4 / 3 + 8;
/// That checkpoint with its receipts, decision and game scope.
const MAX_NEURAL_BYTES: usize = MAX_CHECKPOINT_TEXT + 16_384;
/// An offer is the neural attachment plus a few small fields.
const MAX_REQUEST_BYTES: usize = MAX_NEURAL_BYTES + 65_536;
/// Per ten minutes: the trade window polls about once a second, and reads the result once done.
const CURRENT_POLLS: u32 = 1_200;
const RESULT_READS: u32 = 600;
static MUTATIONS: OnceLock<Mutex<HashMap<Uuid, (Instant, u32)>>> = OnceLock::new();
static SOCKETS: OnceLock<Mutex<HashMap<Uuid, u8>>> = OnceLock::new();
static TRADEABLE_ITEMS: OnceLock<HashSet<String>> = OnceLock::new();

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/trades", post(create_or_join))
        .route("/api/trades/current", get(current))
        .route("/api/trades/live", get(live))
        .route("/api/trades/{id}/offer", post(offer))
        .route("/api/trades/{id}/confirm", post(confirm))
        .route("/api/trades/{id}/cancel", post(cancel))
        .route("/api/trades/{id}/result", get(result))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
}

fn read_rate(state: &AppState, scope: &str, user_id: Uuid, max: u32) -> TradeResult<()> {
    rate_limit(state, format!("{scope}:{user_id}"), max)
        .map_err(|error| TradeError(error.0, error.1, "RATE_LIMIT"))
}

fn worker_failed(error: tokio::task::JoinError) -> TradeError {
    tracing::error!(%error, "Trade worker failed");
    TradeError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "거래 저장소 요청에 실패했습니다.",
        "WORKER",
    )
}

fn mutation_rate(user_id: Uuid) -> TradeResult<()> {
    let mut rates = MUTATIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| {
            TradeError(
                StatusCode::SERVICE_UNAVAILABLE,
                "거래 요청 제한을 확인할 수 없습니다.",
                "RATE_LIMIT",
            )
        })?;
    rates.retain(|_, (started, _)| started.elapsed() < Duration::from_secs(600));
    let row = rates.entry(user_id).or_insert((Instant::now(), 0));
    row.1 += 1;
    if row.1 > 200 {
        return Err(TradeError(
            StatusCode::TOO_MANY_REQUESTS,
            "거래 요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
            "RATE_LIMIT",
        ));
    }
    Ok(())
}

struct SocketGuard(Uuid);
impl SocketGuard {
    fn acquire(user_id: Uuid) -> TradeResult<Self> {
        let mut sockets = SOCKETS.get_or_init(Default::default).lock().map_err(|_| {
            TradeError(
                StatusCode::SERVICE_UNAVAILABLE,
                "거래 연결을 확인할 수 없습니다.",
                "SOCKET_LIMIT",
            )
        })?;
        let count = sockets.entry(user_id).or_default();
        if *count >= 3 {
            return Err(TradeError(
                StatusCode::TOO_MANY_REQUESTS,
                "거래 실시간 연결이 너무 많습니다.",
                "SOCKET_LIMIT",
            ));
        }
        *count += 1;
        Ok(Self(user_id))
    }
}
impl Drop for SocketGuard {
    fn drop(&mut self) {
        if let Ok(mut sockets) = SOCKETS.get_or_init(Default::default).lock() {
            if let Some(count) = sockets.get_mut(&self.0) {
                *count -= 1;
                if *count == 0 {
                    sockets.remove(&self.0);
                }
            }
        }
    }
}

#[derive(Debug)]
struct TradeError(StatusCode, &'static str, &'static str);
impl IntoResponse for TradeError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"message":self.1,"code":self.2}))).into_response()
    }
}
impl From<ApiError> for TradeError {
    fn from(value: ApiError) -> Self {
        Self(value.0, value.1, "AUTH")
    }
}
impl From<sqlx::Error> for TradeError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "Trade database request failed");
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "거래 저장소 요청에 실패했습니다.",
            "DATABASE",
        )
    }
}
type TradeResult<T> = Result<T, TradeError>;
fn invalid(message: &'static str) -> TradeError {
    TradeError(StatusCode::UNPROCESSABLE_ENTITY, message, "INVALID_TRADE")
}
fn conflict(message: &'static str, code: &'static str) -> TradeError {
    TradeError(StatusCode::CONFLICT, message, code)
}
fn missing() -> TradeError {
    TradeError(
        StatusCode::NOT_FOUND,
        "거래를 찾을 수 없습니다.",
        "TRADE_NOT_FOUND",
    )
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
enum EnterRequest {
    Create,
    Join { code: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfferRequest {
    version: i64,
    revision: i64,
    monster_id: Option<String>,
    money: i64,
    #[serde(default)]
    items: Vec<ItemOffer>,
    #[serde(default)]
    neural: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ItemOffer {
    item_id: String,
    quantity: i64,
}

fn tradeable_items() -> &'static HashSet<String> {
    TRADEABLE_ITEMS.get_or_init(|| {
        let rows: Vec<Value> =
            serde_json::from_str(include_str!("../../src/data/field-items.json"))
                .expect("field-items.json must be valid JSON");
        rows.into_iter()
            .map(|row| {
                row.get("id")
                    .and_then(Value::as_str)
                    .expect("each field item must have a string id")
                    .to_owned()
            })
            .collect()
    })
}

#[derive(Deserialize)]
struct VersionRequest {
    version: i64,
}

#[derive(Deserialize, Default)]
struct LiveQuery {
    profile: Option<String>,
}

fn room_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

async fn advisory(tx: &mut Transaction<'_, Postgres>, user_id: Uuid) -> TradeResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("save:{user_id}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn advisory_pair(tx: &mut Transaction<'_, Postgres>, a: Uuid, b: Uuid) -> TradeResult<()> {
    let mut ids = [a, b];
    ids.sort_by_key(|id| id.to_string());
    advisory(tx, ids[0]).await?;
    advisory(tx, ids[1]).await
}

async fn expire_for(tx: &mut Transaction<'_, Postgres>, user_id: Uuid) -> TradeResult<()> {
    sqlx::query("UPDATE trades SET status='expired',version=version+1,updated_at=now() WHERE status IN ('waiting','active') AND expires_at<=now() AND (creator_id=$1 OR joiner_id=$1)")
        .bind(user_id).execute(&mut **tx).await?;
    Ok(())
}

// Every column but the two neural attachments (up to 2 MB each), which only a result reads.
// PostgreSQL cannot decode timestamptz without chrono enabled; select its stable text form.
const ROOM_SELECT: &str = "SELECT t.id,t.code,t.status,t.version,t.expires_at::text expires_at_text,t.creator_id,t.joiner_id,\
t.creator_confirmed,t.joiner_confirmed,t.creator_money,t.joiner_money,t.creator_monster,t.joiner_monster,\
t.creator_items,t.joiner_items,t.creator_revision,t.joiner_revision,t.creator_monster_id,t.joiner_monster_id,\
t.creator_result_revision,t.joiner_result_revision,t.creator_received_monster_id,t.joiner_received_monster_id,\
cu.username creator_username,ju.username joiner_username \
FROM trades t JOIN users cu ON cu.id=t.creator_id LEFT JOIN users ju ON ju.id=t.joiner_id";

async fn row_by_id<'a>(
    tx: &mut Transaction<'a, Postgres>,
    id: Uuid,
    lock: bool,
) -> TradeResult<PgRow> {
    let sql = format!(
        "{ROOM_SELECT} WHERE t.id=$1{}",
        if lock { " FOR UPDATE OF t" } else { "" }
    );
    sqlx::query(&sql)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(missing)
}

fn is_member(row: &PgRow, id: Uuid) -> bool {
    row.get::<Uuid, _>("creator_id") == id || row.try_get::<Uuid, _>("joiner_id").ok() == Some(id)
}
fn side(row: &PgRow, id: Uuid) -> &'static str {
    if row.get::<Uuid, _>("creator_id") == id {
        "creator"
    } else {
        "joiner"
    }
}

fn participant(row: &PgRow, which: &str) -> Option<Value> {
    let id = if which == "creator" {
        Some(row.get::<Uuid, _>("creator_id"))
    } else {
        row.try_get::<Uuid, _>("joiner_id").ok()
    }?;
    let username: String = row.try_get(format!("{which}_username").as_str()).ok()?;
    let monster: Option<Value> = row
        .try_get(format!("{which}_monster").as_str())
        .ok()
        .flatten();
    let items: Value = row
        .try_get(format!("{which}_items").as_str())
        .unwrap_or_else(|_| json!([]));
    Some(json!({
        "side":which,
        "user":{"id":id,"username":username},
        "confirmed":row.get::<bool,_>(format!("{which}_confirmed").as_str()),
        "offer":{"monster":monster,"money":row.get::<i64,_>(format!("{which}_money").as_str()),"items":items}
    }))
}

fn room(row: &PgRow, viewer: Uuid, include_code: bool) -> Value {
    let participants = [participant(row, "creator"), participant(row, "joiner")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let mut trade = json!({
        "id":row.get::<Uuid,_>("id"),
        "status":row.get::<String,_>("status"),
        "version":row.get::<i64,_>("version"),
        "expiresAt":row.get::<String,_>("expires_at_text"),
        "participants":participants
    });
    if include_code && row.get::<Uuid, _>("creator_id") == viewer {
        trade["code"] = json!(row.get::<String, _>("code"));
    }
    trade
}

async fn room_row(db: &sqlx::PgPool, id: Uuid) -> TradeResult<PgRow> {
    let sql = format!("{ROOM_SELECT} WHERE t.id=$1");
    sqlx::query(&sql)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(missing)
}

async fn create_or_join(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EnterRequest>,
) -> TradeResult<Json<Value>> {
    let account = profile_user(&state, &headers).await?;
    mutation_rate(account.id)?;
    let mut tx = state.db.begin().await?;
    match body {
        EnterRequest::Create => {
            advisory(&mut tx, account.id).await?;
            expire_for(&mut tx, account.id).await?;
            if sqlx::query("SELECT 1 FROM trades WHERE status IN ('waiting','active') AND (creator_id=$1 OR joiner_id=$1)").bind(account.id).fetch_optional(&mut *tx).await?.is_some() {
                return Err(conflict("이미 진행 중인 거래가 있습니다.", "ACTIVE_TRADE"));
            }
            let id = Uuid::new_v4();
            let mut inserted = false;
            for _ in 0..4 {
                let code = room_code();
                let result = sqlx::query("INSERT INTO trades(id,code,creator_id) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING")
                    .bind(id).bind(code).bind(account.id).execute(&mut *tx).await?;
                if result.rows_affected() == 1 {
                    inserted = true;
                    break;
                }
            }
            if !inserted {
                return Err(TradeError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "초대 코드를 만들지 못했습니다.",
                    "CODE_GENERATION",
                ));
            }
            tx.commit().await?;
            let row = room_row(&state.db, id).await?;
            let _ = state.trade_events.send(account.id);
            Ok(Json(json!({"trade":room(&row,account.id,true)})))
        }
        EnterRequest::Join { code } => {
            let code = code.trim().to_ascii_uppercase();
            if code.len() != 12
                || !code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            {
                return Err(invalid("초대 코드가 올바르지 않습니다."));
            }
            let initial = sqlx::query("SELECT id,creator_id FROM trades WHERE code=$1")
                .bind(&code)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(missing)?;
            let trade_id: Uuid = initial.get("id");
            let creator: Uuid = initial.get("creator_id");
            if creator == account.id {
                return Err(conflict("자기 계정과 거래할 수 없습니다.", "SELF_TRADE"));
            }
            advisory_pair(&mut tx, creator, account.id).await?;
            expire_for(&mut tx, account.id).await?;
            let row = sqlx::query("SELECT status,joiner_id,expires_at<=now() expired FROM trades WHERE id=$1 FOR UPDATE").bind(trade_id).fetch_one(&mut *tx).await?;
            if row.get::<bool, _>("expired") || row.get::<String, _>("status") != "waiting" {
                return Err(TradeError(
                    StatusCode::GONE,
                    "초대가 만료되었거나 사용할 수 없습니다.",
                    "TRADE_EXPIRED",
                ));
            }
            if row.try_get::<Uuid, _>("joiner_id").ok().is_some() {
                return Err(conflict("이미 참가자가 있는 거래입니다.", "TRADE_FULL"));
            }
            if sqlx::query("SELECT 1 FROM trades WHERE id<>$1 AND status IN ('waiting','active') AND (creator_id=$2 OR joiner_id=$2)").bind(trade_id).bind(account.id).fetch_optional(&mut *tx).await?.is_some() { return Err(conflict("이미 진행 중인 거래가 있습니다.","ACTIVE_TRADE")); }
            sqlx::query("UPDATE trades SET joiner_id=$2,status='active',version=version+1,updated_at=now(),expires_at=now()+interval '10 minutes' WHERE id=$1").bind(trade_id).bind(account.id).execute(&mut *tx).await?;
            tx.commit().await?;
            let row = room_row(&state.db, trade_id).await?;
            let _ = state.trade_events.send(creator);
            let _ = state.trade_events.send(account.id);
            Ok(Json(json!({"trade":room(&row,account.id,false)})))
        }
    }
}

async fn latest_row(state: &AppState, account: Uuid) -> TradeResult<Option<PgRow>> {
    sqlx::query(&format!("{ROOM_SELECT} WHERE t.creator_id=$1 OR t.joiner_id=$1 ORDER BY CASE WHEN t.status IN ('waiting','active') THEN 0 ELSE 1 END,t.updated_at DESC LIMIT 1"))
        .bind(account).fetch_optional(&state.db).await.map_err(Into::into)
}

async fn current(State(state): State<AppState>, headers: HeaderMap) -> TradeResult<Json<Value>> {
    let account = profile_user(&state, &headers).await?;
    read_rate(&state, "trade-current", account.id, CURRENT_POLLS)?;
    let mut tx = state.db.begin().await?;
    advisory(&mut tx, account.id).await?;
    expire_for(&mut tx, account.id).await?;
    tx.commit().await?;
    let Some(row) = latest_row(&state, account.id).await? else {
        return Ok(Json(json!({"trade":null})));
    };
    Ok(Json(json!({"trade":room(&row,account.id,true)})))
}

/// The full connectome behind `/api/connectome`; a traded brain must belong to it.
struct ServerGraph {
    id: String,
    nodes: usize,
    edges: u64,
}

/// `main.rs` loads the connectome from `CONNECTOME_DIR` and refuses to start unless it loads,
/// so that manifest names the graph this process serves. Without it the neural API is off.
fn server_graph() -> Option<&'static ServerGraph> {
    static GRAPH: OnceLock<Option<ServerGraph>> = OnceLock::new();
    GRAPH
        .get_or_init(|| {
            let dir = std::env::var_os("CONNECTOME_DIR")?;
            let bytes = std::fs::read(std::path::Path::new(&dir).join("manifest.json")).ok()?;
            let manifest: Value = serde_json::from_slice(&bytes).ok()?;
            Some(ServerGraph {
                id: manifest.get("id")?.as_str()?.to_owned(),
                nodes: usize::try_from(manifest.pointer("/graph/nodes")?.as_u64()?).ok()?,
                edges: manifest.pointer("/graph/edges")?.as_u64()?,
            })
        })
        .as_ref()
}

/// `CheckpointEnvelope` in `local.rs`, which the receiver's next neural step decodes.
#[derive(Deserialize)]
struct CheckpointEnvelope {
    schema: u32,
    episode_id: String,
    state: NeuralState,
}

/// Decodes the checkpoint as `local.rs` will and checks the state as the connectome step does.
fn valid_checkpoint(encoded: &str, graph: &ServerGraph) -> bool {
    if encoded.len() > MAX_CHECKPOINT_TEXT {
        return false;
    }
    let Ok(compressed) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return false;
    };
    if compressed.is_empty() || compressed.len() > MAX_CHECKPOINT_COMPRESSED {
        return false;
    }
    let mut bytes = Vec::new();
    if GzDecoder::new(compressed.as_slice())
        .take(MAX_CHECKPOINT_EXPANDED + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_CHECKPOINT_EXPANDED
    {
        return false;
    }
    let Ok(envelope) = bincode::deserialize::<CheckpointEnvelope>(&bytes) else {
        return false;
    };
    let state = &envelope.state;
    envelope.schema == 1
        && !envelope.episode_id.is_empty()
        && envelope.episode_id.len() <= 120
        && envelope
            .episode_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        && state.schema == 1
        && state.graph_id == graph.id
        && state.activity.len() == graph.nodes
        && state.activity.iter().all(|value| value.is_finite() && value.abs() <= 1.001)
        && state.readout.len() == 5
        && state.readout.iter().all(|row| {
            row.len() == 256 && row.iter().all(|value| value.is_finite() && value.abs() <= 12.001)
        })
        && state
            .previous
            .as_ref()
            .is_none_or(|row| row.len() == 256 && row.iter().all(|value| value.is_finite()))
        && state.action < 5
}

/// A transferable brain the receiver's `importTransferableServerBrain` accepts and whose
/// checkpoint the neural API can resume.
fn validate_neural(value: &Value, graph: Option<&ServerGraph>) -> TradeResult<()> {
    let raw =
        serde_json::to_vec(value).map_err(|_| invalid("신경 체크포인트를 읽을 수 없습니다."))?;
    if raw.len() > MAX_NEURAL_BYTES {
        return Err(TradeError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "신경 체크포인트가 너무 큽니다.",
            "NEURAL_TOO_LARGE",
        ));
    }
    let graph = graph.ok_or_else(|| invalid("신경 그래프 ID가 올바르지 않습니다."))?;
    let known = |object: &Map<String, Value>, keys: &[&str]| {
        object.keys().all(|key| keys.contains(&key.as_str()))
    };
    let wrapper = value
        .as_object()
        .filter(|wrapper| known(wrapper, &["schema", "graphId", "gameScope", "state"]))
        .ok_or_else(|| invalid("신경 체크포인트가 올바르지 않습니다."))?;
    if wrapper.get("schema").and_then(Value::as_i64) != Some(1) {
        return Err(invalid("신경 체크포인트 schema가 올바르지 않습니다."));
    }
    if wrapper.get("graphId").and_then(Value::as_str) != Some(graph.id.as_str()) {
        return Err(invalid("신경 그래프 ID가 올바르지 않습니다."));
    }
    if wrapper
        .get("gameScope")
        .and_then(Value::as_str)
        .is_none_or(|v| v.is_empty() || v.encode_utf16().count() > 300)
    {
        return Err(invalid("신경 게임 범위가 올바르지 않습니다."));
    }
    let object = wrapper
        .get("state")
        .and_then(Value::as_object)
        .filter(|state| {
            known(
                state,
                &["checkpoint", "checkpointId", "history", "lastRequestId", "lastChoiceId", "decision"],
            )
        })
        .ok_or_else(|| invalid("신경 상태가 없습니다."))?;
    if object
        .get("history")
        .and_then(Value::as_array)
        .is_none_or(|v| !v.is_empty())
    {
        return Err(invalid("신경 체크포인트 기록이 올바르지 않습니다."));
    }
    // The receiver's HASH pattern: lowercase hexadecimal SHA-256.
    let digest = |value: Option<&Value>| {
        value.and_then(Value::as_str).is_some_and(|v| {
            v.len() == 64 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    };
    if !digest(object.get("checkpointId"))
        || !digest(object.get("lastRequestId"))
        || object.get("lastChoiceId").is_some_and(|id| !digest(Some(id)))
    {
        return Err(invalid("신경 체크포인트 영수증이 올바르지 않습니다."));
    }
    let decision = object
        .get("decision")
        .and_then(Value::as_object)
        .filter(|decision| {
            known(
                decision,
                &["action", "updates", "activity", "elapsedMs", "graphId", "nodes", "edges"],
            )
        })
        .ok_or_else(|| invalid("신경 결정 기록이 없습니다."))?;
    // The receiver's `validDecision` bounds; nodes and edges come from this graph.
    let within = |key: &str, minimum: f64, maximum: f64| {
        decision
            .get(key)
            .and_then(Value::as_f64)
            .is_some_and(|v| v.is_finite() && (minimum..=maximum).contains(&v))
    };
    if decision.get("graphId").and_then(Value::as_str) != Some(graph.id.as_str())
        || !decision
            .get("action")
            .and_then(Value::as_i64)
            .is_some_and(|v| (0..=4).contains(&v))
        || !decision
            .get("updates")
            .and_then(Value::as_i64)
            .is_some_and(|v| (0..=1_000_000_000).contains(&v))
        || !within("activity", -1e9, 1e9)
        || !within("elapsedMs", 0.0, 3_600_000.0)
        || decision.get("nodes").and_then(Value::as_u64) != u64::try_from(graph.nodes).ok()
        || decision.get("edges").and_then(Value::as_u64) != Some(graph.edges)
    {
        return Err(invalid("신경 그래프 ID가 상태와 다릅니다."));
    }
    let encoded = object
        .get("checkpoint")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("완성된 신경 체크포인트가 필요합니다."))?;
    if !valid_checkpoint(encoded, graph) {
        return Err(invalid("신경 체크포인트 인코딩이 올바르지 않습니다."));
    }
    Ok(())
}

/// Brains are exported under `account:<id>:<game seed>` (the bare seed before sign-in), so the
/// attachment must name the offering account's own game.
fn neural_scope_matches(neural: &Value, account: Uuid, save: &Value) -> bool {
    let scope = neural.get("gameScope").and_then(Value::as_str);
    let seed = save.pointer("/game/seed").and_then(Value::as_str);
    matches!((scope, seed), (Some(scope), Some(seed))
        if scope == seed || scope == format!("account:{account}:{seed}"))
}

fn no_transient(save: &Value) -> TradeResult<()> {
    let game = save
        .get("game")
        .ok_or_else(|| invalid("계정 저장이 올바르지 않습니다."))?;
    if game.get("battle").is_some() || game.get("captureOffer").is_some() {
        return Err(conflict(
            "전투 또는 포획 선택을 끝낸 뒤 거래해 주세요.",
            "SAVE_BUSY",
        ));
    }
    Ok(())
}

fn box_monster(save: &Value, id: &str) -> TradeResult<Value> {
    save.pointer("/game/player/box")
        .and_then(Value::as_array)
        .and_then(|v| {
            v.iter()
                .find(|m| m.get("instanceId").and_then(Value::as_str) == Some(id))
        })
        .cloned()
        .ok_or_else(|| {
            conflict(
                "제안한 포켓몬이 현재 박스에 없습니다.",
                "MONSTER_NOT_IN_BOX",
            )
        })
}
fn summary(monster: &Value) -> Value {
    json!({"instanceId":monster["instanceId"],"speciesId":monster["speciesId"],"nickname":monster["nickname"],"level":monster["level"]})
}

fn inventory(save: &Value) -> TradeResult<&Map<String, Value>> {
    save.pointer("/game/inventory")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("가방 저장이 올바르지 않습니다."))
}

fn validate_item_offer(save: &Value, items: &[ItemOffer]) -> TradeResult<()> {
    if items.len() > 8 {
        return Err(invalid("도구는 한 번에 최대 8종까지 제안할 수 있습니다."));
    }
    let bag = inventory(save)?;
    let mut seen = HashSet::with_capacity(items.len());
    for item in items {
        if item.quantity < 1 || item.quantity > 999 {
            return Err(invalid("도구 수량은 1개에서 999개 사이여야 합니다."));
        }
        if !seen.insert(item.item_id.as_str()) {
            return Err(invalid("같은 도구를 두 번 제안할 수 없습니다."));
        }
        if !tradeable_items().contains(&item.item_id) {
            return Err(invalid(
                "필드에서 얻는 장착 도구와 메가진화석만 거래할 수 있습니다.",
            ));
        }
        let stock = bag.get(&item.item_id).and_then(Value::as_i64).unwrap_or(-1);
        if stock < item.quantity {
            return Err(conflict(
                "제안한 도구의 가방 재고가 부족합니다.",
                "INSUFFICIENT_ITEMS",
            ));
        }
    }
    Ok(())
}

fn decode_item_offer(value: Value) -> TradeResult<Vec<ItemOffer>> {
    let items: Vec<ItemOffer> = serde_json::from_value(value)
        .map_err(|_| invalid("저장된 도구 거래 제안이 올바르지 않습니다."))?;
    if items.len() > 8 {
        return Err(invalid("저장된 도구 거래 제안이 올바르지 않습니다."));
    }
    let mut seen = HashSet::with_capacity(items.len());
    if items.iter().any(|item| {
        item.quantity < 1
            || item.quantity > 999
            || !seen.insert(item.item_id.as_str())
            || !tradeable_items().contains(&item.item_id)
    }) {
        return Err(invalid("저장된 도구 거래 제안이 올바르지 않습니다."));
    }
    Ok(items)
}

fn apply_item_exchange(
    save: &mut Value,
    outgoing: &[ItemOffer],
    incoming: &[ItemOffer],
) -> TradeResult<()> {
    validate_item_offer(save, outgoing)?;
    let bag = save
        .pointer_mut("/game/inventory")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| invalid("가방 저장이 올바르지 않습니다."))?;
    let mut deltas = HashMap::<&str, i64>::new();
    for item in outgoing {
        *deltas.entry(&item.item_id).or_default() -= item.quantity;
    }
    for item in incoming {
        *deltas.entry(&item.item_id).or_default() += item.quantity;
    }
    for (item_id, delta) in deltas {
        let stock = bag.get(item_id).and_then(Value::as_i64).unwrap_or(0);
        let next = stock
            .checked_add(delta)
            .filter(|value| (0..=MAX_ITEM_STOCK).contains(value))
            .ok_or_else(|| conflict("도구 재고 한도를 넘을 수 없습니다.", "ITEM_STOCK_LIMIT"))?;
        bag.insert(item_id.to_owned(), json!(next));
    }
    Ok(())
}

/// Revision, trade epoch and compressed payload of the account's current save, locked.
async fn load_save_tx(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> TradeResult<(i64, i64, Vec<u8>)> {
    let row=sqlx::query("SELECT revision,trade_epoch,payload FROM saves WHERE user_id=$1 AND slot='current' FOR UPDATE").bind(id).fetch_optional(&mut **tx).await?.ok_or_else(||conflict("먼저 계정 진행을 저장해 주세요.","SAVE_REQUIRED"))?;
    Ok((row.get("revision"), row.get("trade_epoch"), row.get("payload")))
}

/// Decompresses and parses a stored save (blocking work) and stamps its authoritative epoch.
fn parse_save(bytes: &[u8], epoch: i64) -> TradeResult<Value> {
    let mut save: Value = serde_json::from_slice(&decompress(bytes).map_err(TradeError::from)?)
        .map_err(|_| invalid("계정 저장을 읽을 수 없습니다."))?;
    save.as_object_mut()
        .ok_or_else(|| invalid("계정 저장을 읽을 수 없습니다."))?
        .insert("tradeEpoch".into(), json!(epoch));
    Ok(save)
}

async fn offer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<OfferRequest>,
) -> TradeResult<Json<Value>> {
    let account = profile_user(&state, &headers).await?;
    mutation_rate(account.id)?;
    if body.version < 0 || body.revision < 0 || body.money < 0 || body.money > MAX_SAFE_INTEGER {
        return Err(invalid("거래 제안 숫자가 올바르지 않습니다."));
    }
    if body.monster_id.is_none() && body.neural.is_some() {
        return Err(invalid("포켓몬 없이 신경 체크포인트를 보낼 수 없습니다."));
    }
    if body.monster_id.as_ref().is_some_and(|id| id.len() > 120) {
        return Err(invalid("개체 ID가 너무 깁니다."));
    }
    // Decoding the checkpoint is CPU work; finish it before taking any lock.
    let neural = match body.neural {
        Some(neural) => Some(
            tokio::task::spawn_blocking(move || {
                validate_neural(&neural, server_graph()).map(|()| neural)
            })
            .await
            .map_err(worker_failed)??,
        ),
        None => None,
    };
    let mut tx = state.db.begin().await?;
    advisory(&mut tx, account.id).await?;
    let row = row_by_id(&mut tx, id, true).await?;
    if !is_member(&row, account.id) {
        return Err(missing());
    }
    if row.get::<String, _>("status") != "active" {
        return Err(conflict("활성 거래만 수정할 수 있습니다.", "TRADE_STATE"));
    }
    if row.get::<i64, _>("version") != body.version {
        return Err(conflict(
            "거래 내용이 다른 기기에서 바뀌었습니다.",
            "VERSION_CONFLICT",
        ));
    }
    let (revision, epoch, payload) = load_save_tx(&mut tx, account.id).await?;
    if revision != body.revision {
        return Err(conflict("저장 revision이 바뀌었습니다.", "SAVE_CHANGED"));
    }
    let (items, money, monster_id) = (body.items.clone(), body.money, body.monster_id.clone());
    let (neural, monster) = tokio::task::spawn_blocking(move || {
        let save = parse_save(&payload, epoch)?;
        no_transient(&save)?;
        validate_item_offer(&save, &items)?;
        let balance = save
            .pointer("/game/player/money")
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        if money > balance {
            return Err(conflict(
                "보유 금액보다 많이 제안할 수 없습니다.",
                "INSUFFICIENT_MONEY",
            ));
        }
        if neural
            .as_ref()
            .is_some_and(|neural| !neural_scope_matches(neural, account.id, &save))
        {
            return Err(invalid("신경 게임 범위가 올바르지 않습니다."));
        }
        let monster = match &monster_id {
            Some(monster_id) => Some(summary(&box_monster(&save, monster_id)?)),
            None => None,
        };
        Ok((neural, monster))
    })
    .await
    .map_err(worker_failed)??;
    let who = side(&row, account.id);
    let sql = format!(
        "UPDATE trades SET {who}_revision=$2,{who}_monster_id=$3,{who}_monster=$4,{who}_money=$5,{who}_neural=$6,{who}_items=$7,creator_confirmed=false,joiner_confirmed=false,version=version+1,updated_at=now(),expires_at=now()+interval '10 minutes' WHERE id=$1"
    );
    sqlx::query(&sql)
        .bind(id)
        .bind(revision)
        .bind(body.monster_id)
        .bind(monster)
        .bind(body.money)
        .bind(neural)
        .bind(json!(body.items))
        .execute(&mut *tx)
        .await?;
    let creator = row.get::<Uuid, _>("creator_id");
    let joiner = row.try_get::<Uuid, _>("joiner_id").ok();
    tx.commit().await?;
    let row = room_row(&state.db, id).await?;
    let _ = state.trade_events.send(creator);
    if let Some(v) = joiner {
        let _ = state.trade_events.send(v);
    }
    Ok(Json(json!({"trade":room(&row,account.id,true)})))
}

#[derive(Default)]
struct Aux {
    reward: Option<Value>,
    field: Option<Value>,
    world: Option<Value>,
    ledger: Option<Value>,
}
/// Removes the record with `id` from the array under `key`, when both exist.
fn take_record(container: &mut Map<String, Value>, key: &str, id: &str) -> Option<Value> {
    let list = container.get_mut(key)?.as_array_mut()?;
    let index = list
        .iter()
        .position(|v| v.get("id").and_then(Value::as_str) == Some(id))?;
    Some(list.remove(index))
}
fn extract(save: &mut Value, id: &str) -> TradeResult<(Value, Aux)> {
    let list = save
        .pointer_mut("/game/player/box")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid("박스 저장이 올바르지 않습니다."))?;
    let index = list
        .iter()
        .position(|m| m.get("instanceId").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| {
            conflict(
                "제안한 포켓몬이 현재 박스에 없습니다.",
                "MONSTER_NOT_IN_BOX",
            )
        })?;
    let monster = list.remove(index);
    let mut aux = Aux::default();
    if let Some(map) = save
        .pointer_mut("/view/rewards")
        .and_then(Value::as_object_mut)
    {
        aux.reward = map.remove(id);
    }
    if let Some(field) = save
        .pointer_mut("/view/field")
        .and_then(Value::as_object_mut)
    {
        aux.field =
            take_record(field, "entities", id).or_else(|| take_record(field, "memories", id));
    }
    if let Some(world) = save
        .pointer_mut("/view/openWorld")
        .and_then(Value::as_object_mut)
    {
        let companion_id = format!("companion:{id}");
        aux.world = take_record(world, "entities", &companion_id)
            .or_else(|| take_record(world, "companionMemories", &companion_id));
        if let Some(map) = world
            .get_mut("rewardLedgers")
            .and_then(Value::as_object_mut)
        {
            aux.ledger = map.remove(id);
        }
    }
    Ok((monster, aux))
}
fn sorted_add(value: &mut Value, item: i64) {
    if let Some(a) = value.as_array_mut() {
        if !a.iter().any(|v| v.as_i64() == Some(item)) {
            a.push(json!(item));
            a.sort_by_key(|v| v.as_i64().unwrap_or(0));
        }
    }
}
/// The object stored under `key`, created when absent; `None` when something else is there.
fn object_entry<'a>(map: &'a mut Map<String, Value>, key: &str) -> Option<&'a mut Map<String, Value>> {
    map.entry(key).or_insert_with(|| json!({})).as_object_mut()
}
fn array_entry<'a>(map: &'a mut Map<String, Value>, key: &str) -> Option<&'a mut Vec<Value>> {
    map.entry(key).or_insert_with(|| json!([])).as_array_mut()
}
/// Keeps a memory for a receiver without that snapshot. The client never reads this stash.
fn stash(view: &mut Map<String, Value>, id: &str, key: &str, record: Value) {
    if let Some(entry) =
        object_entry(view, "tradeCompanionMemories").and_then(|stash| object_entry(stash, id))
    {
        entry.insert(key.to_owned(), record);
    }
}
fn receive(save: &mut Value, mut monster: Value, aux: Aux) -> TradeResult<String> {
    let source_id = monster
        .get("instanceId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("개체 ID가 없습니다."))?
        .to_owned();
    let species = monster
        .get("speciesId")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid("종 ID가 없습니다."))?;
    let team = save
        .pointer("/game/player/team")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("팀 저장이 올바르지 않습니다."))?;
    let bx = save
        .pointer("/game/player/box")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("박스 저장이 올바르지 않습니다."))?;
    let owned: HashSet<String> = team
        .iter()
        .chain(bx)
        .filter_map(|m| m.get("instanceId").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let next = save
        .pointer("/game/nextInstanceId")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 1 && *value < MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("다음 개체 ID가 올바르지 않습니다."))?;
    let id = format!("mon-{next}");
    if owned.contains(&id) {
        return Err(conflict(
            "새 수신 개체 ID가 이미 사용 중입니다.",
            "INSTANCE_COLLISION",
        ));
    }
    let game = save
        .get_mut("game")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| invalid("계정 저장이 올바르지 않습니다."))?;
    let list = game
        .get_mut("player")
        .and_then(|player| player.get_mut("box"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid("박스 저장이 올바르지 않습니다."))?;
    if list.len() >= 10_000 {
        return Err(conflict("수신 계정 박스가 가득 찼습니다.", "BOX_FULL"));
    }
    monster["instanceId"] = json!(id);
    list.push(monster);
    game.insert("nextInstanceId".into(), json!(next + 1));
    if let Some(dex) = game.get_mut("dex").and_then(Value::as_object_mut) {
        for key in ["seen", "caught"] {
            if let Some(ids) = dex.get_mut(key) {
                sorted_add(ids, species);
            }
        }
    }
    if let Some(version) = game
        .get("adventureVersion")
        .and_then(Value::as_str)
        .map(str::to_owned)
        && species_available_in_version(&version, species)
    {
        let caught = game.entry("versionCaught").or_insert_with(|| json!({}));
        if !caught.is_object() {
            *caught = json!({});
        }
        if let Some(caught) = caught.as_object_mut() {
            let ids = caught.entry(version).or_insert_with(|| json!([]));
            if !ids.is_array() {
                *ids = json!([]);
            }
            sorted_add(ids, species);
        }
    }
    let view = save
        .get_mut("view")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| invalid("계정 저장이 올바르지 않습니다."))?;
    // Memories come from the sender's save: carry only records this receiver's loader accepts.
    if let Some(reward) = aux
        .reward
        .filter(|reward| reward.as_f64().is_some_and(|v| v.is_finite() && v.abs() <= 100.0))
        && let Some(rewards) = object_entry(view, "rewards")
    {
        rewards.insert(id.clone(), reward);
    }
    if let Some(mut record) = aux.field.filter(Value::is_object) {
        record["id"] = json!(id);
        if valid_field_record(&record) {
            if view.contains_key("field") {
                if let Some(memories) = view
                    .get_mut("field")
                    .and_then(Value::as_object_mut)
                    .and_then(|field| array_entry(field, "memories"))
                {
                    memories.push(record);
                }
            } else {
                stash(view, &id, "field", record);
            }
        }
    }
    if let Some(mut record) = aux.world.filter(Value::is_object) {
        record["id"] = json!(format!("companion:{id}"));
        if let Some(player) = view.get("openWorld").and_then(|world| world.get("player")) {
            for axis in ["x", "z"] {
                if let Some(value) = player.get(axis) {
                    record[axis] = value.clone();
                }
            }
        }
        if let Some(object) = record.as_object_mut() {
            object.remove("target");
        }
        if valid_world_record(&record)
            && record.get("kind").and_then(Value::as_str) == Some("companion")
        {
            if view.contains_key("openWorld") {
                if let Some(memories) = view
                    .get_mut("openWorld")
                    .and_then(Value::as_object_mut)
                    .and_then(|world| array_entry(world, "companionMemories"))
                {
                    memories.push(record);
                }
            } else {
                stash(view, &id, "openWorld", record);
            }
        }
    }
    if let Some(mut ledger) = aux.ledger.filter(Value::is_object) {
        ledger["individualId"] = json!(id);
        if valid_reward_ledger(&ledger, &id) {
            if view.contains_key("openWorld") {
                if let Some(ledgers) = view
                    .get_mut("openWorld")
                    .and_then(Value::as_object_mut)
                    .and_then(|world| object_entry(world, "rewardLedgers"))
                {
                    ledgers.insert(id.clone(), ledger);
                }
            } else {
                stash(view, &id, "rewardLedger", ledger);
            }
        }
    }
    // The loader accepts only generated IDs here, and at most 10,000 records.
    if generated_instance_id(&source_id)
        && let Some(records) = object_entry(view, "tradeTransferProvenance")
    {
        if records.len() >= 10_000 {
            records.retain(|key, _| owned.contains(key));
        }
        if records.len() < 10_000 {
            records.insert(id.clone(), json!({"sourceInstanceId":source_id}));
        }
    }
    Ok(id)
}

/// A trade result ready to store: validated under the next epoch, serialized and compressed.
struct SealedSave {
    bytes: Vec<u8>,
    hash: String,
}

fn seal_save(mut save: Value, epoch: i64) -> TradeResult<SealedSave> {
    save["tradeEpoch"] = json!(epoch + 1);
    validate_save(&save).map_err(invalid)?;
    let raw = serde_json::to_vec(&save).map_err(|_| invalid("거래 저장을 만들 수 없습니다."))?;
    Ok(SealedSave {
        bytes: compress(&raw).map_err(TradeError::from)?,
        hash: hex::encode(Sha256::digest(&raw)),
    })
}

async fn store_trade_save(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    revision: i64,
    epoch: i64,
    sealed: SealedSave,
    request_id: String,
) -> TradeResult<i64> {
    let quota=sqlx::query("SELECT count(*)::bigint slots,COALESCE(sum(octet_length(payload)),0)::bigint bytes FROM saves WHERE user_id=$1 AND slot<>'current'").bind(user_id).fetch_one(&mut **tx).await?;
    if quota.get::<i64, _>("slots") >= 128
        || quota.get::<i64, _>("bytes") + sealed.bytes.len() as i64 > 64_000_000
    {
        return Err(TradeError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "거래 결과가 계정 저장 한도를 넘습니다.",
            "SAVE_QUOTA",
        ));
    }
    let next = revision + 1;
    sqlx::query("UPDATE saves SET revision=$2,request_id=$3,payload=$4,payload_hash=$5,trade_epoch=$6,updated_at=now() WHERE user_id=$1 AND slot='current'").bind(user_id).bind(next).bind(&request_id).bind(sealed.bytes).bind(&sealed.hash).bind(epoch+1).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO save_requests(user_id,slot,request_id,payload_hash,revision) VALUES($1,'current',$2,$3,$4) ON CONFLICT(user_id,slot,request_id) DO NOTHING").bind(user_id).bind(request_id).bind(sealed.hash).bind(next).execute(&mut **tx).await?;
    Ok(next)
}

/// One side of a confirmed trade: its locked save and what it sends.
struct TradeSide {
    epoch: i64,
    payload: Vec<u8>,
    monster: Option<String>,
    money: i64,
    items: Vec<ItemOffer>,
}

/// Applies both offers to both saves (blocking work) and returns the sealed saves with the
/// Pokémon each side received.
fn exchange(
    creator: TradeSide,
    joiner: TradeSide,
) -> TradeResult<(SealedSave, SealedSave, Option<String>, Option<String>)> {
    let mut cs = parse_save(&creator.payload, creator.epoch)?;
    let mut js = parse_save(&joiner.payload, joiner.epoch)?;
    no_transient(&cs)?;
    no_transient(&js)?;
    let cb = cs
        .pointer("/game/player/money")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    let jb = js
        .pointer("/game/player/money")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if cb < creator.money || jb < joiner.money {
        return Err(conflict(
            "제안 금액을 보유하고 있지 않습니다.",
            "INSUFFICIENT_MONEY",
        ));
    }
    let c_transfer = match creator.monster.as_deref() {
        Some(v) => Some(extract(&mut cs, v)?),
        None => None,
    };
    let j_transfer = match joiner.monster.as_deref() {
        Some(v) => Some(extract(&mut js, v)?),
        None => None,
    };
    apply_item_exchange(&mut cs, &creator.items, &joiner.items)?;
    apply_item_exchange(&mut js, &joiner.items, &creator.items)?;
    let creator_balance = cb
        .checked_sub(creator.money)
        .and_then(|value| value.checked_add(joiner.money))
        .filter(|value| (0..=MAX_SAFE_INTEGER).contains(value))
        .ok_or_else(|| conflict("거래 후 보유 금액 한도를 넘을 수 없습니다.", "MONEY_LIMIT"))?;
    let joiner_balance = jb
        .checked_sub(joiner.money)
        .and_then(|value| value.checked_add(creator.money))
        .filter(|value| (0..=MAX_SAFE_INTEGER).contains(value))
        .ok_or_else(|| conflict("거래 후 보유 금액 한도를 넘을 수 없습니다.", "MONEY_LIMIT"))?;
    for (save, balance) in [(&mut cs, creator_balance), (&mut js, joiner_balance)] {
        if let Some(money) = save.pointer_mut("/game/player/money") {
            *money = json!(balance);
        }
    }
    let creator_received = match j_transfer {
        Some((m, a)) => Some(receive(&mut cs, m, a)?),
        None => None,
    };
    let joiner_received = match c_transfer {
        Some((m, a)) => Some(receive(&mut js, m, a)?),
        None => None,
    };
    Ok((
        seal_save(cs, creator.epoch)?,
        seal_save(js, joiner.epoch)?,
        creator_received,
        joiner_received,
    ))
}

async fn confirm(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<VersionRequest>,
) -> TradeResult<Response> {
    let account = profile_user(&state, &headers).await?;
    mutation_rate(account.id)?;
    let mut tx = state.db.begin().await?;
    let initial = sqlx::query("SELECT creator_id,joiner_id,status,version FROM trades WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(missing)?;
    let creator: Uuid = initial.get("creator_id");
    let joiner: Uuid = initial
        .try_get("joiner_id")
        .map_err(|_| conflict("아직 참가자가 없습니다.", "TRADE_STATE"))?;
    if account.id != creator && account.id != joiner {
        return Err(missing());
    }
    advisory_pair(&mut tx, creator, joiner).await?;
    expire_for(&mut tx, account.id).await?;
    let row = row_by_id(&mut tx, id, true).await?;
    let status: String = row.get("status");
    if status == "completed" {
        tx.commit().await?;
        return completed_result(&state, account.id, id).await;
    }
    if status != "active" {
        return Err(conflict("활성 거래만 확정할 수 있습니다.", "TRADE_STATE"));
    }
    let who = side(&row, account.id);
    if row.get::<bool, _>(format!("{who}_confirmed").as_str())
        && body.version <= row.get::<i64, _>("version")
    {
        tx.commit().await?;
        let r = room_row(&state.db, id).await?;
        return Ok(Json(json!({"trade":room(&r,account.id,true)})).into_response());
    }
    if body.version != row.get::<i64, _>("version") {
        return Err(conflict(
            "거래 내용이 다른 기기에서 바뀌었습니다.",
            "VERSION_CONFLICT",
        ));
    }
    let c_rev: Option<i64> = row.try_get("creator_revision").ok();
    let j_rev: Option<i64> = row.try_get("joiner_revision").ok();
    if c_rev.is_none() || j_rev.is_none() {
        return Err(conflict(
            "양쪽 모두 거래 제안을 먼저 저장해야 합니다.",
            "OFFER_REQUIRED",
        ));
    }
    let c_mon: Option<String> = row.try_get("creator_monster_id").ok();
    let j_mon: Option<String> = row.try_get("joiner_monster_id").ok();
    let c_money: i64 = row.get("creator_money");
    let j_money: i64 = row.get("joiner_money");
    let c_items = decode_item_offer(row.get::<Value, _>("creator_items"))?;
    let j_items = decode_item_offer(row.get::<Value, _>("joiner_items"))?;
    if c_mon.is_none()
        && j_mon.is_none()
        && c_money == 0
        && j_money == 0
        && c_items.is_empty()
        && j_items.is_empty()
    {
        return Err(invalid("포켓몬이나 돈, 도구 중 하나는 이동해야 합니다."));
    }
    let other_confirmed = row.get::<bool, _>(
        format!(
            "{}_confirmed",
            if who == "creator" {
                "joiner"
            } else {
                "creator"
            }
        )
        .as_str(),
    );
    if !other_confirmed {
        sqlx::query(&format!("UPDATE trades SET {who}_confirmed=true,version=version+1,updated_at=now(),expires_at=now()+interval '10 minutes' WHERE id=$1")).bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        let _ = state.trade_events.send(creator);
        let _ = state.trade_events.send(joiner);
        let r = room_row(&state.db, id).await?;
        return Ok(Json(json!({"trade":room(&r,account.id,true)})).into_response());
    }
    let (cr, ce, c_payload) = load_save_tx(&mut tx, creator).await?;
    let (jr, je, j_payload) = load_save_tx(&mut tx, joiner).await?;
    if Some(cr) != c_rev || Some(jr) != j_rev {
        sqlx::query("UPDATE trades SET creator_confirmed=false,joiner_confirmed=false,version=version+1,updated_at=now(),expires_at=now()+interval '10 minutes' WHERE id=$1").bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        let _ = state.trade_events.send(creator);
        let _ = state.trade_events.send(joiner);
        return Err(conflict(
            "제안 뒤 저장이 바뀌어 다시 확인해야 합니다.",
            "SAVE_CHANGED",
        ));
    }
    // Both saves stay locked while a worker thread rewrites, validates and compresses them.
    let creator_side = TradeSide {
        epoch: ce,
        payload: c_payload,
        monster: c_mon,
        money: c_money,
        items: c_items,
    };
    let joiner_side = TradeSide {
        epoch: je,
        payload: j_payload,
        monster: j_mon,
        money: j_money,
        items: j_items,
    };
    let (c_sealed, j_sealed, creator_received, joiner_received) =
        tokio::task::spawn_blocking(move || exchange(creator_side, joiner_side))
            .await
            .map_err(worker_failed)??;
    let cn = store_trade_save(&mut tx, creator, cr, ce, c_sealed, format!("trade-{id}-creator")).await?;
    let jn = store_trade_save(&mut tx, joiner, jr, je, j_sealed, format!("trade-{id}-joiner")).await?;
    sqlx::query("UPDATE trades SET creator_confirmed=true,joiner_confirmed=true,status='completed',version=version+1,creator_result_revision=$2,joiner_result_revision=$3,creator_received_monster_id=$4,joiner_received_monster_id=$5,updated_at=now(),completed_at=now() WHERE id=$1").bind(id).bind(cn).bind(jn).bind(creator_received).bind(joiner_received).execute(&mut *tx).await?;
    tx.commit().await?;
    let _ = state.trade_events.send(creator);
    let _ = state.trade_events.send(joiner);
    completed_result(&state, account.id, id).await
}

async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<VersionRequest>,
) -> TradeResult<Response> {
    let account = profile_user(&state, &headers).await?;
    mutation_rate(account.id)?;
    let mut tx = state.db.begin().await?;
    advisory(&mut tx, account.id).await?;
    let row = row_by_id(&mut tx, id, true).await?;
    if !is_member(&row, account.id) {
        return Err(missing());
    }
    let status: String = row.get("status");
    if matches!(status.as_str(), "cancelled" | "expired") {
        tx.commit().await?;
        let r = room_row(&state.db, id).await?;
        return Ok(Json(json!({"trade":room(&r,account.id,true)})).into_response());
    }
    if status == "completed" {
        tx.commit().await?;
        return completed_result(&state, account.id, id).await;
    }
    if row.get::<i64, _>("version") != body.version {
        return Err(conflict(
            "거래 내용이 다른 기기에서 바뀌었습니다.",
            "VERSION_CONFLICT",
        ));
    }
    sqlx::query(
        "UPDATE trades SET status='cancelled',version=version+1,updated_at=now() WHERE id=$1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let c = row.get("creator_id");
    let j = row.try_get::<Uuid, _>("joiner_id").ok();
    tx.commit().await?;
    let _ = state.trade_events.send(c);
    if let Some(v) = j {
        let _ = state.trade_events.send(v);
    }
    let r = room_row(&state.db, id).await?;
    Ok(Json(json!({"trade":room(&r,account.id,true)})).into_response())
}

/// The viewer's completed trade with its current save. The other side's neural attachment is
/// read only when the viewer received a Pokémon, and the save is decoded on a worker thread.
async fn completed_result(state: &AppState, viewer: Uuid, id: Uuid) -> TradeResult<Response> {
    let row = room_row(&state.db, id).await?;
    if !is_member(&row, viewer) {
        return Err(missing());
    }
    if row.get::<String, _>("status") != "completed" {
        return Err(conflict("아직 완료되지 않은 거래입니다.", "TRADE_STATE"));
    }
    let trade = room(&row, viewer, true);
    let which = side(&row, viewer);
    let revision: Option<i64> = row
        .try_get(format!("{which}_result_revision").as_str())
        .ok();
    let instance: Option<String> = row
        .try_get(format!("{which}_received_monster_id").as_str())
        .ok();
    let saved = sqlx::query(
        "SELECT revision,trade_epoch,payload FROM saves WHERE user_id=$1 AND slot='current'",
    )
    .bind(viewer)
    .fetch_one(&state.db)
    .await?;
    let neural: Option<Value> = if instance.is_some() {
        sqlx::query_scalar("SELECT CASE WHEN creator_id=$2 THEN joiner_neural ELSE creator_neural END FROM trades WHERE id=$1")
            .bind(id)
            .bind(viewer)
            .fetch_one(&state.db)
            .await?
    } else {
        None
    };
    let current_revision: i64 = saved.get("revision");
    let epoch: i64 = saved.get("trade_epoch");
    let payload: Vec<u8> = saved.get("payload");
    let body = tokio::task::spawn_blocking(move || -> TradeResult<Vec<u8>> {
        let mut save: Value =
            serde_json::from_slice(&decompress(&payload).map_err(TradeError::from)?)
                .map_err(|_| invalid("거래 결과 저장을 읽을 수 없습니다."))?;
        if let Some(fields) = save.as_object_mut() {
            fields.insert("tradeEpoch".into(), json!(epoch));
        }
        let still_owned = instance.as_deref().is_some_and(|id| {
            ["/game/player/team", "/game/player/box"]
                .iter()
                .any(|path| {
                    save.pointer(path)
                        .and_then(Value::as_array)
                        .is_some_and(|items| {
                            items.iter().any(|monster| {
                                monster.get("instanceId").and_then(Value::as_str) == Some(id)
                            })
                        })
                })
        });
        let incoming = match (instance, neural, still_owned) {
            (Some(instance_id), Some(neural), true) => {
                Some(json!({"instanceId":instance_id,"neural":neural}))
            }
            _ => None,
        };
        serde_json::to_vec(&json!({"trade":trade,"result":{"revision":current_revision,"committedRevision":revision,"tradeEpoch":epoch,"save":save,"incomingNeural":incoming}}))
            .map_err(|_| invalid("거래 결과 저장을 읽을 수 없습니다."))
    })
    .await
    .map_err(worker_failed)??;
    Ok(([(header::CONTENT_TYPE, "application/json")], body).into_response())
}
async fn result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> TradeResult<Response> {
    let account = profile_user(&state, &headers).await?;
    read_rate(&state, "trade-result", account.id, RESULT_READS)?;
    completed_result(&state, account.id, id).await
}

async fn live(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<LiveQuery>,
    ws: WebSocketUpgrade,
) -> TradeResult<Response> {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if origin.is_none()
        || origin.is_some_and(|v| !state.origin.split(',').any(|allowed| allowed.trim() == v))
    {
        return Err(TradeError(
            StatusCode::FORBIDDEN,
            "허용되지 않은 WebSocket 출처입니다.",
            "ORIGIN",
        ));
    }
    let account = user(&state, &headers).await?;
    let session_hash = token_hash(&headers).ok_or(TradeError(
        StatusCode::UNAUTHORIZED,
        "로그인이 필요합니다.",
        "AUTH",
    ))?;
    let expected = account.id.to_string();
    let profile = headers
        .get("x-choketmon-profile")
        .and_then(|v| v.to_str().ok())
        .or(query.profile.as_deref());
    if profile != Some(expected.as_str()) {
        return Err(TradeError(
            StatusCode::FORBIDDEN,
            "로그인 계정과 저장 프로필이 다릅니다.",
            "PROFILE",
        ));
    }
    let guard = SocketGuard::acquire(account.id)?;
    Ok(ws
        .max_frame_size(4096)
        .max_message_size(4096)
        .on_upgrade(move |socket| live_socket(socket, state, account.id, session_hash, guard)))
}
async fn send_bounded(socket: &mut WebSocket, message: Message) -> bool {
    tokio::time::timeout(Duration::from_secs(5), socket.send(message))
        .await
        .is_ok_and(|result| result.is_ok())
}
async fn live_socket(
    mut socket: WebSocket,
    state: AppState,
    user_id: Uuid,
    session_hash: String,
    _guard: SocketGuard,
) {
    let mut events = state.trade_events.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    heartbeat.tick().await;
    let mut last_seen = Instant::now();
    if !send_bounded(
        &mut socket,
        Message::Text(json!({"type":"trade-changed"}).to_string().into()),
    )
    .await
    {
        return;
    }
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(id) if id == user_id => if !send_bounded(&mut socket, Message::Text(json!({"type":"trade-changed"}).to_string().into())).await { break; },
                Ok(_) => {},
                // A burst overflowed the channel and may have dropped this user's event: resync.
                Err(RecvError::Lagged(_)) => if !send_bounded(&mut socket, Message::Text(json!({"type":"trade-changed"}).to_string().into())).await { break; },
                Err(RecvError::Closed) => break,
            },
            message = socket.recv() => match message {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(Message::Pong(_))) | Some(Ok(Message::Ping(_))) => last_seen=Instant::now(),
                Some(Ok(Message::Text(text))) if text.len() <= 4096 => last_seen=Instant::now(),
                Some(Ok(Message::Binary(bytes))) if bytes.len() <= 4096 => last_seen=Instant::now(),
                _ => break,
            },
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > Duration::from_secs(45) { break; }
                let active = sqlx::query("SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()")
                    .bind(&session_hash).bind(user_id).fetch_optional(&state.db).await.ok().flatten().is_some();
                if !active || !send_bounded(&mut socket, Message::Ping(Vec::new().into())).await { break; }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::save_validation::tests::{
        add_box_monster, field_record, field_snapshot, reward_ledger, valid_save, world_record,
    };
    #[test]
    fn codes_are_long_and_unambiguous() {
        for _ in 0..100 {
            let c = room_code();
            assert_eq!(c.len(), 12);
            assert!(
                c.bytes()
                    .all(|b| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(&b))
            );
        }
    }
    fn test_graph(nodes: usize) -> ServerGraph {
        ServerGraph {
            id: "test-graph".into(),
            nodes,
            edges: 7,
        }
    }

    /// A checkpoint as `local.rs` encodes it, with pseudo-random activity that barely compresses.
    fn checkpoint(graph_id: &str, nodes: usize) -> String {
        use flate2::{Compression, write::GzEncoder};
        use std::io::Write;
        #[derive(Serialize)]
        struct Envelope {
            schema: u32,
            episode_id: String,
            state: NeuralState,
        }
        let mut seed = 0x2545_f491_u32;
        let activity = (0..nodes)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as f32 / u32::MAX as f32 * 2.0 - 1.0
            })
            .collect();
        let state = NeuralState {
            schema: 1,
            graph_id: graph_id.into(),
            seed: 1,
            activity,
            readout: vec![vec![0.0; 256]; 5],
            previous: None,
            action: 4,
            rng: 2,
            updates: 3,
        };
        let bytes = bincode::serialize(&Envelope {
            schema: 1,
            episode_id: "episode-1".into(),
            state,
        })
        .unwrap();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&bytes).unwrap();
        base64::engine::general_purpose::STANDARD.encode(encoder.finish().unwrap())
    }

    fn neural(graph: &ServerGraph, checkpoint: String) -> Value {
        let digest = "a".repeat(64);
        json!({"schema":1,"graphId":graph.id,"gameScope":"account:00000000-0000-0000-0000-000000000001:seed-1",
            "state":{"checkpoint":checkpoint,"checkpointId":digest,"history":[],"lastRequestId":digest,
                "lastChoiceId":"b".repeat(64),
                "decision":{"action":0,"updates":1,"activity":0.25,"elapsedMs":1.0,"graphId":graph.id,
                    "nodes":graph.nodes,"edges":graph.edges}}})
    }

    fn set(value: &mut Value, pointer: &str, replacement: Value) {
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        value
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(key.into(), replacement);
    }

    #[test]
    fn neural_must_be_a_resumable_brain_of_the_loaded_graph() {
        let graph = test_graph(3);
        let valid = neural(&graph, checkpoint("test-graph", 3));
        validate_neural(&valid, Some(&graph)).unwrap();
        // Without a loaded connectome no receiver can import a brain.
        assert!(validate_neural(&valid, None).is_err());
        let not_gzip = base64::engine::general_purpose::STANDARD.encode(b"not gzip");
        for (pointer, replacement) in [
            ("/graphId", json!("other-graph")),
            ("/schema", json!(2)),
            ("/gameScope", json!("")),
            ("/padding", json!(1)),
            ("/state/padding", json!(1)),
            ("/state/history", json!([{}])),
            ("/state/checkpointId", json!("A".repeat(64))),
            ("/state/lastRequestId", json!("a".repeat(63))),
            ("/state/lastChoiceId", json!("xyz")),
            ("/state/decision/graphId", json!("other-graph")),
            ("/state/decision/nodes", json!(4)),
            ("/state/decision/edges", json!(8)),
            ("/state/decision/updates", json!(1_000_000_001_i64)),
            ("/state/decision/elapsedMs", json!(-1)),
            ("/state/checkpoint", json!("not base64!")),
            ("/state/checkpoint", json!(not_gzip)),
            ("/state/checkpoint", json!(checkpoint("other-graph", 3))),
            ("/state/checkpoint", json!(checkpoint("test-graph", 4))),
        ] {
            let mut edited = valid.clone();
            set(&mut edited, pointer, replacement.clone());
            assert!(
                validate_neural(&edited, Some(&graph)).is_err(),
                "{pointer} {replacement}"
            );
        }
        let mut missing = valid;
        missing["state"].as_object_mut().unwrap().remove("checkpoint");
        assert!(validate_neural(&missing, Some(&graph)).is_err());
    }

    #[test]
    fn offers_accept_every_checkpoint_the_local_api_accepts() {
        // Random activity keeps this checkpoint above the old 1.8M-character offer limit.
        let graph = test_graph(390_000);
        let large = checkpoint("test-graph", graph.nodes);
        assert!(large.len() > 1_800_000 && large.len() <= MAX_CHECKPOINT_TEXT, "{}", large.len());
        let offer = neural(&graph, large);
        validate_neural(&offer, Some(&graph)).unwrap();
        let body = serde_json::to_vec(&json!({"version":1,"revision":1,"monsterId":"mon-1","money":0,"items":[],"neural":offer})).unwrap();
        assert!(body.len() < MAX_REQUEST_BYTES);
        let mut oversized = neural(&graph, "A".repeat(MAX_CHECKPOINT_TEXT + 4));
        assert!(validate_neural(&oversized, Some(&graph)).is_err());
        oversized["state"]["checkpoint"] = json!("A".repeat(MAX_NEURAL_BYTES));
        assert_eq!(
            validate_neural(&oversized, Some(&graph)).unwrap_err().0,
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[test]
    fn neural_scope_names_the_offering_account_game() {
        let account = Uuid::from_u128(1);
        let save = json!({"game":{"seed":"seed-1"}});
        for (scope, valid) in [
            ("account:00000000-0000-0000-0000-000000000001:seed-1", true),
            ("seed-1", true),
            ("account:00000000-0000-0000-0000-000000000002:seed-1", false),
            ("account:00000000-0000-0000-0000-000000000001:seed-2", false),
            ("default", false),
        ] {
            assert_eq!(
                neural_scope_matches(&json!({"gameScope":scope}), account, &save),
                valid,
                "{scope}"
            );
        }
    }

    fn receiver() -> Value {
        json!({
            "game":{"nextInstanceId":3,"adventureVersion":"red","versionCaught":{"red":[1]},"player":{"team":[{"instanceId":"mon-1"}],"box":[{"instanceId":"mon-2"}]},"dex":{"seen":[1],"caught":[1]}},
            "view":{"rewards":{},"field":{"memories":[]},"openWorld":{"player":{"x":4.0,"z":5.0},"companionMemories":[],"rewardLedgers":{}}}
        })
    }

    fn sender_aux() -> Aux {
        let mut world = world_record("companion:mon-2", "companion", 90.0, 90.0);
        world["target"] = json!({"kind":"food","id":"1","x":1,"z":1});
        Aux {
            reward: Some(json!(4)),
            field: Some(field_record("mon-2", 5, 8)),
            world: Some(world),
            ledger: Some(reward_ledger("mon-2")),
        }
    }

    #[test]
    fn receive_allocates_local_id_and_remaps_memories() {
        let mut save = receiver();
        let monster = json!({"instanceId":"mon-2","speciesId":25});
        let received = receive(&mut save, monster, sender_aux()).unwrap();
        assert_eq!(received, "mon-3");
        assert_eq!(save["game"]["nextInstanceId"], 4);
        assert_eq!(save["game"]["player"]["box"][1]["instanceId"], "mon-3");
        assert_eq!(save["game"]["versionCaught"]["red"], json!([1, 25]));
        assert_eq!(save["view"]["rewards"]["mon-3"], 4);
        assert_eq!(save["view"]["field"]["memories"][0]["id"], "mon-3");
        let memory = &save["view"]["openWorld"]["companionMemories"][0];
        assert_eq!(memory["id"], "companion:mon-3");
        assert_eq!((memory["x"].clone(), memory["z"].clone()), (json!(4.0), json!(5.0)));
        assert!(memory.get("target").is_none());
        assert_eq!(
            save["view"]["openWorld"]["rewardLedgers"]["mon-3"]["individualId"],
            "mon-3"
        );
        assert_eq!(
            save["view"]["tradeTransferProvenance"]["mon-3"],
            json!({"sourceInstanceId":"mon-2"})
        );
    }

    #[test]
    fn receive_drops_memories_the_receiver_could_not_load() {
        let mut bad_world = world_record("companion:mon-2", "wild", 1.0, 1.0);
        bad_world["brain"]["sensoryBypass"] = json!(true);
        let mut bad_field = field_record("mon-2", 5, 8);
        bad_field["brain"]["graphId"] = json!("other-graph");
        let mut bad_ledger = reward_ledger("mon-2");
        bad_ledger["lifetime"]["events"] = json!(5);
        let aux = Aux {
            reward: Some(json!(1e6)),
            field: Some(bad_field),
            world: Some(bad_world),
            ledger: Some(bad_ledger),
        };
        let mut save = receiver();
        let received = receive(&mut save, json!({"instanceId":"starter","speciesId":25}), aux).unwrap();
        assert!(save["view"]["rewards"].get(&received).is_none());
        assert_eq!(save["view"]["field"]["memories"], json!([]));
        assert_eq!(save["view"]["openWorld"]["companionMemories"], json!([]));
        assert_eq!(save["view"]["openWorld"]["rewardLedgers"], json!({}));
        // A provenance record the loader would refuse is not written.
        assert!(save["view"].get("tradeTransferProvenance").is_none());

        // Non-object memories are dropped instead of panicking on indexing.
        let aux = Aux {
            reward: Some(json!("4")),
            field: Some(json!("field")),
            world: Some(json!([1])),
            ledger: Some(json!(7)),
        };
        let mut save = receiver();
        receive(&mut save, json!({"instanceId":"mon-2","speciesId":25}), aux).unwrap();
        assert_eq!(save["view"]["field"]["memories"], json!([]));
    }

    #[test]
    fn receive_stashes_memories_for_receivers_without_snapshots_and_caps_provenance() {
        let mut save = receiver();
        let view = save["view"].as_object_mut().unwrap();
        view.remove("field");
        view.remove("openWorld");
        let crowded: Map<String, Value> = (10..10_010)
            .map(|id| (format!("mon-{id}"), json!({"sourceInstanceId":"mon-4"})))
            .chain([("mon-1".to_owned(), json!({"sourceInstanceId":"mon-4"}))])
            .collect();
        view.insert("tradeTransferProvenance".into(), Value::Object(crowded));
        let id = receive(&mut save, json!({"instanceId":"mon-2","speciesId":25}), sender_aux()).unwrap();
        let stash = &save["view"]["tradeCompanionMemories"][&id];
        assert_eq!(stash["field"]["id"], id.as_str());
        assert_eq!(stash["openWorld"]["id"], format!("companion:{id}"));
        assert_eq!(stash["rewardLedger"]["individualId"], id.as_str());
        // Records of departed Pokémon make room; owned ones stay.
        let provenance = save["view"]["tradeTransferProvenance"].as_object().unwrap();
        assert_eq!(provenance.len(), 2);
        assert!(provenance.contains_key("mon-1") && provenance.contains_key(&id));
    }

    #[test]
    fn extract_tolerates_malformed_snapshots() {
        for view in [
            json!({"field":"broken","openWorld":[1],"rewards":7}),
            json!({"field":{"entities":"x","memories":{}},"openWorld":{"entities":5,"rewardLedgers":[]}}),
        ] {
            let mut save = json!({"game":{"player":{"box":[{"instanceId":"mon-2","speciesId":25}]}},"view":view});
            let (monster, aux) = extract(&mut save, "mon-2").unwrap();
            assert_eq!(monster["instanceId"], "mon-2");
            assert!(aux.field.is_none() && aux.world.is_none() && aux.ledger.is_none() && aux.reward.is_none());
        }
    }

    /// A save that passes validation, with a box Pokémon carrying every kind of memory.
    fn trading_save(seed: &str) -> Vec<u8> {
        let mut save = valid_save();
        save["game"]["seed"] = json!(seed);
        add_box_monster(&mut save, "mon-2");
        save["view"]["rewards"] = json!({"mon-2":1.5});
        save["view"]["field"] = field_snapshot(vec![field_record("mon-1", 5, 8)], vec![field_record("mon-2", 6, 8)]);
        save["view"]["openWorld"] = json!({"regionId":"kanto","mapVersion":"kanto-v3",
            "player":{"x":-7.5,"z":3.25,"heading":0},
            "entities":[world_record("companion:mon-1", "companion", 0.0, 0.0)],
            "companionMemories":[world_record("companion:mon-2", "companion", 9.0, 9.0)],
            "rewardLedgers":{"mon-2":reward_ledger("mon-2")}});
        validate_save(&save).unwrap();
        compress(&serde_json::to_vec(&save).unwrap()).unwrap()
    }

    #[test]
    fn exchange_moves_memories_into_loadable_saves() {
        let side = |seed: &str, monster: &str| TradeSide {
            epoch: 0,
            payload: trading_save(seed),
            monster: Some(monster.into()),
            money: 0,
            items: vec![],
        };
        let (creator, joiner, creator_received, joiner_received) =
            exchange(side("creator", "mon-2"), side("joiner", "mon-2")).unwrap();
        assert_eq!((creator_received.as_deref(), joiner_received.as_deref()), (Some("mon-3"), Some("mon-3")));
        for sealed in [creator, joiner] {
            let save: Value = serde_json::from_slice(&decompress(&sealed.bytes).unwrap()).unwrap();
            validate_save(&save).unwrap();
            assert_eq!(save["tradeEpoch"], 1);
            let ids: Vec<&str> = save["game"]["player"]["box"].as_array().unwrap().iter()
                .map(|monster| monster["instanceId"].as_str().unwrap()).collect();
            assert_eq!(ids, ["mon-3"]);
            assert_eq!(save["view"]["rewards"], json!({"mon-3":1.5}));
            assert_eq!(save["view"]["field"]["memories"][0]["id"], "mon-3");
            let memories = save["view"]["openWorld"]["companionMemories"].as_array().unwrap();
            assert_eq!(memories.len(), 1);
            assert_eq!((memories[0]["id"].clone(), memories[0]["x"].clone()), (json!("companion:mon-3"), json!(-7.5)));
            assert_eq!(save["view"]["openWorld"]["rewardLedgers"].as_object().unwrap().keys().collect::<Vec<_>>(), ["mon-3"]);
            assert_eq!(save["view"]["tradeTransferProvenance"], json!({"mon-3":{"sourceInstanceId":"mon-2"}}));
        }
    }

    #[test]
    fn item_offer_accepts_only_unique_owned_field_items() {
        let save = json!({"game":{"inventory":{"leftovers":2,"mega-stone:gengar-mega":1}}});
        assert!(
            validate_item_offer(
                &save,
                &[
                    ItemOffer {
                        item_id: "leftovers".into(),
                        quantity: 2
                    },
                    ItemOffer {
                        item_id: "mega-stone:gengar-mega".into(),
                        quantity: 1
                    },
                ]
            )
            .is_ok()
        );
        assert!(
            validate_item_offer(
                &save,
                &[ItemOffer {
                    item_id: "leftovers".into(),
                    quantity: 3
                }]
            )
            .is_err()
        );
        assert!(
            validate_item_offer(
                &save,
                &[ItemOffer {
                    item_id: "poke-ball".into(),
                    quantity: 1
                }]
            )
            .is_err()
        );
        assert!(
            validate_item_offer(
                &save,
                &[
                    ItemOffer {
                        item_id: "leftovers".into(),
                        quantity: 1
                    },
                    ItemOffer {
                        item_id: "leftovers".into(),
                        quantity: 1
                    },
                ]
            )
            .is_err()
        );
    }

    #[test]
    fn item_exchange_preserves_stock_and_blocks_overflow() {
        let mut save = json!({"game":{"inventory":{"leftovers":5,"focus-sash":1}}});
        let outgoing = [ItemOffer {
            item_id: "leftovers".into(),
            quantity: 2,
        }];
        let incoming = [ItemOffer {
            item_id: "focus-sash".into(),
            quantity: 3,
        }];
        apply_item_exchange(&mut save, &outgoing, &incoming).unwrap();
        assert_eq!(save["game"]["inventory"]["leftovers"], 3);
        assert_eq!(save["game"]["inventory"]["focus-sash"], 4);

        save["game"]["inventory"]["focus-sash"] = json!(MAX_ITEM_STOCK);
        assert!(apply_item_exchange(&mut save, &[], &incoming).is_err());
        assert_eq!(save["game"]["inventory"]["focus-sash"], MAX_ITEM_STOCK);
    }
}
