//! Authoritative two-player ranked battles.
//!
//! Queue admission snapshots the account's `current` cloud-save team, normalizes it to level 50,
//! and resets battle HP. Match turns and Elo are stored separately, so ranked play never changes
//! the original monsters' HP, experience, memories, or save revision. The bundled catalog is
//! generated from the repository's pinned PokeAPI data. General move metadata (damage, healing,
//! drain, stat stages, common ailments and multi-hit ranges) and the battle engine's implemented
//! ability rules are resolved here, together with explicit fixed-damage, one-hit KO, Psywave,
//! recovery, cleansing, stat-reset and Rapid Spin rules, and timed confusion and binding. Other
//! move-specific scripts remain outside this core. Every roll comes from a per-match secret seed.

use crate::api::{ApiError, AppState, decompress, profile_user, rate_limit};
use crate::combat_forms::{combat_form, mega_stone_matches};
use crate::save_validation::{CONSUMABLE_HELD_TOOLS, species_can_evolve};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction, types::Json as SqlJson};
use std::{
    collections::HashMap,
    sync::{Once, OnceLock},
    time::Duration,
};
use uuid::Uuid;

const TURN_SECONDS: i32 = 90;
const ELO_K: f64 = 32.0;
const SWEEP_SECONDS: u64 = 30;
const TRI_ATTACK: i64 = 161;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/ranked", get(status))
        .route("/api/ranked/queue", post(queue))
        .route("/api/ranked/cancel", post(cancel))
        .route("/api/ranked/matches/{id}/action", post(action))
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum League {
    Standard,
    Open,
}
impl League {
    fn parse(value: &str) -> Result<Self, ApiError> {
        match value {
            "standard" => Ok(Self::Standard),
            "open" => Ok(Self::Open),
            _ => Err(invalid("리그는 standard 또는 open이어야 합니다.")),
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Open => "open",
        }
    }
}

#[derive(Deserialize)]
struct LeagueQuery {
    league: String,
}
#[derive(Deserialize)]
struct QueueBody {
    league: String,
}
#[derive(Deserialize)]
struct CancelBody {
    league: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransformationRequest {
    kind: String,
    #[serde(rename = "formIdentifier")]
    form_identifier: Option<String>,
    #[serde(rename = "teraType")]
    tera_type: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingTransformation {
    /// The team slot that asked; the request lapses if another Pokémon is active at resolution.
    index: usize,
    request: TransformationRequest,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnAction {
    turn: i32,
    move_index: Option<usize>,
    switch_index: Option<usize>,
    #[serde(default)]
    surrender: bool,
    #[serde(default)]
    transformation: Option<TransformationRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFile {
    species: Vec<Species>,
    moves: Vec<Move>,
    type_effectiveness: HashMap<String, HashMap<String, f64>>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Species {
    id: i64,
    name: String,
    types: Vec<String>,
    base_stats: Stats,
    restricted: bool,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    hp: i64,
    attack: i64,
    defense: i64,
    special_attack: i64,
    special_defense: i64,
    speed: i64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Move {
    id: i64,
    name: String,
    #[serde(rename = "type")]
    move_type: String,
    power: i64,
    accuracy: i64,
    damage_class: String,
    priority: i64,
    ailment: Option<String>,
    effect_chance: Option<i64>,
    #[serde(default)]
    stat_changes: Vec<StatChange>,
    healing: Option<i64>,
    drain: Option<i64>,
    meta_category: Option<i64>,
    target_id: Option<i64>,
    ailment_chance: Option<i64>,
    stat_chance: Option<i64>,
    min_hits: Option<i64>,
    max_hits: Option<i64>,
}
#[derive(Clone, Deserialize, Serialize)]
struct StatChange {
    stat: String,
    change: i8,
}
struct Catalog {
    species: HashMap<i64, Species>,
    moves: HashMap<i64, Move>,
    effectiveness: HashMap<String, HashMap<String, f64>>,
}
fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let parsed: CatalogFile = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/data/ranked-catalog.json"
        )))
        .expect("ranked catalog");
        Catalog {
            species: parsed.species.into_iter().map(|v| (v.id, v)).collect(),
            moves: parsed.moves.into_iter().map(|v| (v.id, v)).collect(),
            effectiveness: parsed.type_effectiveness,
        }
    })
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Fighter {
    instance_id: String,
    species_id: i64,
    nickname: String,
    level: i64,
    hp: i64,
    max_hp: i64,
    stats: Stats,
    types: Vec<String>,
    moves: Vec<Move>,
    ability: Option<String>,
    #[serde(default)]
    held_tool: Option<String>,
    #[serde(default)]
    held_tool_used: bool,
    #[serde(default)]
    choice_move: Option<i64>,
    #[serde(default)]
    regional_form: Option<String>,
    #[serde(default)]
    individual_values: Option<Stats>,
    #[serde(default)]
    preferred_transformation: Option<TransformationRequest>,
    #[serde(default)]
    transformation_kind: Option<String>,
    #[serde(default)]
    tera_type: Option<String>,
    #[serde(default)]
    original_types: Option<Vec<String>>,
    status: Option<String>,
    status_turns: Option<i8>,
    /// Confusion, binding and Leech Seed are volatile: they end when the Pokémon leaves the field
    /// and sit beside the major status instead of blocking it.
    #[serde(default)]
    confusion_turns: Option<i8>,
    #[serde(default)]
    trap_turns: Option<i8>,
    #[serde(default)]
    seeded: bool,
    #[serde(default)]
    stages: HashMap<String, i8>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Side {
    user_id: Uuid,
    username: String,
    active_index: usize,
    team: Vec<Fighter>,
    #[serde(default)]
    mega_used: bool,
    #[serde(default)]
    tera_used: bool,
    /// A Mega Evolution requested this turn. Only its owner sees it until the turn resolves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_transformation: Option<PendingTransformation>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Battle {
    player1: Side,
    player2: Side,
    #[serde(default)]
    events: Vec<String>,
    /// Secret source of every roll in the match. It stays in the stored state and is never sent;
    /// matches stored before it existed get one in `resolve_turn`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seed: Option<String>,
}

fn invalid(message: &'static str) -> ApiError {
    ApiError(StatusCode::UNPROCESSABLE_ENTITY, message)
}
fn conflict(message: &'static str) -> ApiError {
    ApiError(StatusCode::CONFLICT, message)
}
fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "랭크전을 찾을 수 없습니다.")
}

fn iv(monster: &Value, field: &str) -> i64 {
    monster
        .pointer(&format!("/ivs/{field}"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, 31)
}
fn normalized_stats_from_base(base: Stats, monster: &Value) -> Stats {
    let normal = |base, iv| (2 * base + iv) * 50 / 100 + 5;
    Stats {
        hp: (2 * base.hp + iv(monster, "hp")) * 50 / 100 + 60,
        attack: normal(base.attack, iv(monster, "attack")),
        defense: normal(base.defense, iv(monster, "defense")),
        special_attack: normal(base.special_attack, iv(monster, "specialAttack")),
        special_defense: normal(base.special_defense, iv(monster, "specialDefense")),
        speed: normal(base.speed, iv(monster, "speed")),
    }
}
#[cfg(test)]
fn normalized_stats(species: &Species, monster: &Value) -> Stats {
    normalized_stats_from_base(species.base_stats, monster)
}
fn snapshot(
    save: &Value,
    user_id: Uuid,
    username: String,
    league: League,
) -> Result<Side, ApiError> {
    let source = save
        .pointer("/game/player/team")
        .and_then(Value::as_array)
        .ok_or(invalid("현재 저장에 팀 정보가 없습니다."))?;
    if source.is_empty() {
        return Err(invalid("랭크전에 참가할 포켓몬이 없습니다."));
    }
    let mut team = Vec::new();
    for monster in source.iter().take(6) {
        let species_id = monster
            .get("speciesId")
            .and_then(Value::as_i64)
            .ok_or(invalid("팀 포켓몬 정보가 손상되었습니다."))?;
        let species = catalog()
            .species
            .get(&species_id)
            .ok_or(invalid("지원하지 않는 포켓몬이 팀에 있습니다."))?;
        if league == League::Standard && species.restricted {
            return Err(invalid(
                "스탠더드 리그에서는 전설·환상 포켓몬을 사용할 수 없습니다.",
            ));
        }
        let moves = monster
            .get("moves")
            .and_then(Value::as_array)
            .ok_or(invalid("포켓몬 기술 정보가 없습니다."))?
            .iter()
            .take(4)
            .map(|slot| {
                let id = slot
                    .get("moveId")
                    .and_then(Value::as_i64)
                    .ok_or(invalid("기술 정보가 손상되었습니다."))?;
                catalog()
                    .moves
                    .get(&id)
                    .cloned()
                    .ok_or(invalid("지원하지 않는 기술이 있습니다."))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if moves.is_empty() {
            return Err(invalid("기술을 가진 포켓몬만 참가할 수 있습니다."));
        }
        let form = monster
            .get("regionalForm")
            .and_then(Value::as_str)
            .and_then(combat_form);
        if form.is_some_and(|form| form.species_id != species_id) {
            return Err(invalid("지역 모습이 원본 종과 맞지 않습니다."));
        }
        let base = form.map(|form| form.base_stats);
        let stats = normalized_stats_from_base(
            base.map(|stats| Stats {
                hp: stats.hp,
                attack: stats.attack,
                defense: stats.defense,
                special_attack: stats.special_attack,
                special_defense: stats.special_defense,
                speed: stats.speed,
            })
            .unwrap_or(species.base_stats),
            monster,
        );
        team.push(Fighter {
            instance_id: monster
                .get("instanceId")
                .and_then(Value::as_str)
                .unwrap_or("ranked")
                .to_owned(),
            species_id,
            nickname: monster
                .get("nickname")
                .and_then(Value::as_str)
                .unwrap_or(&species.name)
                .chars()
                .take(30)
                .collect(),
            level: 50,
            hp: stats.hp,
            max_hp: stats.hp,
            stats,
            types: form
                .map(|form| form.types.clone())
                .unwrap_or_else(|| species.types.clone()),
            moves,
            ability: monster
                .pointer("/ability/slug")
                .and_then(Value::as_str)
                .map(str::to_owned),
            held_tool: monster
                .get("heldTool")
                .and_then(Value::as_str)
                .map(str::to_owned),
            held_tool_used: false,
            choice_move: None,
            regional_form: form.map(|form| form.identifier.clone()),
            individual_values: Some(Stats { hp: iv(monster, "hp"), attack: iv(monster, "attack"), defense: iv(monster, "defense"), special_attack: iv(monster, "specialAttack"), special_defense: iv(monster, "specialDefense"), speed: iv(monster, "speed") }),
            preferred_transformation: monster
                .get("preferredTransformation")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| invalid("선호 변신 설정이 올바르지 않습니다."))?,
            transformation_kind: None, tera_type: None, original_types: None,
            status: None,
            status_turns: None,
            confusion_turns: None,
            trap_turns: None,
            seeded: false,
            stages: HashMap::new(),
        });
    }
    Ok(Side {
        user_id,
        username,
        active_index: 0,
        team, mega_used: false, tera_used: false,
        pending_transformation: None,
    })
}
async fn saved_team(
    state: &AppState,
    id: Uuid,
    username: String,
    league: League,
) -> Result<Side, ApiError> {
    let row = sqlx::query("SELECT payload FROM saves WHERE user_id=$1 AND slot='current'")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(invalid("먼저 현재 진행을 계정에 저장해 주세요."))?;
    let raw: Vec<u8> = row.get("payload");
    let save: Value = serde_json::from_slice(&decompress(&raw)?)
        .map_err(|_| invalid("저장 데이터를 읽을 수 없습니다."))?;
    snapshot(&save, id, username, league)
}

fn tier(rating: i32) -> &'static str {
    match rating {
        ..=1099 => "bronze",
        1100..=1249 => "silver",
        1250..=1399 => "gold",
        1400..=1599 => "platinum",
        _ => "master",
    }
}
fn rules(league: League) -> Value {
    json!({"level":50,"teamSize":6,"legendaryAllowed":league==League::Open,"turnSeconds":TURN_SECONDS,"mechanics":"server-core","scriptedMoveEffects":"general-metadata-only"})
}

async fn ensure_rating(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    league: League,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO ranked_ratings(user_id,league) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(league.as_str())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<LeagueQuery>,
) -> Result<Json<Value>, ApiError> {
    let account = profile_user(&state, &headers).await?;
    rate_limit(&state, format!("ranked-status:{}", account.id), 600)?;
    start_sweeper(&state);
    let league = League::parse(&query.league)?;
    // Polling keeps a queued player matchable; a closed tab stops refreshing and drops out.
    sqlx::query("UPDATE ranked_queue SET last_seen=now() WHERE user_id=$1 AND league=$2")
        .bind(account.id)
        .bind(league.as_str())
        .execute(&state.db)
        .await?;
    expire_for_user(&state, account.id).await?;
    Ok(Json(view(&state, account.id, league).await?))
}

async fn view(state: &AppState, user_id: Uuid, league: League) -> Result<Value, ApiError> {
    let leaderboard=sqlx::query("SELECT r.user_id,u.username,r.rating,r.wins,r.losses FROM ranked_ratings r JOIN users u ON u.id=r.user_id WHERE r.league=$1 ORDER BY r.rating DESC,r.wins DESC,r.losses ASC,u.username ASC LIMIT 100")
        .bind(league.as_str()).fetch_all(&state.db).await?;
    let queued = sqlx::query(
        "SELECT joined_at::text joined_at FROM ranked_queue WHERE user_id=$1 AND league=$2",
    )
    .bind(user_id)
    .bind(league.as_str())
    .fetch_optional(&state.db)
    .await?;
    let me =
        sqlx::query("SELECT rating,wins,losses FROM ranked_ratings WHERE user_id=$1 AND league=$2")
            .bind(user_id)
            .bind(league.as_str())
            .fetch_optional(&state.db)
            .await?;
    let current = if queued.is_some() {
        None
    } else {
        current_match(state, user_id, league).await?
    };
    Ok(
        json!({"league":league,"rules":rules(league),"leaderboard":leaderboard.iter().enumerate().map(|(index,row)|{
        let rating:i32=row.get("rating"); json!({"rank":index+1,"userId":row.get::<Uuid,_>("user_id"),"username":row.get::<String,_>("username"),"rating":rating,"wins":row.get::<i32,_>("wins"),"losses":row.get::<i32,_>("losses"),"tier":tier(rating)})}).collect::<Vec<_>>(),
        "me":me.map(|row|{let rating:i32=row.get("rating");json!({"rating":rating,"wins":row.get::<i32,_>("wins"),"losses":row.get::<i32,_>("losses"),"tier":tier(rating),"queued":queued.is_some()})}),"currentMatch":current}),
    )
}

async fn queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<QueueBody>,
) -> Result<Json<Value>, ApiError> {
    let account = profile_user(&state, &headers).await?;
    rate_limit(&state, format!("ranked-queue:{}", account.id), 60)?;
    start_sweeper(&state);
    let league = League::parse(&body.league)?;
    let team = saved_team(&state, account.id, account.username.clone(), league).await?;
    expire_for_user(&state, account.id).await?;
    let mut tx = state.db.begin().await?;
    // The player lock serializes one player's queue requests across both leagues, so parallel
    // requests cannot pair the same player twice; the league lock serializes matchmaking.
    lock_player(&mut tx, account.id).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("ranked:{}", league.as_str()))
        .execute(&mut *tx)
        .await?;
    if in_match(&mut tx, account.id).await? {
        return Err(conflict("이미 진행 중인 랭크전이 있습니다."));
    }
    ensure_rating(&mut tx, account.id, league).await?;
    sqlx::query("UPDATE ranked_ratings SET last_queued_at=now() WHERE user_id=$1 AND league=$2")
        .bind(account.id)
        .bind(league.as_str())
        .execute(&mut *tx)
        .await?;
    drop_unseen_queue(&mut *tx).await?;
    // Queueing again in the same league keeps the original place in line.
    sqlx::query("INSERT INTO ranked_queue(user_id,league,username,team,joined_at,last_seen) VALUES($1,$2,$3,$4,now(),now()) ON CONFLICT(user_id) DO UPDATE SET joined_at=CASE WHEN ranked_queue.league=excluded.league THEN ranked_queue.joined_at ELSE now() END,league=excluded.league,username=excluded.username,team=excluded.team,last_seen=now()")
        .bind(account.id).bind(league.as_str()).bind(&account.username).bind(SqlJson(&team)).execute(&mut *tx).await?;
    let candidates=sqlx::query("SELECT user_id,team FROM ranked_queue WHERE league=$1 AND user_id<>$2 AND last_seen>=now()-interval '30 seconds' ORDER BY joined_at FOR UPDATE SKIP LOCKED LIMIT 10").bind(league.as_str()).bind(account.id).fetch_all(&mut *tx).await?;
    for other in candidates {
        let other_id: Uuid = other.get("user_id");
        // A player whose own queue request is running waits for the next matchmaking.
        if !try_lock_player(&mut tx, other_id).await? {
            continue;
        }
        if in_match(&mut tx, other_id).await? {
            // A queue row left behind by a player who is already playing.
            sqlx::query("DELETE FROM ranked_queue WHERE user_id=$1")
                .bind(other_id)
                .execute(&mut *tx)
                .await?;
            continue;
        }
        let SqlJson(other_team): SqlJson<Side> = other.get("team");
        let id = Uuid::new_v4();
        ensure_rating(&mut tx, other_id, league).await?;
        let battle = initial_battle(other_team, team);
        sqlx::query("INSERT INTO ranked_matches(id,league,player1_id,player2_id,state,deadline_at) VALUES($1,$2,$3,$4,$5,now()+interval '90 seconds')")
            .bind(id).bind(league.as_str()).bind(other_id).bind(account.id).bind(SqlJson(battle)).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM ranked_queue WHERE user_id=$1 OR user_id=$2").bind(other_id).bind(account.id).execute(&mut *tx).await?;
        break;
    }
    tx.commit().await?;
    Ok(Json(view(&state, account.id, league).await?))
}

fn player_lock_key(id: Uuid) -> String {
    format!("ranked-player:{id}")
}
async fn lock_player(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(player_lock_key(id))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
/// Never waits, so two matchmakers holding each other's players cannot deadlock.
async fn try_lock_player(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<bool, ApiError> {
    Ok(
        sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock(hashtext($1))")
            .bind(player_lock_key(id))
            .fetch_one(&mut **tx)
            .await?,
    )
}
/// Whether the player is in an active match of either league.
async fn in_match(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<bool, ApiError> {
    Ok(sqlx::query(
        "SELECT 1 FROM ranked_matches WHERE status='active' AND (player1_id=$1 OR player2_id=$1) LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}
/// Queue rows whose player stopped polling for 30 seconds are gone. Rows another request holds
/// are left for the next pass instead of waited on.
async fn drop_unseen_queue(
    executor: impl sqlx::Executor<'_, Database = Postgres>,
) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM ranked_queue WHERE user_id IN (SELECT user_id FROM ranked_queue WHERE last_seen<now()-interval '30 seconds' FOR UPDATE SKIP LOCKED)")
        .execute(executor)
        .await?;
    Ok(())
}

async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CancelBody>,
) -> Result<Json<Value>, ApiError> {
    let account = profile_user(&state, &headers).await?;
    rate_limit(&state, format!("ranked-cancel:{}", account.id), 120)?;
    let league = match body.league.as_deref() {
        Some(v) => Some(League::parse(v)?),
        None => None,
    };
    let removed = if let Some(l) = league {
        sqlx::query("DELETE FROM ranked_queue WHERE user_id=$1 AND league=$2")
            .bind(account.id)
            .bind(l.as_str())
            .execute(&state.db)
            .await?
            .rows_affected()
    } else {
        sqlx::query("DELETE FROM ranked_queue WHERE user_id=$1")
            .bind(account.id)
            .execute(&state.db)
            .await?
            .rows_affected()
    };
    Ok(Json(json!({"cancelled":removed>0})))
}

async fn action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<TurnAction>,
) -> Result<Json<Value>, ApiError> {
    let account = profile_user(&state, &headers).await?;
    rate_limit(&state, format!("ranked-action:{}", account.id), 600)?;
    start_sweeper(&state);
    let mut tx = state.db.begin().await?;
    let row=sqlx::query("SELECT league,player1_id,player2_id,state,actions,turn,status,deadline_at<=now() expired FROM ranked_matches WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(not_found)?;
    let p1: Uuid = row.get("player1_id");
    let p2: Uuid = row.get("player2_id");
    if account.id != p1 && account.id != p2 {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "이 랭크전의 참가자가 아닙니다.",
        ));
    }
    if row.get::<String, _>("status") != "active" {
        tx.commit().await?;
        return Ok(Json(
            json!({"match":match_value(&state,id,account.id).await?}),
        ));
    }
    if row.get::<bool, _>("expired") {
        finalize_timeout(
            &mut tx,
            id,
            p1,
            p2,
            row.get::<SqlJson<Value>, _>("actions").0,
        )
        .await?;
        tx.commit().await?;
        return Ok(Json(
            json!({"match":match_value(&state,id,account.id).await?}),
        ));
    }
    let turn: i32 = row.get("turn");
    if input.turn < turn {
        tx.commit().await?;
        return Ok(Json(
            json!({"match":match_value(&state,id,account.id).await?}),
        ));
    }
    if input.turn != turn {
        return Err(conflict("현재 턴과 맞지 않는 행동입니다."));
    }
    validate_action_shape(&input)?;
    let mut actions = row.get::<SqlJson<Value>, _>("actions").0;
    let map = actions
        .as_object_mut()
        .ok_or(invalid("대전 행동 정보가 손상되었습니다."))?;
    let key = account.id.to_string();
    if map.contains_key(&key) {
        return Err(conflict("이미 이번 턴의 행동을 제출했습니다."));
    }
    let SqlJson(mut battle): SqlJson<Battle> = row.get("state");
    normalize_battle(&mut battle);
    let own_is_p1 = account.id == p1;
    if let Some(ref transformation) = input.transformation {
        request_transformation(if own_is_p1 { &mut battle.player1 } else { &mut battle.player2 }, transformation)?;
        sqlx::query("UPDATE ranked_matches SET state=$2,updated_at=now() WHERE id=$1").bind(id).bind(SqlJson(&battle)).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(Json(json!({"match":match_value(&state,id,account.id).await?})));
    }
    let (own_side, other_side, other) = if own_is_p1 {
        (&battle.player1, &battle.player2, p2)
    } else {
        (&battle.player2, &battle.player1, p1)
    };
    check_turn_action(own_side, &input)?;
    // Resolution must never fail on the opponent's stored choice: that would roll back every
    // submission until the deadline handed the win to whoever stored it. A stale or invalid
    // stored choice is dropped, so its sender has to choose again before the deadline.
    let other_key = other.to_string();
    let stale = map.get(&other_key).is_some_and(|stored| {
        !serde_json::from_value::<TurnAction>(stored.clone())
            .is_ok_and(|action| check_turn_action(other_side, &action).is_ok())
    });
    if stale {
        map.remove(&other_key);
    }
    map.insert(key.clone(), serde_json::to_value(&input).unwrap());
    if input.switch_index.is_some() {
        // The Pokémon a pending Mega Evolution was for is leaving before it could happen.
        (if own_is_p1 { &mut battle.player1 } else { &mut battle.player2 }).pending_transformation = None;
    }
    if input.surrender {
        finalize(
            &mut tx,
            id,
            p1,
            p2,
            Some(if account.id == p1 { p2 } else { p1 }),
            "surrender",
        )
        .await?;
    } else if map.len() == 2 {
        let a1: TurnAction = serde_json::from_value(map[&p1.to_string()].clone())
            .map_err(|_| invalid("대전 행동 정보가 손상되었습니다."))?;
        let a2: TurnAction = serde_json::from_value(map[&p2.to_string()].clone())
            .map_err(|_| invalid("대전 행동 정보가 손상되었습니다."))?;
        resolve_turn(id, turn, &mut battle, a1, a2)?;
        let p1_alive = alive(&battle.player1);
        let p2_alive = alive(&battle.player2);
        sqlx::query("UPDATE ranked_matches SET state=$2,actions='{}'::jsonb,turn=turn+1,deadline_at=now()+interval '90 seconds',updated_at=now() WHERE id=$1").bind(id).bind(SqlJson(&battle)).execute(&mut *tx).await?;
        if !p1_alive || !p2_alive {
            finalize(
                &mut tx,
                id,
                p1,
                p2,
                if p1_alive {
                    Some(p1)
                } else if p2_alive {
                    Some(p2)
                } else {
                    None
                },
                "knockout",
            )
            .await?;
        }
    } else {
        sqlx::query("UPDATE ranked_matches SET state=$2,actions=$3,updated_at=now() WHERE id=$1")
            .bind(id)
            .bind(SqlJson(&battle))
            .bind(SqlJson(&actions))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(
        json!({"match":match_value(&state,id,account.id).await?}),
    ))
}

/// The move or switch a player chose must be usable in the current state. Checked when the
/// choice is stored, so turn resolution cannot fail on it later.
fn check_turn_action(side: &Side, action: &TurnAction) -> Result<(), ApiError> {
    if let Some(index) = action.move_index {
        selected_move(side, index)?;
    }
    if let Some(index) = action.switch_index {
        if index >= side.team.len() || side.team[index].hp <= 0 || index == side.active_index {
            return Err(invalid("교체할 수 없는 포켓몬입니다."));
        }
    }
    Ok(())
}
fn validate_action_shape(a: &TurnAction) -> Result<(), ApiError> {
    let choices =
        (a.move_index.is_some() as u8) + (a.switch_index.is_some() as u8) + (a.surrender as u8) + (a.transformation.is_some() as u8);
    if choices != 1 {
        return Err(invalid("기술, 교체, 변신, 항복 중 하나만 선택해 주세요."));
    }
    Ok(())
}
fn alive(side: &Side) -> bool {
    side.team.iter().any(|m| m.hp > 0)
}
fn active(side: &Side) -> &Fighter {
    &side.team[side.active_index]
}
fn auto_switch(side: &mut Side) {
    if side.team[side.active_index].hp <= 0 {
        if let Some(i) = side.team.iter().position(|m| m.hp > 0) {
            leave_field(&mut side.team[side.active_index]);
            side.active_index = i;
            apply_preferred_transformation(side);
        }
    }
}
fn apply_switch(side: &mut Side, index: usize) -> Result<(), ApiError> {
    if index >= side.team.len() || side.team[index].hp <= 0 || index == side.active_index {
        return Err(invalid("교체할 수 없는 포켓몬입니다."));
    }
    leave_field(&mut side.team[side.active_index]);
    side.active_index = index;
    apply_preferred_transformation(side);
    Ok(())
}
/// Stat stages, a Choice lock and volatile effects last only while the Pokémon is on the field.
fn leave_field(fighter: &mut Fighter) {
    fighter.stages.clear();
    fighter.choice_move = None;
    fighter.confusion_turns = None;
    fighter.trap_turns = None;
    fighter.seeded = false;
}

fn apply_preferred_transformation(side: &mut Side) {
    remove_legacy_tera(side);
    let Some(request) = side.team[side.active_index].preferred_transformation.clone() else {
        return;
    };
    if side.team[side.active_index].transformation_kind.is_some()
        || (request.kind == "mega" && side.mega_used)
    {
        return;
    }
    let _ = apply_transformation(side, &request);
}

fn initial_battle(mut player1: Side, mut player2: Side) -> Battle {
    apply_preferred_transformation(&mut player1);
    apply_preferred_transformation(&mut player2);
    Battle {
        player1,
        player2,
        events: vec!["랭크전이 시작되었습니다.".into()],
        seed: Some(new_seed()),
    }
}

/// A requested Mega Evolution waits for the turn to resolve, so the opponent cannot see it
/// before locking in and it lapses if its Pokémon switches out first.
fn request_transformation(side: &mut Side, request: &TransformationRequest) -> Result<(), ApiError> {
    let mut preview = side.clone();
    apply_pending_transformation(&mut preview);
    apply_transformation(&mut preview, request)?;
    side.pending_transformation = Some(PendingTransformation {
        index: side.active_index,
        request: request.clone(),
    });
    Ok(())
}
fn apply_pending_transformation(side: &mut Side) {
    if let Some(pending) = side.pending_transformation.take() {
        if pending.index == side.active_index {
            let _ = apply_transformation(side, &pending.request);
        }
    }
}

fn apply_transformation(side: &mut Side, request: &TransformationRequest) -> Result<(), ApiError> {
    let monster = &mut side.team[side.active_index];
    if monster.hp <= 0 || monster.transformation_kind.is_some() { return Err(invalid("현재 포켓몬은 변신할 수 없습니다.")); }
    match request.kind.as_str() {
        "mega" => {
            if side.mega_used { return Err(invalid("이미 메가진화를 사용했습니다.")); }
            let profile = request.form_identifier.as_deref().and_then(combat_form)
                .filter(|form| form.kind == "mega" && form.species_id == monster.species_id && crate::combat_forms::mega_model_available(&form.identifier))
                .ok_or(invalid("메가진화 모습이 올바르지 않습니다."))?;
            if !monster
                .held_tool
                .as_deref()
                .is_some_and(|tool| mega_stone_matches(tool, &profile.identifier))
            {
                return Err(invalid("해당 메가진화석을 장착해야 합니다."));
            }
            let base = profile.base_stats;
            let base = Stats { hp: base.hp, attack: base.attack, defense: base.defense, special_attack: base.special_attack, special_defense: base.special_defense, speed: base.speed };
            let saved = monster.individual_values.map(|ivs| json!({"ivs":ivs})).unwrap_or(json!({}));
            let stats = normalized_stats_from_base(base, &saved);
            monster.hp = ((monster.hp * stats.hp + monster.max_hp - 1) / monster.max_hp).min(stats.hp);
            monster.max_hp = stats.hp; monster.stats = stats; monster.types = profile.types.clone();
            monster.ability = profile.abilities.first().map(|ability| ability.slug.clone());
            monster.regional_form = Some(profile.identifier.clone());
            side.mega_used = true;
        }
        _ => return Err(invalid("변신 종류가 올바르지 않습니다.")),
    }
    monster.transformation_kind = Some(request.kind.clone());
    Ok(())
}

fn remove_legacy_tera(side: &mut Side) {
    side.tera_used = false;
    for monster in &mut side.team {
        if monster.preferred_transformation.as_ref().is_some_and(|request| request.kind == "tera") { monster.preferred_transformation = None; }
        if monster.transformation_kind.as_deref() == Some("tera") {
            monster.types = monster.original_types.take().unwrap_or_else(|| monster.regional_form.as_deref().and_then(combat_form)
                .map(|form| form.types.clone()).unwrap_or_else(|| catalog().species[&monster.species_id].types.clone()));
            monster.transformation_kind = None;
        }
        monster.tera_type = None; monster.original_types = None;
    }
}

/// Brings a stored battle up to the current rules: legacy Tera is undone, and old matches that
/// kept every ailment in the single status slot keep only what this engine carries out.
fn normalize_battle(battle: &mut Battle) {
    for side in [&mut battle.player1, &mut battle.player2] {
        remove_legacy_tera(side);
        let active_index = side.active_index;
        for (index, fighter) in side.team.iter_mut().enumerate() {
            let on_field = index == active_index;
            match fighter.status.as_deref() {
                None | Some("sleep" | "freeze" | "paralysis" | "poison" | "burn") => continue,
                // These never counted down before, so the active Pokémon gets the shortest
                // duration; a benched one has already left the field.
                Some("confusion") if on_field => fighter.confusion_turns = Some(2),
                Some("trap") if on_field => fighter.trap_turns = Some(2),
                Some("leech-seed") if on_field => fighter.seeded = true,
                Some(_) => {}
            }
            fighter.status = None;
            fighter.status_turns = None;
        }
    }
}

fn stab_multiplier(monster: &Fighter, move_type: &str) -> f64 {
    if monster.types.iter().any(|kind| kind == move_type) { 1.5 } else { 1.0 }
}

fn effective_move(_monster: &Fighter, mv: &Move) -> (String, String, i64) {
    (mv.move_type.clone(), mv.damage_class.clone(), mv.power)
}

/// The move a Choice item still locks the fighter into. A lock on a move the fighter no longer
/// knows, or without a Choice item, is ignored, so it can never leave the fighter unable to act.
fn choice_lock(fighter: &Fighter) -> Option<i64> {
    fighter.choice_move.filter(|id| {
        matches!(tool(fighter), Some("choice-band" | "choice-specs" | "choice-scarf"))
            && fighter.moves.iter().any(|known| known.id == *id)
    })
}
fn selected_move(side: &Side, index: usize) -> Result<Move, ApiError> {
    let fighter = active(side);
    let selected = fighter.moves.get(index).ok_or(invalid("선택한 기술이 없습니다."))?;
    if choice_lock(fighter).is_some_and(|id| id != selected.id) { return Err(invalid("구애 도구에 고정된 기술만 사용할 수 있습니다.")); }
    Ok(selected.clone())
}

fn resolve_turn(
    id: Uuid,
    turn: i32,
    battle: &mut Battle,
    a1: TurnAction,
    a2: TurnAction,
) -> Result<(), ApiError> {
    battle.events.clear();
    let dice = Dice {
        seed: battle.seed.get_or_insert_with(|| legacy_seed(id)).clone(),
        turn,
    };
    if let Some(i) = a1.switch_index {
        apply_switch(&mut battle.player1, i)?;
        battle
            .events
            .push(format!("{}이(가) 교체했습니다.", battle.player1.username));
    }
    if let Some(i) = a2.switch_index {
        apply_switch(&mut battle.player2, i)?;
        battle
            .events
            .push(format!("{}이(가) 교체했습니다.", battle.player2.username));
    }
    // A Mega Evolution requested this turn happens before anyone moves, so its speed counts.
    apply_pending_transformation(&mut battle.player1);
    apply_pending_transformation(&mut battle.player2);
    let p1move = a1
        .move_index
        .map(|i| selected_move(&battle.player1, i))
        .transpose()?;
    let p2move = a2
        .move_index
        .map(|i| selected_move(&battle.player2, i))
        .transpose()?;
    let first = match (&p1move, &p2move) {
        (Some(a), Some(b)) => {
            let same = a.priority == b.priority;
            let p1_quick = same && tool(active(&battle.player1)) == Some("quick-claw") && dice.percent(Roll::QuickClaw, true, 0) < 20;
            let p2_quick = same && tool(active(&battle.player2)) == Some("quick-claw") && dice.percent(Roll::QuickClaw, false, 0) < 20;
            if p1_quick != p2_quick {
                let holder = active(if p1_quick { &battle.player1 } else { &battle.player2 }).nickname.clone();
                battle.events.push(format!("{holder}은(는) 선제공격손톱으로 먼저 움직였습니다."));
                p1_quick
            } else {
                let speed1 = effective_stat(active(&battle.player1), "speed");
                let speed2 = effective_stat(active(&battle.player2), "speed");
                a.priority > b.priority
                    || (same
                        && (speed1 > speed2
                            || (speed1 == speed2 && dice.draw(Roll::SpeedTie, true, 0) % 2 == 0)))
            }
        }
        (Some(_), None) => true,
        _ => false,
    };
    for p1_turn in if first { [true, false] } else { [false, true] } {
        let selected = if p1_turn {
            p1move.clone()
        } else {
            p2move.clone()
        };
        if let Some(mv) = selected {
            attack(&dice, battle, p1_turn, &mv);
            for side in [&mut battle.player1, &mut battle.player2] {
                let index = side.active_index;
                react_held_items(&mut side.team[index], &mut battle.events);
            }
        }
    }
    residual(&mut battle.player1, &mut battle.events);
    residual(&mut battle.player2, &mut battle.events);
    auto_switch(&mut battle.player1);
    auto_switch(&mut battle.player2);
    Ok(())
}

/// What a roll decides. With the turn, the side and an index it selects an independent draw.
#[derive(Clone, Copy)]
enum Roll {
    SpeedTie = 1,
    QuickClaw,
    Accuracy,
    Thaw,
    FullParalysis,
    ConfusionHit,
    Hits,
    FocusBand,
    StatChance,
    AilmentChance,
    AilmentKind,
    Duration,
    Psywave,
}
/// The rolls of one turn. Each hashes the match's secret seed with the turn, purpose, side and
/// index, so a client cannot predict an outcome and no roll follows from another.
struct Dice {
    seed: String,
    turn: i32,
}
impl Dice {
    fn draw(&self, roll: Roll, p1: bool, index: u8) -> u64 {
        let digest = Sha256::new()
            .chain_update(self.seed.as_bytes())
            .chain_update(self.turn.to_le_bytes())
            .chain_update([roll as u8, u8::from(p1), index])
            .finalize();
        u64::from_le_bytes(digest[..8].try_into().expect("sha256 digest"))
    }
    fn percent(&self, roll: Roll, p1: bool, index: u8) -> i64 {
        (self.draw(roll, p1, index) % 100) as i64
    }
}
fn new_seed() -> String {
    let mut seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut seed);
    hex::encode(seed)
}
/// Matches stored before per-match seeds existed derive one from a key that never leaves this
/// process, so their remaining rolls are as unpredictable as a new match's.
fn legacy_seed(id: Uuid) -> String {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    let key = KEY.get_or_init(|| {
        let mut key = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut key);
        key
    });
    hex::encode(Sha256::new().chain_update(key).chain_update(id.as_bytes()).finalize())
}
fn effectiveness(move_type: &str, types: &[String]) -> f64 {
    types
        .iter()
        .map(|t| {
            catalog()
                .effectiveness
                .get(move_type)
                .and_then(|m| m.get(t))
                .copied()
                .unwrap_or(1.0)
        })
        .product()
}
fn stage_multiplier(stage: i8) -> f64 {
    if stage >= 0 {
        (2 + stage as i64) as f64 / 2.0
    } else {
        2.0 / (2 - stage as i64) as f64
    }
}
fn effective_stat(monster: &Fighter, stat: &str) -> i64 {
    let base = match stat {
        "attack" => monster.stats.attack,
        "defense" => monster.stats.defense,
        "specialAttack" => monster.stats.special_attack,
        "specialDefense" => monster.stats.special_defense,
        "speed" => monster.stats.speed,
        _ => 1,
    };
    let tool_multiplier = match (monster.held_tool.as_deref(), stat) {
        (Some("choice-band"), "attack")
        | (Some("choice-specs"), "specialAttack")
        | (Some("choice-scarf"), "speed")
        | (Some("assault-vest"), "specialDefense") => 1.5,
        (Some("eviolite"), "defense" | "specialDefense") if species_can_evolve(monster.species_id) => 1.5,
        _ => 1.0,
    };
    let mut value =
        (base as f64 * stage_multiplier(*monster.stages.get(stat).unwrap_or(&0)) * tool_multiplier)
            .floor() as i64;
    if stat == "speed" && monster.status.as_deref() == Some("paralysis") {
        value /= 2;
    }
    value.max(1)
}
fn stage_key(stat: &str) -> Option<&'static str> {
    match stat {
        "attack" => Some("attack"),
        "defense" => Some("defense"),
        "special-attack" | "specialAttack" => Some("specialAttack"),
        "special-defense" | "specialDefense" => Some("specialDefense"),
        "speed" => Some("speed"),
        "accuracy" => Some("accuracy"),
        "evasion" => Some("evasion"),
        _ => None,
    }
}
fn change_stage(monster: &mut Fighter, stat: &str, change: i8) -> i8 {
    let Some(key) = stage_key(stat) else { return 0 };
    let before = *monster.stages.get(key).unwrap_or(&0);
    let after = (before + change).clamp(-6, 6);
    monster.stages.insert(key.into(), after);
    after - before
}
/// The held tool that still works; a consumable stops after its one use in the match.
fn tool(monster: &Fighter) -> Option<&str> {
    let held = monster.held_tool.as_deref()?;
    (!(monster.held_tool_used && CONSUMABLE_HELD_TOOLS.contains(&held))).then_some(held)
}
fn type_boost_tool(move_type: &str) -> Option<&'static str> {
    Some(match move_type {
        "normal" => "silk-scarf",
        "fire" => "charcoal",
        "water" => "mystic-water",
        "electric" => "magnet",
        "grass" => "miracle-seed",
        "ice" => "never-melt-ice",
        "fighting" => "black-belt",
        "poison" => "poison-barb",
        "ground" => "soft-sand",
        "flying" => "sharp-beak",
        "psychic" => "twisted-spoon",
        "bug" => "silver-powder",
        "rock" => "hard-stone",
        "ghost" => "spell-tag",
        "dragon" => "dragon-fang",
        "dark" => "black-glasses",
        "steel" => "iron-plate",
        "fairy" => "fairy-feather",
        _ => return None,
    })
}
/// Offensive held-tool multiplier, mirroring the client battle rules.
fn tool_power(attacker: &Fighter, move_type: &str, damage_class: &str, type_mult: f64) -> f64 {
    match tool(attacker) {
        Some("life-orb") => 1.3,
        Some(held) if type_boost_tool(move_type) == Some(held) => 1.2,
        Some("expert-belt") if type_mult > 1.0 => 1.2,
        Some("muscle-band") if damage_class == "physical" => 1.1,
        Some("wise-glasses") if damage_class == "special" => 1.1,
        _ => 1.0,
    }
}
/// Berries and White Herb react immediately and only once per match.
fn react_held_items(monster: &mut Fighter, events: &mut Vec<String>) {
    if monster.hp <= 0 {
        return;
    }
    let held = tool(monster).map(str::to_owned);
    match held.as_deref() {
        Some(berry @ ("oran-berry" | "sitrus-berry")) if monster.hp * 2 <= monster.max_hp => {
            let (name, amount) = if berry == "oran-berry" { ("오랭열매", 10) } else { ("자뭉열매", (monster.max_hp / 4).max(1)) };
            let before = monster.hp;
            monster.hp = (monster.hp + amount).min(monster.max_hp);
            monster.held_tool_used = true;
            events.push(format!("{}은(는) {name}로 {} 회복했습니다.", monster.nickname, monster.hp - before));
        }
        Some("lum-berry")
            if matches!(
                monster.status.as_deref(),
                Some("sleep" | "freeze" | "paralysis" | "poison" | "burn")
            ) || monster.confusion_turns.is_some() =>
        {
            monster.status = None;
            monster.status_turns = None;
            monster.confusion_turns = None;
            monster.held_tool_used = true;
            events.push(format!("{}은(는) 리샘열매로 상태이상이 나았습니다.", monster.nickname));
        }
        Some("white-herb") if monster.stages.values().any(|stage| *stage < 0) => {
            for stage in monster.stages.values_mut() {
                *stage = (*stage).max(0);
            }
            monster.held_tool_used = true;
            events.push(format!("{}은(는) 하양허브로 떨어진 능력을 되돌렸습니다.", monster.nickname));
        }
        _ => {}
    }
}
fn ability_immunity(ability: Option<&str>, move_type: &str) -> Option<bool> {
    let expected = match ability? {
        "levitate" => "ground",
        "water-absorb" | "storm-drain" | "dry-skin" => "water",
        "volt-absorb" | "lightning-rod" | "motor-drive" => "electric",
        "flash-fire" => "fire",
        "sap-sipper" => "grass",
        _ => return None,
    };
    (expected == move_type).then_some(matches!(
        ability,
        Some("water-absorb" | "volt-absorb" | "dry-skin")
    ))
}
fn low_hp_power(monster: &Fighter, move_type: &str) -> f64 {
    if monster.hp * 3 > monster.max_hp {
        return 1.0;
    }
    match monster.ability.as_deref() {
        Some("overgrow") if move_type == "grass" => 1.5,
        Some("blaze") if move_type == "fire" => 1.5,
        Some("torrent") if move_type == "water" => 1.5,
        Some("swarm") if move_type == "bug" => 1.5,
        _ => 1.0,
    }
}
fn self_target(mv: &Move) -> bool {
    matches!(mv.target_id.unwrap_or(10), 4 | 7 | 13 | 15)
}
/// Rapid Spin, Tera Blast, Spin Out, Torch Song, Aqua Step, Make It Rain, Armor Cannon and
/// Electro Shot: moves that change the user's stats but carry no PokeAPI meta category.
const USER_STAT_MOVES: [i64; 8] = [229, 851, 859, 871, 872, 874, 890, 905];
fn self_stat_target(mv: &Move) -> bool {
    // Meta category 7 (damage+raise) changes the user's stats whether it raises them (Flame
    // Charge) or lowers them (Close Combat, Overheat); 6 (damage+lower) changes the target's.
    match mv.meta_category {
        Some(7) => true,
        Some(6) => false,
        _ => USER_STAT_MOVES.contains(&mv.id) || self_target(mv),
    }
}
fn can_act(dice: &Dice, p1: bool, side: &mut Side, events: &mut Vec<String>) -> bool {
    let monster = &mut side.team[side.active_index];
    if monster.status.as_deref() == Some("sleep") {
        let left = monster.status_turns.unwrap_or(1);
        if left > 1 {
            monster.status_turns = Some(left - 1);
            events.push(format!("{}은(는) 잠들어 있습니다.", monster.nickname));
            return false;
        }
        monster.status = None;
        monster.status_turns = None;
        events.push(format!("{}은(는) 잠에서 깨어났습니다.", monster.nickname));
    }
    if monster.status.as_deref() == Some("freeze") {
        if dice.percent(Roll::Thaw, p1, 0) < 20 {
            monster.status = None;
            monster.status_turns = None;
            events.push(format!("{}의 얼음이 녹았습니다.", monster.nickname));
        } else {
            events.push(format!(
                "{}은(는) 얼어 움직일 수 없습니다.",
                monster.nickname
            ));
            return false;
        }
    }
    if monster.status.as_deref() == Some("paralysis")
        && dice.percent(Roll::FullParalysis, p1, 0) < 25
    {
        events.push(format!(
            "{}은(는) 마비되어 움직일 수 없습니다.",
            monster.nickname
        ));
        return false;
    }
    // Like the client rules: each action uses up a turn of confusion, and while it lasts a third
    // of actions hit the user for 1/8 of its max HP instead.
    if let Some(left) = monster.confusion_turns {
        if left <= 1 {
            monster.confusion_turns = None;
            events.push(format!("{}의 혼란이 풀렸습니다.", monster.nickname));
        } else {
            monster.confusion_turns = Some(left - 1);
            if dice.draw(Roll::ConfusionHit, p1, 0) % 3 == 0 {
                monster.hp = (monster.hp - (monster.max_hp / 8).max(1)).max(0);
                events.push(format!("{}은(는) 혼란으로 자신을 공격했습니다.", monster.nickname));
                return false;
            }
        }
    }
    true
}
fn support_move(
    attacker: &mut Side,
    defender: &mut Side,
    mv: &Move,
    events: &mut Vec<String>,
) -> bool {
    match mv.id {
        114 => {
            attacker.team[attacker.active_index].stages.clear();
            defender.team[defender.active_index].stages.clear();
            events.push(format!(
                "{}: 양쪽 포켓몬의 능력치 변화가 사라졌습니다.",
                mv.name
            ));
        }
        150 => events.push(format!("{}: 아무 일도 일어나지 않았습니다.", mv.name)),
        156 => {
            let actor = &mut attacker.team[attacker.active_index];
            if actor.hp == actor.max_hp
                || matches!(
                    actor.ability.as_deref(),
                    Some("insomnia" | "vital-spirit" | "comatose")
                )
            {
                events.push(format!("{}을(를) 사용할 수 없었습니다.", mv.name));
            } else {
                actor.hp = actor.max_hp;
                actor.status = Some("sleep".into());
                actor.status_turns = Some(3);
                events.push(format!(
                    "{}은(는) 잠들어 완전히 회복했습니다.",
                    actor.nickname
                ));
            }
        }
        215 | 312 => {
            let mut cured = false;
            for (index, ally) in attacker.team.iter_mut().enumerate() {
                if ally.hp <= 0
                    || !matches!(
                        ally.status.as_deref(),
                        Some("sleep" | "freeze" | "paralysis" | "poison" | "burn")
                    )
                {
                    continue;
                }
                if mv.id == 215
                    && index != attacker.active_index
                    && matches!(ally.ability.as_deref(), Some("soundproof" | "good-as-gold"))
                {
                    continue;
                }
                ally.status = None;
                ally.status_turns = None;
                cured = true;
                events.push(format!(
                    "{}: {}의 상태이상이 나았습니다.",
                    mv.name, ally.nickname
                ));
            }
            if !cured {
                events.push(format!("{}: 치료할 상태이상이 없었습니다.", mv.name));
            }
        }
        _ => return false,
    }
    true
}
fn one_hit_ko(mv: &Move) -> bool {
    matches!(mv.id, 12 | 32 | 90)
}
/// Damage that skips the attack formula, as in the client rules. Guillotine, Horn Drill and
/// Fissure take all remaining HP (every ranked fighter is level 50, so their level check never
/// fails); Psywave deals 0.5-1.5x the user's level from a 0-99 `roll`.
fn fixed_damage(mv: &Move, attacker: &Fighter, defender: &Fighter, roll: i64) -> Option<i64> {
    match mv.id {
        49 => Some(20),
        82 => Some(40),
        69 | 101 => Some(attacker.level),
        162 => Some((defender.hp / 2).max(1)),
        _ if one_hit_ko(mv) => Some(defender.hp),
        149 => Some((attacker.level * (50 + roll) / 100).max(1)),
        _ => None,
    }
}
fn attack(dice: &Dice, battle: &mut Battle, p1: bool, mv: &Move) {
    let (attacker, defender) = if p1 {
        (&mut battle.player1, &mut battle.player2)
    } else {
        (&mut battle.player2, &mut battle.player1)
    };
    if !alive(attacker)
        || !alive(defender)
        || active(attacker).hp <= 0
        || !can_act(dice, p1, attacker, &mut battle.events)
    {
        return;
    }
    if mv.damage_class == "status" && tool(active(attacker)) == Some("assault-vest") {
        battle.events.push(format!(
            "{}은(는) 돌격조끼 때문에 {}을(를) 쓸 수 없습니다.",
            active(attacker).nickname,
            mv.name
        ));
        return;
    }
    if matches!(active(attacker).held_tool.as_deref(), Some("choice-band" | "choice-specs" | "choice-scarf")) {
        attacker.team[attacker.active_index].choice_move = Some(mv.id);
    }
    let (move_type, damage_class, move_power) = effective_move(active(attacker), mv);
    let accuracy_tool = if tool(active(attacker)) == Some("wide-lens") { 1.1 } else { 1.0 }
        * if tool(active(defender)) == Some("bright-powder") { 0.9 } else { 1.0 };
    let accuracy = (mv.accuracy as f64
        * stage_multiplier(*active(attacker).stages.get("accuracy").unwrap_or(&0))
        / stage_multiplier(*active(defender).stages.get("evasion").unwrap_or(&0))
        * accuracy_tool)
    .round() as i64;
    if mv.accuracy > 0 && dice.percent(Roll::Accuracy, p1, 0) >= accuracy {
        battle.events.push(format!(
            "{}의 {}이(가) 빗나갔습니다.",
            active(attacker).nickname,
            mv.name
        ));
        return;
    }
    if support_move(attacker, defender, mv, &mut battle.events) {
        return;
    }
    let immunity = if self_target(mv) {
        None
    } else {
        ability_immunity(active(defender).ability.as_deref(), &move_type)
    };
    let balloon = immunity.is_none()
        && damage_class != "status"
        && move_type == "ground"
        && tool(active(defender)) == Some("air-balloon");
    let mut banded = false;
    let mut total_damage = 0;
    let mut type_mult = effectiveness(&move_type, &active(defender).types);
    // Ordinary status moves are not damaging type matchups. Thunder Wave still
    // respects Ground immunity; ailment-specific immunities are checked below.
    if damage_class == "status" && (self_target(mv) || move_type != "electric") {
        type_mult = 1.0;
    }
    if let Some(heal) = immunity {
        type_mult = 0.0;
        if heal {
            let target = &mut defender.team[defender.active_index];
            target.hp = (target.hp + (target.max_hp / 4).max(1)).min(target.max_hp);
        }
        battle.events.push(format!(
            "{}의 특성이 {}을(를) 막았습니다.",
            active(defender).nickname,
            mv.name
        ));
    } else if balloon {
        type_mult = 0.0;
        battle.events.push(format!(
            "{}의 풍선이 {}을(를) 막았습니다.",
            active(defender).nickname,
            mv.name
        ));
    } else if let Some(mut damage) = fixed_damage(
        mv,
        active(attacker),
        active(defender),
        dice.percent(Roll::Psywave, p1, 0),
    ) {
        let target = &mut defender.team[defender.active_index];
        let sturdy_blocks = one_hit_ko(mv) && target.ability.as_deref() == Some("sturdy");
        if type_mult == 0.0 || sturdy_blocks {
            damage = 0;
        }
        if (target.ability.as_deref() == Some("sturdy")
            || (target.held_tool.as_deref() == Some("focus-sash") && !target.held_tool_used))
            && target.hp == target.max_hp
            && damage >= target.hp
        {
            if target.ability.as_deref() != Some("sturdy") { target.held_tool_used = true; }
            damage = (target.hp - 1).max(0);
        }
        if damage >= target.hp && target.hp > 0 && tool(target) == Some("focus-band") && dice.percent(Roll::FocusBand, p1, 0) < 10 {
            damage = target.hp - 1;
            banded = true;
        }
        total_damage = damage.min(target.hp);
        target.hp -= total_damage;
        battle.events.push(if sturdy_blocks {
            format!("{}의 특성이 {}을(를) 막았습니다.", active(defender).nickname, mv.name)
        } else {
            format!("{}의 {}: {} 피해.", active(attacker).nickname, mv.name, total_damage)
        });
    } else if move_power > 0 && damage_class != "status" {
        let hits = match (mv.min_hits, mv.max_hits) {
            (Some(min), Some(max)) if min > 0 && max >= min => {
                min + (dice.draw(Roll::Hits, p1, 0) % (max - min + 1) as u64) as i64
            }
            _ => 1,
        };
        for hit in 0..hits {
            if active(defender).hp <= 0 {
                break;
            }
            let a = active(attacker);
            let d = active(defender);
            let mut offense = effective_stat(
                a,
                if damage_class == "special" {
                    "specialAttack"
                } else {
                    "attack"
                },
            );
            if damage_class == "physical" && a.status.as_deref() == Some("burn") {
                offense = (offense / 2).max(1);
            }
            let defense = effective_stat(
                d,
                if damage_class == "special" {
                    "specialDefense"
                } else {
                    "defense"
                },
            );
            let stab = stab_multiplier(a, &move_type);
            let base = (((22 * move_power * offense / defense.max(1)) / 50) + 2) as f64;
            let mut damage = (base * stab * type_mult * low_hp_power(a, &move_type) * tool_power(a, &move_type, &damage_class, type_mult) * 0.925)
                .floor()
                .max(if type_mult > 0.0 { 1.0 } else { 0.0 }) as i64;
            let target = &mut defender.team[defender.active_index];
            if (target.ability.as_deref() == Some("sturdy")
                || (target.held_tool.as_deref() == Some("focus-sash") && !target.held_tool_used))
                && target.hp == target.max_hp
                && damage >= target.hp
            {
                if target.ability.as_deref() != Some("sturdy") { target.held_tool_used = true; }
            damage = (target.hp - 1).max(0);
            }
            if damage >= target.hp
                && target.hp > 0
                && tool(target) == Some("focus-band")
                && dice.percent(Roll::FocusBand, p1, hit as u8) < 10
            {
                damage = target.hp - 1;
                banded = true;
            }
            let dealt = damage.min(target.hp);
            target.hp -= dealt;
            total_damage += dealt;
        }
        battle.events.push(format!(
            "{}의 {}: {} 피해.",
            active(attacker).nickname,
            mv.name,
            total_damage
        ));
    }
    if banded {
        battle.events.push(format!("{}은(는) 기합의머리띠로 버텼습니다.", active(defender).nickname));
    }
    if total_damage > 0 && tool(active(defender)) == Some("air-balloon") {
        let target = &mut defender.team[defender.active_index];
        target.held_tool_used = true;
        battle.events.push(format!("{}의 풍선이 터졌습니다.", target.nickname));
    }
    if total_damage > 0
        && type_mult > 1.0
        && active(defender).hp > 0
        && tool(active(defender)) == Some("weakness-policy")
    {
        let target = &mut defender.team[defender.active_index];
        change_stage(target, "attack", 2);
        change_stage(target, "specialAttack", 2);
        target.held_tool_used = true;
        battle.events.push(format!("{}의 약점보험: 공격과 특수공격이 크게 올랐습니다.", target.nickname));
    }
    if let Some(drain) = mv.drain.filter(|v| *v != 0 && total_damage > 0) {
        let mut amount = ((total_damage * drain.abs()) / 100).max(1);
        let actor = &mut attacker.team[attacker.active_index];
        if drain > 0 {
            if tool(actor) == Some("big-root") {
                amount = amount * 13 / 10;
            }
            actor.hp = (actor.hp + amount).min(actor.max_hp);
        } else {
            actor.hp = (actor.hp - amount).max(0);
        }
    }
    if let Some(healing) = mv.healing.filter(|v| *v > 0) {
        let actor = &mut attacker.team[attacker.active_index];
        let amount = ((actor.max_hp * healing) / 100).max(1);
        actor.hp = (actor.hp + amount).min(actor.max_hp);
        battle
            .events
            .push(format!("{}의 HP가 회복되었습니다.", actor.nickname));
    }
    if total_damage > 0 && tool(active(attacker)) == Some("shell-bell") && active(attacker).hp > 0 {
        let actor = &mut attacker.team[attacker.active_index];
        actor.hp = (actor.hp + (total_damage / 8).max(1)).min(actor.max_hp);
    }
    if total_damage > 0
        && active(attacker).held_tool.as_deref() == Some("life-orb")
        && active(attacker).hp > 0
    {
        let actor = &mut attacker.team[attacker.active_index];
        actor.hp = (actor.hp - (actor.max_hp / 10).max(1)).max(0);
    }
    if total_damage > 0
        && damage_class == "physical"
        && tool(active(defender)) == Some("rocky-helmet")
        && active(attacker).hp > 0
    {
        let actor = &mut attacker.team[attacker.active_index];
        let recoil = (actor.max_hp / 6).max(1).min(actor.hp);
        actor.hp -= recoil;
        battle.events.push(format!("{}은(는) 울퉁불퉁멧으로 {} 피해를 입었습니다.", actor.nickname, recoil));
    }
    if mv.id == 499 && total_damage > 0 {
        let target = &mut defender.team[defender.active_index];
        target.stages.clear();
        battle
            .events
            .push(format!("{}의 능력치 변화가 사라졌습니다.", target.nickname));
    }
    if mv.id == 229 && total_damage > 0 {
        let actor = &mut attacker.team[attacker.active_index];
        if actor.trap_turns.is_some() || actor.seeded {
            actor.trap_turns = None;
            actor.seeded = false;
            battle
                .events
                .push(format!("{}은(는) 속박에서 벗어났습니다.", actor.nickname));
        }
    }
    let stat_chance = mv
        .stat_chance
        .filter(|v| *v > 0)
        .or(if mv.damage_class == "status" {
            Some(100)
        } else {
            mv.effect_chance
        })
        .unwrap_or(100);
    if type_mult > 0.0
        && !mv.stat_changes.is_empty()
        && dice.percent(Roll::StatChance, p1, 0) < stat_chance
    {
        let target = if self_stat_target(mv) {
            &mut attacker.team[attacker.active_index]
        } else {
            &mut defender.team[defender.active_index]
        };
        for change in &mv.stat_changes {
            change_stage(target, &change.stat, change.change);
        }
    }
    let ailment_chance = mv
        .ailment_chance
        .filter(|v| *v > 0)
        .or(if mv.damage_class == "status" {
            Some(100)
        } else {
            mv.effect_chance
        })
        .unwrap_or(0);
    let ailment = move_ailment(mv, dice.draw(Roll::AilmentKind, p1, 0));
    if type_mult > 0.0 && dice.percent(Roll::AilmentChance, p1, 0) < ailment_chance {
        if let Some(ailment) = ailment {
            let target = if self_target(mv) {
                &mut attacker.team[attacker.active_index]
            } else {
                &mut defender.team[defender.active_index]
            };
            inflict(target, ailment, dice, p1, &mut battle.events);
        }
    }
    // Effects this engine does not carry out (Protect, Roar, Yawn...) are said to do nothing.
    if mv.damage_class == "status"
        && type_mult > 0.0
        && mv.stat_changes.is_empty()
        && !mv.healing.is_some_and(|v| v > 0)
        && ailment.is_none()
    {
        battle.events.push(format!("{}: 아무 일도 일어나지 않았습니다.", mv.name));
    }
}
/// The ailment a move inflicts, limited to what this engine carries out: the major statuses,
/// confusion, binding and Leech Seed. Tri Attack's "unknown" is a burn, paralysis or freeze
/// picked by `pick`; the rest (Protect, Ingrain, Yawn, Attract, grounding...) is not kept.
fn move_ailment(mv: &Move, pick: u64) -> Option<&'static str> {
    const KEPT: [&str; 8] = ["sleep", "freeze", "paralysis", "poison", "burn", "confusion", "trap", "leech-seed"];
    if mv.id == TRI_ATTACK {
        return Some(["burn", "paralysis", "freeze"][(pick % 3) as usize]);
    }
    let ailment = mv.ailment.as_deref()?;
    KEPT.into_iter().find(|kept| *kept == ailment)
}
fn inflict(target: &mut Fighter, ailment: &str, dice: &Dice, p1: bool, events: &mut Vec<String>) {
    if target.hp <= 0 {
        return;
    }
    // Two to five turns for confusion and binding, as in the client rules.
    let volatile_turns = || Some(2 + (dice.draw(Roll::Duration, p1, 0) % 4) as i8);
    match ailment {
        "confusion" if target.confusion_turns.is_none() => target.confusion_turns = volatile_turns(),
        "trap" if target.trap_turns.is_none() => target.trap_turns = volatile_turns(),
        "leech-seed" if !target.seeded => target.seeded = true,
        "confusion" | "trap" | "leech-seed" => return,
        _ => {
            let immune = (ailment == "poison"
                && target.types.iter().any(|t| t == "poison" || t == "steel"))
                || (ailment == "burn" && target.types.iter().any(|t| t == "fire"))
                || (ailment == "freeze" && target.types.iter().any(|t| t == "ice"))
                || (ailment == "paralysis" && target.types.iter().any(|t| t == "electric"));
            if target.status.is_some() || immune {
                return;
            }
            target.status = Some(ailment.into());
            target.status_turns = (ailment == "sleep")
                .then(|| 2 + (dice.draw(Roll::Duration, p1, 0) % 3) as i8);
        }
    }
    events.push(format!(
        "{}은(는) {} 상태가 되었습니다.",
        target.nickname, ailment
    ));
}
fn residual(side: &mut Side, events: &mut Vec<String>) {
    if active(side).hp <= 0 {
        return;
    }
    let target = &mut side.team[side.active_index];
    let poisoned = matches!(target.status.as_deref(), Some("poison" | "burn"));
    for hurt in [poisoned, target.seeded, target.trap_turns.is_some()] {
        if hurt && target.hp > 0 {
            let damage = (target.max_hp / 8).max(1);
            target.hp = (target.hp - damage).max(0);
            events.push(format!(
                "{}은(는) 상태 이상으로 {} 피해를 입었습니다.",
                target.nickname, damage
            ));
        }
    }
    // Binding wears off after its turns, like in the client rules.
    if let Some(left) = target.trap_turns {
        target.trap_turns = (left > 1).then(|| left - 1);
    }
    if target.hp > 0 && target.held_tool.as_deref() == Some("leftovers") {
        target.hp = (target.hp + (target.max_hp / 16).max(1)).min(target.max_hp);
    }
    if target.hp > 0 && target.held_tool.as_deref() == Some("black-sludge") {
        if target.types.iter().any(|kind| kind == "poison") {
            target.hp = (target.hp + (target.max_hp / 16).max(1)).min(target.max_hp);
        } else {
            target.hp = (target.hp - (target.max_hp / 8).max(1)).max(0);
            events.push(format!("{}은(는) 검은오물로 피해를 입었습니다.", target.nickname));
        }
    }
    react_held_items(target, events);
}

async fn finalize(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    p1: Uuid,
    p2: Uuid,
    winner: Option<Uuid>,
    reason: &str,
) -> Result<(), ApiError> {
    let league: String =
        sqlx::query("SELECT league FROM ranked_matches WHERE id=$1 AND status='active'")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(not_found)?
            .get("league");
    let league = League::parse(&league)?;
    ensure_rating(tx, p1, league).await?;
    ensure_rating(tx, p2, league).await?;
    let r1: i32 =
        sqlx::query("SELECT rating FROM ranked_ratings WHERE user_id=$1 AND league=$2 FOR UPDATE")
            .bind(p1)
            .bind(league.as_str())
            .fetch_one(&mut **tx)
            .await?
            .get("rating");
    let r2: i32 =
        sqlx::query("SELECT rating FROM ranked_ratings WHERE user_id=$1 AND league=$2 FOR UPDATE")
            .bind(p2)
            .bind(league.as_str())
            .fetch_one(&mut **tx)
            .await?
            .get("rating");
    let (d1, d2) = if let Some(w) = winner {
        let score = if w == p1 { 1.0 } else { 0.0 };
        let expected = 1.0 / (1.0 + 10f64.powf((r2 - r1) as f64 / 400.0));
        let delta = (ELO_K * (score - expected)).round() as i32;
        (delta, -delta)
    } else {
        (0, 0)
    };
    let w1 = (winner == Some(p1)) as i32;
    let w2 = (winner == Some(p2)) as i32;
    let l1 = (winner == Some(p2)) as i32;
    let l2 = (winner == Some(p1)) as i32;
    sqlx::query("UPDATE ranked_ratings SET rating=GREATEST(0,rating+$3),wins=wins+$4,losses=losses+$5 WHERE user_id=$1 AND league=$2").bind(p1).bind(league.as_str()).bind(d1).bind(w1).bind(l1).execute(&mut **tx).await?;
    sqlx::query("UPDATE ranked_ratings SET rating=GREATEST(0,rating+$3),wins=wins+$4,losses=losses+$5 WHERE user_id=$1 AND league=$2").bind(p2).bind(league.as_str()).bind(d2).bind(w2).bind(l2).execute(&mut **tx).await?;
    sqlx::query("UPDATE ranked_matches SET status='completed',winner_id=$2,result_reason=$3,rating_changes=$4,completed_at=now(),updated_at=now() WHERE id=$1 AND status='active'")
        .bind(id).bind(winner).bind(reason).bind(json!({p1.to_string():d1,p2.to_string():d2})).execute(&mut **tx).await?;
    Ok(())
}
async fn finalize_timeout(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    p1: Uuid,
    p2: Uuid,
    actions: Value,
) -> Result<(), ApiError> {
    let map = actions.as_object();
    let a1 = map.is_some_and(|m| m.contains_key(&p1.to_string()));
    let a2 = map.is_some_and(|m| m.contains_key(&p2.to_string()));
    let winner = match (a1, a2) {
        (true, false) => Some(p1),
        (false, true) => Some(p2),
        _ => None,
    };
    finalize(
        tx,
        id,
        p1,
        p2,
        winner,
        if winner.is_some() {
            "timeout"
        } else {
            "mutual-timeout"
        },
    )
    .await
}
async fn expire_for_user(state: &AppState, id: Uuid) -> Result<(), ApiError> {
    let mut tx = state.db.begin().await?;
    if let Some(row)=sqlx::query("SELECT id,player1_id,player2_id,actions FROM ranked_matches WHERE status='active' AND deadline_at<=now() AND (player1_id=$1 OR player2_id=$1) ORDER BY created_at DESC FOR UPDATE LIMIT 1").bind(id).fetch_optional(&mut *tx).await?{finalize_timeout(&mut tx,row.get("id"),row.get("player1_id"),row.get("player2_id"),row.get::<SqlJson<Value>,_>("actions").0).await?;}
    tx.commit().await?;
    Ok(())
}

/// Expired matches must end even when neither player comes back. The router is built before it
/// has the database, so the first ranked request starts the sweep; later calls do nothing.
pub(crate) fn start_sweeper(state: &AppState) {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let db = state.db.clone();
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_secs(SWEEP_SECONDS));
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticks.tick().await;
                if let Err(error) = sweep(&db).await {
                    tracing::warn!(?error, "Ranked sweep failed");
                }
            }
        });
    });
}
/// Finalizes expired active matches through the same timeout rules a participant's request
/// uses, drops queue rows nobody polls, and prunes completed matches after 30 days.
async fn sweep(db: &PgPool) -> Result<(), ApiError> {
    for _ in 0..100 {
        let mut tx = db.begin().await?;
        // A participant's own request may be finalizing a match already; it is skipped, not waited on.
        let Some(row) = sqlx::query("SELECT id,player1_id,player2_id,actions FROM ranked_matches WHERE status='active' AND deadline_at<=now() ORDER BY deadline_at FOR UPDATE SKIP LOCKED LIMIT 1")
            .fetch_optional(&mut *tx)
            .await?
        else {
            break;
        };
        finalize_timeout(&mut tx, row.get("id"), row.get("player1_id"), row.get("player2_id"), row.get::<SqlJson<Value>, _>("actions").0).await?;
        tx.commit().await?;
    }
    drop_unseen_queue(db).await?;
    sqlx::query("DELETE FROM ranked_matches WHERE id IN (SELECT id FROM ranked_matches WHERE status='completed' AND completed_at<now()-interval '30 days' LIMIT 500)")
        .execute(db)
        .await?;
    Ok(())
}

async fn current_match(
    state: &AppState,
    id: Uuid,
    league: League,
) -> Result<Option<Value>, ApiError> {
    let row=sqlx::query("SELECT m.id FROM ranked_matches m LEFT JOIN ranked_ratings r ON r.user_id=$1 AND r.league=m.league WHERE m.league=$2 AND (m.player1_id=$1 OR m.player2_id=$1) AND (m.status='active' OR m.completed_at>=COALESCE(r.last_queued_at,'-infinity'::timestamptz)) ORDER BY (m.status='active') DESC,m.created_at DESC LIMIT 1").bind(id).bind(league.as_str()).fetch_optional(&state.db).await?;
    match row {
        Some(row) => Ok(Some(match_value(state, row.get("id"), id).await?)),
        None => Ok(None),
    }
}
/// The viewer's own side. A pending Mega Evolution is shown as already applied, a stale Choice
/// lock is left out, and the remaining sleep, confusion and binding turns stay on the server.
fn own_side_view(side: &Side) -> Value {
    let mut shown = side.clone();
    apply_pending_transformation(&mut shown);
    shown.pending_transformation = side.pending_transformation.clone();
    for fighter in &mut shown.team {
        fighter.choice_move = choice_lock(fighter);
        fighter.moves = fighter.moves.iter().map(|source| {
            let (move_type, damage_class, power) = effective_move(fighter, source);
            let mut view = source.clone();
            view.move_type = move_type; view.damage_class = damage_class; view.power = power;
            view
        }).collect();
    }
    let mut value = serde_json::to_value(&shown).unwrap_or_default();
    if let Some(team) = value.get_mut("team").and_then(Value::as_array_mut) {
        for fighter in team.iter_mut().filter_map(Value::as_object_mut) {
            for hidden in ["statusTurns", "confusionTurns", "trapTurns"] {
                fighter.remove(hidden);
            }
        }
    }
    value
}
/// What the opponent may see: the trainer and the active Pokémon's form, typing, HP and status.
/// The bench, moves, held items, abilities, IVs and Mega plans stay hidden.
fn opponent_view(side: &Side) -> Value {
    let fighter = active(side);
    json!({"userId":side.user_id,"username":side.username,"activeIndex":0,"team":[{
        "speciesId":fighter.species_id,"nickname":fighter.nickname,"level":fighter.level,"hp":fighter.hp,"maxHp":fighter.max_hp,
        "types":fighter.types,"regionalForm":fighter.regional_form,"status":fighter.status}]})
}

async fn match_value(state: &AppState, id: Uuid, viewer: Uuid) -> Result<Value, ApiError> {
    let row=sqlx::query("SELECT league,state,actions,turn,status,winner_id,result_reason,rating_changes,deadline_at::text deadline_at FROM ranked_matches WHERE id=$1").bind(id).fetch_optional(&state.db).await?.ok_or_else(not_found)?;
    let SqlJson(mut battle): SqlJson<Battle> = row.get("state");
    normalize_battle(&mut battle);
    let (p_self, p_other) = if viewer == battle.player1.user_id {
        (&battle.player1, &battle.player2)
    } else {
        (&battle.player2, &battle.player1)
    };
    let actions = row.get::<SqlJson<Value>, _>("actions").0;
    let submitted = actions
        .as_object()
        .is_some_and(|m| m.contains_key(&viewer.to_string()));
    let status: String = row.get("status");
    Ok(
        json!({"id":id,"league":row.get::<String,_>("league"),"status":status,"turn":row.get::<i32,_>("turn"),"deadlineAt":row.get::<String,_>("deadline_at"),"selfSide":own_side_view(p_self),"opponentSide":opponent_view(p_other),"events":battle.events,"awaitingOpponent":status=="active"&&submitted,"winnerId":row.get::<Option<Uuid>,_>("winner_id"),"resultReason":row.get::<Option<String>,_>("result_reason"),"ratingChange":row.get::<SqlJson<Value>,_>("rating_changes").0.get(viewer.to_string()).cloned().unwrap_or(json!(0))}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{AppState, compress};
    use sha2::{Digest, Sha256};
    use sqlx::PgPool;
    #[test]
    fn normalizes_level_fifty_and_resets_hp() {
        let s = catalog().species.get(&25).unwrap();
        let stats = normalized_stats(
            s,
            &json!({"ivs":{"hp":31,"attack":12,"defense":3,"specialAttack":22,"specialDefense":8,"speed":31}}),
        );
        assert_eq!(stats.hp, 110);
        assert!(stats.speed > stats.defense);
    }
    #[test]
    fn standard_restriction_comes_from_pinned_catalog() {
        assert!(catalog().species.get(&150).unwrap().restricted);
        assert!(!catalog().species.get(&25).unwrap().restricted);
    }
    #[test]
    fn type_and_stab_change_damage() {
        assert_eq!(effectiveness("water", &["fire".into()]), 2.0);
        assert_eq!(effectiveness("normal", &["ghost".into()]), 0.0);
    }
    #[test]
    fn tiers_have_stable_thresholds() {
        assert_eq!(tier(1000), "bronze");
        assert_eq!(tier(1100), "silver");
        assert_eq!(tier(1600), "master");
    }

    fn fighter(species_id: i64, move_id: i64, ability: Option<&str>) -> Fighter {
        let species = catalog().species.get(&species_id).unwrap();
        let stats = normalized_stats(
            species,
            &json!({"ivs":{"hp":31,"attack":31,"defense":31,"specialAttack":31,"specialDefense":31,"speed":31}}),
        );
        Fighter {
            instance_id: format!("mon-{species_id}"),
            species_id,
            nickname: species.name.clone(),
            level: 50,
            hp: stats.hp,
            max_hp: stats.hp,
            stats,
            types: species.types.clone(),
            moves: vec![catalog().moves.get(&move_id).unwrap().clone()],
            ability: ability.map(str::to_owned),
            held_tool: None,
            held_tool_used: false,
            choice_move: None,
            regional_form: None,
            individual_values: None, preferred_transformation: None, transformation_kind: None, tera_type: None, original_types: None,
            status: None,
            status_turns: None,
            confusion_turns: None,
            trap_turns: None,
            seeded: false,
            stages: HashMap::new(),
        }
    }
    const TEST_SEED: &str = "ranked-test-seed";
    fn dice(turn: i32) -> Dice {
        Dice { seed: TEST_SEED.into(), turn }
    }
    fn side(id: u128, name: &str, team: Vec<Fighter>) -> Side {
        Side {
            user_id: Uuid::from_u128(id),
            username: name.into(),
            active_index: 0,
            team, mega_used: false, tera_used: false,
            pending_transformation: None,
        }
    }
    fn battle(left: Fighter, right: Fighter) -> Battle {
        Battle {
            player1: side(1, "one", vec![left]),
            player2: side(2, "two", vec![right]),
            events: vec![],
            seed: Some(TEST_SEED.into()),
        }
    }
    /// A copy of a catalog move that never misses, for tests about what a hit does.
    fn sure_hit(move_id: i64) -> Move {
        let mut mv = catalog().moves[&move_id].clone();
        mv.accuracy = 0;
        mv
    }

    #[test]
    fn ranked_snapshot_uses_alola_profile_and_held_tool() {
        let save = json!({"game":{"player":{"team":[{
            "instanceId":"mon-19","speciesId":19,"nickname":"Alola Rattata","regionalForm":"rattata-alola","heldTool":"choice-scarf",
            "ivs":{"hp":31,"attack":31,"defense":31,"specialAttack":31,"specialDefense":31,"speed":31},"moves":[{"moveId":33}]
        }]}}});
        let side = snapshot(&save, Uuid::nil(), "ranked".into(), League::Open).unwrap();
        let fighter = &side.team[0];
        assert_eq!(fighter.types, vec!["dark", "normal"]);
        assert_eq!(fighter.stats.hp, 105);
        assert_eq!(fighter.stats.speed, 92);
        assert_eq!(effective_stat(fighter, "speed"), 138);
        assert_eq!(fighter.held_tool.as_deref(), Some("choice-scarf"));
    }

    #[test]
    fn ranked_snapshot_carries_preferred_transformation() {
        let save = json!({"game":{"player":{"team":[{
            "instanceId":"mon-6","speciesId":6,"nickname":"Charizard",
            "heldTool":"mega-stone:charizard-mega-x",
            "ivs":{"hp":31,"attack":31,"defense":31,"specialAttack":31,"specialDefense":31,"speed":31},
            "moves":[{"moveId":53}],
            "preferredTransformation":{"kind":"mega","formIdentifier":"charizard-mega-x"}
        }]}}});
        let side = snapshot(&save, Uuid::nil(), "ranked".into(), League::Open).unwrap();
        let preferred = side.team[0].preferred_transformation.as_ref().unwrap();
        assert_eq!(preferred.kind, "mega");
        assert_eq!(preferred.form_identifier.as_deref(), Some("charizard-mega-x"));
        assert_eq!(side.team[0].held_tool.as_deref(), Some("mega-stone:charizard-mega-x"));

        let loaded: Side = serde_json::from_value(serde_json::to_value(side).unwrap()).unwrap();
        assert_eq!(
            loaded.team[0]
                .preferred_transformation
                .as_ref()
                .and_then(|request| request.form_identifier.as_deref()),
            Some("charizard-mega-x")
        );
    }

    #[test]
    fn ranked_held_tools_apply_damage_survival_recoil_and_recovery() {
        let mut band = fighter(25, 33, None);
        let base_attack = effective_stat(&band, "attack");
        band.held_tool = Some("choice-band".into());
        assert_eq!(
            effective_stat(&band, "attack"),
            (base_attack as f64 * 1.5).floor() as i64
        );

        let mut sash_battle = battle(fighter(150, 63, None), fighter(10, 33, None));
        sash_battle.player2.team[0].held_tool = Some("focus-sash".into());
        attack(&dice(1), &mut sash_battle, true, &sure_hit(63));
        assert_eq!(active(&sash_battle.player2).hp, 1);

        let mut orb_battle = battle(fighter(25, 33, None), fighter(10, 33, None));
        orb_battle.player1.team[0].held_tool = Some("life-orb".into());
        let before = active(&orb_battle.player1).hp;
        attack(&dice(1), &mut orb_battle, true, &catalog().moves[&33]);
        assert_eq!(
            active(&orb_battle.player1).hp,
            before - (active(&orb_battle.player1).max_hp / 10).max(1)
        );

        let mut leftovers = fighter(25, 33, None);
        leftovers.held_tool = Some("leftovers".into());
        leftovers.hp -= 20;
        let expected = leftovers.hp + (leftovers.max_hp / 16).max(1);
        let mut side = battle(leftovers, fighter(10, 33, None)).player1;
        residual(&mut side, &mut vec![]);
        assert_eq!(active(&side).hp, expected);
    }

    fn move_action(index: usize) -> TurnAction {
        TurnAction { turn: 1, move_index: Some(index), switch_index: None, surrender: false, transformation: None }
    }

    #[test]
    fn ranked_expanded_tools_change_damage_and_defenses() {
        let dealt = |tool: Option<&str>, move_id: i64, defender: i64| {
            let mut game = battle(fighter(4, move_id, None), fighter(defender, 33, None));
            game.player1.team[0].held_tool = tool.map(str::to_owned);
            let before = active(&game.player2).hp;
            attack(&dice(1), &mut game, true, &catalog().moves[&move_id]);
            before - active(&game.player2).hp
        };
        let ember = dealt(None, 52, 143);
        assert!(dealt(Some("charcoal"), 52, 143) > ember);
        assert_eq!(dealt(Some("mystic-water"), 52, 143), ember);
        assert!(dealt(Some("wise-glasses"), 52, 143) > ember);
        assert_eq!(dealt(Some("muscle-band"), 52, 143), ember);
        assert!(dealt(Some("muscle-band"), 33, 143) > dealt(None, 33, 143));
        assert!(dealt(Some("expert-belt"), 52, 1) > dealt(None, 52, 1));
        assert_eq!(dealt(Some("expert-belt"), 52, 143), ember);

        let mut eevee = fighter(133, 33, None);
        let (defense, special) = (effective_stat(&eevee, "defense"), effective_stat(&eevee, "specialDefense"));
        eevee.held_tool = Some("eviolite".into());
        assert_eq!(effective_stat(&eevee, "defense"), (defense as f64 * 1.5).floor() as i64);
        assert_eq!(effective_stat(&eevee, "specialDefense"), (special as f64 * 1.5).floor() as i64);
        let mut snorlax = fighter(143, 33, None);
        let base = effective_stat(&snorlax, "specialDefense");
        snorlax.held_tool = Some("eviolite".into());
        assert_eq!(effective_stat(&snorlax, "specialDefense"), base);
        snorlax.held_tool = Some("assault-vest".into());
        assert_eq!(effective_stat(&snorlax, "specialDefense"), (base as f64 * 1.5).floor() as i64);

        let mut vest = battle(fighter(143, 45, None), fighter(25, 33, None));
        vest.player1.team[0].held_tool = Some("assault-vest".into());
        attack(&dice(1), &mut vest, true, &catalog().moves[&45]);
        assert!(active(&vest.player2).stages.get("attack").is_none_or(|stage| *stage == 0));
        assert!(vest.events.iter().any(|event| event.contains("돌격조끼")));
    }

    #[test]
    fn ranked_consumable_tools_trigger_once_and_survive_serialization() {
        let mut balloon = battle(fighter(143, 89, None), fighter(143, 33, None));
        balloon.player2.team[0].held_tool = Some("air-balloon".into());
        let full = active(&balloon.player2).hp;
        attack(&dice(1), &mut balloon, true, &catalog().moves[&89]);
        assert_eq!(active(&balloon.player2).hp, full);
        attack(&dice(2), &mut balloon, true, &catalog().moves[&33]);
        assert!(active(&balloon.player2).held_tool_used);
        let mut loaded: Battle = serde_json::from_value(serde_json::to_value(&balloon).unwrap()).unwrap();
        let popped = active(&loaded.player2).hp;
        attack(&dice(3), &mut loaded, true, &catalog().moves[&89]);
        assert!(active(&loaded.player2).hp < popped);

        let mut policy = battle(fighter(7, 55, None), fighter(248, 33, None));
        policy.player2.team[0].held_tool = Some("weakness-policy".into());
        attack(&dice(1), &mut policy, true, &catalog().moves[&55]);
        assert_eq!(active(&policy.player2).stages.get("attack"), Some(&2));
        assert_eq!(active(&policy.player2).stages.get("specialAttack"), Some(&2));
        attack(&dice(2), &mut policy, true, &catalog().moves[&55]);
        assert_eq!(active(&policy.player2).stages.get("attack"), Some(&2));

        let mut sitrus = fighter(143, 33, None);
        sitrus.held_tool = Some("sitrus-berry".into());
        sitrus.hp = sitrus.max_hp / 2 - 1;
        let expected = sitrus.hp + sitrus.max_hp / 4;
        let mut side = battle(sitrus, fighter(10, 33, None)).player1;
        residual(&mut side, &mut vec![]);
        assert_eq!(active(&side).hp, expected);
        side.team[0].hp = 5;
        residual(&mut side, &mut vec![]);
        assert_eq!(active(&side).hp, 5);

        let mut lum = fighter(143, 33, None);
        lum.held_tool = Some("lum-berry".into());
        lum.status = Some("paralysis".into());
        react_held_items(&mut lum, &mut vec![]);
        assert!(lum.status.is_none() && lum.held_tool_used);
        lum.status = Some("burn".into());
        react_held_items(&mut lum, &mut vec![]);
        assert_eq!(lum.status.as_deref(), Some("burn"));

        let mut herb = fighter(143, 33, None);
        herb.held_tool = Some("white-herb".into());
        herb.stages.insert("attack".into(), -2);
        herb.stages.insert("speed".into(), 1);
        react_held_items(&mut herb, &mut vec![]);
        assert_eq!(herb.stages.get("attack"), Some(&0));
        assert_eq!(herb.stages.get("speed"), Some(&1));
        assert!(herb.held_tool_used);
    }

    #[test]
    fn ranked_recovery_recoil_and_chance_tools_match_client_rules() {
        let mut grimer = fighter(88, 33, None);
        grimer.held_tool = Some("black-sludge".into());
        grimer.hp -= 30;
        let expected = grimer.hp + (grimer.max_hp / 16).max(1);
        let mut side = battle(grimer, fighter(10, 33, None)).player1;
        residual(&mut side, &mut vec![]);
        assert_eq!(active(&side).hp, expected);
        let mut other = fighter(143, 33, None);
        other.held_tool = Some("black-sludge".into());
        let expected = other.hp - (other.max_hp / 8).max(1);
        let mut side = battle(other, fighter(10, 33, None)).player1;
        residual(&mut side, &mut vec![]);
        assert_eq!(active(&side).hp, expected);

        let mut helmet = battle(fighter(143, 33, None), fighter(143, 33, None));
        helmet.player2.team[0].held_tool = Some("rocky-helmet".into());
        let max = active(&helmet.player1).max_hp;
        attack(&dice(1), &mut helmet, true, &catalog().moves[&33]);
        assert_eq!(active(&helmet.player1).hp, max - max / 6);
        let mut special = battle(fighter(4, 52, None), fighter(143, 33, None));
        special.player2.team[0].held_tool = Some("rocky-helmet".into());
        attack(&dice(1), &mut special, true, &catalog().moves[&52]);
        assert_eq!(active(&special.player1).hp, active(&special.player1).max_hp);

        let mut bell = battle(fighter(4, 52, None), fighter(143, 33, None));
        bell.player1.team[0].held_tool = Some("shell-bell".into());
        bell.player1.team[0].hp = 10;
        let before = active(&bell.player2).hp;
        attack(&dice(1), &mut bell, true, &catalog().moves[&52]);
        assert_eq!(active(&bell.player1).hp, 10 + ((before - active(&bell.player2).hp) / 8).max(1));

        let mut quick_first = 0;
        let mut band_saves = 0;
        for turn in 1..=200 {
            let mut game = battle(fighter(79, 33, None), fighter(101, 33, None));
            game.player1.team[0].held_tool = Some("quick-claw".into());
            resolve_turn(Uuid::nil(), turn, &mut game, move_action(0), move_action(0)).unwrap();
            let first_hit = game.events.iter().find(|event| event.contains("피해")).unwrap();
            if first_hit.starts_with(&active(&game.player1).nickname) {
                quick_first += 1;
            }
            let mut band = battle(fighter(150, 94, None), fighter(1, 33, None));
            band.player2.team[0].held_tool = Some("focus-band".into());
            attack(&dice(turn), &mut band, true, &catalog().moves[&94]);
            if active(&band.player2).hp == 1 {
                band_saves += 1;
            }
        }
        assert!((20..70).contains(&quick_first), "{quick_first}");
        assert!((5..40).contains(&band_saves), "{band_saves}");
    }

    #[test]
    fn mega_persists_and_removed_tera_is_rejected() {
        let mut side = battle(fighter(6, 53, None), fighter(7, 55, None)).player1;
        side.team[0].held_tool = Some("mega-stone:charizard-mega-x".into());
        side.team.push(fighter(25, 85, None));
        let attack_before = active(&side).stats.attack;
        let mega = TransformationRequest { kind: "mega".into(), form_identifier: Some("charizard-mega-x".into()), tera_type: None };
        apply_transformation(&mut side, &mega).unwrap();
        assert_eq!(active(&side).types, vec!["fire", "dragon"]);
        assert_eq!(active(&side).ability.as_deref(), Some("tough-claws"));
        assert!(active(&side).stats.attack > attack_before);
        let mut loaded: Side = serde_json::from_value(serde_json::to_value(side).unwrap()).unwrap();
        assert!(apply_transformation(&mut loaded, &mega).is_err());
        apply_switch(&mut loaded, 1).unwrap();
        assert!(apply_transformation(&mut loaded, &TransformationRequest { kind: "tera".into(), form_identifier: None, tera_type: Some("electric".into()) }).is_err());
        assert_eq!(stab_multiplier(active(&loaded), "electric"), 1.5);
        assert!(loaded.mega_used && !loaded.tera_used);
        let mut other = battle(fighter(6, 53, None), fighter(7, 55, None)).player1;
        assert!(apply_transformation(&mut other, &TransformationRequest { kind: "tera".into(), form_identifier: None, tera_type: Some("water".into()) }).is_err());
        assert_eq!(stab_multiplier(active(&other), "fire"), 1.5);
        assert_eq!(stab_multiplier(active(&other), "water"), 1.0);
        assert_eq!(active(&other).types, vec!["fire", "flying"]);
    }

    #[test]
    fn mega_requires_the_exact_held_stone() {
        let mega = TransformationRequest { kind: "mega".into(), form_identifier: Some("charizard-mega-x".into()), tera_type: None };
        for held_tool in [None, Some("mega-stone:charizard-mega-y"), Some("life-orb")] {
            let mut side = battle(fighter(6, 53, None), fighter(7, 55, None)).player1;
            side.team[0].held_tool = held_tool.map(str::to_owned);
            let before = serde_json::to_value(&side).unwrap();
            assert!(apply_transformation(&mut side, &mega).is_err());
            assert_eq!(serde_json::to_value(side).unwrap(), before);
        }

        let mut automatic = battle(fighter(6, 53, None), fighter(7, 55, None)).player1;
        automatic.team[0].preferred_transformation = Some(mega);
        apply_preferred_transformation(&mut automatic);
        assert_eq!(automatic.team[0].transformation_kind, None);
        assert!(!automatic.mega_used);
    }

    #[test]
    fn preferred_transformations_apply_on_entry_and_respect_side_limits_after_switches() {
        let mega = TransformationRequest { kind: "mega".into(), form_identifier: Some("charizard-mega-x".into()), tera_type: None };
        let tera = TransformationRequest { kind: "tera".into(), form_identifier: None, tera_type: Some("electric".into()) };

        let mut lead = fighter(6, 53, None);
        lead.held_tool = Some("mega-stone:charizard-mega-x".into());
        lead.preferred_transformation = Some(mega.clone());
        let mut reserve = fighter(6, 53, None);
        reserve.instance_id = "mon-6-reserve".into();
        reserve.held_tool = Some("mega-stone:charizard-mega-x".into());
        reserve.preferred_transformation = Some(mega);
        let mut tera_lead = fighter(25, 85, None);
        tera_lead.preferred_transformation = Some(tera.clone());
        let game = initial_battle(
            side(1, "one", vec![lead, reserve]),
            side(2, "two", vec![tera_lead]),
        );

        assert_eq!(active(&game.player1).transformation_kind.as_deref(), Some("mega"));
        assert_eq!(active(&game.player2).transformation_kind, None);
        assert!(game.player1.mega_used && !game.player2.tera_used);

        let mut loaded: Battle = serde_json::from_value(serde_json::to_value(game).unwrap()).unwrap();
        apply_switch(&mut loaded.player1, 1).unwrap();
        assert_eq!(active(&loaded.player1).transformation_kind, None);
        assert_eq!(active(&loaded.player1).regional_form, None);

        loaded.player1.team[1].hp = 0;
        loaded.player1.team[0].hp = loaded.player1.team[0].max_hp;
        auto_switch(&mut loaded.player1);
        assert_eq!(loaded.player1.active_index, 0);
        assert_eq!(active(&loaded.player1).transformation_kind.as_deref(), Some("mega"));
    }

    #[test]
    fn legacy_tera_preferences_are_removed_after_manual_and_faint_switches() {
        let tera = TransformationRequest { kind: "tera".into(), form_identifier: None, tera_type: Some("water".into()) };
        let lead = fighter(25, 85, None);
        let mut manual_reserve = fighter(7, 55, None);
        manual_reserve.preferred_transformation = Some(tera.clone());
        let mut manual_side = side(0, "one", vec![lead, manual_reserve]);
        apply_switch(&mut manual_side, 1).unwrap();
        assert_eq!(active(&manual_side).tera_type, None);

        let mut faint_side = side(0, "two", vec![fighter(25, 85, None), fighter(7, 55, None)]);
        faint_side.team[0].hp = 0;
        faint_side.team[1].preferred_transformation = Some(tera);
        auto_switch(&mut faint_side);
        assert_eq!(faint_side.active_index, 1);
        assert_eq!(active(&faint_side).tera_type, None);
        assert!(!faint_side.tera_used);
    }

    #[test]
    fn restores_legacy_tera_types_without_refilling_hp_or_changing_moves() {
        let mut side = battle(fighter(26, 85, None), fighter(7, 55, None)).player1;
        side.team[0].types = vec!["water".into()];
        side.team[0].original_types = Some(vec!["electric".into(), "psychic".into()]);
        side.team[0].transformation_kind = Some("tera".into());
        side.team[0].tera_type = Some("water".into());
        side.team[0].hp = 5; let move_id = side.team[0].moves[0].id;
        remove_legacy_tera(&mut side);
        assert_eq!(side.team[0].types, vec!["electric", "psychic"]);
        assert_eq!(side.team[0].hp, 5); assert_eq!(side.team[0].moves[0].id, move_id);
        assert_eq!(side.team[0].transformation_kind, None);
        assert_eq!(stab_multiplier(&side.team[0], "electric"), 1.5);
    }

    #[test]
    fn mega_without_3d_model_is_unusable() {
        let mut side = battle(fighter(36, 33, None), fighter(7, 55, None)).player1;
        let before = serde_json::to_value(&side).unwrap();
        let request = TransformationRequest { kind: "mega".into(), form_identifier: Some("clefable-mega".into()), tera_type: None };
        assert!(apply_transformation(&mut side, &request).is_err());
        assert_eq!(serde_json::to_value(side).unwrap(), before);
    }

    #[test]
    fn choice_lock_and_sash_consumption_survive_serialization() {
        let mut game = battle(fighter(150, 94, None), fighter(10, 33, None));
        game.player1.team[0].held_tool = Some("choice-specs".into());
        game.player1.team[0].moves.push(catalog().moves[&33].clone());
        game.player1.team.push(fighter(7, 33, None));
        game.player2.team[0].held_tool = Some("focus-sash".into());
        attack(&dice(1), &mut game, true, &catalog().moves[&94]);
        assert_eq!(active(&game.player2).hp, 1);
        let mut loaded: Battle = serde_json::from_value(serde_json::to_value(game).unwrap()).unwrap();
        assert!(active(&loaded.player2).held_tool_used);
        assert!(selected_move(&loaded.player1, 1).is_err());
        loaded.player2.team[0].hp = loaded.player2.team[0].max_hp;
        attack(&dice(2), &mut loaded, true, &catalog().moves[&94]);
        assert_eq!(active(&loaded.player2).hp, 0);
        apply_switch(&mut loaded.player1, 1).unwrap();
        apply_switch(&mut loaded.player1, 0).unwrap();
        assert!(selected_move(&loaded.player1, 1).is_ok());
    }

    #[test]
    fn status_healing_stages_and_residual_are_effective() {
        let mut poisoned = battle(fighter(25, 672, None), fighter(6, 53, None));
        attack(&dice(1), &mut poisoned, true, &catalog().moves[&672]);
        assert_eq!(active(&poisoned.player2).status.as_deref(), Some("poison"));
        let hp = active(&poisoned.player2).hp;
        residual(&mut poisoned.player2, &mut poisoned.events);
        assert!(active(&poisoned.player2).hp < hp);
        let mut boosted = battle(fighter(25, 14, None), fighter(6, 53, None));
        attack(&dice(1), &mut boosted, true, &catalog().moves[&14]);
        assert_eq!(active(&boosted.player1).stages["attack"], 2);
        boosted.player1.team[0].hp = 1;
        boosted.player1.team[0].moves[0] = catalog().moves[&105].clone();
        attack(&dice(2), &mut boosted, true, &catalog().moves[&105]);
        assert!(active(&boosted.player1).hp > 1);
    }

    #[test]
    fn implemented_abilities_affect_server_damage() {
        let mut immune = battle(fighter(112, 89, None), fighter(479, 85, Some("levitate")));
        let hp = active(&immune.player2).hp;
        attack(&dice(1), &mut immune, true, &catalog().moves[&89]);
        assert_eq!(active(&immune.player2).hp, hp);
        let mut sturdy = battle(fighter(150, 63, None), fighter(213, 89, Some("sturdy")));
        sturdy.player2.team[0].hp = 1;
        sturdy.player2.team[0].max_hp = 1;
        attack(&dice(1), &mut sturdy, true, &catalog().moves[&63]);
        assert_eq!(active(&sturdy.player2).hp, 1);
    }

    #[test]
    fn fixed_damage_respects_immunity_sturdy_and_current_hp() {
        for (move_id, target_species, expected) in
            [(69, 143, 50), (101, 25, 50), (69, 94, 0), (101, 143, 0)]
        {
            let mut b = battle(
                fighter(68, move_id, None),
                fighter(target_species, 33, None),
            );
            let before = active(&b.player2).hp;
            attack(&dice(1), &mut b, true, &catalog().moves[&move_id]);
            assert_eq!(before - active(&b.player2).hp, expected);
        }
        let mut b = battle(fighter(20, 162, None), fighter(143, 33, None));
        b.player2.team[0].hp = 55;
        attack(&dice(1), &mut b, true, &sure_hit(162));
        assert_eq!(active(&b.player2).hp, 28);
        b.player2.team[0].hp = 30;
        b.player2.team[0].max_hp = 30;
        b.player2.team[0].ability = Some("sturdy".into());
        attack(&dice(1), &mut b, true, &catalog().moves[&69]);
        assert_eq!(active(&b.player2).hp, 1);
    }

    #[test]
    fn rest_heals_then_blocks_two_actions_even_after_serialization() {
        let mut b = battle(fighter(143, 156, None), fighter(197, 33, None));
        b.player1.team[0].hp = 10;
        b.player1.team[0].status = Some("poison".into());
        attack(&dice(1), &mut b, true, &catalog().moves[&156]);
        assert_eq!(active(&b.player1).hp, active(&b.player1).max_hp);
        assert_eq!(active(&b.player1).status.as_deref(), Some("sleep"));
        let mut b: Battle = serde_json::from_value(serde_json::to_value(b).unwrap()).unwrap();
        for turn in 2..=3 {
            assert!(!can_act(&dice(turn), true, &mut b.player1, &mut b.events));
        }
        assert!(can_act(&dice(4), true, &mut b.player1, &mut b.events));
        assert!(active(&b.player1).status.is_none());
        attack(&dice(5), &mut b, true, &catalog().moves[&156]);
        assert!(active(&b.player1).status.is_none()); // full HP fails
        b.player1.team[0].hp = 10;
        b.player1.team[0].ability = Some("insomnia".into());
        attack(&dice(6), &mut b, true, &catalog().moves[&156]);
        assert_eq!(active(&b.player1).hp, 10);
        assert!(active(&b.player1).status.is_none());
    }

    #[test]
    fn team_cures_do_not_cure_foes_binding_or_soundproof_teammates() {
        for move_id in [215, 312] {
            let mut b = battle(
                fighter(143, move_id, None),
                fighter(197, 33, Some("sap-sipper")),
            );
            b.player1.team[0].status = Some("burn".into());
            b.player1.team[0].trap_turns = Some(3);
            let mut reserve = fighter(100, 33, Some("soundproof"));
            reserve.status = Some("sleep".into());
            reserve.status_turns = Some(3);
            b.player1.team.push(reserve);
            b.player2.team[0].status = Some("poison".into());
            attack(&dice(1), &mut b, true, &catalog().moves[&move_id]);
            assert!(active(&b.player1).status.is_none());
            assert_eq!(
                b.player1.team[1].status.as_deref(),
                if move_id == 215 { Some("sleep") } else { None }
            );
            assert_eq!(active(&b.player1).trap_turns, Some(3));
            assert_eq!(active(&b.player2).status.as_deref(), Some("poison"));
        }
    }

    #[test]
    fn haze_and_clear_smog_reset_the_correct_stages() {
        let mut b = battle(fighter(143, 114, None), fighter(143, 33, None));
        b.player1.team[0].stages.insert("attack".into(), 2);
        b.player2.team[0].stages.insert("defense".into(), -3);
        attack(&dice(1), &mut b, true, &catalog().moves[&114]);
        assert!(active(&b.player1).stages.is_empty());
        assert!(active(&b.player2).stages.is_empty());
        for species in [143, 208] {
            let mut b = battle(fighter(143, 499, None), fighter(species, 33, None));
            b.player2.team[0].stages.insert("attack".into(), 4);
            attack(&dice(1), &mut b, true, &catalog().moves[&499]);
            assert_eq!(active(&b.player2).stages.is_empty(), species != 208);
        }
    }

    #[test]
    fn rapid_spin_effects_need_a_hit_and_switching_clears_stages() {
        for species in [143, 94] {
            let mut b = battle(fighter(143, 229, None), fighter(species, 33, None));
            b.player1.team[0].seeded = true;
            b.player1.team[0].trap_turns = Some(4);
            attack(&dice(1), &mut b, true, &catalog().moves[&229]);
            assert_eq!(
                active(&b.player1).stages.get("speed"),
                if species == 94 { None } else { Some(&1) }
            );
            assert!(active(&b.player2).stages.is_empty());
            let freed = !active(&b.player1).seeded && active(&b.player1).trap_turns.is_none();
            assert_eq!(freed, species != 94);
            b.player1.team.push(fighter(7, 33, None));
            apply_switch(&mut b.player1, 1).unwrap();
            apply_switch(&mut b.player1, 0).unwrap();
            assert!(active(&b.player1).stages.is_empty());
        }
    }

    #[test]
    fn status_moves_ignore_damage_type_chart_but_immune_hits_do_not_debuff() {
        let mut b = battle(fighter(143, 14, None), fighter(94, 33, None));
        attack(&dice(1), &mut b, true, &catalog().moves[&14]);
        assert_eq!(active(&b.player1).stages["attack"], 2);
        attack(&dice(1), &mut b, true, &catalog().moves[&39]);
        assert_eq!(active(&b.player2).stages["defense"], -1);
        b.player2.team[0] = fighter(208, 33, None);
        attack(&dice(1), &mut b, true, &catalog().moves[&491]); // Acid Spray vs Steel
        assert!(active(&b.player2).stages.is_empty());
    }

    fn switch_action(index: usize) -> TurnAction {
        TurnAction { turn: 1, move_index: None, switch_index: Some(index), surrender: false, transformation: None }
    }

    #[test]
    fn rolls_come_from_a_secret_seed_and_are_independent() {
        let seed = new_seed();
        assert_eq!(seed.len(), 64);
        assert_ne!(seed, new_seed());
        assert_eq!(legacy_seed(Uuid::from_u128(7)), legacy_seed(Uuid::from_u128(7)));
        assert_ne!(legacy_seed(Uuid::from_u128(7)), legacy_seed(Uuid::from_u128(8)));
        assert_eq!(dice(3).draw(Roll::Accuracy, true, 0), dice(3).draw(Roll::Accuracy, true, 0));
        let other = Dice { seed: "another-match".into(), turn: 3 };
        assert!((0..8).any(|index| other.draw(Roll::Hits, true, index) != dice(3).draw(Roll::Hits, true, index)));
        // Two 80% moves in one turn no longer share a result, and speed ties ignore turn parity.
        let (mut split, mut parity) = (0, 0);
        for turn in 1..=400 {
            let dice = dice(turn);
            split += ((dice.percent(Roll::Accuracy, true, 0) < 80) != (dice.percent(Roll::Accuracy, false, 0) < 80)) as i32;
            parity += ((dice.draw(Roll::SpeedTie, true, 0) % 2 == 0) == (turn % 2 == 0)) as i32;
        }
        assert!((80..=180).contains(&split), "{split}");
        assert!((150..=250).contains(&parity), "{parity}");
    }

    #[test]
    fn legacy_matches_get_a_secret_seed_on_their_next_turn() {
        let mut game = battle(fighter(143, 33, None), fighter(143, 33, None));
        game.seed = None;
        let mut game: Battle = serde_json::from_value(serde_json::to_value(game).unwrap()).unwrap();
        assert!(game.seed.is_none());
        let id = Uuid::from_u128(99);
        resolve_turn(id, 1, &mut game, move_action(0), move_action(0)).unwrap();
        assert_eq!(game.seed, Some(legacy_seed(id)));
        let stored: Battle = serde_json::from_value(serde_json::to_value(&game).unwrap()).unwrap();
        assert_eq!(stored.seed, game.seed);
    }

    #[test]
    fn views_hide_the_seed_hidden_turns_and_the_opponents_details() {
        let mut game = initial_battle(
            side(1, "one", vec![fighter(6, 53, None), fighter(25, 85, None)]),
            side(2, "two", vec![fighter(143, 33, None)]),
        );
        let seed = game.seed.clone().unwrap();
        assert!(serde_json::to_string(&game).unwrap().contains(&seed));
        let lead = &mut game.player1.team[0];
        lead.held_tool = Some("choice-scarf".into());
        lead.status = Some("sleep".into());
        lead.status_turns = Some(3);
        lead.confusion_turns = Some(4);
        let own = own_side_view(&game.player1);
        let opponent = opponent_view(&game.player1);
        assert!(!own.to_string().contains(&seed) && !opponent.to_string().contains(&seed));
        assert_eq!(own["team"].as_array().unwrap().len(), 2);
        assert_eq!(own["team"][0]["heldTool"], "choice-scarf");
        assert!(own["team"][0].get("statusTurns").is_none() && own["team"][0].get("confusionTurns").is_none());
        assert_eq!((&opponent["userId"], &opponent["username"], &opponent["activeIndex"]), (&json!(Uuid::from_u128(1)), &json!("one"), &json!(0)));
        assert_eq!(opponent["team"].as_array().unwrap().len(), 1);
        let shown = opponent["team"][0].as_object().unwrap();
        let mut fields: Vec<&str> = shown.keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(fields, ["hp", "level", "maxHp", "nickname", "regionalForm", "speciesId", "status", "types"]);
        assert_eq!((&shown["speciesId"], &shown["status"]), (&json!(6), &json!("sleep")));
    }

    #[test]
    fn mega_evolution_waits_for_the_turn_and_lapses_on_a_switch() {
        let mut lead = fighter(6, 53, None);
        lead.held_tool = Some("mega-stone:charizard-mega-x".into());
        let mut game = battle(lead, fighter(143, 33, None));
        game.player1.team.push(fighter(25, 85, None));
        let mega = TransformationRequest { kind: "mega".into(), form_identifier: Some("charizard-mega-x".into()), tera_type: None };
        request_transformation(&mut game.player1, &mega).unwrap();
        let game: Battle = serde_json::from_value(serde_json::to_value(game).unwrap()).unwrap();
        assert!(active(&game.player1).transformation_kind.is_none() && !game.player1.mega_used);
        assert_eq!(opponent_view(&game.player1)["team"][0]["types"], json!(["fire", "flying"]));
        let own = own_side_view(&game.player1);
        assert_eq!((&own["team"][0]["transformationKind"], &own["megaUsed"]), (&json!("mega"), &json!(true)));
        assert_eq!(own["team"][0]["types"], json!(["fire", "dragon"]));
        assert_eq!(own["pendingTransformation"]["index"], 0);
        assert!(request_transformation(&mut game.clone().player1, &mega).is_err());

        let mut resolved = game.clone();
        resolve_turn(Uuid::nil(), 1, &mut resolved, move_action(0), move_action(0)).unwrap();
        assert_eq!(active(&resolved.player1).transformation_kind.as_deref(), Some("mega"));
        assert!(resolved.player1.mega_used && resolved.player1.pending_transformation.is_none());

        let mut switched = game.clone();
        resolve_turn(Uuid::nil(), 1, &mut switched, switch_action(1), move_action(0)).unwrap();
        assert!(switched.player1.team[0].transformation_kind.is_none());
        assert!(!switched.player1.mega_used && switched.player1.pending_transformation.is_none());
    }

    #[test]
    fn confusion_and_binding_wear_off_and_end_on_switching() {
        let mut game = battle(fighter(94, 109, None), fighter(143, 33, None));
        game.player2.team[0].status = Some("paralysis".into());
        attack(&dice(1), &mut game, true, &catalog().moves[&109]);
        let turns = active(&game.player2).confusion_turns.expect("confused");
        assert!((2..=5).contains(&turns));
        assert_eq!(active(&game.player2).status.as_deref(), Some("paralysis"));
        let mut wave = battle(fighter(25, 86, None), fighter(143, 33, None));
        wave.player2.team[0].confusion_turns = Some(3);
        attack(&dice(1), &mut wave, true, &sure_hit(86));
        assert_eq!(active(&wave.player2).status.as_deref(), Some("paralysis"));

        let mut confused = side(1, "one", vec![fighter(143, 33, None)]);
        confused.team[0].confusion_turns = Some(5);
        for turn in 1..=5 {
            can_act(&dice(turn), true, &mut confused, &mut vec![]);
        }
        assert!(confused.team[0].confusion_turns.is_none());
        let mut self_hits = 0;
        for turn in 1..=300 {
            let mut confused = side(1, "one", vec![fighter(143, 33, None)]);
            confused.team[0].confusion_turns = Some(3);
            let (hp, max_hp) = (confused.team[0].hp, confused.team[0].max_hp);
            if !can_act(&dice(turn), true, &mut confused, &mut vec![]) {
                self_hits += 1;
                assert_eq!(confused.team[0].hp, hp - max_hp / 8);
            }
        }
        assert!((60..=140).contains(&self_hits), "{self_hits}");

        let mut bind = battle(fighter(143, 20, None), fighter(143, 33, None));
        attack(&dice(1), &mut bind, true, &sure_hit(20));
        let turns = active(&bind.player2).trap_turns.expect("bound");
        assert!((2..=5).contains(&turns) && active(&bind.player2).status.is_none());
        let mut ticks = 0;
        while active(&bind.player2).trap_turns.is_some() && ticks <= 5 {
            let hp = active(&bind.player2).hp;
            residual(&mut bind.player2, &mut vec![]);
            assert_eq!(active(&bind.player2).hp, hp - active(&bind.player2).max_hp / 8);
            ticks += 1;
        }
        assert_eq!(ticks, turns);
        let hp = active(&bind.player2).hp;
        residual(&mut bind.player2, &mut vec![]);
        assert_eq!(active(&bind.player2).hp, hp);

        let mut volatile = battle(fighter(143, 33, None), fighter(143, 33, None));
        volatile.player1.team.push(fighter(25, 85, None));
        let lead = &mut volatile.player1.team[0];
        (lead.confusion_turns, lead.trap_turns, lead.seeded) = (Some(3), Some(3), true);
        apply_switch(&mut volatile.player1, 1).unwrap();
        let benched = &volatile.player1.team[0];
        assert!(benched.confusion_turns.is_none() && benched.trap_turns.is_none() && !benched.seeded);

        let mut lum = fighter(143, 33, None);
        lum.held_tool = Some("lum-berry".into());
        lum.confusion_turns = Some(3);
        react_held_items(&mut lum, &mut vec![]);
        assert!(lum.confusion_turns.is_none() && lum.held_tool_used);
    }

    #[test]
    fn only_ailments_the_engine_carries_out_are_kept() {
        // Protect, Detect and Ingrain leave nothing behind, so Toxic still lands afterwards.
        for move_id in [182, 197, 275] {
            let mut game = battle(fighter(143, move_id, None), fighter(143, 92, None));
            attack(&dice(1), &mut game, true, &catalog().moves[&move_id]);
            assert!(active(&game.player1).status.is_none(), "{move_id}");
            assert!(game.events.iter().any(|event| event.contains("아무 일도 일어나지 않았습니다")));
            attack(&dice(1), &mut game, false, &sure_hit(92));
            assert_eq!(active(&game.player1).status.as_deref(), Some("poison"));
        }
        // Smack Down, Thousand Arrows, Throat Chop, Yawn, Attract and Torment leave no status.
        for move_id in [479, 614, 675, 281, 213, 259] {
            let mut game = battle(fighter(143, move_id, None), fighter(143, 33, None));
            attack(&dice(1), &mut game, true, &sure_hit(move_id));
            let target = active(&game.player2);
            assert!(target.status.is_none() && target.confusion_turns.is_none() && target.trap_turns.is_none() && !target.seeded, "{move_id}");
        }
        // Tri Attack's 20% "unknown" ailment is a burn, paralysis or freeze.
        let mut kinds = std::collections::BTreeSet::new();
        for turn in 1..=300 {
            let mut game = battle(fighter(137, 161, None), fighter(143, 33, None));
            attack(&dice(turn), &mut game, true, &catalog().moves[&161]);
            kinds.extend(active(&game.player2).status.clone());
        }
        assert_eq!(kinds.into_iter().collect::<Vec<_>>(), ["burn", "freeze", "paralysis"]);
    }

    #[test]
    fn stored_battles_keep_only_statuses_the_engine_runs() {
        let legacy = |status: &str| {
            let mut value = serde_json::to_value(fighter(143, 33, None)).unwrap();
            let object = value.as_object_mut().unwrap();
            for key in ["confusionTurns", "trapTurns", "seeded"] {
                object.remove(key);
            }
            object.insert("status".into(), json!(status));
            serde_json::from_value::<Fighter>(value).unwrap()
        };
        for status in ["confusion", "trap", "leech-seed", "protect", "unknown", "burn"] {
            let mut game = battle(legacy(status), legacy(status));
            game.player1.team.push(legacy(status));
            normalize_battle(&mut game);
            let kept = (status == "burn").then_some("burn");
            let (lead, benched) = (&game.player1.team[0], &game.player1.team[1]);
            assert_eq!((lead.status.as_deref(), benched.status.as_deref()), (kept, kept), "{status}");
            assert_eq!(lead.confusion_turns, (status == "confusion").then_some(2));
            assert_eq!(lead.trap_turns, (status == "trap").then_some(2));
            assert_eq!(lead.seeded, status == "leech-seed");
            assert!(benched.confusion_turns.is_none() && benched.trap_turns.is_none() && !benched.seeded);
        }
    }

    #[test]
    fn one_hit_ko_moves_and_psywave_follow_the_client_rules() {
        let ko = |move_id: i64, target: Fighter| {
            let mut game = battle(fighter(143, move_id, None), target);
            attack(&dice(1), &mut game, true, &sure_hit(move_id));
            game
        };
        for move_id in [12, 32, 90] {
            assert_eq!(active(&ko(move_id, fighter(143, 33, None)).player2).hp, 0, "{move_id}");
        }
        let flying = ko(90, fighter(16, 33, None));
        assert_eq!(active(&flying.player2).hp, active(&flying.player2).max_hp);
        let sturdy = ko(12, fighter(74, 33, Some("sturdy")));
        assert_eq!(active(&sturdy.player2).hp, active(&sturdy.player2).max_hp);
        assert!(sturdy.events.iter().any(|event| event.contains("특성이")));
        let mut sash = fighter(143, 33, None);
        sash.held_tool = Some("focus-sash".into());
        let sashed = ko(32, sash);
        assert_eq!(active(&sashed.player2).hp, 1);
        assert!(active(&sashed.player2).held_tool_used);

        let mut seen = std::collections::BTreeSet::new();
        for turn in 1..=100 {
            let mut game = battle(fighter(64, 149, None), fighter(143, 33, None));
            let before = active(&game.player2).hp;
            attack(&dice(turn), &mut game, true, &catalog().moves[&149]);
            let dealt = before - active(&game.player2).hp;
            assert!((25..=74).contains(&dealt), "{dealt}");
            seen.insert(dealt);
        }
        assert!(seen.len() > 10);
        let mut dark = battle(fighter(64, 149, None), fighter(197, 33, None));
        attack(&dice(1), &mut dark, true, &catalog().moves[&149]);
        assert_eq!(active(&dark.player2).hp, active(&dark.player2).max_hp);
    }

    #[test]
    fn a_stale_choice_lock_never_blocks_every_move() {
        let mut game = battle(fighter(143, 33, None), fighter(143, 33, None));
        game.player1.team[0].moves.push(catalog().moves[&89].clone());
        game.player1.team[0].held_tool = Some("choice-scarf".into());
        game.player1.team[0].choice_move = Some(33);
        assert!(selected_move(&game.player1, 1).is_err());
        assert_eq!(own_side_view(&game.player1)["team"][0]["choiceMove"], 33);
        // A lock on a move the fighter no longer knows, or without a Choice item, is ignored.
        game.player1.team[0].choice_move = Some(94);
        assert!(selected_move(&game.player1, 0).is_ok() && selected_move(&game.player1, 1).is_ok());
        assert!(own_side_view(&game.player1)["team"][0]["choiceMove"].is_null());
        game.player1.team[0].choice_move = Some(33);
        game.player1.team[0].held_tool = None;
        assert!(check_turn_action(&game.player1, &move_action(1)).is_ok());
    }

    fn test_save(species_id: i64, move_id: i64) -> Value {
        json!({"game":{"player":{"team":[{"instanceId":"mon-1","speciesId":species_id,"nickname":"ranked","ivs":{"hp":31,"attack":31,"defense":31,"specialAttack":31,"specialDefense":31,"speed":31},"moves":[{"moveId":move_id}]}]}}})
    }
    async fn account(pool: &PgPool, name: &str, species: i64, move_id: i64) -> (Uuid, HeaderMap) {
        let id = Uuid::new_v4();
        let token = format!("{:064x}", id.as_u128());
        let hash = hex::encode(Sha256::digest(token.as_bytes()));
        sqlx::query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'test')")
            .bind(id)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)")
            .bind(hash)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        let bytes = compress(&serde_json::to_vec(&test_save(species, move_id)).unwrap()).unwrap();
        sqlx::query("INSERT INTO saves(user_id,slot,revision,request_id,payload,payload_hash) VALUES($1,'current',1,'test',$2,'test')").bind(id).bind(bytes).execute(pool).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            format!("choketmon_session={token}").parse().unwrap(),
        );
        headers.insert("x-choketmon-profile", id.to_string().parse().unwrap());
        (id, headers)
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn two_accounts_match_and_rate_each_league(pool: PgPool) {
        let state = AppState::new(pool.clone(), None);
        let (p1, h1) = account(&pool, "ranked-one", 25, 85).await;
        let (p2, h2) = account(&pool, "ranked-two", 6, 53).await;
        let first = queue(
            State(state.clone()),
            h1.clone(),
            Json(QueueBody {
                league: "standard".into(),
            }),
        )
        .await
        .unwrap()
        .0;
        assert!(first["me"]["queued"].as_bool().unwrap());
        let second = queue(
            State(state.clone()),
            h2.clone(),
            Json(QueueBody {
                league: "standard".into(),
            }),
        )
        .await
        .unwrap()
        .0;
        let match_id: Uuid = second["currentMatch"]["id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let _ = action(
            State(state.clone()),
            h1.clone(),
            Path(match_id),
            Json(TurnAction {
                turn: 1,
                move_index: Some(0),
                switch_index: None,
                surrender: false, transformation: None,
            }),
        )
        .await
        .unwrap();
        let resolved = action(
            State(state.clone()),
            h2.clone(),
            Path(match_id),
            Json(TurnAction {
                turn: 1,
                move_index: Some(0),
                switch_index: None,
                surrender: false, transformation: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(resolved["match"]["turn"], 2);
        assert!(
            resolved["match"]["selfSide"]["team"][0]["hp"]
                .as_i64()
                .unwrap()
                < resolved["match"]["selfSide"]["team"][0]["maxHp"]
                    .as_i64()
                    .unwrap()
        );
        let _ = action(
            State(state.clone()),
            h1.clone(),
            Path(match_id),
            Json(TurnAction {
                turn: 2,
                move_index: None,
                switch_index: None,
                surrender: true, transformation: None,
            }),
        )
        .await
        .unwrap();
        let standard = view(&state, p2, League::Standard).await.unwrap();
        assert_eq!(standard["me"]["wins"], 1);
        assert_eq!(standard["leaderboard"][0]["userId"], p2.to_string());
        let _ = queue(
            State(state.clone()),
            h1.clone(),
            Json(QueueBody {
                league: "open".into(),
            }),
        )
        .await
        .unwrap();
        let open = queue(
            State(state.clone()),
            h2.clone(),
            Json(QueueBody {
                league: "open".into(),
            }),
        )
        .await
        .unwrap()
        .0;
        let open_id: Uuid = open["currentMatch"]["id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let _ = action(
            State(state.clone()),
            h1.clone(),
            Path(open_id),
            Json(TurnAction {
                turn: 1,
                move_index: Some(0),
                switch_index: None,
                surrender: false, transformation: None,
            }),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE ranked_matches SET deadline_at=now()-interval '1 second' WHERE id=$1")
            .bind(open_id)
            .execute(&pool)
            .await
            .unwrap();
        expire_for_user(&state, p1).await.unwrap();
        expire_for_user(&state, p1).await.unwrap();
        let open = view(&state, p1, League::Open).await.unwrap();
        assert_eq!(open["me"]["wins"], 1);
        assert_eq!(open["me"]["rating"], 1016);
        let standard = view(&state, p1, League::Standard).await.unwrap();
        assert_eq!(standard["me"]["losses"], 1);
        assert_eq!(standard["me"]["rating"], 984);
    }
}
