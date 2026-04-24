extends GutTest

## Tests for [CollisionSoft] helpers used by the soft-body pipeline.


func test_point_inside_axis_aligned_square() -> void:
	var sq := PackedVector2Array([
		Vector2(0, 0),
		Vector2(10, 0),
		Vector2(10, 10),
		Vector2(0, 10),
	])
	assert_true(CollisionSoft.is_point_in_polygon(Vector2(5, 5), sq), "center inside")
	assert_false(CollisionSoft.is_point_in_polygon(Vector2(20, 5), sq), "outside right")


func test_point_in_polygon_horizontal_matches_ray_cast() -> void:
	var sq := PackedVector2Array([
		Vector2(0, 0),
		Vector2(10, 0),
		Vector2(10, 10),
		Vector2(0, 10),
	])
	var bbox := CollisionSoft.polygon_aabb(sq)
	var p := Vector2(5, 5)
	assert_eq(
		CollisionSoft.is_point_in_polygon(p, sq),
		CollisionSoft.is_point_in_polygon_horizontal(p, sq, bbox),
		"horizontal ray variant should match parity test"
	)


func test_signed_area_square_ccw_positive() -> void:
	var sq := PackedVector2Array([
		Vector2(0, 0),
		Vector2(10, 0),
		Vector2(10, 10),
		Vector2(0, 10),
	])
	var a := CollisionSoft.signed_area_polygon(sq)
	assert_true(a > 0.0, "CCW square should have positive signed area in Godot coords")


func test_aabb_overlap() -> void:
	var r1 := Rect2(0, 0, 10, 10)
	var r2 := Rect2(5, 5, 10, 10)
	var r3 := Rect2(100, 100, 1, 1)
	assert_true(CollisionSoft.aabb_overlap(r1, r2), "overlapping")
	assert_false(CollisionSoft.aabb_overlap(r1, r3), "separated")


func test_edge_vertex_weights_endpoints() -> void:
	var a := Vector2(0, 0)
	var b := Vector2(10, 0)
	var w := CollisionSoft.edge_vertex_weights(Vector2(0, 0), a, b)
	assert_eq(w.x, 1.0, "at A")
	assert_eq(w.y, 0.0, "at A")
	w = CollisionSoft.edge_vertex_weights(Vector2(10, 0), a, b)
	assert_eq(w.y, 1.0, "at B")
