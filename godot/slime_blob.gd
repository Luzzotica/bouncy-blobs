extends Node2D
## Visual + input wrapper for a soft body simulated by [SoftBodyWorld].

const HullPresets := preload("res://soft/hull_presets.gd")
const GT := preload("res://soft/softbody_gameplay_tuning.gd")

enum HullPreset {
	CIRCLE_16,
	SQUARE,
	TRIANGLE,
	STAR,
	DIAMOND,
	HEX,
}

const BLOB_RADIUS := 48.0
## Closed hull outline (matches softbody playground non-debug draw).
const HULL_LINE_WIDTH := 2.25

const MOVE_FORCE := 5.0
## Player-only spring / shape-match multipliers on [code]softbody_gameplay_tuning[/code] (lower = softer, less asymmetric pull on the center).
const PLAYER_SPRING_K_MULT := 0.92
const PLAYER_SPRING_DAMP_MULT := 1.0
const PLAYER_RADIAL_K_MULT := 0.92
const PLAYER_RADIAL_DAMP_MULT := 1.0
const PLAYER_SHAPE_MATCH_K_MULT := 0.92
const PLAYER_SHAPE_MATCH_DAMP_MULT := 1.0
## Player-only: lower mass so spring + shape-match impulses produce higher velocity (stronger expand / ground launch). NPCs keep [code]softbody_gameplay_tuning[/code] masses.
const PLAYER_MASS_MULT := 0.5
## While expand is held: multiply edge / shear / radial spring [i, j, rest, k, damp] in [SoftBodyWorld] (see [method SoftBodyWorld.set_blob_spring_stiffness_scale]).
const EXPAND_SPRING_STIFFNESS_MULT := 1.45
## Run [method _physics_process] before [SoftBodyWorld] so spring scale applies in the same physics tick.
const PLAYER_PHYSICS_PRIORITY := -10

## When false, this blob is simulated but does not read input (for other soft bodies in the level).
@export var player_controlled: bool = true
## Rest hull shape; default 16-gon circle matches playground “Circle (16)”.
@export var hull_preset: HullPreset = HullPreset.CIRCLE_16
## While [code]expand[/code] is held (Space / mobile), shape-match rest frame scales toward this; on release it returns to [code]1.0[/code].
@export var expand_shape_scale_max: float = 3.0
## How fast the **shape-match target scale** moves toward 1.0 when you release expand ([method move_toward] units per second — not a 0–1 lerp).
@export var expand_shape_scale_speed: float = 6.75
## How fast the target scale ramps **up** while expand is held (higher = snappier / more “explosive” inflation).
@export var expand_shape_scale_speed_press: float = 36.0
@export_range(0.0, 1.0) var npc_hue: float = 0.55
## Draw wavy debug lines for every structural spring on this blob (hull, shear, radial).
@export var debug_draw_springs: bool = true

var _world: Variant
var _blob_id: int = -1
var _hull_indices: PackedInt32Array = PackedInt32Array()
var _fill_color: Color = Color.WHITE
var _expand_pressed: bool = false
var _move_input: Vector2 = Vector2.ZERO
var _expand_shape_scale: float = 1.0


func _rest_hull_local() -> PackedVector2Array:
	match hull_preset:
		HullPreset.CIRCLE_16:
			return HullPresets.circle(16, BLOB_RADIUS)
		HullPreset.SQUARE:
			return HullPresets.square(BLOB_RADIUS)
		HullPreset.TRIANGLE:
			return HullPresets.triangle(52.0)
		HullPreset.STAR:
			return HullPresets.star(5, 56.0, 22.0)
		HullPreset.DIAMOND:
			return HullPresets.diamond(BLOB_RADIUS)
		HullPreset.HEX:
			return HullPresets.circle(6, BLOB_RADIUS)
		_:
			return HullPresets.circle(16, BLOB_RADIUS)


func _ready() -> void:
	add_to_group("slime_blobs")
	_world = get_tree().get_first_node_in_group("soft_body_world")
	if _world == null:
		push_error("SoftBodyWorld not found in scene.")
		return
	var hull_local: PackedVector2Array = _rest_hull_local()
	var pk := player_controlled
	var sk: float = GT.SPRING_K * (PLAYER_SPRING_K_MULT if pk else 1.0)
	var sd: float = GT.SPRING_DAMP * (PLAYER_SPRING_DAMP_MULT if pk else 1.0)
	var rk: float = GT.RADIAL_K * (PLAYER_RADIAL_K_MULT if pk else 1.0)
	var rd: float = GT.RADIAL_DAMP * (PLAYER_RADIAL_DAMP_MULT if pk else 1.0)
	var smk: float = GT.SHAPE_MATCH_K * (PLAYER_SHAPE_MATCH_K_MULT if pk else 1.0)
	var smd: float = GT.SHAPE_MATCH_DAMP * (PLAYER_SHAPE_MATCH_DAMP_MULT if pk else 1.0)
	var cm: float = GT.CENTER_MASS * (PLAYER_MASS_MULT if pk else 1.0)
	var hm: float = GT.HULL_MASS * (PLAYER_MASS_MULT if pk else 1.0)
	var reg: Dictionary = _world.add_blob_from_hull(
		hull_local,
		Vector2.ZERO,
		cm,
		hm,
		sk,
		sd,
		rk,
		rd,
		GT.PRESSURE_K,
		smk,
		smd,
		global_position
	)
	if reg.is_empty():
		push_error("SlimeBlob: add_blob_from_hull failed.")
		return
	_blob_id = reg["blob_id"]
	_hull_indices = reg["hull_indices"]
	if player_controlled:
		var hue := fmod(float(get_multiplayer_authority()) * 0.19, 1.0)
		_fill_color = Color.from_hsv(hue, 0.52, 0.98)
	else:
		_fill_color = Color.from_hsv(npc_hue, 0.52, 0.98)
	if multiplayer.multiplayer_peer != null and not is_multiplayer_authority():
		set_physics_process(false)
	elif not player_controlled:
		set_physics_process(false)
	else:
		set_physics_process(true)
		set_physics_process_priority(PLAYER_PHYSICS_PRIORITY)
	set_process(true)


func _process(_delta: float) -> void:
	queue_redraw()
	global_position = _centroid()


func get_perimeter() -> PackedVector2Array:
	if _world == null or _blob_id < 0:
		return PackedVector2Array()
	return _world.get_hull_polygon(_blob_id)


func _centroid() -> Vector2:
	if _world == null or _hull_indices.is_empty():
		return global_position
	var pts: PackedVector2Array = _world.get_positions()
	var s := Vector2.ZERO
	for i in range(_hull_indices.size()):
		s += pts[_hull_indices[i]]
	return s / float(_hull_indices.size())


func _draw() -> void:
	if _world == null or _blob_id < 0:
		return
	var hp: PackedVector2Array = _world.get_hull_polygon(_blob_id)
	var hn: int = hp.size()
	if hn < 2:
		return
	var col: Color = _fill_color
	col.a = minf(col.a, 0.95)
	for i in range(hn):
		var j: int = (i + 1) % hn
		draw_line(to_local(hp[i]), to_local(hp[j]), col, HULL_LINE_WIDTH)
	if debug_draw_springs:
		_draw_debug_springs_squiggly()


func _draw_debug_springs_squiggly() -> void:
	var rng: Vector2i = _world.get_blob_mass_point_index_range(_blob_id)
	var lo: int = rng.x
	var hi: int = rng.y
	if lo < 0 or hi <= lo:
		return
	var pts: PackedVector2Array = _world.get_positions()
	var pairs: Array = _world.get_spring_index_pairs()
	var dbg := Color(0.55, 0.95, 1.0, 0.55)
	var w: float = 1.25
	for p in pairs:
		var ia: int = int(p[0])
		var ib: int = int(p[1])
		if ia < lo or ib < lo or ia >= hi or ib >= hi:
			continue
		if ia >= pts.size() or ib >= pts.size():
			continue
		_draw_squiggly_line_world(pts[ia], pts[ib], dbg, w)


func _draw_squiggly_line_world(a_world: Vector2, b_world: Vector2, color: Color, width: float) -> void:
	var a: Vector2 = to_local(a_world)
	var b: Vector2 = to_local(b_world)
	var d: Vector2 = b - a
	var len: float = d.length()
	if len < 0.5:
		return
	var tang: Vector2 = d / len
	var n: Vector2 = Vector2(-tang.y, tang.x)
	var amp: float = clampf(len * 0.06, 2.0, 10.0)
	var waves: float = 3.5
	var segs: int = maxi(8, int(len / 14.0))
	for i in range(segs):
		var t0: float = float(i) / float(segs)
		var t1: float = float(i + 1) / float(segs)
		var p0: Vector2 = a + d * t0 + n * sin(t0 * TAU * waves) * amp
		var p1: Vector2 = a + d * t1 + n * sin(t1 * TAU * waves) * amp
		draw_line(p0, p1, color, width)


func _physics_process(_delta: float) -> void:
	if not player_controlled:
		return
	if _world == null or _blob_id < 0:
		return
	if multiplayer.multiplayer_peer != null and not is_multiplayer_authority():
		return
	_gather_input()
	var expand_spring_mult: float = (
		EXPAND_SPRING_STIFFNESS_MULT if _expand_pressed else 1.0
	)
	_world.set_blob_spring_stiffness_scale(_blob_id, expand_spring_mult)
	_world.apply_blob_move_force(_blob_id, _move_input, MOVE_FORCE)
	var target_shape_scale: float = (
		expand_shape_scale_max if _expand_pressed else 1.0
	)
	var ramp_rate: float = (
		expand_shape_scale_speed_press
		if target_shape_scale > _expand_shape_scale
		else expand_shape_scale_speed
	)
	_expand_shape_scale = move_toward(
		_expand_shape_scale,
		target_shape_scale,
		ramp_rate * _delta
	)
	_world.set_blob_shape_match_rest_scale(_blob_id, _expand_shape_scale)
	var pts: PackedVector2Array = _world.get_positions()
	var positions := PackedVector2Array()
	positions.resize(_hull_indices.size())
	for i in range(_hull_indices.size()):
		positions[i] = pts[_hull_indices[i]]
	if multiplayer.multiplayer_peer != null:
		sync_points.rpc(positions)


func _gather_input() -> void:
	var x := Input.get_axis(&"move_left", &"move_right")
	_move_input = Vector2(x, 0.0)
	if MobileInput.stick.length_squared() > 0.0001:
		_move_input = Vector2(MobileInput.stick.x, 0.0)
	if absf(_move_input.x) > 1.0:
		_move_input.x = signf(_move_input.x)
	_expand_pressed = Input.is_action_pressed(&"expand") or MobileInput.expand_pressed


@rpc("authority", "unreliable")
func sync_points(positions: PackedVector2Array) -> void:
	if multiplayer.multiplayer_peer == null or _world == null or _blob_id < 0:
		return
	if positions.size() != _hull_indices.size():
		return
	_world.set_hull_positions(_blob_id, positions)
