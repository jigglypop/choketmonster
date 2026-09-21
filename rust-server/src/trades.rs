use crate::api::{ApiError, AppState, compress, decompress, profile_user, token_hash, user};
use crate::save_validation::{species_available_in_version, validate_save};
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
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_ITEM_STOCK: i64 = 1_000_000_000;
const MAX_NEURAL_BYTES: usize = 2_000_000;
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
        .layer(DefaultBodyLimit::max(2_100_000))
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

const ROOM_SELECT: &str = "SELECT t.*,cu.username creator_username,ju.username joiner_username FROM trades t JOIN users cu ON cu.id=t.creator_id LEFT JOIN users ju ON ju.id=t.joiner_id";

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

// PostgreSQL cannot decode timestamptz without chrono enabled; select its stable text form.
const ROOM_SELECT_TEXT: &str = "SELECT t.*,t.expires_at::text expires_at_text,cu.username creator_username,ju.username joiner_username FROM trades t JOIN users cu ON cu.id=t.creator_id LEFT JOIN users ju ON ju.id=t.joiner_id";
async fn room_row(db: &sqlx::PgPool, id: Uuid) -> TradeResult<PgRow> {
    let sql = format!("{ROOM_SELECT_TEXT} WHERE t.id=$1");
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
    sqlx::query(&format!("{ROOM_SELECT_TEXT} WHERE t.creator_id=$1 OR t.joiner_id=$1 ORDER BY CASE WHEN t.status IN ('waiting','active') THEN 0 ELSE 1 END,t.updated_at DESC LIMIT 1"))
        .bind(account).fetch_optional(&state.db).await.map_err(Into::into)
}

async fn current(State(state): State<AppState>, headers: HeaderMap) -> TradeResult<Json<Value>> {
    let account = profile_user(&state, &headers).await?;
    let mut tx = state.db.begin().await?;
    advisory(&mut tx, account.id).await?;
    expire_for(&mut tx, account.id).await?;
    tx.commit().await?;
    let Some(row) = latest_row(&state, account.id).await? else {
        return Ok(Json(json!({"trade":null})));
    };
    Ok(Json(json!({"trade":room(&row,account.id,true)})))
}

fn validate_neural(value: &Value) -> TradeResult<()> {
    let raw =
        serde_json::to_vec(value).map_err(|_| invalid("신경 체크포인트를 읽을 수 없습니다."))?;
    if raw.len() > MAX_NEURAL_BYTES {
        return Err(TradeError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "신경 체크포인트가 너무 큽니다.",
            "NEURAL_TOO_LARGE",
        ));
    }
    let wrapper = value
        .as_object()
        .ok_or_else(|| invalid("신경 체크포인트가 올바르지 않습니다."))?;
    if wrapper.get("schema").and_then(Value::as_i64) != Some(1) {
        return Err(invalid("신경 체크포인트 schema가 올바르지 않습니다."));
    }
    let graph_id = wrapper
        .get("graphId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("신경 그래프 ID가 없습니다."))?;
    if graph_id.is_empty() || graph_id.len() > 120 {
        return Err(invalid("신경 그래프 ID가 올바르지 않습니다."));
    }
    if wrapper
        .get("gameScope")
        .and_then(Value::as_str)
        .is_none_or(|v| v.is_empty() || v.len() > 200)
    {
        return Err(invalid("신경 게임 범위가 올바르지 않습니다."));
    }
    let object = wrapper
        .get("state")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("신경 상태가 없습니다."))?;
    if object.len() > 8
        || object
            .get("history")
            .and_then(Value::as_array)
            .is_none_or(|v| !v.is_empty())
    {
        return Err(invalid("신경 체크포인트 기록이 올바르지 않습니다."));
    }
    let digest = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
    };
    if !digest("checkpointId") || !digest("lastRequestId") {
        return Err(invalid("신경 체크포인트 영수증이 올바르지 않습니다."));
    }
    let decision = object
        .get("decision")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("신경 결정 기록이 없습니다."))?;
    if decision.get("graphId").and_then(Value::as_str) != Some(graph_id)
        || !decision
            .get("action")
            .and_then(Value::as_i64)
            .is_some_and(|v| (0..=4).contains(&v))
        || !decision
            .get("updates")
            .and_then(Value::as_i64)
            .is_some_and(|v| (0..=MAX_SAFE_INTEGER).contains(&v))
        || !["activity", "elapsedMs"].iter().all(|key| {
            decision
                .get(*key)
                .and_then(Value::as_f64)
                .is_some_and(f64::is_finite)
        })
        || !["nodes", "edges"].iter().all(|key| {
            decision
                .get(*key)
                .and_then(Value::as_i64)
                .is_some_and(|v| (1..=MAX_SAFE_INTEGER).contains(&v))
        })
    {
        return Err(invalid("신경 그래프 ID가 상태와 다릅니다."));
    }
    let encoded = object
        .get("checkpoint")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("완성된 신경 체크포인트가 필요합니다."))?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid("신경 체크포인트 인코딩이 올바르지 않습니다."))?;
    if encoded.len() > 1_800_000 || decoded.is_empty() {
        return Err(invalid("신경 체크포인트 인코딩이 올바르지 않습니다."));
    }
    Ok(())
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

async fn load_save_tx(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> TradeResult<(i64, i64, Value)> {
    let row=sqlx::query("SELECT revision,trade_epoch,payload FROM saves WHERE user_id=$1 AND slot='current' FOR UPDATE").bind(id).fetch_optional(&mut **tx).await?.ok_or_else(||conflict("먼저 계정 진행을 저장해 주세요.","SAVE_REQUIRED"))?;
    let bytes: Vec<u8> = row.get("payload");
    let mut save: Value = serde_json::from_slice(&decompress(&bytes).map_err(TradeError::from)?)
        .map_err(|_| invalid("계정 저장을 읽을 수 없습니다."))?;
    let epoch = row.get::<i64, _>("trade_epoch");
    save["tradeEpoch"] = json!(epoch);
    Ok((row.get("revision"), epoch, save))
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
    if let Some(v) = &body.neural {
        validate_neural(v)?;
    }
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
    let (revision, _, save) = load_save_tx(&mut tx, account.id).await?;
    if revision != body.revision {
        return Err(conflict("저장 revision이 바뀌었습니다.", "SAVE_CHANGED"));
    }
    no_transient(&save)?;
    validate_item_offer(&save, &body.items)?;
    let balance = save
        .pointer("/game/player/money")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if body.money > balance {
        return Err(conflict(
            "보유 금액보다 많이 제안할 수 없습니다.",
            "INSUFFICIENT_MONEY",
        ));
    }
    let monster = match &body.monster_id {
        Some(monster_id) => {
            if monster_id.len() > 120 {
                return Err(invalid("개체 ID가 너무 깁니다."));
            }
            Some(box_monster(&save, monster_id)?)
        }
        None => None,
    };
    let who = side(&row, account.id);
    let sql = format!(
        "UPDATE trades SET {who}_revision=$2,{who}_monster_id=$3,{who}_monster=$4,{who}_money=$5,{who}_neural=$6,{who}_items=$7,creator_confirmed=false,joiner_confirmed=false,version=version+1,updated_at=now(),expires_at=now()+interval '10 minutes' WHERE id=$1"
    );
    sqlx::query(&sql)
        .bind(id)
        .bind(revision)
        .bind(body.monster_id)
        .bind(monster.as_ref().map(summary))
        .bind(body.money)
        .bind(body.neural)
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
fn take_named(map: &mut Map<String, Value>, key: &str) -> Option<Value> {
    map.remove(key)
}
fn take_from_array(value: &mut Value, id: &str) -> Option<Value> {
    let list = value.as_array_mut()?;
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
        aux.reward = take_named(map, id);
    }
    if let Some(field) = save.pointer_mut("/view/field") {
        aux.field = take_from_array(&mut field["entities"], id)
            .or_else(|| take_from_array(&mut field["memories"], id));
    }
    if let Some(world) = save.pointer_mut("/view/openWorld") {
        let companion_id = format!("companion:{id}");
        aux.world = take_from_array(&mut world["entities"], &companion_id)
            .or_else(|| take_from_array(&mut world["companionMemories"], &companion_id));
        if let Some(map) = world
            .get_mut("rewardLedgers")
            .and_then(Value::as_object_mut)
        {
            aux.ledger = take_named(map, id);
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
fn receive(save: &mut Value, mut monster: Value, mut aux: Aux) -> TradeResult<String> {
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
    let next = save["game"]["nextInstanceId"]
        .as_i64()
        .filter(|value| *value >= 1 && *value < MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("다음 개체 ID가 올바르지 않습니다."))?;
    let id = format!("mon-{next}");
    if team
        .iter()
        .chain(bx)
        .any(|m| m.get("instanceId").and_then(Value::as_str) == Some(&id))
    {
        return Err(conflict(
            "새 수신 개체 ID가 이미 사용 중입니다.",
            "INSTANCE_COLLISION",
        ));
    }
    save["game"]["nextInstanceId"] = json!(next + 1);
    monster["instanceId"] = json!(id);
    let list = save
        .pointer_mut("/game/player/box")
        .and_then(Value::as_array_mut)
        .unwrap();
    if list.len() >= 10_000 {
        return Err(conflict("수신 계정 박스가 가득 찼습니다.", "BOX_FULL"));
    }
    list.push(monster);
    sorted_add(&mut save["game"]["dex"]["seen"], species);
    sorted_add(&mut save["game"]["dex"]["caught"], species);
    if let Some(version) = save["game"]["adventureVersion"].as_str().map(str::to_owned) {
        if species_available_in_version(&version, species) {
            if !save["game"]["versionCaught"].is_object() {
                save["game"]["versionCaught"] = json!({});
            }
            if !save["game"]["versionCaught"][&version].is_array() {
                save["game"]["versionCaught"][&version] = json!([]);
            }
            sorted_add(&mut save["game"]["versionCaught"][&version], species);
        }
    }
    if let Some(v) = aux.reward {
        if !save["view"]["rewards"].is_object() {
            save["view"]["rewards"] = json!({});
        }
        let map = save["view"]["rewards"].as_object_mut().unwrap();
        map.insert(id.clone(), v);
    }
    if let Some(mut v) = aux.field.take() {
        v["id"] = json!(id);
        if let Some(field) = save.pointer_mut("/view/field") {
            if !field["memories"].is_array() {
                field["memories"] = json!([]);
            }
            field["memories"].as_array_mut().unwrap().push(v);
        } else {
            save["view"]["tradeCompanionMemories"][&id] = json!({"field":v});
        }
    }
    if let Some(mut v) = aux.world.take() {
        v["id"] = json!(format!("companion:{id}"));
        if let Some(player) = save.pointer("/view/openWorld/player").cloned() {
            if let Some(x) = player.get("x") {
                v["x"] = x.clone();
            }
            if let Some(z) = player.get("z") {
                v["z"] = z.clone();
            }
        }
        if let Some(object) = v.as_object_mut() {
            object.remove("target");
        }
        if let Some(world) = save.pointer_mut("/view/openWorld") {
            if !world["companionMemories"].is_array() {
                world["companionMemories"] = json!([]);
            }
            world["companionMemories"].as_array_mut().unwrap().push(v);
        } else {
            save["view"]["tradeCompanionMemories"][&id]["openWorld"] = v;
        }
    }
    if let Some(mut v) = aux.ledger.take() {
        v["individualId"] = json!(id);
        if let Some(world) = save.pointer_mut("/view/openWorld") {
            if !world["rewardLedgers"].is_object() {
                world["rewardLedgers"] = json!({});
            }
            world["rewardLedgers"]
                .as_object_mut()
                .unwrap()
                .insert(id.clone(), v);
        } else {
            save["view"]["tradeCompanionMemories"][&id]["rewardLedger"] = v;
        }
    }
    save["view"]["tradeTransferProvenance"][&id] = json!({"sourceInstanceId":source_id});
    Ok(id)
}

async fn store_trade_save(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    revision: i64,
    epoch: i64,
    mut save: Value,
    request_id: String,
) -> TradeResult<i64> {
    save["tradeEpoch"] = json!(epoch + 1);
    validate_save(&save).map_err(invalid)?;
    let raw = serde_json::to_vec(&save).map_err(|_| invalid("거래 저장을 만들 수 없습니다."))?;
    let bytes = compress(&raw).map_err(TradeError::from)?;
    let hash = hex::encode(Sha256::digest(&raw));
    let quota=sqlx::query("SELECT count(*)::bigint slots,COALESCE(sum(octet_length(payload)),0)::bigint bytes FROM saves WHERE user_id=$1 AND slot<>'current'").bind(user_id).fetch_one(&mut **tx).await?;
    if quota.get::<i64, _>("slots") >= 128
        || quota.get::<i64, _>("bytes") + bytes.len() as i64 > 64_000_000
    {
        return Err(TradeError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "거래 결과가 계정 저장 한도를 넘습니다.",
            "SAVE_QUOTA",
        ));
    }
    let next = revision + 1;
    sqlx::query("UPDATE saves SET revision=$2,request_id=$3,payload=$4,payload_hash=$5,trade_epoch=$6,updated_at=now() WHERE user_id=$1 AND slot='current'").bind(user_id).bind(next).bind(&request_id).bind(bytes).bind(&hash).bind(epoch+1).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO save_requests(user_id,slot,request_id,payload_hash,revision) VALUES($1,'current',$2,$3,$4) ON CONFLICT(user_id,slot,request_id) DO NOTHING").bind(user_id).bind(request_id).bind(hash).bind(next).execute(&mut **tx).await?;
    Ok(next)
}

async fn confirm(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<VersionRequest>,
) -> TradeResult<Json<Value>> {
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
        return result(State(state), headers, Path(id)).await;
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
        return Ok(Json(json!({"trade":room(&r,account.id,true)})));
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
        return Ok(Json(json!({"trade":room(&r,account.id,true)})));
    }
    let (cr, ce, mut cs) = load_save_tx(&mut tx, creator).await?;
    let (jr, je, mut js) = load_save_tx(&mut tx, joiner).await?;
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
    if cb < c_money || jb < j_money {
        return Err(conflict(
            "제안 금액을 보유하고 있지 않습니다.",
            "INSUFFICIENT_MONEY",
        ));
    }
    let c_transfer = match c_mon.as_deref() {
        Some(v) => Some(extract(&mut cs, v)?),
        None => None,
    };
    let j_transfer = match j_mon.as_deref() {
        Some(v) => Some(extract(&mut js, v)?),
        None => None,
    };
    apply_item_exchange(&mut cs, &c_items, &j_items)?;
    apply_item_exchange(&mut js, &j_items, &c_items)?;
    let creator_balance = cb
        .checked_sub(c_money)
        .and_then(|value| value.checked_add(j_money))
        .filter(|value| (0..=MAX_SAFE_INTEGER).contains(value))
        .ok_or_else(|| conflict("거래 후 보유 금액 한도를 넘을 수 없습니다.", "MONEY_LIMIT"))?;
    let joiner_balance = jb
        .checked_sub(j_money)
        .and_then(|value| value.checked_add(c_money))
        .filter(|value| (0..=MAX_SAFE_INTEGER).contains(value))
        .ok_or_else(|| conflict("거래 후 보유 금액 한도를 넘을 수 없습니다.", "MONEY_LIMIT"))?;
    cs["game"]["player"]["money"] = json!(creator_balance);
    js["game"]["player"]["money"] = json!(joiner_balance);
    let creator_received = if let Some((m, a)) = j_transfer {
        Some(receive(&mut cs, m, a)?)
    } else {
        None
    };
    let joiner_received = if let Some((m, a)) = c_transfer {
        Some(receive(&mut js, m, a)?)
    } else {
        None
    };
    let cn = store_trade_save(&mut tx, creator, cr, ce, cs, format!("trade-{id}-creator")).await?;
    let jn = store_trade_save(&mut tx, joiner, jr, je, js, format!("trade-{id}-joiner")).await?;
    sqlx::query("UPDATE trades SET creator_confirmed=true,joiner_confirmed=true,status='completed',version=version+1,creator_result_revision=$2,joiner_result_revision=$3,creator_received_monster_id=$4,joiner_received_monster_id=$5,updated_at=now(),completed_at=now() WHERE id=$1").bind(id).bind(cn).bind(jn).bind(creator_received).bind(joiner_received).execute(&mut *tx).await?;
    tx.commit().await?;
    let _ = state.trade_events.send(creator);
    let _ = state.trade_events.send(joiner);
    result(State(state), headers, Path(id)).await
}

async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<VersionRequest>,
) -> TradeResult<Json<Value>> {
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
        return Ok(Json(json!({"trade":room(&r,account.id,true)})));
    }
    if status == "completed" {
        tx.commit().await?;
        return result(State(state), headers, Path(id)).await;
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
    Ok(Json(json!({"trade":room(&r,account.id,true)})))
}

async fn private_result(state: &AppState, row: &PgRow, viewer: Uuid) -> TradeResult<Value> {
    let which = side(row, viewer);
    let revision: Option<i64> = row
        .try_get(format!("{which}_result_revision").as_str())
        .ok();
    let (current_revision, epoch, save) = {
        let r = sqlx::query(
            "SELECT revision,trade_epoch,payload FROM saves WHERE user_id=$1 AND slot='current'",
        )
        .bind(viewer)
        .fetch_one(&state.db)
        .await?;
        let bytes: Vec<u8> = r.get("payload");
        let mut save: Value =
            serde_json::from_slice(&decompress(&bytes).map_err(TradeError::from)?)
                .map_err(|_| invalid("거래 결과 저장을 읽을 수 없습니다."))?;
        let e = r.get::<i64, _>("trade_epoch");
        save["tradeEpoch"] = json!(e);
        (r.get::<i64, _>("revision"), e, save)
    };
    let other = if which == "creator" {
        "joiner"
    } else {
        "creator"
    };
    let neural: Option<Value> = row
        .try_get(format!("{other}_neural").as_str())
        .ok()
        .flatten();
    let instance: Option<String> = row
        .try_get(format!("{which}_received_monster_id").as_str())
        .ok();
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
    Ok(
        json!({"revision":current_revision,"committedRevision":revision,"tradeEpoch":epoch,"save":save,"incomingNeural":match (instance,neural,still_owned){(Some(instance_id),Some(neural),true)=>Some(json!({"instanceId":instance_id,"neural":neural})),_=>None}}),
    )
}
async fn result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> TradeResult<Json<Value>> {
    let account = profile_user(&state, &headers).await?;
    let row = room_row(&state.db, id).await?;
    if !is_member(&row, account.id) {
        return Err(missing());
    }
    if row.get::<String, _>("status") != "completed" {
        return Err(conflict("아직 완료되지 않은 거래입니다.", "TRADE_STATE"));
    }
    let private = private_result(&state, &row, account.id).await?;
    Ok(Json(
        json!({"trade":room(&row,account.id,true),"result":private}),
    ))
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
                Err(_) => break,
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
    #[test]
    fn neural_is_bounded() {
        let digest = "a".repeat(64);
        let valid = json!({"schema":1,"graphId":"g","gameScope":"x","state":{"checkpoint":"AQ==","checkpointId":digest,"history":[],"lastRequestId":digest,"decision":{"action":0,"updates":1,"activity":0.0,"elapsedMs":1.0,"graphId":"g","nodes":1,"edges":1}}});
        assert!(validate_neural(&valid).is_ok());
        let mut history = valid.clone();
        history["state"]["history"] = json!([{}]);
        assert!(validate_neural(&history).is_err());
        let mut malformed = valid;
        malformed["state"]["checkpoint"] = json!("not base64!");
        assert!(validate_neural(&malformed).is_err());
    }
    #[test]
    fn receive_allocates_local_id_and_remaps_memories() {
        let mut save = json!({
            "game":{"nextInstanceId":3,"adventureVersion":"red","versionCaught":{"red":[1]},"player":{"team":[{"instanceId":"mon-1"}],"box":[{"instanceId":"mon-2"}]},"dex":{"seen":[1],"caught":[1]}},
            "view":{"rewards":{},"field":{"memories":[]},"openWorld":{"player":{"x":4.0,"z":5.0},"companionMemories":[],"rewardLedgers":{}}}
        });
        let monster = json!({"instanceId":"mon-2","speciesId":25});
        let aux = Aux {
            reward: Some(json!(4)),
            field: Some(json!({"id":"mon-2","brain":{"updates":9}})),
            world: Some(json!({"id":"companion:mon-2","x":90.0,"z":90.0,"target":{"foodId":1}})),
            ledger: Some(json!({"individualId":"mon-2","lifetime":{"events":2}})),
        };
        let received = receive(&mut save, monster, aux).unwrap();
        assert_eq!(received, "mon-3");
        assert_eq!(save["game"]["nextInstanceId"], 4);
        assert_eq!(save["game"]["player"]["box"][1]["instanceId"], "mon-3");
        assert_eq!(save["game"]["versionCaught"]["red"], json!([1, 25]));
        assert_eq!(save["view"]["rewards"]["mon-3"], 4);
        assert_eq!(save["view"]["field"]["memories"][0]["id"], "mon-3");
        assert_eq!(
            save["view"]["openWorld"]["companionMemories"][0]["id"],
            "companion:mon-3"
        );
        assert_eq!(save["view"]["openWorld"]["companionMemories"][0]["x"], 4.0);
        assert!(
            save["view"]["openWorld"]["companionMemories"][0]
                .get("target")
                .is_none()
        );
        assert_eq!(
            save["view"]["openWorld"]["rewardLedgers"]["mon-3"]["individualId"],
            "mon-3"
        );
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
