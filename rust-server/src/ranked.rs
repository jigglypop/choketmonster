//! Authoritative two-player ranked battles.
//!
//! Queue admission snapshots the account's `current` cloud-save team, normalizes it to level 50,
//! and resets battle HP. Match turns and Elo are stored separately, so ranked play never changes
//! the original monsters' HP, experience, memories, or save revision. The bundled catalog is
//! generated from the repository's pinned PokeAPI data. General move metadata (damage, healing,
//! drain, stat stages, common ailments and multi-hit ranges) and the battle engine's implemented
//! ability rules are resolved here; move-specific scripted effects remain outside this core.

use crate::api::{ApiError, AppState, decompress, profile_user, rate_limit};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction, types::Json as SqlJson};
use std::{collections::HashMap, sync::OnceLock};
use uuid::Uuid;

const TURN_SECONDS: i32 = 90;
const ELO_K: f64 = 32.0;

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
struct TurnAction {
    turn: i32,
    move_index: Option<usize>,
    switch_index: Option<usize>,
    #[serde(default)]
    surrender: bool,
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
    status: Option<String>,
    status_turns: Option<i8>,
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
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Battle {
    player1: Side,
    player2: Side,
    #[serde(default)]
    events: Vec<String>,
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
fn normalized_stats(species: &Species, monster: &Value) -> Stats {
    let normal = |base, iv| (2 * base + iv) * 50 / 100 + 5;
    Stats {
        hp: (2 * species.base_stats.hp + iv(monster, "hp")) * 50 / 100 + 60,
        attack: normal(species.base_stats.attack, iv(monster, "attack")),
        defense: normal(species.base_stats.defense, iv(monster, "defense")),
        special_attack: normal(
            species.base_stats.special_attack,
            iv(monster, "specialAttack"),
        ),
        special_defense: normal(
            species.base_stats.special_defense,
            iv(monster, "specialDefense"),
        ),
        speed: normal(species.base_stats.speed, iv(monster, "speed")),
    }
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
        let stats = normalized_stats(species, monster);
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
            types: species.types.clone(),
            moves,
            ability: monster
                .pointer("/ability/slug")
                .and_then(Value::as_str)
                .map(str::to_owned),
            status: None,
            status_turns: None,
            stages: HashMap::new(),
        });
    }
    Ok(Side {
        user_id,
        username,
        active_index: 0,
        team,
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
    let league = League::parse(&query.league)?;
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
    let league = League::parse(&body.league)?;
    let team = saved_team(&state, account.id, account.username.clone(), league).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("ranked:{}", league.as_str()))
        .execute(&mut *tx)
        .await?;
    if sqlx::query(
        "SELECT 1 FROM ranked_matches WHERE status='active' AND (player1_id=$1 OR player2_id=$1)",
    )
    .bind(account.id)
    .fetch_optional(&mut *tx)
    .await?
    .is_some()
    {
        return Err(conflict("이미 진행 중인 랭크전이 있습니다."));
    }
    ensure_rating(&mut tx, account.id, league).await?;
    sqlx::query("UPDATE ranked_ratings SET last_queued_at=now() WHERE user_id=$1 AND league=$2")
        .bind(account.id)
        .bind(league.as_str())
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM ranked_queue WHERE joined_at<now()-interval '5 minutes'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO ranked_queue(user_id,league,username,team,joined_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(user_id) DO UPDATE SET league=excluded.league,username=excluded.username,team=excluded.team,joined_at=now()")
        .bind(account.id).bind(league.as_str()).bind(&account.username).bind(SqlJson(&team)).execute(&mut *tx).await?;
    if let Some(other)=sqlx::query("SELECT user_id,team FROM ranked_queue WHERE league=$1 AND user_id<>$2 ORDER BY joined_at FOR UPDATE SKIP LOCKED LIMIT 1").bind(league.as_str()).bind(account.id).fetch_optional(&mut *tx).await?{
        let other_id:Uuid=other.get("user_id"); let SqlJson(other_team):SqlJson<Side>=other.get("team"); let id=Uuid::new_v4();
        ensure_rating(&mut tx,other_id,league).await?;
        let battle=Battle{player1:other_team,player2:team,events:vec!["랭크전이 시작되었습니다.".into()]};
        sqlx::query("INSERT INTO ranked_matches(id,league,player1_id,player2_id,state,deadline_at) VALUES($1,$2,$3,$4,$5,now()+interval '90 seconds')")
            .bind(id).bind(league.as_str()).bind(other_id).bind(account.id).bind(SqlJson(battle)).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM ranked_queue WHERE user_id=$1 OR user_id=$2").bind(other_id).bind(account.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(view(&state, account.id, league).await?))
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
    map.insert(key.clone(), serde_json::to_value(&input).unwrap());
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
        let SqlJson(mut battle): SqlJson<Battle> = row.get("state");
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
        sqlx::query("UPDATE ranked_matches SET actions=$2,updated_at=now() WHERE id=$1")
            .bind(id)
            .bind(SqlJson(actions))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(
        json!({"match":match_value(&state,id,account.id).await?}),
    ))
}

fn validate_action_shape(a: &TurnAction) -> Result<(), ApiError> {
    let choices =
        (a.move_index.is_some() as u8) + (a.switch_index.is_some() as u8) + (a.surrender as u8);
    if choices != 1 {
        return Err(invalid("기술, 교체, 항복 중 하나만 선택해 주세요."));
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
            side.active_index = i;
        }
    }
}
fn apply_switch(side: &mut Side, index: usize) -> Result<(), ApiError> {
    if index >= side.team.len() || side.team[index].hp <= 0 || index == side.active_index {
        return Err(invalid("교체할 수 없는 포켓몬입니다."));
    }
    side.active_index = index;
    Ok(())
}

fn resolve_turn(
    id: Uuid,
    turn: i32,
    battle: &mut Battle,
    a1: TurnAction,
    a2: TurnAction,
) -> Result<(), ApiError> {
    battle.events.clear();
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
    let p1move = a1
        .move_index
        .map(|i| {
            battle.player1.team[battle.player1.active_index]
                .moves
                .get(i)
                .cloned()
                .ok_or(invalid("선택한 기술이 없습니다."))
        })
        .transpose()?;
    let p2move = a2
        .move_index
        .map(|i| {
            battle.player2.team[battle.player2.active_index]
                .moves
                .get(i)
                .cloned()
                .ok_or(invalid("선택한 기술이 없습니다."))
        })
        .transpose()?;
    let first = match (&p1move, &p2move) {
        (Some(a), Some(b)) => {
            a.priority > b.priority
                || (a.priority == b.priority
                    && (effective_stat(active(&battle.player1), "speed")
                        > effective_stat(active(&battle.player2), "speed")
                        || (effective_stat(active(&battle.player1), "speed")
                            == effective_stat(active(&battle.player2), "speed")
                            && deterministic(id, turn, 0) % 2 == 0)))
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
            attack(id, turn, battle, p1_turn, &mv);
        }
    }
    residual(&mut battle.player1, &mut battle.events);
    residual(&mut battle.player2, &mut battle.events);
    auto_switch(&mut battle.player1);
    auto_switch(&mut battle.player2);
    Ok(())
}
fn deterministic(id: Uuid, turn: i32, salt: u8) -> u64 {
    id.as_u128() as u64 ^ (turn as u64).wrapping_mul(0x9e3779b97f4a7c15) ^ salt as u64
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
    let mut value =
        (base as f64 * stage_multiplier(*monster.stages.get(stat).unwrap_or(&0))).floor() as i64;
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
fn self_stat_target(mv: &Move) -> bool {
    self_target(mv) || mv.meta_category == Some(8)
}
fn roll(id: Uuid, turn: i32, salt: u8) -> i64 {
    (deterministic(id, turn, salt) % 100) as i64
}
fn can_act(id: Uuid, turn: i32, p1: bool, side: &mut Side, events: &mut Vec<String>) -> bool {
    let monster = &mut side.team[side.active_index];
    if monster.status.as_deref() == Some("sleep") {
        let left = monster.status_turns.unwrap_or(1);
        monster.status_turns = Some(left - 1);
        events.push(format!("{}은(는) 잠들어 있습니다.", monster.nickname));
        if left <= 1 {
            monster.status = None;
            monster.status_turns = None;
        }
        return false;
    }
    if monster.status.as_deref() == Some("freeze") {
        if roll(id, turn, if p1 { 31 } else { 32 }) < 20 {
            monster.status = None;
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
        && roll(id, turn, if p1 { 33 } else { 34 }) < 25
    {
        events.push(format!(
            "{}은(는) 마비되어 움직일 수 없습니다.",
            monster.nickname
        ));
        return false;
    }
    true
}
fn attack(id: Uuid, turn: i32, battle: &mut Battle, p1: bool, mv: &Move) {
    let (attacker, defender) = if p1 {
        (&mut battle.player1, &mut battle.player2)
    } else {
        (&mut battle.player2, &mut battle.player1)
    };
    if !alive(attacker)
        || !alive(defender)
        || active(attacker).hp <= 0
        || !can_act(id, turn, p1, attacker, &mut battle.events)
    {
        return;
    }
    let accuracy = (mv.accuracy as f64
        * stage_multiplier(*active(attacker).stages.get("accuracy").unwrap_or(&0))
        / stage_multiplier(*active(defender).stages.get("evasion").unwrap_or(&0)))
    .round() as i64;
    if mv.accuracy > 0 && roll(id, turn, if p1 { 1 } else { 2 }) >= accuracy {
        battle.events.push(format!(
            "{}의 {}이(가) 빗나갔습니다.",
            active(attacker).nickname,
            mv.name
        ));
        return;
    }
    let immunity = ability_immunity(active(defender).ability.as_deref(), &mv.move_type);
    let mut total_damage = 0;
    let mut type_mult = effectiveness(&mv.move_type, &active(defender).types);
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
    } else if mv.power > 0 && mv.damage_class != "status" {
        let hits = match (mv.min_hits, mv.max_hits) {
            (Some(min), Some(max)) if min > 0 && max >= min => {
                min + (deterministic(id, turn, if p1 { 41 } else { 42 }) % (max - min + 1) as u64)
                    as i64
            }
            _ => 1,
        };
        for _ in 0..hits {
            if active(defender).hp <= 0 {
                break;
            }
            let a = active(attacker);
            let d = active(defender);
            let mut offense = effective_stat(
                a,
                if mv.damage_class == "special" {
                    "specialAttack"
                } else {
                    "attack"
                },
            );
            if mv.damage_class == "physical" && a.status.as_deref() == Some("burn") {
                offense = (offense / 2).max(1);
            }
            let defense = effective_stat(
                d,
                if mv.damage_class == "special" {
                    "specialDefense"
                } else {
                    "defense"
                },
            );
            let stab = if a.types.iter().any(|t| t == &mv.move_type) {
                1.5
            } else {
                1.0
            };
            let base = (((22 * mv.power * offense / defense.max(1)) / 50) + 2) as f64;
            let mut damage = (base * stab * type_mult * low_hp_power(a, &mv.move_type) * 0.925)
                .floor()
                .max(if type_mult > 0.0 { 1.0 } else { 0.0 }) as i64;
            let target = &mut defender.team[defender.active_index];
            if target.ability.as_deref() == Some("sturdy")
                && target.hp == target.max_hp
                && damage >= target.hp
            {
                damage = (target.hp - 1).max(0);
            }
            target.hp = (target.hp - damage).max(0);
            total_damage += damage;
        }
        battle.events.push(format!(
            "{}의 {}: {} 피해.",
            active(attacker).nickname,
            mv.name,
            total_damage
        ));
    }
    if let Some(drain) = mv.drain.filter(|v| *v != 0 && total_damage > 0) {
        let amount = ((total_damage * drain.abs()) / 100).max(1);
        let actor = &mut attacker.team[attacker.active_index];
        if drain > 0 {
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
    let stat_chance = mv
        .stat_chance
        .filter(|v| *v > 0)
        .or(if mv.damage_class == "status" {
            Some(100)
        } else {
            mv.effect_chance
        })
        .unwrap_or(100);
    if !mv.stat_changes.is_empty() && roll(id, turn, if p1 { 51 } else { 52 }) < stat_chance {
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
    if type_mult > 0.0 && roll(id, turn, if p1 { 61 } else { 62 }) < ailment_chance {
        if let Some(ailment) = mv.ailment.as_deref().filter(|v| *v != "none") {
            let target = if self_target(mv) {
                &mut attacker.team[attacker.active_index]
            } else {
                &mut defender.team[defender.active_index]
            };
            let immune = (ailment == "poison"
                && target.types.iter().any(|t| t == "poison" || t == "steel"))
                || (ailment == "burn" && target.types.iter().any(|t| t == "fire"))
                || (ailment == "freeze" && target.types.iter().any(|t| t == "ice"))
                || (ailment == "paralysis" && target.types.iter().any(|t| t == "electric"));
            if target.status.is_none() && !immune {
                target.status = Some(ailment.into());
                target.status_turns = if ailment == "sleep" {
                    Some(2 + (deterministic(id, turn, 71) % 3) as i8)
                } else {
                    None
                };
                battle.events.push(format!(
                    "{}은(는) {} 상태가 되었습니다.",
                    target.nickname, ailment
                ));
            }
        }
    }
}
fn residual(side: &mut Side, events: &mut Vec<String>) {
    if !alive(side) {
        return;
    }
    let target = &mut side.team[side.active_index];
    if matches!(
        target.status.as_deref(),
        Some("poison" | "burn" | "trap" | "leech-seed")
    ) {
        let damage = (target.max_hp / 8).max(1);
        target.hp = (target.hp - damage).max(0);
        events.push(format!(
            "{}은(는) 상태 이상으로 {} 피해를 입었습니다.",
            target.nickname, damage
        ));
    }
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
async fn match_value(state: &AppState, id: Uuid, viewer: Uuid) -> Result<Value, ApiError> {
    let row=sqlx::query("SELECT league,state,actions,turn,status,winner_id,result_reason,rating_changes,deadline_at::text deadline_at FROM ranked_matches WHERE id=$1").bind(id).fetch_optional(&state.db).await?.ok_or_else(not_found)?;
    let SqlJson(battle): SqlJson<Battle> = row.get("state");
    let p1 = battle.player1.user_id;
    let (p_self, p_other) = if viewer == p1 {
        (battle.player1, battle.player2)
    } else {
        (battle.player2, battle.player1)
    };
    let actions = row.get::<SqlJson<Value>, _>("actions").0;
    let submitted = actions
        .as_object()
        .is_some_and(|m| m.contains_key(&viewer.to_string()));
    let status: String = row.get("status");
    Ok(
        json!({"id":id,"league":row.get::<String,_>("league"),"status":status,"turn":row.get::<i32,_>("turn"),"deadlineAt":row.get::<String,_>("deadline_at"),"selfSide":p_self,"opponentSide":p_other,"events":battle.events,"awaitingOpponent":status=="active"&&submitted,"winnerId":row.get::<Option<Uuid>,_>("winner_id"),"resultReason":row.get::<Option<String>,_>("result_reason"),"ratingChange":row.get::<SqlJson<Value>,_>("rating_changes").0.get(viewer.to_string()).cloned().unwrap_or(json!(0))}),
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
            status: None,
            status_turns: None,
            stages: HashMap::new(),
        }
    }
    fn battle(left: Fighter, right: Fighter) -> Battle {
        Battle {
            player1: Side {
                user_id: Uuid::from_u128(1),
                username: "one".into(),
                active_index: 0,
                team: vec![left],
            },
            player2: Side {
                user_id: Uuid::from_u128(2),
                username: "two".into(),
                active_index: 0,
                team: vec![right],
            },
            events: vec![],
        }
    }

    #[test]
    fn status_healing_stages_and_residual_are_effective() {
        let mut poisoned = battle(fighter(25, 672, None), fighter(6, 53, None));
        attack(Uuid::nil(), 1, &mut poisoned, true, &catalog().moves[&672]);
        assert_eq!(active(&poisoned.player2).status.as_deref(), Some("poison"));
        let hp = active(&poisoned.player2).hp;
        residual(&mut poisoned.player2, &mut poisoned.events);
        assert!(active(&poisoned.player2).hp < hp);
        let mut boosted = battle(fighter(25, 14, None), fighter(6, 53, None));
        attack(Uuid::nil(), 1, &mut boosted, true, &catalog().moves[&14]);
        assert_eq!(active(&boosted.player1).stages["attack"], 2);
        boosted.player1.team[0].hp = 1;
        boosted.player1.team[0].moves[0] = catalog().moves[&105].clone();
        attack(Uuid::nil(), 2, &mut boosted, true, &catalog().moves[&105]);
        assert!(active(&boosted.player1).hp > 1);
    }

    #[test]
    fn implemented_abilities_affect_server_damage() {
        let mut immune = battle(fighter(112, 89, None), fighter(479, 85, Some("levitate")));
        let hp = active(&immune.player2).hp;
        attack(Uuid::nil(), 1, &mut immune, true, &catalog().moves[&89]);
        assert_eq!(active(&immune.player2).hp, hp);
        let mut sturdy = battle(fighter(150, 63, None), fighter(213, 89, Some("sturdy")));
        sturdy.player2.team[0].hp = 1;
        sturdy.player2.team[0].max_hp = 1;
        attack(Uuid::nil(), 1, &mut sturdy, true, &catalog().moves[&63]);
        assert_eq!(active(&sturdy.player2).hp, 1);
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
                surrender: false,
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
                surrender: false,
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
                surrender: true,
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
                surrender: false,
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
