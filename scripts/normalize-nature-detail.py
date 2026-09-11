"""Blender: normalize selected scanned CC0 props, with offline hash verification."""
import hashlib
import json
from pathlib import Path
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/source-world/polyhaven-nature-detail-20260911'
OUTPUT = ROOT / 'public/models/openworld/nature-detail'
OUTPUT.mkdir(parents=True, exist_ok=True)
manifest = json.loads((SOURCE / 'manifest.json').read_text())
for asset in manifest['assets']:
    for file in asset['files']:
        assert hashlib.sha256((SOURCE / file['file']).read_bytes()).hexdigest() == file['sha256']


def bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    return (Vector([min(p[i] for p in points) for i in range(3)]), Vector([max(p[i] for p in points) for i in range(3)]))


records = []
for name, asset, node, height, max_triangles in [
    ('moss-boulder', 'rock_moss_set_01', 'rock_moss_set_01_rock01', 1.35, 1800),
    ('moss-stone', 'rock_moss_set_01', 'rock_moss_set_01_rock03', .62, 1200),
    ('fern', 'fern_02', 'fern_02_a', .8, 1000),
]:
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE / asset / f'{asset}_1k.gltf'))
    obj = bpy.data.objects[node]
    source_triangles = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    matrix = obj.matrix_world.copy()
    obj.parent = None
    obj.matrix_world = matrix
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    lo, hi = bounds([obj])
    scale = height / (hi.z - lo.z)
    obj.location = (obj.location - Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))) * scale
    obj.scale *= scale
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if source_triangles > max_triangles:
        modifier = obj.modifiers.new('Bounded game mesh', 'DECIMATE')
        modifier.ratio = max_triangles / source_triangles
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    # Decimation can move extreme vertices. Re-establish the final pivot/height
    # from the delivered geometry rather than accepting a floating rock.
    lo = Vector([min(v.co[i] for v in obj.data.vertices) for i in range(3)])
    hi = Vector([max(v.co[i] for v in obj.data.vertices) for i in range(3)])
    center = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    scale = height / (hi.z - lo.z)
    for vertex in obj.data.vertices:
        vertex.co = (vertex.co - center) * scale
    obj.data.update()
    bpy.context.view_layer.update()
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj.name = name
    path = OUTPUT / f'{name}.glb'
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_yup=True,
                              export_image_format='AUTO', export_materials='EXPORT', export_animations=False)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(path))
    bpy.context.view_layer.update()
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    lo, hi = bounds(meshes)
    triangles = sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)
    assert abs(lo.z) < .002 and abs((lo.x + hi.x) / 2) < .002 and abs((lo.y + hi.y) / 2) < .002
    assert abs(hi.z - height) < .025 and triangles <= max_triangles + 10
    assert all(o.data.uv_layers for o in meshes)
    sources = next(a for a in manifest['assets'] if a['id'] == asset)
    records.append(dict(id=name, file=path.name, bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                        source=sources, selectedNode=node, excluded='Other source variants',
                        conversion='Selected original mesh; bottom center pivot, Y-up meters; UV-preserving decimation; original PBR maps',
                        sourceTriangles=source_triangles, validation=dict(triangles=triangles, height=hi.z, uv=True, pivot='bottom-center')))
    print(name, triangles, path.stat().st_size, flush=True)
(OUTPUT / 'manifest.json').write_text(json.dumps(dict(version='20260911', license='CC0-1.0', assets=records), indent=2) + '\n')
(OUTPUT / 'LICENSE.txt').write_text((SOURCE / 'LICENSE.txt').read_text())
