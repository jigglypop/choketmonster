#!/usr/bin/env python3
"""Build a compact, reproducible MaleCNS v1.0 curated-neuron CSR graph.

The three verified Feather inputs are read-only. The output keeps every directed
edge whose endpoints both have a non-null neuronal superclass (and are not Glia).
Unknown, low-confidence, and modulatory transmitter predictions remain in the
topology with sign zero; they are never guessed to be excitatory.

Run with: uv run --with pyarrow --with numpy scripts/prepare-full-connectome.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
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
MAGIC = b"CHKCSR01"
HEADER = struct.Struct("<8sIIQ")
SIGN_NAMES = {-1: "inhibitory-assumption", 0: "inactive-uncertain", 1: "excitatory-assumption"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_sources(cache: Path) -> None:
    for name, spec in SOURCES.items():
        path = cache / name
        if not path.is_file():
            raise RuntimeError(f"missing source (this script never downloads): {path}")
        if path.stat().st_size != spec["bytes"] or sha256(path) != spec["sha256"]:
            raise RuntimeError(f"source size/SHA-256 mismatch; refusing to modify it: {path}")
        print(f"verified {name}")


def indices(values: np.ndarray, sorted_ids: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    positions = np.searchsorted(sorted_ids, values)
    valid = positions < len(sorted_ids)
    valid[valid] &= sorted_ids[positions[valid]] == values[valid]
    return positions, valid


def selected_nodes(cache: Path) -> tuple[np.ndarray, dict[str, object]]:
    table = feather.read_table(cache / "annotations.feather", columns=["bodyId", "status", "superclass", "type"], memory_map=True)
    status = table["status"].combine_chunks()
    superclass = table["superclass"].combine_chunks()
    non_glia = pc.fill_null(pc.not_equal(status, "Glia"), True)
    keep = pc.and_(non_glia, pc.invert(pc.is_null(superclass)))
    ids = pc.unique(pc.filter(table["bodyId"], keep).combine_chunks()).to_numpy(zero_copy_only=False).copy()
    ids.sort()
    selected = table.filter(keep)
    status_counts = {("null" if row["values"] is None else str(row["values"])): int(row["counts"])
                     for row in pc.value_counts(selected["status"].combine_chunks()).to_pylist()}
    superclass_counts = {str(row["values"]): int(row["counts"])
                         for row in pc.value_counts(selected["superclass"].combine_chunks()).to_pylist()}
    return ids.astype(np.int64, copy=False), {
        "annotationRows": table.num_rows,
        "explicitGliaExcluded": int(pc.sum(pc.equal(status, "Glia")).as_py() or 0),
        "nonGliaMissingSuperclassExcluded": int(pc.sum(pc.and_(non_glia, pc.is_null(superclass))).as_py() or 0),
        "selectedStatusCounts": dict(sorted(status_counts.items())),
        "selectedSuperclassCounts": dict(sorted(superclass_counts.items())),
        "selectedMissingType": int(pc.sum(pc.is_null(selected["type"])).as_py() or 0),
    }


def transmitter_signs(cache: Path, node_ids: np.ndarray) -> tuple[np.ndarray, dict[str, int]]:
    signs = np.zeros(len(node_ids), dtype=np.int8)
    counts: dict[str, int] = {"acetylcholine": 0, "gaba": 0, "glutamate": 0,
                              "lowConfidenceOrUnclear": 0, "otherTransmitter": 0,
                              "missingPrediction": len(node_ids)}
    table = feather.read_table(cache / "neurotransmitters.feather",
                               columns=["body", "consensus_nt", "predicted_nt_confidence"], memory_map=True)
    bodies = table["body"].combine_chunks().to_numpy(zero_copy_only=False)
    pos, in_graph = indices(bodies, node_ids)
    nts = table["consensus_nt"].combine_chunks().to_pylist()
    confidence = table["predicted_nt_confidence"].combine_chunks().to_numpy(zero_copy_only=False)
    seen: set[int] = set()
    for row in np.flatnonzero(in_graph):
        target = int(pos[row])
        if target in seen:
            continue
        seen.add(target)
        counts["missingPrediction"] -= 1
        nt = (nts[row] or "").strip().lower()
        conf = float(confidence[row]) if np.isfinite(confidence[row]) else 0.0
        if conf >= 0.5 and nt == "acetylcholine":
            signs[target] = 1
            counts[nt] += 1
        elif conf >= 0.5 and nt in {"gaba", "glutamate"}:
            signs[target] = -1
            counts[nt] += 1
        elif nt in {"", "unclear"} or conf < 0.5:
            counts["lowConfidenceOrUnclear"] += 1
        else:
            counts["otherTransmitter"] += 1
    return signs, counts


def edge_batches(path: Path):
    source = pa.memory_map(str(path), "r")
    reader = ipc.RecordBatchFileReader(source)
    for batch_index in range(reader.num_record_batches):
        batch = reader.get_batch(batch_index)
        yield (batch.column(0).to_numpy(zero_copy_only=False),
               batch.column(1).to_numpy(zero_copy_only=False),
               batch.column(2).to_numpy(zero_copy_only=False))


def included_edges(pre: np.ndarray, post: np.ndarray, weights: np.ndarray, node_ids: np.ndarray):
    src, src_ok = indices(pre, node_ids)
    dst, dst_ok = indices(post, node_ids)
    keep = src_ok & dst_ok
    return src[keep].astype(np.uint32), dst[keep].astype(np.uint32), weights[keep].astype(np.uint32)


def build(cache: Path, out: Path, force: bool) -> dict[str, object]:
    verify_sources(cache)
    out.mkdir(parents=True, exist_ok=True)
    targets = [out / "graph.bin", out / "node_ids.txt", out / "manifest.json"]
    if not force and any(path.exists() for path in targets):
        raise RuntimeError(f"derived output already exists; pass --force to replace it: {out}")
    node_ids, annotation_stats = selected_nodes(cache)
    if len(node_ids) > np.iinfo(np.uint32).max:
        raise RuntimeError("node count exceeds u32 binary format")
    signs, nt_nodes = transmitter_signs(cache, node_ids)
    incoming_edges = np.zeros(len(node_ids), dtype=np.uint64)
    known_incoming_synapses = np.zeros(len(node_ids), dtype=np.uint64)
    edge_count = source_rows = induced_synapses = known_edges = known_synapses = 0
    for pre, post, weight in edge_batches(cache / "edges.feather"):
        source_rows += len(pre)
        src, dst, syn = included_edges(pre, post, weight, node_ids)
        edge_count += len(src)
        induced_synapses += int(syn.sum(dtype=np.uint64))
        incoming_edges += np.bincount(dst, minlength=len(node_ids)).astype(np.uint64)
        known = signs[src] != 0
        known_edges += int(known.sum())
        known_synapses += int(syn[known].sum(dtype=np.uint64))
        np.add.at(known_incoming_synapses, dst[known], syn[known].astype(np.uint64))
    if edge_count > np.iinfo(np.uint32).max:
        raise RuntimeError("edge count exceeds current per-array indexing implementation")
    offsets = np.empty(len(node_ids) + 1, dtype=np.uint64)
    offsets[0] = 0
    np.cumsum(incoming_edges, out=offsets[1:])
    temp_graph = out / "graph.bin.part"
    total_bytes = HEADER.size + offsets.nbytes + edge_count * 4 + edge_count * 4 + edge_count
    with temp_graph.open("wb") as stream:
        stream.truncate(total_bytes)
    with temp_graph.open("r+b") as stream:
        stream.write(HEADER.pack(MAGIC, 1, len(node_ids), edge_count))
        stream.write(offsets.astype("<u8", copy=False).tobytes())
    sources = np.memmap(temp_graph, dtype="<u4", mode="r+", offset=HEADER.size + offsets.nbytes, shape=(edge_count,))
    synapses = np.memmap(temp_graph, dtype="<u4", mode="r+", offset=HEADER.size + offsets.nbytes + edge_count * 4, shape=(edge_count,))
    edge_signs = np.memmap(temp_graph, dtype="i1", mode="r+", offset=HEADER.size + offsets.nbytes + edge_count * 8, shape=(edge_count,))
    cursor = offsets[:-1].copy()
    for pre, post, weight in edge_batches(cache / "edges.feather"):
        src, dst, syn = included_edges(pre, post, weight, node_ids)
        if not len(src):
            continue
        order = np.argsort(dst, kind="stable")
        sorted_dst = dst[order]
        row = np.arange(len(dst), dtype=np.uint64)
        starts = np.empty(len(dst), dtype=bool)
        starts[0] = True
        starts[1:] = sorted_dst[1:] != sorted_dst[:-1]
        group_start = np.maximum.accumulate(np.where(starts, row, 0))
        positions = cursor[sorted_dst] + row - group_start
        sorted_src = src[order]
        sources[positions] = sorted_src
        synapses[positions] = syn[order]
        edge_signs[positions] = signs[sorted_src]
        cursor += np.bincount(sorted_dst, minlength=len(node_ids)).astype(np.uint64)
    sources.flush(); synapses.flush(); edge_signs.flush()
    del sources, synapses, edge_signs
    if not np.array_equal(cursor, offsets[1:]):
        raise RuntimeError("CSR fill count mismatch")
    graph_sha = sha256(temp_graph)
    os.replace(temp_graph, out / "graph.bin")
    node_temp = out / "node_ids.txt.part"
    with node_temp.open("w", encoding="ascii", newline="\n") as stream:
        for body_id in node_ids:
            stream.write(f"{int(body_id)}\n")
    node_sha = sha256(node_temp)
    os.replace(node_temp, out / "node_ids.txt")
    uncertain_edges = edge_count - known_edges
    manifest: dict[str, object] = {
        "schema": 1,
        "kind": "connectome-curated-neurons",
        "id": f"malecns-v1.0-curated-neurons166700-csr-{graph_sha[:16]}",
        "format": {
            "magic": MAGIC.decode("ascii"), "endianness": "little", "headerBytes": HEADER.size,
            "layout": "header; u64 incoming_offsets[nodes+1]; u32 sources[edges]; u32 synapses[edges]; i8 signs[edges]",
            "signs": {"1": "ACh positive assumption", "-1": "GABA/glutamate negative assumption", "0": "topology retained, recurrent contribution zero"},
        },
        "graph": {
            "nodes": len(node_ids), "edges": edge_count, "synapses": induced_synapses,
            "knownSignedEdges": known_edges, "knownSignedSynapses": known_synapses,
            "uncertainZeroEdges": uncertain_edges,
            "activeEdgeFraction": known_edges / edge_count if edge_count else 0,
            "graphBytes": (out / "graph.bin").stat().st_size, "graphSha256": graph_sha,
            "nodeIdsSha256": node_sha,
        },
        "selection": {
            **annotation_stats,
            "criteria": "Every unique annotations.bodyId with a non-null neuronal superclass and status other than Glia; every source edge with both endpoints in that node set. This yields the canonical 166,700 curated-neuron scope.",
            "exclusions": "Explicit Glia rows; annotation bodies without an assigned superclass; edge endpoints absent from the curated node set; edges with one or both excluded endpoints.",
            "sourceEdgeRowsScanned": source_rows,
            "warning": "The full source edge table is segment-to-segment and its endpoint union is much larger. This artifact covers the 166,700 superclass-assigned curated neurons, not every source segment and not a complete biological brain model.",
        },
        "transmitterModel": {
            "nodeCounts": nt_nodes,
            "assumption": "Presynaptic consensus ACh with confidence >=0.5 is positive; GABA/glutamate with confidence >=0.5 is negative. Other, missing, unclear, and low-confidence predictions are sign 0. Sign is a coarse engineered assumption, not target receptor evidence.",
            "normalization": "Runtime divides each known signed synapse count by the target's total known signed incoming synapses and multiplies by 0.8. Sign-zero edges stay queryable topology but do not drive activity.",
        },
        "provenance": {
            "officialDatasetPage": OFFICIAL_PAGE, "version": VERSION, "license": LICENSE,
            "sourceFiles": [{"name": name, **spec} for name, spec in SOURCES.items()],
            "modeling": "Sensory projection, recurrent dynamics, action readout, action availability, reward, and learning are engineered game mechanisms without anatomical sensory/motor mapping. Output changes or reward do not establish biological learning or intelligence.",
        },
    }
    manifest_temp = out / "manifest.json.part"
    manifest_temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(manifest_temp, out / "manifest.json")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, default=Path("data/local/malecns-v1.0"))
    parser.add_argument("--out", type=Path, default=Path("data/local/malecns-neurons166k"))
    parser.add_argument("--force", action="store_true", help="replace derived outputs only; source Feather files remain read-only")
    args = parser.parse_args()
    manifest = build(args.cache, args.out, args.force)
    graph = manifest["graph"]
    print(f"wrote {args.out}: {graph['nodes']:,} nodes, {graph['edges']:,} edges, {graph['graphBytes']:,} bytes")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"prepare-full-connectome: {error}", file=sys.stderr)
        raise
