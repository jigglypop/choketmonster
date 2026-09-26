"""Inspects trainer figure GLBs in Blender and renders them for review.

blender -b --factory-startup -P scripts/inspect-figure-blender.py -- --out <dir> <figure.glb> [...]

Per figure it writes <dir>/<name>.json and <name>-*.png: a front, side and back turntable and three moments of each clip.
It checks what broke earlier figures: joints collapsed at the origin, skin weights piled on the hips, clips that never
move, arms left in the T rest pose, and weight on screen (triangles, texture sizes, file size).
"""
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else Path("artifacts/figure-inspection")
files = [Path(value) for index, value in enumerate(argv) if value.endswith(".glb") and (index == 0 or argv[index - 1] != "--out")]
out.mkdir(parents=True, exist_ok=True)

CORE_BONES = ["Hips", "Spine", "Neck", "Head", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand",
              "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot"]
# Budgets for a figure drawn a dozen at a time: triangles, largest texture side, file megabytes.
MAX_TRIANGLES, MAX_TEXTURE, MAX_MEGABYTES = 25_000, 2048, 4.0


def core_name(name):
    """Mixamo bone names carry a prefix: mixamorig:Hips, mixamorig_Hips, mixamorig1:Hips."""
    return name.split(":")[-1].split("mixamorig_")[-1]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def world_bone(armature, bone_name):
    pose = armature.pose.bones[bone_name]
    return armature.matrix_world @ pose.head, armature.matrix_world @ pose.tail


def arm_drop(armature, bones, side):
    """How far the upper arm points down: 0 in a T pose, near -1 hanging at the side."""
    upper, fore = bones.get(f"{side}Arm"), bones.get(f"{side}ForeArm")
    if not upper or not fore:
        return None
    head, _ = world_bone(armature, upper)
    elbow, _ = world_bone(armature, fore)
    direction = elbow - head
    return round(direction.z / (direction.length or 1), 3)


def use_action(armature, action):
    armature.animation_data_create()
    armature.animation_data.action = action
    if getattr(action, "slots", None):
        armature.animation_data.action_slot = action.slots[0]


def setup_render(scene):
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x, scene.render.resolution_y = 360, 480
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("inspect") if not scene.world else scene.world
    scene.world = world
    world.color = (0.62, 0.7, 0.78)
    camera_data = bpy.data.cameras.new("inspect")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("inspect", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    return camera


def frame_camera(camera, center, height, yaw):
    """Orthographic view from `yaw` degrees around the figure; 0 looks at its front (glTF +Z is Blender -Y)."""
    distance = height * 4
    angle = math.radians(yaw)
    camera.location = center + Vector((math.sin(angle) * distance, -math.cos(angle) * distance, 0))
    camera.rotation_euler = (math.radians(90), 0, angle)
    camera.data.ortho_scale = height * 1.15


def inspect(path):
    reset()
    bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True)
    scene = bpy.context.scene
    name = path.stem
    problems, warnings = [], []
    armatures = [obj for obj in scene.objects if obj.type == "ARMATURE"]
    # The importer's bone-shape sphere sits in glTF_not_exported; it is not part of the figure.
    meshes = [obj for obj in scene.objects if obj.type == "MESH" and not any(c.name.startswith("glTF_not_exported") for c in obj.users_collection)]
    report = {"file": str(path), "megabytes": round(path.stat().st_size / 1e6, 2), "meshes": len(meshes), "armatures": len(armatures)}

    triangles = vertices = 0
    for obj in meshes:
        mesh = obj.data
        mesh.calc_loop_triangles()
        triangles += len(mesh.loop_triangles)
        vertices += len(mesh.vertices)
    images = sorted({(image.name, image.size[0], image.size[1]) for image in bpy.data.images if image.size[0]})
    report.update(triangles=triangles, vertices=vertices, images=[{"name": n, "width": w, "height": h} for n, w, h in images])
    if triangles > MAX_TRIANGLES:
        warnings.append(f"{triangles} triangles (budget {MAX_TRIANGLES})")
    if any(max(w, h) > MAX_TEXTURE for _, w, h in images):
        warnings.append(f"texture above {MAX_TEXTURE}px")
    if report["megabytes"] > MAX_MEGABYTES:
        warnings.append(f"{report['megabytes']} MB file (budget {MAX_MEGABYTES})")

    # Bounds of the deformed vertices: the armature places a skinned body, not the mesh object's own box.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    corners = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        corners.extend(obj.matrix_world @ vertex.co for vertex in evaluated.to_mesh().vertices)
        evaluated.to_mesh_clear()
    low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners))) if corners else Vector()
    high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners))) if corners else Vector()
    height = max(high.z - low.z, 1e-6)
    report.update(height=round(height, 3), footprint=[round(high.x - low.x, 3), round(high.y - low.y, 3)], floor=round(low.z, 3))

    if not armatures:
        problems.append("no armature")
    armature = armatures[0] if armatures else None
    bones = {}
    if armature:
        bones = {core_name(bone.name): bone.name for bone in armature.data.bones}
        report["bones"] = len(armature.data.bones)
        missing = [bone for bone in CORE_BONES if bone not in bones]
        report["missingBones"] = missing
        if missing:
            problems.append("missing bones: " + ", ".join(missing))
        # Joints dumped at the origin: the bone heads span almost nothing next to the body they should fill.
        heads = [armature.matrix_world @ bone.head_local for bone in armature.data.bones]
        spread = max((a - b).length for a in heads for b in heads) / height if len(heads) > 1 else 0
        report["jointSpread"] = round(spread, 3)
        if spread < 0.2:
            problems.append(f"joints collapsed (spread {spread:.2f} of the height)")

        # Skin weights: every vertex bound, and the hips not carrying the body alone.
        totals, unweighted, most = {}, 0, 0
        for obj in meshes:
            groups = {group.index: group.name for group in obj.vertex_groups}
            for vertex in obj.data.vertices:
                bound = [(groups.get(g.group), g.weight) for g in vertex.groups if g.weight > 1e-4 and g.group in groups]
                if not bound:
                    unweighted += 1
                most = max(most, len(bound))
                for group, weight in bound:
                    totals[group] = totals.get(group, 0) + weight
        total = sum(totals.values()) or 1
        hips_share = totals.get(bones.get("Hips", ""), 0) / total
        report.update(unweightedVertices=unweighted, hipsWeightShare=round(hips_share, 3), maxInfluences=most,
                      topWeights=[{"bone": core_name(bone), "share": round(weight / total, 3)} for bone, weight in sorted(totals.items(), key=lambda item: -item[1])[:5]])
        if vertices and unweighted / vertices > 0.01:
            problems.append(f"{unweighted} vertices without weights")
        if hips_share > 0.45:
            problems.append(f"hips carry {hips_share:.0%} of the skin weight")

        # Facing: toes point forward. glTF +Z forward imports as Blender -Y.
        forward = Vector()
        for side in ("Left", "Right"):
            foot, toe = bones.get(f"{side}Foot"), bones.get(f"{side}ToeBase")
            if foot and toe:
                forward += (armature.matrix_world @ armature.data.bones[toe].head_local) - (armature.matrix_world @ armature.data.bones[foot].head_local)
        if forward.length > 1e-6:
            yaw = math.degrees(math.atan2(forward.x, -forward.y))
            report["facingYaw"] = round(yaw, 1)
            if abs(yaw) > 35:
                problems.append(f"faces {yaw:.0f} degrees off the front")

    camera = setup_render(scene)
    center = (low + high) / 2
    renders = []

    def shoot(label, yaw):
        frame_camera(camera, center, height, yaw)
        target = out / f"{name}-{label}.png"
        scene.render.filepath = str(target)
        bpy.ops.render.render(write_still=True)
        renders.append(target.name)

    clips = []
    if armature:
        actions = list(bpy.data.actions)
        for action in actions:
            use_action(armature, action)
            start, end = (int(v) for v in action.frame_range)
            samples = sorted({start, start + (end - start) // 3, start + 2 * (end - start) // 3, end})
            rotations, drops, hips_path, feet = [], [], [], []
            for frame in samples:
                scene.frame_set(frame)
                rotations.append({bone.name: bone.matrix.to_quaternion() for bone in armature.pose.bones})
                drops.append((arm_drop(armature, bones, "Left"), arm_drop(armature, bones, "Right")))
                if "Hips" in bones:
                    hips_path.append(world_bone(armature, bones["Hips"])[0])
                for side in ("Left", "Right"):
                    if f"{side}Foot" in bones:
                        feet.append(world_bone(armature, bones[f"{side}Foot"])[0].z - low.z)
            turn = max((math.degrees(a[key].rotation_difference(b[key]).angle) for a, b in zip(rotations, rotations[1:]) for key in a), default=0)
            left = [d[0] for d in drops if d[0] is not None]
            right = [d[1] for d in drops if d[1] is not None]
            drift = max(((a - hips_path[0]).to_2d().length for a in hips_path), default=0) / height
            clip = {"name": action.name, "frames": [start, end], "maxTurn": round(turn, 1), "moving": turn > 2,
                    "armDrop": [round(sum(left) / len(left), 2) if left else None, round(sum(right) / len(right), 2) if right else None],
                    "hipsDrift": round(drift, 3), "lowestFoot": round(min(feet), 3) if feet else None}
            clips.append(clip)
            lower = action.name.lower()
            if not clip["moving"] and "rest" not in lower:
                warnings.append(f"clip {action.name} never moves")
            if clip["moving"] and any(word in lower for word in ("idle", "walk")) and left and right and max(clip["armDrop"]) > -0.3:
                problems.append(f"arms held out in {action.name} (arm drop {clip['armDrop']})")
            if "idle" in lower and drift > 0.15:
                warnings.append(f"{action.name} drifts {drift:.0%} of the height")
            for index, frame in enumerate(samples[:3]):
                scene.frame_set(frame)
                shoot(f"{''.join(ch for ch in action.name if ch.isalnum())[:24]}-{index}", 25)
        armature.animation_data.action = None
    report["clips"] = clips
    if armature and not any("idle" in clip["name"].lower() for clip in clips):
        warnings.append("no idle clip")
    if armature and not any("walk" in clip["name"].lower() for clip in clips):
        problems.append("no walk clip")
    scene.frame_set(0)
    for label, yaw in (("front", 0), ("side", 90), ("back", 180)):
        shoot(label, yaw)
    report.update(renders=renders, problems=problems, warnings=warnings, verdict="fail" if problems else "pass")
    (out / f"{name}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"INSPECTED {name} {report['verdict']} {len(problems)} problems {len(warnings)} warnings", flush=True)
    return report


summary = [inspect(path) for path in files]
(out / "summary.json").write_text(json.dumps([{k: r[k] for k in ("file", "verdict", "problems", "warnings", "triangles", "megabytes")} for r in summary], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
