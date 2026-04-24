class_name SoftBodyWorld
extends Node2D
## Custom soft-body simulation: point masses, springs, shape matching, pressure, constraints,
## jelly-style collisions, triggers, and ray queries.

const CollisionSoft := preload("res://soft/collision_soft.gd")
const ConstraintsSoft := preload("res://soft/constraints_soft.gd")
const ShapeMatching := preload("res://soft/shape_matching.gd")

signal trigger_entered(trigger_shape_idx: int, blob_id: int)
signal trigger_exited(trigger_shape_idx: int, blob_id: int)

const COLLISION_MARGIN := 1.5
const COLLISION_RESTITUTION := 0.25
const CONSTRAINT_ITERS := 8

## Bounce against [method register_static_polygon] geometry.
@export var static_restitution: float = 0.0
## Max distance from [method CollisionSoft.closest_point_on_polygon_boundary] for a hull point that is
## **outside** the static polygon to still count as touching.
@export var static_contact_slop: float = 14.0
## Coulomb friction: hull point vs other blob’s hull edge ([method _resolve_point_in_shape]).
@export var blob_blob_friction_mu: float = 1.44
## Scales tangential impulse for blob–blob contacts (below 1.0 softens jitter if needed).
@export var blob_blob_friction_impulse_scale: float = 1.0
## Coulomb friction: hull point vs [method register_static_polygon] edges (uses normal impulse + gravity load).
@export var static_edge_friction_mu: float = 1.64
## Skip static tangential impulse when tangential speed is below this (very small = almost always apply).
@export var static_friction_min_tangential_speed: float = 0.06
## Multiplier on gravity-based normal load used for static friction cap (was effectively ~0.08 before; keep near 1).
@export var static_friction_normal_load_scale: float = 2.0

## Exponential velocity damping: each substep applies [code]v *= exp(-k * dt)[/code] with this [param k]
## (1/s). Larger = stronger drag; scales correctly with [member fixed_dt] and [member substeps].
@export var hull_vertex_damping_per_sec: float = 0.012
@export var center_hull_damping_per_sec: float = 0.004
## Do not damp hull vertices moving faster than this (reduces fake terminal velocity in air).
@export var hull_damp_skip_above_speed: float = 220.0

## Filled from Project Settings in _ready() unless [member sync_gravity_from_project] is false.
@export var gravity: Vector2 = Vector2(0, 980.0)
@export var sync_gravity_from_project: bool = true
## Multiplies project gravity when [member sync_gravity_from_project] is true (does not affect manual [member gravity] when sync is off).
@export var gravity_scale: float = 4.0
@export var fixed_dt: float = 1.0 / 60.0
@export var substeps: int = 2

var _pos: PackedVector2Array = PackedVector2Array()
var _vel: PackedVector2Array = PackedVector2Array()
var _mass: PackedFloat32Array = PackedFloat32Array()
var _inv_mass: PackedFloat32Array = PackedFloat32Array()
var _particle_radius: PackedFloat32Array = PackedFloat32Array()

var _springs: Array = [] # [i, j, rest, k_base, damp_base]

## Shape dict: indices, static_poly, is_trigger, is_static, target_rest_area, pressure_k,
## shape_match_k, shape_match_damp, rest_local, shape_match_rest_scale, use_frame_override, frame_override,
## trigger_gravity (optional Vector2 for gravity zones)
var _shapes: Array = []

var _static_polygons: Array[PackedVector2Array] = []

var _welds: Array = [] # [i, j]
var _anchors: Array = [] # dict with indices_a, weights_a, indices_b, weights_b
var _distance_max: Array = [] # [i, j, max_dist]

var _blob_ranges: Array = [] # { "id": int, "start": int, "end": int, "hull": PackedInt32Array, "shape_idx": int }

var _trigger_prev: Dictionary = {} # Vector2i(shape_idx, blob_shape_idx) -> bool

var _scratch_poly: PackedVector2Array = PackedVector2Array()

var _time_accum: float = 0.0


func _ready() -> void:
	add_to_group("soft_body_world")
	set_physics_process(true)
	if sync_gravity_from_project:
		_sync_gravity_from_project()


func _sync_gravity_from_project() -> void:
	var strength: float = float(ProjectSettings.get_setting("physics/2d/default_gravity", 980.0))
	var direction: Vector2 = ProjectSettings.get_setting("physics/2d/default_gravity_vector", Vector2(0, 1))
	gravity = strength * direction * gravity_scale


## Call after changing [member gravity_scale] at runtime so [member gravity] matches project settings.
func sync_gravity_from_project_settings() -> void:
	if sync_gravity_from_project:
		_sync_gravity_from_project()


func register_static_polygon(poly: PackedVector2Array) -> void:
	_static_polygons.append(poly)


func clear_static_polygons() -> void:
	_static_polygons.clear()


func register_trigger_polygon(poly: PackedVector2Array, gravity_override: Vector2 = Vector2.ZERO) -> int:
	var d := {
		"indices": PackedInt32Array(),
		"static_poly": poly.duplicate(),
		"is_trigger": true,
		"is_static": true,
		"target_rest_area": 0.0,
		"pressure_k": 0.0,
		"shape_match_k": 0.0,
		"shape_match_damp": 0.0,
		"rest_local": PackedVector2Array(),
		"shape_match_rest_scale": 1.0,
		"use_frame_override": false,
		"frame_override": Transform2D.IDENTITY,
		"trigger_gravity": gravity_override,
	}
	_shapes.append(d)
	return _shapes.size() - 1


func add_blob(
		center_local: Vector2,
		num_hull: int,
		blob_radius: float,
		center_mass: float,
		hull_mass: float,
		spring_k: float,
		spring_damp: float,
		radial_k: float,
		radial_damp: float,
		pressure_k: float,
		shape_match_k: float,
		shape_match_damp: float,
		world_origin: Vector2
	) -> Dictionary:
	var start := _pos.size()
	# Point 0 = center, 1..num_hull = hull
	_pos.append(center_local + world_origin)
	_vel.append(Vector2.ZERO)
	_mass.append(center_mass)
	_inv_mass.append(1.0 / center_mass if center_mass > 0.001 else 0.0)
	_particle_radius.append(0.0)

	var hull_indices := PackedInt32Array()
	for i in range(num_hull):
		var angle := TAU * float(i) / float(num_hull)
		var offset := Vector2(cos(angle), sin(angle)) * blob_radius
		_pos.append(center_local + offset + world_origin)
		_vel.append(Vector2.ZERO)
		_mass.append(hull_mass)
		_inv_mass.append(1.0 / hull_mass if hull_mass > 0.001 else 0.0)
		_particle_radius.append(0.0)
		hull_indices.append(start + 1 + i)

	var spring_begin := _springs.size()
	for i in range(num_hull):
		var j_next := (i + 1) % num_hull
		var ia := start + 1 + i
		var ib := start + 1 + j_next
		var rest := _pos[ia].distance_to(_pos[ib])
		_springs.append([ia, ib, rest, spring_k, spring_damp])

	for i in range(num_hull):
		var j_skip := (i + 2) % num_hull
		var ia := start + 1 + i
		var ib := start + 1 + j_skip
		var rest := _pos[ia].distance_to(_pos[ib])
		_springs.append([ia, ib, rest, spring_k * 0.85, spring_damp])

	for i in range(num_hull):
		var ip := start + 1 + i
		var rest_r := blob_radius
		_springs.append([start, ip, rest_r, radial_k, radial_damp])
	var spring_end := _springs.size()

	var rest_local := PackedVector2Array()
	rest_local.resize(num_hull)
	for i in range(num_hull):
		var angle := TAU * float(i) / float(num_hull)
		rest_local[i] = Vector2(cos(angle), sin(angle)) * blob_radius

	var target_area := absf(CollisionSoft.signed_area_polygon(_build_polygon_from_indices(hull_indices)))
	var shape_dict := {
		"indices": hull_indices,
		"static_poly": PackedVector2Array(),
		"is_trigger": false,
		"is_static": false,
		"target_rest_area": target_area,
		"pressure_k": pressure_k,
		"shape_match_k": shape_match_k,
		"shape_match_damp": shape_match_damp,
		"rest_local": rest_local,
		"shape_match_rest_scale": 1.0,
		"use_frame_override": false,
		"frame_override": Transform2D.IDENTITY,
		"trigger_gravity": Vector2.ZERO,
		"center_idx": start,
	}
	_shapes.append(shape_dict)
	var shape_idx := _shapes.size() - 1

	_blob_ranges.append({
		"id": _blob_ranges.size(),
		"start": start,
		"end": _pos.size(),
		"hull": hull_indices,
		"shape_idx": shape_idx,
		"spring_begin": spring_begin,
		"spring_end": spring_end,
		"spring_stiffness_scale": 1.0,
		"spring_damp_scale": 1.0,
	})

	return {
		"start": start,
		"center_idx": start,
		"hull_indices": hull_indices,
		"shape_idx": shape_idx,
		"blob_id": _blob_ranges.size() - 1,
	}


## Arbitrary closed polygon hull (CCW), center mass at [param center_local]. Rest lengths from layout.
func add_blob_from_hull(
		hull_rest_local: PackedVector2Array,
		center_local: Vector2,
		center_mass: float,
		hull_mass: float,
		spring_k: float,
		spring_damp: float,
		radial_k: float,
		radial_damp: float,
		pressure_k: float,
		shape_match_k: float,
		shape_match_damp: float,
		world_origin: Vector2
	) -> Dictionary:
	var num_hull := hull_rest_local.size()
	if num_hull < 3:
		push_error("add_blob_from_hull: need at least 3 hull points.")
		return {}

	var start := _pos.size()
	_pos.append(center_local + world_origin)
	_vel.append(Vector2.ZERO)
	_mass.append(center_mass)
	_inv_mass.append(1.0 / center_mass if center_mass > 0.001 else 0.0)
	_particle_radius.append(0.0)

	var hull_indices := PackedInt32Array()
	for i in range(num_hull):
		_pos.append(hull_rest_local[i] + world_origin)
		_vel.append(Vector2.ZERO)
		_mass.append(hull_mass)
		_inv_mass.append(1.0 / hull_mass if hull_mass > 0.001 else 0.0)
		_particle_radius.append(0.0)
		hull_indices.append(start + 1 + i)

	var spring_begin := _springs.size()
	for i in range(num_hull):
		var j_next := (i + 1) % num_hull
		var ia := start + 1 + i
		var ib := start + 1 + j_next
		var rest_e := _pos[ia].distance_to(_pos[ib])
		_springs.append([ia, ib, rest_e, spring_k, spring_damp])

	if num_hull >= 4:
		for i in range(num_hull):
			var j_skip := (i + 2) % num_hull
			var ia := start + 1 + i
			var ib := start + 1 + j_skip
			var rest_s := _pos[ia].distance_to(_pos[ib])
			_springs.append([ia, ib, rest_s, spring_k * 0.85, spring_damp])

	for i in range(num_hull):
		var ip := start + 1 + i
		var rest_r := center_local.distance_to(hull_rest_local[i])
		if rest_r < 0.001:
			rest_r = 0.001
		_springs.append([start, ip, rest_r, radial_k, radial_damp])
	var spring_end := _springs.size()

	var rest_local := hull_rest_local.duplicate()
	var target_area := absf(CollisionSoft.signed_area_polygon(_build_polygon_from_indices(hull_indices)))
	var shape_dict := {
		"indices": hull_indices,
		"static_poly": PackedVector2Array(),
		"is_trigger": false,
		"is_static": false,
		"target_rest_area": target_area,
		"pressure_k": pressure_k,
		"shape_match_k": shape_match_k,
		"shape_match_damp": shape_match_damp,
		"rest_local": rest_local,
		"shape_match_rest_scale": 1.0,
		"use_frame_override": false,
		"frame_override": Transform2D.IDENTITY,
		"trigger_gravity": Vector2.ZERO,
		"center_idx": start,
	}
	_shapes.append(shape_dict)
	var shape_idx := _shapes.size() - 1

	_blob_ranges.append({
		"id": _blob_ranges.size(),
		"start": start,
		"end": _pos.size(),
		"hull": hull_indices,
		"shape_idx": shape_idx,
		"spring_begin": spring_begin,
		"spring_end": spring_end,
		"spring_stiffness_scale": 1.0,
		"spring_damp_scale": 1.0,
	})

	return {
		"start": start,
		"center_idx": start,
		"hull_indices": hull_indices,
		"shape_idx": shape_idx,
		"blob_id": _blob_ranges.size() - 1,
	}


## Scales hull edge, shear, and radial spring stiffness for one blob (base [i, j, rest, k, damp] from [method add_blob] / [method add_blob_from_hull]).
## Use while expanding for a snappier launch. [param damp_scale] &lt; 0 uses [code]sqrt(stiffness_scale)[/code] for damping.
func set_blob_spring_stiffness_scale(blob_id: int, stiffness_scale: float, damp_scale: float = -1.0) -> void:
	if blob_id < 0 or blob_id >= _blob_ranges.size():
		return
	var r: Dictionary = _blob_ranges[blob_id]
	var ss: float = clampf(stiffness_scale, 0.2, 4.0)
	var ds: float = damp_scale
	if ds < 0.0:
		ds = sqrt(ss)
	else:
		ds = clampf(ds, 0.2, 4.0)
	r["spring_stiffness_scale"] = ss
	r["spring_damp_scale"] = ds


## Clears dynamic bodies; keeps static collision, trigger volumes ([method register_trigger_polygon]), and their [member _shapes] entries.
func clear_simulation() -> void:
	_pos.clear()
	_vel.clear()
	_mass.clear()
	_inv_mass.clear()
	_particle_radius.clear()
	_springs.clear()
	var kept_shapes: Array = []
	for sh in _shapes:
		if sh.get("is_trigger", false):
			kept_shapes.append(sh)
	_shapes = kept_shapes
	_blob_ranges.clear()
	_welds.clear()
	_anchors.clear()
	_distance_max.clear()
	_trigger_prev.clear()
	_scratch_poly.clear()
	_time_accum = 0.0


## Pairs of point indices for each spring (for debug draw).
func get_spring_index_pairs() -> Array:
	var out: Array = []
	for s in _springs:
		out.append([s[0], s[1]])
	return out


func add_weld(i: int, j: int) -> void:
	_welds.append([i, j])


func add_weighted_anchor(
		indices_a: PackedInt32Array,
		weights_a: PackedFloat32Array,
		indices_b: PackedInt32Array,
		weights_b: PackedFloat32Array
	) -> void:
	_anchors.append({
		"indices_a": indices_a,
		"weights_a": weights_a,
		"indices_b": indices_b,
		"weights_b": weights_b,
	})


func add_distance_max(i: int, j: int, max_dist: float) -> void:
	_distance_max.append([i, j, max_dist])


func add_particle(pos: Vector2, vel: Vector2, mass: float, radius: float) -> int:
	var idx := _pos.size()
	_pos.append(pos)
	_vel.append(vel)
	_mass.append(mass)
	_inv_mass.append(1.0 / mass if mass > 0.001 else 0.0)
	_particle_radius.append(radius)
	return idx


func get_point_count() -> int:
	return _pos.size()


func get_positions() -> PackedVector2Array:
	return _pos


func get_velocities() -> PackedVector2Array:
	return _vel.duplicate()


func set_hull_positions(blob_id: int, hull_positions: PackedVector2Array) -> void:
	if blob_id < 0 or blob_id >= _blob_ranges.size():
		return
	var r: Dictionary = _blob_ranges[blob_id]
	var hull: PackedInt32Array = r["hull"]
	if hull_positions.size() != hull.size():
		return
	var c := Vector2.ZERO
	for i in range(hull.size()):
		var idx := hull[i]
		_pos[idx] = hull_positions[i]
		c += hull_positions[i]
	c /= float(hull.size())
	var ci: int = r["start"]
	_pos[ci] = c
	for j in range(r["start"], r["end"]):
		_vel[j] = Vector2.ZERO


func get_hull_polygon(blob_id: int) -> PackedVector2Array:
	if blob_id < 0 or blob_id >= _blob_ranges.size():
		return PackedVector2Array()
	var hull: PackedInt32Array = _blob_ranges[blob_id]["hull"]
	return _build_polygon_from_indices(hull)


func get_blob_center_point_index(blob_id: int) -> int:
	if blob_id < 0 or blob_id >= _blob_ranges.size():
		return -1
	return int(_blob_ranges[blob_id]["start"])


func get_blob_count() -> int:
	return _blob_ranges.size()


## Inclusive start, exclusive end indices into [method get_positions] for all mass points in [param blob_id].
func get_blob_mass_point_index_range(blob_id: int) -> Vector2i:
	if blob_id < 0 or blob_id >= _blob_ranges.size():
		return Vector2i(-1, -1)
	var r: Dictionary = _blob_ranges[blob_id]
	return Vector2i(int(r["start"]), int(r["end"]))


func ray_cast(origin: Vector2, dir: Vector2, max_dist: float) -> Dictionary:
	var best_t := INF
	var best_normal := Vector2.UP
	var hit := false
	var end := origin + dir.normalized() * max_dist
	for poly in _static_polygons:
		var n := poly.size()
		for i in range(n):
			var a := poly[i]
			var b := poly[(i + 1) % n]
			var inter: Variant = Geometry2D.segment_intersects_segment(origin, end, a, b)
			if inter == null:
				continue
			var inter_pt: Vector2 = inter as Vector2
			var t := origin.distance_to(inter_pt)
			if t < best_t:
				best_t = t
				var edge := b - a
				var nn := Vector2(edge.y, -edge.x).normalized()
				if nn.dot(dir) > 0.0:
					nn = -nn
				best_normal = nn
				hit = true
	return {"hit": hit, "distance": best_t, "position": origin + dir.normalized() * best_t if hit else end, "normal": best_normal}


func apply_external_force_point(i: int, f: Vector2) -> void:
	if i < 0 or i >= _vel.size():
		return
	_vel[i] += f * _inv_mass[i]


func apply_blob_move_force(blob_id: int, move: Vector2, force: float) -> void:
	if blob_id < 0 or blob_id >= _blob_ranges.size():
		return
	var r: Dictionary = _blob_ranges[blob_id]
	var f := move * force
	for i in range(r["start"], r["end"]):
		_vel[i] += f * _inv_mass[i]


## Adds the same world-space delta velocity to every mass point in the blob (pure translation).
func apply_blob_linear_velocity_delta(blob_id: int, delta_v: Vector2) -> void:
	if blob_id < 0 or blob_id >= _blob_ranges.size():
		return
	if delta_v.length_squared() < 1e-12:
		return
	var r: Dictionary = _blob_ranges[blob_id]
	for i in range(r["start"], r["end"]):
		_vel[i] += delta_v


## Effective pressure / area target for a soft shape: [member target_rest_area] × scale² when
## [member shape_match_rest_scale] enlarges the shape-matching rest frame.
func shape_pressure_target_area(shape_idx: int) -> float:
	if shape_idx < 0 or shape_idx >= _shapes.size():
		return 0.0
	var sh: Dictionary = _shapes[shape_idx]
	var base_t: float = float(sh.get("target_rest_area", 0.0))
	var sc: float = maxf(float(sh.get("shape_match_rest_scale", 1.0)), 0.05)
	return maxf(base_t * sc * sc, 1e-6)


## Scales shape-matching rest positions (and pressure target area) for this blob. [code]1.0[/code] = default layout.
## Clamped to [code][0.35, 3.5][/code]. Use while “expanding” so the body pushes to a larger target silhouette.
func set_blob_shape_match_rest_scale(blob_id: int, scale: float) -> void:
	if blob_id < 0 or blob_id >= _blob_ranges.size():
		return
	var si: int = int(_blob_ranges[blob_id]["shape_idx"])
	if si < 0 or si >= _shapes.size():
		return
	var sh: Dictionary = _shapes[si]
	if sh.get("is_static", false) or sh.get("is_trigger", false):
		return
	var s: float = clampf(scale, 0.35, 3.5)
	sh["shape_match_rest_scale"] = s


## Returns blob index containing mass point [param point_idx], or [code]-1[/code].
func get_blob_id_for_point_index(point_idx: int) -> int:
	if point_idx < 0:
		return -1
	for bi in range(_blob_ranges.size()):
		var r: Dictionary = _blob_ranges[bi]
		if point_idx >= int(r["start"]) and point_idx < int(r["end"]):
			return bi
	return -1


## Per-edge pump data matching [method apply_blob_expand]: outward normal and scalar impulse budget
## [param impulse] (before per-particle [code]inv_mass[/code] scaling).
func get_blob_pump_edge_impulses(blob_id: int, expand_force: float) -> Array:
	return _blob_pump_edge_impulses(blob_id, expand_force)


func _blob_pump_edge_impulses(blob_id: int, expand_force: float) -> Array:
	var out: Array = []
	if blob_id < 0 or blob_id >= _blob_ranges.size():
		return out
	var r: Dictionary = _blob_ranges[blob_id]
	var ci: int = int(r["start"])
	var c: Vector2 = _pos[ci]
	var hull: PackedInt32Array = r["hull"]
	var nh: int = hull.size()
	if nh < 3:
		return out
	var perim: float = 0.0
	for k in range(nh):
		var kn: int = (k + 1) % nh
		perim += _pos[hull[k]].distance_to(_pos[hull[kn]])
	if perim < 1e-6:
		return out
	var pmul: float = _blob_pump_pressure_multiplier(blob_id)
	var base: float = expand_force * pmul * (float(nh) * 0.5)
	for k in range(nh):
		var i0: int = hull[k]
		var i1: int = hull[(k + 1) % nh]
		var a: Vector2 = _pos[i0]
		var b: Vector2 = _pos[i1]
		var ed: Vector2 = b - a
		var el: float = ed.length()
		if el < 1e-6:
			continue
		var mid: Vector2 = (a + b) * 0.5
		var n_out: Vector2 = Vector2(-ed.y, ed.x)
		if n_out.dot(c - mid) > 0.0:
			n_out = -n_out
		n_out = n_out.normalized()
		var impulse_edge: float = base * (el / perim)
		out.append({
			"i0": i0,
			"i1": i1,
			"mid": mid,
			"normal": n_out,
			"impulse": impulse_edge,
		})
	return out


## Inflate the blob by applying impulse along each hull edge's outward normal (pressure pump).
## Strength scales with area error and the blob's pressure_k; see _blob_pump_pressure_multiplier.
func apply_blob_expand(blob_id: int, expand_force: float) -> void:
	for e in _blob_pump_edge_impulses(blob_id, expand_force):
		var i0: int = int(e["i0"])
		var i1: int = int(e["i1"])
		var n_out: Vector2 = e["normal"]
		var impulse_edge: float = float(e["impulse"])
		_vel[i0] += n_out * impulse_edge * _inv_mass[i0]
		_vel[i1] += n_out * impulse_edge * _inv_mass[i1]


## World-space target hull from shape matching ([method _apply_shape_matching]).
## Empty when the blob has no active shape matching.
func get_blob_shape_match_target_hull(blob_id: int) -> PackedVector2Array:
	if blob_id < 0 or blob_id >= _blob_ranges.size():
		return PackedVector2Array()
	var si: int = int(_blob_ranges[blob_id]["shape_idx"])
	if si < 0 or si >= _shapes.size():
		return PackedVector2Array()
	var sh: Dictionary = _shapes[si]
	if sh.get("is_static", false) or sh.get("is_trigger", false):
		return PackedVector2Array()
	var smk: float = float(sh.get("shape_match_k", 0.0))
	if smk <= 0.0:
		return PackedVector2Array()
	var idx: PackedInt32Array = sh["indices"]
	var rest_local: PackedVector2Array = sh["rest_local"]
	if idx.size() != rest_local.size() or idx.is_empty():
		return PackedVector2Array()
	var center: Vector2
	var angle: float
	if sh.get("use_frame_override", false):
		var fr: Transform2D = sh["frame_override"]
		center = fr.origin
		angle = fr.get_rotation()
	else:
		center = ShapeMatching.centroid_from_indices(_pos, idx)
		angle = ShapeMatching.average_angle(rest_local, _pos, idx, center)
	var frame: Transform2D = ShapeMatching.frame_transform(center, angle)
	var sm_scale: float = maxf(float(sh.get("shape_match_rest_scale", 1.0)), 0.05)
	var poly := PackedVector2Array()
	poly.resize(idx.size())
	for k in range(idx.size()):
		poly[k] = frame * (rest_local[k] * sm_scale)
	return poly


func _blob_pump_pressure_multiplier(blob_id: int) -> float:
	var r: Dictionary = _blob_ranges[blob_id]
	var si: int = int(r["shape_idx"])
	if si < 0 or si >= _shapes.size():
		return 1.0
	var sh: Dictionary = _shapes[si]
	var pk: float = float(sh.get("pressure_k", 0.0))
	var idx: PackedInt32Array = sh["indices"]
	if idx.size() < 3:
		return 1.0
	_scratch_poly = _build_polygon_from_indices(idx)
	var area: float = CollisionSoft.signed_area_polygon(_scratch_poly)
	var target: float = shape_pressure_target_area(si)
	var err: float = absf(target - area)
	var denom: float = maxf(absf(target), 1.0)
	return 1.0 + pk * err / denom


func _physics_process(delta: float) -> void:
	_time_accum += delta
	var g := gravity
	while _time_accum >= fixed_dt:
		_time_accum -= fixed_dt
		for _s in range(substeps):
			_substep(g)


func _substep(g: Vector2) -> void:
	var dt := fixed_dt / float(substeps)
	var n := _pos.size()
	if n == 0:
		return

	# Gravity + per-blob trigger gravity
	var grav := PackedVector2Array()
	grav.resize(n)
	for i in range(n):
		grav[i] = g

	for bi in range(_blob_ranges.size()):
		var r: Dictionary = _blob_ranges[bi]
		var cx: Vector2 = ShapeMatching.centroid_from_indices(_pos, r["hull"])
		for si in range(_shapes.size()):
			var sh: Dictionary = _shapes[si]
			if not sh.get("is_trigger", false):
				continue
			var tp: PackedVector2Array = sh["static_poly"]
			if tp.is_empty():
				continue
			if CollisionSoft.is_point_in_polygon(cx, tp):
				var og: Vector2 = sh.get("trigger_gravity", Vector2.ZERO)
				if og.length_squared() > 0.0001:
					for j in range(r["start"], r["end"]):
						grav[j] = og

	for i in range(n):
		_vel[i] += grav[i] * dt

	_apply_springs(dt)
	_apply_pressure(dt)
	_apply_shape_matching(dt)

	# Semi-implicit Euler: velocities were updated above; advance positions.
	for i in range(n):
		_pos[i] += _vel[i] * dt

	for _it in range(CONSTRAINT_ITERS):
		for w in _welds:
			ConstraintsSoft.solve_weld(_pos, _inv_mass, w[0], w[1])
		for a in _anchors:
			ConstraintsSoft.solve_weighted_anchor(
				_pos,
				_inv_mass,
				a["indices_a"],
				a["weights_a"],
				a["indices_b"],
				a["weights_b"]
			)
		for d in _distance_max:
			ConstraintsSoft.solve_distance_max(_pos, _inv_mass, d[0], d[1], d[2])

	_solve_collisions(dt)
	_solve_particle_collisions(dt)
	process_trigger_events()

	_apply_hull_velocity_damping(dt)


func _apply_hull_velocity_damping(dt: float) -> void:
	var kh: float = maxf(hull_vertex_damping_per_sec, 0.0)
	var kc: float = maxf(center_hull_damping_per_sec, 0.0)
	var h_fac: float = exp(-kh * dt)
	var c_fac: float = exp(-kc * dt)
	var skip_spd_sq: float = hull_damp_skip_above_speed * hull_damp_skip_above_speed
	for bi in range(_blob_ranges.size()):
		var r: Dictionary = _blob_ranges[bi]
		var ci: int = int(r["start"])
		for j in range(r["start"], r["end"]):
			if j == ci:
				_vel[j] *= c_fac
			else:
				if _vel[j].length_squared() > skip_spd_sq:
					continue
				_vel[j] *= h_fac


func _apply_springs(dt: float) -> void:
	for bi in range(_blob_ranges.size()):
		var r: Dictionary = _blob_ranges[bi]
		var sb: int = int(r.get("spring_begin", -1))
		var se: int = int(r.get("spring_end", -1))
		var k_mult: float = float(r.get("spring_stiffness_scale", 1.0))
		var d_mult: float = float(r.get("spring_damp_scale", 1.0))
		if sb < 0 or se < 0 or sb >= se:
			continue
		for s_idx in range(sb, se):
			if s_idx >= _springs.size():
				break
			var s: Array = _springs[s_idx]
			var ia: int = s[0]
			var ib: int = s[1]
			var rest: float = s[2]
			var k: float = float(s[3]) * k_mult
			var damp: float = float(s[4]) * d_mult
			var diff := _pos[ib] - _pos[ia]
			var dist := diff.length()
			if dist < 0.0001:
				continue
			var dir := diff / dist
			var stretch := dist - rest
			var rel_vel := (_vel[ib] - _vel[ia]).dot(dir)
			var force := (k * stretch + damp * rel_vel) * dir
			var inv_a := _inv_mass[ia]
			var inv_b := _inv_mass[ib]
			if inv_a > 0.0:
				_vel[ia] += force * inv_a * dt
			if inv_b > 0.0:
				_vel[ib] -= force * inv_b * dt


func _apply_pressure(dt: float) -> void:
	for si in range(_shapes.size()):
		var sh: Dictionary = _shapes[si]
		if sh.get("is_static", false) or sh.get("is_trigger", false):
			continue
		var pk: float = sh.get("pressure_k", 0.0)
		if pk <= 0.0:
			continue
		var idx: PackedInt32Array = sh["indices"]
		if idx.size() < 3:
			continue
		_scratch_poly = _build_polygon_from_indices(idx)
		var area: float = CollisionSoft.signed_area_polygon(_scratch_poly)
		var target: float = shape_pressure_target_area(si)
		var err: float = target - area
		var n := idx.size()
		for i in range(n):
			var ia := idx[i]
			var iprev := idx[(i + n - 1) % n]
			var inext := idx[(i + 1) % n]
			var pprev := _pos[iprev]
			var pnext := _pos[inext]
			var grad := Vector2(pnext.y - pprev.y, pprev.x - pnext.x) * 0.5
			var f := grad * pk * err
			if _inv_mass[ia] > 0.0:
				_vel[ia] += f * _inv_mass[ia] * dt


func _apply_shape_matching(dt: float) -> void:
	for si in range(_shapes.size()):
		var sh: Dictionary = _shapes[si]
		if sh.get("is_static", false) or sh.get("is_trigger", false):
			continue
		var smk: float = sh.get("shape_match_k", 0.0)
		if smk <= 0.0:
			continue
		var smd: float = sh.get("shape_match_damp", 0.0)
		var idx: PackedInt32Array = sh["indices"]
		var rest_local: PackedVector2Array = sh["rest_local"]
		if idx.size() != rest_local.size():
			continue
		var center: Vector2
		var angle: float
		if sh.get("use_frame_override", false):
			var fr: Transform2D = sh["frame_override"]
			center = fr.origin
			angle = fr.get_rotation()
		else:
			center = ShapeMatching.centroid_from_indices(_pos, idx)
			angle = ShapeMatching.average_angle(rest_local, _pos, idx, center)
		var frame: Transform2D = ShapeMatching.frame_transform(center, angle)
		var sm_scale: float = maxf(float(sh.get("shape_match_rest_scale", 1.0)), 0.05)
		var v_com: Vector2 = Vector2.ZERO
		var m_sum: float = 0.0
		for k in range(idx.size()):
			var pii: int = idx[k]
			var m: float = _mass[pii]
			v_com += _vel[pii] * m
			m_sum += m
		if m_sum > 1e-8:
			v_com /= m_sum
		for k in range(idx.size()):
			var pi := idx[k]
			var target: Vector2 = frame * (rest_local[k] * sm_scale)
			var diff: Vector2 = target - _pos[pi]
			var v_rel: Vector2 = _vel[pi] - v_com
			var f: Vector2 = diff * smk - (v_rel * smd)
			if _inv_mass[pi] > 0.0:
				_vel[pi] += f * _inv_mass[pi] * dt


func _solve_collisions(_dt: float) -> void:
	# Hull-hull first, then hull vs static. If static runs first, pair resolution can shove hull
	# points back into the floor; they stay wrong until the next substep (visible jitter).
	for a in range(_blob_ranges.size()):
		for b in range(a + 1, _blob_ranges.size()):
			_collide_blobs(a, b)
	for poly in _static_polygons:
		for bi in range(_blob_ranges.size()):
			_collide_blob_with_poly(bi, poly, true, _dt)


func _collide_blob_with_poly(blob_id: int, poly_world: PackedVector2Array, poly_is_static: bool, contact_dt: float = 1.0 / 60.0) -> void:
	var r: Dictionary = _blob_ranges[blob_id]
	var hull: PackedInt32Array = r["hull"]
	var bbox: Rect2 = CollisionSoft.polygon_aabb(poly_world)
	for k in range(hull.size()):
		var pi := hull[k]
		var p := _pos[pi]
		var pr := Rect2(p - Vector2(2, 2), Vector2(4, 4))
		if not CollisionSoft.aabb_overlap(pr, bbox):
			continue
		var info: Dictionary = CollisionSoft.closest_point_on_polygon_boundary(p, poly_world)
		var n_base: Vector2 = info["normal"]
		var closest: Vector2 = info["closest"]
		var inside: bool = CollisionSoft.is_point_in_polygon(p, poly_world)
		var dist_b: float = p.distance_to(closest)
		var n: Vector2
		var push_dist: float
		var use_static: bool = false
		if inside:
			n = -n_base
			var pen := (p - closest).dot(n)
			if pen <= 0.0:
				pen = COLLISION_MARGIN
			push_dist = pen + COLLISION_MARGIN
			use_static = poly_is_static
		elif poly_is_static and dist_b <= static_contact_slop:
			var to_pt: Vector2 = p - closest
			if to_pt.dot(n_base) < -0.05:
				continue
			n = n_base
			var gap: float = to_pt.dot(n)
			if gap < 0.0:
				continue
			push_dist = maxf(gap, COLLISION_MARGIN) + COLLISION_MARGIN * 0.25
			use_static = true
		else:
			continue
		if poly_is_static and use_static:
			var vn_in_wall := _vel[pi].dot(n)
			if vn_in_wall < 0.0:
				_vel[pi] -= n * vn_in_wall
			_pos[pi] = closest + n * push_dist
			var vn_before_rest := _vel[pi].dot(n)
			if vn_before_rest < 0.0:
				_vel[pi] -= n * vn_before_rest * (1.0 + static_restitution)
			var vn_after_rest := _vel[pi].dot(n)
			if static_edge_friction_mu > 1e-6:
				var edge_dir: Vector2 = info["edge_dir"]
				var t: Vector2 = edge_dir.normalized()
				if t.length_squared() < 1e-12:
					t = Vector2(-n.y, n.x).normalized()
				var v_t: float = _vel[pi].dot(t)
				if absf(v_t) >= static_friction_min_tangential_speed:
					var j_n_collision: float = absf(_mass[pi] * (vn_after_rest - vn_before_rest))
					var g_l: float = gravity.length()
					# Normal from surface toward the body should oppose gravity for a supporting contact.
					var g_dir: Vector2 = gravity / g_l if g_l > 1e-6 else Vector2(0, 1)
					var up_dir: Vector2 = -g_dir
					var support: float = clampf(up_dir.dot(n), 0.0, 1.0)
					var j_n_rest: float = (
						_mass[pi]
						* g_l
						* support
						* contact_dt
						* static_friction_normal_load_scale
					)
					var j_n: float = maxf(j_n_collision, j_n_rest)
					var j_t_uncap: float = -_mass[pi] * v_t
					var j_t: float = clampf(
						j_t_uncap,
						-static_edge_friction_mu * j_n,
						static_edge_friction_mu * j_n
					)
					_vel[pi] += t * (j_t / _mass[pi])


func _collide_blobs(a_id: int, b_id: int) -> void:
	var ra: Dictionary = _blob_ranges[a_id]
	var rb: Dictionary = _blob_ranges[b_id]
	var poly_a := _build_polygon_from_indices(ra["hull"])
	var poly_b := _build_polygon_from_indices(rb["hull"])
	if not CollisionSoft.aabb_overlap(CollisionSoft.polygon_aabb(poly_a), CollisionSoft.polygon_aabb(poly_b)):
		return
	# A points in B
	for k in range(ra["hull"].size()):
		var pi: int = ra["hull"][k]
		_resolve_point_in_shape(pi, poly_b, rb["hull"])
	# B points in A
	for k in range(rb["hull"].size()):
		var pi: int = rb["hull"][k]
		_resolve_point_in_shape(pi, poly_a, ra["hull"])


func _resolve_point_in_shape(pi: int, poly_world: PackedVector2Array, poly_indices: PackedInt32Array) -> void:
	var p := _pos[pi]
	if not CollisionSoft.is_point_in_polygon(p, poly_world):
		return
	var info: Dictionary = CollisionSoft.closest_point_on_polygon_boundary(p, poly_world)
	var n: Vector2 = info["normal"]
	var closest: Vector2 = info["closest"]
	var a: Vector2 = info["a"]
	var b: Vector2 = info["b"]
	var w: Vector2 = CollisionSoft.edge_vertex_weights(p, a, b)
	if CollisionSoft.is_point_in_polygon(p, poly_world):
		n = -n
	var edge_i := int(info["edge_i"])
	var ib0: int = poly_indices[edge_i]
	var ib1: int = poly_indices[(edge_i + 1) % poly_indices.size()]
	var pen := (p - closest).dot(n)
	if pen <= 0.0:
		pen = COLLISION_MARGIN
	var wb: float = w.x
	var wc: float = w.y
	var inv_a := _inv_mass[pi]
	var inv_b := _inv_mass[ib0]
	var inv_c := _inv_mass[ib1]
	var pa := _pos[pi]
	var pb := _pos[ib0]
	var pc := _pos[ib1]
	var w_sum: float = inv_a + inv_b * wb * wb + inv_c * wc * wc
	if w_sum < 1e-8:
		return
	var corr: float = pen / w_sum
	_pos[pi] = pa + n * (corr * inv_a)
	_pos[ib0] = pb - n * (corr * inv_b * wb)
	_pos[ib1] = pc - n * (corr * inv_c * wc)
	var va := _vel[pi]
	var vb := _vel[ib0]
	var vc := _vel[ib1]
	var edge_t: Vector2 = info["edge_dir"]
	var out: Array = CollisionSoft.resolve_three_body_velocity(
		va,
		_mass[pi],
		vb,
		_mass[ib0],
		vc,
		_mass[ib1],
		n,
		wb,
		wc,
		COLLISION_RESTITUTION,
		blob_blob_friction_mu,
		edge_t,
		blob_blob_friction_impulse_scale
	)
	_vel[pi] = out[0]
	_vel[ib0] = out[1]
	_vel[ib1] = out[2]


func _solve_particle_collisions(dt: float) -> void:
	for i in range(_pos.size()):
		var rad := _particle_radius[i]
		if rad <= 0.0:
			continue
		for poly in _static_polygons:
			_resolve_particle_vs_poly(i, rad, poly, dt)
		for si in range(_shapes.size()):
			var sh: Dictionary = _shapes[si]
			if sh.get("is_trigger", false):
				continue
			if sh.get("is_static", false):
				var tp: PackedVector2Array = sh["static_poly"]
				if not tp.is_empty():
					_resolve_particle_vs_poly(i, rad, tp, dt)
			else:
				var idx: PackedInt32Array = sh["indices"]
				if idx.size() < 2:
					continue
				_scratch_poly = _build_polygon_from_indices(idx)
				_resolve_particle_vs_poly(i, rad, _scratch_poly, dt)


func _resolve_particle_vs_poly(i: int, rad: float, poly_world: PackedVector2Array, _dt: float) -> void:
	var p := _pos[i]
	var info: Dictionary = CollisionSoft.closest_point_on_polygon_boundary(p, poly_world)
	var closest: Vector2 = info["closest"]
	var n: Vector2 = info["normal"]
	var inside: bool = CollisionSoft.is_point_in_polygon(p, poly_world)
	var dist_along := (p - closest).dot(n)
	if not inside:
		if dist_along >= rad - COLLISION_MARGIN * 0.25:
			return
		_pos[i] = p + n * (rad - dist_along)
	else:
		_pos[i] = closest + n * (rad + COLLISION_MARGIN)
	var vn := _vel[i].dot(n)
	if vn < 0.0:
		_vel[i] -= n * vn * (1.0 + COLLISION_RESTITUTION)


func _build_polygon_from_indices(indices: PackedInt32Array) -> PackedVector2Array:
	var poly := PackedVector2Array()
	poly.resize(indices.size())
	for i in range(indices.size()):
		poly[i] = _pos[indices[i]]
	return poly


func process_trigger_events() -> void:
	# Enter/exit for each trigger vs each dynamic blob centroid
	for si in range(_shapes.size()):
		var sh: Dictionary = _shapes[si]
		if not sh.get("is_trigger", false):
			continue
		var tp: PackedVector2Array = sh["static_poly"]
		if tp.is_empty():
			continue
		for bi in range(_blob_ranges.size()):
			var cx: Vector2 = ShapeMatching.centroid_from_indices(_pos, _blob_ranges[bi]["hull"])
			var inside: bool = CollisionSoft.is_point_in_polygon(cx, tp)
			var key := Vector2i(si, bi)
			var prev: bool = _trigger_prev.get(key, false)
			if inside and not prev:
				trigger_entered.emit(si, bi)
			elif not inside and prev:
				trigger_exited.emit(si, bi)
			_trigger_prev[key] = inside
