#!/usr/bin/env python3
"""Fetch pinned CC0 Kenney building packs and emit small, normalized GLBs.

Run with the system Python. The script downloads and verifies source archives,
extracts them without modifying the archives, then starts Blender in background
mode to normalize the selected buildings::

    python scripts/fetch-kanto-assets.py

Use ``--download-only`` to stop before Blender, or ``--blender PATH`` when the
default Blender 5.2/5.1 installation paths do not apply.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / "data" / "local" / "kanto-assets"
SOURCE = LOCAL / "source"
EXTRACTED = LOCAL / "extracted"
OUTPUT = ROOT / "public" / "models" / "kanto-buildings"

PACKS = {
    "suburban-2.0": {
        "title": "Kenney City Kit (Suburban)",
        "version": "2.0",
        "sourcePage": "https://kenney.nl/assets/city-kit-suburban",
        "archiveUrl": "https://kenney.nl/media/pages/assets/city-kit-suburban/2c871b7af2-1745479373/kenney_city-kit-suburban_20.zip",
        "archiveFile": "kenney_city-kit-suburban_20.zip",
        "archiveSha256": "5869c35cf30b1c87bdb2d197b6d325eebadd2ef08ea27f04797e8e08d77a9a39",
        "sourceRevision": "official-media-path-2c871b7af2-1745479373",
    },
    "commercial-2.1": {
        "title": "Kenney City Kit (Commercial)",
        "version": "2.1",
        "sourcePage": "https://kenney.nl/assets/city-kit-commercial",
        "archiveUrl": "https://kenney.nl/media/pages/assets/city-kit-commercial/a742d900eb-1753115042/kenney_city-kit-commercial_2.1.zip",
        "archiveFile": "kenney_city-kit-commercial_2.1.zip",
        "archiveSha256": "f8b09b081c2bb88bcc126e2dec1cb40fd0dad7e7e591b6c26aaefe96fb35276b",
        "sourceRevision": "official-media-path-a742d900eb-1753115042",
    },
}

# id, pack, source GLB, official texture variation, target maximum x/z footprint,
# semantic role. All output roots have unit scale and a bottom-centre pivot.
ASSETS = [
    ("town-house", "suburban-2.0", "building-type-n.glb", None, (2.75, 2.55), "residence"),
    ("town-house-large", "suburban-2.0", "building-type-d.glb", None, (3.15, 2.75), "residence-large"),
    ("town-clinic", "suburban-2.0", "building-type-a.glb", "variation-b.png", (3.20, 2.80), "clinic"),
    ("town-mart", "suburban-2.0", "building-type-h.glb", "variation-a.png", (3.20, 2.55), "shop"),
    ("town-gym", "commercial-2.1", "building-e.glb", None, (3.20, 2.80), "gym"),
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_extract(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as bundle:
        root = destination.resolve()
        for member in bundle.infolist():
            target = (destination / member.filename).resolve()
            if target != root and root not in target.parents:
                raise RuntimeError(f"unsafe archive member: {member.filename}")
        bundle.extractall(destination)


def acquire_sources(force: bool = False) -> dict:
    SOURCE.mkdir(parents=True, exist_ok=True)
    EXTRACTED.mkdir(parents=True, exist_ok=True)
    receipts = []
    for pack_id, pack in PACKS.items():
        archive = SOURCE / pack["archiveFile"]
        if force or not archive.exists():
            partial = archive.with_suffix(archive.suffix + ".part")
            request = urllib.request.Request(
                pack["archiveUrl"], headers={"User-Agent": "choketmon-kanto-assets/1.0"}
            )
            with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as output:
                shutil.copyfileobj(response, output)
            partial.replace(archive)
        actual_sha = sha256(archive)
        if actual_sha != pack["archiveSha256"]:
            raise RuntimeError(
                f"{archive.name} SHA-256 mismatch: expected {pack['archiveSha256']}, got {actual_sha}"
            )
        destination = EXTRACTED / pack_id
        if force and destination.exists():
            shutil.rmtree(destination)
        if not destination.exists():
            safe_extract(archive, destination)
        license_path = destination / "License.txt"
        if not license_path.exists():
            raise RuntimeError(f"missing bundled license: {license_path}")
        receipts.append(
            {
                "id": pack_id,
                **pack,
                "author": "Kenney",
                "license": "CC0-1.0",
                "licenseFile": str(license_path.relative_to(ROOT)).replace("\\", "/"),
                "licenseSha256": sha256(license_path),
                "archiveBytes": archive.stat().st_size,
                "extractedFiles": sum(1 for item in destination.rglob("*") if item.is_file()),
            }
        )
    receipt = {
        "schemaVersion": 1,
        "sourcePolicy": "Official Kenney archives; originals retained byte-for-byte; normalized outputs are separate.",
        "packages": receipts,
    }
    (LOCAL / "source-receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return receipt


def find_blender(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit)
        if path.exists():
            return path
        raise RuntimeError(f"Blender executable does not exist: {path}")
    located = shutil.which("blender")
    candidates = [
        Path(located) if located else None,
        Path(r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"),
        Path(r"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe"),
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    raise RuntimeError("Blender was not found; pass --blender with an executable path")


def normal_entry(argv: list[str]) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT, help="reserved for compatibility; must be this checkout")
    parser.add_argument("--force", action="store_true", help="redownload and re-extract pinned archives")
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--blender")
    args = parser.parse_args(argv)
    if args.root.resolve() != ROOT.resolve():
        raise RuntimeError("this script currently normalizes only its containing checkout")
    receipt = acquire_sources(args.force)
    print(json.dumps(receipt, ensure_ascii=False, indent=2))
    if args.download_only:
        return
    blender = find_blender(args.blender)
    subprocess.run(
        [str(blender), "--background", "--factory-startup", "--python", str(Path(__file__).resolve()), "--", "--normalize"],
        cwd=ROOT,
        check=True,
    )


def blender_entry() -> None:
    import math

    import bpy
    from mathutils import Vector

    def clean_scene() -> None:
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=False)

    def bounds(objects):
        points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
        return (
            Vector(tuple(min(point[index] for point in points) for index in range(3))),
            Vector(tuple(max(point[index] for point in points) for index in range(3))),
        )

    def set_variation(meshes, variation_path: Path | None) -> None:
        if variation_path is None:
            return
        variation = bpy.data.images.load(str(variation_path), check_existing=True)
        for mesh in meshes:
            for slot in mesh.material_slots:
                material = slot.material
                if not material or not material.use_nodes or not material.node_tree:
                    continue
                for node in material.node_tree.nodes:
                    if node.type == "TEX_IMAGE" and node.image:
                        node.image = variation

    def normalize_asset(asset_id, pack_id, source_name, variation_name, target, role):
        clean_scene()
        pack_root = EXTRACTED / pack_id
        source_path = pack_root / "Models" / "GLB format" / source_name
        if not source_path.exists():
            raise RuntimeError(f"missing selected source GLB: {source_path}")
        bpy.ops.import_scene.gltf(filepath=str(source_path))
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        if not meshes:
            raise RuntimeError(f"no mesh in {source_name}")
        for obj in meshes:
            world = obj.matrix_world.copy()
            obj.parent = None
            obj.matrix_world = world
        minimum, maximum = bounds(meshes)
        size = maximum - minimum
        factor = min(target[0] / size.x, target[1] / size.y)
        centre = (minimum + maximum) * 0.5
        origin = Vector((centre.x, centre.y, minimum.z))
        for obj in meshes:
            obj.location = (obj.location - origin) * factor
            obj.scale *= factor
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        variation_path = pack_root / "Models" / "Textures" / variation_name if variation_name else None
        set_variation(meshes, variation_path)
        for index, obj in enumerate(meshes):
            obj.name = asset_id if index == 0 else f"{asset_id}-{index:02d}"
        minimum, maximum = bounds(meshes)
        size = maximum - minimum
        triangles = sum(len(face.vertices) - 2 for obj in meshes for face in obj.data.polygons)
        vertices = sum(len(obj.data.vertices) for obj in meshes)
        if triangles > 10_000:
            raise RuntimeError(f"{asset_id} exceeds the 10k triangle budget: {triangles}")
        if size.x > target[0] + 0.005 or size.y > target[1] + 0.005:
            raise RuntimeError(f"{asset_id} footprint exceeds target: {size.x:.3f} x {size.y:.3f}")
        OUTPUT.mkdir(parents=True, exist_ok=True)
        output_path = OUTPUT / f"{asset_id}.glb"
        bpy.ops.object.select_all(action="DESELECT")
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.export_scene.gltf(
            filepath=str(output_path), export_format="GLB", use_selection=True,
            export_yup=True, export_apply=True, export_materials="EXPORT",
            export_cameras=False, export_lights=False,
        )
        return meshes, {
            "id": asset_id,
            "role": role,
            "sourcePackage": pack_id,
            "sourceFile": f"Models/GLB format/{source_name}",
            "sourceFileSha256": sha256(source_path),
            "textureVariation": variation_name or "embedded-default",
            "file": str(output_path.relative_to(ROOT)).replace("\\", "/"),
            "bytes": output_path.stat().st_size,
            "sha256": sha256(output_path),
            "dimensions": {"x": round(size.x, 4), "y": round(size.z, 4), "z": round(size.y, 4)},
            "rotation": [0, 0, 0],
            "scale": 1,
            "pivot": "bottom-center",
            "meshBudget": {"triangles": triangles, "vertices": vertices, "maxTriangles": 10_000},
        }

    def validate_export(item):
        clean_scene()
        output_path = ROOT / item["file"]
        bpy.ops.import_scene.gltf(filepath=str(output_path))
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        minimum, maximum = bounds(meshes)
        size = maximum - minimum
        measured = {"x": round(size.x, 4), "y": round(size.z, 4), "z": round(size.y, 4)}
        triangles = sum(len(face.vertices) - 2 for obj in meshes for face in obj.data.polygons)
        if abs(minimum.z) > 0.001:
            raise RuntimeError(f"{item['id']} export pivot is not grounded: {minimum.z}")
        if measured != item["dimensions"] or triangles != item["meshBudget"]["triangles"]:
            raise RuntimeError(f"{item['id']} changed on GLB round-trip")
        item["url"] = f"/models/kanto-buildings/{item['id']}.glb?v={item['sha256'][:12]}"
        item["deliveredValidation"] = {"dimensions": measured, "bottomY": round(minimum.z, 6), "triangles": triangles}

    results = []
    for asset in ASSETS:
        _, report = normalize_asset(*asset)
        results.append(report)
    for item in results:
        validate_export(item)

    # Re-import into a simple review board so the visual result is inspectable.
    clean_scene()
    for index, item in enumerate(results):
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / item["file"]))
        imported = [obj for obj in bpy.context.scene.objects if obj not in before]
        for obj in imported:
            if obj.parent not in imported:
                obj.location.x += (index - 2) * 4.4
    bpy.ops.mesh.primitive_plane_add(size=26, location=(0, 0, -0.025))
    ground = bpy.context.object
    ground_material = bpy.data.materials.new("Review ground")
    ground_material.diffuse_color = (0.12, 0.28, 0.12, 1)
    ground_material.roughness = 1
    ground.data.materials.append(ground_material)
    bpy.ops.object.camera_add(location=(12, -20, 12))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, 0, 1.3)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 48
    bpy.context.scene.camera = camera
    bpy.ops.object.light_add(type="AREA", location=(-5, -7, 12))
    bpy.context.object.data.energy = 1500
    bpy.context.object.data.size = 8
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
    bpy.context.object.rotation_euler = (math.radians(25), math.radians(-20), math.radians(25))
    bpy.context.object.data.energy = 2
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 620
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    (ROOT / "artifacts").mkdir(exist_ok=True)
    scene.render.filepath = str(ROOT / "artifacts" / "kanto-buildings-preview.png")
    scene.world.color = (0.035, 0.05, 0.075)
    bpy.ops.wm.save_as_mainfile(filepath=str(LOCAL / "kanto-buildings-inspection.blend"))
    bpy.ops.render.render(write_still=True)

    license_urls = []
    for pack_id in PACKS:
        label = pack_id.split("-")[0].upper()
        target = OUTPUT / f"LICENSE-KENNEY-{label}-CC0.txt"
        shutil.copyfile(EXTRACTED / pack_id / "License.txt", target)
        license_urls.append(f"/models/kanto-buildings/{target.name}")
    total_bytes = sum(item["bytes"] for item in results)
    if total_bytes > 2_000_000:
        raise RuntimeError(f"delivered building set exceeds 2 MB budget: {total_bytes}")
    manifest = {
        "schemaVersion": 1,
        "generatedBy": f"scripts/fetch-kanto-assets.py with Blender {bpy.app.version_string}",
        "license": "CC0-1.0",
        "licenseTexts": license_urls,
        "sourceReceipt": "data/local/kanto-assets/source-receipt.json",
        "coordinateSystem": "glTF Y-up; dimensions are Three.js x/y/z metres; bottom-center pivot",
        "totalBytes": total_bytes,
        "totalTriangles": sum(item["meshBudget"]["triangles"] for item in results),
        "assets": results,
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"assetCount": len(results), "totalBytes": total_bytes, "assets": results}, indent=2))


if __name__ == "__main__":
    blender_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if "--normalize" in blender_args:
        blender_entry()
    else:
        normal_entry(sys.argv[1:])
