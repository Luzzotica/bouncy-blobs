class_name ShapeMatching
extends RefCounted
## Centroid, average orientation, target world positions for shape-matching springs.

const EPS := 1e-7


static func centroid_from_indices(pos: PackedVector2Array, indices: PackedInt32Array) -> Vector2:
	var c := Vector2.ZERO
	if indices.is_empty():
		return c
	for i in range(indices.size()):
		c += pos[indices[i]]
	return c / float(indices.size())


static func average_angle(
		rest_local: PackedVector2Array,
		pos: PackedVector2Array,
		indices: PackedInt32Array,
		center: Vector2
	) -> float:
	var sum := 0.0
	var count := 0
	for i in range(indices.size()):
		var li := rest_local[i]
		if li.length_squared() < EPS * EPS:
			continue
		var pi := pos[indices[i]] - center
		if pi.length_squared() < EPS * EPS:
			continue
		var a_rest := atan2(li.y, li.x)
		var a_cur := atan2(pi.y, pi.x)
		var diff := a_cur - a_rest
		diff = fmod(diff + PI, TAU) - PI
		sum += diff
		count += 1
	if count == 0:
		return 0.0
	return sum / float(count)


static func frame_transform(center: Vector2, angle: float) -> Transform2D:
	var t := Transform2D().rotated(angle)
	t.origin = center
	return t


static func target_positions(
		rest_local: PackedVector2Array,
		indices: PackedInt32Array,
		frame: Transform2D
	) -> PackedVector2Array:
	var out := PackedVector2Array()
	out.resize(indices.size())
	for i in range(indices.size()):
		out[i] = frame * rest_local[i]
	return out
