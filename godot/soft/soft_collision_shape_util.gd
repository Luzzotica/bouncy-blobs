class_name SoftCollisionShapeUtil
extends RefCounted
## Converts [CollisionShape2D] / [CollisionPolygon2D] to world [PackedVector2Array] for [SoftBodyWorld].


static func collision_polygon_to_world(cp: CollisionPolygon2D) -> PackedVector2Array:
	var poly := cp.polygon
	if poly.size() < 3:
		return PackedVector2Array()
	var out := PackedVector2Array()
	out.resize(poly.size())
	for i in range(poly.size()):
		out[i] = cp.to_global(poly[i])
	return out


static func collision_shape_to_world_polygon(cs: CollisionShape2D) -> PackedVector2Array:
	var sh := cs.shape
	if sh == null:
		return PackedVector2Array()
	var xf: Transform2D = cs.global_transform
	if sh is RectangleShape2D:
		var r: RectangleShape2D = sh as RectangleShape2D
		var e: Vector2 = r.size * 0.5
		var corners := [
			Vector2(-e.x, -e.y),
			Vector2(e.x, -e.y),
			Vector2(e.x, e.y),
			Vector2(-e.x, e.y),
		]
		var out := PackedVector2Array()
		out.resize(4)
		for i in range(4):
			out[i] = xf * corners[i]
		return out
	if sh is ConvexPolygonShape2D:
		var cps: ConvexPolygonShape2D = sh as ConvexPolygonShape2D
		var pts: PackedVector2Array = cps.points
		if pts.size() < 3:
			return PackedVector2Array()
		var out2 := PackedVector2Array()
		out2.resize(pts.size())
		for i in range(pts.size()):
			out2[i] = xf * pts[i]
		return out2
	if sh is CircleShape2D:
		var circ: CircleShape2D = sh as CircleShape2D
		var rad: float = circ.radius
		var n := 16
		var out3 := PackedVector2Array()
		out3.resize(n)
		for i in range(n):
			var a: float = TAU * float(i) / float(n)
			out3[i] = xf * Vector2(cos(a) * rad, sin(a) * rad)
		return out3
	return PackedVector2Array()
