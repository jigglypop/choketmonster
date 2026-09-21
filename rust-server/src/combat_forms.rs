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
