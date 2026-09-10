#!/usr/bin/env python3
"""Normalize selected CC0 Nature Kit props and render a Blender inspection board.

Run with Blender, for example:
  blender --background --factory-startup --python scripts/normalize-world-assets.py
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import sys
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "source-world" / "kenney-nature-kit-2.1" / "extracted"
SOURCE_MODELS = SOURCE / "Models" / "GLTF format"
OUTPUT = ROOT / "public" / "models" / "openworld" / "props"
ARTIFACTS = ROOT / "artifacts"
BLEND = ROOT / "assets" / "blender" / "openworld-props-study.blend"
ASSET_VERSION = "20260911-woodland"

# name, source file, desired world height, collider shape
ASSETS = [
    ("tree-round", "tree_detailed.glb", 5.4, "capsule"),
    ("tree-oak", "tree_oak.glb", 5.5, "capsule"),
    ("tree-pine", "tree_pineTallA_detailed.glb", 6.2, "capsule"),
    ("tree-fat", "tree_fat.glb", 4.3, "capsule"),
    ("tree-thin", "tree_thin.glb", 6.0, "capsule"),
    ("rock-large", "rock_largeA.glb", 1.15, "box"),
    ("rock-moss", "rock_largeE.glb", 0.95, "box"),
    ("rock-small", "rock_smallC.glb", 0.52, "box"),
    ("rock-flat", "rock_smallFlatA.glb", 0.28, "none"),
    ("grass-tuft", "grass_leafsLarge.glb", 0.72, "none"),
    ("grass-soft", "grass_large.glb", 0.58, "none"),
    ("flower-red", "flower_redA.glb", 0.55, "none"),
    ("flower-yellow", "flower_yellowB.glb", 0.55, "none"),
    ("flower-purple", "flower_purpleB.glb", 0.52, "none"),
    ("bush", "plant_bushDetailed.glb", 1.05, "sphere"),
    ("mushroom-cluster", "mushroom_redGroup.glb", 0.48, "none"),
    ("lily", "lily_large.glb", 0.12, "none"),
    ("stump", "stump_roundDetailed.glb", 0.72, "cylinder"),
    ("fallen-log", "log_large.glb", 0.72, "box"),
    ("fence", "fence_simple.glb", 1.15, "box"),
]

PLACEMENT = {
    "tree-round": {"biomes": ["meadow", "forest-edge"], "scaleRange": [0.85, 1.2], "minSpacing": 4.0, "collider": {"shape": "capsule", "radius": 0.28, "height": 2.8, "centerY": 1.4}},
    "tree-oak": {"biomes": ["forest", "meadow"], "scaleRange": [0.8, 1.15], "minSpacing": 5.0, "collider": {"shape": "capsule", "radius": 0.36, "height": 3.0, "centerY": 1.5}},
    "tree-pine": {"biomes": ["forest", "highland"], "scaleRange": [0.85, 1.2], "minSpacing": 4.0, "collider": {"shape": "capsule", "radius": 0.3, "height": 3.4, "centerY": 1.7}},
    "tree-fat": {"biomes": ["forest", "meadow"], "scaleRange": [0.8, 1.15], "minSpacing": 4.5, "collider": {"shape": "capsule", "radius": 0.34, "height": 2.6, "centerY": 1.3}},
    "tree-thin": {"biomes": ["forest", "forest-edge"], "scaleRange": [0.85, 1.18], "minSpacing": 4.0, "collider": {"shape": "capsule", "radius": 0.25, "height": 3.5, "centerY": 1.75}},
    "rock-large": {"biomes": ["meadow", "highland", "shore"], "scaleRange": [0.7, 1.25], "minSpacing": 3.0, "collider": {"shape": "box", "halfExtents": [1.56, 0.52, 2.02], "centerY": 0.52}},
    "rock-moss": {"biomes": ["forest", "shore", "highland"], "scaleRange": [0.72, 1.2], "minSpacing": 3.0, "collider": {"shape": "box", "halfExtents": [1.4, 0.44, 1.7], "centerY": 0.44}},
    "rock-small": {"biomes": ["meadow", "highland", "shore"], "scaleRange": [0.65, 1.35], "minSpacing": 1.5, "collider": {"shape": "box", "halfExtents": [0.61, 0.22, 0.61], "centerY": 0.22}},
    "rock-flat": {"biomes": ["meadow", "highland", "shore"], "scaleRange": [0.7, 1.3], "minSpacing": 0.8, "collider": None},
    "grass-tuft": {"biomes": ["meadow", "forest-edge"], "scaleRange": [0.65, 1.2], "minSpacing": 0.7, "collider": None},
    "grass-soft": {"biomes": ["meadow", "forest-edge"], "scaleRange": [0.65, 1.25], "minSpacing": 0.65, "collider": None},
    "flower-red": {"biomes": ["meadow"], "scaleRange": [0.75, 1.25], "minSpacing": 0.45, "collider": None},
    "flower-yellow": {"biomes": ["meadow", "forest-edge"], "scaleRange": [0.7, 1.2], "minSpacing": 0.55, "collider": None},
    "flower-purple": {"biomes": ["meadow", "forest-edge"], "scaleRange": [0.72, 1.18], "minSpacing": 0.55, "collider": None},
    "bush": {"biomes": ["forest", "forest-edge"], "scaleRange": [0.75, 1.25], "minSpacing": 1.5, "collider": {"shape": "sphere", "radius": 0.62, "centerY": 0.48}},
    "mushroom-cluster": {"biomes": ["forest"], "scaleRange": [0.75, 1.2], "minSpacing": 0.8, "collider": None},
    "lily": {"biomes": ["lake"], "scaleRange": [0.7, 1.2], "minSpacing": 1.2, "collider": None},
    "stump": {"biomes": ["forest", "forest-edge"], "scaleRange": [0.85, 1.2], "minSpacing": 2.0, "collider": {"shape": "cylinder", "radius": 0.5, "height": 0.65, "centerY": 0.325}},
    "fence": {"biomes": ["settlement", "meadow"], "scaleRange": [1.0, 1.0], "minSpacing": 3.33, "collider": {"shape": "box", "halfExtents": [1.67, 0.58, 0.12], "centerY": 0.58}},
    "fallen-log": {"biomes": ["forest", "forest-edge"], "scaleRange": [0.85, 1.25], "minSpacing": 2.2, "collider": {"shape": "box", "halfExtents": [0.78, 0.32, 0.43], "centerY": 0.32}},
}


def tune_material(material: bpy.types.Material) -> None:
    """Convert stylized source colors to a richer, non-metallic woodland palette."""
    name = material.name.lower()
    color = None
    if "leafsdark" in name:
        color = (0.025, 0.16, 0.045, 1)
    elif "leaf" in name:
        color = (0.055, 0.30, 0.075, 1)
    elif "grass" in name:
        color = (0.08, 0.34, 0.09, 1)
    elif "woodinner" in name:
        color = (0.43, 0.24, 0.10, 1)
    elif "wood" in name:
        color = (0.22, 0.105, 0.045, 1)
    elif "dirt" in name:
        color = (0.25, 0.23, 0.18, 1)
    elif "stone" in name or "rock" in name:
        color = (0.31, 0.34, 0.31, 1)
    material.metallic = 0
    material.roughness = 0.9
    if color:
        material.diffuse_color = color
    if material.use_nodes and material.node_tree:
        node = next((item for item in material.node_tree.nodes if item.type == "BSDF_PRINCIPLED"), None)
        if node:
            if "Metallic" in node.inputs:
                node.inputs["Metallic"].default_value = 0
            if "Roughness" in node.inputs:
                node.inputs["Roughness"].default_value = 0.9
            if color and "Base Color" in node.inputs:
                node.inputs["Base Color"].default_value = color


def clean_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.armatures, bpy.data.cameras, bpy.data.lights):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def mesh_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    return (
        Vector(tuple(min(point[i] for point in points) for i in range(3))),
        Vector(tuple(max(point[i] for point in points) for i in range(3))),
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def import_normalized(asset_name: str, source_name: str, target_height: float) -> tuple[list[bpy.types.Object], dict]:
    source_path = SOURCE_MODELS / source_name
    if not source_path.exists():
        raise RuntimeError(f"Missing source model: {source_path}")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(source_path))
    imported = [obj for obj in bpy.context.scene.objects if obj not in before]
    meshes = [obj for obj in imported if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh imported from {source_name}")

    # Kenney GLBs may include importer-created root empties. Flatten meshes into
    # the scene so export contains only durable render geometry.
    for obj in meshes:
        world_matrix = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world_matrix
    imported = meshes

    minimum, maximum = mesh_bounds(meshes)
    source_height = maximum.z - minimum.z
    if source_height <= 0:
        raise RuntimeError(f"Flat source asset: {source_name}")
    scale = target_height / source_height
    center = (minimum + maximum) * 0.5
    for obj in imported:
        if obj.parent not in imported:
            obj.location = (obj.location - Vector((center.x, center.y, minimum.z))) * scale
            obj.scale *= scale

    # Bake transforms so every delivered file has a true bottom-center origin and unit root transform.
    for obj in imported:
        obj.select_set(obj.type == "MESH")
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    minimum, maximum = mesh_bounds(meshes)
    dimensions = maximum - minimum
    triangles = sum(len(poly.vertices) - 2 for obj in meshes for poly in obj.data.polygons)
    material_names = sorted({slot.material.name for obj in meshes for slot in obj.material_slots if slot.material})
    for material_name in material_names:
        material = bpy.data.materials.get(material_name)
        if material:
            tune_material(material)
    for index, obj in enumerate(imported):
        obj.name = asset_name if index == 0 else f"{asset_name}-{index:02d}"
        obj.select_set(True)
    return imported, {
        "sourceFile": source_name,
        "sourceSha256": sha256(source_path),
        "dimensions": {"x": round(dimensions.x, 4), "y": round(dimensions.z, 4), "z": round(dimensions.y, 4)},
        "bounds": {
            "min": [round(minimum.x, 4), round(minimum.z, 4), round(-maximum.y, 4)],
            "max": [round(maximum.x, 4), round(maximum.z, 4), round(-minimum.y, 4)],
        },
        "triangles": triangles,
        "meshCount": len(meshes),
        "materials": material_names,
    }


def export_asset(asset_name: str, imported: list[bpy.types.Object]) -> Path:
    output_path = OUTPUT / f"{asset_name}.glb"
    bpy.ops.object.select_all(action="DESELECT")
    for obj in imported:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(obj for obj in imported if obj.type == "MESH")
    bpy.ops.export_scene.gltf(
        filepath=str(output_path), export_format="GLB", use_selection=True,
        export_yup=True, export_apply=True, export_materials="EXPORT",
        export_cameras=False, export_lights=False,
    )
    return output_path


def validate_export(output_path: Path) -> dict:
    """Re-import the delivered GLB and measure the bytes consumers receive."""
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(output_path))
    imported = [obj for obj in bpy.context.scene.objects if obj not in before]
    meshes = [obj for obj in imported if obj.type == "MESH"]
    minimum, maximum = mesh_bounds(meshes)
    dimensions = maximum - minimum
    validation = {
        "meshCount": len(meshes),
        "triangles": sum(len(poly.vertices) - 2 for obj in meshes for poly in obj.data.polygons),
        "materialCount": len({slot.material.name for obj in meshes for slot in obj.material_slots if slot.material}),
        "bottomY": round(minimum.z, 5),
        "dimensions": {
            "x": round(dimensions.x, 4),
            "y": round(dimensions.z, 4),
            "z": round(dimensions.y, 4),
        },
    }
    for obj in imported:
        bpy.data.objects.remove(obj, do_unlink=True)
    if abs(validation["bottomY"]) > 0.001:
        raise RuntimeError(f"{output_path.name} bottom pivot validation failed: {validation['bottomY']}")
    return validation


def add_ground() -> None:
    bpy.ops.mesh.primitive_plane_add(size=34, location=(0, 0, -0.025))
    ground = bpy.context.object
    ground.name = "InspectionGround"
    material = bpy.data.materials.new("Inspection meadow")
    material.diffuse_color = (0.14, 0.31, 0.12, 1)
    material.roughness = 1
    ground.data.materials.append(material)


def add_camera_and_lights() -> None:
    bpy.ops.object.camera_add(location=(20.5, -31.5, 20.5))
    camera = bpy.context.object
    camera.name = "InspectionCamera"
    bpy.context.scene.camera = camera
    target = Vector((0, 0, 2.0))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 48
    bpy.ops.object.light_add(type="AREA", location=(-6, -8, 14))
    bpy.context.object.data.energy = 1700
    bpy.context.object.data.shape = "DISK"
    bpy.context.object.data.size = 8
    bpy.ops.object.light_add(type="AREA", location=(10, 6, 8))
    bpy.context.object.data.energy = 900
    bpy.context.object.data.color = (0.62, 0.78, 1.0)
    bpy.context.object.data.size = 6
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
    bpy.context.object.rotation_euler = (math.radians(28), math.radians(-22), math.radians(28))
    bpy.context.object.data.energy = 2.1


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    BLEND.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE / "License.txt", OUTPUT.parent / "LICENSE-KENNEY.txt")
    clean_scene()
    report_assets = []
    imported_groups = []
    for index, (asset_name, source_name, height, collider) in enumerate(ASSETS):
        imported, report = import_normalized(asset_name, source_name, height)
        output_path = export_asset(asset_name, imported)
        delivered_validation = validate_export(output_path)
        report.update({
            "id": asset_name,
            "url": f"/models/openworld/props/{asset_name}.glb?v={ASSET_VERSION}",
            "file": str(output_path.relative_to(ROOT)).replace("\\", "/"),
            "bytes": output_path.stat().st_size,
            "sha256": sha256(output_path),
            "collider": collider,
            "recommendedPlacement": PLACEMENT[asset_name],
            "deliveredValidation": delivered_validation,
        })
        if report["triangles"] >= 10_000:
            raise RuntimeError(f"{asset_name} exceeds 10k triangles")
        report_assets.append(report)
        imported_groups.append(imported)

        column = index % 5
        row = index // 5
        x = (column - 2) * 4.6
        y = (row - 1.5) * 5.2
        for obj in imported:
            if obj.parent not in imported:
                obj.location.x += x
                obj.location.y += y

    add_ground()
    add_camera_and_lights()
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(ARTIFACTS / "openworld-props-preview.png")
    scene.render.film_transparent = False
    scene.world.color = (0.035, 0.055, 0.09)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
    bpy.ops.render.render(write_still=True)

    total_bytes = sum(item["bytes"] for item in report_assets)
    manifest = {
        "schemaVersion": 2,
        "package": "Kenney Nature Kit",
        "packageVersion": "2.1",
        "author": "Kenney",
        "license": "CC0-1.0",
        "licenseText": "/models/openworld/LICENSE-KENNEY.txt",
        "sourcePage": "https://kenney.nl/assets/nature-kit",
        "archiveUrl": "https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip",
        "archiveSha256": "fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d",
        "sourceRevision": "official-media-path-37ac38a37b-1677698939",
        "generatedBy": "scripts/normalize-world-assets.py with Blender 5.2.1 LTS",
        "coordinateSystem": "glTF Y-up; bottom-center pivot; dimensions are Three.js x/y/z metres",
        "materialTransform": "non-metallic woodland palette; roughness 0.9; source meshes unchanged",
        "totalBytes": total_bytes,
        "assets": report_assets,
    }
    (OUTPUT.parent / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (ARTIFACTS / "openworld-props-inspection.json").write_text(
        json.dumps({
            "blenderVersion": bpy.app.version_string,
            "blendFile": str(BLEND.relative_to(ROOT)).replace("\\", "/"),
            "preview": "artifacts/openworld-props-preview.png",
            "assetCount": len(report_assets),
            "totalBytes": total_bytes,
            "totalTriangles": sum(item["triangles"] for item in report_assets),
            "assets": report_assets,
        }, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"assetCount": len(report_assets), "totalBytes": total_bytes}, indent=2))


if __name__ == "__main__":
    main()
