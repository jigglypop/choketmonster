use axum::{
    Json, Router,
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, Utf8Bytes, WebSocket},
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
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak},
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
/// Every scene, halls and caves included, lies inside the client's world square
/// (`WORLD_MIN`..`WORLD_MAX` in src/openworld/world-space.ts), and movement is clamped to it.
const WORLD_EXTENT: f64 = 240.0;
/// An emptied room keeps its chat this long for players coming back, e.g. after a reconnect.
const EMPTY_ROOM_TTL: Duration = Duration::from_secs(10 * 60);
const ROOM_SWEEP_INTERVAL: Duration = Duration::from_secs(30);

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

impl Region {
    fn id(self) -> &'static str {
        match self {
            Region::Johto => "johto",
            Region::Kanto => "kanto",
            Region::Hoenn => "hoenn",
            Region::Sinnoh => "sinnoh",
            Region::Unova => "unova",
            Region::Kalos => "kalos",
            Region::Alola => "alola",
            Region::Galar => "galar",
            Region::Hisui => "hisui",
            Region::Paldea => "paldea",
        }
    }
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

impl RealtimeInner {
    fn hub(&self) -> MutexGuard<'_, Hub> {
        self.hub.lock().unwrap_or_else(|error| error.into_inner())
    }
}

#[derive(Default)]
struct Hub {
    clients: HashMap<String, Client>,
    rooms: HashMap<RoomKey, Room>,
    /// Rooms with moves or departures since the last patch; a flush visits only these.
    pending: HashSet<RoomKey>,
    /// Kept current as players come and go, so the health check does not walk the rooms.
    player_count: usize,
    occupied_rooms: usize,
    connections: u64,
}

struct Client {
    connection: u64,
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
    emptied_at: Option<Instant>,
}

/// One socket of an account. A reconnect gets a new connection number, so a socket that is
/// still closing can neither act for nor remove the account's newer socket.
#[derive(Clone, Debug, Eq, PartialEq)]
struct Session {
    id: String,
    connection: u64,
}

/// Holds an account's hub entry for one socket. The socket task owns it, and axum drops that
/// task unstarted when the upgrade fails, so the entry never outlives its socket.
struct Registration {
    inner: Arc<RealtimeInner>,
    session: Session,
}

impl Drop for Registration {
    fn drop(&mut self) {
        disconnect(&self.inner, &self.session);
    }
}

impl Hub {
    fn register(
        &mut self,
        id: String,
        username: String,
        auth_expires_at: u64,
        tx: mpsc::Sender<Message>,
    ) -> Session {
        self.connections += 1;
        let session = Session {
            id,
            connection: self.connections,
        };
        self.clients.insert(
            session.id.clone(),
            Client {
                connection: session.connection,
                tx,
                room: None,
                last_seq: None,
                message_rate: RateWindow::default(),
                state_rate: RateWindow::default(),
                chat_rate: RateWindow::default(),
                username,
                auth_expires_at,
            },
        );
        session
    }

    /// The account's entry while it still belongs to this socket.
    fn client(&self, session: &Session) -> Option<&Client> {
        self.clients
            .get(&session.id)
            .filter(|client| client.connection == session.connection)
    }

    fn client_mut(&mut self, session: &Session) -> Option<&mut Client> {
        self.clients
            .get_mut(&session.id)
            .filter(|client| client.connection == session.connection)
    }

    fn remove(&mut self, session: &Session, now: Instant) {
        if self.client(session).is_none() {
            return;
        }
        if let Some(room) = self
            .clients
            .remove(&session.id)
            .and_then(|client| client.room)
        {
            self.leave_room(&room, &session.id, now);
        }
    }

    fn enter_room(&mut self, key: &RoomKey, player: RemotePlayer) -> &mut Room {
        self.pending.insert(key.clone());
        let room = self.rooms.entry(key.clone()).or_default();
        if room.players.is_empty() {
            self.occupied_rooms += 1;
            room.emptied_at = None;
        }
        room.left.remove(&player.id);
        room.dirty.insert(player.id.clone());
        if room.players.insert(player.id.clone(), player).is_none() {
            self.player_count += 1;
        }
        room
    }

    /// The others hear of a departure on the next patch. An emptied room closes at once, or after
    /// `EMPTY_ROOM_TTL` when it holds chat that a returning player should still see.
    fn leave_room(&mut self, key: &RoomKey, id: &str, now: Instant) {
        let Some(room) = self.rooms.get_mut(key) else {
            return;
        };
        if room.players.remove(id).is_none() {
            return;
        }
        room.dirty.remove(id);
        self.player_count -= 1;
        if !room.players.is_empty() {
            room.left.insert(id.to_owned());
            self.pending.insert(key.clone());
            return;
        }
        self.occupied_rooms -= 1;
        self.pending.remove(key);
        if room.history.is_empty() {
            self.rooms.remove(key);
        } else {
            room.dirty.clear();
            room.left.clear();
            room.emptied_at = Some(now);
        }
    }
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
    let hub = state.inner.hub();
    Json(json!({
        "status":"ok", "server":"realtime", "schema":1, "tickRate":TICK_RATE,
        "connections":hub.clients.len(),
        "players":hub.player_count,
        "rooms":hub.occupied_rooms
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
    let session = {
        let mut hub = state.inner.hub();
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
        hub.register(id, claims.username, claims.exp, tx)
    };
    let registration = Registration {
        inner: state.inner.clone(),
        session,
    };
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| connection(socket, state, registration, rx))
}

async fn connection(
    mut socket: WebSocket,
    state: RealtimeState,
    registration: Registration,
    mut outbound: mpsc::Receiver<Message>,
) {
    let session = &registration.session;
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if !allow_connection_message(&state, session, Instant::now()) { break; }
                    last_seen = Instant::now();
                    if text.len() > MAX_MESSAGE_BYTES {
                        send_error(&state, session, "MESSAGE_TOO_LARGE", "메시지가 너무 큽니다.");
                        continue;
                    }
                    match serde_json::from_str::<ClientMessage>(&text) {
                        Ok(message) => process(&state, session, message, Instant::now()),
                        Err(_) => send_error(&state, session, "INVALID_MESSAGE", "메시지 형식이 올바르지 않습니다."),
                    }
                }
                Some(Ok(Message::Pong(_))) => {
                    if !allow_connection_message(&state, session, Instant::now()) { break; }
                    last_seen = Instant::now();
                }
                Some(Ok(Message::Ping(payload))) => {
                    if !allow_connection_message(&state, session, Instant::now()) { break; }
                    last_seen = Instant::now();
                    if !send_socket(&mut socket, Message::Pong(payload)).await { break; }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(Message::Binary(_))) => {
                    if !allow_connection_message(&state, session, Instant::now()) { break; }
                    send_error(&state, session, "INVALID_MESSAGE", "JSON 텍스트 메시지가 필요합니다.");
                }
            },
            outgoing = outbound.recv() => match outgoing {
                Some(message) => if !send_socket(&mut socket, message).await { break; },
                None => break,
            },
            _ = heartbeat.tick() => {
                if !authentication_valid(&state, session) { break; }
                if last_seen.elapsed() >= HEARTBEAT_TIMEOUT { break; }
                if !send_socket(&mut socket, Message::Ping(Vec::new().into())).await { break; }
            }
        }
    }
}

async fn send_socket(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(SOCKET_SEND_TIMEOUT, socket.send(message)).await,
        Ok(Ok(()))
    )
}

/// False once this socket was evicted or replaced, which also ends its task.
fn allow_connection_message(state: &RealtimeState, session: &Session, now: Instant) -> bool {
    let mut hub = state.inner.hub();
    hub.client_mut(session).is_some_and(|client| {
        client
            .message_rate
            .allow(now, MAX_CONNECTION_MESSAGES, CONNECTION_MESSAGE_PERIOD)
    })
}

fn process(state: &RealtimeState, session: &Session, message: ClientMessage, now: Instant) {
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
                state, session, region, scene_id, species_id, x, z, heading, activity,
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
            update_player(
                state, session, seq, x, z, heading, species_id, activity, now,
            );
        }
        ClientMessage::Chat { text } => chat(state, session, text, now),
        ClientMessage::Reauth { ticket } => reauthenticate(state, session, &ticket),
        ClientMessage::Ping { sent_at } => {
            let joined = state
                .inner
                .hub()
                .client(session)
                .is_some_and(|client| client.room.is_some());
            if !joined {
                send_error(
                    state,
                    session,
                    "JOIN_REQUIRED",
                    "먼저 지역에 접속해 주세요.",
                );
            } else if !sent_at.is_finite() {
                send_error(
                    state,
                    session,
                    "INVALID_MESSAGE",
                    "ping 시간이 올바르지 않습니다.",
                );
            } else {
                send_to(state, session, &ServerMessage::Pong { sent_at });
            }
        }
    }
}

fn authentication_valid(state: &RealtimeState, session: &Session) -> bool {
    state
        .inner
        .hub()
        .client(session)
        .is_some_and(|client| client.auth_expires_at >= epoch_seconds())
}

fn reauthenticate(state: &RealtimeState, session: &Session, ticket: &str) {
    let Ok(claims) = verify_ticket(state, ticket) else {
        send_error(
            state,
            session,
            "AUTH_REQUIRED",
            "실시간 인증을 갱신할 수 없습니다.",
        );
        return;
    };
    if claims.sub.to_string() != session.id {
        send_error(
            state,
            session,
            "AUTH_REQUIRED",
            "다른 계정의 인증은 사용할 수 없습니다.",
        );
        return;
    }
    let mut hub = state.inner.hub();
    let Some(client) = hub.client_mut(session) else {
        return;
    };
    if client.username != claims.username {
        drop(hub);
        send_error(
            state,
            session,
            "AUTH_REQUIRED",
            "계정 정보가 변경되었습니다.",
        );
        return;
    }
    client.auth_expires_at = claims.exp;
}

#[allow(clippy::too_many_arguments)]
fn join(
    state: &RealtimeState,
    session: &Session,
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
            session,
            "INVALID_JOIN",
            "접속 위치나 포켓몬이 올바르지 않습니다.",
        );
        return;
    }
    let hub = state.inner.hub();
    let Some(client) = hub.client(session) else {
        return;
    };
    let current_room = client.room.clone();
    let next_room = RoomKey { region, scene_id };
    if current_room.as_ref() != Some(&next_room)
        && hub
            .rooms
            .get(&next_room)
            .is_some_and(|room| room.players.len() >= state.inner.room_capacity)
    {
        drop(hub);
        send_error(
            state,
            session,
            "ROOM_FULL",
            "이 지역의 실시간 방이 가득 찼습니다.",
        );
        return;
    }
    finish_join(
        state,
        hub,
        session,
        current_room,
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
    mut hub: MutexGuard<'_, Hub>,
    session: &Session,
    old_room: Option<RoomKey>,
    room_key: RoomKey,
    species_id: i64,
    x: f64,
    z: f64,
    heading: f64,
    activity: Activity,
) {
    let Some(client) = hub.client_mut(session) else {
        return;
    };
    client.room = Some(room_key.clone());
    client.last_seq = None;
    client.state_rate = RateWindow::default();
    let (name, tx) = (client.username.clone(), client.tx.clone());
    if let Some(old) = old_room.filter(|old| *old != room_key) {
        hub.leave_room(&old, &session.id, Instant::now());
    }
    let player = RemotePlayer {
        id: session.id.clone(),
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
    let room = hub.enter_room(&room_key, player);
    let message = ServerMessage::Welcome {
        id: session.id.clone(),
        region: room_key.region,
        scene_id: room_key.scene_id,
        tick_rate: TICK_RATE,
        players: room.players.values().cloned().collect(),
        history: room.history.iter().cloned().collect(),
    };
    // Queued under the lock, so no patch of the new room can overtake the welcome.
    let failed = send_now(&tx, &message).is_err();
    drop(hub);
    if failed {
        disconnect(&state.inner, session);
    }
}

#[allow(clippy::too_many_arguments)]
fn update_player(
    state: &RealtimeState,
    session: &Session,
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
            session,
            "INVALID_STATE",
            "플레이어 상태가 올바르지 않습니다.",
        );
        return;
    }
    let mut hub = state.inner.hub();
    let Some(client) = hub.client_mut(session) else {
        return;
    };
    let Some(room_key) = client.room.clone() else {
        drop(hub);
        send_error(
            state,
            session,
            "JOIN_REQUIRED",
            "먼저 지역에 접속해 주세요.",
        );
        return;
    };
    if client.last_seq.is_some_and(|last| seq <= last) {
        drop(hub);
        send_error(
            state,
            session,
            "STALE_SEQ",
            "이전 상태 번호는 적용할 수 없습니다.",
        );
        return;
    }
    if !client.state_rate.allow(now, 15, Duration::from_secs(1)) {
        drop(hub);
        send_error(state, session, "RATE_LIMIT", "상태 갱신이 너무 빠릅니다.");
        return;
    }
    client.last_seq = Some(seq);
    let room = hub
        .rooms
        .get_mut(&room_key)
        .expect("joined client room must exist");
    let player = room
        .players
        .get_mut(&session.id)
        .expect("joined client player must exist");
    player.x = x;
    player.z = z;
    player.heading = heading;
    player.species_id = species_id;
    player.activity = activity;
    player.updated_at = epoch_ms();
    room.dirty.insert(session.id.clone());
    hub.pending.insert(room_key);
}

fn chat(state: &RealtimeState, session: &Session, text: String, now: Instant) {
    let Some(text) = normalize_chat(&text) else {
        send_error(
            state,
            session,
            "INVALID_CHAT",
            "채팅은 1~200자로 입력해 주세요.",
        );
        return;
    };
    let mut guard = state.inner.hub();
    let Some(client) = guard.client_mut(session) else {
        return;
    };
    let Some(room_key) = client.room.clone() else {
        drop(guard);
        send_error(
            state,
            session,
            "JOIN_REQUIRED",
            "먼저 지역에 접속해 주세요.",
        );
        return;
    };
    if !client.chat_rate.allow(now, 5, Duration::from_secs(10)) {
        drop(guard);
        send_error(
            state,
            session,
            "RATE_LIMIT",
            "채팅을 너무 빠르게 보냈습니다.",
        );
        return;
    }
    let hub = &mut *guard;
    let room = hub
        .rooms
        .get_mut(&room_key)
        .expect("joined client room must exist");
    let player = room
        .players
        .get(&session.id)
        .expect("joined client player must exist");
    let message = ChatMessage {
        id: Uuid::new_v4().to_string(),
        player_id: session.id.clone(),
        name: player.name.clone(),
        text,
        sent_at: epoch_ms(),
    };
    room.history.push_back(message.clone());
    while room.history.len() > CHAT_HISTORY {
        room.history.pop_front();
    }
    let recipients = recipients(&hub.clients, room);
    drop(guard);
    broadcast(
        &state.inner,
        recipients,
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
        && x.abs() <= WORLD_EXTENT
        && z.abs() <= WORLD_EXTENT
        && heading.abs() <= 360.0
}

/// Scenes the client can stand in: its region's surface, a dungeon floor, or a gym or league
/// hall. Anything else would only open rooms nobody can reach.
fn valid_scene(region: Region, value: &str) -> bool {
    if value.len() > 64 {
        return false;
    }
    let region_id = region.id();
    let Some((kind, rest)) = value.split_once(':') else {
        return false;
    };
    if kind == "surface" {
        return rest == region_id;
    }
    let Some(place) = rest
        .strip_prefix(region_id)
        .and_then(|rest| rest.strip_prefix(':'))
    else {
        return false;
    };
    let (gyms, league) = hall_locations(region);
    match kind {
        "cave" => dungeon_scenes()
            .get(region_id)
            .is_some_and(|ids| ids.contains(place)),
        "gym" => gyms.contains(&place),
        "league" => league == place,
        _ => false,
    }
}

/// Every dungeon floor scene by region, generated from the client's dungeon plans.
fn dungeon_scenes() -> &'static HashMap<String, HashSet<String>> {
    static SCENES: OnceLock<HashMap<String, HashSet<String>>> = OnceLock::new();
    SCENES.get_or_init(|| {
        let parsed: HashMap<String, Vec<String>> =
            serde_json::from_str(include_str!("../../src/data/dungeon-scenes.json"))
                .expect("dungeon scene list");
        parsed
            .into_iter()
            .map(|(region, ids)| (region, ids.into_iter().collect()))
            .collect()
    })
}

/// Locations of the region's gym halls and of its league hall: the client's campaign gym lists
/// (`getCampaignGyms`) and `LEAGUE_LOCATION_IDS` in src/openworld/gym-scenes.ts.
fn hall_locations(region: Region) -> (&'static [&'static str; 8], &'static str) {
    match region {
        Region::Kanto => (
            &[
                "pewter",
                "cerulean",
                "vermilion",
                "celadon",
                "fuchsia",
                "saffron",
                "cinnabar",
                "viridian",
            ],
            "indigo-plateau",
        ),
        Region::Johto => (
            &[
                "violet",
                "azalea",
                "goldenrod",
                "ecruteak",
                "cianwood",
                "olivine",
                "mahogany",
                "blackthorn",
            ],
            "tohjo-falls",
        ),
        Region::Hoenn => (
            &[
                "rustboro-city",
                "dewford-town",
                "mauville-city",
                "lavaridge-town",
                "petalburg-city",
                "fortree-city",
                "mossdeep-city",
                "sootopolis-city",
            ],
            "ever-grande-city",
        ),
        Region::Sinnoh => (
            &[
                "oreburgh-city",
                "eterna-city",
                "hearthome-city",
                "veilstone-city",
                "pastoria-city",
                "canalave-city",
                "snowpoint-city",
                "sunyshore-city",
            ],
            "sinnoh-pokemon-league",
        ),
        Region::Unova => (
            &[
                "striaton-city",
                "nacrene-city",
                "castelia-city",
                "nimbasa-city",
                "driftveil-city",
                "mistralton-city",
                "icirrus-city",
                "opelucid-city",
            ],
            "unova-pokemon-league",
        ),
        Region::Kalos => (
            &[
                "santalune-city",
                "cyllage-city",
                "shalour-city",
                "coumarine-city",
                "lumiose-city",
                "laverre-city",
                "anistar-city",
                "snowbelle-city",
            ],
            "kalos-pokemon-league",
        ),
        Region::Alola => (
            &[
                "verdant-cavern",
                "brooklet-hill",
                "wela-volcano-park",
                "lush-jungle",
                "mount-hokulani",
                "tapu-village",
                "poni-wilds",
                "vast-poni-canyon",
            ],
            "alola-pokemon-league",
        ),
        Region::Galar => (
            &[
                "turffield",
                "hulbury",
                "motostoke",
                "stow-on-side",
                "ballonlea",
                "circhester",
                "spikemuth",
                "hammerlocke",
            ],
            "galar-pokemon-league",
        ),
        Region::Hisui => (
            &[
                "grandtree-arena",
                "brava-arena",
                "molten-arena",
                "coronet-highlands",
                "moonview-arena",
                "alabaster-icelands",
                "icepeak-arena",
                "temple-of-sinnoh",
            ],
            "temple-of-sinnoh",
        ),
        Region::Paldea => (
            &[
                "cortondo",
                "artazon",
                "levincia",
                "cascarrafa",
                "medali",
                "montenevera",
                "alfornada",
                "glaseado-mountain",
            ],
            "paldea-pokemon-league",
        ),
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn send_error(state: &RealtimeState, session: &Session, code: &'static str, message: &'static str) {
    send_to(state, session, &ServerMessage::Error { code, message });
}

fn send_to(state: &RealtimeState, session: &Session, message: &ServerMessage) {
    let tx = state
        .inner
        .hub()
        .client(session)
        .map(|client| client.tx.clone());
    if tx.is_some_and(|tx| send_now(&tx, message).is_err()) {
        disconnect(&state.inner, session);
    }
}

fn encode(message: &ServerMessage) -> Option<Utf8Bytes> {
    serde_json::to_string(message).ok().map(Utf8Bytes::from)
}

fn send_now(tx: &mpsc::Sender<Message>, message: &ServerMessage) -> Result<(), ()> {
    let text = encode(message).ok_or(())?;
    tx.try_send(Message::Text(text)).map_err(|_| ())
}

/// A room's sockets, each with its connection number so a failed send evicts only that socket.
fn recipients(
    clients: &HashMap<String, Client>,
    room: &Room,
) -> Vec<(Session, mpsc::Sender<Message>)> {
    room.players
        .keys()
        .filter_map(|id| {
            clients.get(id).map(|client| {
                (
                    Session {
                        id: id.clone(),
                        connection: client.connection,
                    },
                    client.tx.clone(),
                )
            })
        })
        .collect()
}

/// Serializes once; every recipient's queue shares the same buffer.
fn broadcast(
    inner: &RealtimeInner,
    recipients: Vec<(Session, mpsc::Sender<Message>)>,
    message: &ServerMessage,
) {
    let Some(text) = encode(message) else {
        return;
    };
    let failed: Vec<_> = recipients
        .into_iter()
        .filter(|(_, tx)| tx.try_send(Message::Text(text.clone())).is_err())
        .map(|(session, _)| session)
        .collect();
    for session in failed {
        disconnect(inner, &session);
    }
}

fn disconnect(inner: &RealtimeInner, session: &Session) {
    inner.hub().remove(session, Instant::now());
}

async fn patch_loop(inner: Weak<RealtimeInner>) {
    let mut interval = tokio::time::interval(Duration::from_millis(1000 / TICK_RATE));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut swept = Instant::now();
    loop {
        interval.tick().await;
        let Some(inner) = inner.upgrade() else {
            break;
        };
        flush_patches(&inner);
        if swept.elapsed() >= ROOM_SWEEP_INTERVAL {
            swept = Instant::now();
            sweep_rooms(&inner, swept);
        }
    }
}

fn flush_patches(inner: &RealtimeInner) {
    let batches = {
        let mut guard = inner.hub();
        let hub = &mut *guard;
        let mut batches = Vec::with_capacity(hub.pending.len());
        for key in hub.pending.drain() {
            let Some(room) = hub.rooms.get_mut(&key) else {
                continue;
            };
            if room.dirty.is_empty() && room.left.is_empty() {
                continue;
            }
            let mut players: Vec<_> = room
                .dirty
                .drain()
                .filter_map(|id| room.players.get(&id).cloned())
                .collect();
            for player in &mut players {
                player.x = quantize(player.x);
                player.z = quantize(player.z);
            }
            let mut left: Vec<_> = room.left.drain().collect();
            players.sort_by(|a, b| a.id.cmp(&b.id));
            left.sort();
            batches.push((
                recipients(&hub.clients, room),
                ServerMessage::Patch {
                    region: key.region,
                    scene_id: key.scene_id,
                    players,
                    left,
                },
            ));
        }
        batches
    };
    for (recipients, message) in batches {
        broadcast(inner, recipients, &message);
    }
}

fn sweep_rooms(inner: &RealtimeInner, now: Instant) {
    inner.hub().rooms.retain(|_, room| {
        !room.players.is_empty()
            || room
                .emptied_at
                .is_some_and(|at| now.duration_since(at) < EMPTY_ROOM_TTL)
    });
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

    fn connect(state: &RealtimeState, id: &str) -> (Session, mpsc::Receiver<Message>) {
        let (tx, rx) = mpsc::channel(OUTBOUND_CAPACITY);
        let session = state.inner.hub().register(
            id.into(),
            "tester".into(),
            epoch_seconds() + TICKET_TTL_SECONDS,
            tx,
        );
        (session, rx)
    }

    fn room(region: Region, scene_id: &str) -> RoomKey {
        RoomKey {
            region,
            scene_id: scene_id.into(),
        }
    }

    fn join_scene(state: &RealtimeState, session: &Session, region: Region, scene_id: &str) {
        join(
            state,
            session,
            region,
            scene_id.into(),
            25,
            1.0,
            2.0,
            0.0,
            Activity::Idle,
        );
    }

    fn join_test(state: &RealtimeState, session: &Session, region: Region) {
        join_scene(state, session, region, &format!("surface:{}", region.id()));
    }

    fn latest(outbound: &mut mpsc::Receiver<Message>) -> Utf8Bytes {
        std::iter::from_fn(|| outbound.try_recv().ok())
            .last()
            .unwrap()
            .into_text()
            .unwrap()
    }

    #[test]
    fn isolates_rooms_and_tracks_moves_and_cleanup_as_deltas() {
        let state = test_state(64);
        let (a, mut a_rx) = connect(&state, "aaaa");
        let (b, _b_rx) = connect(&state, "bbbb");
        join_test(&state, &a, Region::Johto);
        join_test(&state, &b, Region::Kanto);
        a_rx.try_recv().unwrap();
        flush_patches(&state.inner);
        let patch = a_rx.try_recv().unwrap().into_text().unwrap();
        assert!(patch.contains("\"region\":\"johto\""));
        assert!(!patch.contains("bbbb"));
        join_test(&state, &a, Region::Kanto);
        flush_patches(&state.inner);
        let hub = state.inner.hub();
        // Nobody chatted in the Johto room, so it closed with its last player.
        assert!(
            !hub.rooms
                .contains_key(&room(Region::Johto, "surface:johto"))
        );
        assert!(
            hub.rooms[&room(Region::Kanto, "surface:kanto")]
                .players
                .contains_key("aaaa")
        );
        drop(hub);
        disconnect(&state.inner, &a);
        assert!(!state.inner.hub().clients.contains_key("aaaa"));
    }

    #[test]
    fn validates_region_scoped_surface_and_cave_scenes() {
        assert!(valid_scene(Region::Kanto, "surface:kanto"));
        assert!(valid_scene(Region::Johto, "cave:johto:dark-cave-violet"));
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
        // Only floors the client builds open rooms.
        assert!(!valid_scene(Region::Johto, "cave:johto:dark-cave-1"));
        assert!(!valid_scene(Region::Kanto, "cave:kanto:mt-moon:b1f"));
    }

    #[test]
    fn accepts_the_gym_and_league_halls_the_client_opens() {
        assert!(valid_scene(Region::Kanto, "gym:kanto:pewter"));
        assert!(valid_scene(Region::Johto, "league:johto:tohjo-falls"));
        assert!(valid_scene(Region::Alola, "gym:alola:verdant-cavern"));
        assert!(valid_scene(Region::Hisui, "gym:hisui:temple-of-sinnoh"));
        assert!(valid_scene(Region::Hisui, "league:hisui:temple-of-sinnoh"));
        assert!(!valid_scene(Region::Johto, "gym:kanto:pewter"));
        assert!(!valid_scene(Region::Kanto, "gym:kanto:route-1"));
        assert!(!valid_scene(Region::Kanto, "league:kanto:pewter"));
        assert!(!valid_scene(Region::Kanto, "gym:kanto:pewter:1f"));
        assert!(!valid_scene(Region::Kanto, "gym:kanto"));
        let state = test_state(64);
        let (a, mut outbound) = connect(&state, "aaaa");
        join_scene(&state, &a, Region::Kanto, "gym:kanto:pewter");
        let welcome = outbound.try_recv().unwrap().into_text().unwrap();
        assert!(welcome.contains("\"type\":\"welcome\""));
        assert!(welcome.contains("\"sceneId\":\"gym:kanto:pewter\""));
    }

    /// The hall table mirrors client data; this catches a gym or league that moved.
    #[test]
    fn hall_locations_match_the_client_gym_and_league_lists() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let read = |path: &str| {
            std::fs::read_to_string(root.join(path))
                .unwrap_or_else(|error| panic!("{path}: {error}"))
        };
        for (region, path, name) in [
            (Region::Kanto, "openworld/kanto.ts", "KANTO_GYMS"),
            (Region::Johto, "game/campaign.ts", "JOHTO_CAMPAIGN_GYMS"),
            (Region::Hoenn, "openworld/hoenn.ts", "HOENN_GYMS"),
            (Region::Sinnoh, "openworld/sinnoh.ts", "SINNOH_GYMS"),
            (Region::Unova, "openworld/unova.ts", "UNOVA_GYMS"),
            (Region::Kalos, "openworld/kalos.ts", "KALOS_GYMS"),
            (Region::Alola, "openworld/alola.ts", "ALOLA_GYMS"),
            (Region::Galar, "openworld/galar.ts", "GALAR_GYMS"),
            (Region::Hisui, "openworld/hisui.ts", "HISUI_GYMS"),
            (Region::Paldea, "openworld/paldea.ts", "PALDEA_GYMS"),
        ] {
            let source = read(path);
            let start = source
                .find(&format!("export const {name}"))
                .unwrap_or_else(|| panic!("{name} not found"));
            let list = &source[start..];
            let list = &list[list.find('=').unwrap()..];
            let list = &list[list.find('[').unwrap()..list.find("];").unwrap()];
            let ids: Vec<&str> = list
                .split("locationId")
                .skip(1)
                .map(|entry| entry.split('\'').nth(1).unwrap())
                .collect();
            assert_eq!(ids, hall_locations(region).0, "{name}");
        }
        let source = read("openworld/gym-scenes.ts");
        let object = &source[source.find("LEAGUE_LOCATION_IDS").unwrap()..];
        let object = &object[object.find("({").unwrap() + 2..object.find("})").unwrap()];
        let leagues: Vec<_> = object
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(|entry| entry.split_once(':').unwrap())
            .collect();
        assert_eq!(leagues.len(), 10);
        for (region, location) in leagues {
            let region: Region = serde_json::from_value(json!(region.trim())).unwrap();
            assert_eq!(hall_locations(region).1, location.trim().trim_matches('\''));
        }
    }

    #[test]
    fn positions_stay_inside_the_client_world_square() {
        assert!(valid_position(240.0, -240.0, 0.0));
        assert!(!valid_position(240.01, 0.0, 0.0));
        assert!(!valid_position(0.0, -241.0, 0.0));
        assert!(!valid_position(f64::NAN, 0.0, 0.0));
    }

    #[test]
    fn empty_rooms_close_and_chat_rooms_wait_for_returning_players() {
        let state = test_state(64);
        let (a, mut outbound) = connect(&state, "aaaa");
        let cave = room(Region::Kanto, "cave:kanto:mt-moon");
        let surface = room(Region::Kanto, "surface:kanto");
        join_scene(&state, &a, Region::Kanto, &cave.scene_id);
        join_scene(&state, &a, Region::Kanto, &surface.scene_id);
        assert!(!state.inner.hub().rooms.contains_key(&cave));
        chat(&state, &a, "hello".into(), Instant::now());
        join_scene(&state, &a, Region::Kanto, &cave.scene_id);
        sweep_rooms(&state.inner, Instant::now());
        assert!(state.inner.hub().rooms[&surface].players.is_empty());
        join_scene(&state, &a, Region::Kanto, &surface.scene_id);
        assert!(latest(&mut outbound).contains("hello"));
        join_scene(&state, &a, Region::Kanto, &cave.scene_id);
        sweep_rooms(&state.inner, Instant::now() + EMPTY_ROOM_TTL);
        let hub = state.inner.hub();
        assert!(!hub.rooms.contains_key(&surface));
        assert!(hub.rooms.contains_key(&cave));
    }

    #[tokio::test]
    async fn flush_visits_only_changed_rooms_and_health_counts_stay_current() {
        let state = test_state(64);
        let (a, _a_rx) = connect(&state, "aaaa");
        let (b, _b_rx) = connect(&state, "bbbb");
        join_test(&state, &a, Region::Johto);
        join_test(&state, &b, Region::Johto);
        join_scene(&state, &b, Region::Johto, "cave:johto:dark-cave");
        assert_eq!(state.inner.hub().pending.len(), 2);
        flush_patches(&state.inner);
        assert!(state.inner.hub().pending.is_empty());
        update_player(
            &state,
            &a,
            1,
            3.0,
            4.0,
            0.0,
            25,
            Activity::Moving,
            Instant::now(),
        );
        assert_eq!(
            state.inner.hub().pending,
            HashSet::from([room(Region::Johto, "surface:johto")])
        );
        let counts = |body: serde_json::Value| {
            ["connections", "players", "rooms"].map(|key| body[key].as_u64().unwrap())
        };
        let Json(body) = health(State(state.clone())).await;
        assert_eq!(counts(body), [2, 2, 2]);
        disconnect(&state.inner, &b);
        let Json(body) = health(State(state.clone())).await;
        assert_eq!(counts(body), [1, 1, 1]);
    }

    #[test]
    fn a_broadcast_is_serialized_once_for_every_recipient() {
        let state = test_state(64);
        let (a, mut a_rx) = connect(&state, "aaaa");
        let (b, mut b_rx) = connect(&state, "bbbb");
        join_test(&state, &a, Region::Johto);
        join_test(&state, &b, Region::Johto);
        flush_patches(&state.inner);
        let (a_patch, b_patch) = (latest(&mut a_rx), latest(&mut b_rx));
        assert!(a_patch.contains("\"type\":\"patch\""));
        assert_eq!(a_patch.as_ptr(), b_patch.as_ptr());
    }

    #[test]
    fn a_closing_socket_cannot_remove_or_act_for_its_reconnected_account() {
        let state = test_state(64);
        let (old, _old_rx) = connect(&state, "aaaa");
        join_test(&state, &old, Region::Johto);
        // A full queue evicted the old socket; its task is still winding down when the account
        // connects again.
        disconnect(&state.inner, &old);
        let (new, mut outbound) = connect(&state, "aaaa");
        join_test(&state, &new, Region::Kanto);
        outbound.try_recv().unwrap();
        assert!(!allow_connection_message(&state, &old, Instant::now()));
        assert!(!authentication_valid(&state, &old));
        process(
            &state,
            &old,
            ClientMessage::Chat {
                text: "stale".into(),
            },
            Instant::now(),
        );
        join_test(&state, &old, Region::Johto);
        drop(Registration {
            inner: state.inner.clone(),
            session: old,
        });
        let hub = state.inner.hub();
        assert_eq!(hub.clients["aaaa"].connection, new.connection);
        let kanto = &hub.rooms[&room(Region::Kanto, "surface:kanto")];
        assert!(kanto.players.contains_key("aaaa"));
        assert!(kanto.history.is_empty());
        assert!(
            !hub.rooms
                .contains_key(&room(Region::Johto, "surface:johto"))
        );
        drop(hub);
        assert!(outbound.try_recv().is_err());
    }

    #[test]
    fn an_upgrade_that_never_runs_releases_the_account() {
        let state = test_state(64);
        let (session, outbound) = connect(&state, "aaaa");
        let registration = Registration {
            inner: state.inner.clone(),
            session,
        };
        let task_state = state.clone();
        // axum drops the callback unrun when the handshake fails.
        let callback =
            move |socket: WebSocket| connection(socket, task_state, registration, outbound);
        drop(callback);
        assert!(state.inner.hub().clients.is_empty());
    }

    #[test]
    fn accepts_expansion_presence_through_species_1025() {
        let state = test_state(64);
        let (a, mut accepted) = connect(&state, "aaaa");
        join(
            &state,
            &a,
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

        let (b, mut rejected) = connect(&state, "bbbb");
        join(
            &state,
            &b,
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
        let (a, _outbound) = connect(&state, "aaaa");
        let now = Instant::now();
        for _ in 0..MAX_CONNECTION_MESSAGES {
            assert!(allow_connection_message(&state, &a, now));
            state
                .inner
                .hub()
                .clients
                .get_mut("aaaa")
                .unwrap()
                .state_rate = RateWindow::default();
        }
        assert!(!allow_connection_message(&state, &a, now));
        assert!(allow_connection_message(
            &state,
            &a,
            now + CONNECTION_MESSAGE_PERIOD
        ));
    }

    #[test]
    fn rejects_invalid_input_and_keeps_only_latest_quantized_state() {
        let state = test_state(64);
        let (a, mut outbound) = connect(&state, "aaaa");
        process(
            &state,
            &a,
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
        join_test(&state, &a, Region::Johto);
        outbound.try_recv().unwrap();
        update_player(
            &state,
            &a,
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
            &a,
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
            &a,
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
            &a,
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
        let (a, _a_rx) = connect(&state, "aaaa");
        let (b, mut b_rx) = connect(&state, "bbbb");
        join_test(&state, &a, Region::Johto);
        join_test(&state, &b, Region::Kanto);
        b_rx.try_recv().unwrap();
        join_test(&state, &b, Region::Johto);
        assert!(
            b_rx.try_recv()
                .unwrap()
                .into_text()
                .unwrap()
                .contains("ROOM_FULL")
        );
        assert_eq!(
            state.inner.hub().clients["bbbb"]
                .room
                .as_ref()
                .map(|room| room.region),
            Some(Region::Kanto)
        );
    }

    #[test]
    fn chat_envelope_keeps_the_origin_room_and_does_not_cross_rooms() {
        let state = test_state(64);
        let (a, mut johto) = connect(&state, "aaaa");
        let (b, mut cave) = connect(&state, "bbbb");
        join_test(&state, &a, Region::Johto);
        join_scene(&state, &b, Region::Johto, "cave:johto:dark-cave");
        johto.try_recv().unwrap();
        cave.try_recv().unwrap();

        chat(&state, &a, "hello".into(), Instant::now());
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
        let (session, mut outbound) = connect(&state, &id);
        state.inner.hub().clients.get_mut(&id).unwrap().username = "alice".into();
        let (ticket, _) =
            issue_ticket_with_secret(account, "alice", &state.inner.ticket_secret).unwrap();
        reauthenticate(&state, &session, &ticket);
        assert!(authentication_valid(&state, &session));
        let (other, _) =
            issue_ticket_with_secret(Uuid::new_v4(), "alice", &state.inner.ticket_secret).unwrap();
        reauthenticate(&state, &session, &other);
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
            while !state.inner.hub().clients.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(state.inner.hub().rooms.is_empty());
        server.abort();
    }
}
