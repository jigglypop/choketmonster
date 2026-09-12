use anyhow::{Context, Result, bail};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::time::Instant;

const MAGIC: &[u8; 8] = b"CHKCSR01";
const INPUTS: usize = 12;
const ACTIONS: usize = 5;
const FEATURES: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: u32,
    kind: String,
    id: String,
    graph: ManifestGraph,
    selection: Value,
    transmitter_model: Value,
    provenance: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestGraph {
    nodes: usize,
    edges: u64,
    known_signed_edges: u64,
    uncertain_zero_edges: u64,
    active_edge_fraction: f64,
    graph_bytes: u64,
    graph_sha256: String,
    node_ids_sha256: String,
}

/// One immutable MaleCNS topology shared by every creature state.
pub struct Connectome {
    graph_id: String,
    offsets: Vec<u64>,
    sources: Vec<u32>,
    weights: Vec<f32>,
    edges: u64,
    manifest_info: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeuralState {
    pub schema: u32,
    pub graph_id: String,
    pub seed: u64,
    pub activity: Vec<f32>,
    pub readout: Vec<Vec<f32>>,
    pub previous: Option<Vec<f32>>,
    pub action: usize,
    pub rng: u64,
    pub updates: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRequest {
    pub inputs: Vec<f32>,
    pub available: Vec<bool>,
    pub reward: Option<f32>,
    pub learning: bool,
    pub terminal: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub action: usize,
    pub updates: u64,
    pub activity: f32,
    pub elapsed_ms: f64,
    pub graph_id: String,
    pub nodes: usize,
    pub edges: u64,
}

impl Connectome {
    pub fn load(dir: &Path) -> Result<Self> {
        let manifest_path = dir.join("manifest.json");
        let manifest: Manifest = serde_json::from_reader(BufReader::new(
            File::open(&manifest_path)
                .with_context(|| format!("open {}", manifest_path.display()))?,
        ))
        .context("parse full-connectome manifest")?;
        if manifest.schema != 1 || manifest.graph.nodes < 2 || manifest.graph.edges == 0 {
            bail!("unsupported or empty full-connectome manifest");
        }
        if manifest.kind != "connectome-curated-neurons" {
            bail!("manifest is not a curated-neuron connectome");
        }
        if manifest.graph.known_signed_edges + manifest.graph.uncertain_zero_edges
            != manifest.graph.edges
        {
            bail!("manifest edge accounting mismatch");
        }
        let graph_path = dir.join("graph.bin");
        let metadata = std::fs::metadata(&graph_path)
            .with_context(|| format!("stat {}", graph_path.display()))?;
        if metadata.len() != manifest.graph.graph_bytes {
            bail!("graph.bin size differs from manifest");
        }
        let actual_sha = file_sha256(&graph_path)?;
        if actual_sha != manifest.graph.graph_sha256 {
            bail!("graph.bin SHA-256 differs from manifest");
        }
        let node_ids_path = dir.join("node_ids.txt");
        if file_sha256(&node_ids_path)? != manifest.graph.node_ids_sha256 {
            bail!("node_ids.txt SHA-256 differs from manifest");
        }

        let mut reader = BufReader::with_capacity(8 * 1024 * 1024, File::open(&graph_path)?);
        let mut magic = [0_u8; 8];
        reader.read_exact(&mut magic)?;
        if &magic != MAGIC {
            bail!("invalid full-connectome binary magic");
        }
        let schema = read_u32(&mut reader)?;
        let nodes = read_u32(&mut reader)? as usize;
        let edges = read_u64(&mut reader)?;
        if schema != 1 || nodes != manifest.graph.nodes || edges != manifest.graph.edges {
            bail!("binary header differs from manifest");
        }
        let edge_len = usize::try_from(edges).context("edge count does not fit this platform")?;
        let mut offsets = Vec::with_capacity(nodes + 1);
        for _ in 0..=nodes {
            offsets.push(read_u64(&mut reader)?);
        }
        if offsets.first() != Some(&0)
            || offsets.last() != Some(&edges)
            || offsets.windows(2).any(|pair| pair[0] > pair[1])
        {
            bail!("invalid CSR offsets");
        }
        let mut sources = Vec::with_capacity(edge_len);
        for _ in 0..edge_len {
            let source = read_u32(&mut reader)?;
            if source as usize >= nodes {
                bail!("CSR source index out of range");
            }
            sources.push(source);
        }
        let mut synapses = Vec::with_capacity(edge_len);
        for _ in 0..edge_len {
            synapses.push(read_u32(&mut reader)?);
        }
        let mut sign_bytes = vec![0_u8; edge_len];
        reader.read_exact(&mut sign_bytes)?;
        let signs: Vec<i8> = sign_bytes.into_iter().map(|value| value as i8).collect();
        if signs.iter().any(|sign| !matches!(sign, -1..=1)) {
            bail!("invalid transmitter sign code");
        }
        let mut trailing = [0_u8; 1];
        if reader.read(&mut trailing)? != 0 {
            bail!("unexpected trailing graph bytes");
        }

        let mut weights = vec![0.0_f32; edge_len];
        for target in 0..nodes {
            let start = offsets[target] as usize;
            let end = offsets[target + 1] as usize;
            let denominator: u64 = (start..end)
                .filter(|&edge| signs[edge] != 0)
                .map(|edge| synapses[edge] as u64)
                .sum();
            if denominator == 0 {
                continue;
            }
            let scale = 0.8_f32 / denominator as f32;
            for edge in start..end {
                weights[edge] = signs[edge] as f32 * synapses[edge] as f32 * scale;
            }
        }
        drop(synapses);
        drop(signs);
        let manifest_info = json!({
            "graphId": manifest.id,
            "kind": manifest.kind,
            "nodes": nodes,
            "edges": edges,
            "activeEdges": manifest.graph.known_signed_edges,
            "uncertainZeroEdges": manifest.graph.uncertain_zero_edges,
            "activeEdgeFraction": manifest.graph.active_edge_fraction,
            "residentGraphBytesEstimate": offsets.len() * std::mem::size_of::<u64>()
                + sources.len() * std::mem::size_of::<u32>()
                + weights.len() * std::mem::size_of::<f32>(),
            "selection": manifest.selection,
            "transmitterModel": manifest.transmitter_model,
            "provenance": manifest.provenance,
        });
        Ok(Self {
            graph_id: manifest_info["graphId"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            offsets,
            sources,
            weights,
            edges,
            manifest_info,
        })
    }

    pub fn info(&self) -> Value {
        self.manifest_info.clone()
    }

    pub fn step(&self, state: &mut NeuralState, request: &StepRequest) -> Result<StepResult> {
        self.step_inner(state, request, true)
    }

    fn step_inner(
        &self,
        state: &mut NeuralState,
        request: &StepRequest,
        recurrence: bool,
    ) -> Result<StepResult> {
        let started = Instant::now();
        self.validate_state(state)?;
        if request.inputs.len() != INPUTS || request.inputs.iter().any(|x| !x.is_finite()) {
            bail!("inputs must contain 12 finite values");
        }
        if request.available.len() != ACTIONS
            || !request.available.iter().any(|available| *available)
        {
            bail!("available must contain 5 flags with at least one action enabled");
        }
        if request.reward.is_some_and(|reward| !reward.is_finite()) {
            bail!("reward must be finite");
        }
        // A terminal request is the reward-flush/reset boundary between battles.
        // It deliberately performs no new recurrent decision.
        if request.terminal {
            if request.learning {
                if let Some(reward) = request.reward {
                    update_readout(state, reward, 0.0)?;
                }
            }
            state.activity.fill(0.0);
            state.previous = None;
            state.action = 4;
            return Ok(StepResult {
                action: 4,
                updates: state.updates,
                activity: 0.0,
                elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                graph_id: self.graph_id.clone(),
                nodes: self.nodes(),
                edges: self.edges,
            });
        }
        let previous_activity = &state.activity;
        let mut next = vec![0.0_f32; self.nodes()];
        next.par_iter_mut().enumerate().for_each(|(target, value)| {
            let mut sum = sensory_projection(state.seed, target, &request.inputs);
            if recurrence {
                let start = self.offsets[target] as usize;
                let end = self.offsets[target + 1] as usize;
                for edge in start..end {
                    sum += previous_activity[self.sources[edge] as usize] * self.weights[edge];
                }
            }
            *value = 0.35 * previous_activity[target] + 0.65 * sum.tanh();
        });
        state.activity = next;
        let features = pooled_features(&state.activity);
        let values = action_values(&state.readout, &features);
        if request.learning {
            if let Some(reward) = request.reward {
                let bootstrap = request
                    .available
                    .iter()
                    .enumerate()
                    .filter(|(_, available)| **available)
                    .map(|(action, _)| values[action])
                    .fold(f32::NEG_INFINITY, f32::max);
                update_readout(state, reward, bootstrap)?;
            }
        }
        let current = action_values(&state.readout, &features);
        let greedy_action = request
            .available
            .iter()
            .enumerate()
            .filter(|(_, available)| **available)
            .max_by(|(left, _), (right, _)| {
                current[*left]
                    .total_cmp(&current[*right])
                    .then_with(|| right.cmp(left))
            })
            .map(|(index, _)| index)
            .context("no available action")?;
        let action = if request.learning {
            state.rng = splitmix64(state.rng);
            if unit_interval(state.rng) < 0.08 {
                let available: Vec<usize> = request
                    .available
                    .iter()
                    .enumerate()
                    .filter_map(|(index, enabled)| enabled.then_some(index))
                    .collect();
                state.rng = splitmix64(state.rng);
                available[(state.rng as usize) % available.len()]
            } else {
                greedy_action
            }
        } else {
            greedy_action
        };
        state.action = action;
        state.previous = Some(features);
        let active = state
            .activity
            .iter()
            .filter(|value| value.abs() > 0.05)
            .count();
        Ok(StepResult {
            action,
            updates: state.updates,
            activity: active as f32 / self.nodes() as f32,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            graph_id: self.graph_id.clone(),
            nodes: self.nodes(),
            edges: self.edges,
        })
    }

    fn validate_state(&self, state: &NeuralState) -> Result<()> {
        if state.schema != 1
            || state.graph_id != self.graph_id
            || state.activity.len() != self.nodes()
            || state
                .activity
                .iter()
                .any(|x| !x.is_finite() || x.abs() > 1.001)
            || state.readout.len() != ACTIONS
            || state.readout.iter().any(|row| {
                row.len() != FEATURES || row.iter().any(|x| !x.is_finite() || x.abs() > 12.001)
            })
            || state
                .previous
                .as_ref()
                .is_some_and(|row| row.len() != FEATURES || row.iter().any(|x| !x.is_finite()))
            || state.action >= ACTIONS
        {
            bail!("neural state is malformed or belongs to another graph");
        }
        Ok(())
    }

    fn nodes(&self) -> usize {
        self.offsets.len() - 1
    }
}

impl NeuralState {
    pub fn new(graph: &Connectome, seed: u64) -> Self {
        let mut rng = seed ^ 0xa076_1d64_78bd_642f;
        let readout = (0..ACTIONS)
            .map(|_| {
                (0..FEATURES)
                    .map(|_| {
                        rng = splitmix64(rng);
                        unit_signed(rng) * 0.02
                    })
                    .collect()
            })
            .collect();
        Self {
            schema: 1,
            graph_id: graph.graph_id.clone(),
            seed,
            activity: vec![0.0; graph.nodes()],
            readout,
            previous: None,
            action: 4,
            rng,
            updates: 0,
        }
    }
}

fn update_readout(state: &mut NeuralState, reward: f32, bootstrap: f32) -> Result<()> {
    let Some(previous) = state.previous.as_ref() else {
        return Ok(());
    };
    let row = state
        .readout
        .get_mut(state.action)
        .context("previous action is invalid")?;
    let estimate: f32 = row
        .iter()
        .zip(previous)
        .map(|(weight, feature)| weight * feature)
        .sum();
    let delta = (reward + 0.85 * bootstrap - estimate).clamp(-4.0, 4.0);
    let norm = 1.0
        + previous
            .iter()
            .map(|feature| feature * feature)
            .sum::<f32>();
    for (weight, feature) in row.iter_mut().zip(previous) {
        *weight = (*weight + 0.14 * delta * feature / norm).clamp(-12.0, 12.0);
    }
    state.updates = state
        .updates
        .checked_add(1)
        .context("learning update counter overflow")?;
    Ok(())
}

fn pooled_features(activity: &[f32]) -> Vec<f32> {
    let mut sums = vec![0.0_f32; FEATURES];
    let mut counts = [0_u32; FEATURES];
    for (index, value) in activity.iter().enumerate() {
        let bucket = index % FEATURES;
        sums[bucket] += *value;
        counts[bucket] += 1;
    }
    for (sum, count) in sums.iter_mut().zip(counts) {
        *sum = *sum / count.max(1) as f32 * 0.35;
    }
    sums
}

fn action_values(readout: &[Vec<f32>], features: &[f32]) -> Vec<f32> {
    readout
        .iter()
        .map(|row| {
            row.iter()
                .zip(features)
                .map(|(weight, feature)| weight * feature)
                .sum()
        })
        .collect()
}

fn sensory_projection(seed: u64, node: usize, inputs: &[f32]) -> f32 {
    inputs
        .iter()
        .enumerate()
        .map(|(input, value)| {
            let key = seed
                ^ (node as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
                ^ (input as u64).wrapping_mul(0xd1b5_4a32_d192_ed03);
            unit_signed(splitmix64(key)) * 0.6 * value
        })
        .sum()
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn unit_signed(value: u64) -> f32 {
    ((value >> 40) as f32 / 8_388_607.5) - 1.0
}

fn unit_interval(value: u64) -> f32 {
    (value >> 40) as f32 / 16_777_216.0
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut reader = BufReader::with_capacity(
        8 * 1024 * 1024,
        File::open(path).with_context(|| format!("open {}", path.display()))?,
    );
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 8 * 1024 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn read_u32(reader: &mut impl Read) -> Result<u32> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> Result<u64> {
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_graph() -> Option<Connectome> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/local/malecns-neurons166k");
        dir.exists()
            .then(|| Connectome::load(&dir).expect("load generated full graph"))
    }

    #[test]
    fn full_graph_step_is_replay_deterministic_and_eval_is_frozen() {
        let Some(graph) = full_graph() else {
            return;
        };
        let request = StepRequest {
            inputs: vec![0.2; INPUTS],
            available: vec![true; ACTIONS],
            reward: None,
            learning: false,
            terminal: false,
        };
        let mut left = NeuralState::new(&graph, 42);
        let mut right = left.clone();
        let eval_rng = left.rng;
        let left_result = graph.step(&mut left, &request).unwrap();
        let right_result = graph.step(&mut right, &request).unwrap();
        assert_eq!(left_result.action, right_result.action);
        assert_eq!(left.activity, right.activity);
        assert_eq!(left.readout, right.readout);
        assert_eq!(left.rng, eval_rng);
        assert_eq!(left.updates, 0);
        assert_eq!(graph.info()["nodes"], 166_700);
        assert_eq!(graph.info()["edges"], 25_582_938_u64);
        let state_bytes = bincode::serialize(&left).unwrap().len();
        eprintln!(
            "full step elapsedMs={:.3} activity={:.6} serializedStateBytes={state_bytes}",
            left_result.elapsed_ms, left_result.activity
        );
    }

    #[test]
    fn full_graph_topology_changes_activity() {
        let Some(graph) = full_graph() else {
            return;
        };
        let request = StepRequest {
            inputs: (0..INPUTS).map(|i| i as f32 / 11.0 - 0.5).collect(),
            available: vec![true; ACTIONS],
            reward: None,
            learning: false,
            terminal: false,
        };
        let mut recurrent = NeuralState::new(&graph, 7);
        let mut ablated = recurrent.clone();
        graph.step_inner(&mut recurrent, &request, true).unwrap();
        graph.step_inner(&mut ablated, &request, false).unwrap();
        graph.step_inner(&mut recurrent, &request, true).unwrap();
        graph.step_inner(&mut ablated, &request, false).unwrap();
        let mean_l1 = recurrent
            .activity
            .iter()
            .zip(&ablated.activity)
            .map(|(left, right)| (left - right).abs())
            .sum::<f32>()
            / graph.nodes() as f32;
        eprintln!("topology ablation meanActivityL1={mean_l1:.8}");
        assert!(
            mean_l1 > 1e-5,
            "full topology should affect recurrent activity: {mean_l1}"
        );
    }

    #[test]
    fn learning_updates_only_prior_action_and_terminal_clears_trace() {
        let Some(graph) = full_graph() else {
            return;
        };
        let mut state = NeuralState::new(&graph, 9);
        let initial_rng = state.rng;
        let observe = StepRequest {
            inputs: vec![0.25; INPUTS],
            available: vec![true; ACTIONS],
            reward: None,
            learning: true,
            terminal: false,
        };
        graph.step(&mut state, &observe).unwrap();
        assert_ne!(state.rng, initial_rng);
        let before = state.readout.clone();
        let finish = StepRequest {
            inputs: vec![0.25; INPUTS],
            available: vec![true; ACTIONS],
            reward: Some(1.0),
            learning: true,
            terminal: true,
        };
        graph.step(&mut state, &finish).unwrap();
        assert_eq!(state.updates, 1);
        assert_ne!(state.readout, before);
        assert!(state.previous.is_none());
        assert!(state.activity.iter().all(|value| *value == 0.0));
    }
}
