#!/usr/bin/env python3
"""Build the canonical FPS right arm from the authored CT soldier rig.

The result is not a replacement/procedural hand.  It is the original `Body`
SkinnedMesh and `CharacterArmature` from ``soldier_ct.glb``, frozen in the
authored ``Idle_Shoot`` grip pose.  Every mesh vertex except the right lower
arm and articulated fingers is removed before export.

The exported scene uses the viewmodel weapon convention used by this project:
``VM_Grip`` is an identity node at the origin, +Y is up, and an external
weapon GLB can be added as its sibling with an identity transform.  The
normalization is derived from the NPC AK's authored ``Index1.R`` attachment
and the same -90 degree axis correction used by
``tools/render-npc-fps-approval.py``.

Usage:
    blender --background --python tools/generate-npc-viewmodel-arms.py -- \
      --source assets/models/soldier_ct.glb \
      --output assets/models/viewmodels/npc-arms-ct.glb
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector


ARM_GROUP_PREFIXES = ("LowerArm", "Pinky", "Middle", "Index", "Thumb")
ARM_SIDE_SUFFIX = ".R"


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="assets/models/soldier_ct.glb")
    parser.add_argument(
        "--output", default="assets/models/viewmodels/npc-arms-ct.glb"
    )
    parser.add_argument("--clip", default="Idle_Shoot")
    parser.add_argument("--frame", type=float, default=4.0)
    parser.add_argument("--weight-threshold", type=float, default=0.20)
    parser.add_argument("--weapon-axis", type=float, default=-90.0)
    parser.add_argument(
        "--forearm-reach",
        type=float,
        default=0.0,
        help=(
            "Optional maximum grip-space reach along -Y in meters. Use 0 "
            "(the default) to preserve the complete authored lower arm so "
            "its natural sleeve can exit below the FPS camera frame."
        ),
    )
    return parser.parse_args(argv)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def set_authored_pose(
    armature: bpy.types.Object, clip_name: str, frame: float
) -> None:
    action = bpy.data.actions.get(clip_name)
    if action is None:
        available = ", ".join(sorted(item.name for item in bpy.data.actions))
        raise RuntimeError(
            f"NPC clip {clip_name!r} was not found; available clips: {available}"
        )
    if armature.animation_data is None:
        armature.animation_data_create()
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    armature.animation_data.action = action
    bpy.context.scene.frame_set(int(frame), subframe=frame % 1.0)
    bpy.context.view_layer.update()


def wanted_vertex_groups(body: bpy.types.Object) -> dict[int, str]:
    return {
        group.index: group.name
        for group in body.vertex_groups
        if group.name.endswith(ARM_SIDE_SUFFIX)
        and group.name.startswith(ARM_GROUP_PREFIXES)
    }


def isolate_right_lower_arm(
    body: bpy.types.Object, threshold: float
) -> tuple[int, int, list[str]]:
    """Delete every vertex not materially influenced by a requested R bone."""
    wanted = wanted_vertex_groups(body)
    if not wanted:
        raise RuntimeError("No right lower-arm/finger weight groups were found")

    source_vertices = len(body.data.vertices)
    keep_indices: set[int] = set()
    for vertex in body.data.vertices:
        requested_weight = sum(
            membership.weight
            for membership in vertex.groups
            if membership.group in wanted
        )
        if requested_weight >= threshold:
            keep_indices.add(vertex.index)

    if not keep_indices:
        raise RuntimeError(
            f"Weight threshold {threshold} removed the entire requested arm"
        )

    mesh = body.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(
        bm,
        geom=[vertex for vertex in bm.verts if vertex.index not in keep_indices],
        context="VERTS",
    )
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    return source_vertices, len(mesh.vertices), sorted(wanted.values())


def apply_pose_as_rest(
    armature: bpy.types.Object, body: bpy.types.Object
) -> None:
    """Bake the sampled deformation and make that pose the new skinned rest.

    Applying only the pose to the armature changes its bind matrices but can
    move the mesh when the result is round-tripped through glTF.  Baking the
    current deformation into the original Body mesh first, then rebuilding
    the same armature modifier against the new rest pose, preserves the
    authored silhouette while keeping a real skin.
    """
    modifiers = [modifier for modifier in body.modifiers if modifier.type == "ARMATURE"]
    if len(modifiers) != 1 or modifiers[0].object != armature:
        raise RuntimeError("Expected one Body armature modifier before pose bake")

    bpy.ops.object.select_all(action="DESELECT")
    body.hide_viewport = False
    body.hide_set(False)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier=modifiers[0].name)

    bpy.ops.object.select_all(action="DESELECT")
    armature.hide_viewport = False
    armature.hide_set(False)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    armature.animation_data_clear()
    armature.data.pose_position = "REST"

    skin = body.modifiers.new(name="CharacterArmature", type="ARMATURE")
    skin.object = armature
    skin.use_vertex_groups = True
    bpy.context.view_layer.update()


def crop_distant_forearm(
    body: bpy.types.Object, forearm_reach: float
) -> dict[str, object]:
    """Optionally remove the distant sleeve after baking grip-locally.

    In the standardized grip frame the forearm exits toward -Y.  The CT hand
    and every finger-weighted vertex end before -0.31 m, while the black
    sleeve continues to roughly -0.60 m.  Cropping is opt-in because a cut
    sleeve exposes a severed circular end in some weapon poses; the default
    full arm is positioned low enough for its natural end to exit the frame.
    """
    if forearm_reach < 0.0:
        raise RuntimeError("--forearm-reach cannot be negative")
    if forearm_reach == 0.0:
        return {
            "forearm_reach": 0.0,
            "forearm_cutoff_y": None,
            "crop_removed_vertices": 0,
            "crop_removed_polygons": 0,
        }

    finger_indices = {
        group.index
        for group in body.vertex_groups
        if group.name.endswith(ARM_SIDE_SUFFIX)
        and group.name.startswith(("Pinky", "Middle", "Index", "Thumb"))
    }
    cutoff_y = -forearm_reach
    remove_indices: set[int] = set()
    protected_beyond_cutoff: list[int] = []
    for vertex in body.data.vertices:
        world = body.matrix_world @ vertex.co
        if world.y >= cutoff_y:
            continue
        finger_weight = sum(
            membership.weight
            for membership in vertex.groups
            if membership.group in finger_indices
        )
        if finger_weight > 1e-6:
            protected_beyond_cutoff.append(vertex.index)
        else:
            remove_indices.add(vertex.index)

    if protected_beyond_cutoff:
        raise RuntimeError(
            "Forearm crop would remove "
            f"{len(protected_beyond_cutoff)} finger-weighted vertices; "
            "increase --forearm-reach"
        )
    if not remove_indices:
        raise RuntimeError(
            "Forearm crop removed no geometry; decrease --forearm-reach"
        )

    before_vertices = len(body.data.vertices)
    before_polygons = len(body.data.polygons)
    mesh = body.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(
        bm,
        geom=[vertex for vertex in bm.verts if vertex.index in remove_indices],
        context="VERTS",
    )
    # Removing a sleeve ring can leave the next cut ring with no faces. Keep
    # the source topology clean instead of relying on the glTF exporter to
    # silently discard those unreferenced vertices.
    loose = [vertex for vertex in bm.verts if not vertex.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return {
        "forearm_reach": forearm_reach,
        "forearm_cutoff_y": cutoff_y,
        "crop_removed_vertices": before_vertices - len(mesh.vertices),
        "crop_removed_polygons": before_polygons - len(mesh.polygons),
    }


def authored_external_grip_matrix(
    armature: bpy.types.Object,
    source_weapon: bpy.types.Object,
    axis_degrees: float,
) -> Matrix:
    """Evaluate the proven external-weapon socket transform in world space."""
    probe = bpy.data.objects.new("_GripNormalizationProbe", None)
    bpy.context.collection.objects.link(probe)
    probe.parent = armature
    probe.parent_type = "BONE"
    probe.parent_bone = "Index1.R"
    probe.location = source_weapon.location.copy()
    probe.rotation_mode = "QUATERNION"
    correction = Euler(
        (0.0, 0.0, math.radians(axis_degrees)), "XYZ"
    ).to_quaternion()
    probe.rotation_quaternion = source_weapon.rotation_quaternion @ correction
    probe.scale = Vector((1.0, 1.0, 1.0))
    bpy.context.view_layer.update()
    matrix = probe.matrix_world.copy()
    bpy.data.objects.remove(probe, do_unlink=True)
    return matrix


def normalize_to_grip(
    armature: bpy.types.Object,
    grip_world: Matrix,
    source: str,
    clip: str,
    frame: float,
    axis_degrees: float,
) -> bpy.types.Object:
    """Move the authored rig into grip-local space under an identity root."""
    armature.matrix_world = grip_world.inverted() @ armature.matrix_world
    bpy.context.view_layer.update()

    grip = bpy.data.objects.new("VM_Grip", None)
    bpy.context.collection.objects.link(grip)
    grip.location = Vector((0.0, 0.0, 0.0))
    grip.rotation_mode = "QUATERNION"
    grip.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
    grip.scale = Vector((1.0, 1.0, 1.0))
    grip["source_asset"] = source
    grip["source_clip"] = clip
    grip["source_frame"] = frame
    grip["weapon_axis_correction_degrees"] = axis_degrees

    world = armature.matrix_world.copy()
    armature.parent = grip
    armature.parent_type = "OBJECT"
    armature.matrix_parent_inverse = Matrix.Identity(4)
    armature.matrix_world = world
    bpy.context.view_layer.update()
    return grip


def remove_everything_except(
    grip: bpy.types.Object,
    armature: bpy.types.Object,
    body: bpy.types.Object,
) -> None:
    allowed = {grip, armature, body}
    for obj in list(bpy.data.objects):
        if obj not in allowed:
            bpy.data.objects.remove(obj, do_unlink=True)


def mesh_bounds_world(body: bpy.types.Object) -> tuple[Vector, Vector]:
    points = [body.matrix_world @ vertex.co for vertex in body.data.vertices]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return minimum, maximum


def finger_metrics_world(body: bpy.types.Object) -> dict[str, object]:
    finger_indices = {
        group.index
        for group in body.vertex_groups
        if group.name.endswith(ARM_SIDE_SUFFIX)
        and group.name.startswith(("Pinky", "Middle", "Index", "Thumb"))
    }
    samples: list[tuple[Vector, float]] = []
    for vertex in body.data.vertices:
        weight = sum(
            membership.weight
            for membership in vertex.groups
            if membership.group in finger_indices
        )
        if weight > 0.0:
            samples.append((body.matrix_world @ vertex.co, weight))
    if not samples:
        raise RuntimeError("The exported arm has no finger-weighted vertices")

    points = [sample[0] for sample in samples]
    centroid = sum(points, Vector()) / len(points)
    weight_sum = sum(sample[1] for sample in samples)
    weighted_centroid = sum(
        (point * weight for point, weight in samples), Vector()
    ) / weight_sum
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return {
        "finger_vertices": len(samples),
        "finger_centroid": [round(value, 6) for value in centroid],
        "finger_weighted_centroid": [
            round(value, 6) for value in weighted_centroid
        ],
        "finger_bounds_min": [round(value, 6) for value in minimum],
        "finger_bounds_max": [round(value, 6) for value in maximum],
    }


def validate_scene(
    grip: bpy.types.Object,
    armature: bpy.types.Object,
    body: bpy.types.Object,
    wanted_names: list[str],
    threshold: float,
) -> dict[str, object]:
    if grip.matrix_world != Matrix.Identity(4):
        raise RuntimeError("VM_Grip must remain identity at the origin")
    if body.parent != armature:
        raise RuntimeError("Body lost its CharacterArmature parent")
    modifiers = [modifier for modifier in body.modifiers if modifier.type == "ARMATURE"]
    if len(modifiers) != 1 or modifiers[0].object != armature:
        raise RuntimeError("Body must retain one CharacterArmature skin modifier")
    if not body.data.vertices or not body.data.polygons:
        raise RuntimeError("Body arm geometry is empty")

    wanted_indices = {
        group.index for group in body.vertex_groups if group.name in wanted_names
    }
    unexpected_vertices: list[int] = []
    for vertex in body.data.vertices:
        requested_weight = sum(
            membership.weight
            for membership in vertex.groups
            if membership.group in wanted_indices
        )
        if requested_weight < threshold - 1e-6:
            unexpected_vertices.append(vertex.index)
    if unexpected_vertices:
        raise RuntimeError(
            f"{len(unexpected_vertices)} exported vertices violate the arm-only mask"
        )

    minimum, maximum = mesh_bounds_world(body)
    report = {
        "objects": [grip.name, armature.name, body.name],
        "vertices": len(body.data.vertices),
        "triangles": sum(len(poly.vertices) - 2 for poly in body.data.polygons),
        "materials": [slot.name for slot in body.data.materials],
        "armature_bones": len(armature.data.bones),
        "weighted_groups": wanted_names,
        "bounds_min": [round(value, 6) for value in minimum],
        "bounds_max": [round(value, 6) for value in maximum],
        "bounds_size": [round(value, 6) for value in maximum - minimum],
    }
    report.update(finger_metrics_world(body))
    return report


def export_glb(
    output: Path,
    grip: bpy.types.Object,
    armature: bpy.types.Object,
    body: bpy.types.Object,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (grip, armature, body):
        obj.hide_render = False
        obj.hide_viewport = False
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = grip
    bpy.ops.export_scene.gltf(
        filepath=str(output.resolve()),
        export_format="GLB",
        use_selection=True,
        export_animations=False,
        export_skins=True,
        export_all_influences=True,
        export_apply=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_yup=True,
        check_existing=False,
    )


def main() -> None:
    args = parse_args()
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(Path(args.source).resolve()))

    armature = bpy.data.objects.get("CharacterArmature")
    body = bpy.data.objects.get("Body")
    source_weapon = bpy.data.objects.get("AK")
    if armature is None or body is None or source_weapon is None:
        raise RuntimeError(
            "Expected CharacterArmature, Body, and authored AK in the CT GLB"
        )

    set_authored_pose(armature, args.clip, args.frame)
    source_vertices, kept_vertices, wanted_names = isolate_right_lower_arm(
        body, args.weight_threshold
    )
    grip_world = authored_external_grip_matrix(
        armature, source_weapon, args.weapon_axis
    )
    grip = normalize_to_grip(
        armature,
        grip_world,
        args.source,
        args.clip,
        args.frame,
        args.weapon_axis,
    )
    apply_pose_as_rest(armature, body)
    crop_report = crop_distant_forearm(body, args.forearm_reach)
    remove_everything_except(grip, armature, body)

    body.name = "Body"
    body.data.name = "Body"
    armature.name = "CharacterArmature"
    armature.data.name = "CharacterArmature"
    body["geometry_mask"] = "LowerArm.R and right finger weights only"
    body["source_vertex_count"] = source_vertices
    body["kept_vertex_count"] = kept_vertices

    report = validate_scene(
        grip, armature, body, wanted_names, args.weight_threshold
    )
    report.update(
        {
            "source": str(Path(args.source)),
            "clip": args.clip,
            "frame": args.frame,
            "weight_threshold": args.weight_threshold,
            "weapon_axis_degrees": args.weapon_axis,
        }
    )
    report.update(crop_report)
    output = Path(args.output)
    export_glb(output, grip, armature, body)
    report["output"] = str(output.resolve())
    report["file_bytes"] = output.stat().st_size
    print("NPC_VIEWMODEL_ARMS=" + json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
