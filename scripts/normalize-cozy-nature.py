"""Blender: package the free Quaternius Standard models for the open world.

Download Standard from the source URL in source.json into assets/source-world/
quaternius-stylized-nature-20260912, keeping the original ZIP and extracted files.
Run: blender --background --python scripts/normalize-cozy-nature.py
"""
import hashlib
import json
from pathlib import Path
import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/source-world/quaternius-stylized-nature-20260912'
OUTPUT = ROOT / 'public/models/openworld/cozy-nature'
OUTPUT.mkdir(parents=True, exist_ok=True)
STAGING = ROOT / 'artifacts/cozy-nature-build'
STAGING.mkdir(parents=True, exist_ok=True)
source = json.loads((SOURCE / 'source.json').read_text())
assert hashlib.sha256((SOURCE / source['archive']).read_bytes()).hexdigest() == source['sha256']
MODELS = [
    ('tree-round', 'CommonTree_1', 5.2, 1.22),
    ('tree-oak', 'CommonTree_2', 5.6, 1.22),
    ('tree-fat', 'CommonTree_5', 4.8, 1.3),
    ('tree-thin', 'CommonTree_3', 5.8, 1.2),
    ('tree-pine', 'Pine_1', 5.7, 1.0),
    ('rock-round', 'Rock_Medium_1', 2.1, 1.0),
    ('rock-wide', 'Rock_Medium_2', 1.7, 1.0),
    ('rock-tall', 'Rock_Medium_3', 3.0, 1.0),
    ('fern', 'Fern_1', .8, 1.0),
]


def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.outliner.orphans_purge(do_recursive=True)


def bounds(meshes):
    bpy.context.view_layer.update()
    points = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    return Vector([min(p[i] for p in points) for i in range(3)]), Vector([max(p[i] for p in points) for i in range(3)])


records = []
for name, original, height, width in MODELS:
    clear()
    path = SOURCE / 'extracted/glTF' / f'{original}.gltf'
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    lo, hi = bounds(meshes)
    center = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    scale = height / (hi.z - lo.z)
    for obj in meshes:
        matrix = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = Matrix.Identity(4)
        for vertex in obj.data.vertices:
            p = (matrix @ vertex.co - center) * scale
            vertex.co = (p.x * width, p.y * width, p.z)
        obj.data.update()
        obj.name = name
    # Bound texture memory while preserving original painted colors/alpha and UVs.
    for image in bpy.data.images:
        if image.type != 'IMAGE':
            continue
        w, h = image.size
        assert w > 0 and h > 0
        if max(w, h) > 1024:
            factor = 1024 / max(w, h)
            image.scale(round(w * factor), round(h * factor))
            image.filepath_raw = str(STAGING / f'{image.name}.png')
            image.file_format = 'PNG'
            image.save()
            if image.packed_file:
                image.unpack(method='REMOVE')
            image.reload()
            image.pack()
    for material in bpy.data.materials:
        if material.use_nodes:
            for node in material.node_tree.nodes:
                if node.type == 'BSDF_PRINCIPLED':
                    node.inputs['Roughness'].default_value = .92
                    node.inputs['Metallic'].default_value = 0
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    out = OUTPUT / f'{name}.glb'
    bpy.ops.export_scene.gltf(filepath=str(out), export_format='GLB', use_selection=True,
                              export_yup=True, export_image_format='AUTO', export_animations=False)
    clear()
    bpy.ops.import_scene.gltf(filepath=str(out))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    lo, hi = bounds(meshes)
    triangles = sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)
    assert abs(lo.z) < .002 and abs(lo.x + hi.x) < .004 and abs(lo.y + hi.y) < .004, (name, list(lo), list(hi))
    assert abs(hi.z - height) < .005 and triangles <= 6500
    assert all(o.data.uv_layers for o in meshes)
    assert all(0 < max(i.size) <= 1024 for i in bpy.data.images if i.type == 'IMAGE')
    records.append(dict(id=name, file=out.name, sourceFile=f'glTF/{original}.gltf',
                        sourceFileSha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                        bytes=out.stat().st_size, sha256=hashlib.sha256(out.read_bytes()).hexdigest(),
                        heightMeters=height, horizontalScale=width, triangles=triangles,
                        validation=dict(pivot='bottom-center', up='Y', uv=True, maxTextureSize=1024)))
    print(name, triangles, out.stat().st_size, flush=True)
(OUTPUT / 'manifest.json').write_text(json.dumps(dict(version='20260912-cozy', source=source,
    selection='Five green tree silhouettes, three painted rocks and a matching fern from the free Standard pack',
    excluded='Other Standard models and all paid Pro/Source content',
    conversion='Bottom-center pivot; Y-up meters; fuller broadleaf proportions; original topology, UVs, painted textures and alpha; textures limited to 1024px',
    assets=records), indent=2) + '\n')
(OUTPUT / 'LICENSE.txt').write_text((SOURCE / 'extracted/License_Standard.txt').read_text())
