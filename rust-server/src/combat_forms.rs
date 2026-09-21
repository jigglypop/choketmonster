use serde::Deserialize;
use std::{collections::HashMap, sync::OnceLock};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CombatStats {
    pub(crate) hp: i64,
    pub(crate) attack: i64,
    pub(crate) defense: i64,
    pub(crate) special_attack: i64,
    pub(crate) special_defense: i64,
    pub(crate) speed: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CombatAbility {
    pub(crate) id: i64,
    pub(crate) slot: i64,
    pub(crate) hidden: bool,
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) english_name: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CombatMove {
    pub(crate) level: i64,
    pub(crate) move_id: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CombatForm {
    pub(crate) identifier: String,
    pub(crate) species_id: i64,
    pub(crate) kind: String,
    pub(crate) types: Vec<String>,
    pub(crate) base_stats: CombatStats,
    pub(crate) abilities: Vec<CombatAbility>,
    pub(crate) level_up_moves: Vec<CombatMove>,
}

#[derive(Deserialize)]
struct CombatFormFile {
    forms: Vec<CombatForm>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldItem {
    id: String,
    name: String,
    kind: String,
    form_identifier: Option<String>,
    species_id: Option<i64>,
}

fn forms() -> &'static HashMap<String, CombatForm> {
    static FORMS: OnceLock<HashMap<String, CombatForm>> = OnceLock::new();
    FORMS.get_or_init(|| {
        let parsed: CombatFormFile = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/data/pokemon-combat-forms.json"
        )))
        .expect("combat form catalog");
        parsed
            .forms
            .into_iter()
            .map(|form| (form.identifier.clone(), form))
            .collect()
    })
}

pub(crate) fn combat_form(identifier: &str) -> Option<&'static CombatForm> {
    forms().get(identifier)
}

pub(crate) fn mega_model_available(identifier: &str) -> bool {
    static MODELS: OnceLock<std::collections::HashSet<String>> = OnceLock::new();
    MODELS.get_or_init(|| {
        #[derive(Deserialize)]
        struct Model { identifier: String }
        #[derive(Deserialize)]
        struct Manifest { entries: Vec<Model> }
        let manifest: Manifest = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"), "/../src/data/pokemon-mega-models-manifest.json"
        ))).expect("Mega model manifest");
        manifest.entries.into_iter().map(|model| model.identifier).collect()
    }).contains(identifier)
}

fn field_items() -> &'static HashMap<String, FieldItem> {
    static ITEMS: OnceLock<HashMap<String, FieldItem>> = OnceLock::new();
    ITEMS.get_or_init(|| {
        let parsed: Vec<FieldItem> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/data/field-items.json"
        )))
        .expect("field item catalog");
        let item_count = parsed.len();
        let items: HashMap<_, _> = parsed
            .into_iter()
            .map(|item| {
                assert!(!item.id.is_empty() && !item.name.trim().is_empty());
                match item.kind.as_str() {
                    "held-tool" => {
                        assert!(item.form_identifier.is_none() && item.species_id.is_none());
                    }
                    "mega-stone" => {
                        let identifier = item.form_identifier.as_deref().expect("Mega stone form");
                        let form = combat_form(identifier).expect("Mega stone combat form");
                        assert_eq!(item.id, format!("mega-stone:{identifier}"));
                        assert_eq!(item.species_id, Some(form.species_id));
                        assert!(form.kind == "mega" && mega_model_available(identifier));
                    }
                    _ => panic!("unsupported field item kind"),
                }
                (item.id.clone(), item)
            })
            .collect();
        assert_eq!(items.len(), item_count, "duplicate field item id");
        items
    })
}

pub(crate) fn field_item_exists(identifier: &str) -> bool {
    field_items().contains_key(identifier)
}

pub(crate) fn held_tool_valid_for_species(identifier: &str, species_id: i64) -> bool {
    field_items().get(identifier).is_some_and(|item| {
        item.kind == "held-tool" || item.kind == "mega-stone" && item.species_id == Some(species_id)
    })
}

pub(crate) fn mega_stone_matches(identifier: &str, form_identifier: &str) -> bool {
    field_items().get(identifier).is_some_and(|item| {
        item.kind == "mega-stone" && item.form_identifier.as_deref() == Some(form_identifier)
    })
}
