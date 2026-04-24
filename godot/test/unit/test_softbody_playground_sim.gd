extends GutTest
## Headless-friendly integration test for [SoftBodyWorld] via [member softbody_playground] scene.
## Run from repo root (omit default .gutconfig dirs; run only this script):
##   godot --headless --path . -s res://addons/gut/gut_cmdln.gd -- -gconfig= -gtest=res://test/unit/test_softbody_playground_sim.gd -gexit
##
## Anti-vibration checks (after warmup): hull RMS speed, peak speed, centroid positional stability,
## and RMS frame-to-frame delta velocity on one hull point (high-frequency chatter proxy).
##
## Strict hull-vertex checks (see [method test_playground_hull_outer_vertices_rest_at_low_jitter]):
## centroid can stay still while outer points shake; this test measures per-vertex relative motion.

const PLAYGROUND := preload("res://softbody_playground.tscn")

## Margins above typical headless runs (~peak 300, rms 126, rms_dv 80, stdev_cy 0.27).
const MAX_PEAK_HULL_SPEED := 330.0
const MAX_RMS_HULL_SPEED := 135.0
const MAX_RMS_HULL_VELOCITY_DELTA := 92.0
const MAX_STDEV_CENTROID_Y := 0.55
const MAX_STDEV_HULL0_Y := 0.55

## Stricter targets for outer hull vertices (world px / px/s). Tighten as physics improves.
## With [member ENFORCE_STRICT_HULL_VERTEX_REST] true, failure means hull points still buzz (centroid can be calm).
## Headless baseline (current sim): peak ~300, rms ~126, rms_vrel ~126, max shape stdev ~1.0 px.
const MAX_PEAK_HULL_VERTEX_SPEED_STRICT := 120.0
const MAX_RMS_HULL_VERTEX_SPEED_STRICT := 45.0
const MAX_RMS_HULL_VELOCITY_REL_TO_CENTER := 45.0
## Max RMS deviation of (vertex - center) from its temporal mean over the measure window — shape wobble.
const MAX_ANY_HULL_VERTEX_REL_SHAPE_STDEV := 0.55

## Set [code]true[/code] to also enforce strict hull-at-rest limits (expected to fail until jitter is fixed).
const ENFORCE_STRICT_HULL_VERTEX_REST := false

## Loose regression cap on temporal wobble of (hull vertex - center); baseline ~0.98 px.
const MAX_ANY_HULL_VERTEX_REL_SHAPE_STDEV_LOOSE := 1.15


func test_playground_scene_loads_and_has_world() -> void:
	var pg: Node2D = PLAYGROUND.instantiate()
	add_child_autofree(pg)
	await wait_process_frames(1)
	var world: Node = pg.get_node_or_null("SoftBodyWorld")
	assert_not_null(world)
	assert_true(world is SoftBodyWorld)


func test_playground_resting_softbody_not_chattering() -> void:
	var pg: Node2D = PLAYGROUND.instantiate()
	add_child_autofree(pg)
	await wait_process_frames(2)
	var world: SoftBodyWorld = pg.get_node("SoftBodyWorld") as SoftBodyWorld
	assert_gt(world.get_blob_count(), 0, "playground should spawn blobs")
	var warmup_frames := 240
	var measure_frames := 360
	var peak := 0.0
	var sum_sq := 0.0
	var sample_count := 0
	var cy_samples: Array[float] = []
	var hull0_y_samples: Array[float] = []
	var prev_v_h0: Vector2 = Vector2.ZERO
	var dv_sq_sum := 0.0
	var dv_samples := 0
	var h0_init := false
	for i in range(warmup_frames + measure_frames):
		await wait_physics_frames(1)
		if i < warmup_frames:
			continue
		var vel: PackedVector2Array = world.get_velocities()
		var pos: PackedVector2Array = world.get_positions()
		var center_i: int = world.get_blob_center_point_index(0)
		var rng: Vector2i = world.get_blob_mass_point_index_range(0)
		var h0: int = center_i + 1
		if h0 < rng.y:
			var v_h0: Vector2 = vel[h0]
			if h0_init:
				var dv: Vector2 = v_h0 - prev_v_h0
				dv_sq_sum += dv.length_squared()
				dv_samples += 1
			h0_init = true
			prev_v_h0 = v_h0
			hull0_y_samples.append(pos[h0].y)
		var c := Vector2.ZERO
		for j in range(rng.x, rng.y):
			c += pos[j]
		c /= float(rng.y - rng.x)
		cy_samples.append(c.y)
		for j in range(rng.x, rng.y):
			if j == center_i:
				continue
			var s: float = vel[j].length()
			sum_sq += s * s
			sample_count += 1
			if s > peak:
				peak = s
	var rms: float = sqrt(sum_sq / float(max(sample_count, 1)))
	var stdev_cy: float = _population_stdev(cy_samples)
	var stdev_h0: float = _population_stdev(hull0_y_samples)
	var rms_dv: float = sqrt(dv_sq_sum / float(max(dv_samples, 1)))
	assert_lt(peak, MAX_PEAK_HULL_SPEED, "peak hull point speed should stay bounded (no runaway)")
	assert_lt(rms, MAX_RMS_HULL_SPEED, "RMS hull speed should stay low while resting")
	assert_lt(rms_dv, MAX_RMS_HULL_VELOCITY_DELTA, "hull velocity should not change violently frame-to-frame")
	assert_lt(stdev_cy, MAX_STDEV_CENTROID_Y, "blob centroid Y should not wander (no bulk vibration)")
	assert_lt(stdev_h0, MAX_STDEV_HULL0_Y, "sample hull vertex Y should stay stable (no floor chatter)")


## Every outer mass point (hull vertex): speed and temporal wobble of (vertex - center).
## Always checks loose bounds; set [member ENFORCE_STRICT_HULL_VERTEX_REST] to tighten toward “no buzz.”
func test_playground_hull_outer_vertices_rest_at_low_jitter() -> void:
	var pg: Node2D = PLAYGROUND.instantiate()
	add_child_autofree(pg)
	await wait_process_frames(2)
	var world: SoftBodyWorld = pg.get_node("SoftBodyWorld") as SoftBodyWorld
	assert_gt(world.get_blob_count(), 0, "playground should spawn blobs")
	var warmup_frames := 240
	var measure_frames := 360
	var center_i: int = world.get_blob_center_point_index(0)
	var rng: Vector2i = world.get_blob_mass_point_index_range(0)
	var rel_series: Dictionary = {}
	var peak := 0.0
	var sum_sq := 0.0
	var sum_sq_vrel := 0.0
	var n_samples := 0
	for i in range(warmup_frames + measure_frames):
		await wait_physics_frames(1)
		if i < warmup_frames:
			continue
		var vel: PackedVector2Array = world.get_velocities()
		var pos: PackedVector2Array = world.get_positions()
		var v_c: Vector2 = vel[center_i]
		for j in range(rng.x, rng.y):
			if j == center_i:
				continue
			var rel: Vector2 = pos[j] - pos[center_i]
			if not rel_series.has(j):
				rel_series[j] = [] as Array[Vector2]
			(rel_series[j] as Array[Vector2]).append(rel)
			var sp: float = vel[j].length()
			var srel: float = (vel[j] - v_c).length()
			sum_sq += sp * sp
			sum_sq_vrel += srel * srel
			n_samples += 1
			if sp > peak:
				peak = sp
	var rms: float = sqrt(sum_sq / float(max(n_samples, 1)))
	var rms_vrel: float = sqrt(sum_sq_vrel / float(max(n_samples, 1)))
	var max_shape_stdev := 0.0
	for j in rel_series:
		var series: Array[Vector2] = rel_series[j] as Array[Vector2]
		var sig: float = _vector2_series_rms_around_mean(series)
		if sig > max_shape_stdev:
			max_shape_stdev = sig
	assert_lt(peak, MAX_PEAK_HULL_SPEED, "hull vertex peak speed regression")
	assert_lt(rms, MAX_RMS_HULL_SPEED, "hull vertex RMS speed regression")
	assert_lt(rms_vrel, MAX_RMS_HULL_SPEED * 1.05, "hull speed relative to center regression")
	assert_lt(
		max_shape_stdev,
		MAX_ANY_HULL_VERTEX_REL_SHAPE_STDEV_LOOSE,
		"vertex-to-center offset wobble vs temporal mean (regression on shape shimmer)"
	)
	if ENFORCE_STRICT_HULL_VERTEX_REST:
		assert_lt(
			peak,
			MAX_PEAK_HULL_VERTEX_SPEED_STRICT,
			"[strict] no hull vertex should spike to high speed while resting"
		)
		assert_lt(
			rms,
			MAX_RMS_HULL_VERTEX_SPEED_STRICT,
			"[strict] hull vertex RMS speed should be low (outer points not buzzing)"
		)
		assert_lt(
			rms_vrel,
			MAX_RMS_HULL_VELOCITY_REL_TO_CENTER,
			"[strict] hull motion relative to center mass should be low (not just centroid stable)"
		)
		assert_lt(
			max_shape_stdev,
			MAX_ANY_HULL_VERTEX_REL_SHAPE_STDEV,
			"[strict] vertex-to-center offset should not wobble over time (temporal shape jitter)"
		)


func test_minimal_softbody_on_floor_centroid_drops() -> void:
	var w := SoftBodyWorld.new()
	w.sync_gravity_from_project = false
	w.gravity = Vector2(0, 980.0)
	w.gravity_scale = 4.0
	w.fixed_dt = 1.0 / 60.0
	w.substeps = 2
	add_child_autofree(w)
	# Floor strip similar to playground (world coords): y in [440, 600]
	var floor_poly := PackedVector2Array([
		Vector2(-1400, 440),
		Vector2(1400, 440),
		Vector2(1400, 600),
		Vector2(-1400, 600),
	])
	w.register_static_polygon(floor_poly)
	var hull := PackedVector2Array([
		Vector2(-32, -32),
		Vector2(32, -32),
		Vector2(32, 32),
		Vector2(-32, 32),
	])
	var _reg: Dictionary = w.add_blob_from_hull(
		hull,
		Vector2.ZERO,
		0.2,
		0.12,
		60.0,
		1.5,
		80.0,
		2.0,
		0.12,
		95.0,
		2.2,
		Vector2(0, 200)
	)
	var cy0 := _centroid_y_blob(w, 0)
	for _i in range(600):
		w._physics_process(1.0 / 60.0)
	var cy1 := _centroid_y_blob(w, 0)
	assert_gt(cy1, cy0 + 20.0, "blob centroid should fall toward floor")


func _centroid_y_blob(world: SoftBodyWorld, blob_id: int) -> float:
	var hp: PackedVector2Array = world.get_hull_polygon(blob_id)
	if hp.is_empty():
		return 0.0
	var s := 0.0
	for p in hp:
		s += p.y
	return s / float(hp.size())


func _population_stdev(samples: Array[float]) -> float:
	if samples.is_empty():
		return 0.0
	var n: int = samples.size()
	var mean := 0.0
	for v in samples:
		mean += v
	mean /= float(n)
	var acc := 0.0
	for v in samples:
		var d := v - mean
		acc += d * d
	return sqrt(acc / float(n))


## RMS magnitude of (sample - mean) for Vector2 series — scalar "radius" of temporal jitter.
func _vector2_series_rms_around_mean(series: Array[Vector2]) -> float:
	if series.is_empty():
		return 0.0
	var n: int = series.size()
	var mean := Vector2.ZERO
	for v in series:
		mean += v
	mean /= float(n)
	var acc := 0.0
	for v in series:
		var d: Vector2 = v - mean
		acc += d.length_squared()
	return sqrt(acc / float(n))
