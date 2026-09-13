use serde::Deserialize;
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const INVENTORY_ITEMS: [&str; 12] = [
    "poke-ball",
    "great-ball",
    "ultra-ball",
    "potion",
    "super-potion",
    "rare-candy",
    "fire-stone",
    "water-stone",
    "thunder-stone",
    "leaf-stone",
    "moon-stone",
    "link-cable",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFile {
    species: Vec<Species>,
    moves: Vec<Move>,
    #[serde(default)]
    versions: Vec<Version>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    id: String,
    species_ids: Vec<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Species {
    id: i64,
    base_stats: Stats,
    moves: Vec<LearnedMove>,
    experience: Vec<i64>,
    #[serde(default)]
    evolutions: Vec<Evolution>,
}

#[derive(Deserialize)]
struct Evolution {
    target: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    hp: i64,
    attack: i64,
    defense: i64,
    special_attack: i64,
    special_defense: i64,
    speed: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LearnedMove {
    level: i64,
    move_id: i64,
}

#[derive(Deserialize)]
struct Move {
    id: i64,
    pp: i64,
}

struct Catalog {
    species: HashMap<i64, Species>,
    moves: HashMap<i64, Move>,
    versions: HashMap<String, HashSet<i64>>,
}

static CATALOG: OnceLock<Catalog> = OnceLock::new();
static GRAPH: OnceLock<Value> = OnceLock::new();

fn catalog() -> &'static Catalog {
    CATALOG.get_or_init(|| {
        let parsed: CatalogFile = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/data/pokemon-validation.json"
        )))
        .expect("generated Pokemon validation catalog must be valid JSON");
        Catalog {
            species: parsed
                .species
                .into_iter()
                .map(|item| (item.id, item))
                .collect(),
            moves: parsed
                .moves
                .into_iter()
                .map(|item| (item.id, item))
                .collect(),
            versions: parsed
                .versions
                .into_iter()
                .map(|version| (version.id, version.species_ids.into_iter().collect()))
                .collect(),
        }
    })
}

fn expected_graph() -> &'static Value {
    GRAPH.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../public/data/connectome.json"
        )))
        .expect("bundled connectome must be valid JSON")
    })
}

fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, &'static str> {
    value
        .get(field)
        .and_then(Value::as_object)
        .ok_or("저장 파일의 객체 필드가 올바르지 않습니다.")
}

fn array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, &'static str> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or("저장 파일의 배열 필드가 올바르지 않습니다.")
}

fn integer(value: Option<&Value>, min: i64, max: i64) -> Result<i64, &'static str> {
    let number = value
        .and_then(Value::as_i64)
        .ok_or("저장 파일의 정수 값이 올바르지 않습니다.")?;
    if !(min..=max).contains(&number) {
        return Err("저장 파일의 정수 범위가 올바르지 않습니다.");
    }
    Ok(number)
}

fn experience_at_level(species: &Species, level: i64) -> Result<i64, &'static str> {
    species
        .experience
        .get(level as usize - 1)
        .copied()
        .ok_or("포켓몬 경험치 표가 올바르지 않습니다.")
}

fn expected_stats(species: &Species, level: i64) -> [i64; 6] {
    let normal = |base| 2 * base * level / 100 + 5;
    [
        2 * species.base_stats.hp * level / 100 + level + 10,
        normal(species.base_stats.attack),
        normal(species.base_stats.defense),
        normal(species.base_stats.special_attack),
        normal(species.base_stats.special_defense),
        normal(species.base_stats.speed),
    ]
}

fn finite_number(value: &Value, absolute_maximum: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number.abs() <= absolute_maximum)
}

fn validate_matrix(
    value: Option<&Value>,
    rows: usize,
    columns: usize,
    bound: f64,
) -> Result<(), &'static str> {
    let matrix = value
        .and_then(Value::as_array)
        .ok_or("신경 체크포인트 행렬이 올바르지 않습니다.")?;
    if matrix.len() != rows
        || matrix.iter().any(|row| {
            row.as_array().is_none_or(|items| {
                items.len() != columns || items.iter().any(|item| !finite_number(item, bound))
            })
        })
    {
        return Err("신경 체크포인트 행렬이 올바르지 않습니다.");
    }
    Ok(())
}

fn validate_brain(brain: &Value) -> Result<(), &'static str> {
    let node_count = expected_graph()["nodes"]
        .as_array()
        .map(Vec::len)
        .ok_or("서버 커넥톰이 올바르지 않습니다.")?;
    integer(brain.get("schema"), 1, 1)?;
    integer(brain.get("seed"), 0, u32::MAX as i64)?;
    integer(brain.get("rng"), 0, u32::MAX as i64)?;
    integer(brain.get("updates"), 0, MAX_SAFE_INTEGER)?;
    integer(brain.get("action"), 0, 4)?;
    validate_matrix(brain.get("inputWeights"), node_count, 12, 12.0)?;
    validate_matrix(brain.get("readout"), 5, node_count + 12, 12.0)?;
    let activity = brain
        .get("activity")
        .and_then(Value::as_array)
        .ok_or("신경 활동 값이 올바르지 않습니다.")?;
    if activity.len() != node_count || activity.iter().any(|item| !finite_number(item, 1.0)) {
        return Err("신경 활동 값이 올바르지 않습니다.");
    }
    if let Some(previous) = brain.get("previous").filter(|item| !item.is_null()) {
        let previous = previous
            .as_array()
            .ok_or("신경 학습 특징이 올바르지 않습니다.")?;
        if previous.len() != node_count + 12
            || previous.iter().any(|item| !finite_number(item, 1.0))
        {
            return Err("신경 학습 특징이 올바르지 않습니다.");
        }
    }
    if brain
        .get("sensoryBypass")
        .is_some_and(|value| value != false)
    {
        return Err("신경 감각 우회 설정이 올바르지 않습니다.");
    }
    // packSave intentionally removes every nested `graph`; accepting one here
    // would let a forged topology enter a client-side brain after restoration.
    if brain.get("graph").is_some() {
        return Err("개체 체크포인트에는 별도 그래프를 저장할 수 없습니다.");
    }
    Ok(())
}

fn validate_monster(
    monster: &Value,
    ids: &mut HashSet<String>,
    owned: bool,
    owned_species: &mut HashSet<i64>,
) -> Result<(), &'static str> {
    let instance_id = monster
        .get("instanceId")
        .and_then(Value::as_str)
        .ok_or("개체 ID가 올바르지 않습니다.")?;
    if instance_id.is_empty()
        || instance_id.len() > 120
        || !instance_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        || !ids.insert(instance_id.to_owned())
    {
        return Err("개체 ID가 없거나 중복되었습니다.");
    }
    let species_id = integer(monster.get("speciesId"), 1, i64::MAX)?;
    let species = catalog()
        .species
        .get(&species_id)
        .ok_or("지원하지 않는 포켓몬 종입니다.")?;
    if owned {
        owned_species.insert(species_id);
    }
    let nickname = monster
        .get("nickname")
        .and_then(Value::as_str)
        .ok_or("포켓몬 이름이 올바르지 않습니다.")?;
    if nickname.is_empty() || nickname.chars().count() > 40 {
        return Err("포켓몬 이름이 올바르지 않습니다.");
    }
    let level = integer(monster.get("level"), 1, 100)?;
    let xp = integer(monster.get("xp"), 0, MAX_SAFE_INTEGER)?;
    let minimum = experience_at_level(species, level)?;
    let maximum = if level == 100 {
        experience_at_level(species, 100)?
    } else {
        experience_at_level(species, level + 1)? - 1
    };
    if xp < minimum || xp > maximum {
        return Err("레벨과 경험치가 일치하지 않습니다.");
    }
    let stats = object(monster, "stats")?;
    for (field, expected) in [
        "hp",
        "attack",
        "defense",
        "specialAttack",
        "specialDefense",
        "speed",
    ]
    .into_iter()
    .zip(expected_stats(species, level))
    {
        if integer(stats.get(field), 1, 10_000)? != expected {
            return Err("계산 능력치가 종과 레벨에 맞지 않습니다.");
        }
    }
    let maximum_hp = stats["hp"].as_i64().unwrap();
    integer(monster.get("hp"), 0, maximum_hp)?;
    if let Some(status) = monster.get("status") {
        let status = status
            .as_str()
            .ok_or("포켓몬 상태이상이 올바르지 않습니다.")?;
        if status.is_empty() || status.len() > 40 {
            return Err("포켓몬 상태이상이 올바르지 않습니다.");
        }
    }
    if let Some(turns) = monster.get("statusTurns") {
        integer(Some(turns), 1, 10)?;
        if monster.get("status").is_none() {
            return Err("상태이상 없이 지속 시간만 저장할 수 없습니다.");
        }
    }
    let moves = array(monster, "moves")?;
    if moves.len() > 4 {
        return Err("기술은 최대 4개만 저장할 수 있습니다.");
    }
    // Evolution keeps the moves already learned by prior forms. Walk the
    // reverse evolution graph so those legitimate slots survive validation.
    let mut legal = HashSet::new();
    let mut forms = vec![species_id];
    let mut visited = HashSet::new();
    while let Some(form) = forms.pop() {
        if !visited.insert(form) {
            continue;
        }
        if let Some(entry) = catalog().species.get(&form) {
            legal.extend(
                entry
                    .moves
                    .iter()
                    .filter(|learned| learned.level <= level)
                    .map(|learned| learned.move_id),
            );
        }
        forms.extend(
            catalog()
                .species
                .values()
                .filter(|candidate| {
                    candidate
                        .evolutions
                        .iter()
                        .any(|evolution| evolution.target == form)
                })
                .map(|candidate| candidate.id),
        );
    }
    let mut move_ids = HashSet::new();
    for slot in moves {
        let move_id = integer(slot.get("moveId"), 1, i64::MAX)?;
        let known = catalog()
            .moves
            .get(&move_id)
            .ok_or("지원하지 않는 기술입니다.")?;
        if !legal.contains(&move_id) || !move_ids.insert(move_id) {
            return Err("현재 종과 레벨이 배울 수 없는 기술입니다.");
        }
        integer(slot.get("pp"), 0, known.pp)?;
    }
    if let Some(order) = monster.get("moveOrder") {
        let order = order.as_array().ok_or("기술 배치가 올바르지 않습니다.")?;
        if order.len() > 4 {
            return Err("기술 배치가 올바르지 않습니다.");
        }
        let mut ordered_ids = HashSet::new();
        for value in order {
            let move_id = integer(Some(value), 1, MAX_SAFE_INTEGER)?;
            if !move_ids.contains(&move_id) || !ordered_ids.insert(move_id) {
                return Err("기술 배치가 올바르지 않습니다.");
            }
        }
    }
    if let Some(reserve) = monster.get("movePpReserve") {
        let reserve = reserve
            .as_object()
            .ok_or("미장착 기술 PP가 잘못되었습니다.")?;
        if reserve.len() > legal.len() {
            return Err("미장착 기술 PP가 잘못되었습니다.");
        }
        for (move_id_text, pp) in reserve {
            let move_id = move_id_text
                .parse::<i64>()
                .ok()
                .filter(|id| *id >= 1 && *id <= MAX_SAFE_INTEGER)
                .ok_or("미장착 기술 PP가 잘못되었습니다.")?;
            if move_id.to_string() != *move_id_text {
                return Err("미장착 기술 PP가 잘못되었습니다.");
            }
            let known = catalog()
                .moves
                .get(&move_id)
                .ok_or("미장착 기술 PP가 잘못되었습니다.")?;
            if !legal.contains(&move_id) || move_ids.contains(&move_id) {
                return Err("미장착 기술 PP가 잘못되었습니다.");
            }
            integer(Some(pp), 0, known.pp)?;
        }
    }
    if let Some(brain) = monster.get("brain") {
        validate_brain(brain)?;
    }
    if let Some(learning) = monster.get("moveLearning") {
        let learning = learning
            .as_object()
            .ok_or("기술 학습 기록이 올바르지 않습니다.")?;
        if learning.len() > 2048 {
            return Err("기술 학습 기록이 너무 많습니다.");
        }
        for (move_id, record) in learning {
            let id = move_id
                .parse::<i64>()
                .ok()
                .filter(|id| catalog().moves.contains_key(id))
                .ok_or("기술 학습 기록의 기술이 올바르지 않습니다.")?;
            let _ = id;
            let choices = integer(record.get("choices"), 0, 1_000_000_000)?;
            let executed = integer(record.get("executed"), 0, choices)?;
            integer(record.get("effective"), 0, executed)?;
            if !record
                .get("reward")
                .is_some_and(|value| finite_number(value, 1_000_000_000.0))
            {
                return Err("기술 학습 보상이 올바르지 않습니다.");
            }
        }
    }
    Ok(())
}

const WORLD_MAPS: [(&str, &str); 10] = [
    ("kanto", "kanto-v2"),
    ("johto", "johto-atlas-v1"),
    ("hoenn", "hoenn-atlas-v1"),
    ("sinnoh", "sinnoh-atlas-v1"),
    ("unova", "unova-atlas-v1"),
    ("kalos", "kalos-atlas-v1"),
    ("alola", "alola-atlas-v1"),
    ("galar", "galar-atlas-v1"),
    ("hisui", "hisui-atlas-v1"),
    ("paldea", "paldea-atlas-v1"),
];

fn validate_town_ids(value: &Value) -> Result<(), &'static str> {
    let ids = value
        .as_array()
        .ok_or("지역 방문 기록이 올바르지 않습니다.")?;
    if ids.len() > 100 {
        return Err("지역 방문 기록이 올바르지 않습니다.");
    }
    let mut unique = HashSet::new();
    for id in ids {
        let id = id
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 80)
            .ok_or("지역 방문 기록이 올바르지 않습니다.")?;
        if !unique.insert(id) {
            return Err("지역 방문 기록이 올바르지 않습니다.");
        }
    }
    Ok(())
}

fn validate_open_world(view: Option<&Value>) -> Result<(), &'static str> {
    let Some(view) = view else {
        return Ok(());
    };
    let view = view
        .as_object()
        .ok_or("화면 저장 형식이 올바르지 않습니다.")?;
    let Some(world) = view.get("openWorld") else {
        return Ok(());
    };
    let world = world
        .as_object()
        .ok_or("오픈월드 저장 형식이 올바르지 않습니다.")?;
    if world
        .get("regionId")
        .is_some_and(|value| !value.is_string())
        || world
            .get("mapVersion")
            .is_some_and(|value| !value.is_string())
    {
        return Err("오픈월드 지역과 지도 버전이 올바르지 않습니다.");
    }
    let region = world.get("regionId").and_then(Value::as_str);
    let map_version = world.get("mapVersion").and_then(Value::as_str);
    match region {
        Some(region) => {
            let expected = WORLD_MAPS
                .iter()
                .find_map(|(id, map)| (*id == region).then_some(*map))
                .ok_or("오픈월드 지역이 올바르지 않습니다.")?;
            let legacy_kanto =
                region == "kanto" && (map_version.is_none() || map_version == Some("kanto-v1"));
            if !legacy_kanto && map_version != Some(expected) {
                return Err("오픈월드 지도 버전이 지역과 일치하지 않습니다.");
            }
        }
        None => {
            if !matches!(map_version, None | Some("kanto-v1") | Some("kanto-v2")) {
                return Err("기존 오픈월드 지도 버전이 올바르지 않습니다.");
            }
        }
    }
    if let Some(ids) = world.get("visitedTownIds") {
        validate_town_ids(ids)?;
    }
    if let Some(regions) = world.get("visitedTownsByRegion") {
        let regions = regions
            .as_object()
            .filter(|regions| regions.len() <= WORLD_MAPS.len())
            .ok_or("지역별 방문 기록이 올바르지 않습니다.")?;
        for (region, ids) in regions {
            if !WORLD_MAPS.iter().any(|(id, _)| id == region) {
                return Err("지역별 방문 기록이 올바르지 않습니다.");
            }
            validate_town_ids(ids)?;
        }
    }
    Ok(())
}

pub fn validate_save(value: &Value) -> Result<(), &'static str> {
    if value.get("format") != Some(&Value::String("choketmon".into()))
        || value.get("version") != Some(&Value::from(2))
        || value.get("model") != Some(&Value::String("pokemon-recurrent-v1".into()))
    {
        return Err("저장 파일 형식이 올바르지 않습니다.");
    }
    if value.get("graph") != Some(expected_graph()) {
        return Err("저장 파일의 커넥톰이 서버 원본과 일치하지 않습니다.");
    }
    let game = value.get("game").ok_or("게임 저장 데이터가 없습니다.")?;
    integer(game.get("schemaVersion"), 2, 2)?;
    let seed = game
        .get("seed")
        .and_then(Value::as_str)
        .ok_or("게임 시드가 올바르지 않습니다.")?;
    if seed.is_empty() || seed.len() > 200 {
        return Err("게임 시드가 올바르지 않습니다.");
    }
    integer(game.get("rngState"), 1, u32::MAX as i64)?;
    if game
        .get("experienceShare")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("경험치 공유 설정이 올바르지 않습니다.");
    }
    let next_instance_id = integer(game.get("nextInstanceId"), 1, MAX_SAFE_INTEGER)?;
    let player = game
        .get("player")
        .ok_or("플레이어 저장 데이터가 없습니다.")?;
    integer(player.get("money"), 0, MAX_SAFE_INTEGER)?;
    let badges = integer(player.get("badges"), 0, 8)?;
    let team = array(player, "team")?;
    let box_monsters = array(player, "box")?;
    if team.is_empty() || team.len() > 6 || box_monsters.len() > 10_000 {
        return Err("팀 또는 박스의 개체 수가 올바르지 않습니다.");
    }
    let inventory = object(game, "inventory")?;
    if inventory.len() != INVENTORY_ITEMS.len()
        || INVENTORY_ITEMS
            .iter()
            .any(|item| !inventory.contains_key(*item))
    {
        return Err("가방 품목 구성이 올바르지 않습니다.");
    }
    for item in INVENTORY_ITEMS {
        integer(inventory.get(item), 0, 1_000_000_000)?;
    }
    let defeated = array(game, "defeatedGyms")?;
    if defeated.len() != badges as usize
        || defeated
            .iter()
            .enumerate()
            .any(|(index, badge)| badge.as_i64() != Some(index as i64 + 1))
    {
        return Err("배지 진행이 올바르지 않습니다.");
    }
    if !game.get("championDefeated").is_some_and(Value::is_boolean)
        || game["championDefeated"] == true && badges != 8
    {
        return Err("챔피언 진행이 올바르지 않습니다.");
    }

    let mut ids = HashSet::new();
    let mut owned_species = HashSet::new();
    for monster in team.iter().chain(box_monsters) {
        validate_monster(monster, &mut ids, true, &mut owned_species)?;
    }
    if let Some(offer) = game.get("captureOffer") {
        validate_monster(offer, &mut ids, false, &mut owned_species)?;
        if offer.get("hp").and_then(Value::as_i64) != Some(0) || game.get("battle").is_some() {
            return Err("승리 후 포획 대상이 올바르지 않습니다.");
        }
    }
    if let Some(battle) = game.get("battle") {
        let enemy = battle
            .get("enemy")
            .ok_or("전투 상대가 올바르지 않습니다.")?;
        let enemies = array(enemy, "team")?;
        if enemies.is_empty() || enemies.len() > 6 {
            return Err("전투 상대 팀이 올바르지 않습니다.");
        }
        integer(enemy.get("activeIndex"), 0, enemies.len() as i64 - 1)?;
        for monster in enemies {
            validate_monster(monster, &mut ids, false, &mut owned_species)?;
        }
        let battle_player = battle
            .get("player")
            .ok_or("전투 플레이어가 올바르지 않습니다.")?;
        if array(battle_player, "team")? != team {
            return Err("전투 팀과 플레이어 팀이 일치하지 않습니다.");
        }
        integer(battle_player.get("activeIndex"), 0, team.len() as i64 - 1)?;
    }
    let dex = game.get("dex").ok_or("도감 저장 데이터가 없습니다.")?;
    let seen = array(dex, "seen")?;
    let caught = array(dex, "caught")?;
    let validate_dex = |items: &Vec<Value>| -> Result<HashSet<i64>, &'static str> {
        let mut set = HashSet::new();
        let mut prior = 0;
        for item in items {
            let id = integer(Some(item), 1, i64::MAX)?;
            if !catalog().species.contains_key(&id) || id <= prior || !set.insert(id) {
                return Err("도감 번호가 중복되었거나 순서가 올바르지 않습니다.");
            }
            prior = id;
        }
        Ok(set)
    };
    let seen = validate_dex(seen)?;
    let caught = validate_dex(caught)?;
    if !caught.is_subset(&seen) || !owned_species.is_subset(&caught) {
        return Err("발견·포획 도감과 보유 포켓몬이 일치하지 않습니다.");
    }
    let adventure_version = game
        .get("adventureVersion")
        .and_then(Value::as_str)
        .unwrap_or("red");
    if !catalog().versions.contains_key(adventure_version) {
        return Err("수집 버전이 올바르지 않습니다.");
    }
    if let Some(version_caught) = game.get("versionCaught") {
        let version_caught = version_caught
            .as_object()
            .ok_or("버전별 도감이 올바르지 않습니다.")?;
        if version_caught.len() > catalog().versions.len() {
            return Err("버전별 도감이 올바르지 않습니다.");
        }
        for (version, ids) in version_caught {
            let allowed = catalog()
                .versions
                .get(version)
                .ok_or("수집 버전이 올바르지 않습니다.")?;
            let ids = ids.as_array().ok_or("버전별 도감이 올바르지 않습니다.")?;
            let mut unique = HashSet::new();
            for id in ids {
                let id = integer(Some(id), 1, i64::MAX)?;
                if !allowed.contains(&id) || !caught.contains(&id) || !unique.insert(id) {
                    return Err("버전별 포획 기록이 올바르지 않습니다.");
                }
            }
        }
    }
    if let Some(seconds) = game.get("ballRefillSeconds") {
        let seconds = seconds
            .as_f64()
            .ok_or("볼 보충 기록이 올바르지 않습니다.")?;
        if !seconds.is_finite() || !(0.0..30.0).contains(&seconds) {
            return Err("볼 보충 기록이 올바르지 않습니다.");
        }
    }
    let logs = array(game, "logs")?;
    if logs.len() > 200
        || logs.iter().any(|log| {
            log.as_str()
                .is_none_or(|message| message.chars().count() > 500)
        })
    {
        return Err("게임 기록이 올바르지 않습니다.");
    }
    let maximum_generated_id = ids
        .iter()
        .filter_map(|id| id.strip_prefix("mon-")?.parse::<i64>().ok())
        .max()
        .unwrap_or(0);
    if next_instance_id <= maximum_generated_id {
        return Err("다음 개체 ID가 기존 개체보다 커야 합니다.");
    }
    validate_open_world(value.get("view"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_monster() -> Value {
        let species = catalog().species.get(&1).unwrap();
        let stats = expected_stats(species, 5);
        let learned = species.moves.iter().find(|entry| entry.level <= 5).unwrap();
        let pp = catalog().moves.get(&learned.move_id).unwrap().pp;
        serde_json::json!({
            "instanceId":"mon-1", "speciesId":1, "nickname":"starter", "level":5,
            "xp":experience_at_level(species, 5).unwrap(), "hp":stats[0],
            "stats":{"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]},
            "moves":[{"moveId":learned.move_id,"pp":pp}]
        })
    }

    fn valid_save() -> Value {
        serde_json::json!({
            "format":"choketmon", "version":2, "model":"pokemon-recurrent-v1", "savedAt":"2026-09-13T00:00:00.000Z",
            "graph":expected_graph().clone(),
            "game":{"schemaVersion":2,"seed":"test","rngState":1,"nextInstanceId":2,
                "player":{"money":3000,"badges":0,"team":[valid_monster()],"box":[]},
                "inventory":{"poke-ball":8,"great-ball":0,"ultra-ball":0,"potion":3,"super-potion":0,"rare-candy":0,"fire-stone":0,"water-stone":0,"thunder-stone":0,"leaf-stone":0,"moon-stone":0,"link-cable":0},
                "dex":{"seen":[1],"caught":[1]},"regionId":"safari-meadow","defeatedGyms":[],"championDefeated":false,"logs":[]},
            "view":{"learning":true,"position":{"x":1,"y":1,"steps":0}}
        })
    }

    #[test]
    fn accepts_consistent_save() {
        validate_save(&valid_save()).unwrap();
    }

    #[test]
    fn validates_optional_move_order_against_current_unique_moves() {
        let mut save = valid_save();
        let move_id = save["game"]["player"]["team"][0]["moves"][0]["moveId"].clone();
        save["game"]["player"]["team"][0]["moveOrder"] = serde_json::json!([move_id]);
        validate_save(&save).unwrap();

        for invalid in [
            serde_json::json!([move_id, move_id]),
            serde_json::json!([999_999]),
            serde_json::json!([1, 2, 3, 4, 5]),
            Value::Null,
        ] {
            let mut edited = save.clone();
            edited["game"]["player"]["team"][0]["moveOrder"] = invalid;
            assert!(validate_save(&edited).is_err());
        }
    }

    #[test]
    fn validates_unequipped_move_pp_without_allowing_a_pp_refresh() {
        let mut save = valid_save();
        let species_id = save["game"]["player"]["team"][0]["speciesId"]
            .as_i64()
            .unwrap();
        let level = save["game"]["player"]["team"][0]["level"].as_i64().unwrap();
        let equipped = save["game"]["player"]["team"][0]["moves"][0]["moveId"]
            .as_i64()
            .unwrap();
        let reserve_id = catalog()
            .species
            .get(&species_id)
            .unwrap()
            .moves
            .iter()
            .find(|entry| entry.level <= level && entry.move_id != equipped)
            .unwrap()
            .move_id;
        let maximum = catalog().moves.get(&reserve_id).unwrap().pp;
        let object = |id: i64, pp: i64| {
            Value::Object(serde_json::Map::from_iter([(
                id.to_string(),
                Value::from(pp),
            )]))
        };
        save["game"]["player"]["team"][0]["movePpReserve"] = object(reserve_id, maximum - 1);
        validate_save(&save).unwrap();

        for invalid in [
            object(equipped, 0),
            object(reserve_id, maximum + 1),
            serde_json::json!({"999999": 0}),
            Value::Null,
        ] {
            let mut edited = save.clone();
            edited["game"]["player"]["team"][0]["movePpReserve"] = invalid;
            assert!(validate_save(&edited).is_err());
        }
    }

    #[test]
    fn rejects_edited_species_stats_experience_pp_duplicates_and_graph() {
        for mutate in [
            "species",
            "stats",
            "xp",
            "pp",
            "duplicate",
            "graph",
            "version",
        ] {
            let mut save = valid_save();
            match mutate {
                "species" => save["game"]["player"]["team"][0]["speciesId"] = Value::from(99_999),
                "stats" => {
                    save["game"]["player"]["team"][0]["stats"]["attack"] = Value::from(9_999)
                }
                "xp" => save["game"]["player"]["team"][0]["xp"] = Value::from(MAX_SAFE_INTEGER),
                "pp" => save["game"]["player"]["team"][0]["moves"][0]["pp"] = Value::from(99_999),
                "duplicate" => save["game"]["player"]["box"] = serde_json::json!([valid_monster()]),
                "graph" => save["graph"]["id"] = Value::String("forged".into()),
                "version" => save["game"]["adventureVersion"] = Value::String("hacked".into()),
                _ => unreachable!(),
            }
            assert!(validate_save(&save).is_err(), "{mutate} must be rejected");
        }
    }

    #[test]
    fn generated_experience_tables_define_every_species_and_level_100_cap() {
        for species in catalog().species.values() {
            assert_eq!(species.experience.len(), 100, "species {}", species.id);
            assert!(
                species
                    .experience
                    .windows(2)
                    .all(|levels| levels[0] <= levels[1])
            );
            let level = 100;
            let stats = expected_stats(species, level);
            let monster = serde_json::json!({
                "instanceId":format!("species-{}", species.id), "speciesId":species.id,
                "nickname":"test", "level":level, "xp":species.experience[99], "hp":stats[0],
                "stats":{"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]},
                "moves":[]
            });
            validate_monster(&monster, &mut HashSet::new(), false, &mut HashSet::new()).unwrap();
            let mut edited = monster;
            edited["xp"] = Value::from(species.experience[99] + 1);
            assert!(
                validate_monster(&edited, &mut HashSet::new(), false, &mut HashSet::new()).is_err()
            );
        }
    }

    #[test]
    fn validates_regional_open_world_heads_and_visit_shape() {
        let mut save = valid_save();
        save["view"]["openWorld"] = serde_json::json!({
            "regionId":"paldea", "mapVersion":"paldea-atlas-v1",
            "visitedTownIds":["cabo-poco"],
            "visitedTownsByRegion":{"kanto":["pallet"],"paldea":["cabo-poco"]}
        });
        validate_save(&save).unwrap();

        let mut wrong_map = save.clone();
        wrong_map["view"]["openWorld"]["mapVersion"] = Value::String("kanto-v2".into());
        assert!(validate_save(&wrong_map).is_err());

        let mut unknown_region = save.clone();
        unknown_region["view"]["openWorld"]["regionId"] = Value::String("missing".into());
        assert!(validate_save(&unknown_region).is_err());

        let mut duplicate_visit = save;
        duplicate_visit["view"]["openWorld"]["visitedTownsByRegion"]["paldea"] =
            serde_json::json!(["cabo-poco", "cabo-poco"]);
        assert!(validate_save(&duplicate_visit).is_err());
    }
}
