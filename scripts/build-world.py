"""Build the Choketmon overworld and trainer with Blender 5.x.

Run:
  blender --background --factory-startup --python scripts/build-world.py

The script is deterministic, edits only a fresh scene, and overwrites its own
documented outputs so it can be used as the source of truth for the assets.
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
BLEND_PATH = ROOT / "assets" / "blender" / "choketmon-world.blend"
WORLD_GLB = ROOT / "public" / "models" / "world.glb"
TRAINER_GLB = ROOT / "public" / "models" / "trainer.glb"
PREVIEW_PATH = ROOT / "artifacts" / "world-preview.png"

for path in (BLEND_PATH, WORLD_GLB, TRAINER_GLB, PREVIEW_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
    pass

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1024
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.render.filepath = str(PREVIEW_PATH)
scene.render.resolution_percentage = 100
scene.world.color = (0.055, 0.085, 0.07)
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.frame_start = 1
scene.frame_end = 20
scene.render.fps = 20

world_collection = bpy.data.collections.new("WORLD_EXPORT")
trainer_collection = bpy.data.collections.new("TRAINER_EXPORT")
support_collection = bpy.data.collections.new("SCENE_SUPPORT")
scene.collection.children.link(world_collection)
scene.collection.children.link(trainer_collection)
scene.collection.children.link(support_collection)


def material(name: str, color: tuple[float, float, float, float], roughness: float = 0.72, metallic: float = 0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


M = {
    "earth": material("Earth", (0.31, 0.20, 0.12, 1)),
    "grass": material("Meadow", (0.43, 0.69, 0.32, 1)),
    "grass_dark": material("TallGrass", (0.20, 0.49, 0.20, 1)),
    "path": material("WarmPath", (0.82, 0.68, 0.43, 1)),
    "water": material("PondWater", (0.18, 0.62, 0.68, 1), 0.25, 0.05),
    "stone": material("PondStone", (0.45, 0.55, 0.48, 1)),
    "trunk": material("TreeTrunk", (0.29, 0.17, 0.09, 1)),
    "leaf": material("TreeLeaf", (0.18, 0.46, 0.22, 1)),
    "leaf_light": material("TreeLeafLight", (0.34, 0.61, 0.27, 1)),
    "cream": material("CenterWall", (0.92, 0.83, 0.65, 1)),
    "red": material("CenterRoof", (0.73, 0.16, 0.13, 1)),
    "teal": material("GymTeal", (0.08, 0.48, 0.50, 1)),
    "teal_dark": material("GymTealDark", (0.04, 0.25, 0.30, 1)),
    "glass": material("Window", (0.30, 0.65, 0.76, 1), 0.18),
    "white": material("WarmWhite", (0.94, 0.93, 0.82, 1)),
    "wood": material("FurnitureWood", (0.43, 0.25, 0.12, 1)),
    "skin": material("TrainerSkin", (0.92, 0.58, 0.38, 1)),
    "navy": material("TrainerNavy", (0.07, 0.16, 0.27, 1)),
    "cap": material("TrainerCap", (0.80, 0.13, 0.10, 1)),
    "yellow": material("AccentYellow", (0.96, 0.70, 0.16, 1)),
}


def move_to_collection(obj, collection):
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)
    return obj


def cube(name, loc, dims, mat, bevel=0.0, collection=world_collection):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Soft bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
    return move_to_collection(obj, collection)


def cylinder(name, loc, radius, depth, mat, vertices=8, collection=world_collection):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    return move_to_collection(obj, collection)


def sphere(name, loc, scale, mat, subdivisions=1, collection=world_collection):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return move_to_collection(obj, collection)


def join(objects, name):
    if not objects:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    objects[0].name = name
    return objects[0]


def world_xy(tile_x: float, tile_y: float):
    return tile_x - 11.5, -(tile_y - 7.0)


# Pastel floating meadow foundation and exact walkable tile plane.
cube("IslandEarth", (0, 0, -0.52), (25.2, 16.2, 1.0), M["earth"], 0.75)
cube("MeadowSurface", (0, 0, 0.015), (24.0, 15.0, 0.10), M["grass"], 0.30)

# Cross road: y=7, x=12, plus the y>=10 x=9..14 branch from map.ts.
cube("PathHorizontal", (0, 0, 0.09), (24.0, 0.86, 0.08), M["path"], 0.12)
cube("PathVertical", (0.5, 0, 0.091), (0.86, 15.0, 0.08), M["path"], 0.12)
cube("PathSouthBranch", (0, -4.0, 0.092), (6.0, 2.86, 0.08), M["path"], 0.12)

# Pond exactly covers map tiles x=17..21, y=9..12.
pond_x, pond_y = world_xy(19, 10.5)
cube("Pond", (pond_x, pond_y, 0.105), (4.90, 3.90, 0.10), M["water"], 0.42)
rocks = []
for i in range(18):
    angle = 2 * math.pi * i / 18
    x = pond_x + math.cos(angle) * 2.62
    y = pond_y + math.sin(angle) * 2.12
    rocks.append(sphere(f"PondRock_{i:02d}", (x, y, 0.18), (0.25 + (i % 3) * 0.04, 0.20, 0.17), M["stone"], 1))
join(rocks, "PondRocks")


def gable_roof(name, center, width, depth, height, mat):
    x, y, z = center
    verts = [
        (x-width/2, y-depth/2, z), (x+width/2, y-depth/2, z),
        (x+width/2, y+depth/2, z), (x-width/2, y+depth/2, z),
        (x, y-depth/2, z+height), (x, y+depth/2, z+height),
    ]
    faces = [(0,1,4), (3,5,2), (0,4,5,3), (1,2,5,4), (0,3,2,1)]
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(verts, [], faces); mesh.update()
    obj = bpy.data.objects.new(name, mesh); world_collection.objects.link(obj); obj.data.materials.append(mat)
    bevel = obj.modifiers.new("Rounded roof edges", "BEVEL"); bevel.width = 0.08; bevel.segments = 2
    return obj


# Pokemon center occupies tiles x=3..6, y=3..5.
cx, cy = world_xy(4.5, 4)
cube("CenterBody", (cx, cy, 1.05), (3.75, 2.75, 2.0), M["cream"], 0.16)
gable_roof("CenterRedRoof", (cx, cy, 2.02), 4.35, 3.25, 1.0, M["red"])
cube("CenterDoor", (cx, cy-1.401, 0.75), (0.75, 0.08, 1.30), M["teal_dark"], 0.06)
for dx in (-1.15, 1.15):
    cube(f"CenterWindow_{dx}", (cx+dx, cy-1.405, 1.15), (0.70, 0.07, 0.65), M["glass"], 0.05)
cube("CenterCrossV", (cx, cy-1.70, 2.54), (0.25, 0.08, 0.78), M["white"], 0.05)
cube("CenterCrossH", (cx, cy-1.70, 2.54), (0.78, 0.08, 0.25), M["white"], 0.05)

# Gym occupies tiles x=16..20, y=2..4.
gx, gy = world_xy(18, 3)
cube("GymBody", (gx, gy, 1.12), (4.75, 2.75, 2.15), M["teal"], 0.18)
gable_roof("GymRoof", (gx, gy, 2.15), 5.30, 3.25, 0.82, M["teal_dark"])
cube("GymDoor", (gx, gy-1.405, 0.80), (0.95, 0.08, 1.45), M["navy"], 0.06)
for dx in (-1.55, 1.55):
    cylinder(f"GymColumn_{dx}", (gx+dx, gy-1.55, 0.85), 0.19, 1.70, M["white"], 10)
cube("GymSign", (gx, gy-1.72, 2.42), (1.65, 0.10, 0.48), M["yellow"], 0.08)

# Boundary collision trees, batched into three material meshes.
trunks, crowns_dark, crowns_light = [], [], []
tree_tiles = [(x, y) for y in range(15) for x in range(24) if x < 1 or y < 1 or x >= 23 or y >= 14]
for i, (tx, ty) in enumerate(tree_tiles):
    x, y = world_xy(tx, ty)
    jitter_x = ((i * 17) % 7 - 3) * 0.035
    jitter_y = ((i * 29) % 7 - 3) * 0.035
    trunks.append(cylinder(f"TreeTrunk_{i:03d}", (x+jitter_x, y+jitter_y, 0.55), 0.17, 1.05, M["trunk"], 7))
    crowns_dark.append(sphere(f"TreeCrown_{i:03d}", (x+jitter_x, y+jitter_y, 1.48), (0.65, 0.60, 0.82), M["leaf"], 1))
    crowns_light.append(sphere(f"TreeHighlight_{i:03d}", (x-0.18+jitter_x, y-0.12+jitter_y, 1.82), (0.33, 0.30, 0.36), M["leaf_light"], 1))
join(trunks, "BoundaryTreeTrunks")
join(crowns_dark, "BoundaryTreeCrowns")
join(crowns_light, "BoundaryTreeHighlights")

# Tall-grass tiles are geometry and match tileAt exactly.
grass_tiles = []
for y in range(1, 14):
    for x in range(1, 23):
        is_grass = ((x <= 8 and 9 <= y <= 12) or (15 <= x <= 20 and 5 <= y <= 6) or (8 <= x <= 10 and 2 <= y <= 5))
        if is_grass:
            grass_tiles.append((x, y))
verts, faces = [], []
for tile_i, (tx, ty) in enumerate(grass_tiles):
    base_x, base_y = world_xy(tx, ty)
    for blade in range(5):
        bx = base_x + ((blade * 37 + tile_i * 11) % 70 - 35) / 100
        by = base_y + ((blade * 23 + tile_i * 17) % 70 - 35) / 100
        height = 0.32 + (blade % 3) * 0.07
        width = 0.075
        for angle in (0, math.pi/2):
            dx, dy = math.cos(angle)*width, math.sin(angle)*width
            start = len(verts)
            verts.extend([(bx-dx, by-dy, 0.10), (bx+dx, by+dy, 0.10), (bx+dx*0.25, by+dy*0.25, 0.10+height), (bx-dx*0.25, by-dy*0.25, 0.10+height)])
            faces.append((start, start+1, start+2, start+3))
grass_mesh = bpy.data.meshes.new("TallGrassMesh")
grass_mesh.from_pydata(verts, [], faces); grass_mesh.update()
grass_obj = bpy.data.objects.new("TallGrassPatches", grass_mesh); world_collection.objects.link(grass_obj); grass_obj.data.materials.append(M["grass_dark"])

# Small authored props near paths.
for i, (tx, ty) in enumerate(((9, 7), (15, 7), (12, 4), (12, 12))):
    x, y = world_xy(tx, ty)
    cylinder(f"SignPost_{i}", (x, y, 0.38), 0.07, 0.70, M["wood"], 6)
    cube(f"SignBoard_{i}", (x, y, 0.72), (0.65, 0.12, 0.34), M["wood"], 0.05)
for i, (tx, ty) in enumerate(((9.5, 8.2), (14.5, 8.2))):
    x, y = world_xy(tx, ty)
    cube(f"BenchSeat_{i}", (x, y, 0.37), (1.15, 0.38, 0.15), M["wood"], 0.06)
    for dx in (-0.42, 0.42): cylinder(f"BenchLeg_{i}_{dx}", (x+dx, y, 0.18), 0.055, 0.30, M["wood"], 6)


# Primitive trainer with transform animation, exported separately.
root = bpy.data.objects.new("TrainerRoot", None)
trainer_collection.objects.link(root)
root.location = (*world_xy(12, 10), 0.13)

def trainer_part(name, loc, dims, mat, bevel=0.05):
    obj = cube(name, loc, dims, mat, bevel, trainer_collection)
    obj.parent = root
    return obj

body = trainer_part("TrainerBody", (0, 0, 1.14), (0.55, 0.34, 0.78), M["navy"])
head = sphere("TrainerHead", (0, 0, 1.78), (0.32, 0.29, 0.34), M["skin"], 2, trainer_collection); head.parent = root
cap = trainer_part("TrainerCap", (0, -0.015, 2.06), (0.68, 0.62, 0.18), M["cap"], 0.09)
brim = trainer_part("TrainerCapBrim", (0, -0.34, 2.01), (0.48, 0.28, 0.07), M["cap"], 0.04)
pack = trainer_part("TrainerPack", (0, 0.25, 1.15), (0.46, 0.22, 0.62), M["yellow"], 0.08)
left_arm = trainer_part("TrainerArmL", (-0.39, 0, 1.17), (0.17, 0.18, 0.70), M["skin"], 0.06)
right_arm = trainer_part("TrainerArmR", (0.39, 0, 1.17), (0.17, 0.18, 0.70), M["skin"], 0.06)
left_leg = trainer_part("TrainerLegL", (-0.17, 0, 0.52), (0.22, 0.26, 0.75), M["navy"], 0.06)
right_leg = trainer_part("TrainerLegR", (0.17, 0, 0.52), (0.22, 0.26, 0.75), M["navy"], 0.06)
for frame, swing, bob in ((1, -0.38, 0.00), (6, 0.38, 0.08), (11, -0.38, 0.00), (16, 0.38, 0.08), (20, -0.38, 0.00)):
    left_arm.rotation_euler.x = swing; right_arm.rotation_euler.x = -swing
    left_leg.rotation_euler.x = -swing; right_leg.rotation_euler.x = swing
    root.location.z = 0.13 + bob
    for obj in (left_arm, right_arm, left_leg, right_leg): obj.keyframe_insert("rotation_euler", frame=frame)
    root.keyframe_insert("location", frame=frame)

# Lighting and presentation camera remain in the .blend, outside exported world geometry.
def support_object(obj):
    return move_to_collection(obj, support_collection)

bpy.ops.object.light_add(type="SUN", location=(4, -6, 14))
sun = support_object(bpy.context.object); sun.name = "Sun"; sun.data.energy = 2.1; sun.rotation_euler = (math.radians(28), math.radians(-22), math.radians(-28))
bpy.ops.object.light_add(type="AREA", location=(-6, -4, 12))
area = support_object(bpy.context.object); area.name = "Softbox"; area.data.energy = 900; area.data.shape = "DISK"; area.data.size = 9
bpy.ops.object.camera_add(location=(17.8, -21.5, 20.2))
camera = support_object(bpy.context.object); camera.name = "WorldPreviewCamera"; scene.camera = camera; camera.data.lens = 53

def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()

look_at(camera, (0, 0, 0.4)); look_at(area, (0, 0, 0))

# Export selection avoids cameras, lights, and the trainer in world.glb.
def export_collection(collection, path, animations=False):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in collection.all_objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True,
        export_yup=True, export_apply=True, export_animations=animations,
        export_cameras=False, export_lights=False,
    )

export_collection(world_collection, WORLD_GLB, False)
export_collection(trainer_collection, TRAINER_GLB, True)

scene.frame_set(6)
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
bpy.ops.render.render(write_still=True)

def triangle_count(collection):
    depsgraph = bpy.context.evaluated_depsgraph_get(); count = 0
    for obj in collection.all_objects:
        if obj.type != "MESH": continue
        evaluated = obj.evaluated_get(depsgraph); mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles(); count += len(mesh.loop_triangles); evaluated.to_mesh_clear()
    return count

summary = {
    "schema": 1,
    "generator": str(Path(__file__).relative_to(ROOT)).replace("\\", "/"),
    "blender": bpy.app.version_string,
    "coordinates": "Blender X=x-11.5, Y=-(tileY-7), Z=height; glTF exports Y-up",
    "world": {"path": str(WORLD_GLB.relative_to(ROOT)).replace("\\", "/"), "objects": len(world_collection.all_objects), "triangles": triangle_count(world_collection), "bytes": WORLD_GLB.stat().st_size},
    "trainer": {"path": str(TRAINER_GLB.relative_to(ROOT)).replace("\\", "/"), "objects": len(trainer_collection.all_objects), "triangles": triangle_count(trainer_collection), "bytes": TRAINER_GLB.stat().st_size, "animationFrames": [1, 20]},
    "blend": {"path": str(BLEND_PATH.relative_to(ROOT)).replace("\\", "/"), "bytes": BLEND_PATH.stat().st_size},
    "preview": {"path": str(PREVIEW_PATH.relative_to(ROOT)).replace("\\", "/"), "bytes": PREVIEW_PATH.stat().st_size, "resolution": [1024, 640]},
    "tileProof": {"cols": 24, "rows": 15, "pond": {"x": [17, 21], "y": [9, 12]}, "center": {"x": [3, 6], "y": [3, 5]}, "gym": {"x": [16, 20], "y": [2, 4]}, "grassTiles": len(grass_tiles), "boundaryTrees": len(tree_tiles)},
}
print("CHOKETMON_WORLD_BUILD=" + json.dumps(summary, ensure_ascii=False, sort_keys=True))
