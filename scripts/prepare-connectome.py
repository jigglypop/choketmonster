#!/usr/bin/env python3
"""Download, verify, and extract a reproducible MaleCNS v1.0 circuit.

Requires pyarrow (for example: uv run --with pyarrow scripts/prepare-connectome.py).
The upstream files are immutable inputs: completed files are reused after SHA-256
verification and interrupted downloads resume from a .part file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.ipc as ipc


VERSION = "MaleCNS v1.0 (minconf 0.5)"
LICENSE = "CC-BY 4.0"
OFFICIAL_PAGE = "https://male-cns.janelia.org/download/"
BASE = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
SOURCES = {
    "annotations.feather": {
        "url": f"{BASE}/body-annotations-male-cns-v1.0-minconf-0.5.feather",
        "bytes": 14_483_314,
        "sha256": "2177e246113e4cfbf1e7772ec37c6da1955ff22e8063d0b1f833101f99a9a3b2",
    },
    "neurotransmitters.feather": {
        "url": f"{BASE}/body-neurotransmitters-male-cns-v1.0.feather",
        "bytes": 43_282_834,
        "sha256": "95c9289220663abeb3409f3ad9e5a7f8a53f8093f5139d15502cd08da8879621",
    },
    "edges.feather": {
        "url": f"{BASE}/connectome-weights-male-cns-v1.0-minconf-0.5.feather",
        "bytes": 1_051_241_946,
        "sha256": "e35da783d1c686b2b58b3b87cd6a403ae43bfcfba8bff28e08ef752c1a56afc1",
    },
}
SUPPORTED_NT = {"acetylcholine": 1, "gaba": -1, "glutamate": -1}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def valid_source(path: Path, spec: dict[str, object]) -> bool:
    return path.is_file() and path.stat().st_size == spec["bytes"] and sha256(path) == spec["sha256"]


def download(name: str, cache: Path) -> Path:
    spec = SOURCES[name]
    target = cache / name
    partial = cache / f"{name}.part"
    if valid_source(target, spec):
        print(f"reuse verified {name} ({target.stat().st_size:,} bytes)")
        return target
    if target.exists():
        raise RuntimeError(f"refusing to replace invalid completed source: {target}")
    offset = partial.stat().st_size if partial.exists() else 0
    if offset > int(spec["bytes"]):
        raise RuntimeError(f"partial file is larger than expected: {partial}")
    request = urllib.request.Request(str(spec["url"]), headers={"Range": f"bytes={offset}-"} if offset else {})
    print(f"download {name} from byte {offset:,}")
    with urllib.request.urlopen(request) as response:
        if offset and response.status != 206:
            raise RuntimeError(f"server did not honor resume request for {name}")
        mode = "ab" if offset else "wb"
        with partial.open(mode) as output:
            shutil.copyfileobj(response, output, 8 * 1024 * 1024)
    if partial.stat().st_size != spec["bytes"] or sha256(partial) != spec["sha256"]:
        raise RuntimeError(f"downloaded bytes failed size/SHA-256 check: {partial}")
    os.replace(partial, target)
    print(f"verified {name} {spec['sha256']}")
    return target


def text(value: object) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def table_rows(path: Path, columns: list[str]):
    table = feather.read_table(path, columns=columns, memory_map=True)
    yield from table.to_pylist()


def select_circuit(cache: Path, node_count: int) -> dict[str, object]:
    if not 64 <= node_count <= 256:
        raise ValueError("--nodes must be between 64 and 256")

    nt_by_body: dict[int, dict[str, object]] = {}
    for row in table_rows(cache / "neurotransmitters.feather", ["body", "consensus_nt", "predicted_nt_confidence", "ground_truth"]):
        nt = text(row["consensus_nt"])
        confidence = float(row["predicted_nt_confidence"] or 0)
        if nt in SUPPORTED_NT and confidence >= 0.5:
            nt_by_body[int(row["body"])] = {"nt": nt, "confidence": confidence, "groundTruth": text(row["ground_truth"])}

    metadata: dict[int, dict[str, object]] = {}
    annotation_columns = ["bodyId", "instance", "type", "superclass", "class", "subclass", "status", "somaSide"]
    for row in table_rows(cache / "annotations.feather", annotation_columns):
        body = int(row["bodyId"])
        neuron_type, superclass = text(row["type"]), text(row["superclass"])
        if body not in nt_by_body or not neuron_type or not superclass or text(row["status"]) == "Glia":
            continue
        nt = nt_by_body[body]
        metadata[body] = {
            "id": str(body), "instance": text(row["instance"]), "type": neuron_type,
            "superclass": superclass, "class": text(row["class"]), "subclass": text(row["subclass"]),
            "status": text(row["status"]), "somaSide": text(row["somaSide"]),
            "neurotransmitter": nt["nt"], "ntConfidence": round(float(nt["confidence"]), 6),
            "ntGroundTruth": nt["groundTruth"],
        }

    seeds = sorted((body for body, row in metadata.items() if row["type"] == "DNa02"), key=lambda body: str(metadata[body]["instance"]))
    if len(seeds) != 2:
        raise RuntimeError(f"expected the bilateral DNa02 pair, found {seeds}")

    eligible = set(metadata)
    scores: dict[int, int] = {}
    edge_path = cache / "edges.feather"
    source = pa.memory_map(str(edge_path), "r")
    reader = ipc.RecordBatchFileReader(source)
    seed_set = set(seeds)
    rows_scanned = 0
    for batch_index in range(reader.num_record_batches):
        batch = reader.get_batch(batch_index)
        pre = batch.column(0).to_pylist()
        post = batch.column(1).to_pylist()
        weights = batch.column(2).to_pylist()
        rows_scanned += batch.num_rows
        for a, b, weight in zip(pre, post, weights):
            if a in seed_set and b in eligible and b not in seed_set:
                scores[b] = scores.get(b, 0) + int(weight)
            if b in seed_set and a in eligible and a not in seed_set:
                scores[a] = scores.get(a, 0) + int(weight)
    ranked = sorted(scores, key=lambda body: (-scores[body], body))
    if len(ranked) < node_count - len(seeds):
        raise RuntimeError(f"only {len(ranked)} eligible annotated direct DNa02 partners")
    selected = seeds + ranked[: node_count - len(seeds)]
    selected_set = set(selected)
    indices = {body: index for index, body in enumerate(selected)}

    raw_edges: list[dict[str, object]] = []
    incoming = [0] * len(selected)
    source.seek(0)
    reader = ipc.RecordBatchFileReader(source)
    for batch_index in range(reader.num_record_batches):
        batch = reader.get_batch(batch_index)
        pre = batch.column(0).to_pylist()
        post = batch.column(1).to_pylist()
        weights = batch.column(2).to_pylist()
        for a, b, synapses in zip(pre, post, weights):
            if a not in selected_set or b not in selected_set:
                continue
            sign = SUPPORTED_NT[str(metadata[a]["neurotransmitter"])]
            signed_count = sign * int(synapses)
            incoming[indices[b]] += abs(signed_count)
            raw_edges.append({"source": indices[a], "target": indices[b], "signedCount": signed_count, "synapses": int(synapses)})
    if not raw_edges:
        raise RuntimeError("selected circuit has no induced edges")
    if len(raw_edges) > 50_000:
        raise RuntimeError(f"selected circuit has {len(raw_edges)} edges, exceeding Graph limit")

    edges = [{"source": edge["source"], "target": edge["target"],
              "weight": edge["signedCount"] / incoming[int(edge["target"])] * 0.8,
              "synapses": edge["synapses"]} for edge in raw_edges]
    counts: dict[str, int] = {}
    for body in selected:
        key = str(metadata[body]["superclass"])
        counts[key] = counts.get(key, 0) + 1

    return {
        "schema": 1, "kind": "connectome-subset", "id": f"malecns-v1.0-dna02-neighborhood-{node_count}",
        "nodes": [str(body) for body in selected], "edges": edges,
        "provenance": {
            "source": SOURCES["edges.feather"]["url"], "version": VERSION, "license": LICENSE,
            "sha256": SOURCES["edges.feather"]["sha256"],
            "note": "Induced subgraph around the bilateral DNa02 locomotor descending-neuron pair. Partners are annotated neurons with acetylcholine, GABA, or glutamate consensus prediction confidence >=0.5, ranked by total measured synapse count to/from the seeds. Edge signs are a coarse transmitter assumption (ACh positive; GABA/glutamate negative), not receptor evidence. Absolute incoming signed counts are normalized to 0.8. Game sensory projection, learned action readout, and rewards are engineered and have no anatomical mapping. The generic Brain supports sensory skip features; the Pokemon model disables that bypass (sensoryBypass=false). This is not a whole-brain model.",
        },
        "nodeMetadata": [metadata[body] for body in selected],
        "selection": {
            "seedType": "DNa02", "seedIds": [str(body) for body in seeds], "requestedNodes": node_count,
            "selectedNodes": len(selected), "inducedEdges": len(edges), "inducedSynapses": sum(int(e["synapses"]) for e in edges),
            "sourceEdgeRowsScanned": rows_scanned, "eligibleAnnotatedNeurons": len(eligible),
            "superclassCounts": dict(sorted(counts.items())),
            "criteria": "Bilateral type DNa02 seeds plus strongest direct annotated partners by summed released edge weight; deterministic ties by numeric body ID.",
            "exclusions": "Missing type/superclass, Glia status, transmitter outside ACh/GABA/glutamate, or neuron-level predicted NT confidence below 0.5.",
        },
        "sourceFiles": [{"name": name, **spec} for name, spec in SOURCES.items()],
        "officialDatasetPage": OFFICIAL_PAGE,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, default=Path("data/local/malecns-v1.0"))
    parser.add_argument("--out", type=Path, default=Path("public/data/connectome.json"))
    parser.add_argument("--nodes", type=int, default=128)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    for name in SOURCES:
        download(name, args.cache)
    lock = {name: spec for name, spec in SOURCES.items()}
    (args.cache / "source.lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
    graph = select_circuit(args.cache, args.nodes)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out}: {len(graph['nodes'])} nodes, {len(graph['edges'])} edges")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"prepare-connectome: {error}", file=sys.stderr)
        raise
