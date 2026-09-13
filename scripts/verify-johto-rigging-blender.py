"""Round-trip audit of authored Johto GLBs with Blender 5.2.

The canonical source and candidate GLBs are read only. This script writes only
the requested JSON report directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Vector


EXPECTED_ACTIONS = ("CM_idle", "CM_walk", "CM_attack", "CM_damage")
FRAMES = (0, 6, 12)
ORIGINAL_MOTION_IDS = (160, 168, 183, 196, 197, 200, 210, 212, 249)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--candidate-dir", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--author-verification", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    raw = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(raw)
    for name in ("source_dir", "candidate_dir", "metadata", "author_verification", "output_dir"):
        setattr(args, name, getattr(args, name).resolve())
    return args


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def clear_blender() -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials,
                       bpy.data.images, bpy.data.actions, bpy.data.cameras, bpy.data.lights):
        for item in list(collection):
            if item.users == 0:
                collection.remove(item)


def action_fcurves(action: bpy.types.Action) -> list:
    curves = []
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                curves.extend(channelbag.fcurves)
    return curves


def weighted_mesh_audit(meshes: list[bpy.types.Object]) -> dict:
    vertices = unweighted = non_finite = invalid_sum = 0
    minimum = math.inf
    maximum = -math.inf
    for obj in meshes:
        for vertex in obj.data.vertices:
            vertices += 1
            weights = [float(group.weight) for group in vertex.groups]
            if not weights:
                unweighted += 1
                continue
            if not all(math.isfinite(weight) and weight >= 0 for weight in weights):
                non_finite += 1
                continue
            total = sum(weights)
            minimum = min(minimum, total)
            maximum = max(maximum, total)
            if abs(total - 1) > 2e-3:
                invalid_sum += 1
    return {
        "vertices": vertices,
        "unweighted": unweighted,
        "nonFiniteWeights": non_finite,
        "invalidWeightSums": invalid_sum,
        "weightSumRange": None if minimum is math.inf else [round(minimum, 8), round(maximum, 8)],
    }


def sample_deformed_points(meshes: list[bpy.types.Object]) -> tuple[list[tuple[float, float, float]], int]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points: list[tuple[float, float, float]] = []
    non_finite = 0
    budget_per_mesh = max(16, 768 // max(1, len(meshes)))
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        temporary = evaluated.to_mesh()
        try:
            count = len(temporary.vertices)
            step = max(1, math.ceil(count / budget_per_mesh))
            matrix = evaluated.matrix_world
            for vertex_index in range(0, count, step):
                vertex = temporary.vertices[vertex_index]
                point = matrix @ vertex.co
                values = (float(point.x), float(point.y), float(point.z))
                if not all(math.isfinite(value) for value in values):
                    non_finite += 1
                points.append(values)
        finally:
            evaluated.to_mesh_clear()
    return points, non_finite


def point_delta(left: list[tuple[float, float, float]], right: list[tuple[float, float, float]]) -> dict:
    if len(left) != len(right):
        return {"samples": min(len(left), len(right)), "changed": 0, "maxDelta": None, "topologyChanged": True}
    deltas = [math.dist(a, b) for a, b in zip(left, right)]
    return {
        "samples": len(deltas),
        "changed": sum(delta > 1e-7 for delta in deltas),
        "maxDelta": round(max(deltas, default=0.0), 9),
        "topologyChanged": False,
    }


def audit_candidate(path: Path) -> dict:
    clear_blender()
    bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True)
    objects = list(bpy.context.scene.objects)
    meshes = [obj for obj in objects if obj.type == "MESH"]
    armatures = [obj for obj in objects if obj.type == "ARMATURE"]
    skinned = [obj for obj in meshes if any(modifier.type == "ARMATURE" and modifier.object for modifier in obj.modifiers)]
    bones = sorted({bone.name for armature in armatures for bone in armature.data.bones})
    actions = {action.name: action for action in bpy.data.actions}
    animation_targets = [obj for obj in objects if obj.animation_data]
    for obj in animation_targets:
        for track in obj.animation_data.nla_tracks:
            track.mute = True

    # No action is the imported bind/rest evaluation reference.
    for obj in animation_targets:
        obj.animation_data.action = None
    bpy.context.scene.frame_set(0)
    bind_points, bind_non_finite = sample_deformed_points(skinned)

    action_results = []
    for name in EXPECTED_ACTIONS:
        action = actions.get(name)
        if action is None:
            action_results.append({"name": name, "present": False})
            continue
        target = animation_targets[0] if animation_targets else None
        if target is None:
            action_results.append({"name": name, "present": True, "targetMissing": True})
            continue
        target.animation_data.action = action
        if action.slots:
            target.animation_data.action_slot = action.slots[0]
        frames = {}
        points_by_frame = {}
        for frame in FRAMES:
            bpy.context.scene.frame_set(frame)
            points, non_finite = sample_deformed_points(skinned)
            points_by_frame[frame] = points
            frames[str(frame)] = {
                "finite": non_finite == 0,
                "nonFinitePositions": non_finite,
                "vsBind": point_delta(bind_points, points),
            }
        frames["6"]["vsFrame0"] = point_delta(points_by_frame[0], points_by_frame[6])
        frames["12"]["vsFrame0"] = point_delta(points_by_frame[0], points_by_frame[12])
        curves = action_fcurves(action)
        action_results.append({
            "name": name,
            "present": True,
            "frameRange": [round(float(value), 6) for value in action.frame_range],
            "fcurves": len(curves),
            "keyframes": sum(len(curve.keyframe_points) for curve in curves),
            "frames": frames,
        })

    weights = weighted_mesh_audit(skinned)
    failures = []
    if not meshes:
        failures.append("no meshes")
    if not skinned:
        failures.append("no skinned meshes")
    if not armatures or not bones:
        failures.append("no armature joints")
    if weights["unweighted"] or weights["nonFiniteWeights"] or weights["invalidWeightSums"]:
        failures.append("invalid skin weights")
    if bind_non_finite:
        failures.append("non-finite bind positions")
    for result in action_results:
        if not result.get("present"):
            failures.append(f"missing {result['name']}")
            continue
        if result.get("targetMissing"):
            failures.append(f"no target for {result['name']}")
            continue
        if not result["fcurves"]:
            failures.append(f"no curves for {result['name']}")
        if any(not frame_result["finite"] for frame_result in result["frames"].values()):
            failures.append(f"non-finite deformation in {result['name']}")
        if result["frames"]["6"]["vsFrame0"]["changed"] == 0 and result["frames"]["12"]["vsFrame0"]["changed"] == 0:
            failures.append(f"no sampled deformation in {result['name']}")
    return {
        "id": int(path.stem),
        "candidate": {"path": path.as_posix(), "bytes": path.stat().st_size, "sha256": sha256(path)},
        "objects": len(objects),
        "meshes": len(meshes),
        "skinnedMeshes": len(skinned),
        "armatures": len(armatures),
        "joints": len(bones),
        "boneNames": bones,
        "weights": weights,
        "bindSample": {"positions": len(bind_points), "nonFinitePositions": bind_non_finite},
        "actions": action_results,
        "failures": failures,
        "passed": not failures,
    }


def main() -> None:
    args = arguments()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    author = json.loads(args.author_verification.read_text(encoding="utf-8"))
    expected_hash = {int(entry["id"]): entry["sha256"] for entry in metadata["entries"] if 152 <= int(entry["id"]) <= 251}
    author_by_id = {int(entry["id"]): entry for entry in author["results"]}

    source_before = {}
    canonical = []
    for pokemon_id in range(152, 252):
        path = args.source_dir / f"{pokemon_id}.glb"
        current = sha256(path)
        source_before[pokemon_id] = current
        canonical.append({
            "id": pokemon_id,
            "path": path.as_posix(),
            "bytes": path.stat().st_size,
            "expectedSha256": expected_hash[pokemon_id],
            "currentSha256Before": current,
            "matchesCanonical": current == expected_hash[pokemon_id],
        })

    candidate_paths = sorted(args.candidate_dir.glob("*.glb"), key=lambda path: int(path.stem))
    candidate_ids = {int(path.stem) for path in candidate_paths}
    expected_candidates = set(range(152, 252)) - set(ORIGINAL_MOTION_IDS)
    results = []
    for index, path in enumerate(candidate_paths, start=1):
        try:
            result = audit_candidate(path)
        except Exception as error:
            result = {
                "id": int(path.stem),
                "candidate": {"path": path.as_posix(), "bytes": path.stat().st_size, "sha256": sha256(path)},
                "passed": False,
                "failures": [f"Blender import/audit exception: {type(error).__name__}: {error}"],
            }
        authored = author_by_id.get(result["id"], {}).get("authored", {})
        # 222 had a source skin, but the authoring path deliberately replaced it.
        result["category"] = "new-native-geometry" if result["id"] == 222 or not authored.get("sourceSkeleton", False) else "existing-source-skeleton"
        result["authorNumericQaPassed"] = bool(author_by_id.get(result["id"], {}).get("passed"))
        results.append(result)
        print(f"ROUNDTRIP {index:02d}/{len(candidate_paths)} #{result['id']} {'PASS' if result['passed'] else 'FAIL'}", flush=True)

    source_after = {pokemon_id: sha256(args.source_dir / f"{pokemon_id}.glb") for pokemon_id in range(152, 252)}
    for entry in canonical:
        pokemon_id = entry["id"]
        entry["currentSha256After"] = source_after[pokemon_id]
        entry["unchangedDuringAudit"] = source_before[pokemon_id] == source_after[pokemon_id]

    missing_candidates = sorted(expected_candidates - candidate_ids)
    unexpected_candidates = sorted(candidate_ids - expected_candidates)
    category_counts = Counter(result["category"] for result in results)
    report = {
        "schema": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "tool": {"name": "Blender", "version": bpy.app.version_string},
        "scope": {
            "candidateExpected": 91,
            "candidateFound": len(candidate_paths),
            "frames": list(FRAMES),
            "actions": list(EXPECTED_ACTIONS),
            "originalMotionIdsNotReexported": list(ORIGINAL_MOTION_IDS),
        },
        "provenanceBoundary": {
            "canonicalSource": "Immutable downloaded GLBs, validated against docs/pokemon-rigging-metadata.json SHA-256.",
            "candidate": "Locally authored/re-exported GLBs under artifacts/johto-rigging; candidate hashes are separate and do not replace canonical hashes.",
            "authorNumericQa": args.author_verification.as_posix(),
            "blenderRoundTrip": "Fresh Blender import, skin/weights/actions and evaluated mesh positions at frames 0/6/12.",
        },
        "canonicalSources": canonical,
        "omittedOriginalMotion": [{
            "id": pokemon_id,
            "sourceSha256": source_before[pokemon_id],
            "candidate": None,
            "reason": "Original source already has motion; no authored candidate was exported.",
        } for pokemon_id in ORIGINAL_MOTION_IDS],
        "candidateInventory": {
            "missing": missing_candidates,
            "unexpected": unexpected_candidates,
            "categories": dict(sorted(category_counts.items())),
        },
        "results": results,
        "summary": {
            "passed": sum(result["passed"] for result in results),
            "failed": sum(not result["passed"] for result in results),
            "authorNumericQaPassed": sum(result["authorNumericQaPassed"] for result in results),
            "canonicalSourcesMatching": sum(entry["matchesCanonical"] for entry in canonical),
            "canonicalSourcesUnchanged": sum(entry["unchangedDuringAudit"] for entry in canonical),
        },
    }
    report["passed"] = (
        report["summary"]["passed"] == 91
        and report["summary"]["canonicalSourcesMatching"] == 100
        and report["summary"]["canonicalSourcesUnchanged"] == 100
        and not missing_candidates and not unexpected_candidates
        and category_counts == Counter({"new-native-geometry": 55, "existing-source-skeleton": 36})
    )
    destination = args.output_dir / "report.json"
    destination.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("JOHTO_RIGGING_BLENDER_RESULT=" + json.dumps({"report": str(destination), "passed": report["passed"], **report["summary"]}), flush=True)
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
