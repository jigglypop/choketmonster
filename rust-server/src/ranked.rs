//! Authoritative two-player ranked battles.
//!
//! Queue admission snapshots the account's `current` cloud-save team, normalizes it to level 50,
//! and resets battle HP. Match turns and Elo are stored separately, so ranked play never changes
//! the original monsters' HP, experience, memories, or save revision. The bundled catalog is
//! generated from the repository's pinned PokeAPI data. General move metadata (damage, healing,
//! drain, stat stages, common ailments and multi-hit ranges) and the battle engine's implemented
//! ability rules are resolved here, together with explicit fixed-damage, recovery, cleansing,
//! stat-reset and Rapid Spin rules. Other move-specific scripts remain outside this core.

use crate::api::{ApiError, AppState, decompress, profile_user, rate_limit};
use crate::combat_forms::combat_form;
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
struct TransformationRequest {
    kind: String,
    #[serde(rename = "formIdentifier")]
    form_identifier: Option<String>,
    #[serde(rename = "teraType")]
    tera_type: Option<String>,
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
    transformation_kind: Option<String>,
    #[serde(default)]
    tera_type: Option<String>,
    #[serde(default)]
    original_types: Option<Vec<String>>,
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
    #[serde(default)]
    mega_used: bool,
    #[serde(default)]
    tera_used: bool,
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
            transformation_kind: None, tera_type: None, original_types: None,
            status: None,
            status_turns: None,
            stages: HashMap::new(),
        });
    }
    Ok(Side {
        user_id,
        username,
        active_index: 0,
        team, mega_used: false, tera_used: false,
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
    if let Some(ref transformation) = input.transformation {
        let SqlJson(mut current): SqlJson<Battle> = row.get("state");
        apply_transformation(if account.id == p1 { &mut current.player1 } else { &mut current.player2 }, transformation)?;
        sqlx::query("UPDATE ranked_matches SET state=$2,updated_at=now() WHERE id=$1").bind(id).bind(SqlJson(current)).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(Json(json!({"match":match_value(&state,id,account.id).await?})));
    }
    if let Some(index) = input.move_index {
        let SqlJson(current): SqlJson<Battle> = row.get("state");
        selected_move(if account.id == p1 { &current.player1 } else { &current.player2 }, index)?;
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
            side.active_index = i;
        }
    }
}
fn apply_switch(side: &mut Side, index: usize) -> Result<(), ApiError> {
    if index >= side.team.len() || side.team[index].hp <= 0 || index == side.active_index {
        return Err(invalid("교체할 수 없는 포켓몬입니다."));
    }
    side.team[side.active_index].stages.clear();
    side.team[side.active_index].choice_move = None;
    side.active_index = index;
    Ok(())
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
        "tera" => {
            if side.tera_used { return Err(invalid("이미 테라스탈을 사용했습니다.")); }
            let tera = request.tera_type.as_deref().filter(|kind| catalog().effectiveness.contains_key(*kind))
                .ok_or(invalid("테라 타입이 올바르지 않습니다."))?;
            monster.original_types = Some(monster.types.clone());
            monster.types = vec![tera.to_owned()]; monster.tera_type = Some(tera.to_owned()); side.tera_used = true;
        }
        _ => return Err(invalid("변신 종류가 올바르지 않습니다.")),
    }
    monster.transformation_kind = Some(request.kind.clone());
    Ok(())
}

fn stab_multiplier(monster: &Fighter, move_type: &str) -> f64 {
    let original = monster.original_types.as_ref().unwrap_or(&monster.types).iter().any(|kind| kind == move_type);
    if monster.tera_type.as_deref() == Some(move_type) { if original { 2.0 } else { 1.5 } }
    else if original { 1.5 } else { 1.0 }
}

fn effective_tera_move(monster: &Fighter, mv: &Move) -> (String, String, i64) {
    let move_type = if mv.id == 851 {
        monster.tera_type.as_deref().unwrap_or(&mv.move_type)
    } else {
        &mv.move_type
    };
    let damage_class = if mv.id == 851
        && monster.tera_type.is_some()
        && effective_stat(monster, "attack") > effective_stat(monster, "specialAttack")
    {
        "physical"
    } else {
        &mv.damage_class
    };
    let multi_hit = matches!((mv.min_hits, mv.max_hits), (Some(min), Some(max)) if min > 0 && max > 0);
    let power = if monster.tera_type.as_deref() == Some(move_type)
        && mv.power > 0
        && mv.power < 60
        && mv.priority <= 0
        && !multi_hit
    {
        60
    } else {
        mv.power
    };
    (move_type.to_owned(), damage_class.to_owned(), power)
}

fn selected_move(side: &Side, index: usize) -> Result<Move, ApiError> {
    let fighter = active(side);
    let selected = fighter.moves.get(index).ok_or(invalid("선택한 기술이 없습니다."))?;
    if fighter.choice_move.is_some_and(|id| id != selected.id) { return Err(invalid("구애 도구에 고정된 기술만 사용할 수 있습니다.")); }
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
        .map(|i| selected_move(&battle.player1, i))
        .transpose()?;
    let p2move = a2
        .move_index
        .map(|i| selected_move(&battle.player2, i))
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
    let tool_multiplier = match (monster.held_tool.as_deref(), stat) {
        (Some("choice-band"), "attack")
        | (Some("choice-specs"), "specialAttack")
        | (Some("choice-scarf"), "speed") => 1.5,

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
    self_target(mv) || mv.meta_category == Some(8) || mv.id == 229
}
fn roll(id: Uuid, turn: i32, salt: u8) -> i64 {
    (deterministic(id, turn, salt) % 100) as i64
}
fn can_act(id: Uuid, turn: i32, p1: bool, side: &mut Side, events: &mut Vec<String>) -> bool {
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
        if roll(id, turn, if p1 { 31 } else { 32 }) < 20 {
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
fn fixed_damage(mv: &Move, attacker: &Fighter, defender: &Fighter) -> Option<i64> {
    match mv.id {
        49 => Some(20),
        82 => Some(40),
        69 | 101 => Some(attacker.level),
        162 => Some((defender.hp / 2).max(1)),
        _ => None,
    }
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
    if matches!(active(attacker).held_tool.as_deref(), Some("choice-band" | "choice-specs" | "choice-scarf")) {
        attacker.team[attacker.active_index].choice_move = Some(mv.id);
    }
    let (move_type, damage_class, move_power) = effective_tera_move(active(attacker), mv);
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
    if support_move(attacker, defender, mv, &mut battle.events) {
        return;
    }
    let immunity = if self_target(mv) {
        None
    } else {
        ability_immunity(active(defender).ability.as_deref(), &move_type)
    };
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
    } else if let Some(mut damage) = fixed_damage(mv, active(attacker), active(defender)) {
        let target = &mut defender.team[defender.active_index];
        if type_mult == 0.0 || (matches!(mv.id, 12 | 32 | 90) && target.ability.as_deref() == Some("sturdy")) {
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
        total_damage = damage.min(target.hp);
        target.hp -= total_damage;
        battle.events.push(format!(
            "{}의 {}: {} 피해.",
            active(attacker).nickname,
            mv.name,
            total_damage
        ));
    } else if move_power > 0 && damage_class != "status" {
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
            let mut damage = (base * stab * type_mult * low_hp_power(a, &move_type) * if a.held_tool.as_deref() == Some("life-orb") { 1.3 } else { 1.0 } * 0.925)
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
    if total_damage > 0
        && active(attacker).held_tool.as_deref() == Some("life-orb")
        && active(attacker).hp > 0
    {
        let actor = &mut attacker.team[attacker.active_index];
        actor.hp = (actor.hp - (actor.max_hp / 10).max(1)).max(0);
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
        if matches!(actor.status.as_deref(), Some("trap" | "leech-seed")) {
            actor.status = None;
            actor.status_turns = None;
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
        && roll(id, turn, if p1 { 51 } else { 52 }) < stat_chance
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
            if target.hp > 0 && target.status.is_none() && !immune {
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
    if active(side).hp <= 0 {
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
    if target.hp > 0 && target.held_tool.as_deref() == Some("leftovers") {
        target.hp = (target.hp + (target.max_hp / 16).max(1)).min(target.max_hp);
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
fn presentation_side(mut side: Side) -> Side {
    for fighter in &mut side.team {
        fighter.moves = fighter.moves.iter().map(|source| {
            let (move_type, damage_class, power) = effective_tera_move(fighter, source);
            let mut view = source.clone();
            view.move_type = move_type; view.damage_class = damage_class; view.power = power;
            view
        }).collect();
    }
    side
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
    let p_self = presentation_side(p_self);
    let p_other = presentation_side(p_other);
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
            held_tool: None,
            held_tool_used: false,
            choice_move: None,
            regional_form: None,
            individual_values: None, transformation_kind: None, tera_type: None, original_types: None,
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
                team: vec![left], mega_used: false, tera_used: false,
            },
            player2: Side {
                user_id: Uuid::from_u128(2),
                username: "two".into(),
                active_index: 0,
                team: vec![right], mega_used: false, tera_used: false,
            },
            events: vec![],
        }
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
        attack(
            Uuid::nil(),
            1,
            &mut sash_battle,
            true,
            &catalog().moves[&63],
        );
        assert_eq!(active(&sash_battle.player2).hp, 1);

        let mut orb_battle = battle(fighter(25, 33, None), fighter(10, 33, None));
        orb_battle.player1.team[0].held_tool = Some("life-orb".into());
        let before = active(&orb_battle.player1).hp;
        attack(Uuid::nil(), 1, &mut orb_battle, true, &catalog().moves[&33]);
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

    #[test]
    fn mega_and_tera_are_canonical_and_persist_per_side_limits() {
        let mut side = battle(fighter(6, 53, None), fighter(7, 55, None)).player1;
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
        apply_transformation(&mut loaded, &TransformationRequest { kind: "tera".into(), form_identifier: None, tera_type: Some("electric".into()) }).unwrap();
        assert_eq!(stab_multiplier(active(&loaded), "electric"), 2.0);
        assert!(loaded.mega_used && loaded.tera_used);
        let mut other = battle(fighter(6, 53, None), fighter(7, 55, None)).player1;
        apply_transformation(&mut other, &TransformationRequest { kind: "tera".into(), form_identifier: None, tera_type: Some("water".into()) }).unwrap();
        assert_eq!(stab_multiplier(active(&other), "fire"), 1.5);
        assert_eq!(stab_multiplier(active(&other), "water"), 1.5);
        assert_eq!(active(&other).types, vec!["water"]);
    }

    #[test]
    fn tera_move_rules_match_gen_nine_power_and_tera_blast_behavior() {
        let mut attacker = fighter(26, 33, None);
        attacker.types = vec!["electric".into()];
        attacker.original_types = Some(vec!["electric".into(), "psychic".into()]);
        attacker.tera_type = Some("electric".into());
        attacker.stats.attack = 140;
        attacker.stats.special_attack = 90;

        let mut tera_blast = catalog().moves[&33].clone();
        tera_blast.id = 851;
        tera_blast.move_type = "normal".into();
        tera_blast.damage_class = "special".into();
        tera_blast.power = 80;
        assert_eq!(effective_tera_move(&attacker, &tera_blast), ("electric".into(), "physical".into(), 80));
        attacker.stats.attack = 90;
        attacker.stats.special_attack = 140;
        assert_eq!(effective_tera_move(&attacker, &tera_blast).1, "special");

        let mut weak = catalog().moves[&33].clone();
        weak.move_type = "electric".into();
        weak.power = 40;
        weak.priority = 0;
        weak.min_hits = None;
        weak.max_hits = None;
        assert_eq!(effective_tera_move(&attacker, &weak).2, 60);
        weak.priority = 1;
        assert_eq!(effective_tera_move(&attacker, &weak).2, 40);
        weak.priority = 0;
        weak.min_hits = Some(2);
        weak.max_hits = Some(5);
        assert_eq!(effective_tera_move(&attacker, &weak).2, 40);
        weak.min_hits = None;
        weak.max_hits = None;
        weak.power = 0;
        assert_eq!(effective_tera_move(&attacker, &weak).2, 0);
        assert_eq!(stab_multiplier(&attacker, "electric"), 2.0);
        assert_eq!(stab_multiplier(&attacker, "psychic"), 1.5);
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
        attack(Uuid::nil(), 1, &mut game, true, &catalog().moves[&94]);
        assert_eq!(active(&game.player2).hp, 1);
        let mut loaded: Battle = serde_json::from_value(serde_json::to_value(game).unwrap()).unwrap();
        assert!(active(&loaded.player2).held_tool_used);
        assert!(selected_move(&loaded.player1, 1).is_err());
        loaded.player2.team[0].hp = loaded.player2.team[0].max_hp;
        attack(Uuid::nil(), 2, &mut loaded, true, &catalog().moves[&94]);
        assert_eq!(active(&loaded.player2).hp, 0);
        apply_switch(&mut loaded.player1, 1).unwrap();
        apply_switch(&mut loaded.player1, 0).unwrap();
        assert!(selected_move(&loaded.player1, 1).is_ok());
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
            attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&move_id]);
            assert_eq!(before - active(&b.player2).hp, expected);
        }
        let mut b = battle(fighter(20, 162, None), fighter(143, 33, None));
        b.player2.team[0].hp = 55;
        attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&162]);
        assert_eq!(active(&b.player2).hp, 28);
        b.player2.team[0].hp = 30;
        b.player2.team[0].max_hp = 30;
        b.player2.team[0].ability = Some("sturdy".into());
        attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&69]);
        assert_eq!(active(&b.player2).hp, 1);
    }

    #[test]
    fn rest_heals_then_blocks_two_actions_even_after_serialization() {
        let mut b = battle(fighter(143, 156, None), fighter(197, 33, None));
        b.player1.team[0].hp = 10;
        b.player1.team[0].status = Some("poison".into());
        attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&156]);
        assert_eq!(active(&b.player1).hp, active(&b.player1).max_hp);
        assert_eq!(active(&b.player1).status.as_deref(), Some("sleep"));
        let mut b: Battle = serde_json::from_value(serde_json::to_value(b).unwrap()).unwrap();
        for turn in 2..=3 {
            assert!(!can_act(
                Uuid::nil(),
                turn,
                true,
                &mut b.player1,
                &mut b.events
            ));
        }
        assert!(can_act(Uuid::nil(), 4, true, &mut b.player1, &mut b.events));
        assert!(active(&b.player1).status.is_none());
        attack(Uuid::nil(), 5, &mut b, true, &catalog().moves[&156]);
        assert!(active(&b.player1).status.is_none()); // full HP fails
        b.player1.team[0].hp = 10;
        b.player1.team[0].ability = Some("insomnia".into());
        attack(Uuid::nil(), 6, &mut b, true, &catalog().moves[&156]);
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
            let mut reserve = fighter(100, 33, Some("soundproof"));
            reserve.status = Some("sleep".into());
            reserve.status_turns = Some(3);
            b.player1.team.push(reserve);
            let mut bound = fighter(7, 33, None);
            bound.status = Some("trap".into());
            b.player1.team.push(bound);
            b.player2.team[0].status = Some("poison".into());
            attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&move_id]);
            assert!(active(&b.player1).status.is_none());
            assert_eq!(
                b.player1.team[1].status.as_deref(),
                if move_id == 215 { Some("sleep") } else { None }
            );
            assert_eq!(b.player1.team[2].status.as_deref(), Some("trap"));
            assert_eq!(active(&b.player2).status.as_deref(), Some("poison"));
        }
    }

    #[test]
    fn haze_and_clear_smog_reset_the_correct_stages() {
        let mut b = battle(fighter(143, 114, None), fighter(143, 33, None));
        b.player1.team[0].stages.insert("attack".into(), 2);
        b.player2.team[0].stages.insert("defense".into(), -3);
        attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&114]);
        assert!(active(&b.player1).stages.is_empty());
        assert!(active(&b.player2).stages.is_empty());
        for species in [143, 208] {
            let mut b = battle(fighter(143, 499, None), fighter(species, 33, None));
            b.player2.team[0].stages.insert("attack".into(), 4);
            attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&499]);
            assert_eq!(active(&b.player2).stages.is_empty(), species != 208);
        }
    }

    #[test]
    fn rapid_spin_effects_need_a_hit_and_switching_clears_stages() {
        for species in [143, 94] {
            let mut b = battle(fighter(143, 229, None), fighter(species, 33, None));
            b.player1.team[0].status = Some("leech-seed".into());
            attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&229]);
            assert_eq!(
                active(&b.player1).stages.get("speed"),
                if species == 94 { None } else { Some(&1) }
            );
            assert!(active(&b.player2).stages.is_empty());
            assert_eq!(active(&b.player1).status.is_none(), species != 94);
            b.player1.team.push(fighter(7, 33, None));
            apply_switch(&mut b.player1, 1).unwrap();
            apply_switch(&mut b.player1, 0).unwrap();
            assert!(active(&b.player1).stages.is_empty());
        }
    }

    #[test]
    fn status_moves_ignore_damage_type_chart_but_immune_hits_do_not_debuff() {
        let mut b = battle(fighter(143, 14, None), fighter(94, 33, None));
        attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&14]);
        assert_eq!(active(&b.player1).stages["attack"], 2);
        attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&39]);
        assert_eq!(active(&b.player2).stages["defense"], -1);
        b.player2.team[0] = fighter(208, 33, None);
        attack(Uuid::nil(), 1, &mut b, true, &catalog().moves[&491]); // Acid Spray vs Steel
        assert!(active(&b.player2).stages.is_empty());
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
