#!/usr/bin/env python3
"""Render an FPS proof directly from the game's authored NPC rig.

This intentionally uses the same soldier mesh, skeleton, animation, and held
weapon hierarchy as the bots.  Body geometry is removed by vertex weights so
the camera can only see the requested forearm/hand geometry and weapon.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="assets/models/soldier_ct.glb")
    parser.add_argument("--weapon", default="assets/models/viewmodels/ak47.glb")
    parser.add_argument("--output", default="/private/tmp/tiny-strike-npc-fps-ak.png")
    parser.add_argument("--clip", default="Idle_Shoot")
    parser.add_argument("--frame", type=float, default=4.0)
    parser.add_argument("--camera-x", type=float, default=-0.04)
    parser.add_argument("--camera-y", type=float, default=-0.16)
    parser.add_argument("--camera-z", type=float, default=1.52)
    parser.add_argument("--pitch", type=float, default=-3.0)
    parser.add_argument("--yaw", type=float, default=0.0)
    parser.add_argument("--fov", type=float, default=74.0)
    parser.add_argument("--near", type=float, default=0.22)
    parser.add_argument("--weapon-scale", type=float, default=0.82)
    parser.add_argument("--weapon-axis", type=float, default=-90.0)
    parser.add_argument("--rig-x", type=float, default=0.0)
    parser.add_argument("--rig-y", type=float, default=0.0)
    parser.add_argument("--rig-z", type=float, default=0.0)
    parser.add_argument("--rig-yaw", type=float, default=0.0)
    parser.add_argument("--rig-pitch", type=float, default=0.0)
    parser.add_argument("--rig-roll", type=float, default=0.0)
    parser.add_argument("--keep-left", action="store_true")
    return parser.parse_args(argv)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.armatures,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def set_pose(armature: bpy.types.Object, clip_name: str, frame: float) -> None:
    action = bpy.data.actions.get(clip_name)
    if action is None:
        raise RuntimeError(f"NPC clip not found: {clip_name}")
    if armature.animation_data is None:
        armature.animation_data_create()
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    armature.animation_data.action = action
    bpy.context.scene.frame_set(int(frame), subframe=frame % 1.0)
    bpy.context.view_layer.update()


def isolate_weighted_arms(body: bpy.types.Object, keep_left: bool) -> None:
    suffixes = [".R"] + ([".L"] if keep_left else [])
    wanted_names = {
        group.name
        for group in body.vertex_groups
        if any(group.name.endswith(suffix) for suffix in suffixes)
        and (
            group.name.startswith("LowerArm")
            or group.name.startswith("Pinky")
            or group.name.startswith("Middle")
            or group.name.startswith("Index")
            or group.name.startswith("Thumb")
        )
    }
    wanted = {body.vertex_groups[name].index for name in wanted_names}
    keep_indices: set[int] = set()
    for vertex in body.data.vertices:
        influence = sum(
            membership.weight
            for membership in vertex.groups
            if membership.group in wanted
        )
        if influence >= 0.20:
            keep_indices.add(vertex.index)

    mesh = body.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    remove = [vertex for vertex in bm.verts if vertex.index not in keep_indices]
    bmesh.ops.delete(bm, geom=remove, context="VERTS")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def hide_non_viewmodel_objects(body: bpy.types.Object) -> None:
    allowed = {body.name, "CharacterArmature"}
    for obj in bpy.context.scene.objects:
        if obj.name not in allowed:
            obj.hide_render = True
    for weapon_name in ("Pistol", "SMG", "Sniper"):
        weapon = bpy.data.objects.get(weapon_name)
        if weapon is not None:
            weapon.hide_render = True


def attach_external_weapon(
    path: Path,
    armature: bpy.types.Object,
    source_weapon: bpy.types.Object,
    scale: float,
    axis_degrees: float,
) -> bpy.types.Object:
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(path.resolve()))
    imported = [obj for obj in bpy.context.scene.objects if obj not in before]
    imported_set = set(imported)

    root = bpy.data.objects.new("NPC_FPS_WeaponSocket", None)
    bpy.context.collection.objects.link(root)
    root.parent = armature
    root.parent_type = "BONE"
    root.parent_bone = "Index1.R"
    root.location = source_weapon.location.copy()
    root.rotation_mode = "QUATERNION"
    correction = Euler((0.0, 0.0, math.radians(axis_degrees)), "XYZ").to_quaternion()
    root.rotation_quaternion = source_weapon.rotation_quaternion @ correction
    root.scale = (scale, scale, scale)

    for obj in imported:
        if obj.parent in imported_set:
            continue
        obj.parent = root
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_basis = Matrix.Identity(4)
        if obj.type == "MESH":
            obj.hide_render = False
            for polygon in obj.data.polygons:
                polygon.use_smooth = False

    source_weapon.hide_render = True
    return root


def orient_fps_rig(
    armature: bpy.types.Object,
    offset: Vector,
    yaw_degrees: float,
    pitch_degrees: float,
    roll_degrees: float,
) -> bpy.types.Object:
    head = armature.matrix_world @ armature.pose.bones["Head"].head
    rotation = Euler((
        math.radians(pitch_degrees),
        math.radians(roll_degrees),
        math.radians(yaw_degrees),
    ), "XYZ").to_matrix().to_4x4()
    transform = (
        Matrix.Translation(head + offset)
        @ rotation
        @ Matrix.Translation(-head)
    )
    armature.matrix_world = transform @ armature.matrix_world
    bpy.context.view_layer.update()
    return armature


def look_direction(yaw_deg: float, pitch_deg: float) -> Vector:
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    return Vector((
        math.sin(yaw) * math.cos(pitch),
        -math.cos(yaw) * math.cos(pitch),
        math.sin(pitch),
    ))


def make_material(name: str, color: tuple[float, float, float, float], roughness: float) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    return material


def add_environment() -> None:
    floor_mat = make_material("FPS_Floor", (0.075, 0.082, 0.072, 1.0), 0.9)
    wall_mat = make_material("FPS_Wall", (0.19, 0.17, 0.14, 1.0), 0.88)

    bpy.ops.mesh.primitive_plane_add(size=30.0, location=(0.0, -7.0, 0.0))
    floor = bpy.context.object
    floor.name = "FPS_Environment_Floor"
    floor.data.materials.append(floor_mat)

    bpy.ops.mesh.primitive_plane_add(
        size=20.0,
        location=(0.0, -8.0, 4.0),
        rotation=(math.pi / 2.0, 0.0, 0.0),
    )
    wall = bpy.context.object
    wall.name = "FPS_Environment_Wall"
    wall.data.materials.append(wall_mat)

    bpy.ops.object.light_add(type="AREA", location=(-1.8, -1.3, 3.5))
    key = bpy.context.object
    key.name = "FPS_Key"
    key.data.energy = 430.0
    key.data.shape = "DISK"
    key.data.size = 3.0
    key.rotation_euler = ((Vector((0.0, -1.4, 1.2)) - key.location).to_track_quat("-Z", "Y").to_euler())

    bpy.ops.object.light_add(type="AREA", location=(2.4, -3.5, 2.2))
    fill = bpy.context.object
    fill.name = "FPS_Fill"
    fill.data.energy = 210.0
    fill.data.color = (0.55, 0.68, 1.0)
    fill.data.size = 2.4
    fill.rotation_euler = ((Vector((0.0, -1.8, 1.35)) - fill.location).to_track_quat("-Z", "Y").to_euler())

    # Environment geometry/lights are created after the character visibility
    # pass, so they remain visible while all non-viewmodel NPC pieces stay out.


def configure_render(output: Path) -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(output.resolve())
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.world.color = (0.008, 0.011, 0.014)


def main() -> None:
    args = parse_args()
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(Path(args.model).resolve()))

    armature = bpy.data.objects.get("CharacterArmature")
    body = bpy.data.objects.get("Body")
    if armature is None or body is None:
        raise RuntimeError("Expected CharacterArmature and Body in NPC GLB")
    set_pose(armature, args.clip, args.frame)
    isolate_weighted_arms(body, args.keep_left)
    hide_non_viewmodel_objects(body)
    source_weapon = bpy.data.objects.get("AK")
    if source_weapon is None:
        raise RuntimeError("Expected the NPC's authored AK grip reference")
    attach_external_weapon(
        Path(args.weapon),
        armature,
        source_weapon,
        args.weapon_scale,
        args.weapon_axis,
    )
    orient_fps_rig(
        armature,
        Vector((args.rig_x, args.rig_y, args.rig_z)),
        args.rig_yaw,
        args.rig_pitch,
        args.rig_roll,
    )

    bpy.ops.object.camera_add(location=(args.camera_x, args.camera_y, args.camera_z))
    camera = bpy.context.object
    camera.name = "FPS_Approval_Camera"
    camera.data.type = "PERSP"
    camera.data.angle = math.radians(args.fov)
    camera.data.clip_start = args.near
    camera.data.clip_end = 100.0
    direction = look_direction(args.yaw, args.pitch)
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = camera

    add_environment()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    configure_render(output)
    bpy.ops.render.render(write_still=True)
    print(f"NPC_FPS_APPROVAL={output.resolve()}")


if __name__ == "__main__":
    main()
