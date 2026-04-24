extends GutTest

## Integration checks for [SoftBodyWorld] (no private fields).

const HullPresets := preload("res://soft/hull_presets.gd")
const GT := preload("res://soft/softbody_gameplay_tuning.gd")


func test_add_blob_point_count_center_plus_hull() -> void:
	var w := SoftBodyWorld.new()
	w.sync_gravity_from_project = false
	w.gravity = Vector2(0, 980.0)
	var _reg: Dictionary = w.add_blob(
		Vector2.ZERO,
		8,
		48.0,
		0.2,
		0.12,
		60.0,
		1.5,
		80.0,
		2.0,
		0.0,
		0.0,
		0.0,
		Vector2(100, 200)
	)
	assert_eq(w.get_point_count(), 9, "center + 8 hull")
	w.free()


func test_add_blob_from_hull_square_point_count() -> void:
	var w := SoftBodyWorld.new()
	w.sync_gravity_from_project = false
	var hull := HullPresets.square(40.0)
	var _reg: Dictionary = w.add_blob_from_hull(
		hull,
		Vector2.ZERO,
		GT.CENTER_MASS,
		GT.HULL_MASS,
		GT.SPRING_K,
		GT.SPRING_DAMP,
		GT.RADIAL_K,
		GT.RADIAL_DAMP,
		GT.PRESSURE_K,
		GT.SHAPE_MATCH_K,
		GT.SHAPE_MATCH_DAMP,
		Vector2.ZERO
	)
	assert_eq(w.get_point_count(), 5, "center + 4 hull vertices")
	w.free()


func test_single_physics_step_hull_falls_when_shape_match_off() -> void:
	var w := SoftBodyWorld.new()
	w.sync_gravity_from_project = false
	w.gravity = Vector2(0, 8000.0)
	w.fixed_dt = 1.0 / 60.0
	w.substeps = 1
	var _reg: Dictionary = w.add_blob(
		Vector2.ZERO,
		4,
		40.0,
		0.2,
		0.12,
		2.0,
		0.5,
		2.0,
		0.5,
		0.0,
		0.0,
		0.0,
		Vector2.ZERO
	)
	var y_before := w.get_positions()[1].y
	w._physics_process(1.0 / 60.0)
	var y_after := w.get_positions()[1].y
	assert_true(y_after > y_before, "first hull point should move down (y increases) after gravity integration")
	w.free()
