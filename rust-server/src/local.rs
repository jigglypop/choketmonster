use crate::connectome::{Connectome, NeuralState, StepRequest, StepResult};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    sync::Mutex,
    time::{Duration, Instant},
};

const CACHE_CAPACITY: usize = 64;
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_HISTORY: usize = 7;
const MAX_COMPRESSED_CHECKPOINT: usize = 1_500_000;
const MAX_CHECKPOINT: u64 = 2_000_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBatchRequest {
    pub client_id: String,
    pub steps: Vec<LocalStep>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStep {
    pub creature_id: String,
    pub request_id: String,
    pub episode_id: String,
    pub inputs: Vec<f32>,
    pub available: Vec<bool>,
    pub reward: Option<f32>,
    pub learning: bool,
    pub terminal: bool,
    pub checkpoint: Option<String>,
    pub checkpoint_id: Option<String>,
    #[serde(default)]
    pub history: Vec<LocalHistoryStep>,
    #[serde(default)]
    pub return_checkpoint: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHistoryStep {
    pub request_id: String,
    pub episode_id: String,
    pub inputs: Vec<f32>,
    pub available: Vec<bool>,
    pub reward: Option<f32>,
    pub learning: bool,
    pub terminal: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBatchResponse {
    pub decisions: Vec<LocalDecision>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCheckpointRequest {
    pub client_id: String,
    pub creature_id: String,
    pub last_request_id: String,
    pub checkpoint: Option<String>,
    pub checkpoint_id: Option<String>,
    #[serde(default)]
    pub history: Vec<LocalHistoryStep>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCheckpointResponse {
    pub checkpoint: String,
    pub checkpoint_id: String,
}

/// Materialize an already recorded head. No new action, reward or random draw
/// is added; replay uses the donor's original initialization seed.
pub fn materialize_checkpoint(
    graph: &Connectome,
    request: LocalCheckpointRequest,
) -> Result<LocalCheckpointResponse, LocalError> {
    validate_client_id(&request.client_id)?;
    validate_identifier(&request.creature_id)?;
    validate_identifier(&request.last_request_id)?;
    if request.history.len() > MAX_HISTORY
        || request.checkpoint.is_some() != request.checkpoint_id.is_some()
    {
        return Err(LocalError::Invalid("Invalid checkpoint and history pair."));
    }
    if let Some(id) = &request.checkpoint_id {
        validate_identifier(id)?;
    }
    let head = request
        .history
        .last()
        .map(|step| step.request_id.as_str())
        .or(request.checkpoint_id.as_deref());
    if head != Some(request.last_request_id.as_str()) {
        return Err(LocalError::Invalid(
            "Checkpoint history does not end at the requested head.",
        ));
    }
    let mut ids = HashSet::new();
    for step in &request.history {
        validate_identifier(&step.request_id)?;
        validate_identifier(&step.episode_id)?;
        validate_step_values(&step.inputs, &step.available, step.reward)?;
        if !ids.insert(&step.request_id) || request.checkpoint_id.as_ref() == Some(&step.request_id)
        {
            return Err(LocalError::Invalid("Duplicate checkpoint history request."));
        }
    }
    let (mut neural, mut episode) = if let Some(encoded) = request.checkpoint.as_deref() {
        let decoded = decode_checkpoint(encoded)?;
        (decoded.state, decoded.episode_id)
    } else {
        let first = request
            .history
            .first()
            .ok_or(LocalError::Invalid("Checkpoint history is empty."))?;
        (
            NeuralState::new(
                graph,
                creature_seed(&request.client_id, &request.creature_id),
            ),
            first.episode_id.clone(),
        )
    };
    for step in &request.history {
        reset_for_episode(&mut neural, &mut episode, &step.episode_id);
        graph
            .step(&mut neural, &history_request(step))
            .map_err(|_| LocalError::Invalid("Invalid neural checkpoint or replay history."))?;
    }
    Ok(LocalCheckpointResponse {
        checkpoint: encode_checkpoint(&neural, &episode)?,
        checkpoint_id: request.last_request_id,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDecision {
    pub creature_id: String,
    pub request_id: String,
    pub decision: StepResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct CheckpointEnvelope {
    schema: u32,
    episode_id: String,
    state: NeuralState,
}

#[derive(Debug)]
pub enum LocalError {
    Invalid(&'static str),
    Conflict(&'static str),
    CheckpointRequired(&'static str),
    Busy(&'static str),
    Internal(String),
}

struct CacheEntry {
    state: NeuralState,
    head: String,
    episode_id: String,
    last_request_id: String,
    last_request_hash: String,
    last_response: LocalDecision,
    touched: Instant,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<(String, String), CacheEntry>,
    busy_clients: HashSet<String>,
}

#[derive(Default)]
pub struct LocalBrains {
    inner: Mutex<Inner>,
}

impl LocalBrains {
    pub fn try_begin(&self, client_id: &str) -> Result<(), LocalError> {
        validate_client_id(client_id)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|error| LocalError::Internal(error.to_string()))?;
        if !inner.busy_clients.insert(client_id.to_owned()) {
            return Err(LocalError::Busy(
                "This client already has a neural batch in progress.",
            ));
        }
        Ok(())
    }

    pub fn finish(&self, client_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.busy_clients.remove(client_id);
        }
    }

    pub fn process(
        &self,
        graph: &Connectome,
        batch: LocalBatchRequest,
    ) -> Result<LocalBatchResponse, LocalError> {
        validate_batch(&batch)?;
        let mut decisions = Vec::with_capacity(batch.steps.len());
        for step in batch.steps {
            decisions.push(self.process_one(graph, &batch.client_id, step)?);
        }
        Ok(LocalBatchResponse { decisions })
    }

    fn process_one(
        &self,
        graph: &Connectome,
        client_id: &str,
        step: LocalStep,
    ) -> Result<LocalDecision, LocalError> {
        let request_hash = canonical_hash(&step)?;
        let key = (client_id.to_owned(), step.creature_id.clone());
        let recent_head = step
            .history
            .last()
            .map(|item| item.request_id.as_str())
            .or(step.checkpoint_id.as_deref());

        let cached = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|error| LocalError::Internal(error.to_string()))?;
            prune(&mut inner.entries);
            if let Some(entry) = inner.entries.get_mut(&key) {
                if entry.last_request_id == step.request_id {
                    if entry.last_request_hash != request_hash {
                        return Err(LocalError::Conflict(
                            "The same requestId was used with different neural inputs.",
                        ));
                    }
                    entry.touched = Instant::now();
                    return Ok(entry.last_response.clone());
                }
                if recent_head == Some(entry.head.as_str()) {
                    Some((entry.state.clone(), entry.episode_id.clone()))
                } else {
                    None
                }
            } else {
                None
            }
        };

        let (mut neural, mut episode_id, replay_history) = if let Some((state, episode)) = cached {
            (state, episode, false)
        } else if let Some(encoded) = step.checkpoint.as_deref() {
            let checkpoint = decode_checkpoint(encoded)?;
            (checkpoint.state, checkpoint.episode_id, true)
        } else {
            if step.checkpoint_id.is_some() {
                return Err(LocalError::CheckpointRequired(
                    "The server cache missed this checkpoint; resend the same request with checkpoint data.",
                ));
            }
            (
                NeuralState::new(graph, creature_seed(client_id, &step.creature_id)),
                step.history
                    .first()
                    .map(|item| item.episode_id.clone())
                    .unwrap_or_else(|| step.episode_id.clone()),
                true,
            )
        };

        if replay_history {
            for item in &step.history {
                reset_for_episode(&mut neural, &mut episode_id, &item.episode_id);
                graph
                    .step(&mut neural, &history_request(item))
                    .map_err(|_| {
                        LocalError::Invalid("Invalid neural checkpoint or replay history.")
                    })?;
            }
        }
        reset_for_episode(&mut neural, &mut episode_id, &step.episode_id);
        let result = graph
            .step(&mut neural, &step_request(&step))
            .map_err(|_| LocalError::Invalid("Invalid neural step input or checkpoint."))?;
        let checkpoint = step
            .return_checkpoint
            .then(|| encode_checkpoint(&neural, &episode_id))
            .transpose()?;
        let response = LocalDecision {
            creature_id: step.creature_id.clone(),
            request_id: step.request_id.clone(),
            decision: result,
            checkpoint,
        };
        let entry = CacheEntry {
            state: neural,
            head: step.request_id.clone(),
            episode_id,
            last_request_id: step.request_id,
            last_request_hash: request_hash,
            last_response: response.clone(),
            touched: Instant::now(),
        };
        let mut inner = self
            .inner
            .lock()
            .map_err(|error| LocalError::Internal(error.to_string()))?;
        prune(&mut inner.entries);
        if !inner.entries.contains_key(&key) && inner.entries.len() >= CACHE_CAPACITY {
            if let Some(oldest) = inner
                .entries
                .iter()
                .min_by_key(|(_, value)| value.touched)
                .map(|(key, _)| key.clone())
            {
                inner.entries.remove(&oldest);
            }
        }
        inner.entries.insert(key, entry);
        Ok(response)
    }
}

fn validate_batch(batch: &LocalBatchRequest) -> Result<(), LocalError> {
    validate_client_id(&batch.client_id)?;
    if !(1..=2).contains(&batch.steps.len()) {
        return Err(LocalError::Invalid(
            "A local neural batch must contain one or two steps.",
        ));
    }
    let mut creatures = HashSet::new();
    for step in &batch.steps {
        validate_identifier(&step.creature_id)?;
        validate_identifier(&step.request_id)?;
        validate_identifier(&step.episode_id)?;
        if !creatures.insert(&step.creature_id) {
            return Err(LocalError::Invalid(
                "Batch creatureId values must be distinct.",
            ));
        }
        if step.history.len() > MAX_HISTORY {
            return Err(LocalError::Invalid(
                "Replay history may contain at most seven steps.",
            ));
        }
        if step.checkpoint.is_some() && step.checkpoint_id.is_none() {
            return Err(LocalError::Invalid("checkpoint requires checkpointId."));
        }
        if let Some(id) = &step.checkpoint_id {
            validate_identifier(id)?;
        }
        let mut requests = HashSet::new();
        requests.insert(step.request_id.as_str());
        for item in &step.history {
            validate_identifier(&item.request_id)?;
            validate_identifier(&item.episode_id)?;
            if !requests.insert(item.request_id.as_str()) {
                return Err(LocalError::Invalid(
                    "Replay requestId values must be distinct.",
                ));
            }
            validate_step_values(&item.inputs, &item.available, item.reward)?;
        }
        validate_step_values(&step.inputs, &step.available, step.reward)?;
    }
    Ok(())
}

fn validate_client_id(value: &str) -> Result<(), LocalError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(LocalError::Invalid(
            "clientId must contain exactly 64 hexadecimal characters.",
        ));
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), LocalError> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
    {
        return Err(LocalError::Invalid("Invalid local neural identifier."));
    }
    Ok(())
}

fn validate_step_values(
    inputs: &[f32],
    available: &[bool],
    reward: Option<f32>,
) -> Result<(), LocalError> {
    if inputs.len() != 12 || inputs.iter().any(|value| !value.is_finite()) {
        return Err(LocalError::Invalid("inputs must contain 12 finite values."));
    }
    if available.len() != 5 || !available.iter().any(|value| *value) {
        return Err(LocalError::Invalid(
            "available must enable at least one of five actions.",
        ));
    }
    if reward.is_some_and(|value| !value.is_finite()) {
        return Err(LocalError::Invalid("reward must be finite."));
    }
    Ok(())
}

fn step_request(step: &LocalStep) -> StepRequest {
    StepRequest {
        inputs: step.inputs.clone(),
        available: step.available.clone(),
        reward: step.reward,
        learning: step.learning,
        terminal: step.terminal,
    }
}

fn history_request(step: &LocalHistoryStep) -> StepRequest {
    StepRequest {
        inputs: step.inputs.clone(),
        available: step.available.clone(),
        reward: step.reward,
        learning: step.learning,
        terminal: step.terminal,
    }
}

fn reset_for_episode(state: &mut NeuralState, current: &mut String, next: &str) {
    if current != next {
        state.activity.fill(0.0);
        state.previous = None;
        state.action = 4;
        current.clear();
        current.push_str(next);
    }
}

fn creature_seed(client_id: &str, creature_id: &str) -> u64 {
    let mut digest = Sha256::new();
    digest.update(client_id.as_bytes());
    digest.update([0]);
    digest.update(creature_id.as_bytes());
    let bytes = digest.finalize();
    u64::from_le_bytes(bytes[..8].try_into().expect("SHA-256 prefix"))
}

fn canonical_hash(step: &LocalStep) -> Result<String, LocalError> {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "creatureId": step.creature_id,
        "requestId": step.request_id,
        "episodeId": step.episode_id,
        "inputs": step.inputs,
        "available": step.available,
        "reward": step.reward,
        "learning": step.learning,
        "terminal": step.terminal,
        "checkpointId": step.checkpoint_id,
        "history": step.history,
        "returnCheckpoint": step.return_checkpoint,
    }))
    .map_err(|error| LocalError::Internal(error.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn encode_checkpoint(state: &NeuralState, episode_id: &str) -> Result<String, LocalError> {
    let envelope = CheckpointEnvelope {
        schema: 1,
        episode_id: episode_id.to_owned(),
        state: state.clone(),
    };
    let serialized =
        bincode::serialize(&envelope).map_err(|error| LocalError::Internal(error.to_string()))?;
    if serialized.len() as u64 > MAX_CHECKPOINT {
        return Err(LocalError::Internal(
            "Neural checkpoint exceeds its size bound.".into(),
        ));
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(&serialized)
        .map_err(|error| LocalError::Internal(error.to_string()))?;
    let compressed = encoder
        .finish()
        .map_err(|error| LocalError::Internal(error.to_string()))?;
    Ok(STANDARD.encode(compressed))
}

fn decode_checkpoint(encoded: &str) -> Result<CheckpointEnvelope, LocalError> {
    if encoded.len() > (MAX_COMPRESSED_CHECKPOINT * 4 / 3 + 8) {
        return Err(LocalError::Invalid(
            "Compressed neural checkpoint is too large.",
        ));
    }
    let compressed = STANDARD
        .decode(encoded)
        .map_err(|_| LocalError::Invalid("Neural checkpoint is not valid base64."))?;
    if compressed.len() > MAX_COMPRESSED_CHECKPOINT {
        return Err(LocalError::Invalid(
            "Compressed neural checkpoint is too large.",
        ));
    }
    let mut bytes = Vec::new();
    GzDecoder::new(compressed.as_slice())
        .take(MAX_CHECKPOINT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LocalError::Invalid("Neural checkpoint is not valid gzip."))?;
    if bytes.len() as u64 > MAX_CHECKPOINT {
        return Err(LocalError::Invalid(
            "Neural checkpoint expands beyond its size bound.",
        ));
    }
    let envelope: CheckpointEnvelope = bincode::deserialize(&bytes)
        .map_err(|_| LocalError::Invalid("Neural checkpoint is invalid."))?;
    if envelope.schema != 1 {
        return Err(LocalError::Invalid(
            "Neural checkpoint schema is unsupported.",
        ));
    }
    validate_identifier(&envelope.episode_id)?;
    Ok(envelope)
}

fn prune(entries: &mut HashMap<(String, String), CacheEntry>) {
    entries.retain(|_, entry| entry.touched.elapsed() < CACHE_TTL);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn graph() -> Option<Connectome> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/local/malecns-neurons166k");
        dir.exists().then(|| Connectome::load(&dir).unwrap())
    }

    fn step(request_id: &str, checkpoint: Option<(String, String)>) -> LocalStep {
        LocalStep {
            creature_id: "9007199254740993".into(),
            request_id: request_id.into(),
            episode_id: "battle-1".into(),
            inputs: vec![0.2; 12],
            available: vec![true; 5],
            reward: Some(0.25),
            learning: true,
            terminal: false,
            checkpoint: checkpoint.as_ref().map(|value| value.0.clone()),
            checkpoint_id: checkpoint.map(|value| value.1),
            history: vec![],
            return_checkpoint: true,
        }
    }

    fn batch(step: LocalStep) -> LocalBatchRequest {
        LocalBatchRequest {
            client_id: "a".repeat(64),
            steps: vec![step],
        }
    }

    fn history(step: &LocalStep) -> LocalHistoryStep {
        LocalHistoryStep {
            request_id: step.request_id.clone(),
            episode_id: step.episode_id.clone(),
            inputs: step.inputs.clone(),
            available: step.available.clone(),
            reward: step.reward,
            learning: step.learning,
            terminal: step.terminal,
        }
    }

    #[test]
    fn retry_is_idempotent_and_conflicting_body_is_rejected() {
        let Some(graph) = graph() else { return };
        let store = LocalBrains::default();
        let request = batch(step("request-1", None));
        let first = store.process(&graph, request.clone()).unwrap();
        let retry = store.process(&graph, request).unwrap();
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            serde_json::to_value(retry).unwrap()
        );
        let mut conflict = step("request-1", None);
        conflict.inputs[0] = 0.9;
        assert!(matches!(
            store.process(&graph, batch(conflict)),
            Err(LocalError::Conflict(_))
        ));
    }

    #[test]
    fn concurrent_batches_for_one_client_are_rejected() {
        let store = LocalBrains::default();
        let client_id = "b".repeat(64);
        store.try_begin(&client_id).unwrap();
        assert!(matches!(
            store.try_begin(&client_id),
            Err(LocalError::Busy(_))
        ));
        store.finish(&client_id);
        store.try_begin(&client_id).unwrap();
        store.finish(&client_id);
    }

    #[test]
    fn checkpoint_and_bounded_history_reload_match_cached_state() {
        let Some(graph) = graph() else { return };
        let cached = LocalBrains::default();
        let first = cached
            .process(&graph, batch(step("request-1", None)))
            .unwrap();
        let checkpoint = first.decisions[0].checkpoint.clone().unwrap();
        eprintln!("local checkpoint base64Bytes={}", checkpoint.len());
        let mut second_step = step("request-2", Some((checkpoint.clone(), "request-1".into())));
        second_step.checkpoint = None;
        cached.process(&graph, batch(second_step.clone())).unwrap();
        let cold = LocalBrains::default();
        assert!(matches!(
            cold.process(&graph, batch(second_step.clone())),
            Err(LocalError::CheckpointRequired(_))
        ));
        let mut third_step = step("request-3", Some((checkpoint.clone(), "request-1".into())));
        third_step.history = vec![history(&second_step)];
        let expected = cached.process(&graph, batch(third_step)).unwrap();

        let restarted = LocalBrains::default();
        let mut replayed = step("request-3", Some((checkpoint, "request-1".into())));
        replayed.history = vec![history(&second_step)];
        let actual = restarted.process(&graph, batch(replayed)).unwrap();
        let left = &expected.decisions[0].decision;
        let right = &actual.decisions[0].decision;
        assert_eq!(
            (left.action, left.updates, left.activity),
            (right.action, right.updates, right.activity)
        );
        assert_eq!(
            expected.decisions[0].checkpoint,
            actual.decisions[0].checkpoint
        );
    }

    #[test]
    fn materialized_history_preserves_exact_state_across_recipient_identity() {
        let Some(graph) = graph() else { return };
        let first_step = step("recorded-1", None);
        let donor = LocalBrains::default();
        let first = donor.process(&graph, batch(first_step.clone())).unwrap();
        let packed = materialize_checkpoint(
            &graph,
            LocalCheckpointRequest {
                client_id: "a".repeat(64),
                creature_id: first_step.creature_id.clone(),
                last_request_id: first_step.request_id.clone(),
                checkpoint: None,
                checkpoint_id: None,
                history: vec![history(&first_step)],
            },
        )
        .unwrap();
        assert_eq!(
            Some(&packed.checkpoint),
            first.decisions[0].checkpoint.as_ref()
        );
        let next = step(
            "recorded-2",
            Some((packed.checkpoint.clone(), packed.checkpoint_id.clone())),
        );
        let expected = donor.process(&graph, batch(next.clone())).unwrap();
        let mut transferred = next;
        transferred.creature_id = "mon-999".into();
        let actual = LocalBrains::default()
            .process(
                &graph,
                LocalBatchRequest {
                    client_id: "b".repeat(64),
                    steps: vec![transferred],
                },
            )
            .unwrap();
        assert_eq!(
            expected.decisions[0].checkpoint,
            actual.decisions[0].checkpoint
        );
        assert_eq!(
            expected.decisions[0].decision.updates,
            actual.decisions[0].decision.updates
        );
    }
}
