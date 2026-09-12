"""Author compact, curved low-poly nature models; no external meshes/textures.

blender --background --python scripts/build-cute-nature.py
The editable Blender scene and each self-contained GLB use the same geometry.
"""
import hashlib
import json
import math
from pathlib import Path
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'public/models/openworld/cute-nature'
OUTPUT.mkdir(parents=True, exist_ok=True)
SOURCE = ROOT / 'assets/blender/cute-nature.blend'
SOURCE.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def material(name, hex_color):
    color = tuple(int(hex_color[i:i+2], 16) / 255 for i in (0, 2, 4))
    # Input colors are sRGB; glTF material factors are linear.
    color = tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in color)
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = .86
    shader.inputs['Emission Color'].default_value = (*color, 1)
    shader.inputs['Emission Strength'].default_value = .22
    return m


bark = material('warm biscuit bark', 'BD997A')
knot_mat = material('soft bark detail', 'A78568')
mint = material('mint cloud', '9FCFAB')
sage = material('pistachio crown', 'B2CE88')
light_mint = material('young mint leaves', 'BFDDB0')
pear = material('butter lime crown', 'CBD997')
pine_mat = material('sage evergreen', '94BDA5')
fruit = material('apricot fruit', 'F4BAA3')
stone = material('warm pebble', 'C5C8BE')
stone_light = material('cream pebble', 'DBD7C8')
stone_blue = material('blue grey pebble', 'B5C5CC')
moss = material('soft mint moss', 'AFC6A1')


def mesh(name, vertices, faces, mat):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(mat)
    for p in data.polygons:
        p.use_smooth = True
    return obj


def blob(name, position, scale, mat, segments=16, rings=10, phase=0):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=position)
    obj = bpy.context.object
    obj.name = name
    # Broad, deliberate asymmetry rather than a perfect sphere.
    for v in obj.data.vertices:
        p = v.co
        angle = math.atan2(p.y, p.x)
        swell = 1 + .055 * math.sin(3 * angle + phase) * (1 - p.z * p.z)
        p.x *= scale[0] * swell
        p.y *= scale[1] * swell
        p.z *= scale[2]
    obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def activate(objects):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def fused_crown(name, lobes, mat, budget=1100):
    pieces = [blob(name, pos, scale, mat, 20, 12, i * .7) for i, (pos, scale) in enumerate(lobes)]
    activate(pieces)
    bpy.ops.object.join()
    obj = bpy.context.object
    remesh = obj.modifiers.new('continuous hand-shaped crown', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = .105
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth = obj.modifiers.new('soft canopy valleys', 'SMOOTH')
    smooth.factor = 1.2
    smooth.iterations = 7
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    triangles = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    decimate = obj.modifiers.new('compact curved silhouette', 'DECIMATE')
    decimate.ratio = min(1, budget / triangles)
    bpy.ops.object.modifier_apply(modifier=decimate.name)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def trunk(name, height=2.1, bend=.16):
    vertices, faces = [], []
    rings = [(0, .52), (.14, .45), (.55, .32), (1.05, .28), (1.55, .29), (height, .21)]
    sides = 12
    for j, (z, radius) in enumerate(rings):
        for i in range(sides):
            a = i * 2 * math.pi / sides
            root = 1 + (.16 * math.cos(3*a) if j < 2 else .025 * math.sin(3*a))
            vertices.append((math.cos(a)*radius*root + bend*(z/height)**2,
                             math.sin(a)*radius*root, z))
    for j in range(len(rings)-1):
        for i in range(sides):
            a = j*sides+i; b = j*sides+(i+1)%sides
            faces.append((a, b, b+sides, a+sides))
    faces.extend([tuple(reversed(range(sides))), tuple((len(rings)-1)*sides+i for i in range(sides))])
    obj = mesh(name, vertices, faces, bark)
    bevel = obj.modifiers.new('rounded roots', 'BEVEL')
    bevel.width = .07; bevel.segments = 2
    activate([obj]); bpy.ops.object.modifier_apply(modifier=bevel.name)
    return obj


def leaf(name, position, scale, rotation=0):
    obj = blob(name, position, scale, light_mint, 10, 6)
    obj.rotation_euler = (.15, .22, rotation)
    return obj


def tree(name, variant):
    trunk(name+' trunk', 2.2 if variant != 2 else 1.9, .14 if variant%2 else -.14)
    settings = [
        (mint, [((0, 0, 2.95),(1.4,1.25,1.35)), ((-.85,.02,2.55),(.95,1.05,.88)), ((.85,.12,2.8),(1.0,1.0,1.05)), ((-.25,.0,3.7),(1.02,.98,.87))]),
        (sage, [((0,0,3.0),(1.4,1.22,1.32)), ((-.9,.1,2.8),(1.04,.98,.98)), ((.9,.05,2.72),(1.05,1.0,.95)), ((-.32,.03,3.75),(1.02,.93,.94)), ((.55,.05,3.62),(.93,.91,.85))]),
        (pear, [((0,0,2.75),(1.55,1.35,1.15)), ((-.95,.05,2.5),(.87,1.0,.81)), ((.96,.02,2.54),(.88,1.0,.84)), ((.1,0,3.4),(1.04,1.0,.72))]),
        (light_mint, [((0,0,2.72),(1.22,1.14,1.1)), ((-.45,0,3.47),(1.13,1.02,1.05)), ((.4,.05,3.8),(.95,.94,.83))]),
    ]
    mat, lobes = settings[variant]
    fused_crown(name+' crown', lobes, mat)
    # Small sculpted leaf pairs give a designed silhouette at close range.
    leaf(name+' leaf left', (-.18,-.04,4.45 if variant == 1 else max(p[0][2]+p[1][2] for p in lobes)-.12), (.24,.10,.09), -.45)
    leaf(name+' leaf right', (.16,.03,4.48 if variant == 1 else max(p[0][2]+p[1][2] for p in lobes)-.08), (.22,.10,.085), .45)
    if variant == 1:
        for i, pos in enumerate([(-.94,-.86,2.9),(.8,-.95,2.75),(.18,-1.04,3.48)]):
            blob('apricot '+str(i), pos, (.18,.18,.20), fruit, 12, 8)


def pine(name):
    trunk(name+' trunk', 1.6, .1)
    for level, (z,r,h) in enumerate([(1.35,1.55,1.55),(2.25,1.22,1.45),(3.2,.86,1.35)]):
        vertices, faces = [], []
        profile = [(0,.68),(.09,.91),(.25,1.0),(.45,.87),(.72,.58),(.92,.22),(1,.04)]
        sides = 20
        for j,(t,width) in enumerate(profile):
            for i in range(sides):
                a=i*2*math.pi/sides
                scallop=1+.045*math.cos(5*a)
                vertices.append((math.cos(a)*r*width*scallop,math.sin(a)*r*width*scallop,z+t*h))
        for j in range(len(profile)-1):
            for i in range(sides):
                a=j*sides+i; b=j*sides+(i+1)%sides
                faces.append((a,b,b+sides,a+sides))
        faces += [tuple(reversed(range(sides))),tuple((len(profile)-1)*sides+i for i in range(sides))]
        mesh(name+' soft tier '+str(level), vertices, faces, pine_mat)


def rock(name, variant):
    sizes = [(1.35,1.0,1.05),(1.55,1.12,.8),(1.25,1.02,1.45)]
    sx,sy,sz = sizes[variant]
    # A softened irregular superellipsoid gives broad stone planes with rounded edges.
    obj = blob(name, (0,0,sz*.88), (1,1,1), [stone,stone_light,stone_blue][variant], 16, 10, variant)
    for v in obj.data.vertices:
        p=v.co.copy()
        power=.73
        shaped=Vector([math.copysign(abs(c)**power,c) for c in p])
        shaped.x *= sx*(1+.10*p.z+.05*p.y)
        shaped.y *= sy*(1-.08*p.x)
        shaped.z *= sz
        v.co=shaped
    for i,(pos,scale) in enumerate([((-.52,-.17,sz*1.79),(.48,.37,.065)), ((.25,.02,sz*1.91),(.33,.29,.055))]):
        blob(name+' moss cushion '+str(i),pos,scale,moss,12,6)


def plant(name):
    for i in range(7):
        a=i*2*math.pi/7
        obj=blob(name+' spoon leaf '+str(i),(math.cos(a)*.2,math.sin(a)*.2,.27),(.13,.36,.09),mint if i%2 else light_mint,10,6)
        obj.rotation_euler=(.6,0,a-math.pi/2)


records=[]
all_objects=[]
for name, make in [
    ('tree-round',lambda:tree('cloud tree',0)), ('tree-oak',lambda:tree('apricot tree',1)),
    ('tree-fat',lambda:tree('butter tree',2)), ('tree-thin',lambda:tree('young tree',3)),
    ('tree-pine',lambda:pine('soft pine')), ('rock-round',lambda:rock('rounded boulder',0)),
    ('rock-wide',lambda:rock('wide pebble',1)), ('rock-tall',lambda:rock('tall pebble',2)),
    ('fern',lambda:plant('spoon leaves')),
]:
    before=set(bpy.context.scene.objects)
    make()
    objects=[o for o in bpy.context.scene.objects if o not in before]
    activate(objects)
    bpy.ops.object.join()
    obj=bpy.context.object; obj.name=name
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    lo=Vector([min(v.co[i] for v in obj.data.vertices) for i in range(3)])
    hi=Vector([max(v.co[i] for v in obj.data.vertices) for i in range(3)])
    center=Vector(((lo.x+hi.x)/2,(lo.y+hi.y)/2,lo.z))
    for v in obj.data.vertices:v.co-=center
    obj.data.update()
    tri=sum(len(p.vertices)-2 for p in obj.data.polygons)
    assert tri<=2600,(name,tri)
    path=OUTPUT/f'{name}.glb'
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_yup=True,export_animations=False)
    records.append(dict(id=name,file=path.name,triangles=tri,bytes=path.stat().st_size,
                        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),height=hi.z-lo.z,
                        dimensions=[hi[i]-lo[i] for i in range(3)],materials=len(obj.data.materials)))
    all_objects.append(obj)
    print(name,tri,path.stat().st_size,flush=True)
for i,obj in enumerate(all_objects):obj.location=((i%5)*5.5,(i//5)*6,0)
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))
(OUTPUT/'manifest.json').write_text(json.dumps(dict(version='20260912-cute-lowpoly',
    provenance='Original procedural modeling for Choketmon. No third-party meshes or textures.',
    generator='scripts/build-cute-nature.py',generatorSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    sourceScene='assets/blender/cute-nature.blend',
    design='Low-poly curved silhouettes, fused cloud canopies, short rooted trunks, rounded stone planes, pastel materials',
    axes='Y-up meters; bottom-center pivot',assets=records),indent=2)+'\n')
