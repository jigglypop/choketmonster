use crate::connectome::Connectome;
use crate::local::{LocalBatchRequest, LocalBrains, LocalError};
use crate::save_validation::validate_save;
use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    db: PgPool,
    graph: Option<Arc<Connectome>>,
    compute: Arc<Semaphore>,
    local_brains: Arc<LocalBrains>,
    attempts: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
    origin: String,
    secure: bool,
}
impl AppState {
    pub fn new(db: PgPool, graph: Option<Arc<Connectome>>) -> Self {
        Self {
            db,
            graph,
            compute: Arc::new(Semaphore::new(2)),
            local_brains: Arc::new(LocalBrains::default()),
            attempts: Default::default(),
            origin: env::var("APP_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:5173".into()),
            secure: env::var("COOKIE_SECURE")
                .map(|s| s != "false")
                .unwrap_or(true),
        }
    }
}
type ApiResult<T> = Result<T, ApiError>;
pub struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = if self.0 == StatusCode::PRECONDITION_REQUIRED {
            json!({"message": self.1, "code":"CHECKPOINT_REQUIRED"})
        } else {
            json!({"message": self.1})
        };
        (self.0, Json(body)).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "Database request failed");
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "저장 서버 요청에 실패했습니다.",
        )
    }
}
fn bad(message: &'static str) -> ApiError {
    ApiError(StatusCode::UNPROCESSABLE_ENTITY, message)
}
fn internal(error: impl std::fmt::Display) -> ApiError {
    tracing::error!(%error, "Neural request failed");
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "회로 처리에 실패했습니다.",
    )
}
pub fn router(state: AppState) -> Router {
    let auth = Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
        .layer(DefaultBodyLimit::max(4096));
    let local = Router::new()
        .route("/api/local-brains/step-batch", post(local_neural_batch))
        .layer(DefaultBodyLimit::max(2_200_000));
    let api = Router::new()
        .merge(local)
        .nest("/api/auth", auth)
        .route("/api/health", get(health))
        .route("/api/connectome", get(graph_info))
        .route("/api/saves", get(list_saves))
        .route("/api/saves/{slot}", get(load_save).put(save))
        .route("/api/brains/{creature}/step", post(retired_neural_step))
        .route("/api/brains/step-batch", post(retired_neural_batch))
        .layer(DefaultBodyLimit::max(20_000_000))
        .layer(middleware::from_fn_with_state(state.clone(), protect))
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);
    api.merge(crate::realtime::router())
}

async fn local_neural_batch(
    State(state): State<AppState>,
    Json(batch): Json<LocalBatchRequest>,
) -> ApiResult<Json<crate::local::LocalBatchResponse>> {
    let graph = state.graph.clone().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "The full connectome is not loaded.",
    ))?;
    state
        .local_brains
        .try_begin(&batch.client_id)
        .map_err(local_error)?;
    let busy = LocalBusyGuard {
        brains: state.local_brains.clone(),
        client_id: batch.client_id.clone(),
    };
    let permit = state.compute.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Neural computation is busy. Please retry shortly.",
        )
    })?;
    let worker = busy.brains.clone();
    // The worker owns the busy receipt. Dropping the HTTP future cannot unlock
    // this client while its blocking graph step is still running.
    let response = tokio::task::spawn_blocking(move || {
        let _busy = busy;
        let _permit = permit;
        worker.process(&graph, batch)
    })
    .await
    .map_err(internal)?
    .map_err(local_error)?;
    Ok(Json(response))
}

struct LocalBusyGuard {
    brains: Arc<LocalBrains>,
    client_id: String,
}

impl Drop for LocalBusyGuard {
    fn drop(&mut self) {
        self.brains.finish(&self.client_id);
    }
}

#[cfg(test)]
mod local_busy_tests {
    use super::*;

    #[test]
    fn worker_guard_releases_client_on_unwind() {
        let brains = Arc::new(LocalBrains::default());
        let client_id = "c".repeat(64);
        brains.try_begin(&client_id).unwrap();
        let guard = LocalBusyGuard {
            brains: brains.clone(),
            client_id: client_id.clone(),
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = guard;
            panic!("simulated blocking worker panic");
        }));
        brains.try_begin(&client_id).unwrap();
        brains.finish(&client_id);
    }
}

fn local_error(error: LocalError) -> ApiError {
    match error {
        LocalError::Invalid(message) => ApiError(StatusCode::UNPROCESSABLE_ENTITY, message),
        LocalError::Conflict(message) => ApiError(StatusCode::CONFLICT, message),
        LocalError::CheckpointRequired(message) => {
            ApiError(StatusCode::PRECONDITION_REQUIRED, message)
        }
        LocalError::Busy(message) => ApiError(StatusCode::TOO_MANY_REQUESTS, message),
        LocalError::Internal(message) => internal(message),
    }
}
async fn protect(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    ) {
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok());
        let cross_site = request
            .headers()
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site");
        if cross_site
            || origin.is_none()
            || origin.is_some_and(|origin| !state.origin.split(',').any(|v| origin == v.trim()))
        {
            return ApiError(StatusCode::FORBIDDEN, "허용되지 않은 요청 출처입니다.")
                .into_response();
        }
        if !request
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v.to_str().unwrap_or("").starts_with("application/json"))
        {
            return ApiError(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "JSON 요청이 필요합니다.",
            )
            .into_response();
        }
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert("x-frame-options", "DENY".parse().unwrap());
    response
        .headers_mut()
        .insert("referrer-policy", "no-referrer".parse().unwrap());
    response.headers_mut().insert(
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'"
            .parse()
            .unwrap(),
    );
    response
}
#[derive(Serialize)]
struct User {
    id: Uuid,
    username: String,
}
fn token_hash(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    let token = cookie
        .split(';')
        .find_map(|item| item.trim().strip_prefix("choketmon_session="))?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(hex::encode(Sha256::digest(token.as_bytes())))
}
async fn user(state: &AppState, headers: &HeaderMap) -> ApiResult<User> {
    let token =
        token_hash(headers).ok_or(ApiError(StatusCode::UNAUTHORIZED, "로그인이 필요합니다."))?;
    let row = sqlx::query("SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()")
        .bind(token).fetch_optional(&state.db).await?.ok_or(ApiError(StatusCode::UNAUTHORIZED, "다시 로그인해 주세요."))?;
    Ok(User {
        id: row.get("id"),
        username: row.get("username"),
    })
}
async fn profile_user(state: &AppState, headers: &HeaderMap) -> ApiResult<User> {
    let account = user(state, headers).await?;
    let profile = headers
        .get("x-choketmon-profile")
        .and_then(|value| value.to_str().ok());
    let expected = account.id.to_string();
    if profile != Some(expected.as_str()) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "로그인 계정과 이 탭의 저장 프로필이 다릅니다. 다시 로그인해 주세요.",
        ));
    }
    Ok(account)
}
fn rate_limit(state: &AppState, key: String, max: u32) -> ApiResult<()> {
    let mut attempts = state.attempts.lock().map_err(internal)?;
    attempts.retain(|_, (time, _)| time.elapsed() < Duration::from_secs(600));
    if attempts.len() >= 10000 {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "잠시 후 다시 시도해 주세요.",
        ));
    }
    let entry = attempts.entry(key).or_insert((Instant::now(), 0));
    entry.1 += 1;
    if entry.1 > max {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "시도가 너무 많습니다. 10분 후 다시 시도해 주세요.",
        ));
    }
    Ok(())
}
#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
}
fn credentials(body: Credentials) -> ApiResult<(String, String)> {
    let name = body.username.trim().to_lowercase();
    if !(3..=32).contains(&name.len())
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(bad(
            "아이디는 영문·숫자·밑줄·하이픈 3~32자로 입력해 주세요.",
        ));
    }
    if !(10..=128).contains(&body.password.len()) {
        return Err(bad("비밀번호는 10~128바이트로 입력해 주세요."));
    }
    Ok((name, body.password))
}
async fn session(state: &AppState, user: User) -> ApiResult<Response> {
    let mut random = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let token = hex::encode(random);
    sqlx::query("INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)")
        .bind(hex::encode(Sha256::digest(token.as_bytes())))
        .bind(user.id)
        .execute(&state.db)
        .await?;
    // Bound stolen/forgotten sessions per account. expires_at preserves
    // insertion order because every new token receives the same 30-day TTL.
    sqlx::query("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=$1 ORDER BY expires_at DESC OFFSET 8)")
        .bind(user.id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at<now()")
        .execute(&state.db)
        .await?;
    let secure = if state.secure { "; Secure" } else { "" };
    let cookie = format!(
        "choketmon_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000{secure}"
    );
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({"user":user}))).into_response())
}
async fn register(
    State(state): State<AppState>,
    Json(body): Json<Credentials>,
) -> ApiResult<Response> {
    let (username, password) = credentials(body)?;
    rate_limit(&state, "register:global".into(), 300)?;
    rate_limit(&state, format!("register:{username}"), 5)?;
    let permit = state
        .compute
        .clone()
        .acquire_owned()
        .await
        .map_err(internal)?;
    let hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let salt = SaltString::generate(&mut rand::rngs::OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|v| v.to_string())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(internal)?
    .map_err(internal)?;
    let account = User {
        id: Uuid::new_v4(),
        username,
    };
    let inserted = sqlx::query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3) ON CONFLICT(username) DO NOTHING")
        .bind(account.id).bind(&account.username).bind(hash).execute(&state.db).await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "이미 사용 중인 아이디입니다.",
        ));
    }
    session(&state, account).await
}
async fn login(
    State(state): State<AppState>,
    Json(body): Json<Credentials>,
) -> ApiResult<Response> {
    let (username, password) = credentials(body)?;
    rate_limit(&state, "login:global".into(), 300)?;
    rate_limit(&state, format!("login:{username}"), 20)?;
    let row = sqlx::query("SELECT id,username,password_hash FROM users WHERE username=$1")
        .bind(&username)
        .fetch_optional(&state.db)
        .await?;
    let hash: Option<String> = row.as_ref().map(|r| r.get("password_hash"));
    let permit = state
        .compute
        .clone()
        .acquire_owned()
        .await
        .map_err(internal)?;
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if let Some(hash) = hash {
            PasswordHash::new(&hash).is_ok_and(|h| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &h)
                    .is_ok()
            })
        } else {
            let salt = SaltString::generate(&mut rand::rngs::OsRng);
            let _ = Argon2::default().hash_password(password.as_bytes(), &salt);
            false
        }
    })
    .await
    .map_err(internal)?;
    if !valid {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "아이디 또는 비밀번호가 올바르지 않습니다.",
        ));
    }
    let row = row.unwrap();
    session(
        &state,
        User {
            id: row.get("id"),
            username: row.get("username"),
        },
    )
    .await
}
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(hash) = token_hash(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(hash)
            .execute(&state.db)
            .await?;
    }
    let secure = if state.secure { "; Secure" } else { "" };
    Ok((
        StatusCode::NO_CONTENT,
        [(
            header::SET_COOKIE,
            format!("choketmon_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{secure}"),
        )],
    )
        .into_response())
}
async fn me(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    match user(&state, &headers).await {
        Ok(u) => Ok(Json(json!({"user":u}))),
        Err(ApiError(StatusCode::UNAUTHORIZED, _)) => Ok(Json(json!({"user":null}))),
        Err(e) => Err(e),
    }
}
async fn health(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(
        json!({"status":"ok","server":"rust","database":"postgresql","connectome":state.graph.is_some()}),
    ))
}
async fn graph_info(State(state): State<AppState>) -> Json<Value> {
    Json(
        state
            .graph
            .as_ref()
            .map(|g| {
                let mut info = g.info();
                info["available"] = json!(true);
                info
            })
            .unwrap_or(json!({"available":false})),
    )
}
fn identifier(value: &str) -> ApiResult<()> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err(bad("올바르지 않은 저장 식별자입니다."));
    }
    Ok(())
}
fn compress(bytes: &[u8]) -> ApiResult<Vec<u8>> {
    let mut e = GzEncoder::new(Vec::new(), Compression::fast());
    e.write_all(bytes).map_err(internal)?;
    e.finish().map_err(internal)
}
fn decompress(bytes: &[u8]) -> ApiResult<Vec<u8>> {
    let mut out = Vec::new();
    GzDecoder::new(bytes)
        .take(64_000_001)
        .read_to_end(&mut out)
        .map_err(internal)?;
    if out.len() > 64_000_000 {
        return Err(bad("저장 데이터가 너무 큽니다."));
    }
    Ok(out)
}
async fn list_saves(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = profile_user(&state, &headers).await?;
    let rows=sqlx::query("SELECT slot,revision,updated_at::text FROM saves WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100").bind(user.id).fetch_all(&state.db).await?;
    Ok(Json(
        json!({"saves":rows.iter().map(|r|json!({"slot":r.get::<String,_>("slot"),"revision":r.get::<i64,_>("revision"),"updatedAt":r.get::<String,_>("updated_at")})).collect::<Vec<_>>()}),
    ))
}
async fn load_save(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slot): Path<String>,
) -> ApiResult<Json<Value>> {
    identifier(&slot)?;
    let user = profile_user(&state, &headers).await?;
    let row = sqlx::query("SELECT revision,payload FROM saves WHERE user_id=$1 AND slot=$2")
        .bind(user.id)
        .bind(slot)
        .fetch_optional(&state.db)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "저장된 모험이 없습니다."))?;
    let bytes: Vec<u8> = row.get("payload");
    let payload: Value = serde_json::from_slice(&decompress(&bytes)?).map_err(internal)?;
    Ok(Json(
        json!({"save":payload,"revision":row.get::<i64,_>("revision")}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRequest {
    save: Value,
    revision: i64,
    request_id: String,
}
async fn save(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slot): Path<String>,
    Json(body): Json<SaveRequest>,
) -> ApiResult<Json<Value>> {
    identifier(&slot)?;
    identifier(&body.request_id)?;
    let user = profile_user(&state, &headers).await?;
    rate_limit(&state, format!("save:{}", user.id), 600)?;
    let value = &body.save;
    if body.revision < 0 {
        return Err(bad("저장 리비전이 올바르지 않습니다."));
    }
    validate_save(value).map_err(bad)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("save:{}", user.id))
        .execute(&mut *tx)
        .await?;
    let prior = sqlx::query(
        "SELECT revision,request_id,payload_hash FROM saves WHERE user_id=$1 AND slot=$2",
    )
    .bind(user.id)
    .bind(&slot)
    .fetch_optional(&mut *tx)
    .await?;
    let revision = prior
        .as_ref()
        .map(|r| r.get::<i64, _>("revision"))
        .unwrap_or(0);
    let raw = serde_json::to_vec(value).map_err(internal)?;
    let payload_hash = hex::encode(Sha256::digest(&raw));
    if let Some(receipt) = sqlx::query("SELECT revision,payload_hash FROM save_requests WHERE user_id=$1 AND slot=$2 AND request_id=$3")
        .bind(user.id).bind(&slot).bind(&body.request_id).fetch_optional(&mut *tx).await? {
        if receipt.get::<String, _>("payload_hash") != payload_hash {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "같은 요청 ID의 저장 내용이 다릅니다.",
            ));
        }
        return Ok(Json(json!({"revision":receipt.get::<i64,_>("revision")})));
    }
    if revision != body.revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "다른 기기의 저장이 있습니다. 현재 진행은 이 기기에 보존됐습니다. 새로고침 전에 내보내기로 백업해 주세요.",
        ));
    }
    let bytes = compress(&raw)?;
    let quota=sqlx::query("SELECT count(*)::bigint AS slots,COALESCE(sum(octet_length(payload)),0)::bigint AS bytes FROM saves WHERE user_id=$1 AND slot<>$2").bind(user.id).bind(&slot).fetch_one(&mut *tx).await?;
    if quota.get::<i64, _>("slots") >= 128
        || quota.get::<i64, _>("bytes") + bytes.len() as i64 > 64_000_000
    {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "계정 저장 한도(128개, 압축 64MB)에 도달했습니다.",
        ));
    }
    sqlx::query("INSERT INTO saves(user_id,slot,revision,request_id,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,slot) DO UPDATE SET revision=excluded.revision,request_id=excluded.request_id,payload=excluded.payload,payload_hash=excluded.payload_hash,updated_at=now()")
        .bind(user.id).bind(&slot).bind(revision+1).bind(&body.request_id).bind(bytes).bind(&payload_hash).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO save_requests(user_id,slot,request_id,payload_hash,revision) VALUES($1,$2,$3,$4,$5)")
        .bind(user.id).bind(&slot).bind(&body.request_id).bind(&payload_hash).bind(revision+1).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM save_requests WHERE user_id=$1 AND created_at<now()-interval '1 day'")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"revision":revision+1})))
}

async fn retired_neural_step(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(creature): Path<String>,
    Json(_body): Json<Value>,
) -> ApiResult<Response> {
    identifier(&creature)?;
    let _ = user(&state, &headers).await?;
    Ok((StatusCode::GONE, Json(json!({
        "message":"계정용 회로 API는 종료되었습니다. /api/local-brains/step-batch와 기기 체크포인트를 사용해 주세요.",
        "code":"LOCAL_CHECKPOINT_REQUIRED"
    }))).into_response())
}

async fn retired_neural_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(_body): Json<Value>,
) -> ApiResult<Response> {
    let _ = user(&state, &headers).await?;
    Ok((StatusCode::GONE, Json(json!({
        "message":"계정용 회로 API는 종료되었습니다. /api/local-brains/step-batch와 기기 체크포인트를 사용해 주세요.",
        "code":"LOCAL_CHECKPOINT_REQUIRED"
    }))).into_response())
}
