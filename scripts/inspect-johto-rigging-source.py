"""Inspect pinned Johto GLBs in Blender without modifying the source files.

Run:
  blender --background --python scripts/inspect-johto-rigging-source.py -- \
    --source-dir data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65 \
    --output-dir artifacts/johto-rigging-source
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import struct
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Vector


DEFAULT_RENDER_IDS = (152, 161, 179, 165, 170, 194, 201, 208)
REPRESENTATIVE_NOTES = {
    152: {"bodyType": "small quadruped with a head leaf and optional left/right vine effect meshes", "suggestedBones": ["root", "pelvis", "spine", "neck", "head", "leg.FL", "leg.FR", "leg.BL", "leg.BR", "leaf.01", "leaf.02", "vine.L.01-10", "vine.R.01-10"]},
    161: {"bodyType": "upright body with two feet and a weight-bearing tail", "suggestedBones": ["root", "pelvis", "spine", "head", "ear.L", "ear.R", "arm.L", "arm.R", "leg.L", "leg.R", "tail.01", "tail.02"]},
    179: {"bodyType": "compact quadruped with short legs, neck/head and tail", "suggestedBones": ["root", "pelvis", "spine", "neck", "head", "leg.FL", "leg.FR", "leg.BL", "leg.BR", "tail.01", "tail.02"]},
    165: {"bodyType": "winged insect with six limbs and two wing pairs", "suggestedBones": ["root", "thorax", "head", "wing.FL", "wing.FR", "wing.BL", "wing.BR", "leg.FL", "leg.FR", "leg.ML", "leg.MR", "leg.BL", "leg.BR"]},
    170: {"bodyType": "floating aquatic body with two long antennae and small fins", "suggestedBones": ["root", "body", "head", "antenna.L.01", "antenna.L.02", "antenna.R.01", "antenna.R.02", "fin.L", "fin.R", "tail"]},
    194: {"bodyType": "small upright amphibious body with two feet, head frills and tail", "suggestedBones": ["root", "pelvis", "spine", "head", "gill.L", "gill.R", "leg.L", "leg.R", "tail.01", "tail.02"]},
    201: {"bodyType": "thin floating rigid glyph; no limb articulation", "suggestedBones": ["root", "body"]},
    208: {"bodyType": "horizontal segmented serpent with jaw and serial body chain", "suggestedBones": ["root", "head", "jaw", "spine.01", "spine.02", "spine.03", "spine.04", "spine.05", "spine.06", "tail"]},
}
VIEWS = {
    "front": Vector((0.0, -1.0, 0.18)),
    "side": Vector((1.0, 0.0, 0.18)),
    "three-quarter": Vector((0.75, -0.75, 0.22)),
}


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--render-ids", default=",".join(map(str, DEFAULT_RENDER_IDS)))
    parser.add_argument("--no-render", action="store_true")
    raw = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(raw)
    args.render_ids = tuple(int(value) for value in args.render_ids.split(",") if value)
    args.source_dir = args.source_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    return args


def clear_scene() -> None:
    # Imported glTF nodes may be hidden and therefore skipped by select/delete.
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for datablocks in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials,
                       bpy.data.cameras, bpy.data.lights, bpy.data.actions):
        for block in list(datablocks):
            datablocks.remove(block)


def world_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    if not points:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    return Vector(tuple(min(point[i] for point in points) for i in range(3))), Vector(
        tuple(max(point[i] for point in points) for i in range(3))
    )


def is_helper_mesh(obj: bpy.types.Object) -> bool:
    return obj.name.startswith("Icosphere") and not obj.vertex_groups \
        and not any(modifier.type == "ARMATURE" for modifier in obj.modifiers)


def source_glb_structure(source: Path) -> dict:
    data = source.read_bytes()
    if data[:4] != b"glTF" or len(data) < 20:
        raise ValueError(f"Not a GLB v2 file: {source}")
    offset = 12
    document = None
    while offset + 8 <= len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8 : offset + 8 + length]
        if chunk_type == 0x4E4F534A:
            document = json.loads(chunk.rstrip(b" \t\r\n\0").decode("utf-8"))
            break
        offset += 8 + length
    if document is None:
        raise ValueError(f"Missing GLB JSON chunk: {source}")
    node_names = [node.get("name") for node in document.get("nodes", []) if node.get("name")]
    mesh_names = [mesh.get("name") for mesh in document.get("meshes", []) if mesh.get("name")]
    return {
        "nodes": len(document.get("nodes", [])),
        "meshes": len(document.get("meshes", [])),
        "skins": len(document.get("skins", [])),
        "animations": len(document.get("animations", [])),
        "nodeNames": node_names,
        "meshNames": mesh_names,
        "containsIcosphereName": any("icosphere" in name.lower() for name in node_names + mesh_names),
    }


def object_bounds(obj: bpy.types.Object) -> dict[str, list[float]]:
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
    high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
    return {"min": rounded(low), "max": rounded(high), "dimensions": rounded(high - low)}


def vertex_group_weights(obj: bpy.types.Object) -> list[dict]:
    stats = {group.index: {"name": group.name, "assignedVertices": 0, "totalWeight": 0.0, "maxWeight": 0.0}
             for group in obj.vertex_groups}
    for vertex in obj.data.vertices:
        for assignment in vertex.groups:
            item = stats.get(assignment.group)
            if item is None:
                continue
            item["assignedVertices"] += 1
            item["totalWeight"] += float(assignment.weight)
            item["maxWeight"] = max(item["maxWeight"], float(assignment.weight))
    return [{**item, "totalWeight": round(item["totalWeight"], 6), "maxWeight": round(item["maxWeight"], 6)}
            for item in stats.values() if item["assignedVertices"]]


def rounded(vector: Vector) -> list[float]:
    return [round(float(value), 6) for value in vector]


def floor_contacts(meshes: list[bpy.types.Object], low: Vector, high: Vector) -> dict:
    height = max(high.z - low.z, 1e-8)
    threshold = low.z + max(height * 0.035, 1e-5)
    contacts: list[Vector] = []
    for obj in meshes:
        matrix = obj.matrix_world
        contacts.extend(matrix @ vertex.co for vertex in obj.data.vertices if (matrix @ vertex.co).z <= threshold)
    if not contacts:
        return {"thresholdZ": round(threshold, 6), "vertexCount": 0, "centroid": None, "leftCentroid": None, "rightCentroid": None}

    def centroid(values: list[Vector]) -> list[float] | None:
        return rounded(sum(values, Vector()) / len(values)) if values else None

    center_x = (low.x + high.x) / 2
    return {
        "thresholdZ": round(threshold, 6),
        "vertexCount": len(contacts),
        "centroid": centroid(contacts),
        "leftCentroid": centroid([point for point in contacts if point.x < center_x]),
        "rightCentroid": centroid([point for point in contacts if point.x >= center_x]),
    }


def heuristic_anchors(low: Vector, high: Vector) -> dict[str, list[float]]:
    center = (low + high) / 2
    height = high.z - low.z
    at = lambda z: rounded(Vector((center.x, center.y, low.z + height * z)))
    return {
        "groundCenter": rounded(Vector((center.x, center.y, low.z))),
        "pelvis": at(0.42),
        "spine": at(0.62),
        "neck": at(0.78),
        "head": at(0.88),
    }


ROLE_PATTERNS = {
    "root": re.compile(r"(^|_)(root|master)(_|$)|^waist$|^hips$", re.I),
    "pelvis": re.compile(r"hip|pelvis|waist", re.I),
    "spine": re.compile(r"spine|chest|body", re.I),
    "neck": re.compile(r"neck", re.I),
    "head": re.compile(r"head", re.I),
    "jaw": re.compile(r"jaw|mouth", re.I),
    "leftArm": re.compile(r"(^l|left).*(arm|shoulder|hand)|(^l)(arm|shoulder|hand)", re.I),
    "rightArm": re.compile(r"(^r|right).*(arm|shoulder|hand)|(^r)(arm|shoulder|hand)", re.I),
    "leftLeg": re.compile(r"(^l|left).*(leg|thigh|foot|toe)|(^l)(leg|thigh|foot|toe)", re.I),
    "rightLeg": re.compile(r"(^r|right).*(leg|thigh|foot|toe)|(^r)(leg|thigh|foot|toe)", re.I),
    "tail": re.compile(r"tail", re.I),
    "wing": re.compile(r"wing", re.I),
}


def role_candidates(bone_names: list[str]) -> dict[str, list[str]]:
    return {role: [name for name in bone_names if pattern.search(name)] for role, pattern in ROLE_PATTERNS.items()}


def inspect_one(source: Path) -> dict:
    glb_structure = source_glb_structure(source)
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(source), import_pack_images=True)
    objects = list(bpy.context.scene.objects)
    meshes = [obj for obj in objects if obj.type == "MESH"]
    armatures = [obj for obj in objects if obj.type == "ARMATURE"]
    actions = list(bpy.data.actions)
    content_meshes = [obj for obj in meshes if not is_helper_mesh(obj)]
    low, high = world_bounds(content_meshes)
    all_low, all_high = world_bounds(meshes)
    bone_names = sorted({bone.name for obj in armatures for bone in obj.data.bones})
    root_bones = sorted({bone.name for obj in armatures for bone in obj.data.bones if bone.parent is None})
    if armatures and actions:
        status = "rigged-animated"
    elif armatures:
        status = "rigged-static"
    elif actions:
        status = "transform-animated"
    else:
        status = "static"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    return {
        "id": int(source.stem),
        "source": source.as_posix(),
        "bytes": source.stat().st_size,
        "sha256": digest,
        "sourceGlbStructure": glb_structure,
        "status": status,
        "objects": len(objects),
        "meshObjects": len(meshes),
        "meshDetails": [{
            "name": obj.name,
            "dataName": obj.data.name,
            "parent": obj.parent.name if obj.parent else None,
            "vertices": len(obj.data.vertices),
            "polygons": len(obj.data.polygons),
            "vertexGroups": len(obj.vertex_groups),
            "armatureModifiers": [modifier.object.name for modifier in obj.modifiers
                                  if modifier.type == "ARMATURE" and modifier.object],
            "translation": rounded(obj.matrix_world.translation),
            "scale": rounded(obj.matrix_world.to_scale()),
            "blenderImporterHelper": is_helper_mesh(obj),
            "bounds": object_bounds(obj),
            "vertexGroupWeights": vertex_group_weights(obj),
        } for obj in meshes],
        "vertices": sum(len(obj.data.vertices) for obj in meshes),
        "polygons": sum(len(obj.data.polygons) for obj in meshes),
        "materials": len({slot.material.name for obj in meshes for slot in obj.material_slots if slot.material}),
        "armatures": len(armatures),
        "bones": len(bone_names),
        "boneNames": bone_names,
        "rootBones": root_bones,
        "boneRoleCandidates": role_candidates(bone_names),
        "armatureDetails": [{
            "name": obj.name,
            "translation": rounded(obj.matrix_world.translation),
            "scale": rounded(obj.matrix_world.to_scale()),
            "bones": [{
                "name": bone.name,
                "parent": bone.parent.name if bone.parent else None,
                "headLocal": rounded(bone.head_local),
                "tailLocal": rounded(bone.tail_local),
                "headWorld": rounded(obj.matrix_world @ bone.head_local),
                "tailWorld": rounded(obj.matrix_world @ bone.tail_local),
                "deform": bool(bone.use_deform),
            } for bone in obj.data.bones],
        } for obj in armatures],
        "actions": len(actions),
        "actionNames": sorted(action.name for action in actions),
        "bounds": {"min": rounded(low), "max": rounded(high), "dimensions": rounded(high - low), "center": rounded((low + high) / 2)},
        "allMeshBounds": {"min": rounded(all_low), "max": rounded(all_high), "dimensions": rounded(all_high - all_low)},
        "floorContact": floor_contacts(content_meshes, low, high),
        "boundsHeuristicAnchors": heuristic_anchors(low, high),
    }


def point_camera(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def render_views(source: Path, entry: dict, render_dir: Path) -> list[Path]:
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(source), import_pack_images=True)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    for obj in meshes:
        obj.hide_render = is_helper_mesh(obj)
    meshes = [obj for obj in meshes if not is_helper_mesh(obj)]
    low, high = world_bounds(meshes)
    center = (low + high) / 2
    span = max(*(high - low), 0.1)

    world = bpy.context.scene.world or bpy.data.worlds.new("AuditWorld")
    bpy.context.scene.world = world
    world.color = (0.035, 0.045, 0.065)
    bpy.ops.object.light_add(type="AREA", location=(center.x - span, center.y - span, high.z + span))
    bpy.context.object.data.energy = 700
    bpy.context.object.data.shape = "DISK"
    bpy.context.object.data.size = span * 2.5
    bpy.ops.object.light_add(type="AREA", location=(center.x + span, center.y + span, center.z))
    bpy.context.object.data.energy = 350
    bpy.context.object.data.size = span * 2

    bpy.ops.mesh.primitive_plane_add(size=span * 5, location=(center.x, center.y, low.z - span * 0.008))
    plane = bpy.context.object
    material = bpy.data.materials.new("AuditGround")
    material.diffuse_color = (0.13, 0.16, 0.20, 1)
    plane.data.materials.append(material)

    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = span * 1.35
    bpy.context.scene.camera = camera
    scene = bpy.context.scene
    # A neutral clay pass exposes geometry even when source textures are nearly
    # black, over-bright, or absent (notably 170 and 201).
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "SINGLE"
    scene.display.shading.single_color = (0.42, 0.63, 0.82)
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "WORLD"
    scene.render.resolution_x = 420
    scene.render.resolution_y = 420
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    render_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, direction in VIEWS.items():
        camera.location = center + direction.normalized() * span * 3.2
        point_camera(camera, center)
        path = render_dir / f"{entry['id']}-{name}.png"
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        paths.append(path)
    return paths


def make_contact_sheet(output: Path, render_ids: tuple[int, ...], render_dir: Path) -> None:
    python = shutil.which("python")
    if not python:
        return
    code = """
from PIL import Image, ImageDraw
import pathlib, sys
out=pathlib.Path(sys.argv[1]); ids=[int(x) for x in sys.argv[2].split(',')]; src=pathlib.Path(sys.argv[3])
views=('front','side','three-quarter'); cell=420; label=34
sheet=Image.new('RGB',(cell*len(views),(cell+label)*len(ids)),(20,25,35)); draw=ImageDraw.Draw(sheet)
for row,pid in enumerate(ids):
    for col,view in enumerate(views):
        image=Image.open(src/f'{pid}-{view}.png').convert('RGB'); sheet.paste(image,(col*cell,row*(cell+label)+label))
        draw.text((col*cell+10,row*(cell+label)+8),f'#{pid} {view}',fill=(240,244,255))
sheet.save(out)
"""
    subprocess.run([python, "-c", code, str(output), ",".join(map(str, render_ids)), str(render_dir)], check=True)


def main() -> None:
    args = arguments()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    sources = [args.source_dir / f"{pokemon_id}.glb" for pokemon_id in range(152, 252)]
    missing = [str(path) for path in sources if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Missing {len(missing)} source GLBs; first: {missing[:3]}")

    entries = []
    for index, source in enumerate(sources, start=1):
        entry = inspect_one(source)
        entries.append(entry)
        print(f"INSPECT {index:03d}/100 #{entry['id']} {entry['status']}", flush=True)

    target_entries = [entry for entry in entries if entry["status"] in {"static", "rigged-static"}]
    bone_frequency = Counter(name for entry in target_entries for name in entry["boneNames"])
    dimensions = [entry["bounds"]["dimensions"] for entry in target_entries]
    report = {
        "schema": 2,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "tool": {"name": "Blender", "version": bpy.app.version_string},
        "source": {"directory": args.source_dir.as_posix(), "range": [152, 251], "files": len(sources), "readOnly": True},
        "coordinateSystem": {
            "source": "glTF 2.0 right-handed, +Y up",
            "inspected": "Blender world coordinates after importer conversion, +Z up",
            "boundsUnits": "source-authored units after node transforms",
        },
        "blenderImporterNote": "Blender creates an unskinned Icosphere custom-shape helper for armatures. It is absent from the source GLB nodes/meshes and excluded only from Blender-side content bounds and previews; no runtime source-mesh exclusion is implied.",
        "statusCounts": dict(sorted(Counter(entry["status"] for entry in entries).items())),
        "staticAndRiggedStatic": {
            "files": len(target_entries),
            "dimensionRange": {
                "min": [min(values[axis] for values in dimensions) for axis in range(3)],
                "max": [max(values[axis] for values in dimensions) for axis in range(3)],
            },
            "commonBoneNames": [{"name": name, "files": count} for name, count in bone_frequency.most_common(80)],
            "anchorCaveat": "boundsHeuristicAnchors and floorContact are geometric candidates, not validated anatomical joints.",
        },
        "renderIds": list(args.render_ids),
        "entries": entries,
    }
    (args.output_dir / "inspection.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    roots = Counter(tuple(entry["rootBones"]) for entry in entries if entry["status"] == "rigged-static")
    candidates = {
        "schema": 1,
        "inspection": "inspection.json",
        "coordinateRule": "Use Blender-imported +Z-up bounds. Representative front renders confirm -Y-facing for the seven reviewed static models.",
        "normalizationRule": "Normalize each source independently; authored spans vary by more than four orders of magnitude. Use max bounds span, then ground by floorContact before placing bones.",
        "existingRigConventions": {
            "rootSets": [{"names": list(names), "files": count} for names, count in roots.most_common()],
            "commonBoneNames": report["staticAndRiggedStatic"]["commonBoneNames"],
            "note": "All 37 rigged-static files have distinct complete bone-name sets; use role candidates per entry instead of assuming one identical skeleton.",
        },
        "representatives": [{
            "id": pokemon_id,
            "status": by_id["status"],
            "bounds": by_id["bounds"],
            "normalizationScaleToMaxSpan": round(1 / max(by_id["bounds"]["dimensions"]), 9),
            "floorContact": by_id["floorContact"],
            "boundsHeuristicAnchors": by_id["boundsHeuristicAnchors"],
            "visualReview": note,
        } for pokemon_id, note in REPRESENTATIVE_NOTES.items() for by_id in [next(entry for entry in entries if entry["id"] == pokemon_id)]],
        "caveat": "Suggested bones and bounds anchors are rigging inputs, not completed deformation or animation validation.",
    }
    (args.output_dir / "rigging-candidates.json").write_text(
        json.dumps(candidates, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    if not args.no_render:
        render_dir = args.output_dir / "renders"
        by_id = {entry["id"]: entry for entry in entries}
        for pokemon_id in args.render_ids:
            render_views(args.source_dir / f"{pokemon_id}.glb", by_id[pokemon_id], render_dir)
        make_contact_sheet(args.output_dir / "contact-sheet.png", args.render_ids, render_dir)
    print("JOHTO_RIGGING_SOURCE_RESULT=" + json.dumps({
        "report": str(args.output_dir / "inspection.json"),
        "candidates": str(args.output_dir / "rigging-candidates.json"),
        "contactSheet": None if args.no_render else str(args.output_dir / "contact-sheet.png"),
        "statusCounts": report["statusCounts"],
    }), flush=True)


if __name__ == "__main__":
    main()
