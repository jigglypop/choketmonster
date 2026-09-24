use axum::{
    Json, Router,
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::mpsc;
use uuid::Uuid;

const TICK_RATE: u64 = 10;
const OUTBOUND_CAPACITY: usize = 16;
const MAX_MESSAGE_BYTES: usize = 4096;
const MAX_CHAT_CHARS: usize = 200;
const CHAT_HISTORY: usize = 50;
const MAX_CONNECTION_MESSAGES: usize = 40;
const CONNECTION_MESSAGE_PERIOD: Duration = Duration::from_secs(1);
const SOCKET_SEND_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);
const TICKET_TTL_SECONDS: u64 = 60;

#[derive(Debug, Deserialize, Serialize)]
struct TicketClaims {
    sub: Uuid,
    username: String,
    exp: u64,
    nonce: String,
}

fn hmac_sha256(secret: &[u8], message: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 64];
    if secret.len() > 64 {
        key[..32].copy_from_slice(&Sha256::digest(secret));
    } else {
        key[..secret.len()].copy_from_slice(secret);
    }
    let mut inner = [0x36u8; 64];
    let mut outer = [0x5cu8; 64];
    for i in 0..64 {
        inner[i] ^= key[i];
        outer[i] ^= key[i];
    }
    let inner_hash = Sha256::new()
        .chain_update(inner)
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(outer)
        .chain_update(inner_hash)
        .finalize()
        .into()
}

fn ticket_secret() -> Result<Vec<u8>, &'static str> {
    let value =
        env::var("REALTIME_TICKET_SECRET").map_err(|_| "실시간 인증이 설정되지 않았습니다.")?;
    if value.as_bytes().len() < 32 {
        return Err("실시간 인증 키가 너무 짧습니다.");
    }
    Ok(value.into_bytes())
}

pub fn issue_ticket(user_id: Uuid, username: &str) -> Result<(String, u64), &'static str> {
    issue_ticket_with_secret(user_id, username, &ticket_secret()?)
}

fn issue_ticket_with_secret(
    user_id: Uuid,
    username: &str,
    secret: &[u8],
) -> Result<(String, u64), &'static str> {
    if username.is_empty() || username.len() > 32 {
        return Err("계정 이름이 올바르지 않습니다.");
    }
    let exp = epoch_seconds() + TICKET_TTL_SECONDS;
    let mut nonce = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let claims = TicketClaims {
        sub: user_id,
        username: username.to_owned(),
        exp,
        nonce: hex::encode(nonce),
    };
    let payload =
        serde_json::to_vec(&claims).map_err(|_| "실시간 인증 티켓을 만들 수 없습니다.")?;
    let encoder = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let body = encoder.encode(payload);
    let signature = encoder.encode(hmac_sha256(secret, body.as_bytes()));
    Ok((format!("{body}.{signature}"), exp))
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Region {
    Johto,
    Kanto,
    Hoenn,
    Sinnoh,
    Unova,
    Kalos,
    Alola,
    Galar,
    Hisui,
    Paldea,
}
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RoomKey {
    region: Region,
    scene_id: String,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Activity {
    Idle,
    Moving,
    Battle,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemotePlayer {
    id: String,
    name: String,
    region: Region,
    scene_id: String,
    species_id: i64,
    x: f64,
    z: f64,
    heading: f64,
    activity: Activity,
    updated_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    id: String,
    player_id: String,
    name: String,
    text: String,
    sent_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum ClientMessage {
    Join {
        region: Region,
        #[serde(rename = "sceneId")]
        scene_id: String,
        #[serde(rename = "speciesId")]
        species_id: i64,
        x: f64,
        z: f64,
        heading: f64,
        activity: Activity,
    },
    State {
        seq: u64,
        x: f64,
        z: f64,
        heading: f64,
        #[serde(rename = "speciesId")]
        species_id: i64,
        activity: Activity,
    },
    Chat {
        text: String,
    },
    Reauth {
        ticket: String,
    },
    Ping {
        #[serde(rename = "sentAt")]
        sent_at: f64,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ServerMessage {
    Welcome {
        id: String,
        region: Region,
        #[serde(rename = "sceneId")]
        scene_id: String,
        #[serde(rename = "tickRate")]
        tick_rate: u64,
        players: Vec<RemotePlayer>,
        history: Vec<ChatMessage>,
    },
    Patch {
        region: Region,
        #[serde(rename = "sceneId")]
        scene_id: String,
        players: Vec<RemotePlayer>,
        left: Vec<String>,
    },
    Chat {
        region: Region,
        #[serde(rename = "sceneId")]
        scene_id: String,
        message: ChatMessage,
    },
    Pong {
        #[serde(rename = "sentAt")]
        sent_at: f64,
    },
    Error {
        code: &'static str,
        message: &'static str,
    },
}

#[derive(Clone)]
struct RealtimeState {
    inner: Arc<RealtimeInner>,
}

struct RealtimeInner {
    hub: Mutex<Hub>,
    allowed_origins: Vec<String>,
    room_capacity: usize,
    server_capacity: usize,
    ticket_secret: Vec<u8>,
    used_tickets: Mutex<HashMap<String, u64>>,
}

#[derive(Default)]
struct Hub {
    clients: HashMap<String, Client>,
    rooms: HashMap<RoomKey, Room>,
}

struct Client {
    tx: mpsc::Sender<Message>,
    room: Option<RoomKey>,
    last_seq: Option<u64>,
    message_rate: RateWindow,
    state_rate: RateWindow,
    chat_rate: RateWindow,
    username: String,
    auth_expires_at: u64,
}

#[derive(Default)]
struct Room {
    players: HashMap<String, RemotePlayer>,
    history: VecDeque<ChatMessage>,
    dirty: HashSet<String>,
    left: HashSet<String>,
}

#[derive(Default)]
struct RateWindow(VecDeque<Instant>);

impl RateWindow {
    fn allow(&mut self, now: Instant, maximum: usize, period: Duration) -> bool {
        while self
            .0
            .front()
            .is_some_and(|time| now.duration_since(*time) >= period)
        {
            self.0.pop_front();
        }
        if self.0.len() >= maximum {
            return false;
        }
        self.0.push_back(now);
        true
    }
}

impl RealtimeState {
    fn from_env() -> Self {
        let allowed_origins = env::var("APP_ORIGIN")
            .unwrap_or_else(|_| "http://127.0.0.1:5173".into())
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect();
        Self::new_with_secret(
            allowed_origins,
            env_capacity("REALTIME_ROOM_CAPACITY", 64),
            env_capacity("REALTIME_SERVER_CAPACITY", 256),
            ticket_secret().unwrap_or_default(),
        )
    }

    #[cfg(test)]
    fn new(allowed_origins: Vec<String>, room_capacity: usize, server_capacity: usize) -> Self {
        Self::new_with_secret(
            allowed_origins,
            room_capacity,
            server_capacity,
            b"test-realtime-ticket-secret-32bytes".to_vec(),
        )
    }
    fn new_with_secret(
        allowed_origins: Vec<String>,
        room_capacity: usize,
        server_capacity: usize,
        ticket_secret: Vec<u8>,
    ) -> Self {
        Self {
            inner: Arc::new(RealtimeInner {
                hub: Mutex::new(Hub::default()),
                allowed_origins,
                room_capacity: room_capacity.clamp(1, 256),
                server_capacity: server_capacity.clamp(1, 4096),
                ticket_secret,
                used_tickets: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn start(&self) {
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move { patch_loop(inner).await });
    }
}

fn env_capacity(name: &str, default: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

pub fn router() -> Router {
    let state = RealtimeState::from_env();
    router_with_state(state)
}

fn router_with_state(state: RealtimeState) -> Router {
    state.start();
    Router::new()
        .route("/api/realtime", get(upgrade))
        .route("/api/realtime/health", get(health))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

async fn security_headers(request: axum::extract::Request, next: Next) -> Response {
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

async fn health(State(state): State<RealtimeState>) -> Json<serde_json::Value> {
    let hub = state
        .inner
        .hub
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    Json(json!({
        "status":"ok", "server":"realtime", "schema":1, "tickRate":TICK_RATE,
        "connections":hub.clients.len(),
        "players":hub.rooms.values().map(|room| room.players.len()).sum::<usize>(),
        "rooms":hub.rooms.values().filter(|room| !room.players.is_empty()).count()
    }))
}

#[derive(Deserialize)]
struct TicketQuery {
    ticket: String,
}

fn verify_ticket(state: &RealtimeState, ticket: &str) -> Result<TicketClaims, &'static str> {
    if state.inner.ticket_secret.len() < 32 || ticket.len() > 2048 {
        return Err("실시간 인증 티켓이 올바르지 않습니다.");
    }
    let (body, signature) = ticket
        .split_once('.')
        .ok_or("실시간 인증 티켓이 올바르지 않습니다.")?;
    let encoder = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let supplied = encoder
        .decode(signature)
        .map_err(|_| "실시간 인증 티켓이 올바르지 않습니다.")?;
    let expected = hmac_sha256(&state.inner.ticket_secret, body.as_bytes());
    if supplied.len() != expected.len()
        || !supplied
            .iter()
            .zip(expected)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            .eq(&0)
    {
        return Err("실시간 인증 티켓 서명이 올바르지 않습니다.");
    }
    let payload = encoder
        .decode(body)
        .map_err(|_| "실시간 인증 티켓이 올바르지 않습니다.")?;
    let claims: TicketClaims =
        serde_json::from_slice(&payload).map_err(|_| "실시간 인증 티켓이 올바르지 않습니다.")?;
    let now = epoch_seconds();
    if claims.exp < now
        || claims.exp > now + TICKET_TTL_SECONDS + 5
        || claims.username.is_empty()
        || claims.username.len() > 32
    {
        return Err("실시간 인증 티켓이 만료되었습니다.");
    }
    let receipt = hex::encode(Sha256::digest(ticket.as_bytes()));
    let mut used = state
        .inner
        .used_tickets
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    used.retain(|_, exp| *exp >= now);
    if used.insert(receipt, claims.exp).is_some() {
        return Err("이미 사용한 실시간 인증 티켓입니다.");
    }
    Ok(claims)
}

async fn upgrade(
    State(state): State<RealtimeState>,
    headers: HeaderMap,
    Query(query): Query<TicketQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if origin.is_none()
        || origin.is_some_and(|origin| {
            !state
                .inner
                .allowed_origins
                .iter()
                .any(|value| value == origin)
        })
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"code":"ORIGIN","message":"허용되지 않은 요청 출처입니다."})),
        )
            .into_response();
    }
    let claims = match verify_ticket(&state, &query.ticket) {
        Ok(value) => value,
        Err(message) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"code":"AUTH_REQUIRED","message":message})),
            )
                .into_response();
        }
    };
    let (tx, rx) = mpsc::channel(OUTBOUND_CAPACITY);
    let id = claims.sub.to_string();
    {
        let mut hub = state
            .inner
            .hub
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if hub.clients.len() >= state.inner.server_capacity {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"code":"SERVER_FULL","message":"실시간 서버가 가득 찼습니다."})),
            )
                .into_response();
        }
        if hub.clients.contains_key(&id) {
            return (
                StatusCode::CONFLICT,
                Json(json!({"code":"ALREADY_CONNECTED","message":"이 계정은 이미 접속 중입니다."})),
            )
                .into_response();
        }
        hub.clients.insert(
            id.clone(),
            Client {
                tx,
                room: None,
                last_seq: None,
                message_rate: RateWindow::default(),
                state_rate: RateWindow::default(),
                chat_rate: RateWindow::default(),
                username: claims.username,
                auth_expires_at: claims.exp,
            },
        );
    }
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| connection(socket, state, id, rx))
}

async fn connection(
    mut socket: WebSocket,
    state: RealtimeState,
    id: String,
    mut outbound: mpsc::Receiver<Message>,
) {
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if !allow_connection_message(&state, &id, Instant::now()) { break; }
                    last_seen = Instant::now();
                    if text.len() > MAX_MESSAGE_BYTES {
                        send_error(&state, &id, "MESSAGE_TOO_LARGE", "메시지가 너무 큽니다.");
                        continue;
                    }
                    match serde_json::from_str::<ClientMessage>(&text) {
                        Ok(message) => process(&state, &id, message, Instant::now()),
                        Err(_) => send_error(&state, &id, "INVALID_MESSAGE", "메시지 형식이 올바르지 않습니다."),
                    }
                }
                Some(Ok(Message::Pong(_))) => {
                    if !allow_connection_message(&state, &id, Instant::now()) { break; }
                    last_seen = Instant::now();
                }
                Some(Ok(Message::Ping(payload))) => {
                    if !allow_connection_message(&state, &id, Instant::now()) { break; }
                    last_seen = Instant::now();
                    if !send_socket(&mut socket, Message::Pong(payload)).await { break; }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(Message::Binary(_))) => {
                    if !allow_connection_message(&state, &id, Instant::now()) { break; }
                    send_error(&state, &id, "INVALID_MESSAGE", "JSON 텍스트 메시지가 필요합니다.");
                }
            },
            outgoing = outbound.recv() => match outgoing {
                Some(message) => if !send_socket(&mut socket, message).await { break; },
                None => break,
            },
            _ = heartbeat.tick() => {
                if !authentication_valid(&state, &id) { break; }
                if last_seen.elapsed() >= HEARTBEAT_TIMEOUT { break; }
                if !send_socket(&mut socket, Message::Ping(Vec::new().into())).await { break; }
            }
        }
    }
    disconnect(&state.inner, &id);
}

async fn send_socket(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(SOCKET_SEND_TIMEOUT, socket.send(message)).await,
        Ok(Ok(()))
    )
}

fn allow_connection_message(state: &RealtimeState, id: &str, now: Instant) -> bool {
    let mut hub = state
        .inner
        .hub
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    hub.clients.get_mut(id).is_some_and(|client| {
        client
            .message_rate
            .allow(now, MAX_CONNECTION_MESSAGES, CONNECTION_MESSAGE_PERIOD)
    })
}

fn process(state: &RealtimeState, id: &str, message: ClientMessage, now: Instant) {
    match message {
        ClientMessage::Join {
            region,
            scene_id,
            species_id,
            x,
            z,
            heading,
            activity,
        } => {
            join(
                state, id, region, scene_id, species_id, x, z, heading, activity,
            );
        }
        ClientMessage::State {
            seq,
            x,
            z,
            heading,
            species_id,
            activity,
        } => {
            update_player(state, id, seq, x, z, heading, species_id, activity, now);
        }
        ClientMessage::Chat { text } => chat(state, id, text, now),
        ClientMessage::Reauth { ticket } => reauthenticate(state, id, &ticket),
        ClientMessage::Ping { sent_at } => {
            let joined = state
                .inner
                .hub
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clients
                .get(id)
                .is_some_and(|client| client.room.is_some());
            if !joined {
                send_error(state, id, "JOIN_REQUIRED", "먼저 지역에 접속해 주세요.");
            } else if !sent_at.is_finite() {
                send_error(
                    state,
                    id,
                    "INVALID_MESSAGE",
                    "ping 시간이 올바르지 않습니다.",
                );
            } else {
                send_to(state, id, &ServerMessage::Pong { sent_at });
            }
        }
    }
}

fn authentication_valid(state: &RealtimeState, id: &str) -> bool {
    state
        .inner
        .hub
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clients
        .get(id)
        .is_some_and(|client| client.auth_expires_at >= epoch_seconds())
}

fn reauthenticate(state: &RealtimeState, id: &str, ticket: &str) {
    let Ok(claims) = verify_ticket(state, ticket) else {
        send_error(
            state,
            id,
            "AUTH_REQUIRED",
            "실시간 인증을 갱신할 수 없습니다.",
        );
        return;
    };
    if claims.sub.to_string() != id {
        send_error(
            state,
            id,
            "AUTH_REQUIRED",
            "다른 계정의 인증은 사용할 수 없습니다.",
        );
        return;
    }
    let mut hub = state
        .inner
        .hub
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let Some(client) = hub.clients.get_mut(id) else {
        return;
    };
    if client.username != claims.username {
        drop(hub);
        send_error(state, id, "AUTH_REQUIRED", "계정 정보가 변경되었습니다.");
        return;
    }
    client.auth_expires_at = claims.exp;
}

#[allow(clippy::too_many_arguments)]
fn join(
    state: &RealtimeState,
    id: &str,
    region: Region,
    scene_id: String,
    species_id: i64,
    x: f64,
    z: f64,
    heading: f64,
    activity: Activity,
) {
    if !valid_position(x, z, heading)
        || !(1..=1025).contains(&species_id)
        || !valid_scene(region, &scene_id)
    {
        send_error(
            state,
            id,
            "INVALID_JOIN",
            "접속 위치나 포켓몬이 올바르지 않습니다.",
        );
        return;
    }
    let hub = state
        .inner
        .hub
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let next_room = RoomKey { region, scene_id };
    let Some(current_room) = hub.clients.get(id).and_then(|client| client.room.clone()) else {
        if !hub.clients.contains_key(id) {
            return;
        }
        if hub
            .rooms
            .get(&next_room)
            .is_some_and(|room| room.players.len() >= state.inner.room_capacity)
        {
            drop(hub);
            send_error(
                state,
                id,
                "ROOM_FULL",
                "이 지역의 실시간 방이 가득 찼습니다.",
            );
            return;
        }
        return finish_join(
            state, hub, id, None, next_room, species_id, x, z, heading, activity,
        );
    };
    if current_room != next_room
        && hub
            .rooms
            .get(&next_room)
            .is_some_and(|room| room.players.len() >= state.inner.room_capacity)
    {
        drop(hub);
        send_error(
            state,
            id,
            "ROOM_FULL",
            "이 지역의 실시간 방이 가득 찼습니다.",
        );
        return;
    }
    finish_join(
        state,
        hub,
        id,
        Some(current_room),
        next_room,
        species_id,
        x,
        z,
        heading,
        activity,
    );
}

#[allow(clippy::too_many_arguments)]
fn finish_join(
    state: &RealtimeState,
    mut hub: std::sync::MutexGuard<'_, Hub>,
    id: &str,
    old_room: Option<RoomKey>,
    room_key: RoomKey,
    species_id: i64,
    x: f64,
    z: f64,
    heading: f64,
    activity: Activity,
) {
    if let Some(old) = old_room.filter(|old| *old != room_key) {
        if let Some(room) = hub.rooms.get_mut(&old) {
            room.players.remove(id);
            room.dirty.remove(id);
            room.left.insert(id.to_owned());
        }
    }
    let name = hub
        .clients
        .get(id)
        .map(|client| client.username.clone())
        .unwrap_or_default();
    let player = RemotePlayer {
        id: id.to_owned(),
        name,
        region: room_key.region,
        scene_id: room_key.scene_id.clone(),
        species_id,
        x,
        z,
        heading,
        activity,
        updated_at: epoch_ms(),
    };
    let room = hub.rooms.entry(room_key.clone()).or_default();
    room.left.remove(id);
    room.dirty.insert(id.to_owned());
    room.players.insert(id.to_owned(), player);
    let players = room.players.values().cloned().collect();
    let history = room.history.iter().cloned().collect();
    let Some(client) = hub.clients.get_mut(id) else {
        return;
    };
    client.room = Some(room_key.clone());
    client.last_seq = None;
    client.state_rate = RateWindow::default();
    let message = ServerMessage::Welcome {
        id: id.to_owned(),
        region: room_key.region,
        scene_id: room_key.scene_id,
        tick_rate: TICK_RATE,
        players,
        history,
    };
    let failed = try_send(&client.tx, &message).is_err();
    drop(hub);
    if failed {
        disconnect(&state.inner, id);
    }
}

#[allow(clippy::too_many_arguments)]
fn update_player(
    state: &RealtimeState,
    id: &str,
    seq: u64,
    x: f64,
    z: f64,
    heading: f64,
    species_id: i64,
    activity: Activity,
    now: Instant,
) {
    if !valid_position(x, z, heading) || !(1..=1025).contains(&species_id) {
        send_error(
            state,
            id,
            "INVALID_STATE",
            "플레이어 상태가 올바르지 않습니다.",
        );
        return;
    }
    let mut hub = state
        .inner
        .hub
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let Some(client) = hub.clients.get_mut(id) else {
        return;
    };
    let Some(room_key) = client.room.clone() else {
        drop(hub);
        send_error(state, id, "JOIN_REQUIRED", "먼저 지역에 접속해 주세요.");
        return;
    };
    if client.last_seq.is_some_and(|last| seq <= last) {
        drop(hub);
        send_error(
            state,
            id,
            "STALE_SEQ",
            "이전 상태 번호는 적용할 수 없습니다.",
        );
        return;
    }
    if !client.state_rate.allow(now, 15, Duration::from_secs(1)) {
        drop(hub);
        send_error(state, id, "RATE_LIMIT", "상태 갱신이 너무 빠릅니다.");
        return;
    }
    client.last_seq = Some(seq);
    let room = hub
        .rooms
        .get_mut(&room_key)
        .expect("joined client room must exist");
    let player = room
        .players
        .get_mut(id)
        .expect("joined client player must exist");
    player.x = x;
    player.z = z;
    player.heading = heading;
    player.species_id = species_id;
    player.activity = activity;
    player.updated_at = epoch_ms();
    room.dirty.insert(id.to_owned());
}

fn chat(state: &RealtimeState, id: &str, text: String, now: Instant) {
    let Some(text) = normalize_chat(&text) else {
        send_error(state, id, "INVALID_CHAT", "채팅은 1~200자로 입력해 주세요.");
        return;
    };
    let mut hub = state
        .inner
        .hub
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let Some(client) = hub.clients.get_mut(id) else {
        return;
    };
    let Some(room_key) = client.room.clone() else {
        drop(hub);
        send_error(state, id, "JOIN_REQUIRED", "먼저 지역에 접속해 주세요.");
        return;
    };
    if !client.chat_rate.allow(now, 5, Duration::from_secs(10)) {
        drop(hub);
        send_error(state, id, "RATE_LIMIT", "채팅을 너무 빠르게 보냈습니다.");
        return;
    }
    let (message, recipient_ids) = {
        let room = hub
            .rooms
            .get_mut(&room_key)
            .expect("joined client room must exist");
        let player = room
            .players
            .get(id)
            .expect("joined client player must exist");
        let message = ChatMessage {
            id: Uuid::new_v4().to_string(),
            player_id: id.to_owned(),
            name: player.name.clone(),
            text,
            sent_at: epoch_ms(),
        };
        room.history.push_back(message.clone());
        while room.history.len() > CHAT_HISTORY {
            room.history.pop_front();
        }
        (message, room.players.keys().cloned().collect::<Vec<_>>())
    };
    let senders: Vec<_> = recipient_ids
        .into_iter()
        .filter_map(|id| hub.clients.get(&id).map(|client| (id, client.tx.clone())))
        .collect();
    drop(hub);
    broadcast(
        &state.inner,
        senders,
        &ServerMessage::Chat {
            region: room_key.region,
            scene_id: room_key.scene_id,
            message,
        },
    );
}

fn normalize_chat(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty()
        || normalized.chars().count() > MAX_CHAT_CHARS
        || normalized.chars().any(char::is_control)
    {
        None
    } else {
        Some(normalized)
    }
}

fn valid_position(x: f64, z: f64, heading: f64) -> bool {
    x.is_finite()
        && z.is_finite()
        && heading.is_finite()
        && x.abs() <= 1000.0
        && z.abs() <= 1000.0
        && heading.abs() <= 360.0
}
fn valid_scene(region: Region, value: &str) -> bool {
    if value.len() > 64 {
        return false;
    }
    let expected_region = match region {
        Region::Kanto => "kanto",
        Region::Johto => "johto",
        Region::Hoenn => "hoenn",
        Region::Sinnoh => "sinnoh",
        Region::Unova => "unova",
        Region::Kalos => "kalos",
        Region::Alola => "alola",
        Region::Galar => "galar",
        Region::Hisui => "hisui",
        Region::Paldea => "paldea",
    };
    let mut parts = value.split(':');
    matches!(parts.next(), Some("surface") | Some("cave"))
        && parts.next() == Some(expected_region)
        && match parts.next() {
            None => value.starts_with("surface:"),
            Some(id) => {
                value.starts_with("cave:")
                    && !id.is_empty()
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    && parts.next().is_none()
            }
        }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn send_error(state: &RealtimeState, id: &str, code: &'static str, message: &'static str) {
    send_to(state, id, &ServerMessage::Error { code, message });
}

fn send_to(state: &RealtimeState, id: &str, message: &ServerMessage) {
    let tx = {
        let hub = state
            .inner
            .hub
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        hub.clients.get(id).map(|client| client.tx.clone())
    };
    if tx.is_some_and(|tx| try_send(&tx, message).is_err()) {
        disconnect(&state.inner, id);
    }
}

fn try_send(tx: &mpsc::Sender<Message>, message: &ServerMessage) -> Result<(), ()> {
    let text = serde_json::to_string(message).map_err(|_| ())?;
    tx.try_send(Message::Text(text.into())).map_err(|_| ())
}

fn broadcast(
    inner: &Arc<RealtimeInner>,
    senders: Vec<(String, mpsc::Sender<Message>)>,
    message: &ServerMessage,
) {
    let failed: Vec<_> = senders
        .into_iter()
        .filter_map(|(id, tx)| try_send(&tx, message).err().map(|_| id))
        .collect();
    for id in failed {
        disconnect(inner, &id);
    }
}

fn disconnect(inner: &Arc<RealtimeInner>, id: &str) {
    let mut hub = inner.hub.lock().unwrap_or_else(|error| error.into_inner());
    let Some(client) = hub.clients.remove(id) else {
        return;
    };
    if let Some(room_key) = client.room {
        if let Some(room) = hub.rooms.get_mut(&room_key) {
            room.players.remove(id);
            room.dirty.remove(id);
            room.left.insert(id.to_owned());
        }
    }
}

async fn patch_loop(inner: Weak<RealtimeInner>) {
    let mut interval = tokio::time::interval(Duration::from_millis(1000 / TICK_RATE));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let Some(inner) = inner.upgrade() else {
            break;
        };
        flush_patches(&inner);
    }
}

fn flush_patches(inner: &Arc<RealtimeInner>) {
    let batches = {
        let mut hub = inner.hub.lock().unwrap_or_else(|error| error.into_inner());
        let regions: Vec<_> = hub.rooms.keys().cloned().collect();
        let mut batches = Vec::new();
        for region in regions {
            let Some((players, left, recipient_ids)) =
                hub.rooms.get_mut(&region).and_then(|room| {
                    if room.dirty.is_empty() && room.left.is_empty() {
                        return None;
                    }
                    let mut players: Vec<_> = room
                        .dirty
                        .iter()
                        .filter_map(|id| room.players.get(id).cloned())
                        .collect();
                    for player in &mut players {
                        player.x = quantize(player.x);
                        player.z = quantize(player.z);
                    }
                    let mut left: Vec<_> = room.left.drain().collect();
                    room.dirty.clear();
                    players.sort_by(|a, b| a.id.cmp(&b.id));
                    left.sort();
                    Some((
                        players,
                        left,
                        room.players.keys().cloned().collect::<Vec<_>>(),
                    ))
                })
            else {
                continue;
            };
            let recipients: Vec<_> = recipient_ids
                .into_iter()
                .filter_map(|id| hub.clients.get(&id).map(|client| (id, client.tx.clone())))
                .collect();
            batches.push((
                recipients,
                ServerMessage::Patch {
                    region: region.region,
                    scene_id: region.scene_id,
                    players,
                    left,
                },
            ));
        }
        batches
    };
    for (senders, message) in batches {
        broadcast(inner, senders, &message);
    }
}

fn quantize(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{Message as ClientFrame, client::IntoClientRequest},
    };

    fn test_state(room_capacity: usize) -> RealtimeState {
        RealtimeState::new(vec!["http://localhost".into()], room_capacity, 256)
    }

    fn connect(state: &RealtimeState, id: &str) -> mpsc::Receiver<Message> {
        let (tx, rx) = mpsc::channel(OUTBOUND_CAPACITY);
        state.inner.hub.lock().unwrap().clients.insert(
            id.into(),
            Client {
                tx,
                room: None,
                last_seq: None,
                message_rate: RateWindow::default(),
                state_rate: RateWindow::default(),
                chat_rate: RateWindow::default(),
                username: "tester".into(),
                auth_expires_at: epoch_seconds() + TICKET_TTL_SECONDS,
            },
        );
        rx
    }

    fn join_test(state: &RealtimeState, id: &str, region: Region) {
        let scene = match region {
            Region::Kanto => "surface:kanto",
            Region::Johto => "surface:johto",
            Region::Hoenn => "surface:hoenn",
            Region::Sinnoh => "surface:sinnoh",
            Region::Unova => "surface:unova",
            Region::Kalos => "surface:kalos",
            Region::Alola => "surface:alola",
            Region::Galar => "surface:galar",
            Region::Hisui => "surface:hisui",
            Region::Paldea => "surface:paldea",
        };
        join(
            state,
            id,
            region,
            scene.into(),
            25,
            1.0,
            2.0,
            0.0,
            Activity::Idle,
        );
    }

    #[test]
    fn isolates_rooms_and_tracks_moves_and_cleanup_as_deltas() {
        let state = test_state(64);
        let mut a = connect(&state, "aaaa");
        let _b = connect(&state, "bbbb");
        join_test(&state, "aaaa", Region::Johto);
        join_test(&state, "bbbb", Region::Kanto);
        a.try_recv().unwrap();
        flush_patches(&state.inner);
        let patch = a.try_recv().unwrap().into_text().unwrap();
        assert!(patch.contains("\"region\":\"johto\""));
        assert!(!patch.contains("bbbb"));
        join_test(&state, "aaaa", Region::Kanto);
        flush_patches(&state.inner);
        let hub = state.inner.hub.lock().unwrap();
        assert!(
            !hub.rooms[&RoomKey {
                region: Region::Johto,
                scene_id: "surface:johto".into()
            }]
                .players
                .contains_key("aaaa")
        );
        assert!(
            hub.rooms[&RoomKey {
                region: Region::Kanto,
                scene_id: "surface:kanto".into()
            }]
                .players
                .contains_key("aaaa")
        );
        drop(hub);
        disconnect(&state.inner, "aaaa");
        assert!(!state.inner.hub.lock().unwrap().clients.contains_key("aaaa"));
    }

    #[test]
    fn validates_region_scoped_surface_and_cave_scenes() {
        assert!(valid_scene(Region::Kanto, "surface:kanto"));
        assert!(valid_scene(Region::Johto, "cave:johto:dark-cave-1"));
        assert!(valid_scene(Region::Kanto, "cave:kanto:mt-moon-b2f"));
        assert!(valid_scene(Region::Johto, "cave:johto:bell-tower-roof"));
        assert!(valid_scene(Region::Hoenn, "surface:hoenn"));
        assert!(valid_scene(Region::Sinnoh, "surface:sinnoh"));
        assert!(valid_scene(Region::Unova, "surface:unova"));
        assert!(!valid_scene(Region::Kanto, "surface"));
        assert!(!valid_scene(Region::Kanto, "surface:johto"));
        assert!(!valid_scene(Region::Hoenn, "surface:sinnoh"));
        assert!(!valid_scene(Region::Johto, "cave:kanto:rock-tunnel"));
        assert!(!valid_scene(Region::Kanto, "cave:kanto:bad_room"));
    }

    #[test]
    fn accepts_expansion_presence_through_species_1025() {
        let state = test_state(64);
        let mut accepted = connect(&state, "aaaa");
        join(
            &state,
            "aaaa",
            Region::Paldea,
            "surface:paldea".into(),
            1025,
            1.0,
            2.0,
            0.0,
            Activity::Idle,
        );
        assert!(
            accepted
                .try_recv()
                .unwrap()
                .into_text()
                .unwrap()
                .contains("\"type\":\"welcome\"")
        );

        let mut rejected = connect(&state, "bbbb");
        join(
            &state,
            "bbbb",
            Region::Paldea,
            "surface:paldea".into(),
            1026,
            1.0,
            2.0,
            0.0,
            Activity::Idle,
        );
        assert!(
            rejected
                .try_recv()
                .unwrap()
                .into_text()
                .unwrap()
                .contains("INVALID_JOIN")
        );
    }

    #[test]
    fn rate_limits_on_the_first_message_beyond_each_boundary() {
        let mut state = RateWindow::default();
        let now = Instant::now();
        for _ in 0..15 {
            assert!(state.allow(now, 15, Duration::from_secs(1)));
        }
        assert!(!state.allow(now, 15, Duration::from_secs(1)));
        assert!(state.allow(now + Duration::from_secs(1), 15, Duration::from_secs(1)));

        let mut chat = RateWindow::default();
        for _ in 0..5 {
            assert!(chat.allow(now, 5, Duration::from_secs(10)));
        }
        assert!(!chat.allow(now, 5, Duration::from_secs(10)));
    }

    #[test]
    fn connection_budget_survives_join_state_rate_resets() {
        let state = test_state(64);
        let _outbound = connect(&state, "aaaa");
        let now = Instant::now();
        for _ in 0..MAX_CONNECTION_MESSAGES {
            assert!(allow_connection_message(&state, "aaaa", now));
            state
                .inner
                .hub
                .lock()
                .unwrap()
                .clients
                .get_mut("aaaa")
                .unwrap()
                .state_rate = RateWindow::default();
        }
        assert!(!allow_connection_message(&state, "aaaa", now));
        assert!(allow_connection_message(
            &state,
            "aaaa",
            now + CONNECTION_MESSAGE_PERIOD
        ));
    }

    #[test]
    fn rejects_invalid_input_and_keeps_only_latest_quantized_state() {
        let state = test_state(64);
        let mut outbound = connect(&state, "aaaa");
        process(
            &state,
            "aaaa",
            ClientMessage::Ping { sent_at: 1.0 },
            Instant::now(),
        );
        assert!(
            outbound
                .try_recv()
                .unwrap()
                .into_text()
                .unwrap()
                .contains("JOIN_REQUIRED")
        );
        join_test(&state, "aaaa", Region::Johto);
        outbound.try_recv().unwrap();
        update_player(
            &state,
            "aaaa",
            1,
            1.234,
            2.345,
            0.0,
            25,
            Activity::Moving,
            Instant::now(),
        );
        update_player(
            &state,
            "aaaa",
            2,
            3.456,
            4.567,
            0.0,
            25,
            Activity::Battle,
            Instant::now(),
        );
        update_player(
            &state,
            "aaaa",
            1,
            9.0,
            9.0,
            0.0,
            25,
            Activity::Idle,
            Instant::now(),
        );
        assert!(
            outbound
                .try_recv()
                .unwrap()
                .into_text()
                .unwrap()
                .contains("STALE_SEQ")
        );
        update_player(
            &state,
            "aaaa",
            3,
            1001.0,
            0.0,
            0.0,
            25,
            Activity::Idle,
            Instant::now(),
        );
        assert!(
            outbound
                .try_recv()
                .unwrap()
                .into_text()
                .unwrap()
                .contains("INVALID_STATE")
        );
        flush_patches(&state.inner);
        let patch = outbound.try_recv().unwrap().into_text().unwrap();
        assert!(patch.contains("3.46"));
        assert!(patch.contains("4.57"));
        assert!(!patch.contains("1.23"));
    }

    #[test]
    fn enforces_room_capacity_without_removing_existing_membership() {
        let state = test_state(1);
        let _a = connect(&state, "aaaa");
        let mut b = connect(&state, "bbbb");
        join_test(&state, "aaaa", Region::Johto);
        join_test(&state, "bbbb", Region::Kanto);
        b.try_recv().unwrap();
        join_test(&state, "bbbb", Region::Johto);
        assert!(
            b.try_recv()
                .unwrap()
                .into_text()
                .unwrap()
                .contains("ROOM_FULL")
        );
        assert_eq!(
            state.inner.hub.lock().unwrap().clients["bbbb"]
                .room
                .as_ref()
                .map(|room| room.region),
            Some(Region::Kanto)
        );
    }

    #[test]
    fn chat_envelope_keeps_the_origin_room_and_does_not_cross_rooms() {
        let state = test_state(64);
        let mut johto = connect(&state, "aaaa");
        let mut cave = connect(&state, "bbbb");
        join_test(&state, "aaaa", Region::Johto);
        join(
            &state,
            "bbbb",
            Region::Johto,
            "cave:johto:dark-cave".into(),
            25,
            1.0,
            2.0,
            0.0,
            Activity::Idle,
        );
        johto.try_recv().unwrap();
        cave.try_recv().unwrap();

        chat(&state, "aaaa", "hello".into(), Instant::now());
        let envelope = johto.try_recv().unwrap().into_text().unwrap();
        assert!(envelope.contains("\"type\":\"chat\""));
        assert!(envelope.contains("\"region\":\"johto\""));
        assert!(cave.try_recv().is_err());
    }

    #[test]
    fn rejects_tampered_and_replayed_account_tickets() {
        let state = test_state(64);
        let (ticket, _) = issue_ticket_with_secret(
            Uuid::new_v4(),
            "registered-user",
            &state.inner.ticket_secret,
        )
        .unwrap();
        let mut tampered = ticket.clone();
        tampered.push('x');
        assert!(verify_ticket(&state, &tampered).is_err());
        let claims = verify_ticket(&state, &ticket).unwrap();
        assert_eq!(claims.username, "registered-user");
        assert!(verify_ticket(&state, &ticket).is_err());
    }

    #[test]
    fn reauthentication_extends_only_the_same_account_connection() {
        let state = test_state(64);
        let account = Uuid::new_v4();
        let id = account.to_string();
        let mut outbound = connect(&state, &id);
        state
            .inner
            .hub
            .lock()
            .unwrap()
            .clients
            .get_mut(&id)
            .unwrap()
            .username = "alice".into();
        let (ticket, _) =
            issue_ticket_with_secret(account, "alice", &state.inner.ticket_secret).unwrap();
        reauthenticate(&state, &id, &ticket);
        assert!(authentication_valid(&state, &id));
        let (other, _) =
            issue_ticket_with_secret(Uuid::new_v4(), "alice", &state.inner.ticket_secret).unwrap();
        reauthenticate(&state, &id, &other);
        assert!(
            outbound
                .try_recv()
                .unwrap()
                .into_text()
                .unwrap()
                .contains("AUTH_REQUIRED")
        );
    }

    #[tokio::test]
    async fn accepts_a_real_same_origin_socket_and_cleans_up_after_close() {
        let state = test_state(64);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router_with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let user_id = Uuid::new_v4();
        let denied_ticket = issue_ticket_with_secret(user_id, "alice", &state.inner.ticket_secret)
            .unwrap()
            .0;
        let mut denied = format!("ws://{address}/api/realtime?ticket={denied_ticket}")
            .into_client_request()
            .unwrap();
        denied
            .headers_mut()
            .insert(header::ORIGIN, "http://attacker.invalid".parse().unwrap());
        let error = connect_async(denied).await.unwrap_err();
        assert!(
            matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == StatusCode::FORBIDDEN)
        );
        let ticket = issue_ticket_with_secret(user_id, "alice", &state.inner.ticket_secret)
            .unwrap()
            .0;
        let mut request = format!("ws://{address}/api/realtime?ticket={ticket}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(header::ORIGIN, "http://localhost".parse().unwrap());
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket
            .send(ClientFrame::Text(
                json!({
                    "type":"join", "region":"johto", "sceneId":"cave:johto:dark-cave", "speciesId":25,
                    "x":1, "z":2, "heading":0, "activity":"idle"
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let welcome = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = socket.next().await.unwrap().unwrap();
                if let Ok(text) = frame.into_text()
                    && text.contains("\"type\":\"welcome\"")
                {
                    break text;
                }
            }
        })
        .await
        .unwrap();
        assert!(welcome.contains("\"type\":\"welcome\""));
        assert!(welcome.contains("alice"));
        assert!(welcome.contains("cave:johto:dark-cave"));
        socket.close(None).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !state.inner.hub.lock().unwrap().clients.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        server.abort();
    }
}
