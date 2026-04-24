extends GutTest

## Tests for [ShapeMatching] centroid and frame helpers.


func test_centroid_of_square() -> void:
	var idx := PackedInt32Array([0, 1, 2, 3])
	var pos := PackedVector2Array([
		Vector2(0, 0),
		Vector2(10, 0),
		Vector2(10, 10),
		Vector2(0, 10),
	])
	var c := ShapeMatching.centroid_from_indices(pos, idx)
	assert_eq(c, Vector2(5, 5), "centroid of axis square")


func test_average_angle_undeformed_matches_frame() -> void:
	var rest := PackedVector2Array([
		Vector2(10, 0),
		Vector2(0, 10),
		Vector2(-10, 0),
		Vector2(0, -10),
	])
	var idx := PackedInt32Array([0, 1, 2, 3])
	var pos := PackedVector2Array()
	pos.resize(4)
	for i in 4:
		pos[i] = rest[i]
	var center := ShapeMatching.centroid_from_indices(pos, idx)
	var ang := ShapeMatching.average_angle(rest, pos, idx, center)
	assert_almost_eq(ang, 0.0, 0.001, "no rotation vs rest")
