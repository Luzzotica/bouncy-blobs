class_name ConstraintsSoft
extends RefCounted
## Position-based constraint iterations: weld, weighted anchor, max distance.

const EPS := 1e-7


static func solve_weld(
		pos: PackedVector2Array,
		inv_mass: PackedFloat32Array,
		i: int,
		j: int
	) -> void:
	var w_i := inv_mass[i] if i < inv_mass.size() else 0.0
	var w_j := inv_mass[j] if j < inv_mass.size() else 0.0
	var w_sum := w_i + w_j
	if w_sum < EPS:
		return
	var delta: Vector2 = pos[j] - pos[i]
	var corr := delta / w_sum
	pos[i] = pos[i] + corr * w_j
	pos[j] = pos[j] - corr * w_i


static func solve_weighted_anchor(
		pos: PackedVector2Array,
		inv_mass: PackedFloat32Array,
		indices_a: PackedInt32Array,
		weights_a: PackedFloat32Array,
		indices_b: PackedInt32Array,
		weights_b: PackedFloat32Array
	) -> void:
	var pa := Vector2.ZERO
	var wa_sum := 0.0
	for k in range(indices_a.size()):
		var idx := indices_a[k]
		var w := weights_a[k]
		pa += pos[idx] * w
		wa_sum += w
	var pb := Vector2.ZERO
	var wb_sum := 0.0
	for k in range(indices_b.size()):
		var idx := indices_b[k]
		var w := weights_b[k]
		pb += pos[idx] * w
		wb_sum += w
	if wa_sum < EPS or wb_sum < EPS:
		return
	pa /= wa_sum
	pb /= wb_sum
	var delta := pb - pa
	var w_total := 0.0
	for k in range(indices_a.size()):
		var idx := indices_a[k]
		var w := weights_a[k] / wa_sum
		w_total += inv_mass[idx] * w * w
	for k in range(indices_b.size()):
		var idx := indices_b[k]
		var w := weights_b[k] / wb_sum
		w_total += inv_mass[idx] * w * w
	if w_total < EPS:
		return
	var corr := delta / w_total
	for k in range(indices_a.size()):
		var idx := indices_a[k]
		var w := weights_a[k] / wa_sum
		pos[idx] = pos[idx] + corr * inv_mass[idx] * w
	for k in range(indices_b.size()):
		var idx := indices_b[k]
		var w := weights_b[k] / wb_sum
		pos[idx] = pos[idx] - corr * inv_mass[idx] * w


static func solve_distance_max(
		pos: PackedVector2Array,
		inv_mass: PackedFloat32Array,
		i: int,
		j: int,
		max_dist: float
	) -> void:
	var d := pos[j] - pos[i]
	var len := d.length()
	if len <= max_dist or len < EPS:
		return
	var n := d / len
	var overlap := len - max_dist
	var w_i := inv_mass[i] if i < inv_mass.size() else 0.0
	var w_j := inv_mass[j] if j < inv_mass.size() else 0.0
	var w_sum := w_i + w_j
	if w_sum < EPS:
		return
	var corr := overlap / w_sum
	pos[i] = pos[i] + n * corr * w_j
	pos[j] = pos[j] - n * corr * w_i
