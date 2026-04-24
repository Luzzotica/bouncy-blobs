class_name CollisionSoft
extends RefCounted
## Point-in-polygon, AABB, closest edge, three-body position correction, circle-circle velocity,
## and particle (circle) vs polygon penetration.

const EPS := 1e-6


static func polygon_aabb(poly: PackedVector2Array) -> Rect2:
	if poly.is_empty():
		return Rect2()
	var min_x := poly[0].x
	var max_x := poly[0].x
	var min_y := poly[0].y
	var max_y := poly[0].y
	for i in range(1, poly.size()):
		var p := poly[i]
		min_x = minf(min_x, p.x)
		max_x = maxf(max_x, p.x)
		min_y = minf(min_y, p.y)
		max_y = maxf(max_y, p.y)
	return Rect2(min_x, min_y, max_x - min_x, max_y - min_y)


static func aabb_overlap(a: Rect2, b: Rect2) -> bool:
	return a.position.x < b.end.x and a.end.x > b.position.x and a.position.y < b.end.y and a.end.y > b.position.y


static func is_point_in_polygon(point: Vector2, polygon: PackedVector2Array) -> bool:
	var inside := false
	var n := polygon.size()
	var j := n - 1
	for i in range(n):
		var pi := polygon[i]
		var pj := polygon[j]
		if ((pi.y > point.y) != (pj.y > point.y)) and \
				(point.x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y) + pi.x):
			inside = not inside
		j = i
	return inside


## Horizontal ray variant: test point vs polygon using ray to (bbox.max.x + margin, point.y)
static func is_point_in_polygon_horizontal(point: Vector2, polygon: PackedVector2Array, bbox: Rect2) -> bool:
	var out_x := bbox.end.x + 10.0
	var ray_end := Vector2(out_x, point.y)
	var crossings := 0
	var n := polygon.size()
	for i in range(n):
		var a := polygon[i]
		var b := polygon[(i + 1) % n]
		if absf(a.y - b.y) < EPS:
			continue
		var ymin := minf(a.y, b.y)
		var ymax := maxf(a.y, b.y)
		if point.y <= ymin or point.y >= ymax:
			continue
		var t := (point.y - a.y) / (b.y - a.y)
		var ix := a.x + t * (b.x - a.x)
		if ix > point.x and ix <= out_x:
			crossings += 1
	return (crossings % 2) == 1


static func closest_point_on_polygon_boundary(point: Vector2, polygon: PackedVector2Array) -> Dictionary:
	var best_dist := INF
	var best_closest := Vector2.ZERO
	var best_i := 0
	var n := polygon.size()
	for i in range(n):
		var a := polygon[i]
		var b := polygon[(i + 1) % n]
		var c := Geometry2D.get_closest_point_to_segment(point, a, b)
		var d := point.distance_squared_to(c)
		if d < best_dist:
			best_dist = d
			best_closest = c
			best_i = i
	var a := polygon[best_i]
	var b := polygon[(best_i + 1) % n]
	var edge := b - a
	var len_e := edge.length()
	var edge_dir := edge / len_e if len_e > EPS else Vector2.RIGHT
	var tangent := edge_dir
	var normal := Vector2(tangent.y, -tangent.x).normalized()
	var from_closest_to_point := point - best_closest
	if from_closest_to_point.dot(normal) < 0.0:
		normal = -normal
	return {
		"closest": best_closest,
		"edge_i": best_i,
		"normal": normal,
		"a": a,
		"b": b,
		"edge_dir": edge_dir,
		"edge_len": len_e,
	}


## Returns separation along normal to push point out of polygon (positive = push along normal).
static func penetration_depth_point_in_poly(point: Vector2, polygon: PackedVector2Array, info: Dictionary) -> float:
	var closest: Vector2 = info["closest"]
	var n: Vector2 = info["normal"]
	return (point - closest).dot(n)


static func edge_vertex_weights(point: Vector2, a: Vector2, b: Vector2) -> Vector2:
	var ab := b - a
	var lab_sq := ab.length_squared()
	if lab_sq < EPS * EPS:
		return Vector2(0.5, 0.5)
	var t := (point - a).dot(ab) / lab_sq
	t = clampf(t, 0.0, 1.0)
	return Vector2(1.0 - t, t)


## Resolve three masses with inverse mass correction along normal.
static func resolve_three_body_position(
		pa: Vector2, inv_ma: float,
		pb: Vector2, inv_mb: float,
		pc: Vector2, inv_mc: float,
		normal: Vector2,
		penetration: float,
		wb: float,
		wc: float
	) -> Array:
	var w_sum := inv_ma + inv_mb * wb * wb + inv_mc * wc * wc
	if w_sum < EPS:
		return [pa, pb, pc]
	var corr := penetration / w_sum
	var delta_a := normal * (corr * inv_ma)
	var delta_b := normal * (-corr * inv_mb * wb)
	var delta_c := normal * (-corr * inv_mc * wc)
	return [pa + delta_a, pb + delta_b, pc + delta_c]


## Impulse on three bodies: penetrating point A vs edge B–C with weights wb, wc (sum to 1).
## Optional Coulomb friction along [param tangent] (unit edge direction); [param mu] caps tangential impulse
## by [code]mu * abs(j_n)[/code] where [code]j_n[/code] is the normal impulse scalar.
## [param friction_impulse_scale] scales the applied tangential impulse (soft bodies: use below 1.0 to reduce chatter).
static func resolve_three_body_velocity(
		va: Vector2, ma: float,
		vb: Vector2, mb: float,
		vc: Vector2, mc: float,
		normal: Vector2,
		wb: float,
		wc: float,
		restitution: float,
		mu: float = 0.0,
		tangent: Vector2 = Vector2.ZERO,
		friction_impulse_scale: float = 1.0
	) -> Array:
	var n := normal.normalized()
	var v_rel := n.dot(va) - (wb * n.dot(vb) + wc * n.dot(vc))
	if v_rel >= 0.0:
		return [va, vb, vc]
	var inv_sum := 0.0
	if ma > EPS:
		inv_sum += 1.0 / ma
	if mb > EPS:
		inv_sum += (wb * wb) / mb
	if mc > EPS:
		inv_sum += (wc * wc) / mc
	if inv_sum < EPS:
		return [va, vb, vc]
	var j := -(1.0 + restitution) * v_rel / inv_sum
	var va_new := va + n * (j / ma if ma > EPS else 0.0)
	var vb_new := vb - n * (j * wb / mb if mb > EPS else 0.0)
	var vc_new := vc - n * (j * wc / mc if mc > EPS else 0.0)
	if mu <= EPS or tangent.length_squared() < EPS * EPS:
		return [va_new, vb_new, vc_new]
	var t := tangent.normalized()
	if absf(t.dot(n)) > 0.05:
		t = Vector2(-n.y, n.x).normalized()
	var v_rel_t := t.dot(va_new) - (wb * t.dot(vb_new) + wc * t.dot(vc_new))
	# Ignore micro-slip so stacked soft bodies don’t chatter from many edge contacts per frame.
	if absf(v_rel_t) < 0.42:
		return [va_new, vb_new, vc_new]
	var j_t_uncap := -v_rel_t / inv_sum
	var j_n_abs: float = absf(j)
	var max_t: float = mu * maxf(j_n_abs, EPS * EPS)
	var j_t: float = clampf(j_t_uncap, -max_t, max_t) * clampf(friction_impulse_scale, 0.0, 1.0)
	va_new += t * (j_t / ma if ma > EPS else 0.0)
	vb_new -= t * (j_t * wb / mb if mb > EPS else 0.0)
	vc_new -= t * (j_t * wc / mc if mc > EPS else 0.0)
	return [va_new, vb_new, vc_new]


static func signed_area_polygon(poly: PackedVector2Array) -> float:
	var a := 0.0
	var n := poly.size()
	for i in range(n):
		var j := (i + 1) % n
		a += poly[i].x * poly[j].y - poly[j].x * poly[i].y
	return a * 0.5
