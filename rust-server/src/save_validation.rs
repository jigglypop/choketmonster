use serde::Deserialize;
use crate::combat_forms::{
    CombatForm, combat_form, field_item_exists, held_tool_valid_for_species,
    mega_model_available, mega_stone_matches,
};
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

// Allow-lists hold every key a released client has written on these objects. The client keeps
// unknown keys when it loads a save, so keys that older releases wrote are still accepted.
const SAVE_KEYS: [&str; 8] = [
    "format", "version", "model", "savedAt", "graph", "game", "view", "tradeEpoch",
];
const GAME_KEYS: [&str; 24] = [
    "schemaVersion", "seed", "rngState", "nextInstanceId", "player", "nursery", "inventory",
    "dex", "regionId", "defeatedGyms", "defeatedFieldTrainers", "championDefeated", "campaign",
    "claimedRegionalStarters", "experienceShare", "autoMergeDuplicates", "adventureVersion",
    "versionCaught", "ballRefillSeconds", "evolutionContext", "technicalMachines", "battle",
    "captureOffer", "logs",
];
const PLAYER_KEYS: [&str; 4] = ["money", "badges", "team", "box"];
const DEX_KEYS: [&str; 2] = ["seen", "caught"];
const MONSTER_KEYS: [&str; 23] = [
    "instanceId", "speciesId", "nickname", "originRegion", "gender", "level", "xp", "hp",
    "stats", "ivs", "ability", "heldTool", "preferredTransformation", "regionalForm", "moves",
    "taughtMoves", "moveOrder", "movePpReserve", "status", "statusTurns", "brain",
    "moveLearning", "evolutionProgress",
];
const STAT_KEYS: [&str; 6] = [
    "hp", "attack", "defense", "specialAttack", "specialDefense", "speed",
];
const MOVE_SLOT_KEYS: [&str; 2] = ["moveId", "pp"];
const MOVE_LEARNING_KEYS: [&str; 4] = ["choices", "executed", "effective", "reward"];
const EGG_KEYS: [&str; 7] = [
    "eggId", "speciesId", "parentIds", "steps", "requiredSteps", "brain", "createdAtStep",
];
/// Monster and egg brains; `packSave` strips their `graph`.
const BRAIN_KEYS: [&str; 10] = [
    "schema", "seed", "inputWeights", "readout", "activity", "previous", "action", "rng",
    "updates", "sensoryBypass",
];
const BATTLE_KEYS: [&str; 17] = [
    "kind", "regionId", "player", "enemy", "turn", "canRun", "policyRegion", "awaitingSwitch",
    "gymBadge", "campaignRegion", "trainerId", "statStages", "transformations",
    "playerMegaUsed", "playerTeraUsed", "choiceLocks", "consumedTools",
];
const BATTLE_SIDE_KEYS: [&str; 2] = ["team", "activeIndex"];
const TRANSFORMATION_KEYS: [&str; 9] = [
    "speciesId", "stats", "moves", "types", "ability", "kind", "formIdentifier", "hpAdjusted",
    "teraType",
];
const BATTLE_STATS: [&str; 7] = [
    "attack", "defense", "specialAttack", "specialDefense", "speed", "accuracy", "evasion",
];
const VIEW_KEYS: [&str; 10] = [
    "position", "learning", "learningDefaultsVersion", "rewards", "field", "fieldPreferences",
    "openWorld", "openWorldPaused", "tradeTransferProvenance",
    // Written by the trade server for a receiver without a field or world snapshot.
    "tradeCompanionMemories",
];
const OPEN_WORLD_KEYS: [&str; 41] = [
    "schema", "model", "graphId", "seed", "rng", "tick", "serverFinalizations", "player",
    "selectedWildId", "autoCapture", "autoHunt", "battleWildId", "worldClockSeconds",
    "fieldItemPickupStates", "battleElapsed", "pendingCapture", "pendingBall",
    "lastPlayerReward", "lastEnemyReward", "pendingAction", "manualControlRemaining",
    "nextBattleTeamIndex", "controlMode", "selectionPinned", "trackingSelected",
    "visitedTownIds", "visitedTownsByRegion", "rewardLedgers", "regionId", "sceneId",
    "surfaceReturn", "mapVersion", "densityRemaining", "spawnAnchor", "encounterLayout",
    "spawnSerial", "nextFoodId", "foods", "respawnQueue", "entities", "companionMemories",
];
const WORLD_ENTITY_KEYS: [&str; 15] = [
    "id", "kind", "speciesId", "level", "x", "z", "heading", "energy", "brain", "observation",
    "action", "reward", "foods", "collisions", "target",
];
const WORLD_RESPAWN_KEYS: [&str; 7] = [
    "id", "speciesId", "level", "biome", "originX", "originZ", "remainingSeconds",
];
const FIELD_KEYS: [&str; 12] = [
    "schema", "model", "graphId", "seed", "rng", "tick", "recurrentEnabled", "player", "foods",
    "nextFoodId", "entities", "memories",
];
const FIELD_ENTITY_KEYS: [&str; 13] = [
    "id", "speciesId", "x", "y", "heading", "energy", "brain", "lastObservation", "target",
    "action", "reward", "foods", "collisions",
];
const FIELD_MODEL: &str = "pokemon-field-recurrent-v1";
const REWARD_MODEL: &str = "kanto-engineered-reward-v1";
const REWARD_COMPONENTS: [&str; 8] = [
    "engagement", "damageDealt", "damageReceived", "typeChoice", "moveEffect", "outcome",
    "growth", "evolution",
];
/// Regions of the classic map and the Kanto badges each one needs (`src/game/regions.ts`).
const MAP_REGIONS: [(&str, i64); 9] = [
    ("safari-meadow", 0),
    ("verdant-forest", 1),
    ("azure-shore", 2),
    ("silph-city", 3),
    ("moon-cavern", 4),
    ("rough-badlands", 5),
    ("crown-mountain", 6),
    ("seafoam-depths", 7),
    ("cerulean-cave", 8),
];

fn known_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

/// The instance IDs the client allocates. Its loader refuses any other form, and IDs beyond
/// sixteen digits exceed every `nextInstanceId` a save can hold.
pub(crate) fn generated_instance_id(id: &str) -> bool {
    id.strip_prefix("mon-").is_some_and(|digits| {
        (1..=16).contains(&digits.len())
            && !digits.starts_with('0')
            && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

/// JavaScript `string.length`: the client bounds names in UTF-16 code units.
fn utf16_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn finite_value(value: Option<&Value>, absolute_maximum: f64) -> bool {
    value.is_some_and(|value| finite_number(value, absolute_maximum))
}

fn safe_count(value: Option<&Value>, maximum: i64) -> bool {
    value
        .and_then(Value::as_i64)
        .is_some_and(|number| (0..=maximum).contains(&number))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldTrainerRecord {
    id: String,
    region: String,
    location_id: String,
    team: Vec<(i64, i64)>,
}
fn field_trainer_catalog() -> &'static Vec<FieldTrainerRecord> {
    static TRAINERS: OnceLock<Vec<FieldTrainerRecord>> = OnceLock::new();
    TRAINERS.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/data/trainer-battle-catalog.json"))
            .expect("checked trainer catalog")
    })
}
fn field_trainer(id: &str) -> Option<&'static FieldTrainerRecord> {
    static TRAINER_INDEX: OnceLock<HashMap<String, usize>> = OnceLock::new();
    let trainers = field_trainer_catalog();
    let index = TRAINER_INDEX.get_or_init(|| {
        trainers
            .iter()
            .enumerate()
            .map(|(index, trainer)| (trainer.id.clone(), index))
            .collect()
    });
    index.get(id).map(|index| &trainers[*index])
}
const REQUIRED_INVENTORY_ITEMS: [&str; 12] = [
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

// Added after schemaVersion 2 shipped. Their absence is interpreted as zero by the client,
// while the original inventory shape remains mandatory for legacy-save integrity.
const OPTIONAL_INVENTORY_ITEMS: [&str; 48] = [
    "sun-stone",
    "shiny-stone",
    "dusk-stone",
    "dawn-stone",
    "ice-stone",
    "metal-coat",
    "kings-rock",
    "dragon-scale",
    "up-grade",
    "protector",
    "electirizer",
    "magmarizer",
    "dubious-disc",
    "reaper-cloth",
    "deep-sea-tooth",
    "deep-sea-scale",
    "prism-scale",
    "razor-claw",
    "razor-fang",
    "oval-stone",
    "galarica-cuff",
    "galarica-wreath",
    "black-augurite",
    "peat-block",
    "sachet",
    "whipped-dream",
    "tart-apple",
    "sweet-apple",
    "syrupy-apple",
    "cracked-pot",
    "chipped-pot",
    "metal-alloy",
    "scroll-of-darkness",
    "scroll-of-waters",
    "auspicious-armor",
    "malicious-armor",
    "unremarkable-teacup",
    "masterpiece-teacup",
    "evolution-catalyst",
    "friendship-treat",
    "beauty-treat",
    "affection-treat",
    "leftovers",
    "choice-band",
    "choice-specs",
    "choice-scarf",
    "life-orb",
    "focus-sash",
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
    #[serde(default)]
    machine_moves: Vec<i64>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AbilitySource {
    id: i64,
    slot: i64,
    hidden: bool,
    slug: String,
    name: String,
    english_name: String,
}

struct Catalog {
    species: HashMap<i64, Species>,
    moves: HashMap<i64, Move>,
    versions: HashMap<String, HashSet<i64>>,
}

static CATALOG: OnceLock<Catalog> = OnceLock::new();
static TECHNICAL_MACHINES: OnceLock<HashMap<i64, Vec<u8>>> = OnceLock::new();

#[derive(Deserialize)]
struct TechnicalMachineFile {
    machines: Vec<TechnicalMachineRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TechnicalMachineRecord {
    move_id: i64,
    species: String,
}

/// Machine move ID to its species compatibility bitset (species n is bit n - 1, most significant bit first).
fn technical_machines() -> &'static HashMap<i64, Vec<u8>> {
    TECHNICAL_MACHINES.get_or_init(|| {
        let parsed: TechnicalMachineFile =
            serde_json::from_str(include_str!("../../src/data/technical-machines.json"))
                .expect("technical machine catalog");
        parsed
            .machines
            .into_iter()
            .map(|machine| {
                let bits = hex::decode(&machine.species).expect("technical machine bitset");
                (machine.move_id, bits)
            })
            .collect()
    })
}

fn technical_machine_compatible(move_id: i64, species_id: i64) -> bool {
    if species_id < 1 {
        return false;
    }
    let index = (species_id - 1) as usize;
    technical_machines()
        .get(&move_id)
        .and_then(|bits| bits.get(index / 8))
        .is_some_and(|byte| byte & (0x80 >> (index % 8)) != 0)
}
static GRAPH: OnceLock<Value> = OnceLock::new();
static ABILITIES: OnceLock<HashMap<i64, Vec<AbilitySource>>> = OnceLock::new();

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

fn abilities() -> &'static HashMap<i64, Vec<AbilitySource>> {
    ABILITIES.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/data/pokemon-abilities-validation.json"
        )))
        .expect("generated Pokemon ability catalog must be valid JSON")
    })
}

/// Held tools spent once per battle. Their holders are the only valid `consumedTools` entries.
pub(crate) const CONSUMABLE_HELD_TOOLS: [&str; 7] = [
    "focus-sash",
    "oran-berry",
    "sitrus-berry",
    "lum-berry",
    "white-herb",
    "weakness-policy",
    "air-balloon",
];

/// Eviolite applies only to species that still have an evolution in the pinned catalog.
pub(crate) fn species_can_evolve(species_id: i64) -> bool {
    catalog()
        .species
        .get(&species_id)
        .is_some_and(|species| !species.evolutions.is_empty())
}

pub(crate) fn species_available_in_version(version: &str, species_id: i64) -> bool {
    catalog()
        .versions
        .get(version)
        .is_some_and(|species| species.contains(&species_id))
}

pub(crate) fn species_exists(species_id: i64) -> bool {
    catalog().species.contains_key(&species_id)
}

/// Species that evolve into `species_id`, indexed once instead of scanning every species.
fn pre_evolutions(species_id: i64) -> &'static [i64] {
    static PARENTS: OnceLock<HashMap<i64, Vec<i64>>> = OnceLock::new();
    PARENTS
        .get_or_init(|| {
            let mut parents: HashMap<i64, Vec<i64>> = HashMap::new();
            for species in catalog().species.values() {
                for evolution in &species.evolutions {
                    parents.entry(evolution.target).or_default().push(species.id);
                }
            }
            parents
        })
        .get(&species_id)
        .map_or(&[], Vec::as_slice)
}

/// The Alolan combat form of each species that has one; the client stores no other regional kind.
fn alola_form(species_id: i64) -> Option<&'static CombatForm> {
    static FORMS: OnceLock<HashMap<i64, &'static CombatForm>> = OnceLock::new();
    FORMS
        .get_or_init(|| {
            #[derive(Deserialize)]
            struct FormHead {
                identifier: String,
                kind: String,
            }
            #[derive(Deserialize)]
            struct FormFile {
                forms: Vec<FormHead>,
            }
            let parsed: FormFile = serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/data/pokemon-combat-forms.json"
            )))
            .expect("combat form catalog");
            parsed
                .forms
                .iter()
                .filter(|form| form.kind == "alola")
                .filter_map(|form| combat_form(&form.identifier))
                .map(|form| (form.species_id, form))
                .collect()
        })
        .get(&species_id)
        .copied()
}

/// Gender ratio per species from the client's generated breeding table (-1 genderless, 0..8 female eighths).
fn gender_rates() -> &'static HashMap<i64, i64> {
    static RATES: OnceLock<HashMap<i64, i64>> = OnceLock::new();
    RATES.get_or_init(|| {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Breeding {
            gender_rate: i64,
        }
        let source = include_str!("../../src/data/breeding.generated.ts");
        let declaration = source
            .find("export const BREEDING_SPECIES")
            .expect("breeding species table");
        let start = declaration + source[declaration..].find('{').expect("breeding table start");
        let end = start + source[start..].find("};").expect("breeding table end") + 1;
        let parsed: HashMap<String, Breeding> =
            serde_json::from_str(&source[start..end]).expect("breeding table must be JSON");
        parsed
            .into_iter()
            .map(|(id, row)| (id.parse().expect("breeding species id"), row.gender_rate))
            .collect()
    })
}

/// `isValidGender` in `src/game/breeding.ts`.
fn valid_gender(species_id: i64, gender: &Value) -> bool {
    let gender = gender.as_str();
    match gender_rates().get(&species_id) {
        Some(-1) => gender == Some("genderless"),
        Some(0) => gender == Some("male"),
        Some(8) => gender == Some("female"),
        _ => matches!(gender, Some("male" | "female")),
    }
}

/// `tileAt` in `src/game/map.ts`: trees, water and buildings block the classic map.
fn map_walkable(x: i64, y: i64) -> bool {
    let tree = x < 1 || y < 1 || x >= 23 || y >= 14;
    let water = (17..=21).contains(&x) && (9..=12).contains(&y);
    let building = (3..=6).contains(&x) && (3..=5).contains(&y)
        || (16..=20).contains(&x) && (2..=4).contains(&y);
    !tree && !water && !building
}

fn map_tile(value: &Value, x_key: &str, y_key: &str) -> Option<(i64, i64)> {
    let x = value.get(x_key)?.as_i64()?;
    let y = value.get(y_key)?.as_i64()?;
    (x >= 0 && y >= 0 && map_walkable(x, y)).then_some((x, y))
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

#[cfg(test)]
fn expected_stats(species: &Species, level: i64) -> [i64; 6] {
    expected_stats_with_ivs(species, level, [0; 6])
}

fn expected_stats_with_ivs(species: &Species, level: i64, ivs: [i64; 6]) -> [i64; 6] {
    expected_stats_from_base(&species.base_stats, level, ivs)
}

fn expected_stats_from_base(base: &Stats, level: i64, ivs: [i64; 6]) -> [i64; 6] {
    let normal = |base, iv| (2 * base + iv) * level / 100 + 5;
    [
        (2 * base.hp + ivs[0]) * level / 100 + level + 10,
        normal(base.attack, ivs[1]),
        normal(base.defense, ivs[2]),
        normal(base.special_attack, ivs[3]),
        normal(base.special_defense, ivs[4]),
        normal(base.speed, ivs[5]),
    ]
}

fn form_stats(identifier: &str, level: i64, ivs: [i64; 6]) -> Result<[i64; 6], &'static str> {
    let form = combat_form(identifier).ok_or("지원하지 않는 포켓몬 모습입니다.")?;
    let base = form.base_stats;
    Ok(expected_stats_from_base(&Stats { hp: base.hp, attack: base.attack, defense: base.defense,
        special_attack: base.special_attack, special_defense: base.special_defense, speed: base.speed }, level, ivs))
}

fn adjusted_mega_maximum_hp(
    monster: &Value,
    transformations: Option<&serde_json::Map<String, Value>>,
) -> Result<Option<i64>, &'static str> {
    let Some(instance_id) = monster.get("instanceId").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(form_value) = transformations.and_then(|forms| forms.get(instance_id)) else {
        return Ok(None);
    };
    let form = form_value
        .as_object()
        .ok_or("전투 변신 기록이 올바르지 않습니다.")?;
    let Some(hp_adjusted) = form.get("hpAdjusted") else {
        return Ok(None);
    };
    if hp_adjusted.as_bool() != Some(true)
        || form.get("kind").and_then(Value::as_str) != Some("mega")
    {
        return Err("메가진화 HP 조정 기록이 올바르지 않습니다.");
    }
    let species_id = integer(monster.get("speciesId"), 1, i64::MAX)?;
    let profile = form
        .get("formIdentifier")
        .and_then(Value::as_str)
        .and_then(combat_form)
        .filter(|profile| {
            profile.kind == "mega"
                && profile.species_id == species_id
                && mega_model_available(&profile.identifier)
        })
        .ok_or("메가진화 모습이 올바르지 않습니다.")?;
    let level = integer(monster.get("level"), 1, 100)?;
    let ivs = validate_individual_traits(monster, species_id)?;
    Ok(Some(form_stats(&profile.identifier, level, ivs)?[0]))
}

fn validate_individual_traits(monster: &Value, species_id: i64) -> Result<[i64; 6], &'static str> {
    match (monster.get("ivs"), monster.get("ability")) {
        // Regional forms arrived after individual traits, so a legacy trait-less save never has
        // one; the loader's species fallback ability would not match the form anyway.
        (None, None) if monster.get("regionalForm").is_some() => {
            return Err("지역 모습 특성 정보가 올바르지 않습니다.");
        }
        (None, None) => return Ok([0; 6]),
        (Some(_), None) | (None, Some(_)) => return Err("개체값과 특성은 함께 저장해야 합니다."),
        _ => {}
    }
    let ivs = object(monster, "ivs")?;
    let fields = [
        "hp",
        "attack",
        "defense",
        "specialAttack",
        "specialDefense",
        "speed",
    ];
    if ivs.len() != fields.len() || fields.iter().any(|field| !ivs.contains_key(*field)) {
        return Err("개체값 구성이 올바르지 않습니다.");
    }
    let values = [
        integer(ivs.get("hp"), 0, 31)?,
        integer(ivs.get("attack"), 0, 31)?,
        integer(ivs.get("defense"), 0, 31)?,
        integer(ivs.get("specialAttack"), 0, 31)?,
        integer(ivs.get("specialDefense"), 0, 31)?,
        integer(ivs.get("speed"), 0, 31)?,
    ];
    let ability = object(monster, "ability")?;
    let required = [
        "id",
        "slot",
        "hidden",
        "slug",
        "name",
        "englishName",
        "effect",
        "description",
    ];
    if ability.len() != required.len() || required.iter().any(|field| !ability.contains_key(*field))
    {
        return Err("특성 구성이 올바르지 않습니다.");
    }
    let id = integer(ability.get("id"), 1, MAX_SAFE_INTEGER)?;
    let slot = integer(ability.get("slot"), 1, 3)?;
    if let Some(identifier) = monster.get("regionalForm") {
        let form = identifier.as_str().and_then(combat_form)
            .filter(|form| form.species_id == species_id && form.kind == "alola")
            .ok_or("지역 모습이 원본 종과 맞지 않습니다.")?;
        let source = form.abilities.iter().find(|entry| entry.id == id && entry.slot == slot)
            .ok_or("특성이 원본 모습/슬롯 데이터와 맞지 않습니다.")?;
        if ability.get("hidden").and_then(Value::as_bool) != Some(source.hidden)
            || ability.get("slug").and_then(Value::as_str) != Some(source.slug.as_str())
            || ability.get("name").and_then(Value::as_str) != Some(source.name.as_str())
            || ability.get("englishName").and_then(Value::as_str) != Some(source.english_name.as_str())
            || ability.get("effect").and_then(Value::as_str) != Some(ability_effect(&source.slug))
            || ability.get("description").and_then(Value::as_str).is_none_or(|text| text.is_empty() || text.chars().count() > 240) {
            return Err("지역 모습 특성 정보가 올바르지 않습니다.");
        }
        return Ok(values);
    }
    let source = abilities()
        .get(&species_id)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.id == id && entry.slot == slot)
        })
        .ok_or("특성이 원본 종/슬롯 데이터와 맞지 않습니다.")?;
    if ability.get("hidden").and_then(Value::as_bool) != Some(source.hidden)
        || ability.get("slug").and_then(Value::as_str) != Some(source.slug.as_str())
        || ability.get("name").and_then(Value::as_str) != Some(source.name.as_str())
        || ability.get("englishName").and_then(Value::as_str) != Some(source.english_name.as_str())
    {
        return Err("특성 원본 정보가 변조되었습니다.");
    }
    let expected_effect = ability_effect(&source.slug);
    if ability.get("effect").and_then(Value::as_str) != Some(expected_effect)
        || ability
            .get("description")
            .and_then(Value::as_str)
            .is_none_or(|text| text.is_empty() || text.chars().count() > 240)
    {
        return Err("특성 효과 표시가 올바르지 않습니다.");
    }
    Ok(values)
}

fn finite_number(value: &Value, absolute_maximum: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number.abs() <= absolute_maximum)
}

fn ability_effect(slug: &str) -> &'static str {
    match slug {
        "overgrow" | "blaze" | "torrent" | "swarm" | "levitate" | "sturdy" | "water-absorb"
        | "volt-absorb" => "implemented",
        "flash-fire" | "lightning-rod" | "motor-drive" | "sap-sipper" | "storm-drain"
        | "dry-skin" | "insomnia" | "vital-spirit" | "comatose" | "soundproof" | "good-as-gold" => {
            "partial"
        }
        _ => "display-only",
    }
}

fn validate_evolution_progress(monster: &Value) -> Result<(), &'static str> {
    let Some(value) = monster.get("evolutionProgress") else {
        return Ok(());
    };
    let progress = value
        .as_object()
        .ok_or("진화 진행 기록이 올바르지 않습니다.")?;
    const FIELDS: [&str; 11] = [
        "gender",
        "friendship",
        "beauty",
        "affection",
        "steps",
        "damageTaken",
        "recoilDamage",
        "criticalHits",
        "defeatedBisharp",
        "coins",
        "moveUses",
    ];
    if progress.len() != FIELDS.len() || FIELDS.iter().any(|field| !progress.contains_key(*field)) {
        return Err("진화 진행 기록 구성이 올바르지 않습니다.");
    }
    if !matches!(
        progress.get("gender").and_then(Value::as_str),
        Some("female" | "male" | "genderless")
    ) {
        return Err("포켓몬 성별 기록이 올바르지 않습니다.");
    }
    for field in ["friendship", "beauty", "affection"] {
        integer(progress.get(field), 0, 255)?;
    }
    for field in [
        "steps",
        "damageTaken",
        "recoilDamage",
        "criticalHits",
        "defeatedBisharp",
        "coins",
    ] {
        integer(progress.get(field), 0, 1_000_000_000)?;
    }
    let move_uses = progress
        .get("moveUses")
        .and_then(Value::as_object)
        .filter(|uses| uses.len() <= 1000)
        .ok_or("진화 기술 사용 기록이 올바르지 않습니다.")?;
    for (move_id, count) in move_uses {
        if move_id
            .parse::<i64>()
            .ok()
            .is_none_or(|id| !(1..=1000).contains(&id) || id.to_string() != *move_id)
        {
            return Err("진화 기술 ID가 올바르지 않습니다.");
        }
        integer(Some(count), 0, 1_000_000_000)?;
    }
    Ok(())
}

fn validate_evolution_context(game: &Value) -> Result<(), &'static str> {
    let Some(value) = game.get("evolutionContext") else {
        return Ok(());
    };
    let context = value
        .as_object()
        .ok_or("진화 환경 기록이 올바르지 않습니다.")?;
    const FIELDS: [&str; 5] = ["period", "regionId", "locationId", "raining", "multiplayer"];
    if context.len() != FIELDS.len() || FIELDS.iter().any(|field| !context.contains_key(*field)) {
        return Err("진화 환경 기록 구성이 올바르지 않습니다.");
    }
    if !matches!(
        context.get("period").and_then(Value::as_str),
        Some("day" | "night" | "dusk")
    ) {
        return Err("진화 시간대 기록이 올바르지 않습니다.");
    }
    for (field, maximum) in [("regionId", 40), ("locationId", 100)] {
        if context
            .get(field)
            .and_then(Value::as_str)
            .is_none_or(|value| value.chars().count() > maximum)
        {
            return Err("진화 위치 기록이 올바르지 않습니다.");
        }
    }
    if ["raining", "multiplayer"]
        .iter()
        .any(|field| context.get(*field).is_none_or(|value| !value.is_boolean()))
    {
        return Err("진화 환경 상태가 올바르지 않습니다.");
    }
    Ok(())
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
    // packSave intentionally removes every nested `graph`; accepting one here
    // would let a forged topology enter a client-side brain after restoration.
    if brain.get("graph").is_some() {
        return Err("개체 체크포인트에는 별도 그래프를 저장할 수 없습니다.");
    }
    if !brain.as_object().is_some_and(|fields| known_keys(fields, &BRAIN_KEYS)) {
        return Err("저장 파일의 객체 필드가 올바르지 않습니다.");
    }
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
    // Brain.restore needs `previous` present (null between decisions) and the loader
    // accepts only an explicitly disabled sensory bypass.
    let previous = brain
        .get("previous")
        .ok_or("신경 학습 특징이 올바르지 않습니다.")?;
    if !previous.is_null() {
        let previous = previous
            .as_array()
            .ok_or("신경 학습 특징이 올바르지 않습니다.")?;
        if previous.len() != node_count + 12
            || previous.iter().any(|item| !finite_number(item, 1.0))
        {
            return Err("신경 학습 특징이 올바르지 않습니다.");
        }
    }
    if brain.get("sensoryBypass") != Some(&Value::Bool(false)) {
        return Err("신경 감각 우회 설정이 올바르지 않습니다.");
    }
    Ok(())
}

/// Field and open-world creature brains, checked as `Brain.restore` does after the loader
/// swaps their `graphId` for the save's graph.
fn valid_record_brain(brain: Option<&Value>) -> bool {
    let Some(brain) = brain.and_then(Value::as_object) else {
        return false;
    };
    let Some(node_count) = expected_graph()["nodes"].as_array().map(Vec::len) else {
        return false;
    };
    let vector = |value: Option<&Value>, size: usize| {
        value.and_then(Value::as_array).is_some_and(|items| {
            items.len() == size && items.iter().all(|item| finite_number(item, 100.0))
        })
    };
    let matrix = |value: Option<&Value>, rows: usize, columns: usize| {
        value.and_then(Value::as_array).is_some_and(|items| {
            items.len() == rows && items.iter().all(|row| vector(Some(row), columns))
        })
    };
    brain.keys().all(|key| key == "graphId" || BRAIN_KEYS.contains(&key.as_str()))
        && brain.get("graphId") == expected_graph().get("id")
        && brain.get("sensoryBypass") == Some(&Value::Bool(false))
        && brain.get("schema").and_then(Value::as_i64) == Some(1)
        && matrix(brain.get("inputWeights"), node_count, 12)
        && matrix(brain.get("readout"), 5, node_count + 12)
        && vector(brain.get("activity"), node_count)
        && brain
            .get("previous")
            .is_some_and(|previous| previous.is_null() || vector(Some(previous), node_count + 12))
        && safe_count(brain.get("seed"), u32::MAX as i64)
        && safe_count(brain.get("rng"), u32::MAX as i64)
        && safe_count(brain.get("action"), 4)
        && safe_count(brain.get("updates"), MAX_SAFE_INTEGER)
}

/// One open-world creature (`restore` in `src/openworld/simulation.ts`). Terrain needs the
/// region atlas, so positions are bounded to the world square only.
pub(crate) fn valid_world_record(record: &Value) -> bool {
    let Some(entity) = record.as_object() else {
        return false;
    };
    known_keys(entity, &WORLD_ENTITY_KEYS)
        && entity
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty() && id.len() <= 200)
        && matches!(
            entity.get("kind").and_then(Value::as_str),
            Some("wild" | "companion")
        )
        && entity
            .get("speciesId")
            .and_then(Value::as_i64)
            .is_some_and(species_exists)
        && entity
            .get("level")
            .and_then(Value::as_i64)
            .is_some_and(|level| (1..=100).contains(&level))
        && finite_value(entity.get("x"), 240.0)
        && finite_value(entity.get("z"), 240.0)
        && safe_count(entity.get("heading"), 4)
        && safe_count(entity.get("action"), 4)
        && entity
            .get("energy")
            .and_then(Value::as_f64)
            .is_some_and(|energy| energy.is_finite() && (0.0..=100.0).contains(&energy))
        && finite_value(entity.get("reward"), 10.0)
        && safe_count(entity.get("foods"), MAX_SAFE_INTEGER)
        && safe_count(entity.get("collisions"), MAX_SAFE_INTEGER)
        && entity
            .get("observation")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.len() == 12 && items.iter().all(|item| finite_number(item, f64::MAX))
            })
        && entity
            .get("target")
            .is_none_or(|target| validate_world_point(target).is_ok())
        && valid_record_brain(entity.get("brain"))
}

/// One classic-map field creature (`unpack` in `src/game/field.ts`).
pub(crate) fn valid_field_record(record: &Value) -> bool {
    let Some(entity) = record.as_object() else {
        return false;
    };
    known_keys(entity, &FIELD_ENTITY_KEYS)
        && entity
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty() && id.len() <= 200)
        && entity
            .get("speciesId")
            .and_then(Value::as_i64)
            .is_some_and(species_exists)
        && map_tile(record, "x", "y").is_some()
        && safe_count(entity.get("heading"), 4)
        && safe_count(entity.get("action"), 4)
        && entity
            .get("energy")
            .and_then(Value::as_f64)
            .is_some_and(|energy| energy.is_finite() && (0.0..=100.0).contains(&energy))
        && finite_value(entity.get("reward"), 10.0)
        && safe_count(entity.get("foods"), MAX_SAFE_INTEGER)
        && safe_count(entity.get("collisions"), MAX_SAFE_INTEGER)
        && entity
            .get("lastObservation")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.len() == 12 && items.iter().all(|item| finite_number(item, f64::MAX))
            })
        && entity.get("target").is_none_or(|target| {
            safe_count(target.get("foodId"), MAX_SAFE_INTEGER)
                && target.get("foodId").and_then(Value::as_i64) != Some(0)
                && map_tile(target, "x", "y").is_some()
        })
        && valid_record_brain(entity.get("brain"))
}

/// `validateRewardLedger` in `src/game/rewards.ts`, for the ledger stored under `id`.
/// A missing `moveEffect` is the legacy shape the client fills with zero.
pub(crate) fn valid_reward_ledger(ledger: &Value, id: &str) -> bool {
    let Some(fields) = ledger.as_object() else {
        return false;
    };
    let components = |value: Option<&Value>, bound: f64| {
        value.and_then(Value::as_object).is_some_and(|parts| {
            known_keys(parts, &REWARD_COMPONENTS)
                && REWARD_COMPONENTS.iter().all(|component| match parts.get(*component) {
                    None => *component == "moveEffect",
                    value => finite_value(value, bound),
                })
        })
    };
    let Some(lifetime) = fields.get("lifetime").and_then(Value::as_object) else {
        return false;
    };
    let Some(counts) = lifetime.get("eventCounts").and_then(Value::as_object) else {
        return false;
    };
    let counted = |key: &str| {
        counts
            .get(key)
            .and_then(Value::as_i64)
            .filter(|count| (0..=1_000_000_000).contains(count))
    };
    let (Some(engagement), Some(battle)) = (counted("engagement"), counted("battle")) else {
        return false;
    };
    let lifetime_valid = known_keys(
        lifetime,
        &["events", "eventCounts", "total", "componentTotals", "componentCounts"],
    ) && known_keys(counts, &["engagement", "battle"])
        && lifetime.get("events").and_then(Value::as_i64) == Some(engagement + battle)
        && safe_count(lifetime.get("events"), 2_000_000_000)
        && finite_value(lifetime.get("total"), 1e9)
        && components(lifetime.get("componentTotals"), 1e9)
        && lifetime
            .get("componentCounts")
            .and_then(Value::as_object)
            .is_some_and(|parts| {
                known_keys(parts, &REWARD_COMPONENTS)
                    && REWARD_COMPONENTS.iter().all(|component| match parts.get(*component) {
                        None => *component == "moveEffect",
                        value => safe_count(value, 1_000_000_000),
                    })
            });
    let entry_valid = |entry: &Value| {
        let Some(item) = entry.as_object() else {
            return false;
        };
        let source = item.get("source").and_then(Value::as_str);
        let learning = item.get("learningEligible").and_then(Value::as_bool);
        let total = item.get("total").and_then(Value::as_f64);
        let sum = item.get("breakdown").map(|parts| {
            REWARD_COMPONENTS
                .iter()
                .map(|component| parts.get(*component).and_then(Value::as_f64).unwrap_or(0.0))
                .sum::<f64>()
        });
        known_keys(
            item,
            &["event", "tick", "source", "learningEligible", "total", "breakdown"],
        ) && matches!(
            item.get("event").and_then(Value::as_str),
            Some("engagement" | "battle")
        ) && safe_count(item.get("tick"), MAX_SAFE_INTEGER)
            && matches!(source, Some("connectome" | "manual" | "fallback"))
            && learning.is_some_and(|eligible| !eligible || source == Some("connectome"))
            && finite_value(item.get("total"), 2.0)
            && components(item.get("breakdown"), 2.0)
            && matches!((sum, total), (Some(sum), Some(total)) if (sum.clamp(-2.0, 2.0) - total).abs() <= 1e-9)
    };
    known_keys(fields, &["rewardModel", "individualId", "latest", "lifetime"])
        && fields.get("rewardModel").and_then(Value::as_str) == Some(REWARD_MODEL)
        && fields.get("individualId").and_then(Value::as_str) == Some(id)
        && !id.is_empty()
        && utf16_length(id) <= 200
        && lifetime_valid
        && fields
            .get("latest")
            .and_then(Value::as_array)
            .is_some_and(|entries| entries.len() <= 32 && entries.iter().all(entry_valid))
}

fn validate_nursery(game: &Value, ids: &mut HashSet<String>) -> Result<(), &'static str> {
    let Some(value) = game.get("nursery") else {
        return Ok(());
    };
    let eggs = value
        .as_array()
        .filter(|eggs| eggs.len() <= 6)
        .ok_or("알 보관함이 올바르지 않습니다.")?;
    for egg in eggs {
        if !egg.as_object().is_some_and(|fields| known_keys(fields, &EGG_KEYS)) {
            return Err("알 보관함이 올바르지 않습니다.");
        }
        let egg_id = egg
            .get("eggId")
            .and_then(Value::as_str)
            .filter(|id| {
                id.starts_with("egg-")
                    && id.len() <= 120
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            })
            .ok_or("알 ID가 올바르지 않습니다.")?;
        if !ids.insert(egg_id.to_owned()) {
            return Err("알 ID가 중복되었습니다.");
        }
        let species_id = integer(egg.get("speciesId"), 1, MAX_SAFE_INTEGER)?;
        if !catalog().species.contains_key(&species_id) {
            return Err("알의 포켓몬 종이 올바르지 않습니다.");
        }
        let parents = egg
            .get("parentIds")
            .and_then(Value::as_array)
            .filter(|items| items.len() == 2)
            .ok_or("알의 부모 기록이 올바르지 않습니다.")?;
        let first = parents[0]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 120)
            .ok_or("알의 부모 기록이 올바르지 않습니다.")?;
        let second = parents[1]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 120)
            .ok_or("알의 부모 기록이 올바르지 않습니다.")?;
        if first == second {
            return Err("알의 부모 기록이 올바르지 않습니다.");
        }
        let required = integer(egg.get("requiredSteps"), 256, 65_536)?;
        if required % 256 != 0 {
            return Err("알의 부화 걸음이 올바르지 않습니다.");
        }
        integer(egg.get("steps"), 0, required)?;
        integer(egg.get("createdAtStep"), 1, MAX_SAFE_INTEGER)?;
        validate_brain(egg.get("brain").ok_or("알의 회로 상태가 없습니다.")?)?;
    }
    Ok(())
}

fn validate_monster(
    monster: &Value,
    ids: &mut HashSet<String>,
    owned: bool,
    owned_species: &mut HashSet<i64>,
    maximum_hp_override: Option<i64>,
) -> Result<(), &'static str> {
    if !monster.as_object().is_some_and(|fields| known_keys(fields, &MONSTER_KEYS)) {
        return Err("저장 파일의 객체 필드가 올바르지 않습니다.");
    }
    validate_evolution_progress(monster)?;
    if let Some(origin) = monster.get("originRegion") {
        let origin = origin
            .as_str()
            .ok_or("포켓몬 출신 지방 기록이 올바르지 않습니다.")?;
        if !matches!(
            origin,
            "kanto"
                | "johto"
                | "hoenn"
                | "sinnoh"
                | "unova"
                | "kalos"
                | "alola"
                | "galar"
                | "hisui"
                | "paldea"
        ) {
            return Err("포켓몬 출신 지방 기록이 올바르지 않습니다.");
        }
    }
    let instance_id = monster
        .get("instanceId")
        .and_then(Value::as_str)
        .ok_or("개체 ID가 올바르지 않습니다.")?;
    if !generated_instance_id(instance_id) || !ids.insert(instance_id.to_owned()) {
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
    // An absent gender is derived on load; a stored one must fit the species ratio.
    if monster
        .get("gender")
        .is_some_and(|gender| !valid_gender(species_id, gender))
    {
        return Err("포켓몬 성별 기록이 올바르지 않습니다.");
    }
    if let Some(preferred) = monster.get("preferredTransformation") {
        if !owned {
            return Err("소유 포켓몬만 선호 변신을 설정할 수 있습니다.");
        }
        let preferred = preferred
            .as_object()
            .ok_or("선호 변신 설정이 올바르지 않습니다.")?;
        match preferred.get("kind").and_then(Value::as_str) {
            Some("mega") => {
                if preferred.len() != 2
                    || !preferred.contains_key("formIdentifier")
                    || preferred
                        .get("formIdentifier")
                        .and_then(Value::as_str)
                        .and_then(combat_form)
                        .filter(|form| {
                            form.kind == "mega"
                                && form.species_id == species_id
                                && mega_model_available(&form.identifier)
                        })
                        .is_none()
                {
                    return Err("선호 메가진화 설정이 올바르지 않습니다.");
                }
            }
            Some("tera") => {
                if preferred.len() != 2
                    || !matches!(
                        preferred.get("teraType").and_then(Value::as_str),
                        Some(
                            "normal" | "fire" | "water" | "electric" | "grass" | "ice"
                                | "fighting" | "poison" | "ground" | "flying" | "psychic"
                                | "bug" | "rock" | "ghost" | "dragon" | "dark" | "steel"
                                | "fairy"
                        )
                    )
                {
                    return Err("선호 테라스탈 설정이 올바르지 않습니다.");
                }
            }
            _ => return Err("선호 변신 종류가 올바르지 않습니다."),
        }
    }
    let ivs = validate_individual_traits(monster, species_id)?;
    if monster.get("heldTool").is_some_and(|value| {
        value
            .as_str()
            .is_none_or(|identifier| !held_tool_valid_for_species(identifier, species_id))
    }) {
        return Err("장착 도구가 올바르지 않습니다.");
    }
    if let Some(form) = monster.get("regionalForm") {
        let form = form
            .as_str()
            .and_then(combat_form)
            .filter(|form| form.kind == "alola")
            .ok_or("지역 모습이 올바르지 않습니다.")?;
        if species_id != form.species_id {
            return Err("지역 모습이 원본 종과 맞지 않습니다.");
        }
    }
    let nickname = monster
        .get("nickname")
        .and_then(Value::as_str)
        .ok_or("포켓몬 이름이 올바르지 않습니다.")?;
    if nickname.is_empty() || utf16_length(nickname) > 40 {
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
    if !known_keys(stats, &STAT_KEYS) {
        return Err("계산 능력치가 종과 레벨에 맞지 않습니다.");
    }
    for (field, expected) in [
        "hp",
        "attack",
        "defense",
        "specialAttack",
        "specialDefense",
        "speed",
    ]
    .into_iter()
    .zip(if let Some(identifier) = monster.get("regionalForm").and_then(Value::as_str) { form_stats(identifier, level, ivs)? } else { expected_stats_with_ivs(species, level, ivs) })
    {
        if integer(stats.get(field), 1, 10_000)? != expected {
            return Err("계산 능력치가 종과 레벨에 맞지 않습니다.");
        }
    }
    let maximum_hp = maximum_hp_override.unwrap_or_else(|| stats["hp"].as_i64().unwrap());
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
    // An earlier Alolan form's learnset counts too: evolving keeps those moves,
    // and an Alolan Meowth may even become a Perrserker without a regional form.
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
        if form != species_id
            && let Some(regional) = alola_form(form)
        {
            legal.extend(
                regional
                    .level_up_moves
                    .iter()
                    .filter(|learned| learned.level <= level)
                    .map(|learned| learned.move_id),
            );
        }
        forms.extend_from_slice(pre_evolutions(form));
    }
    if let Some(entry) = catalog().species.get(&species_id) {
        legal.extend(entry.machine_moves.iter().copied());
    }
    if let Some(taught) = monster.get("taughtMoves") {
        let taught = taught
            .as_array()
            .ok_or("기술머신으로 배운 기술이 올바르지 않습니다.")?;
        if taught.len() > 64 {
            return Err("기술머신으로 배운 기술이 올바르지 않습니다.");
        }
        let mut seen = HashSet::new();
        for value in taught {
            let move_id = integer(Some(value), 1, MAX_SAFE_INTEGER)?;
            if !technical_machines().contains_key(&move_id) || !seen.insert(move_id) {
                return Err("기술머신으로 배운 기술이 올바르지 않습니다.");
            }
            if visited.iter().any(|form| technical_machine_compatible(move_id, *form)) {
                legal.insert(move_id);
            }
        }
    }
    if let Some(form) = monster.get("regionalForm").and_then(Value::as_str).and_then(combat_form) { legal.extend(form.level_up_moves.iter().filter(|entry| entry.level <= level).map(|entry| entry.move_id)); }
    let mut move_ids = HashSet::new();
    for slot in moves {
        if !slot.as_object().is_some_and(|fields| known_keys(fields, &MOVE_SLOT_KEYS)) {
            return Err("저장 파일의 객체 필드가 올바르지 않습니다.");
        }
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
            // The loader accepts only decimal digits (`/^\d+$/`); `parse` would also take a sign.
            if move_id.is_empty()
                || !move_id.bytes().all(|byte| byte.is_ascii_digit())
                || move_id
                    .parse::<i64>()
                    .ok()
                    .is_none_or(|id| !catalog().moves.contains_key(&id))
            {
                return Err("기술 학습 기록의 기술이 올바르지 않습니다.");
            }
            if !record
                .as_object()
                .is_some_and(|fields| known_keys(fields, &MOVE_LEARNING_KEYS))
            {
                return Err("기술 학습 기록이 올바르지 않습니다.");
            }
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
    ("kanto", "kanto-v3"),
    ("johto", "johto-v3"),
    ("hoenn", "hoenn-authored-v1"),
    ("sinnoh", "sinnoh-authored-v1"),
    ("unova", "unova-authored-v1"),
    ("kalos", "kalos-authored-v1"),
    ("alola", "alola-authored-v1"),
    ("galar", "galar-authored-v1"),
    ("hisui", "hisui-authored-v1"),
    ("paldea", "paldea-authored-v1"),
];

fn is_legacy_expansion_map(region: Option<&str>, map_version: Option<&str>) -> bool {
    matches!(
        (region, map_version),
        (Some("hoenn"), Some("hoenn-atlas-v1" | "hoenn-atlas-v2"))
            | (Some("sinnoh"), Some("sinnoh-atlas-v1" | "sinnoh-atlas-v2"))
            | (Some("unova"), Some("unova-atlas-v1" | "unova-atlas-v2"))
            | (Some("galar"), Some("galar-atlas-v1"))
            | (Some("hisui"), Some("hisui-atlas-v1"))
            | (Some("paldea"), Some("paldea-atlas-v1"))
    )
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

fn valid_world_scene(region: &str, scene: &str) -> bool {
    if scene == format!("surface:{region}") {
        return true;
    }
    // Gym and league halls are keyed by the region and the location they stand in.
    for hall in ["gym", "league"] {
        if let Some(location) = scene.strip_prefix(&format!("{hall}:{region}:")) {
            return !location.is_empty()
                && location.len() <= 64
                && location.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        }
    }
    let Some(id) = scene.strip_prefix(&format!("cave:{region}:")) else {
        return false;
    };
    dungeon_scenes()
        .get(region)
        .is_some_and(|ids| ids.contains(id))
}

fn validate_world_point(value: &Value) -> Result<(), &'static str> {
    let point = value
        .as_object()
        .ok_or("오픈월드 좌표가 올바르지 않습니다.")?;
    if !point
        .get("x")
        .is_some_and(|value| finite_number(value, 240.0))
        || !point
            .get("z")
            .is_some_and(|value| finite_number(value, 240.0))
    {
        return Err("오픈월드 좌표가 올바르지 않습니다.");
    }
    Ok(())
}

const KANTO_GYM_REGIONS: [&str; 8] = [
    "safari-meadow",
    "verdant-forest",
    "azure-shore",
    "silph-city",
    "moon-cavern",
    "rough-badlands",
    "crown-mountain",
    "seafoam-depths",
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

/// The open-world snapshot. Companions belong to `owned` (team and box); reward ledgers may
/// also belong to battle opponents and the capture offer in `owners`.
fn validate_open_world(
    world: &Value,
    owned: &HashSet<&str>,
    owners: &HashSet<&str>,
) -> Result<(), &'static str> {
    let world = world
        .as_object()
        .filter(|world| known_keys(world, &OPEN_WORLD_KEYS))
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
            let legacy_kanto = region == "kanto"
                && matches!(map_version, None | Some("kanto-v1") | Some("kanto-v2"));
            let legacy_johto = region == "johto"
                && matches!(map_version, Some("johto-v2") | Some("johto-atlas-v1"));
            let legacy_expansion = is_legacy_expansion_map(Some(region), map_version);
            if !legacy_kanto && !legacy_johto && !legacy_expansion && map_version != Some(expected)
            {
                return Err("오픈월드 지도 버전이 지역과 일치하지 않습니다.");
            }
        }
        None => {
            if !matches!(map_version, None | Some("kanto-v1") | Some("kanto-v2")) {
                return Err("기존 오픈월드 지도 버전이 올바르지 않습니다.");
            }
        }
    }
    if let Some(layout) = world.get("encounterLayout") {
        let layout = layout
            .as_str()
            .ok_or("오픈월드 출현표 버전이 올바르지 않습니다.")?;
        let expected = match region {
            Some("johto") => "gold-v1",
            Some(
                "hoenn" | "sinnoh" | "unova" | "kalos" | "alola" | "galar" | "hisui" | "paldea",
            ) => "expansion-v1",
            _ => "red-v1",
        };
        if layout != expected
            && !(is_legacy_expansion_map(region, map_version) && layout == "red-v1")
        {
            return Err("오픈월드 출현표 버전이 지역과 일치하지 않습니다.");
        }
    } else if matches!(
        region,
        Some("hoenn" | "sinnoh" | "unova" | "kalos" | "alola" | "galar" | "hisui" | "paldea")
    ) && !is_legacy_expansion_map(region, map_version)
    {
        return Err("추가 지방 오픈월드 출현표 버전이 필요합니다.");
    }
    if let Some(scene) = world.get("sceneId") {
        let scene = scene.as_str().ok_or("오픈월드 장면이 올바르지 않습니다.")?;
        let region = region.ok_or("오픈월드 장면에는 지역이 필요합니다.")?;
        if !valid_world_scene(region, scene) {
            return Err("오픈월드 장면이 지역과 일치하지 않습니다.");
        }
    }
    if let Some(seconds) = world.get("worldClockSeconds")
        && !seconds
            .as_f64()
            .is_some_and(|seconds| seconds.is_finite() && (0.0..1200.0).contains(&seconds))
    {
        return Err("오픈월드 시간이 올바르지 않습니다.");
    }
    if let Some(states) = world.get("fieldItemPickupStates") {
        let slots = states.as_object().ok_or("길가 물품 상태가 올바르지 않습니다.")?;
        if slots.len() > 240 { return Err("길가 물품 상태가 너무 많습니다."); }
        for (id, state) in slots {
            let parts: Vec<_> = id.split(':').collect();
            if parts.len() != 3 || parts[0] != "field-item"
                || !matches!(parts[1], "kanto" | "johto" | "hoenn" | "sinnoh" | "unova" | "kalos" | "alola" | "galar" | "hisui" | "paldea")
                || !parts[2].parse::<u8>().is_ok_and(|slot| slot < 24 && parts[2] == slot.to_string())
                || !state.get("remainingSeconds").and_then(Value::as_f64).is_some_and(|seconds| seconds.is_finite() && (0.0..=1800.0).contains(&seconds))
                || !state.get("collectedCount").and_then(Value::as_u64).is_some_and(|count| count <= 1_000_000_000)
            { return Err("길가 물품 대기 시간이 올바르지 않습니다."); }
        }
    }
    if let Some(index) = world.get("nextBattleTeamIndex")
        && !index.as_i64().is_some_and(|index| (0..=5).contains(&index))
    {
        return Err("자동 전투 순서가 올바르지 않습니다.");
    }
    for key in ["player", "spawnAnchor"] {
        if let Some(point) = world.get(key) {
            validate_world_point(point)?;
        }
    }
    if let Some(surface_return) = world.get("surfaceReturn") {
        validate_world_point(surface_return)?;
        let expected = region.map(|region| format!("surface:{region}"));
        if surface_return.get("sceneId").and_then(Value::as_str) != expected.as_deref() {
            return Err("동굴 복귀 장면이 지역과 일치하지 않습니다.");
        }
    }
    if let Some(items) = world.get("foods") {
        let items = items
            .as_array()
            .ok_or("오픈월드 좌표 목록이 올바르지 않습니다.")?;
        for item in items {
            validate_world_point(item)?;
        }
    }
    // Creatures are restored with their brains, and the loader wants exactly one active
    // companion, companion-only memories, unique IDs and companions of owned Pokémon.
    let mut entity_ids = HashSet::new();
    for (key, memories) in [("entities", false), ("companionMemories", true)] {
        let Some(items) = world.get(key) else {
            continue;
        };
        let items = items
            .as_array()
            .ok_or("오픈월드 좌표 목록이 올바르지 않습니다.")?;
        let mut companions = 0;
        for item in items {
            if !valid_world_record(item) {
                return Err("오픈월드 좌표 목록이 올바르지 않습니다.");
            }
            let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            let companion = item.get("kind").and_then(Value::as_str) == Some("companion");
            if !entity_ids.insert(id)
                || memories && !companion
                || companion
                    && !id
                        .strip_prefix("companion:")
                        .is_some_and(|instance| owned.contains(instance))
            {
                return Err("오픈월드 좌표 목록이 올바르지 않습니다.");
            }
            companions += usize::from(companion);
        }
        if !memories && companions != 1 {
            return Err("오픈월드 좌표 목록이 올바르지 않습니다.");
        }
    }
    if let Some(items) = world.get("respawnQueue") {
        let items = items
            .as_array()
            .ok_or("오픈월드 재등장 좌표가 올바르지 않습니다.")?;
        for item in items {
            if !item
                .as_object()
                .is_some_and(|fields| known_keys(fields, &WORLD_RESPAWN_KEYS))
                || !item
                    .get("originX")
                    .is_some_and(|value| finite_number(value, 240.0))
                || !item
                    .get("originZ")
                    .is_some_and(|value| finite_number(value, 240.0))
            {
                return Err("오픈월드 재등장 좌표가 올바르지 않습니다.");
            }
        }
    }
    if let Some(ledgers) = world.get("rewardLedgers") {
        let ledgers = ledgers
            .as_object()
            .ok_or("오픈월드 저장 형식이 올바르지 않습니다.")?;
        if ledgers
            .iter()
            .any(|(id, ledger)| !owners.contains(id.as_str()) || !valid_reward_ledger(ledger, id))
        {
            return Err("오픈월드 저장 형식이 올바르지 않습니다.");
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

/// The legacy classic-map field snapshot (`FieldSimulation` in `src/game/field.ts`).
fn validate_field(field: &Value) -> Result<(), &'static str> {
    const INVALID: &str = "들판 기억이 올바르지 않습니다.";
    let snapshot = field
        .as_object()
        .filter(|snapshot| known_keys(snapshot, &FIELD_KEYS))
        .ok_or(INVALID)?;
    let entities = snapshot
        .get("entities")
        .and_then(Value::as_array)
        .filter(|entities| entities.len() <= 6)
        .ok_or(INVALID)?;
    let memories = snapshot
        .get("memories")
        .and_then(Value::as_array)
        .ok_or(INVALID)?;
    let foods = snapshot
        .get("foods")
        .and_then(Value::as_array)
        .ok_or(INVALID)?;
    let next_food = snapshot
        .get("nextFoodId")
        .and_then(Value::as_i64)
        .filter(|id| (1..=MAX_SAFE_INTEGER).contains(id))
        .ok_or(INVALID)?;
    let player = snapshot
        .get("player")
        .filter(|player| player.as_object().is_some_and(|player| known_keys(player, &["x", "y"])))
        .and_then(|player| map_tile(player, "x", "y"))
        .ok_or(INVALID)?;
    if snapshot.get("schema").and_then(Value::as_i64) != Some(1)
        || snapshot.get("model").and_then(Value::as_str) != Some(FIELD_MODEL)
        || snapshot.get("graphId") != expected_graph().get("id")
        || !safe_count(snapshot.get("seed"), u32::MAX as i64)
        || !safe_count(snapshot.get("rng"), u32::MAX as i64)
        || !safe_count(snapshot.get("tick"), MAX_SAFE_INTEGER)
        || !snapshot.get("recurrentEnabled").is_some_and(Value::is_boolean)
    {
        return Err(INVALID);
    }
    let (mut food_ids, mut food_tiles) = (HashSet::new(), HashSet::new());
    for food in foods {
        let id = food
            .get("id")
            .and_then(Value::as_i64)
            .filter(|id| *id >= 1 && *id < next_food);
        let tile = map_tile(food, "x", "y");
        if !food.as_object().is_some_and(|food| known_keys(food, &["id", "x", "y"]))
            || !id.is_some_and(|id| food_ids.insert(id))
            || !tile.is_some_and(|tile| food_tiles.insert(tile))
        {
            return Err(INVALID);
        }
    }
    // Active creatures and the player each hold their own tile; food never sits under them.
    let (mut ids, mut occupied) = (HashSet::new(), HashSet::from([player]));
    for (index, record) in entities.iter().chain(memories).enumerate() {
        if !valid_field_record(record)
            || !ids.insert(record.get("id").and_then(Value::as_str).unwrap_or_default())
            || index < entities.len()
                && !map_tile(record, "x", "y").is_some_and(|tile| occupied.insert(tile))
        {
            return Err(INVALID);
        }
    }
    if food_tiles.iter().any(|tile| occupied.contains(tile)) {
        return Err(INVALID);
    }
    Ok(())
}

/// `ViewState`, checked as `unpackSave` in `src/game/storage.ts` checks it. `owned` holds the
/// team and box IDs, `owners` also the battle opponents and capture offer.
fn validate_view(
    view: Option<&Value>,
    owned: &HashSet<&str>,
    owners: &HashSet<&str>,
) -> Result<(), &'static str> {
    let view = view
        .and_then(Value::as_object)
        .ok_or("화면 저장 형식이 올바르지 않습니다.")?;
    if !known_keys(view, &VIEW_KEYS)
        || !view.get("learning").is_some_and(Value::is_boolean)
        || view
            .get("learningDefaultsVersion")
            .is_some_and(|version| version.as_f64() != Some(1.0))
    {
        return Err("화면 저장 형식이 올바르지 않습니다.");
    }
    let position = view.get("position");
    if !position.is_some_and(|position| {
        position
            .as_object()
            .is_some_and(|fields| known_keys(fields, &["x", "y", "steps"]))
            && map_tile(position, "x", "y").is_some()
            && safe_count(position.get("steps"), MAX_SAFE_INTEGER)
    }) {
        return Err("탐험 위치가 올바르지 않습니다.");
    }
    if let Some(rewards) = view.get("rewards")
        && !rewards.as_object().is_some_and(|rewards| {
            rewards
                .iter()
                .all(|(id, reward)| owners.contains(id.as_str()) && finite_number(reward, 100.0))
        })
    {
        return Err("신경 학습의 보상 기록이 올바르지 않습니다.");
    }
    if let Some(field) = view.get("field") {
        validate_field(field)?;
    }
    if let Some(preferences) = view.get("fieldPreferences")
        && !preferences.as_object().is_some_and(|preferences| {
            known_keys(preferences, &["paused", "learning", "selectedId"])
                && preferences.get("paused").is_some_and(Value::is_boolean)
                && preferences.get("learning").is_some_and(Value::is_boolean)
                && preferences
                    .get("selectedId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.len() <= 200)
        })
    {
        return Err("들판 설정이 올바르지 않습니다.");
    }
    if view.get("openWorldPaused").is_some_and(|paused| !paused.is_boolean()) {
        return Err("월드 정지 설정이 올바르지 않습니다.");
    }
    if let Some(provenance) = view.get("tradeTransferProvenance")
        && !provenance.as_object().is_some_and(|records| {
            records.len() <= 10_000
                && records.iter().all(|(id, record)| {
                    generated_instance_id(id)
                        && record.as_object().is_some_and(|record| {
                            known_keys(record, &["sourceInstanceId", "tradeId"])
                                && record
                                    .get("sourceInstanceId")
                                    .and_then(Value::as_str)
                                    .is_some_and(generated_instance_id)
                                && record.get("tradeId").is_none_or(|trade| {
                                    trade.as_str().is_some_and(|trade| {
                                        !trade.is_empty() && utf16_length(trade) <= 100
                                    })
                                })
                        })
                })
        })
    {
        return Err("거래 개체 출처 기록이 올바르지 않습니다.");
    }
    // The client never reads this stash; only its shape is bounded.
    if let Some(stash) = view.get("tradeCompanionMemories") {
        let record = |value: Option<&Value>, keys: &[&str]| {
            value.is_none_or(|value| value.as_object().is_some_and(|value| known_keys(value, keys)))
        };
        let valid = stash.as_object().is_some_and(|entries| {
            entries.iter().all(|(id, entry)| {
                generated_instance_id(id)
                    && entry.as_object().is_some_and(|entry| {
                        known_keys(entry, &["field", "openWorld", "rewardLedger"])
                            && record(entry.get("field"), &FIELD_ENTITY_KEYS)
                            && record(entry.get("openWorld"), &WORLD_ENTITY_KEYS)
                            && record(
                                entry.get("rewardLedger"),
                                &["rewardModel", "individualId", "latest", "lifetime"],
                            )
                    })
            })
        });
        if !valid {
            return Err("화면 저장 형식이 올바르지 않습니다.");
        }
    }
    if let Some(world) = view.get("openWorld") {
        validate_open_world(world, owned, owners)?;
    }
    Ok(())
}

struct CampaignProgress<'a> {
    start_region: &'a str,
    johto_badges: &'a Vec<Value>,
    kanto_league: i64,
    johto_league: i64,
    expansion: HashMap<&'a str, RegionalCampaignProgress>,
}

#[derive(Clone, Copy)]
struct RegionalCampaignProgress {
    badges: i64,
    league: i64,
}

fn validate_badge_order(value: &Value, message: &'static str) -> Result<i64, &'static str> {
    let badges = value.as_array().ok_or(message)?;
    if badges.len() > 8
        || badges
            .iter()
            .enumerate()
            .any(|(index, badge)| badge.as_i64() != Some(index as i64 + 1))
    {
        return Err(message);
    }
    Ok(badges.len() as i64)
}

fn validate_campaign(
    game: &Value,
    kanto_badges: i64,
    champion_defeated: bool,
) -> Result<Option<CampaignProgress<'_>>, &'static str> {
    let Some(campaign) = game.get("campaign") else {
        return Ok(None);
    };
    let campaign = campaign
        .as_object()
        .ok_or("캠페인 진행 형식이 올바르지 않습니다.")?;
    let required_fields = [
        "startRegion",
        "johtoBadges",
        "kantoLeague",
        "johtoLeague",
        "redDefeated",
    ];
    if campaign.len() > required_fields.len() + 1
        || required_fields
            .iter()
            .any(|field| !campaign.contains_key(*field))
        || campaign
            .keys()
            .any(|field| !required_fields.contains(&field.as_str()) && field != "expansion")
    {
        return Err("캠페인 진행 형식이 올바르지 않습니다.");
    }
    let start_region = campaign
        .get("startRegion")
        .and_then(Value::as_str)
        .filter(|region| matches!(*region, "johto" | "kanto"))
        .ok_or("캠페인 시작 지역이 올바르지 않습니다.")?;
    let johto_badges = campaign
        .get("johtoBadges")
        .and_then(Value::as_array)
        .ok_or("성도 배지 진행이 올바르지 않습니다.")?;
    validate_badge_order(
        campaign.get("johtoBadges").unwrap(),
        "성도 배지 진행이 올바르지 않습니다.",
    )?;
    let kanto_league = integer(campaign.get("kantoLeague"), 0, 5)?;
    let johto_league = integer(campaign.get("johtoLeague"), 0, 5)?;
    let red_defeated = campaign
        .get("redDefeated")
        .and_then(Value::as_bool)
        .ok_or("레드 진행이 올바르지 않습니다.")?;
    if (kanto_league > 0 && kanto_badges != 8) || (johto_league > 0 && johto_badges.len() != 8) {
        return Err("리그 진행과 배지 진행이 일치하지 않습니다.");
    }
    if start_region == "johto" && (kanto_badges > 0 || kanto_league > 0) && johto_league < 5 {
        return Err("성도 리그 완료 전에 관동을 진행할 수 없습니다.");
    }
    if (kanto_league == 5) != champion_defeated {
        return Err("관동 리그와 챔피언 진행이 일치하지 않습니다.");
    }
    if red_defeated
        && (kanto_badges != 8 || johto_badges.len() != 8 || kanto_league != 5 || johto_league != 5)
    {
        return Err("레드 진행 조건이 올바르지 않습니다.");
    }
    let mut expansion = HashMap::new();
    if let Some(value) = campaign.get("expansion") {
        let regions = value
            .as_object()
            .filter(|regions| regions.len() <= 8)
            .ok_or("추가 지방 진행 형식이 올바르지 않습니다.")?;
        for (region, value) in regions {
            if !matches!(
                region.as_str(),
                "hoenn" | "sinnoh" | "unova" | "kalos" | "alola" | "galar" | "hisui" | "paldea"
            ) {
                return Err("추가 지방 진행 형식이 올바르지 않습니다.");
            }
            let progress = value
                .as_object()
                .filter(|progress| {
                    progress.len() == 2
                        && progress.contains_key("badges")
                        && progress.contains_key("league")
                })
                .ok_or("추가 지방 배지·리그 진행이 올바르지 않습니다.")?;
            let badges = validate_badge_order(
                progress.get("badges").unwrap(),
                "추가 지방 배지·리그 진행이 올바르지 않습니다.",
            )?;
            let league = integer(progress.get("league"), 0, 5)?;
            if league > 0 && badges != 8 {
                return Err("추가 지방 리그 진행과 배지 진행이 일치하지 않습니다.");
            }
            expansion.insert(region.as_str(), RegionalCampaignProgress { badges, league });
        }
    }
    let progressed = |region: &str| {
        expansion
            .get(region)
            .is_some_and(|value| value.badges > 0 || value.league > 0)
    };
    if progressed("hoenn") && kanto_league < 5
        || progressed("sinnoh")
            && expansion
                .get("hoenn")
                .map_or(true, |value| value.league < 5)
        || progressed("unova")
            && expansion
                .get("sinnoh")
                .map_or(true, |value| value.league < 5)
        || progressed("kalos")
            && expansion
                .get("unova")
                .map_or(true, |value| value.league < 5)
        || progressed("alola")
            && expansion
                .get("kalos")
                .map_or(true, |value| value.league < 5)
        || progressed("galar")
            && expansion
                .get("alola")
                .map_or(true, |value| value.league < 5)
        || progressed("hisui")
            && expansion
                .get("galar")
                .map_or(true, |value| value.league < 5)
        || progressed("paldea")
            && expansion
                .get("hisui")
                .map_or(true, |value| value.league < 5)
    {
        return Err("추가 지방 캠페인 진행 순서가 올바르지 않습니다.");
    }
    Ok(Some(CampaignProgress {
        start_region,
        johto_badges,
        kanto_league,
        johto_league,
        expansion,
    }))
}

fn validate_battle_progress(
    game: &Value,
    battle: &Value,
    kanto_badges: i64,
    campaign: Option<&CampaignProgress<'_>>,
) -> Result<(), &'static str> {
    let kind = battle
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| {
            matches!(
                *kind,
                "wild" | "gym" | "trainer" | "elite" | "champion" | "red"
            )
        })
        .ok_or("전투 종류가 올바르지 않습니다.")?;
    let region_id = battle
        .get("regionId")
        .and_then(Value::as_str)
        .ok_or("전투 지역이 올바르지 않습니다.")?;
    integer(battle.get("turn"), 1, MAX_SAFE_INTEGER)?;
    let can_run = battle
        .get("canRun")
        .and_then(Value::as_bool)
        .ok_or("전투 도주 규칙이 올바르지 않습니다.")?;
    if (kind == "wild") != can_run {
        return Err("전투 도주 규칙이 올바르지 않습니다.");
    }
    if battle.get("policyRegion").is_some_and(|value| {
        !matches!(
            value.as_str(),
            Some(
                "kanto"
                    | "johto"
                    | "hoenn"
                    | "sinnoh"
                    | "unova"
                    | "kalos"
                    | "alola"
                    | "galar"
                    | "hisui"
                    | "paldea"
            )
        )
    }) {
        return Err("전투 사용 정책 지역이 올바르지 않습니다.");
    }

    let campaign_region = battle.get("campaignRegion");
    let trainer_id = battle.get("trainerId");
    if kind == "wild" {
        if campaign_region.is_some()
            || trainer_id.is_some()
            || battle.get("gymBadge").is_some()
            || game.get("regionId").and_then(Value::as_str) != Some(region_id)
        {
            return Err("야생 전투 진행이 올바르지 않습니다.");
        }
        return Ok(());
    }

    let Some(campaign_region) = campaign_region else {
        if trainer_id.is_some() || matches!(kind, "elite" | "red") {
            return Err("캠페인 전투 진행이 올바르지 않습니다.");
        }
        return match kind {
            "gym" => {
                if region_id != game.get("regionId").and_then(Value::as_str).unwrap_or("")
                    || integer(battle.get("gymBadge"), 1, 8)? != kanto_badges + 1
                {
                    Err("체육관 전투 진행이 올바르지 않습니다.")
                } else {
                    Ok(())
                }
            }
            "champion" => {
                if region_id != "pokemon-league"
                    || kanto_badges != 8
                    || battle.get("gymBadge").is_some()
                {
                    Err("챔피언 전투 진행이 올바르지 않습니다.")
                } else {
                    Ok(())
                }
            }
            _ => Err("캠페인 전투 진행이 올바르지 않습니다."),
        };
    };
    let campaign_region = campaign_region
        .as_str()
        .filter(|region| {
            matches!(
                *region,
                "johto"
                    | "kanto"
                    | "hoenn"
                    | "sinnoh"
                    | "unova"
                    | "kalos"
                    | "alola"
                    | "galar"
                    | "hisui"
                    | "paldea"
            )
        })
        .ok_or("캠페인 전투 지역이 올바르지 않습니다.")?;
    let campaign = campaign.ok_or("캠페인 전투 진행이 올바르지 않습니다.")?;
    if campaign_region == "kanto" && campaign.start_region == "johto" && campaign.johto_league < 5 {
        return Err("성도 리그 완료 전에 관동 전투를 저장할 수 없습니다.");
    }
    if campaign_region == "hoenn" && campaign.kanto_league < 5
        || campaign_region == "sinnoh"
            && campaign
                .expansion
                .get("hoenn")
                .map_or(true, |progress| progress.league < 5)
        || campaign_region == "unova"
            && campaign
                .expansion
                .get("sinnoh")
                .map_or(true, |progress| progress.league < 5)
        || campaign_region == "kalos"
            && campaign
                .expansion
                .get("unova")
                .map_or(true, |progress| progress.league < 5)
        || campaign_region == "alola"
            && campaign
                .expansion
                .get("kalos")
                .map_or(true, |progress| progress.league < 5)
        || campaign_region == "galar"
            && campaign
                .expansion
                .get("alola")
                .map_or(true, |progress| progress.league < 5)
        || campaign_region == "hisui"
            && campaign
                .expansion
                .get("galar")
                .map_or(true, |progress| progress.league < 5)
        || campaign_region == "paldea"
            && campaign
                .expansion
                .get("hisui")
                .map_or(true, |progress| progress.league < 5)
    {
        return Err("이전 지방 리그 완료 전에 추가 지방 전투를 저장할 수 없습니다.");
    }

    match kind {
        "trainer" => {
            let trainer = trainer_id
                .and_then(Value::as_str)
                .and_then(field_trainer)
                .ok_or("트레이너 정보가 올바르지 않습니다.")?;
            let enemy_team = battle
                .get("enemy")
                .and_then(|enemy| enemy.get("team"))
                .and_then(Value::as_array)
                .ok_or("트레이너 편성이 올바르지 않습니다.")?;
            if trainer.region != campaign_region
                || trainer.location_id != region_id
                || battle.get("gymBadge").is_some()
                || game
                    .get("defeatedFieldTrainers")
                    .and_then(Value::as_array)
                    .is_some_and(|ids| {
                        ids.iter()
                            .any(|id| id.as_str() == Some(trainer.id.as_str()))
                    })
                || enemy_team.len() != trainer.team.len()
                || enemy_team
                    .iter()
                    .zip(&trainer.team)
                    .any(|(monster, (species, level))| {
                        monster.get("speciesId").and_then(Value::as_i64) != Some(*species)
                            || monster.get("level").and_then(Value::as_i64) != Some(*level)
                    })
            {
                return Err("트레이너 배틀 진행이 올바르지 않습니다.");
            }
        }
        "gym" => {
            let completed = match campaign_region {
                "johto" => campaign.johto_badges.len() as i64,
                "kanto" => kanto_badges,
                expansion => campaign
                    .expansion
                    .get(expansion)
                    .map_or(0, |progress| progress.badges),
            };
            let expected_region = if campaign_region != "kanto" {
                "safari-meadow"
            } else {
                KANTO_GYM_REGIONS
                    .get(completed as usize)
                    .copied()
                    .ok_or("완료한 관동 체육관 전투를 저장할 수 없습니다.")?
            };
            if trainer_id.is_some()
                || region_id != expected_region
                || game.get("regionId").and_then(Value::as_str) != Some(expected_region)
                || integer(battle.get("gymBadge"), 1, 8)? != completed + 1
            {
                return Err("캠페인 체육관 전투 진행이 올바르지 않습니다.");
            }
        }
        "elite" | "champion" => {
            if battle.get("gymBadge").is_some() || region_id != "pokemon-league" {
                return Err("캠페인 리그 전투 진행이 올바르지 않습니다.");
            }
            let (league, trainers) = match campaign_region {
                "johto" => (
                    campaign.johto_league,
                    [
                        "johto-will",
                        "johto-koga",
                        "johto-bruno",
                        "johto-karen",
                        "johto-lance",
                    ],
                ),
                "kanto" => (
                    campaign.kanto_league,
                    [
                        "kanto-lorelei",
                        "kanto-bruno",
                        "kanto-agatha",
                        "kanto-lance",
                        "kanto-blue",
                    ],
                ),
                "hoenn" => (
                    campaign
                        .expansion
                        .get("hoenn")
                        .map_or(0, |progress| progress.league),
                    [
                        "hoenn-sidney",
                        "hoenn-phoebe",
                        "hoenn-glacia",
                        "hoenn-drake",
                        "hoenn-wallace",
                    ],
                ),
                "sinnoh" => (
                    campaign
                        .expansion
                        .get("sinnoh")
                        .map_or(0, |progress| progress.league),
                    [
                        "sinnoh-aaron",
                        "sinnoh-bertha",
                        "sinnoh-flint",
                        "sinnoh-lucian",
                        "sinnoh-cynthia",
                    ],
                ),
                "unova" => (
                    campaign
                        .expansion
                        .get("unova")
                        .map_or(0, |progress| progress.league),
                    [
                        "unova-shauntal",
                        "unova-grimsley",
                        "unova-caitlin",
                        "unova-marshal",
                        "unova-alder",
                    ],
                ),
                "kalos" => (
                    campaign
                        .expansion
                        .get("kalos")
                        .map_or(0, |progress| progress.league),
                    [
                        "kalos-malus",
                        "kalos-siebold",
                        "kalos-wikstrom",
                        "kalos-drashna",
                        "kalos-diantha",
                    ],
                ),
                "alola" => (
                    campaign
                        .expansion
                        .get("alola")
                        .map_or(0, |progress| progress.league),
                    [
                        "alola-molayne",
                        "alola-olivia",
                        "alola-acerola",
                        "alola-kahili",
                        "alola-champion",
                    ],
                ),
                "galar" => (
                    campaign
                        .expansion
                        .get("galar")
                        .map_or(0, |progress| progress.league),
                    [
                        "galar-marnie",
                        "galar-hop",
                        "galar-bede",
                        "galar-raihan",
                        "galar-leon",
                    ],
                ),
                "hisui" => (
                    campaign
                        .expansion
                        .get("hisui")
                        .map_or(0, |progress| progress.league),
                    [
                        "hisui-mai",
                        "hisui-irida",
                        "hisui-adaman",
                        "hisui-kamado",
                        "hisui-volo",
                    ],
                ),
                "paldea" => (
                    campaign
                        .expansion
                        .get("paldea")
                        .map_or(0, |progress| progress.league),
                    [
                        "paldea-rika",
                        "paldea-poppy",
                        "paldea-larry",
                        "paldea-hassel",
                        "paldea-geeta",
                    ],
                ),
                _ => return Err("캠페인 리그 지역이 올바르지 않습니다."),
            };
            let trainer = trainers
                .get(league as usize)
                .ok_or("완료한 리그 전투를 저장할 수 없습니다.")?;
            if trainer_id.and_then(Value::as_str) != Some(*trainer)
                || (league < 4 && kind != "elite")
                || (league == 4 && kind != "champion")
            {
                return Err("캠페인 리그 상대가 진행 순서와 일치하지 않습니다.");
            }
        }
        "red" => {
            if campaign_region != "johto"
                || region_id != "mt-silver"
                || battle.get("gymBadge").is_some()
                || trainer_id.and_then(Value::as_str) != Some("red")
                || campaign.kanto_league != 5
                || campaign.johto_league != 5
                || kanto_badges != 8
                || campaign.johto_badges.len() != 8
            {
                return Err("레드 전투 진행이 올바르지 않습니다.");
            }
        }
        _ => return Err("캠페인 전투 종류가 올바르지 않습니다."),
    }
    Ok(())
}

pub fn validate_save(value: &Value) -> Result<(), &'static str> {
    // The envelope is rebuilt by packSave on every save, so only its own keys can appear.
    if value.get("format") != Some(&Value::String("choketmon".into()))
        || value.get("version") != Some(&Value::from(2))
        || value.get("model") != Some(&Value::String("pokemon-recurrent-v1".into()))
        || !value.as_object().is_some_and(|envelope| known_keys(envelope, &SAVE_KEYS))
        || value
            .get("savedAt")
            .is_some_and(|saved| saved.as_str().is_none_or(|saved| saved.len() > 64))
    {
        return Err("저장 파일 형식이 올바르지 않습니다.");
    }
    if value.get("graph") != Some(expected_graph()) {
        return Err("저장 파일의 커넥톰이 서버 원본과 일치하지 않습니다.");
    }
    let game = value.get("game").ok_or("게임 저장 데이터가 없습니다.")?;
    if !game.as_object().is_some_and(|game| known_keys(game, &GAME_KEYS)) {
        return Err("저장 파일의 객체 필드가 올바르지 않습니다.");
    }
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
    if game
        .get("autoMergeDuplicates")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("자동 합치기 설정이 올바르지 않습니다.");
    }
    let next_instance_id = integer(game.get("nextInstanceId"), 1, MAX_SAFE_INTEGER)?;
    let player = game
        .get("player")
        .ok_or("플레이어 저장 데이터가 없습니다.")?;
    if !player.as_object().is_some_and(|player| known_keys(player, &PLAYER_KEYS)) {
        return Err("저장 파일의 객체 필드가 올바르지 않습니다.");
    }
    integer(player.get("money"), 0, MAX_SAFE_INTEGER)?;
    let badges = integer(player.get("badges"), 0, 8)?;
    // The classic map region must exist and be unlocked by the Kanto badges.
    if !game
        .get("regionId")
        .and_then(Value::as_str)
        .and_then(|region| MAP_REGIONS.iter().find(|(id, _)| *id == region))
        .is_some_and(|(_, minimum)| *minimum <= badges)
    {
        return Err("잠기지 않은 지역 진행이 손상되었습니다.");
    }
    let team = array(player, "team")?;
    let box_monsters = array(player, "box")?;
    if team.is_empty() || team.len() > 6 || box_monsters.len() > 10_000 {
        return Err("팀 또는 박스의 개체 수가 올바르지 않습니다.");
    }
    let inventory = object(game, "inventory")?;
    if REQUIRED_INVENTORY_ITEMS
        .iter()
        .any(|item| !inventory.contains_key(*item))
        || inventory.keys().any(|item| {
            !REQUIRED_INVENTORY_ITEMS.contains(&item.as_str())
                && !OPTIONAL_INVENTORY_ITEMS.contains(&item.as_str())
                && !field_item_exists(item)
        })
    {
        return Err("가방 품목 구성이 올바르지 않습니다.");
    }
    for amount in inventory.values() {
        integer(Some(amount), 0, 1_000_000_000)?;
    }
    if let Some(machines) = game.get("technicalMachines") {
        let machines = machines
            .as_object()
            .ok_or("기술머신 보관함이 올바르지 않습니다.")?;
        for (move_id, amount) in machines {
            let known = move_id
                .parse::<i64>()
                .ok()
                .filter(|id| id.to_string() == *move_id && technical_machines().contains_key(id));
            if known.is_none() {
                return Err("기술머신 보관함이 올바르지 않습니다.");
            }
            integer(Some(amount), 0, 1_000_000_000)?;
        }
    }
    validate_evolution_context(game)?;
    let defeated = array(game, "defeatedGyms")?;
    if defeated.len() != badges as usize
        || defeated
            .iter()
            .enumerate()
            .any(|(index, badge)| badge.as_i64() != Some(index as i64 + 1))
    {
        return Err("배지 진행이 올바르지 않습니다.");
    }
    if let Some(field_trainers) = game.get("defeatedFieldTrainers") {
        let field_trainers = field_trainers
            .as_array()
            .filter(|items| items.len() <= 1024)
            .ok_or("필드 트레이너 진행이 올바르지 않습니다.")?;
        let mut unique = HashSet::new();
        for trainer in field_trainers {
            // The loader looks every entry up in the trainer catalog and refuses unknown ones.
            let id = trainer
                .as_str()
                .filter(|id| field_trainer(id).is_some())
                .ok_or("필드 트레이너 진행이 올바르지 않습니다.")?;
            if !unique.insert(id) {
                return Err("필드 트레이너 진행이 중복되었습니다.");
            }
        }
    }
    let champion_defeated = game
        .get("championDefeated")
        .and_then(Value::as_bool)
        .ok_or("챔피언 진행이 올바르지 않습니다.")?;
    if champion_defeated && badges != 8 {
        return Err("챔피언 진행이 올바르지 않습니다.");
    }
    let campaign = validate_campaign(game, badges, champion_defeated)?;
    if let Some(claimed) = game.get("claimedRegionalStarters") {
        let claimed = claimed
            .as_array()
            .filter(|items| items.len() <= 10)
            .ok_or("지역별 스타팅 포켓몬 수령 기록이 올바르지 않습니다.")?;
        let start_region = campaign
            .as_ref()
            .map_or("kanto", |progress| progress.start_region);
        let mut unique = HashSet::new();
        for region in claimed {
            let region = region
                .as_str()
                .filter(|region| {
                    matches!(
                        *region,
                        "kanto"
                            | "johto"
                            | "hoenn"
                            | "sinnoh"
                            | "unova"
                            | "kalos"
                            | "alola"
                            | "galar"
                            | "hisui"
                            | "paldea"
                    )
                })
                .ok_or("지역별 스타팅 포켓몬 수령 기록이 올바르지 않습니다.")?;
            if !unique.insert(region) {
                return Err("지역별 스타팅 포켓몬 수령 기록이 올바르지 않습니다.");
            }
        }
        if !unique.contains(start_region) {
            return Err("시작 지방 스타팅 포켓몬 수령 기록이 없습니다.");
        }
    }

    let mut ids = HashSet::new();
    let mut owned_species = HashSet::new();
    let battle = game.get("battle");
    let battle_transformations = battle
        .and_then(|battle| battle.get("transformations"))
        .and_then(Value::as_object);
    for monster in team {
        let maximum_hp = adjusted_mega_maximum_hp(monster, battle_transformations)?;
        validate_monster(monster, &mut ids, true, &mut owned_species, maximum_hp)?;
    }
    for monster in box_monsters {
        validate_monster(monster, &mut ids, true, &mut owned_species, None)?;
    }
    validate_nursery(game, &mut ids)?;
    if let Some(offer) = game.get("captureOffer") {
        validate_monster(offer, &mut ids, false, &mut owned_species, None)?;
        if offer.get("hp").and_then(Value::as_i64) != Some(0) || game.get("battle").is_some() {
            return Err("승리 후 포획 대상이 올바르지 않습니다.");
        }
    }
    let mut enemy_team: &[Value] = &[];
    if let Some(battle) = battle {
        if !battle.as_object().is_some_and(|battle| known_keys(battle, &BATTLE_KEYS)) {
            return Err("저장 파일의 객체 필드가 올바르지 않습니다.");
        }
        validate_battle_progress(game, battle, badges, campaign.as_ref())?;
        let enemy = battle
            .get("enemy")
            .ok_or("전투 상대가 올바르지 않습니다.")?;
        let enemies = array(enemy, "team")?;
        enemy_team = enemies.as_slice();
        if enemies.is_empty() || enemies.len() > 6 {
            return Err("전투 상대 팀이 올바르지 않습니다.");
        }
        // A wild encounter is always a single opponent.
        if battle.get("kind").and_then(Value::as_str) == Some("wild") && enemies.len() != 1 {
            return Err("전투 도주 규칙이 올바르지 않습니다.");
        }
        integer(enemy.get("activeIndex"), 0, enemies.len() as i64 - 1)?;
        for monster in enemies {
            let maximum_hp = adjusted_mega_maximum_hp(monster, battle_transformations)?;
            validate_monster(monster, &mut ids, false, &mut owned_species, maximum_hp)?;
        }
        let battle_player = battle
            .get("player")
            .ok_or("전투 플레이어가 올바르지 않습니다.")?;
        if [battle_player, enemy].iter().any(|side| {
            !side
                .as_object()
                .is_some_and(|side| known_keys(side, &BATTLE_SIDE_KEYS))
        }) {
            return Err("저장 파일의 객체 필드가 올바르지 않습니다.");
        }
        if array(battle_player, "team")? != team {
            return Err("전투 팀과 플레이어 팀이 일치하지 않습니다.");
        }
        let active_index = integer(battle_player.get("activeIndex"), 0, team.len() as i64 - 1)?;
        // A fainted lead waits for a forced switch while anyone can still fight, and only then.
        let awaiting = battle.get("awaitingSwitch");
        if awaiting.is_some_and(|value| value.as_str() != Some("player")) {
            return Err("강제 교체 상태가 손상되었습니다.");
        }
        let lead_fainted = team[active_index as usize].get("hp").and_then(Value::as_i64) == Some(0);
        if lead_fainted != awaiting.is_some()
            && team
                .iter()
                .any(|monster| monster.get("hp").and_then(Value::as_i64).is_some_and(|hp| hp > 0))
        {
            return Err("강제 교체 대상이 일치하지 않습니다.");
        }
        if let Some(stages) = battle.get("statStages") {
            validate_stat_stages(stages, team.iter().chain(enemies))?;
        }
        if let Some(locks) = battle.get("choiceLocks") {
            let locks = locks.as_object().ok_or("도구의 기술 고정 기록이 올바르지 않습니다.")?;
            for (id, move_id) in locks {
                let monster = team.iter().chain(enemies).find(|monster| monster.get("instanceId").and_then(Value::as_str) == Some(id.as_str()))
                    .ok_or("도구의 기술 고정 개체가 올바르지 않습니다.")?;
                if !matches!(monster.get("heldTool").and_then(Value::as_str), Some("choice-band" | "choice-specs" | "choice-scarf"))
                    || move_id.as_i64().is_none_or(|id| !catalog().moves.contains_key(&id)) {
                    return Err("도구의 기술 고정 기록이 올바르지 않습니다.");
                }
            }
        }
        if let Some(consumed) = battle.get("consumedTools") {
            let consumed = consumed.as_array().ok_or("소모 도구 기록이 올바르지 않습니다.")?;
            let mut ids = HashSet::new();
            for id in consumed {
                let id = id.as_str().ok_or("소모 도구 개체가 올바르지 않습니다.")?;
                if !ids.insert(id) || !team.iter().chain(enemies).any(|monster| monster.get("instanceId").and_then(Value::as_str) == Some(id)
                    && monster.get("heldTool").and_then(Value::as_str).is_some_and(|tool| CONSUMABLE_HELD_TOOLS.contains(&tool))) {
                    return Err("소모 도구 기록이 올바르지 않습니다.");
                }
            }
        }
        for key in ["playerMegaUsed", "playerTeraUsed"] {
            if battle.get(key).is_some_and(|value| !value.is_boolean()) {
                return Err("전투 변신 사용 기록이 올바르지 않습니다.");
            }
        }
        if let Some(transformations) = battle.get("transformations") {
            let transformations = transformations
                .as_object()
                .ok_or("전투 변신 기록이 올바르지 않습니다.")?;
            let battle_ids: HashSet<&str> = team
                .iter()
                .chain(enemies)
                .filter_map(|monster| monster.get("instanceId")?.as_str())
                .collect();
            if transformations.len() > battle_ids.len() {
                return Err("전투 변신 기록이 올바르지 않습니다.");
            }
            let mut player_megas = 0;
            for (instance_id, form_value) in transformations {
                if !battle_ids.contains(instance_id.as_str()) {
                    return Err("전투 변신 개체가 올바르지 않습니다.");
                }
                let form = form_value
                    .as_object()
                    .filter(|form| known_keys(form, &TRANSFORMATION_KEYS))
                    .ok_or("전투 변신 기록이 올바르지 않습니다.")?;
                // Transform copies a real species; the loader looks it up in the catalog.
                if !species_exists(integer(form.get("speciesId"), 1, MAX_SAFE_INTEGER)?) {
                    return Err("전투 변신 기록이 올바르지 않습니다.");
                }
                let stats = object(form_value, "stats")?;
                for key in [
                    "hp",
                    "attack",
                    "defense",
                    "specialAttack",
                    "specialDefense",
                    "speed",
                ] {
                    integer(stats.get(key), 1, 10_000)?;
                }
                let moves = array(form_value, "moves")?;
                if moves.len() > 4 {
                    return Err("전투 변신 기술이 올바르지 않습니다.");
                }
                let kind = form.get("kind").and_then(Value::as_str);
                for slot in moves {
                    let move_id = integer(slot.get("moveId"), 1, MAX_SAFE_INTEGER)?;
                    let known = catalog()
                        .moves
                        .get(&move_id)
                        .ok_or("전투 변신 기술이 올바르지 않습니다.")?;
                    // Transform copies moves with at most five PP each.
                    let maximum = if matches!(kind, Some("mega" | "tera")) { known.pp } else { known.pp.min(5) };
                    integer(slot.get("pp"), 0, maximum)?;
                }
                if kind.is_some_and(|kind| !matches!(kind, "transform" | "mega" | "tera")) {
                    return Err("전투 변신 종류가 올바르지 않습니다.");
                }
                if let Some(hp_adjusted) = form.get("hpAdjusted")
                    && (kind != Some("mega") || hp_adjusted.as_bool() != Some(true))
                {
                    return Err("메가진화 HP 조정 기록이 올바르지 않습니다.");
                }
                if let Some(types) = form.get("types") {
                    let types = types
                        .as_array()
                        .filter(|types| !types.is_empty() && types.len() <= 2)
                        .ok_or("전투 변신 타입이 올바르지 않습니다.")?;
                    if types.iter().any(|value| {
                        !matches!(
                            value.as_str(),
                            Some(
                                "normal"
                                    | "fire"
                                    | "water"
                                    | "electric"
                                    | "grass"
                                    | "ice"
                                    | "fighting"
                                    | "poison"
                                    | "ground"
                                    | "flying"
                                    | "psychic"
                                    | "bug"
                                    | "rock"
                                    | "ghost"
                                    | "dragon"
                                    | "dark"
                                    | "steel"
                                    | "fairy"
                            )
                        )
                    }) {
                        return Err("전투 변신 타입이 올바르지 않습니다.");
                    }
                }
                if matches!(kind, Some("mega" | "tera")) {
                    let source = team.iter().chain(enemies).find(|monster| monster.get("instanceId").and_then(Value::as_str) == Some(instance_id.as_str())).unwrap();
                    if form.get("speciesId") != source.get("speciesId") || form.get("moves") != source.get("moves") {
                        return Err("전투 변신 원본 개체/기술이 일치하지 않습니다.");
                    }
                    let expected_stats = if kind == Some("mega") {
                        let profile = form.get("formIdentifier").and_then(Value::as_str).and_then(combat_form)
                            .filter(|profile| {
                                profile.kind == "mega"
                                    && Some(profile.species_id) == source.get("speciesId").and_then(Value::as_i64)
                                    && mega_model_available(&profile.identifier)
                            })
                            .ok_or("메가진화 모습이 올바르지 않습니다.")?;
                        // The player's side Mega Evolves once per battle and only while holding the
                        // matching stone, which stays equipped until the battle ends.
                        if team.iter().any(|monster| monster.get("instanceId").and_then(Value::as_str) == Some(instance_id.as_str())) {
                            player_megas += 1;
                            if player_megas > 1 {
                                return Err("이 전투에서는 이미 메가진화를 사용했습니다.");
                            }
                            if !source.get("heldTool").and_then(Value::as_str).is_some_and(|tool| mega_stone_matches(tool, &profile.identifier)) {
                                return Err("해당 메가진화석을 장착해야 합니다.");
                            }
                        }
                        if form.get("types") != Some(&serde_json::json!(profile.types)) { return Err("메가진화 타입이 올바르지 않습니다."); }
                        if let Some(ability) = profile.abilities.first() {
                            if form_value.pointer("/ability/id").and_then(Value::as_i64) != Some(ability.id)
                                || form_value.pointer("/ability/slug").and_then(Value::as_str) != Some(ability.slug.as_str()) {
                                return Err("메가진화 특성이 올바르지 않습니다.");
                            }
                        }
                        let ivs = validate_individual_traits(source, profile.species_id)?;
                        form_stats(&profile.identifier, integer(source.get("level"), 1, 100)?, ivs)?
                    } else {
                        if form.contains_key("ability") || form.contains_key("formIdentifier") {
                            return Err("테라스탈 능력치가 올바르지 않습니다.");
                        }
                        let source_stats = object(source, "stats")?;
                        ["hp", "attack", "defense", "specialAttack", "specialDefense", "speed"].map(|key| source_stats[key].as_i64().unwrap())
                    };
                    for (key, expected) in ["hp", "attack", "defense", "specialAttack", "specialDefense", "speed"].into_iter().zip(expected_stats) {
                        if stats.get(key).and_then(Value::as_i64) != Some(expected) { return Err("전투 변신 능력치가 올바르지 않습니다."); }
                    }
                    if team.iter().any(|monster| monster.get("instanceId").and_then(Value::as_str) == Some(instance_id.as_str()))
                        && battle.get(if kind == Some("mega") { "playerMegaUsed" } else { "playerTeraUsed" }).and_then(Value::as_bool) != Some(true) {
                        return Err("전투 변신 사용 기록이 올바르지 않습니다.");
                    }
                }
                if kind == Some("tera") {
                    let tera = form
                        .get("teraType")
                        .and_then(Value::as_str)
                        .ok_or("테라스탈 타입이 올바르지 않습니다.")?;
                    let types = form
                        .get("types")
                        .and_then(Value::as_array)
                        .ok_or("테라스탈 타입이 올바르지 않습니다.")?;
                    if types.len() != 1 || types[0].as_str() != Some(tera) {
                        return Err("테라스탈 타입이 올바르지 않습니다.");
                    }
                }
            }
        }
    }
    let dex = game.get("dex").ok_or("도감 저장 데이터가 없습니다.")?;
    if !dex.as_object().is_some_and(|dex| known_keys(dex, &DEX_KEYS)) {
        return Err("저장 파일의 객체 필드가 올바르지 않습니다.");
    }
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
    let adventure_version = match game.get("adventureVersion") {
        None => "red",
        Some(version) => version.as_str().ok_or("수집 버전이 올바르지 않습니다.")?,
    };
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
                .is_none_or(|message| utf16_length(message) > 500)
        })
    {
        return Err("게임 기록이 올바르지 않습니다.");
    }
    // A numeric suffix too large for an integer is larger than any `nextInstanceId`.
    let maximum_generated_id = ids
        .iter()
        .filter_map(|id| id.strip_prefix("mon-").or_else(|| id.strip_prefix("egg-")))
        .filter(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .map(|digits| digits.parse::<i64>().unwrap_or(i64::MAX))
        .max()
        .unwrap_or(0);
    if next_instance_id <= maximum_generated_id {
        return Err("다음 개체 ID가 기존 개체보다 커야 합니다.");
    }
    fn instance(monster: &Value) -> Option<&str> {
        monster.get("instanceId").and_then(Value::as_str)
    }
    let owned: HashSet<&str> = team.iter().chain(box_monsters).filter_map(instance).collect();
    let owners: HashSet<&str> = team
        .iter()
        .chain(box_monsters)
        .chain(enemy_team)
        .chain(game.get("captureOffer"))
        .filter_map(instance)
        .collect();
    validate_view(value.get("view"), &owned, &owners)?;
    Ok(())
}

/// `battle.statStages` as the loader reads it through `Object.entries`: falsy or entry-less
/// values pass, every listed Pokémon must be in the battle with stat stages of -6..6.
fn validate_stat_stages<'a>(
    stages: &Value,
    members: impl Iterator<Item = &'a Value>,
) -> Result<(), &'static str> {
    const INVALID: &str = "능력 단계가 손상되었습니다.";
    let truthy = |value: &Value| match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    };
    // Arrays and strings list index keys, which neither Pokémon IDs nor stat names match.
    let entryless = |value: &Value| match value {
        Value::Array(items) => items.is_empty(),
        Value::String(text) => text.is_empty(),
        Value::Object(fields) => fields.is_empty(),
        _ => true,
    };
    let Some(entries) = stages.as_object() else {
        return if !truthy(stages) || entryless(stages) { Ok(()) } else { Err(INVALID) };
    };
    let battle_ids: HashSet<&str> = members
        .filter_map(|monster| monster.get("instanceId")?.as_str())
        .collect();
    for (id, set) in entries {
        let valid = battle_ids.contains(id.as_str())
            && truthy(set)
            && match set.as_object() {
                Some(stats) => stats.iter().all(|(stat, stage)| {
                    BATTLE_STATS.contains(&stat.as_str())
                        && stage.as_i64().is_some_and(|stage| (-6..=6).contains(&stage))
                }),
                None => entryless(set),
            };
        if !valid {
            return Err(INVALID);
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Checks real saves before tightening validation, e.g. saves exported from a database:
    /// `SAVE_FIXTURES=<dir of .json envelopes> cargo test saved_fixtures -- --ignored`.
    #[test]
    #[ignore]
    fn saved_fixtures_pass_validation() {
        let dir = std::env::var("SAVE_FIXTURES").expect("SAVE_FIXTURES must name a directory");
        let mut checked = 0;
        let mut failures = Vec::new();
        for entry in std::fs::read_dir(dir).expect("fixture directory") {
            let path = entry.expect("fixture entry").path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let value: Value =
                serde_json::from_slice(&std::fs::read(&path).expect("fixture file")).expect("fixture JSON");
            checked += 1;
            if let Err(error) = validate_save(&value) {
                failures.push(format!("{}: {error}", path.display()));
            }
        }
        assert!(failures.is_empty(), "{} of {checked} saves rejected:\n{}", failures.len(), failures.join("\n"));
        println!("{checked} saves passed");
    }

    #[test]
    fn ability_effects_match_the_client_runtime_categories() {
        assert_eq!(ability_effect("overgrow"), "implemented");
        for slug in [
            "insomnia",
            "vital-spirit",
            "comatose",
            "soundproof",
            "good-as-gold",
        ] {
            assert_eq!(ability_effect(slug), "partial");
        }
        assert_eq!(ability_effect("run-away"), "display-only");
    }

    #[test]
    fn accepts_a_client_canonicalized_insomnia_save() {
        let species_id = 163;
        let source = abilities()[&species_id]
            .iter()
            .find(|entry| entry.slug == "insomnia")
            .expect("fixture species with insomnia");
        let species = &catalog().species[&species_id];
        let level = 5;
        let learned = species
            .moves
            .iter()
            .find(|entry| entry.level <= level)
            .unwrap();
        let pp = catalog().moves[&learned.move_id].pp;
        let ivs = [0; 6];
        let stats = expected_stats_with_ivs(species, level, ivs);
        let mut save = valid_save();
        save["game"]["player"]["team"][0] = serde_json::json!({
            "instanceId":"mon-1", "speciesId":species_id, "nickname":"fixture", "level":level,
            "xp":experience_at_level(species, level).unwrap(), "hp":stats[0],
            "stats":{"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]},
            "ivs":{"hp":0,"attack":0,"defense":0,"specialAttack":0,"specialDefense":0,"speed":0},
            "ability":{"id":source.id,"slot":source.slot,"hidden":source.hidden,"slug":source.slug,
                "name":source.name,"englishName":source.english_name,"effect":"partial","description":"수면 관련 효과 일부 적용"},
            "moves":[{"moveId":learned.move_id,"pp":pp}]
        });
        save["game"]["dex"]["seen"] = serde_json::json!([1, species_id]);
        save["game"]["dex"]["caught"] = serde_json::json!([1, species_id]);
        validate_save(&save).unwrap();
    }

    pub(crate) fn valid_monster() -> Value {
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

    pub(crate) fn valid_save() -> Value {
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

    pub(crate) fn valid_brain_checkpoint() -> Value {
        let node_count = expected_graph()["nodes"].as_array().unwrap().len();
        serde_json::json!({
            "schema":1, "seed":7, "rng":9, "updates":0, "action":0,
            "inputWeights":vec![vec![0.0; 12]; node_count],
            "readout":vec![vec![0.0; node_count + 12]; 5],
            "activity":vec![0.0; node_count], "previous":null, "sensoryBypass":false
        })
    }

    fn set_kanto_badges(save: &mut Value, count: i64) {
        save["game"]["player"]["badges"] = Value::from(count);
        save["game"]["defeatedGyms"] = Value::Array((1..=count).map(Value::from).collect());
    }

    fn set_campaign(
        save: &mut Value,
        johto_badges: i64,
        kanto_league: i64,
        johto_league: i64,
        red_defeated: bool,
    ) {
        save["game"]["campaign"] = serde_json::json!({
            "startRegion":"johto",
            "johtoBadges":(1..=johto_badges).collect::<Vec<_>>(),
            "kantoLeague":kanto_league,
            "johtoLeague":johto_league,
            "redDefeated":red_defeated
        });
        save["game"]["championDefeated"] = Value::Bool(kanto_league == 5);
    }

    fn set_expansion_progress(save: &mut Value, region: &str, badges: i64, league: i64) {
        if save["game"]["campaign"].get("expansion").is_none() {
            save["game"]["campaign"]["expansion"] = serde_json::json!({});
        }
        save["game"]["campaign"]["expansion"][region] = serde_json::json!({
            "badges":(1..=badges).collect::<Vec<_>>(),
            "league":league
        });
    }

    pub(crate) fn set_battle(
        save: &mut Value,
        kind: &str,
        region_id: &str,
        campaign_region: Option<&str>,
        trainer_id: Option<&str>,
        gym_badge: Option<i64>,
    ) {
        let mut enemy = valid_monster();
        let next = save["game"]["nextInstanceId"].as_i64().unwrap();
        enemy["instanceId"] = Value::String(format!("mon-{next}"));
        save["game"]["nextInstanceId"] = Value::from(next + 1);
        let mut battle = serde_json::json!({
            "kind":kind,
            "regionId":region_id,
            "player":{"team":save["game"]["player"]["team"].clone(),"activeIndex":0},
            "enemy":{"team":[enemy],"activeIndex":0},
            "turn":1,
            "canRun":kind == "wild"
        });
        if let Some(region) = campaign_region {
            battle["campaignRegion"] = Value::String(region.into());
        }
        if let Some(trainer) = trainer_id {
            battle["trainerId"] = Value::String(trainer.into());
        }
        if let Some(badge) = gym_badge {
            battle["gymBadge"] = Value::from(badge);
        }
        save["game"]["battle"] = battle;
    }

    pub(crate) fn monster_for_species(species_id: i64, instance_id: &str, level: i64, hp: i64) -> Value {
        let species = &catalog().species[&species_id];
        let stats = expected_stats(species, level);
        serde_json::json!({
            "instanceId":instance_id,"speciesId":species_id,"nickname":"test","level":level,
            "xp":experience_at_level(species, level).unwrap(),"hp":hp,
            "stats":{"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]},
            "moves":[]
        })
    }

    fn mega_transformation(monster: &Value, identifier: &str, hp_adjusted: Option<Value>) -> Value {
        let profile = combat_form(identifier).unwrap();
        let stats = form_stats(
            identifier,
            monster["level"].as_i64().unwrap(),
            [0; 6],
        )
        .unwrap();
        let mut transformation = serde_json::json!({
            "kind":"mega","formIdentifier":identifier,
            "speciesId":monster["speciesId"],"moves":monster["moves"],
            "types":profile.types,
            "stats":{"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]}
        });
        if let Some(ability) = profile.abilities.first() {
            transformation["ability"] = serde_json::json!({"id":ability.id,"slug":ability.slug});
        }
        if let Some(value) = hp_adjusted {
            transformation["hpAdjusted"] = value;
        }
        transformation
    }

    fn mega_battle_save(species_id: i64, identifier: &str, hp: i64, marker: Option<Value>) -> Value {
        let mut save = valid_save();
        let mut monster = monster_for_species(species_id, "mon-1", 100, hp);
        monster["heldTool"] = Value::from(format!("mega-stone:{identifier}"));
        save["game"]["player"]["team"] = serde_json::json!([monster]);
        save["game"]["dex"]["seen"] = serde_json::json!([species_id]);
        save["game"]["dex"]["caught"] = serde_json::json!([species_id]);
        set_battle(&mut save, "wild", "safari-meadow", None, None, None);
        let transformation = mega_transformation(
            &save["game"]["player"]["team"][0],
            identifier,
            marker,
        );
        save["game"]["battle"]["transformations"] =
            Value::Object(Map::from_iter([("mon-1".into(), transformation)]));
        save["game"]["battle"]["playerMegaUsed"] = Value::Bool(true);
        save
    }

    #[test]
    fn accepts_consistent_save() {
        validate_save(&valid_save()).unwrap();
    }

    #[test]
    fn validates_ordinary_trainer_battle_and_victory_history() {
        let mut save = valid_save();
        set_campaign(&mut save, 0, 0, 0, false);
        let trainer = field_trainer_catalog()
            .iter()
            .find(|trainer| trainer.id == "practice-johto-new-bark")
            .unwrap();
        set_battle(
            &mut save,
            "trainer",
            &trainer.location_id,
            Some("johto"),
            Some(&trainer.id),
            None,
        );
        let (species_id, level) = trainer.team[0];
        let species = catalog().species.get(&species_id).unwrap();
        let stats = expected_stats(species, level);
        let enemy = &mut save["game"]["battle"]["enemy"]["team"][0];
        enemy["speciesId"] = Value::from(species_id);
        enemy["level"] = Value::from(level);
        enemy["xp"] = Value::from(experience_at_level(species, level).unwrap());
        enemy["hp"] = Value::from(stats[0]);
        enemy["stats"] = serde_json::json!({"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]});
        enemy["moves"] = serde_json::json!([]);
        validate_save(&save).unwrap();
        let mut invalid = save.clone();
        invalid["game"]["battle"]["regionId"] = Value::String("wrong-town".into());
        assert!(validate_save(&invalid).is_err());
        invalid = save.clone();
        invalid["game"]["defeatedFieldTrainers"] = serde_json::json!([trainer.id]);
        assert!(validate_save(&invalid).is_err());
        invalid["game"].as_object_mut().unwrap().remove("battle");
        validate_save(&invalid).unwrap();
    }

    #[test]
    fn validates_persistent_egg_brain_and_generated_id() {
        let mut save = valid_save();
        save["game"]["nextInstanceId"] = Value::from(3);
        save["game"]["nursery"] = serde_json::json!([{
            "eggId":"egg-2", "speciesId":1, "parentIds":["mon-1","former-parent"],
            "steps":400, "requiredSteps":5376, "createdAtStep":2,
            "brain":valid_brain_checkpoint()
        }]);
        validate_save(&save).unwrap();

        let mut stale_id = save.clone();
        stale_id["game"]["nextInstanceId"] = Value::from(2);
        assert!(validate_save(&stale_id).is_err());

        save["game"]["nursery"][0]["brain"]["sensoryBypass"] = Value::Bool(true);
        assert!(validate_save(&save).is_err());
    }

    #[test]
    fn accepts_legacy_partial_and_complete_optional_inventories() {
        validate_save(&valid_save()).unwrap();

        let mut partial = valid_save();
        partial["game"]["inventory"]["metal-coat"] = Value::from(2);
        partial["game"]["inventory"]["up-grade"] = Value::from(1);
        partial["game"]["inventory"]["focus-sash"] = Value::from(2);
        validate_save(&partial).unwrap();

        let mut complete = valid_save();
        for item in OPTIONAL_INVENTORY_ITEMS {
            complete["game"]["inventory"][item] = Value::from(0);
        }
        assert_eq!(complete["game"]["inventory"].as_object().unwrap().len(), 60);
        validate_save(&complete).unwrap();

        let field_items: Vec<Value> = serde_json::from_str(include_str!(
            "../../src/data/field-items.json"
        ))
        .unwrap();
        let ids_of = |kind: &str| -> Vec<String> {
            field_items
                .iter()
                .filter(|item| item.get("kind").and_then(Value::as_str) == Some(kind))
                .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect()
        };
        let mega_stones = ids_of("mega-stone");
        let held_tools = ids_of("held-tool");
        assert_eq!(mega_stones.len(), 65);
        assert_eq!(held_tools.len(), 47);
        for item in mega_stones.iter().chain(&held_tools) {
            complete["game"]["inventory"][item.as_str()] = Value::from(0);
        }
        // 12 required, 48 legacy optional (the six original held tools included),
        // 41 catalog-only held tools and 65 Mega stones.
        assert_eq!(complete["game"]["inventory"].as_object().unwrap().len(), 166);
        validate_save(&complete).unwrap();
    }

    #[test]
    fn rejects_invalid_optional_inventory_shapes_and_amounts() {
        let mut missing_required = valid_save();
        missing_required["game"]["inventory"]
            .as_object_mut()
            .unwrap()
            .remove("poke-ball");
        assert!(validate_save(&missing_required).is_err());

        let mut unknown = valid_save();
        unknown["game"]["inventory"]["unknown-item"] = Value::from(1);
        assert!(validate_save(&unknown).is_err());

        for invalid in [
            Value::from(-1),
            Value::Null,
            serde_json::json!(1.5),
            Value::from(1_000_000_001_i64),
        ] {
            let mut save = valid_save();
            save["game"]["inventory"]["metal-coat"] = invalid;
            assert!(validate_save(&save).is_err());
        }
    }

    #[test]
    fn accepts_legacy_and_complete_evolution_tracking() {
        validate_save(&valid_save()).unwrap();

        let mut save = valid_save();
        save["game"]["player"]["team"][0]["evolutionProgress"] = serde_json::json!({
            "gender":"female",
            "friendship":255,
            "beauty":128,
            "affection":0,
            "steps":1_000_000_000_i64,
            "damageTaken":12,
            "recoilDamage":3,
            "criticalHits":4,
            "defeatedBisharp":3,
            "coins":999,
            "moveUses":{"1":0,"1000":1_000_000_000_i64}
        });
        save["game"]["evolutionContext"] = serde_json::json!({
            "period":"dusk",
            "regionId":"팔데아",
            "locationId":"union-circle-cave",
            "raining":true,
            "multiplayer":false
        });
        validate_save(&save).unwrap();
    }

    #[test]
    fn rejects_invalid_evolution_progress() {
        let valid_progress = serde_json::json!({
            "gender":"genderless","friendship":0,"beauty":0,"affection":0,"steps":0,
            "damageTaken":0,"recoilDamage":0,"criticalHits":0,"defeatedBisharp":0,"coins":0,
            "moveUses":{}
        });
        let mut invalid_values = Vec::new();
        let mut missing = valid_progress.clone();
        missing.as_object_mut().unwrap().remove("gender");
        invalid_values.push(missing);
        let mut extra = valid_progress.clone();
        extra["extra"] = Value::Bool(true);
        invalid_values.push(extra);
        for (field, value) in [
            ("gender", Value::String("unknown".into())),
            ("friendship", Value::from(256)),
            ("beauty", Value::from(-1)),
            ("affection", serde_json::json!(1.5)),
            ("steps", Value::from(1_000_000_001_i64)),
            ("damageTaken", Value::Null),
        ] {
            let mut progress = valid_progress.clone();
            progress[field] = value;
            invalid_values.push(progress);
        }
        for (move_id, count) in [
            ("0", Value::from(1)),
            ("01", Value::from(1)),
            ("1001", Value::from(1)),
            ("move", Value::from(1)),
            ("1", Value::from(-1)),
            ("2", serde_json::json!(1.5)),
            ("3", Value::from(1_000_000_001_i64)),
        ] {
            let mut progress = valid_progress.clone();
            progress["moveUses"][move_id] = count;
            invalid_values.push(progress);
        }
        let too_many = (1..=1001)
            .map(|id| (id.to_string(), Value::from(0)))
            .collect::<Map<String, Value>>();
        let mut progress = valid_progress;
        progress["moveUses"] = Value::Object(too_many);
        invalid_values.push(progress);

        for progress in invalid_values {
            let mut save = valid_save();
            save["game"]["player"]["team"][0]["evolutionProgress"] = progress;
            assert!(validate_save(&save).is_err());
        }

        let mut null_progress = valid_save();
        null_progress["game"]["player"]["team"][0]["evolutionProgress"] = Value::Null;
        assert!(validate_save(&null_progress).is_err());
    }

    #[test]
    fn rejects_invalid_evolution_context() {
        let valid_context = serde_json::json!({
            "period":"day","regionId":"kanto","locationId":"power-plant",
            "raining":false,"multiplayer":false
        });
        let mut invalid_values = Vec::new();
        let mut missing = valid_context.clone();
        missing.as_object_mut().unwrap().remove("locationId");
        invalid_values.push(missing);
        let mut extra = valid_context.clone();
        extra["weather"] = Value::String("clear".into());
        invalid_values.push(extra);
        for (field, value) in [
            ("period", Value::String("morning".into())),
            ("regionId", Value::String("r".repeat(41))),
            ("locationId", Value::String("l".repeat(101))),
            ("raining", Value::from(0)),
            ("multiplayer", Value::Null),
        ] {
            let mut context = valid_context.clone();
            context[field] = value;
            invalid_values.push(context);
        }
        for context in invalid_values {
            let mut save = valid_save();
            save["game"]["evolutionContext"] = context;
            assert!(validate_save(&save).is_err());
        }

        let mut null_context = valid_save();
        null_context["game"]["evolutionContext"] = Value::Null;
        assert!(validate_save(&null_context).is_err());
    }

    #[test]
    fn validates_campaign_progress_and_preserves_legacy_saves() {
        validate_save(&valid_save()).unwrap();

        let mut completed = valid_save();
        set_kanto_badges(&mut completed, 8);
        set_campaign(&mut completed, 8, 5, 5, true);
        validate_save(&completed).unwrap();

        for invalid in [
            serde_json::json!(null),
            serde_json::json!({"startRegion":"johto","johtoBadges":[],"kantoLeague":0,"johtoLeague":0}),
            serde_json::json!({"startRegion":"hoenn","johtoBadges":[],"kantoLeague":0,"johtoLeague":0,"redDefeated":false}),
            serde_json::json!({"startRegion":"johto","johtoBadges":[1,3],"kantoLeague":0,"johtoLeague":0,"redDefeated":false}),
            serde_json::json!({"startRegion":"johto","johtoBadges":[],"kantoLeague":1,"johtoLeague":0,"redDefeated":false}),
            serde_json::json!({"startRegion":"johto","johtoBadges":[],"kantoLeague":0,"johtoLeague":1,"redDefeated":false}),
            serde_json::json!({"startRegion":"johto","johtoBadges":[],"kantoLeague":0,"johtoLeague":0,"redDefeated":true}),
        ] {
            let mut save = valid_save();
            save["game"]["campaign"] = invalid;
            assert!(validate_save(&save).is_err());
        }

        let mut champion_mismatch = valid_save();
        set_kanto_badges(&mut champion_mismatch, 8);
        set_campaign(&mut champion_mismatch, 8, 5, 5, false);
        champion_mismatch["game"]["championDefeated"] = Value::Bool(false);
        assert!(validate_save(&champion_mismatch).is_err());

        let mut premature_kanto = valid_save();
        set_kanto_badges(&mut premature_kanto, 1);
        set_campaign(&mut premature_kanto, 8, 0, 0, false);
        assert!(validate_save(&premature_kanto).is_err());

        premature_kanto["game"]["campaign"]["startRegion"] = Value::String("kanto".into());
        validate_save(&premature_kanto).unwrap();
    }

    #[test]
    fn validates_expansion_campaign_order_and_shape() {
        let mut hoenn = valid_save();
        set_kanto_badges(&mut hoenn, 8);
        set_campaign(&mut hoenn, 8, 5, 5, false);
        set_expansion_progress(&mut hoenn, "hoenn", 8, 2);
        validate_save(&hoenn).unwrap();

        let mut sinnoh = hoenn.clone();
        set_expansion_progress(&mut sinnoh, "hoenn", 8, 5);
        set_expansion_progress(&mut sinnoh, "sinnoh", 3, 0);
        validate_save(&sinnoh).unwrap();

        let mut unova = sinnoh.clone();
        set_expansion_progress(&mut unova, "sinnoh", 8, 5);
        set_expansion_progress(&mut unova, "unova", 1, 0);
        validate_save(&unova).unwrap();

        let mut premature_sinnoh = hoenn.clone();
        set_expansion_progress(&mut premature_sinnoh, "sinnoh", 1, 0);
        assert!(validate_save(&premature_sinnoh).is_err());

        let mut premature_unova = sinnoh;
        set_expansion_progress(&mut premature_unova, "unova", 1, 0);
        assert!(validate_save(&premature_unova).is_err());

        let mut late = hoenn.clone();
        for region in [
            "hoenn", "sinnoh", "unova", "kalos", "alola", "galar", "hisui",
        ] {
            set_expansion_progress(&mut late, region, 8, 5);
        }
        set_expansion_progress(&mut late, "paldea", 1, 0);
        validate_save(&late).unwrap();

        for expansion in [
            serde_json::json!({"orrea":{"badges":[],"league":0}}),
            serde_json::json!({"hoenn":{"badges":[1,3],"league":0}}),
            serde_json::json!({"hoenn":{"badges":[],"league":1}}),
            serde_json::json!({"hoenn":{"badges":[],"league":0,"extra":true}}),
        ] {
            let mut edited = valid_save();
            set_kanto_badges(&mut edited, 8);
            set_campaign(&mut edited, 8, 5, 5, false);
            edited["game"]["campaign"]["expansion"] = expansion;
            assert!(validate_save(&edited).is_err());
        }
    }

    #[test]
    fn validates_legacy_and_campaign_battle_progress() {
        let mut legacy_gym = valid_save();
        set_battle(&mut legacy_gym, "gym", "safari-meadow", None, None, Some(1));
        validate_save(&legacy_gym).unwrap();

        let mut johto_gym = valid_save();
        set_campaign(&mut johto_gym, 2, 0, 0, false);
        set_battle(
            &mut johto_gym,
            "gym",
            "safari-meadow",
            Some("johto"),
            None,
            Some(3),
        );
        validate_save(&johto_gym).unwrap();

        let mut kanto_gym = valid_save();
        set_kanto_badges(&mut kanto_gym, 1);
        set_campaign(&mut kanto_gym, 0, 0, 0, false);
        kanto_gym["game"]["campaign"]["startRegion"] = Value::String("kanto".into());
        kanto_gym["game"]["regionId"] = Value::String("verdant-forest".into());
        set_battle(
            &mut kanto_gym,
            "gym",
            "verdant-forest",
            Some("kanto"),
            None,
            Some(2),
        );
        validate_save(&kanto_gym).unwrap();

        let mut johto_elite = valid_save();
        set_campaign(&mut johto_elite, 8, 0, 2, false);
        set_battle(
            &mut johto_elite,
            "elite",
            "pokemon-league",
            Some("johto"),
            Some("johto-bruno"),
            None,
        );
        validate_save(&johto_elite).unwrap();

        let mut kanto_champion = valid_save();
        set_kanto_badges(&mut kanto_champion, 8);
        set_campaign(&mut kanto_champion, 8, 4, 5, false);
        set_battle(
            &mut kanto_champion,
            "champion",
            "pokemon-league",
            Some("kanto"),
            Some("kanto-blue"),
            None,
        );
        validate_save(&kanto_champion).unwrap();

        let mut red = valid_save();
        set_kanto_badges(&mut red, 8);
        set_campaign(&mut red, 8, 5, 5, false);
        set_battle(
            &mut red,
            "red",
            "mt-silver",
            Some("johto"),
            Some("red"),
            None,
        );
        validate_save(&red).unwrap();

        let mut wrong_trainer = johto_elite;
        wrong_trainer["game"]["battle"]["trainerId"] = Value::String("johto-karen".into());
        assert!(validate_save(&wrong_trainer).is_err());

        let mut wrong_badge = johto_gym;
        wrong_badge["game"]["battle"]["gymBadge"] = Value::from(4);
        assert!(validate_save(&wrong_badge).is_err());

        let mut wrong_kanto_region = kanto_gym;
        wrong_kanto_region["game"]["battle"]["regionId"] = Value::String("safari-meadow".into());
        assert!(validate_save(&wrong_kanto_region).is_err());

        let mut gated_kanto_gym = valid_save();
        set_campaign(&mut gated_kanto_gym, 8, 0, 0, false);
        set_battle(
            &mut gated_kanto_gym,
            "gym",
            "safari-meadow",
            Some("kanto"),
            None,
            Some(1),
        );
        assert!(validate_save(&gated_kanto_gym).is_err());

        gated_kanto_gym["game"]["campaign"]["startRegion"] = Value::String("kanto".into());
        validate_save(&gated_kanto_gym).unwrap();

        let mut premature_red = valid_save();
        set_campaign(&mut premature_red, 8, 0, 5, false);
        set_battle(
            &mut premature_red,
            "red",
            "mt-silver",
            Some("johto"),
            Some("red"),
            None,
        );
        assert!(validate_save(&premature_red).is_err());
    }

    #[test]
    fn validates_expansion_gym_and_league_battles() {
        let mut hoenn_gym = valid_save();
        set_kanto_badges(&mut hoenn_gym, 8);
        set_campaign(&mut hoenn_gym, 8, 5, 5, false);
        set_expansion_progress(&mut hoenn_gym, "hoenn", 2, 0);
        set_battle(
            &mut hoenn_gym,
            "gym",
            "safari-meadow",
            Some("hoenn"),
            None,
            Some(3),
        );
        validate_save(&hoenn_gym).unwrap();

        let mut hoenn_elite = valid_save();
        set_kanto_badges(&mut hoenn_elite, 8);
        set_campaign(&mut hoenn_elite, 8, 5, 5, false);
        set_expansion_progress(&mut hoenn_elite, "hoenn", 8, 2);
        set_battle(
            &mut hoenn_elite,
            "elite",
            "pokemon-league",
            Some("hoenn"),
            Some("hoenn-glacia"),
            None,
        );
        validate_save(&hoenn_elite).unwrap();

        let mut wrong_trainer = hoenn_elite.clone();
        wrong_trainer["game"]["battle"]["trainerId"] = Value::String("hoenn-drake".into());
        assert!(validate_save(&wrong_trainer).is_err());

        let mut gated_sinnoh = hoenn_elite;
        set_expansion_progress(&mut gated_sinnoh, "sinnoh", 8, 0);
        set_battle(
            &mut gated_sinnoh,
            "elite",
            "pokemon-league",
            Some("sinnoh"),
            Some("sinnoh-aaron"),
            None,
        );
        assert!(validate_save(&gated_sinnoh).is_err());

        let mut late = valid_save();
        set_kanto_badges(&mut late, 8);
        set_campaign(&mut late, 8, 5, 5, false);
        for region in ["hoenn", "sinnoh", "unova", "kalos", "alola"] {
            set_expansion_progress(&mut late, region, 8, 5);
        }
        for (region, trainer) in [
            ("galar", "galar-marnie"),
            ("hisui", "hisui-mai"),
            ("paldea", "paldea-rika"),
        ] {
            set_expansion_progress(&mut late, region, 8, 0);
            set_battle(
                &mut late,
                "elite",
                "pokemon-league",
                Some(region),
                Some(trainer),
                None,
            );
            validate_save(&late).unwrap();
            late["game"].as_object_mut().unwrap().remove("battle");
            set_expansion_progress(&mut late, region, 8, 5);
        }
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
    fn validates_individual_values_and_source_ability_slots() {
        let mut save = valid_save();
        let monster = &mut save["game"]["player"]["team"][0];
        let species_id = monster["speciesId"].as_i64().unwrap();
        let level = monster["level"].as_i64().unwrap();
        let source = &abilities()[&species_id][0];
        let ivs = [31, 30, 29, 28, 27, 26];
        monster["ivs"] = serde_json::json!({"hp":31,"attack":30,"defense":29,"specialAttack":28,"specialDefense":27,"speed":26});
        monster["ability"] = serde_json::json!({
            "id":source.id,"slot":source.slot,"hidden":source.hidden,"slug":source.slug,
            "name":source.name,"englishName":source.english_name,"effect":"implemented",
            "description":"검증된 전투 효과"
        });
        let stats = expected_stats_with_ivs(&catalog().species[&species_id], level, ivs);
        monster["stats"] = serde_json::json!({"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]});
        monster["hp"] = Value::from(stats[0]);
        validate_save(&save).unwrap();

        let mut bad_iv = save.clone();
        bad_iv["game"]["player"]["team"][0]["ivs"]["speed"] = Value::from(32);
        assert!(validate_save(&bad_iv).is_err());
        let mut bad_ability = save.clone();
        bad_ability["game"]["player"]["team"][0]["ability"]["slot"] = Value::from(3);
        assert!(validate_save(&bad_ability).is_err());
        let mut partial = save;
        partial["game"]["player"]["team"][0]
            .as_object_mut()
            .unwrap()
            .remove("ability");
        assert!(validate_save(&partial).is_err());
    }

    #[test]
    fn accepts_consumed_records_only_for_battle_consumable_tools() {
        let with_tool = |tool: &str| {
            let mut save = valid_save();
            save["game"]["player"]["team"][0]["heldTool"] = Value::from(tool);
            set_battle(&mut save, "wild", "safari-meadow", None, None, None);
            let id = save["game"]["player"]["team"][0]["instanceId"].clone();
            save["game"]["battle"]["consumedTools"] = serde_json::json!([id]);
            save
        };
        for tool in CONSUMABLE_HELD_TOOLS {
            validate_save(&with_tool(tool)).unwrap();
        }
        for tool in ["leftovers", "lucky-egg", "charcoal", "eviolite"] {
            assert!(validate_save(&with_tool(tool)).is_err(), "{tool}");
        }
        let mut duplicated = with_tool("sitrus-berry");
        let id = duplicated["game"]["player"]["team"][0]["instanceId"].clone();
        duplicated["game"]["battle"]["consumedTools"] = serde_json::json!([id.clone(), id]);
        assert!(validate_save(&duplicated).is_err());
        assert!(species_can_evolve(1));
        assert!(species_can_evolve(133));
        assert!(!species_can_evolve(3));
    }

    #[test]
    fn validates_auto_merge_and_held_tool_extensions() {
        let mut save = valid_save();
        save["game"]["autoMergeDuplicates"] = Value::Bool(true);
        save["game"]["player"]["team"][0]["heldTool"] = Value::from("leftovers");
        validate_save(&save).unwrap();

        let mut bad_option = save.clone();
        bad_option["game"]["autoMergeDuplicates"] = Value::from(1);
        assert!(validate_save(&bad_option).is_err());
        for tool in ["charcoal", "weakness-policy", "lum-berry", "amulet-coin", "everstone"] {
            let mut expanded = save.clone();
            expanded["game"]["player"]["team"][0]["heldTool"] = Value::from(tool);
            expanded["game"]["inventory"][tool] = Value::from(3);
            validate_save(&expanded).unwrap();
        }
        let mut bad_tool = save;
        bad_tool["game"]["player"]["team"][0]["heldTool"] = Value::from("unknown-tool");
        assert!(validate_save(&bad_tool).is_err());

        let species_id = 718;
        let base_hp = expected_stats(&catalog().species[&species_id], 100)[0];
        let mut matching_stone = valid_save();
        matching_stone["game"]["player"]["team"][0] =
            monster_for_species(species_id, "mon-1", 100, base_hp);
        matching_stone["game"]["player"]["team"][0]["heldTool"] =
            Value::from("mega-stone:zygarde-mega");
        matching_stone["game"]["dex"]["seen"] = serde_json::json!([species_id]);
        matching_stone["game"]["dex"]["caught"] = serde_json::json!([species_id]);
        validate_save(&matching_stone).unwrap();

        for invalid in [
            "mega-stone:charizard-mega-x",
            "mega-stone:clefable-mega",
        ] {
            let mut wrong = matching_stone.clone();
            wrong["game"]["player"]["team"][0]["heldTool"] = Value::from(invalid);
            assert!(validate_save(&wrong).is_err(), "{invalid}");
        }
    }

    #[test]
    fn validates_owned_preferred_transformations_and_legacy_absence() {
        validate_save(&valid_save()).unwrap();

        let mut tera = valid_save();
        tera["game"]["player"]["team"][0]["preferredTransformation"] =
            serde_json::json!({"kind":"tera","teraType":"fairy"});
        validate_save(&tera).unwrap();

        for invalid in [
            serde_json::json!(null),
            serde_json::json!({"kind":"unknown","teraType":"fire"}),
            serde_json::json!({"kind":"tera","teraType":"stellar"}),
            serde_json::json!({"kind":"tera","teraType":"fire","formIdentifier":"charizard-mega-x"}),
            serde_json::json!({"kind":"mega","formIdentifier":"charizard-mega-x"}),
        ] {
            let mut edited = valid_save();
            edited["game"]["player"]["team"][0]["preferredTransformation"] = invalid;
            assert!(validate_save(&edited).is_err());
        }

        let make_monster = |species_id: i64, instance_id: &str| {
            let species = &catalog().species[&species_id];
            let stats = expected_stats(species, 100);
            serde_json::json!({
                "instanceId":instance_id,"speciesId":species_id,"nickname":"test","level":100,
                "xp":species.experience[99],"hp":stats[0],
                "stats":{"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]},
                "moves":[]
            })
        };
        let mut charizard = make_monster(6, "mon-6");
        charizard["preferredTransformation"] =
            serde_json::json!({"kind":"mega","formIdentifier":"charizard-mega-x"});
        validate_monster(&charizard, &mut HashSet::new(), true, &mut HashSet::new(), None).unwrap();

        let mut unavailable = make_monster(36, "mon-36");
        unavailable["preferredTransformation"] =
            serde_json::json!({"kind":"mega","formIdentifier":"clefable-mega"});
        assert!(validate_monster(&unavailable, &mut HashSet::new(), true, &mut HashSet::new(), None).is_err());

        let mut encounter = make_monster(25, "mon-25");
        encounter["preferredTransformation"] =
            serde_json::json!({"kind":"tera","teraType":"electric"});
        assert!(validate_monster(&encounter, &mut HashSet::new(), false, &mut HashSet::new(), None).is_err());
    }

    #[test]
    fn accepts_canonical_adjusted_mega_hp_for_battle_team_members() {
        for (species_id, identifier) in [(670, "floette-mega"), (718, "zygarde-mega")] {
            let base_hp = expected_stats(&catalog().species[&species_id], 100)[0];
            let mega_hp = form_stats(identifier, 100, [0; 6]).unwrap()[0];
            assert!(mega_hp > base_hp, "{identifier} must exercise the HP override");

            let save = mega_battle_save(species_id, identifier, mega_hp, Some(Value::Bool(true)));
            validate_save(&save).unwrap();
        }
    }

    #[test]
    fn rejects_adjusted_mega_hp_above_canonical_form_even_with_forged_form_stats() {
        let identifier = "zygarde-mega";
        let mega_hp = form_stats(identifier, 100, [0; 6]).unwrap()[0];
        let over_form_hp = mega_battle_save(718, identifier, mega_hp + 1, Some(Value::Bool(true)));
        assert!(validate_save(&over_form_hp).is_err());

        let mut forged_form_stats = over_form_hp;
        forged_form_stats["game"]["battle"]["transformations"]["mon-1"]["stats"]["hp"] =
            Value::from(mega_hp + 1);
        assert!(validate_save(&forged_form_stats).is_err());
    }

    #[test]
    fn rejects_invalid_hp_adjustment_markers_and_box_hp_bypass() {
        let mega_hp = form_stats("zygarde-mega", 100, [0; 6]).unwrap()[0];
        for (kind, marker) in [
            ("mega", Value::Bool(false)),
            ("mega", Value::Null),
            ("tera", Value::Bool(true)),
            ("transform", Value::Bool(true)),
        ] {
            let mut save = mega_battle_save(718, "zygarde-mega", mega_hp, Some(marker));
            save["game"]["battle"]["transformations"]["mon-1"]["kind"] =
                Value::String(kind.into());
            assert!(validate_save(&save).is_err(), "kind={kind}");
        }

        let mut boxed = valid_save();
        let boxed_monster = monster_for_species(718, "mon-2", 100, mega_hp);
        boxed["game"]["player"]["box"] = serde_json::json!([boxed_monster]);
        boxed["game"]["dex"]["seen"] = serde_json::json!([1, 718]);
        boxed["game"]["dex"]["caught"] = serde_json::json!([1, 718]);
        boxed["game"]["nextInstanceId"] = Value::from(3);
        set_battle(&mut boxed, "wild", "safari-meadow", None, None, None);
        let transformation = mega_transformation(
            &boxed["game"]["player"]["box"][0],
            "zygarde-mega",
            Some(Value::Bool(true)),
        );
        boxed["game"]["battle"]["transformations"] =
            Value::Object(Map::from_iter([("mon-2".into(), transformation)]));
        boxed["game"]["battle"]["playerMegaUsed"] = Value::Bool(true);
        assert!(validate_save(&boxed).is_err());
    }

    #[test]
    fn preserves_legacy_mega_saves_without_hp_adjustment_marker() {
        let species_id = 718;
        let base_hp = expected_stats(&catalog().species[&species_id], 100)[0];
        let save = mega_battle_save(species_id, "zygarde-mega", base_hp, None);
        validate_save(&save).unwrap();
        validate_save(&valid_save()).unwrap();
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
                "instanceId":format!("mon-{}", species.id), "speciesId":species.id,
                "nickname":"test", "level":level, "xp":species.experience[99], "hp":stats[0],
                "stats":{"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]},
                "moves":[]
            });
            validate_monster(&monster, &mut HashSet::new(), false, &mut HashSet::new(), None).unwrap();
            let mut edited = monster;
            edited["xp"] = Value::from(species.experience[99] + 1);
            assert!(
                validate_monster(&edited, &mut HashSet::new(), false, &mut HashSet::new(), None).is_err()
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

        for map in ["johto-v3", "johto-v2", "johto-atlas-v1"] {
            let mut johto = save.clone();
            johto["view"]["openWorld"]["regionId"] = Value::String("johto".into());
            johto["view"]["openWorld"]["mapVersion"] = Value::String(map.into());
            validate_save(&johto).unwrap();
        }

        let mut unknown_region = save.clone();
        unknown_region["view"]["openWorld"]["regionId"] = Value::String("missing".into());
        assert!(validate_save(&unknown_region).is_err());

        let mut duplicate_visit = save;
        duplicate_visit["view"]["openWorld"]["visitedTownsByRegion"]["paldea"] =
            serde_json::json!(["cabo-poco", "cabo-poco"]);
        assert!(validate_save(&duplicate_visit).is_err());
    }

    #[test]
    fn validates_expansion_open_world_version_layout_and_scene() {
        for (region, map_versions) in [
            (
                "hoenn",
                ["hoenn-authored-v1", "hoenn-atlas-v1", "hoenn-atlas-v2"],
            ),
            (
                "sinnoh",
                ["sinnoh-authored-v1", "sinnoh-atlas-v1", "sinnoh-atlas-v2"],
            ),
            (
                "unova",
                ["unova-authored-v1", "unova-atlas-v1", "unova-atlas-v2"],
            ),
        ] {
            for map_version in map_versions {
                let mut save = valid_save();
                save["view"]["openWorld"] = serde_json::json!({
                    "regionId":region,
                    "mapVersion":map_version,
                    "encounterLayout":"expansion-v1",
                    "sceneId":format!("surface:{region}")
                });
                validate_save(&save).unwrap();
                if map_version.contains("atlas") {
                    let mut old_layout = save.clone();
                    old_layout["view"]["openWorld"]["encounterLayout"] =
                        Value::String("red-v1".into());
                    validate_save(&old_layout).unwrap();

                    let mut no_layout = save;
                    no_layout["view"]["openWorld"]
                        .as_object_mut()
                        .unwrap()
                        .remove("encounterLayout");
                    validate_save(&no_layout).unwrap();
                }
            }

            let mut save = valid_save();
            save["view"]["openWorld"] = serde_json::json!({
                "regionId":region,
                "mapVersion":format!("{region}-authored-v1"),
                "encounterLayout":"expansion-v1",
                "sceneId":format!("surface:{region}")
            });

            let mut wrong_scene = save.clone();
            wrong_scene["view"]["openWorld"]["sceneId"] = Value::String("surface:kanto".into());
            assert!(validate_save(&wrong_scene).is_err());

            let mut wrong_layout = save.clone();
            wrong_layout["view"]["openWorld"]["encounterLayout"] = Value::String("red-v1".into());
            assert!(validate_save(&wrong_layout).is_err());

            let mut missing_layout = save;
            missing_layout["view"]["openWorld"]
                .as_object_mut()
                .unwrap()
                .remove("encounterLayout");
            assert!(validate_save(&missing_layout).is_err());

            let mut wrong_legacy_region = valid_save();
            wrong_legacy_region["view"]["openWorld"] = serde_json::json!({
                "regionId":region,
                "mapVersion":if region == "hoenn" { "sinnoh-atlas-v1" } else { "hoenn-atlas-v1" },
                "encounterLayout":"expansion-v1",
                "sceneId":format!("surface:{region}")
            });
            assert!(validate_save(&wrong_legacy_region).is_err());
        }

        for region in ["galar", "hisui", "paldea"] {
            for map_version in [
                format!("{region}-authored-v1"),
                format!("{region}-atlas-v1"),
            ] {
                let mut save = valid_save();
                save["view"]["openWorld"] = serde_json::json!({
                    "regionId":region,
                    "mapVersion":map_version,
                    "encounterLayout":"expansion-v1",
                    "sceneId":format!("surface:{region}")
                });
                validate_save(&save).unwrap();
            }
            let mut missing_layout = valid_save();
            missing_layout["view"]["openWorld"] = serde_json::json!({
                "regionId":region,
                "mapVersion":format!("{region}-authored-v1"),
                "sceneId":format!("surface:{region}")
            });
            assert!(validate_save(&missing_layout).is_err());
        }
    }

    #[test]
    fn validates_optional_open_world_battle_rotation_index() {
        for index in [0, 5] {
            let mut save = valid_save();
            save["view"]["openWorld"] = serde_json::json!({"nextBattleTeamIndex":index});
            validate_save(&save).unwrap();
        }
        for index in [
            serde_json::json!(-1),
            serde_json::json!(6),
            serde_json::json!(1.5),
            serde_json::json!("1"),
        ] {
            let mut save = valid_save();
            save["view"]["openWorld"] = serde_json::json!({"nextBattleTeamIndex":index});
            assert!(validate_save(&save).is_err());
        }
    }

    #[test]
    fn validates_field_item_cooldowns_and_accepts_legacy_absence() {
        let mut save = valid_save();
        save["view"]["openWorld"] = serde_json::json!({"regionId":"kanto", "sceneId":"surface:kanto", "fieldItemPickupStates":{"field-item:kanto:0":{"remainingSeconds":1799.5,"collectedCount":3}}});
        validate_save(&save).unwrap();
        for timer in [-1.0, 1800.1] {
            let mut bad = save.clone(); bad["view"]["openWorld"]["fieldItemPickupStates"]["field-item:kanto:0"]["remainingSeconds"] = Value::from(timer);
            assert!(validate_save(&bad).is_err());
        }
        save["view"]["openWorld"]["fieldItemPickupStates"] = serde_json::json!({"field-item:kanto:23":{"remainingSeconds":0,"collectedCount":0}});
        validate_save(&save).unwrap();
        for slot in ["24", "03", "-1"] {
            save["view"]["openWorld"]["fieldItemPickupStates"] = serde_json::json!({ format!("field-item:kanto:{slot}"): {"remainingSeconds":0,"collectedCount":0} });
            assert!(validate_save(&save).is_err());
        }
        validate_save(&valid_save()).unwrap();
    }

    #[test]
    fn accepts_every_dungeon_floor_including_the_older_single_chamber_caves() {
        for (region, scene) in [
            ("kanto", "cave:kanto:mt-moon"),
            ("kanto", "cave:kanto:mt-moon-b2f"),
            ("kanto", "cave:kanto:power-plant"),
            ("kanto", "cave:kanto:pokemon-tower-7f"),
            ("johto", "cave:johto:dark-cave"),
            ("johto", "cave:johto:bell-tower-roof"),
        ] {
            let mut save = valid_save();
            save["view"]["openWorld"] = serde_json::json!({"regionId":region, "mapVersion":format!("{region}-v3"), "sceneId":scene});
            validate_save(&save).unwrap_or_else(|error| panic!("{scene}: {error}"));
        }
        for (region, scene) in [
            ("kanto", "cave:kanto:mt-moon-b9f"),
            ("kanto", "cave:johto:bell-tower-2f"),
            ("johto", "cave:johto:pokemon-tower"),
        ] {
            let mut save = valid_save();
            save["view"]["openWorld"] = serde_json::json!({"regionId":region, "mapVersion":format!("{region}-v3"), "sceneId":scene});
            assert!(validate_save(&save).is_err(), "{scene}");
        }
        let mut later = valid_save();
        later["view"]["openWorld"] = serde_json::json!({"regionId":"sinnoh", "mapVersion":"sinnoh-authored-v1",
            "encounterLayout":"expansion-v1", "sceneId":"cave:sinnoh:mt-coronet-top"});
        validate_save(&later).unwrap();
        later["view"]["openWorld"]["sceneId"] = Value::String("cave:sinnoh:mt-moon".into());
        assert!(validate_save(&later).is_err());
    }

    #[test]
    fn accepts_gym_and_league_halls_of_the_same_region() {
        for scene in ["gym:kanto:pewter", "league:kanto:indigo-plateau"] {
            let mut save = valid_save();
            save["view"]["openWorld"] = serde_json::json!({"regionId":"kanto", "sceneId":scene, "surfaceReturn":{"sceneId":"surface:kanto","x":1,"z":2}});
            validate_save(&save).unwrap();
        }
        for scene in ["gym:johto:violet", "league:kanto:", "gym:kanto:Pewter", "hall:kanto:pewter"] {
            let mut save = valid_save();
            save["view"]["openWorld"] = serde_json::json!({"regionId":"kanto", "sceneId":scene});
            assert!(validate_save(&save).is_err(), "{scene}");
        }
    }

    #[test]
    fn validates_technical_machine_stock_and_taught_moves() {
        let mut save = valid_save();
        save["game"]["technicalMachines"] = serde_json::json!({"89": 2, "85": 0});
        validate_save(&save).unwrap();
        for stock in [serde_json::json!({"1": 1}), serde_json::json!({"089": 1}), serde_json::json!({"89": -1}), serde_json::json!([89])] {
            let mut bad = valid_save();
            bad["game"]["technicalMachines"] = stock;
            assert!(validate_save(&bad).is_err());
        }
        assert!(technical_machine_compatible(89, 6) && !technical_machine_compatible(89, 12));
        let energy_ball = catalog().moves.get(&412).unwrap().pp;
        let mut taught = valid_save();
        taught["game"]["player"]["team"][0]["taughtMoves"] = serde_json::json!([412]);
        taught["game"]["player"]["team"][0]["moves"].as_array_mut().unwrap().push(serde_json::json!({"moveId":412,"pp":energy_ball}));
        validate_save(&taught).unwrap();
        let mut untaught = taught.clone();
        untaught["game"]["player"]["team"][0].as_object_mut().unwrap().remove("taughtMoves");
        assert!(validate_save(&untaught).is_err());
        let mut incompatible = valid_save();
        incompatible["game"]["player"]["team"][0]["taughtMoves"] = serde_json::json!([89]);
        validate_save(&incompatible).unwrap();
        incompatible["game"]["player"]["team"][0]["moves"].as_array_mut().unwrap().push(serde_json::json!({"moveId":89,"pp":10}));
        assert!(validate_save(&incompatible).is_err());
        for invalid in [serde_json::json!([412, 412]), serde_json::json!([1]), serde_json::json!(412)] {
            let mut bad = valid_save();
            bad["game"]["player"]["team"][0]["taughtMoves"] = invalid;
            assert!(validate_save(&bad).is_err());
        }
    }

    #[test]
    fn validates_v3_scene_clock_coordinates_and_field_trainer_progress() {
        let mut save = valid_save();
        add_box_monster(&mut save, "mon-2");
        save["game"]["defeatedFieldTrainers"] = serde_json::json!(["crystal-hiker-daniel"]);
        let mut companion = world_record("companion:mon-1", "companion", 4.0, 5.0);
        companion["target"] = serde_json::json!({"kind":"food","id":"1","x":6,"z":7});
        save["view"]["openWorld"] = serde_json::json!({
            "regionId":"johto", "mapVersion":"johto-v3", "sceneId":"cave:johto:union-cave",
            "worldClockSeconds":1199.5, "player":{"x":240,"z":-240,"heading":0},
            "spawnAnchor":{"x":1,"z":2},
            "surfaceReturn":{"sceneId":"surface:johto","x":-200,"z":200},
            "entities":[companion, world_record("wild-1", "wild", -3.0, 2.0)],
            "companionMemories":[world_record("companion:mon-2", "companion", 8.0, 9.0)],
            "foods":[{"id":1,"x":10,"z":11}],
            "respawnQueue":[{"originX":12,"originZ":13}]
        });
        validate_save(&save).unwrap();

        let mut wrong_scene = save.clone();
        wrong_scene["view"]["openWorld"]["sceneId"] = Value::String("cave:kanto:mt-moon".into());
        assert!(validate_save(&wrong_scene).is_err());
        let mut outside = save.clone();
        outside["view"]["openWorld"]["player"]["x"] = Value::from(240.01);
        assert!(validate_save(&outside).is_err());
        let mut bad_clock = save.clone();
        bad_clock["view"]["openWorld"]["worldClockSeconds"] = Value::from(1200);
        assert!(validate_save(&bad_clock).is_err());
        let mut duplicate = save;
        duplicate["game"]["defeatedFieldTrainers"] =
            serde_json::json!(["crystal-hiker-daniel", "crystal-hiker-daniel"]);
        assert!(validate_save(&duplicate).is_err());
    }

    #[test]
    fn validates_regional_origin_and_one_time_starter_claims_while_accepting_legacy_absence() {
        let legacy = valid_save();
        validate_save(&legacy).unwrap();

        let mut current = valid_save();
        current["game"]["claimedRegionalStarters"] = serde_json::json!(["kanto", "johto"]);
        current["game"]["player"]["team"][0]["originRegion"] = Value::String("kanto".into());
        validate_save(&current).unwrap();

        let mut duplicate = current.clone();
        duplicate["game"]["claimedRegionalStarters"] = serde_json::json!(["kanto", "kanto"]);
        assert!(validate_save(&duplicate).is_err());
        let mut missing_start = current.clone();
        missing_start["game"]["claimedRegionalStarters"] = serde_json::json!(["johto"]);
        assert!(validate_save(&missing_start).is_err());
        let mut invalid_origin = current;
        invalid_origin["game"]["player"]["team"][0]["originRegion"] = Value::String("moon".into());
        assert!(validate_save(&invalid_origin).is_err());
    }

    pub(crate) fn add_box_monster(save: &mut Value, instance_id: &str) {
        let mut monster = valid_monster();
        monster["instanceId"] = Value::from(instance_id);
        save["game"]["player"]["box"].as_array_mut().unwrap().push(monster);
        let number: i64 = instance_id.trim_start_matches("mon-").parse().unwrap();
        let next = save["game"]["nextInstanceId"].as_i64().unwrap().max(number + 1);
        save["game"]["nextInstanceId"] = Value::from(next);
    }

    /// A field or open-world creature brain as the client snapshots it.
    pub(crate) fn record_brain() -> Value {
        let mut brain = valid_brain_checkpoint();
        brain["graphId"] = expected_graph()["id"].clone();
        brain
    }

    pub(crate) fn world_record(id: &str, kind: &str, x: f64, z: f64) -> Value {
        serde_json::json!({
            "id":id, "kind":kind, "speciesId":1, "level":5, "x":x, "z":z, "heading":4,
            "energy":100, "brain":record_brain(), "observation":vec![0.0; 12], "action":4,
            "reward":0, "foods":0, "collisions":0
        })
    }

    pub(crate) fn field_record(id: &str, x: i64, y: i64) -> Value {
        serde_json::json!({
            "id":id, "speciesId":1, "x":x, "y":y, "heading":4, "energy":100,
            "brain":record_brain(), "lastObservation":vec![0.0; 12], "action":4, "reward":0,
            "foods":0, "collisions":0
        })
    }

    /// `emptyRewardLedger` in `src/game/rewards.ts`.
    pub(crate) fn reward_ledger(id: &str) -> Value {
        let zeros = serde_json::json!({"engagement":0,"damageDealt":0,"damageReceived":0,
            "typeChoice":0,"moveEffect":0,"outcome":0,"growth":0,"evolution":0});
        serde_json::json!({"rewardModel":"kanto-engineered-reward-v1","individualId":id,"latest":[],
            "lifetime":{"events":0,"eventCounts":{"engagement":0,"battle":0},"total":0,
                "componentTotals":zeros,"componentCounts":zeros}})
    }

    pub(crate) fn field_snapshot(entities: Vec<Value>, memories: Vec<Value>) -> Value {
        serde_json::json!({"schema":1,"model":"pokemon-field-recurrent-v1",
            "graphId":expected_graph()["id"].clone(),"seed":71,"rng":5,"tick":3,
            "recurrentEnabled":true,"player":{"x":12,"y":10},"foods":[{"id":1,"x":2,"y":7}],
            "nextFoodId":2,"entities":entities,"memories":memories})
    }

    fn alolan_monster(identifier: &str, instance_id: &str, level: i64, move_ids: &[i64]) -> Value {
        let form = combat_form(identifier).unwrap();
        let species = &catalog().species[&form.species_id];
        let stats = form_stats(identifier, level, [0; 6]).unwrap();
        let ability = &form.abilities[0];
        serde_json::json!({
            "instanceId":instance_id, "speciesId":form.species_id, "nickname":"alola",
            "level":level, "xp":experience_at_level(species, level).unwrap(), "hp":stats[0],
            "stats":{"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]},
            "ivs":{"hp":0,"attack":0,"defense":0,"specialAttack":0,"specialDefense":0,"speed":0},
            "ability":{"id":ability.id,"slot":ability.slot,"hidden":ability.hidden,"slug":ability.slug,
                "name":ability.name,"englishName":ability.english_name,
                "effect":ability_effect(&ability.slug),"description":"원본 폼 특성"},
            "regionalForm":identifier,
            "moves":move_ids.iter().map(|id| serde_json::json!({"moveId":id,"pp":catalog().moves[id].pp})).collect::<Vec<_>>()
        })
    }

    fn with_lead(monster: Value) -> Value {
        let species_id = monster["speciesId"].clone();
        let mut save = valid_save();
        save["game"]["player"]["team"] = serde_json::json!([monster]);
        save["game"]["dex"]["seen"] = serde_json::json!([species_id]);
        save["game"]["dex"]["caught"] = serde_json::json!([species_id]);
        save
    }

    fn with_moves(mut monster: Value, move_ids: &[i64]) -> Value {
        monster["moves"] = move_ids
            .iter()
            .map(|id| serde_json::json!({"moveId":id,"pp":catalog().moves[id].pp}))
            .collect();
        monster
    }

    #[test]
    fn keeps_moves_learned_as_an_earlier_alolan_form() {
        for (identifier, moves) in [
            ("ninetales-alola", [181, 420, 62, 58]),
            ("ninetales-alola", [54, 694, 573, 181]),
            ("sandslash-alola", [54, 181, 334, 442]),
            ("sandslash-alola", [883, 59, 54, 181]),
        ] {
            let save = with_lead(alolan_monster(identifier, "mon-1", 100, &moves));
            validate_save(&save).unwrap_or_else(|error| panic!("{identifier} {moves:?}: {error}"));
        }
        // Every regional line: each move an earlier Alolan form learns by level 100 stays legal.
        let mut checked = 0;
        for species in catalog().species.values() {
            let mut earlier = Vec::new();
            let mut forms = pre_evolutions(species.id).to_vec();
            while let Some(form) = forms.pop() {
                if let Some(regional) = alola_form(form) {
                    earlier.extend(
                        regional
                            .level_up_moves
                            .iter()
                            .filter(|entry| entry.level <= 100)
                            .map(|entry| entry.move_id),
                    );
                }
                forms.extend_from_slice(pre_evolutions(form));
            }
            earlier.sort_unstable();
            earlier.dedup();
            for moves in earlier.chunks(4) {
                let monster = match alola_form(species.id) {
                    Some(form) => alolan_monster(&form.identifier, "mon-1", 100, moves),
                    None => with_moves(monster_for_species(species.id, "mon-1", 100, 1), moves),
                };
                validate_save(&with_lead(monster))
                    .unwrap_or_else(|error| panic!("{} {moves:?}: {error}", species.id));
                checked += 1;
            }
        }
        assert!(checked >= 10, "regional lines checked: {checked}");
        // Perrserker has no Alolan form, but an Alolan Meowth can become one.
        let perrserker = with_moves(monster_for_species(863, "mon-1", 100, 1), &[400]);
        validate_save(&with_lead(perrserker)).unwrap();
        // Moves outside every learnset of the line are still refused.
        let ninetales = alolan_monster("ninetales-alola", "mon-1", 100, &[]);
        let refused = |id: i64| validate_save(&with_lead(with_moves(ninetales.clone(), &[id])));
        let foreign = *catalog()
            .moves
            .keys()
            .filter(|id| refused(**id).is_err())
            .min()
            .unwrap();
        assert_eq!(refused(foreign), Err("현재 종과 레벨이 배울 수 없는 기술입니다."));
    }

    #[test]
    fn enforces_client_instance_id_gender_nickname_and_move_learning_rules() {
        for id in ["starter", "mon-0", "mon-01", "mon-", "Mon-1", "mon-1x", "mon-12345678901234567"] {
            let mut save = valid_save();
            save["game"]["player"]["team"][0]["instanceId"] = Value::from(id);
            assert!(validate_save(&save).is_err(), "{id}");
        }
        let mut save = valid_save();
        save["game"]["player"]["team"][0]["instanceId"] = Value::from("mon-7");
        save["game"]["nextInstanceId"] = Value::from(8);
        validate_save(&save).unwrap();
        let mut egg = valid_save();
        egg["game"]["nursery"] = serde_json::json!([{
            "eggId":"egg-99999999999999999999", "speciesId":1, "parentIds":["mon-1","mon-2"],
            "steps":0, "requiredSteps":5376, "createdAtStep":2, "brain":valid_brain_checkpoint()
        }]);
        assert!(validate_save(&egg).is_err());

        for (species_id, gender, valid) in [
            (1, "female", true),
            (1, "male", true),
            (1, "genderless", false),
            (81, "genderless", true),
            (81, "male", false),
            (113, "female", true),
            (113, "male", false),
            (128, "male", true),
            (128, "female", false),
        ] {
            let mut monster = monster_for_species(species_id, "mon-1", 30, 1);
            monster["gender"] = Value::from(gender);
            assert_eq!(validate_save(&with_lead(monster)).is_ok(), valid, "{species_id} {gender}");
        }
        let mut null_gender = valid_save();
        null_gender["game"]["player"]["team"][0]["gender"] = Value::Null;
        assert!(validate_save(&null_gender).is_err());

        // The client counts UTF-16 code units: twenty emoji fill the forty-unit name.
        for (nickname, valid) in [
            ("😀".repeat(20), true),
            ("😀".repeat(21), false),
            ("가".repeat(40), true),
            ("가".repeat(41), false),
        ] {
            let mut save = valid_save();
            save["game"]["player"]["team"][0]["nickname"] = Value::from(nickname.clone());
            assert_eq!(validate_save(&save).is_ok(), valid, "{nickname}");
        }

        let move_id = valid_monster()["moves"][0]["moveId"].as_i64().unwrap();
        let record = serde_json::json!({"choices":2,"executed":1,"effective":1,"reward":0.5});
        let padded = serde_json::json!({"choices":2,"executed":1,"effective":1,"reward":0.5,"note":"x"});
        for (key, record, valid) in [
            (move_id.to_string(), record.clone(), true),
            (format!("00{move_id}"), record.clone(), true),
            (format!("+{move_id}"), record.clone(), false),
            (format!("-{move_id}"), record.clone(), false),
            (move_id.to_string(), padded, false),
        ] {
            let mut save = valid_save();
            save["game"]["player"]["team"][0]["moveLearning"] =
                Value::Object(Map::from_iter([(key.clone(), record)]));
            assert_eq!(validate_save(&save).is_ok(), valid, "{key}");
        }
    }

    #[test]
    fn requires_loadable_brains_and_regional_traits() {
        let mut save = valid_save();
        save["game"]["player"]["team"][0]["brain"] = valid_brain_checkpoint();
        validate_save(&save).unwrap();
        for key in ["previous", "sensoryBypass"] {
            let mut edited = save.clone();
            edited["game"]["player"]["team"][0]["brain"]
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(validate_save(&edited).is_err(), "{key}");
        }
        let mut extra = save;
        extra["game"]["player"]["team"][0]["brain"]["padding"] = Value::from("x");
        assert!(validate_save(&extra).is_err());

        let alolan = alolan_monster("vulpix-alola", "mon-1", 10, &[]);
        validate_save(&with_lead(alolan.clone())).unwrap();
        let mut traitless = alolan;
        traitless.as_object_mut().unwrap().remove("ivs");
        traitless.as_object_mut().unwrap().remove("ability");
        assert!(validate_save(&with_lead(traitless)).is_err());
    }

    /// A save using every key the client writes on the allow-listed objects.
    fn complete_save() -> Value {
        let species = &catalog().species[&1];
        let source = &abilities()[&1][0];
        let level = 5;
        let stats = expected_stats(species, level);
        let learned: Vec<i64> = species
            .moves
            .iter()
            .filter(|entry| entry.level <= level)
            .map(|entry| entry.move_id)
            .collect();
        let equipped = learned[0];
        let reserve = *learned.iter().find(|id| **id != equipped).unwrap();
        let monster = serde_json::json!({
            "instanceId":"mon-1","speciesId":1,"nickname":"full","originRegion":"kanto","gender":"female",
            "level":level,"xp":experience_at_level(species, level).unwrap(),"hp":stats[0],
            "stats":{"hp":stats[0],"attack":stats[1],"defense":stats[2],"specialAttack":stats[3],"specialDefense":stats[4],"speed":stats[5]},
            "ivs":{"hp":0,"attack":0,"defense":0,"specialAttack":0,"specialDefense":0,"speed":0},
            "ability":{"id":source.id,"slot":source.slot,"hidden":source.hidden,"slug":source.slug,
                "name":source.name,"englishName":source.english_name,"effect":ability_effect(&source.slug),"description":"설명"},
            "heldTool":"leftovers","preferredTransformation":{"kind":"tera","teraType":"grass"},
            "moves":[{"moveId":equipped,"pp":1}],"taughtMoves":[412],"moveOrder":[equipped],
            "movePpReserve":{reserve.to_string():1},"status":"poison","statusTurns":2,
            "brain":valid_brain_checkpoint(),
            "moveLearning":{equipped.to_string():{"choices":1,"executed":1,"effective":0,"reward":0.25}},
            "evolutionProgress":{"gender":"female","friendship":70,"beauty":0,"affection":0,"steps":10,
                "damageTaken":0,"recoilDamage":0,"criticalHits":0,"defeatedBisharp":0,"coins":0,"moveUses":{}}
        });
        let mut full = valid_save();
        full["game"]["player"]["team"] = serde_json::json!([monster]);
        full["tradeEpoch"] = Value::from(3);
        set_campaign(&mut full, 0, 0, 0, false);
        let game = full["game"].as_object_mut().unwrap();
        for (key, value) in [
            ("nursery", serde_json::json!([])),
            ("defeatedFieldTrainers", serde_json::json!([])),
            ("claimedRegionalStarters", serde_json::json!(["johto"])),
            ("experienceShare", Value::Bool(true)),
            ("autoMergeDuplicates", Value::Bool(false)),
            ("adventureVersion", Value::from("red")),
            ("versionCaught", serde_json::json!({"red":[1]})),
            ("ballRefillSeconds", Value::from(0)),
            ("technicalMachines", serde_json::json!({"412":1})),
            ("evolutionContext", serde_json::json!({"period":"day","regionId":"kanto","locationId":"pallet","raining":false,"multiplayer":false})),
        ] {
            game.insert(key.into(), value);
        }
        let mut companion = world_record("companion:mon-1", "companion", 1.0, 2.0);
        companion["target"] = serde_json::json!({"kind":"player","id":"player","x":3,"z":4});
        let mut world = serde_json::json!({"schema":1,"model":"pokemon-open-world-recurrent-v1",
            "graphId":expected_graph()["id"].clone(),"seed":81,"rng":3,"tick":10,"serverFinalizations":[],
            "player":{"x":0,"z":0,"heading":4},"selectedWildId":"wild-1","autoCapture":true,"autoHunt":false,
            "battleWildId":"wild-1","worldClockSeconds":10,"fieldItemPickupStates":{},"battleElapsed":0,
            "pendingCapture":false,"pendingBall":"poke-ball","lastPlayerReward":null,"lastEnemyReward":null,
            "manualControlRemaining":0,"nextBattleTeamIndex":0,"controlMode":"auto","selectionPinned":false,
            "trackingSelected":false,"regionId":"kanto","sceneId":"surface:kanto","mapVersion":"kanto-v3",
            "densityRemaining":0,"encounterLayout":"red-v1","spawnSerial":2,"nextFoodId":1});
        for (key, value) in [
            ("pendingAction", serde_json::json!({"type":"wait"})),
            ("visitedTownIds", serde_json::json!(["pallet"])),
            ("visitedTownsByRegion", serde_json::json!({"kanto":["pallet"]})),
            ("rewardLedgers", serde_json::json!({"mon-1":reward_ledger("mon-1")})),
            ("surfaceReturn", serde_json::json!({"sceneId":"surface:kanto","x":0,"z":0})),
            ("spawnAnchor", serde_json::json!({"x":0,"z":0,"heading":4})),
            ("foods", serde_json::json!([])),
            ("respawnQueue", serde_json::json!([])),
            ("entities", serde_json::json!([companion, world_record("wild-1", "wild", 5.0, 5.0)])),
            ("companionMemories", serde_json::json!([])),
        ] {
            world[key] = value;
        }
        let stash = serde_json::json!({"mon-1":{"field":field_record("mon-1", 5, 8),
            "openWorld":world_record("companion:mon-1", "companion", 0.0, 0.0),
            "rewardLedger":reward_ledger("mon-1")}});
        full["view"] = serde_json::json!({
            "position":{"x":12,"y":10,"steps":4},"learning":true,"learningDefaultsVersion":1,
            "rewards":{"mon-1":0.5},"field":field_snapshot(vec![field_record("mon-1", 5, 8)], vec![]),
            "fieldPreferences":{"paused":false,"learning":true,"selectedId":"mon-1"},
            "openWorldPaused":false,
            "tradeTransferProvenance":{"mon-1":{"sourceInstanceId":"mon-9","tradeId":"trade-1"}},
            "tradeCompanionMemories":stash, "openWorld":world
        });
        full
    }

    #[test]
    fn allow_lists_keep_every_client_key_and_refuse_padding() {
        let full = complete_save();
        validate_save(&full).unwrap();
        assert_eq!(full.as_object().unwrap().len(), SAVE_KEYS.len());
        assert_eq!(full["game"].as_object().unwrap().len(), GAME_KEYS.len() - 2);
        assert_eq!(full["game"]["player"]["team"][0].as_object().unwrap().len(), MONSTER_KEYS.len() - 1);
        assert_eq!(full["view"].as_object().unwrap().len(), VIEW_KEYS.len());
        assert_eq!(full["view"]["openWorld"].as_object().unwrap().len(), OPEN_WORLD_KEYS.len());

        let learned = full["game"]["player"]["team"][0]["moves"][0]["moveId"].as_i64().unwrap();
        for pointer in [
            String::new(),
            "/game".into(),
            "/game/player".into(),
            "/game/dex".into(),
            "/game/player/team/0".into(),
            "/game/player/team/0/stats".into(),
            "/game/player/team/0/moves/0".into(),
            format!("/game/player/team/0/moveLearning/{learned}"),
            "/view".into(),
            "/view/position".into(),
            "/view/openWorld".into(),
            "/view/openWorld/entities/0".into(),
            "/view/openWorld/entities/0/brain".into(),
            "/view/openWorld/rewardLedgers/mon-1".into(),
            "/view/openWorld/rewardLedgers/mon-1/lifetime".into(),
            "/view/field".into(),
            "/view/field/entities/0".into(),
            "/view/tradeCompanionMemories/mon-1".into(),
            "/view/tradeCompanionMemories/mon-1/openWorld".into(),
            "/view/tradeTransferProvenance/mon-1".into(),
        ] {
            let mut padded = full.clone();
            padded
                .pointer_mut(&pointer)
                .unwrap_or_else(|| panic!("{pointer}"))
                .as_object_mut()
                .unwrap()
                .insert("padding".into(), Value::from("x".repeat(64)));
            assert!(validate_save(&padded).is_err(), "{pointer}");
        }
        let mut long_date = full;
        long_date["savedAt"] = Value::from("x".repeat(65));
        assert!(validate_save(&long_date).is_err());

        let mut battle = valid_save();
        set_battle(&mut battle, "wild", "safari-meadow", None, None, None);
        validate_save(&battle).unwrap();
        for pointer in ["/game/battle", "/game/battle/enemy"] {
            let mut padded = battle.clone();
            padded
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("padding".into(), Value::from(1));
            assert!(validate_save(&padded).is_err(), "{pointer}");
        }
        let mut egg = valid_save();
        egg["game"]["nextInstanceId"] = Value::from(3);
        egg["game"]["nursery"] = serde_json::json!([{
            "eggId":"egg-2", "speciesId":1, "parentIds":["mon-1","former-parent"], "steps":0,
            "requiredSteps":5376, "createdAtStep":2, "brain":valid_brain_checkpoint()
        }]);
        validate_save(&egg).unwrap();
        egg["game"]["nursery"][0]["padding"] = Value::from(1);
        assert!(validate_save(&egg).is_err());
    }

    #[test]
    fn validates_classic_map_region_trainers_and_version() {
        let mut save = valid_save();
        save["game"]["regionId"] = Value::from("verdant-forest");
        assert!(validate_save(&save).is_err());
        set_kanto_badges(&mut save, 1);
        validate_save(&save).unwrap();
        for region in [Value::from("pokemon-league"), Value::Null, Value::from(3)] {
            let mut edited = valid_save();
            edited["game"]["regionId"] = region;
            assert!(validate_save(&edited).is_err());
        }
        let mut unknown = valid_save();
        unknown["game"]["defeatedFieldTrainers"] = serde_json::json!(["crystal-nobody-at-all"]);
        assert!(validate_save(&unknown).is_err());
        let mut version = valid_save();
        version["game"]["adventureVersion"] = serde_json::json!(["red"]);
        assert!(validate_save(&version).is_err());
    }

    fn two_member_battle(lead_hp: i64) -> Value {
        let mut save = valid_save();
        let mut second = valid_monster();
        second["instanceId"] = Value::from("mon-2");
        save["game"]["player"]["team"]
            .as_array_mut()
            .unwrap()
            .push(second);
        save["game"]["player"]["team"][0]["hp"] = Value::from(lead_hp);
        save["game"]["nextInstanceId"] = Value::from(3);
        set_battle(&mut save, "wild", "safari-meadow", None, None, None);
        save
    }

    #[test]
    fn validates_battle_stages_forced_switches_and_transformations() {
        let save = two_member_battle(10);
        validate_save(&save).unwrap();
        for (stages, valid) in [
            (serde_json::json!({"mon-1":{"attack":2,"evasion":-6}}), true),
            (serde_json::json!({"mon-3":{"speed":6}}), true),
            (serde_json::json!({"mon-1":true}), true),
            (serde_json::json!(null), true),
            (serde_json::json!({"mon-1":{"attack":7}}), false),
            (serde_json::json!({"mon-1":{"attack":1.5}}), false),
            (serde_json::json!({"mon-1":{"luck":1}}), false),
            (serde_json::json!({"mon-1":null}), false),
            (serde_json::json!({"mon-9":{"attack":1}}), false),
            (serde_json::json!([{"attack":1}]), false),
        ] {
            let mut edited = save.clone();
            edited["game"]["battle"]["statStages"] = stages.clone();
            assert_eq!(validate_save(&edited).is_ok(), valid, "{stages}");
        }

        let mut waiting = save.clone();
        waiting["game"]["battle"]["awaitingSwitch"] = Value::from("player");
        assert!(validate_save(&waiting).is_err());
        let fainted = two_member_battle(0);
        assert!(validate_save(&fainted).is_err());
        let mut switching = fainted;
        switching["game"]["battle"]["awaitingSwitch"] = Value::from("player");
        validate_save(&switching).unwrap();
        for value in [Value::from("enemy"), Value::Null] {
            let mut edited = switching.clone();
            edited["game"]["battle"]["awaitingSwitch"] = value;
            assert!(validate_save(&edited).is_err());
        }

        let enemy = save["game"]["battle"]["enemy"]["team"][0].clone();
        let move_id = enemy["moves"][0]["moveId"].as_i64().unwrap();
        let transform = |species: i64, pp: i64| {
            serde_json::json!({"speciesId":species,"stats":enemy["stats"].clone(),
                "moves":[{"moveId":move_id,"pp":pp}]})
        };
        let mut copied = save.clone();
        copied["game"]["battle"]["transformations"] = serde_json::json!({"mon-3":transform(25, 5)});
        validate_save(&copied).unwrap();
        for (species, pp) in [(99_999, 5), (25, 6)] {
            let mut edited = save.clone();
            edited["game"]["battle"]["transformations"] =
                serde_json::json!({"mon-3":transform(species, pp)});
            assert!(validate_save(&edited).is_err(), "{species} {pp}");
        }

        let mut crowded = save;
        let mut second_enemy = crowded["game"]["battle"]["enemy"]["team"][0].clone();
        second_enemy["instanceId"] = Value::from("mon-4");
        crowded["game"]["nextInstanceId"] = Value::from(5);
        crowded["game"]["battle"]["enemy"]["team"]
            .as_array_mut()
            .unwrap()
            .push(second_enemy);
        assert!(validate_save(&crowded).is_err());
    }

    #[test]
    fn player_mega_evolution_needs_its_stone_and_happens_once() {
        let mega_hp = form_stats("zygarde-mega", 100, [0; 6]).unwrap()[0];
        let save = mega_battle_save(718, "zygarde-mega", mega_hp, Some(Value::Bool(true)));
        validate_save(&save).unwrap();
        let mut stoneless = save.clone();
        stoneless["game"]["player"]["team"][0]
            .as_object_mut()
            .unwrap()
            .remove("heldTool");
        stoneless["game"]["battle"]["player"]["team"] = stoneless["game"]["player"]["team"].clone();
        assert_eq!(
            validate_save(&stoneless),
            Err("해당 메가진화석을 장착해야 합니다.")
        );

        let mut twice = save;
        let mut second = twice["game"]["player"]["team"][0].clone();
        second["instanceId"] = Value::from("mon-4");
        twice["game"]["nextInstanceId"] = Value::from(5);
        twice["game"]["player"]["team"]
            .as_array_mut()
            .unwrap()
            .push(second);
        twice["game"]["battle"]["player"]["team"] = twice["game"]["player"]["team"].clone();
        let transformation = twice["game"]["battle"]["transformations"]["mon-1"].clone();
        twice["game"]["battle"]["transformations"]["mon-4"] = transformation;
        assert_eq!(
            validate_save(&twice),
            Err("이 전투에서는 이미 메가진화를 사용했습니다.")
        );
    }

    #[test]
    fn validates_view_rewards_provenance_and_settings_like_the_loader() {
        validate_save(&valid_save()).unwrap();
        let mut missing = valid_save();
        missing.as_object_mut().unwrap().remove("view");
        assert!(validate_save(&missing).is_err());
        for (key, value, valid) in [
            ("learning", Value::from(1), false),
            ("learningDefaultsVersion", Value::from(1), true),
            ("learningDefaultsVersion", Value::from(2), false),
            ("position", serde_json::json!({"x":3,"y":3,"steps":0}), false),
            ("position", serde_json::json!({"x":0,"y":1,"steps":0}), false),
            ("position", serde_json::json!({"x":22,"y":13,"steps":0}), true),
            ("position", serde_json::json!({"x":12,"y":10,"steps":-1}), false),
            ("rewards", serde_json::json!({"mon-1":100}), true),
            ("rewards", serde_json::json!({"mon-1":100.5}), false),
            ("rewards", serde_json::json!({"mon-9":1}), false),
            ("rewards", serde_json::json!([]), false),
            ("fieldPreferences", serde_json::json!({"paused":true,"learning":false,"selectedId":""}), true),
            ("fieldPreferences", serde_json::json!({"paused":true,"learning":false}), false),
            ("openWorldPaused", Value::from("yes"), false),
            ("tradeTransferProvenance", serde_json::json!({"mon-1":{"sourceInstanceId":"mon-4"}}), true),
            ("tradeTransferProvenance", serde_json::json!({"mon-1":{"sourceInstanceId":"starter"}}), false),
            ("tradeTransferProvenance", serde_json::json!({"starter":{"sourceInstanceId":"mon-4"}}), false),
            ("tradeTransferProvenance", serde_json::json!({"mon-1":{"sourceInstanceId":"mon-4","tradeId":""}}), false),
            ("tradeTransferProvenance", serde_json::json!({"mon-1":{"sourceInstanceId":"mon-4","tradeId":"t".repeat(101)}}), false),
            ("tradeCompanionMemories", serde_json::json!({"mon-5":{"rewardLedger":{"individualId":"mon-5"}}}), true),
            ("tradeCompanionMemories", serde_json::json!({"mon-5":{"brain":{}}}), false),
            ("tradeCompanionMemories", serde_json::json!({"x":{}}), false),
        ] {
            let mut save = valid_save();
            save["view"]
                .as_object_mut()
                .unwrap()
                .insert(key.into(), value.clone());
            assert_eq!(validate_save(&save).is_ok(), valid, "{key} {value}");
        }
        let mut crowded = valid_save();
        crowded["view"]["tradeTransferProvenance"] = Value::Object(
            (1..=10_001)
                .map(|id| (format!("mon-{id}"), serde_json::json!({"sourceInstanceId":"mon-1"})))
                .collect(),
        );
        assert!(validate_save(&crowded).is_err());
    }

    #[test]
    fn validates_legacy_field_snapshots_like_the_loader() {
        let mut save = valid_save();
        add_box_monster(&mut save, "mon-2");
        save["view"]["field"] = field_snapshot(
            vec![field_record("mon-1", 5, 8)],
            vec![field_record("mon-2", 5, 8)],
        );
        validate_save(&save).unwrap();
        for (pointer, value) in [
            ("/view/field/entities/0/brain/graphId", Value::from("other")),
            ("/view/field/entities/0/x", Value::from(0)),
            ("/view/field/entities/0/y", Value::from(4)),
            ("/view/field/entities/0/energy", Value::from(101)),
            ("/view/field/memories/0/id", Value::from("mon-1")),
            ("/view/field/foods/0/y", Value::from(8)),
            ("/view/field/player/x", Value::from(17)),
            ("/view/field/graphId", Value::from("other")),
        ] {
            let mut edited = save.clone();
            *edited.pointer_mut(pointer).unwrap() = value;
            if pointer == "/view/field/foods/0/y" {
                // Food under an active creature.
                edited["view"]["field"]["foods"][0]["x"] = Value::from(5);
            }
            assert!(validate_save(&edited).is_err(), "{pointer}");
        }
        let mut crowded = save;
        crowded["view"]["field"]["entities"] = Value::Array(
            (0..7)
                .map(|index| field_record(&format!("mon-{}", index + 10), 1 + index, 1))
                .collect(),
        );
        assert!(validate_save(&crowded).is_err());
    }

    #[test]
    fn validates_open_world_creatures_and_reward_ledgers() {
        let mut save = valid_save();
        add_box_monster(&mut save, "mon-2");
        let world = |entities: Vec<Value>, memories: Vec<Value>, ledgers: Value| {
            serde_json::json!({"regionId":"kanto", "mapVersion":"kanto-v3", "entities":entities,
                "companionMemories":memories, "rewardLedgers":ledgers})
        };
        let companion = world_record("companion:mon-1", "companion", 1.0, 1.0);
        let memory = world_record("companion:mon-2", "companion", 2.0, 2.0);
        let wild = world_record("wild-1", "wild", 3.0, 3.0);
        let mut entry_ledger = reward_ledger("mon-2");
        entry_ledger["latest"] = serde_json::json!([{"event":"battle","tick":3,"source":"connectome",
            "learningEligible":true,"total":0.5,"breakdown":{"engagement":0,"damageDealt":0.5,
            "damageReceived":0,"typeChoice":0,"moveEffect":0,"outcome":0,"growth":0,"evolution":0}}]);
        entry_ledger["lifetime"]["events"] = Value::from(1);
        entry_ledger["lifetime"]["eventCounts"]["battle"] = Value::from(1);
        let mut legacy_ledger = reward_ledger("mon-1");
        for key in ["componentTotals", "componentCounts"] {
            legacy_ledger["lifetime"][key]
                .as_object_mut()
                .unwrap()
                .remove("moveEffect");
        }
        save["view"]["openWorld"] = world(
            vec![companion.clone(), wild.clone()],
            vec![memory.clone()],
            serde_json::json!({"mon-1":legacy_ledger,"mon-2":entry_ledger.clone()}),
        );
        validate_save(&save).unwrap();

        let mut unowned = memory.clone();
        unowned["id"] = Value::from("companion:mon-9");
        let mut bypass = memory.clone();
        bypass["brain"]["sensoryBypass"] = Value::Bool(true);
        let mut far = memory.clone();
        far["x"] = Value::from(240.5);
        let mut mismatched = entry_ledger.clone();
        mismatched["latest"][0]["total"] = Value::from(0.4);
        let mut uneven = entry_ledger;
        uneven["lifetime"]["events"] = Value::from(2);
        let empty = serde_json::json!({});
        for (label, candidate) in [
            ("two companions", world(vec![companion.clone(), memory.clone()], vec![], empty.clone())),
            ("no companion", world(vec![wild.clone()], vec![], empty.clone())),
            ("wild memory", world(vec![companion.clone()], vec![wild], empty.clone())),
            ("unowned", world(vec![companion.clone()], vec![unowned], empty.clone())),
            ("duplicate", world(vec![companion.clone()], vec![companion.clone()], empty.clone())),
            ("bypass", world(vec![companion.clone()], vec![bypass], empty.clone())),
            ("outside", world(vec![companion.clone()], vec![far], empty.clone())),
            ("ledger owner", world(vec![companion.clone()], vec![], serde_json::json!({"mon-9":reward_ledger("mon-9")}))),
            ("ledger id", world(vec![companion.clone()], vec![], serde_json::json!({"mon-2":reward_ledger("mon-1")}))),
            ("ledger total", world(vec![companion.clone()], vec![], serde_json::json!({"mon-2":mismatched}))),
            ("ledger events", world(vec![companion], vec![], serde_json::json!({"mon-2":uneven}))),
        ] {
            let mut edited = save.clone();
            edited["view"]["openWorld"] = candidate;
            assert!(validate_save(&edited).is_err(), "{label}");
        }
    }
}
