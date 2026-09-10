"""Import and visually inspect four canonical Pokemon GLBs in the live bridge scene.

Executed by scripts/blender-call.py. The bridge injects bpy and reads the global
`result` value after execution.
"""
from pathlib import Path
import hashlib
import json
import math

import bpy
from mathutils import Vector

ROOT = Path(r"C:\dev\choketmon")
IDS = (1, 4, 7, 25)
NAMES = {1: "Bulbasaur", 4: "Charmander", 7: "Squirtle", 25: "Pikachu"}
POSITIONS = {1: -4.8, 4: -1.6, 7: 1.6, 25: 4.8}
BLEND_PATH = ROOT / "assets" / "blender" / "pokemon-study.blend"
PREVIEW_PATH = ROOT / "artifacts" / "pokemon-blender-preview.png"
BLEND_PATH.parent.mkdir(parents=True, exist_ok=True)
PREVIEW_PATH.parent.mkdir(parents=True, exist_ok=True)

# This bridge was launched with --factory-startup specifically for this study.
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for collection in list(bpy.data.collections):
    if collection.name != "Collection":
        bpy.data.collections.remove(collection)
bpy.ops.outliner.orphans_purge(do_recursive=True)

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1200
scene.render.resolution_y = 700
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(PREVIEW_PATH)
scene.render.film_transparent = False
scene.world.color = (0.055, 0.070, 0.090)
scene.frame_start = 0
scene.frame_end = 48
scene.frame_set(8)
try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    pass


def mat(name, color, roughness=0.7, metallic=0.0):
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return material


stage_mat = mat("StudyStage", (0.15, 0.20, 0.25, 1))
ring_mat = mat("StudyRing", (0.32, 0.45, 0.55, 1), 0.45, 0.08)
label_mat = mat("StudyLabel", (0.90, 0.92, 0.80, 1))


def bounds(objects):
    points = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        return None
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return {
        "min": [round(v, 6) for v in low],
        "max": [round(v, 6) for v in high],
        "size": [round(v, 6) for v in high - low],
    }


def triangles(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for obj in objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        total += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    return total


inspection = []
all_imported = []
for pokemon_id in IDS:
    source = ROOT / "public" / "models" / "pokemon" / f"{pokemon_id}.glb"
    before_objects = set(bpy.data.objects)
    before_actions = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(source), import_pack_images=True)
    imported = [obj for obj in bpy.data.objects if obj not in before_objects]
    imported_set = set(imported)
    roots = [obj for obj in imported if obj.parent not in imported_set]
    source_bounds = bounds(imported)
    if not source_bounds or source_bounds["size"][2] <= 0:
        raise RuntimeError(f"Pokemon {pokemon_id} has no measurable mesh bounds")

    container = bpy.data.objects.new(f"ImportedPokemon_{pokemon_id:03d}_{NAMES[pokemon_id]}", None)
    scene.collection.objects.link(container)
    for root_obj in roots:
        old_world = root_obj.matrix_world.copy()
        root_obj.parent = container
        root_obj.matrix_world = old_world
    target_height = 2.35 if pokemon_id == 25 else 2.15
    scale = target_height / source_bounds["size"][2]
    container.scale = (scale, scale, scale)
    bpy.context.view_layer.update()
    scaled = bounds(imported)
    container.location = (POSITIONS[pokemon_id], 0.0, -scaled["min"][2])
    bpy.context.view_layer.update()
    placed = bounds(imported)

    armatures = [obj for obj in imported if obj.type == "ARMATURE"]
    meshes = [obj for obj in imported if obj.type == "MESH"]
    material_names = sorted({slot.material.name for obj in meshes for slot in obj.material_slots if slot.material})
    imported_actions = [action for action in bpy.data.actions if action not in before_actions]
    nla_tracks = sum(len(obj.animation_data.nla_tracks) for obj in imported if obj.animation_data)
    inspection.append({
        "id": pokemon_id,
        "name": NAMES[pokemon_id],
        "source": str(source.relative_to(ROOT)).replace("\\", "/"),
        "sourceBytes": source.stat().st_size,
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "objects": len(imported),
        "meshes": len(meshes),
        "armatures": len(armatures),
        "bones": sum(len(obj.data.bones) for obj in armatures),
        "triangles": triangles(imported),
        "materials": material_names,
        "materialCount": len(material_names),
        "actionsImported": sorted(action.name for action in imported_actions),
        "actionCount": len(imported_actions),
        "nlaTracks": nla_tracks,
        "sourceBounds": source_bounds,
        "placedBounds": placed,
        "uniformScale": round(scale, 8),
        "container": container.name,
    })
    all_imported.extend(imported)

# Presentation stage, floor markers, and labels stay outside ImportedPokemon roots.
bpy.ops.mesh.primitive_cube_add(location=(0, 0.35, -0.23), scale=(6.8, 2.7, 0.22))
stage = bpy.context.object
stage.name = "PokemonStudyStage"
stage.data.materials.append(stage_mat)
bevel = stage.modifiers.new("Rounded stage", "BEVEL")
bevel.width = 0.22
bevel.segments = 3

for pokemon_id in IDS:
    x = POSITIONS[pokemon_id]
    bpy.ops.mesh.primitive_torus_add(major_radius=0.95, minor_radius=0.035, major_segments=40, minor_segments=8, location=(x, 0, 0.025))
    ring = bpy.context.object
    ring.name = f"Marker_{pokemon_id:03d}"
    ring.data.materials.append(ring_mat)
    bpy.ops.object.text_add(location=(x, -1.55, 0.04), rotation=(0, 0, 0))
    label = bpy.context.object
    label.name = f"Label_{pokemon_id:03d}"
    label.data.body = f"{pokemon_id:03d}  {NAMES[pokemon_id]}"
    label.data.align_x = "CENTER"
    label.data.size = 0.34
    label.data.extrude = 0.012
    label.data.materials.append(label_mat)

bpy.ops.object.light_add(type="SUN", location=(4, -6, 10))
sun = bpy.context.object
sun.name = "StudySun"
sun.data.energy = 2.2
sun.rotation_euler = (math.radians(28), math.radians(-20), math.radians(-30))
bpy.ops.object.light_add(type="AREA", location=(-4, -4, 8))
area = bpy.context.object
area.name = "StudySoftbox"
area.data.energy = 1100
area.data.shape = "DISK"
area.data.size = 7
bpy.ops.object.camera_add(location=(9.7, -15.5, 7.2))
camera = bpy.context.object
camera.name = "PokemonStudyCamera"
camera.data.lens = 54
camera.rotation_euler = ((Vector((0, 0.15, 1.05)) - camera.location).to_track_quat("-Z", "Y").to_euler())
area.rotation_euler = ((Vector((0, 0, 0.8)) - area.location).to_track_quat("-Z", "Y").to_euler())
scene.camera = camera

bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
bpy.ops.render.render(write_still=True)

result = {
    "schema": 1,
    "connected": True,
    "blender": bpy.app.version_string,
    "sourceRights": "Local fan-game evaluation only; external distribution rights not established (see public/models/pokemon/manifest.json)",
    "blend": str(BLEND_PATH.relative_to(ROOT)).replace("\\", "/"),
    "blendBytes": BLEND_PATH.stat().st_size,
    "blendSha256": hashlib.sha256(BLEND_PATH.read_bytes()).hexdigest(),
    "preview": str(PREVIEW_PATH.relative_to(ROOT)).replace("\\", "/"),
    "previewBytes": PREVIEW_PATH.stat().st_size,
    "previewSha256": hashlib.sha256(PREVIEW_PATH.read_bytes()).hexdigest(),
    "pokemon": inspection,
    "scene": {
        "file": bpy.data.filepath,
        "camera": scene.camera.name,
        "objects": len(scene.objects),
        "importedContainers": [f"ImportedPokemon_{pokemon_id:03d}_{NAMES[pokemon_id]}" for pokemon_id in IDS],
        "frame": scene.frame_current,
    },
}
print("POKEMON_BLENDER_INSPECTION=" + json.dumps(result, ensure_ascii=False, sort_keys=True))
