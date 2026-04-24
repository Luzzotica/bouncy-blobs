extends RefCounted
## CCW hull vertices in local space (center at origin). Matches [SoftBodyWorld.add_blob_from_hull] expectations.
## Reference via [code]preload("res://soft/hull_presets.gd")[/code] static methods.


static func square(half: float) -> PackedVector2Array:
	return PackedVector2Array([
		Vector2(-half, -half),
		Vector2(half, -half),
		Vector2(half, half),
		Vector2(-half, half),
	])


static func circle(n: int, r: float) -> PackedVector2Array:
	var out := PackedVector2Array()
	out.resize(n)
	for i in range(n):
		var a := TAU * float(i) / float(n) - PI * 0.5
		out[i] = Vector2(cos(a), sin(a)) * r
	return out


static func triangle(r: float) -> PackedVector2Array:
	var out := PackedVector2Array()
	for i in range(3):
		var a := -PI * 0.5 + TAU * float(i) / 3.0
		out.append(Vector2(cos(a), sin(a)) * r)
	return out


static func star(arms: int, r_out: float, r_in: float) -> PackedVector2Array:
	var out := PackedVector2Array()
	var n := arms * 2
	for i in range(n):
		var a := -PI * 0.5 + TAU * float(i) / float(n)
		var rr := r_out if (i % 2 == 0) else r_in
		out.append(Vector2(cos(a), sin(a)) * rr)
	return out


static func diamond(w: float) -> PackedVector2Array:
	var h := w * 1.2
	return PackedVector2Array([
		Vector2(0, -h),
		Vector2(w, 0),
		Vector2(0, h),
		Vector2(-w, 0),
	])
