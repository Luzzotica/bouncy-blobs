extends Node2D
## Playground: tools (pull / pump / frame scale), sliders, optional keyboard control, debug hull.

const CollisionSoftScript := preload("res://soft/collision_soft.gd")
const HullPresets := preload("res://soft/hull_presets.gd")
const GT := preload("res://soft/softbody_gameplay_tuning.gd")

enum Tool { PULL, PUMP, FRAME }

const MOVE_FORCE := 47.5
const EXPAND_FORCE := 500.0

const HULL_LINE_WIDTH := 2.25
## Debug: center-velocity arrow length (world impulse → pixels).
const DEBUG_VEL_ARROW_SCALE := 0.085
## Debug: pump edge arrow length from scalar impulse budget [code]impulse[/code].
const DEBUG_PUMP_ARROW_SCALE := 0.22
## Pull: gesture × slider × this (additional ÷10 vs earlier playground tuning).
const PULL_FORCE_SCALE := 0.005
## Smoothed mouse velocity (used as fallback when release flick is tiny).
const PULL_DRAG_VEL_SMOOTH := 0.45
## Scales release impulse from pointer motion (instant velocity is primary).
const PULL_RELEASE_THROW_SCALE := 1.65
## Pump: slider expand force × this (÷100 vs raw apply_blob_expand units).
const PUMP_FORCE_SCALE := 0.1
## Frame tool: [method SoftBodyWorld.set_blob_shape_match_rest_scale] target (clamped by world to [code][0.35, 3.5][/code]).
const FRAME_REST_SCALE := 2.0
## Fixed framing — camera does not follow any blob.
const CAMERA_WORLD_CENTER := Vector2(0, 320)

const SHAPE_NAMES: PackedStringArray = [
	"Square",
	"Circle (16)",
	"Triangle",
	"Hexagon",
	"Star",
	"Diamond",
]

@onready var _world = $SoftBodyWorld
@onready var _camera: Camera2D = $Camera2D

var _hint: Label
var _toolbar_root: Control
var _btn_pull: Button
var _btn_pump: Button
var _btn_frame: Button
var _slider_gravity: HSlider
var _slider_pump: HSlider
var _slider_pull: HSlider
var _chk_debug: CheckBox
var _chk_keys: CheckBox

var _tool: Tool = Tool.PULL

var _shape_idx: int = 0
var _blob_ids: Array[int] = []
var _blob_colors: Array[Color] = []

var _spawn_pos: Vector2 = Vector2(0, 360)
var _debug_mode: bool = false
var _fill_color: Color = Color(0.45, 0.82, 0.98, 0.88)

var _move_input: Vector2 = Vector2.ZERO
var _expand_pressed: bool = false

## Pull tool: mouse position when grab started (global). Force scales with |mouse - grab|.
var _grab_mouse_world: Vector2
var _drag_point_idx: int = -1
var _pull_mouse_prev_world: Vector2 = Vector2.ZERO
var _pull_drag_vel_smooth: Vector2 = Vector2.ZERO

func _ready() -> void:
	if _world:
		_world.substeps = 4
	_hint = $UI/Label
	_setup_toolbar()
	if _hint:
		_hint.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		_hint.custom_minimum_size.x = 1020.0
	_register_static_polygons()
	_spawn_all_bodies()
	_sync_sliders_from_world()
	_update_hint()
	if _camera:
		_camera.global_position = CAMERA_WORLD_CENTER
	set_process(true)
	set_physics_process(true)


func _setup_toolbar() -> void:
	var ui: CanvasLayer = $UI
	ui.remove_child(_hint)

	var root := VBoxContainer.new()
	root.name = "ToolbarColumn"
	root.set_anchors_preset(Control.PRESET_TOP_LEFT)
	root.offset_left = 12.0
	root.offset_top = 10.0
	root.offset_right = 1100.0
	root.offset_bottom = 220.0
	root.add_theme_constant_override(&"separation", 6)
	_toolbar_root = root

	var row1 := HBoxContainer.new()
	row1.add_theme_constant_override(&"separation", 8)

	var lt := Label.new()
	lt.text = "Tool"
	row1.add_child(lt)

	var bg := ButtonGroup.new()
	_btn_pull = Button.new()
	_btn_pull.text = "Pull (1)"
	_btn_pull.toggle_mode = true
	_btn_pull.button_group = bg
	_btn_pull.button_pressed = true
	row1.add_child(_btn_pull)

	_btn_pump = Button.new()
	_btn_pump.text = "Pump (2)"
	_btn_pump.toggle_mode = true
	_btn_pump.button_group = bg
	row1.add_child(_btn_pump)

	_btn_frame = Button.new()
	_btn_frame.text = "Frame (3)"
	_btn_frame.toggle_mode = true
	_btn_frame.button_group = bg
	row1.add_child(_btn_frame)

	_btn_pull.toggled.connect(func(pressed: bool) -> void:
		if pressed:
			_tool = Tool.PULL
			_update_hint()
	)
	_btn_pump.toggled.connect(func(pressed: bool) -> void:
		if pressed:
			_tool = Tool.PUMP
			_drag_point_idx = -1
			_update_hint()
	)
	_btn_frame.toggled.connect(func(pressed: bool) -> void:
		if pressed:
			_tool = Tool.FRAME
			_drag_point_idx = -1
			_update_hint()
	)

	_slider_gravity = _add_labeled_slider(row1, "Gravity ×", 0.2, 8.0, 0.1, 4.0)
	_slider_gravity.value_changed.connect(_on_gravity_slider)

	_slider_pump = _add_labeled_slider(row1, "Pump", 100.0, 3200.0, 25.0, 1100.0)
	_slider_pump.value_changed.connect(_on_pump_slider)

	_slider_pull = _add_labeled_slider(row1, "Pull", 80.0, 2800.0, 25.0, 720.0)
	_slider_pull.value_changed.connect(_on_pull_slider)

	_chk_debug = CheckBox.new()
	_chk_debug.text = "Debug (O)"
	_chk_debug.button_pressed = _debug_mode
	_chk_debug.toggled.connect(func(on: bool) -> void:
		_debug_mode = on
		_update_hint()
	)
	row1.add_child(_chk_debug)

	_chk_keys = CheckBox.new()
	_chk_keys.text = "Keys A/D/Space (player)"
	_chk_keys.button_pressed = false
	_chk_keys.toggled.connect(func(_on: bool) -> void:
		_update_hint()
	)
	row1.add_child(_chk_keys)

	root.add_child(row1)
	root.add_child(_hint)

	ui.add_child(root)


func _add_labeled_slider(
		parent: HBoxContainer,
		label_text: String,
		min_v: float,
		max_v: float,
		step_v: float,
		default_v: float
	) -> HSlider:
	var lab := Label.new()
	lab.text = label_text
	parent.add_child(lab)
	var s := HSlider.new()
	s.min_value = min_v
	s.max_value = max_v
	s.step = step_v
	s.value = default_v
	s.custom_minimum_size.x = 110.0
	parent.add_child(s)
	return s


func _sync_sliders_from_world() -> void:
	if _slider_gravity and _world:
		_slider_gravity.set_block_signals(true)
		_slider_gravity.value = _world.gravity_scale
		_slider_gravity.set_block_signals(false)
	if _slider_pump:
		_slider_pump.set_block_signals(true)
		_slider_pump.value = 1100.0
		_slider_pump.set_block_signals(false)
	if _slider_pull:
		_slider_pull.set_block_signals(true)
		_slider_pull.value = 720.0
		_slider_pull.set_block_signals(false)


func _on_gravity_slider(v: float) -> void:
	if _world == null:
		return
	_world.gravity_scale = v
	_world.sync_gravity_from_project_settings()


func _on_pump_slider(_v: float) -> void:
	_update_hint()


func _on_pull_slider(_v: float) -> void:
	_update_hint()


func _register_static_polygons() -> void:
	_register_polygon_from_vis($World/Floor/FloorVis)


func _register_polygon_from_vis(vis: Polygon2D) -> void:
	var poly := vis.polygon
	var gp := PackedVector2Array()
	gp.resize(poly.size())
	for i in range(poly.size()):
		gp[i] = vis.to_global(poly[i])
	_world.register_static_polygon(gp)


func _shape_hull(idx: int) -> PackedVector2Array:
	match idx:
		0:
			return HullPresets.square(48.0)
		1:
			return HullPresets.circle(16, 48.0)
		2:
			return HullPresets.triangle(52.0)
		3:
			return HullPresets.circle(6, 48.0)
		4:
			return HullPresets.star(5, 56.0, 22.0)
		5:
			return HullPresets.diamond(48.0)
		_:
			return HullPresets.circle(16, 48.0)


func _spawn_all_bodies() -> void:
	_world.clear_simulation()
	_blob_ids.clear()
	_blob_colors.clear()

	var defs: Array[Dictionary] = [
		{
			"hull": _shape_hull(_shape_idx),
			"pos": _spawn_pos,
			"col": Color(0.45, 0.82, 0.98, 0.88),
		},
		{"hull": HullPresets.circle(16, 48.0), "pos": Vector2(-300, 380), "col": Color(0.95, 0.55, 0.45, 0.88)},
		{"hull": HullPresets.square(48.0), "pos": Vector2(300, 380), "col": Color(0.55, 0.9, 0.55, 0.88)},
		{"hull": HullPresets.triangle(52.0), "pos": Vector2(0, 270), "col": Color(0.9, 0.55, 0.88, 0.88)},
	]

	for d in defs:
		var hull: PackedVector2Array = d["hull"]
		var pos: Vector2 = d["pos"]
		var col: Color = d["col"]
		var reg: Dictionary = _world.add_blob_from_hull(
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
			pos
		)
		if reg.is_empty():
			continue
		_blob_ids.append(reg["blob_id"])
		_blob_colors.append(col)


func _player_blob_id() -> int:
	if _blob_ids.is_empty():
		return -1
	return _blob_ids[0]


func _process(_delta: float) -> void:
	queue_redraw()


func _physics_process(_delta: float) -> void:
	if _world == null:
		return

	if _tool == Tool.PULL and _drag_point_idx >= 0:
		var mouse_w: Vector2 = get_global_mouse_position()
		var dt: float = maxf(_delta, 0.0001)
		var instant_vel: Vector2 = (mouse_w - _pull_mouse_prev_world) / dt
		_pull_drag_vel_smooth = _pull_drag_vel_smooth.lerp(instant_vel, PULL_DRAG_VEL_SMOOTH)
		_pull_mouse_prev_world = mouse_w

	var expand_held: bool = Input.is_action_pressed(&"expand") or MobileInput.expand_pressed
	var pump_used_expand: bool = false

	if _tool == Tool.PUMP and expand_held and not _pointer_over_toolbar():
		var hb: int = _pick_blob_at(get_global_mouse_position())
		if hb >= 0:
			var pump_f: float = _slider_pump.value if _slider_pump else 1100.0
			_world.apply_blob_expand(hb, pump_f * PUMP_FORCE_SCALE)
			pump_used_expand = true

	if _tool == Tool.PULL and _drag_point_idx >= 0:
		var pts: PackedVector2Array = _world.get_positions()
		if _drag_point_idx < pts.size():
			var mouse := get_global_mouse_position()
			var gesture := mouse - _grab_mouse_world
			var pull_k: float = _slider_pull.value if _slider_pull else 720.0
			_world.apply_external_force_point(_drag_point_idx, gesture * pull_k * PULL_FORCE_SCALE)

	if _chk_keys and _chk_keys.button_pressed:
		var pid := _player_blob_id()
		if pid >= 0:
			_gather_input()
			_world.apply_blob_move_force(pid, _move_input, MOVE_FORCE)
			if _expand_pressed and not pump_used_expand:
				_world.apply_blob_expand(pid, EXPAND_FORCE)


func _gather_input() -> void:
	var x := Input.get_axis(&"move_left", &"move_right")
	_move_input = Vector2(x, 0.0)
	if MobileInput.stick.length_squared() > 0.0001:
		_move_input = Vector2(MobileInput.stick.x, 0.0)
	if absf(_move_input.x) > 1.0:
		_move_input.x = signf(_move_input.x)
	_expand_pressed = Input.is_action_pressed(&"expand") or MobileInput.expand_pressed


func _pointer_over_toolbar() -> bool:
	var c: Control = get_viewport().gui_get_hovered_control() as Control
	if c == null:
		return false
	return _toolbar_root != null and _toolbar_root.is_ancestor_of(c)


func _pick_nearest_point_in_blob(world_mouse: Vector2) -> int:
	var best_dist_sq := INF
	var best_idx := -1
	var positions: PackedVector2Array = _world.get_positions()
	for bi in range(_world.get_blob_count()):
		var poly: PackedVector2Array = _world.get_hull_polygon(bi)
		if poly.is_empty():
			continue
		if not CollisionSoftScript.is_point_in_polygon(world_mouse, poly):
			continue
		var rgv: Vector2i = _world.get_blob_mass_point_index_range(bi)
		for idx in range(rgv.x, rgv.y):
			var d := positions[idx].distance_squared_to(world_mouse)
			if d < best_dist_sq:
				best_dist_sq = d
				best_idx = idx
	return best_idx


func _pick_blob_at(world_mouse: Vector2) -> int:
	for bi in range(_world.get_blob_count()):
		var poly: PackedVector2Array = _world.get_hull_polygon(bi)
		if poly.is_empty():
			continue
		if CollisionSoftScript.is_point_in_polygon(world_mouse, poly):
			return bi
	return -1


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT:
			if event.pressed:
				if _pointer_over_toolbar():
					return
				var w := get_global_mouse_position()
				if _tool == Tool.FRAME:
					if _world:
						var fb: int = _pick_blob_at(w)
						if fb >= 0:
							_world.set_blob_shape_match_rest_scale(fb, FRAME_REST_SCALE)
					get_viewport().set_input_as_handled()
					return
				if _tool == Tool.PULL:
					_grab_mouse_world = w
					_drag_point_idx = _pick_nearest_point_in_blob(w)
					_pull_mouse_prev_world = w
					_pull_drag_vel_smooth = Vector2.ZERO
			else:
				if _tool == Tool.PULL and _drag_point_idx >= 0:
					var bid: int = _world.get_blob_id_for_point_index(_drag_point_idx)
					if bid >= 0:
						var mouse_now: Vector2 = get_global_mouse_position()
						var dt_rel: float = maxf(get_physics_process_delta_time(), 0.0001)
						var instant_vel: Vector2 = (mouse_now - _pull_mouse_prev_world) / dt_rel
						_pull_drag_vel_smooth = _pull_drag_vel_smooth.lerp(instant_vel, PULL_DRAG_VEL_SMOOTH)
						var throw_v: Vector2 = instant_vel * PULL_RELEASE_THROW_SCALE
						if throw_v.length_squared() < 2.25:
							throw_v = _pull_drag_vel_smooth * PULL_RELEASE_THROW_SCALE
						_world.apply_blob_linear_velocity_delta(bid, throw_v)
					_drag_point_idx = -1
			return

	if event is InputEventKey and event.pressed and not event.echo:
		match event.keycode:
			KEY_1:
				if _btn_pull:
					_btn_pull.button_pressed = true
				get_viewport().set_input_as_handled()
			KEY_2:
				if _btn_pump:
					_btn_pump.button_pressed = true
				get_viewport().set_input_as_handled()
			KEY_3:
				if _btn_frame:
					_btn_frame.button_pressed = true
				get_viewport().set_input_as_handled()
			KEY_TAB:
				_shape_idx = (_shape_idx + 1) % SHAPE_NAMES.size()
				_spawn_all_bodies()
				_update_hint()
				get_viewport().set_input_as_handled()
			KEY_R:
				_spawn_all_bodies()
				get_viewport().set_input_as_handled()
			KEY_O:
				_debug_mode = not _debug_mode
				if _chk_debug:
					_chk_debug.set_block_signals(true)
					_chk_debug.button_pressed = _debug_mode
					_chk_debug.set_block_signals(false)
				_update_hint()
				get_viewport().set_input_as_handled()


func _update_hint() -> void:
	if _hint == null:
		return
	var shape_name: String = SHAPE_NAMES[_shape_idx]
	var dbg := "ON" if _debug_mode else "OFF"
	var tname: String = "Pull"
	match _tool:
		Tool.PUMP:
			tname = "Pump"
		Tool.FRAME:
			tname = "Frame"
		_:
			tname = "Pull"
	var pull_v: float = _slider_pull.value if _slider_pull else 720.0
	var pump_v: float = _slider_pump.value if _slider_pump else 1100.0
	var dbg_extra := ""
	if _debug_mode:
		dbg_extra = (
			" Debug draw: springs (magenta = between blobs), cyan = shape-match target, "
			+ "yellow arrow = center velocity, orange = pump edge impulse."
		)
	_hint.text = (
		"Playground — first blob shape: %s (Tab). Respawn all: R. Debug: %s (O).%s\n"
		+ "Tool: %s  |  Pull: drag (strength %d × %s).  "
		+ "Pump: hover + Space — inflate (%d × %s/tick).  "
		+ "Frame: click blob — shape-match rest × %s.  Keys 1/2/3 switch tools.\n"
		+ "Camera fixed on scene center. Sliders: gravity, pump, pull. Optional keyboard on first blob."
	) % [
		shape_name,
		dbg,
		dbg_extra,
		tname,
		int(pull_v),
		str(PULL_FORCE_SCALE),
		int(pump_v),
		str(PUMP_FORCE_SCALE),
		str(FRAME_REST_SCALE),
	]


func _draw() -> void:
	if _world == null or _world.get_blob_count() < 1:
		return
	var pts: PackedVector2Array = _world.get_positions()

	if _debug_mode:
		_draw_debug(pts)
	else:
		for bi in range(_world.get_blob_count()):
			var hp: PackedVector2Array = _world.get_hull_polygon(bi)
			var hn: int = hp.size()
			if hn < 2:
				continue
			var col: Color = _fill_color
			if bi < _blob_colors.size():
				col = _blob_colors[bi]
			col.a = minf(col.a, 0.95)
			for i in range(hn):
				var j: int = (i + 1) % hn
				draw_line(to_local(hp[i]), to_local(hp[j]), col, HULL_LINE_WIDTH)

	if _tool == Tool.PULL and _drag_point_idx >= 0 and Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT):
		var a := _grab_mouse_world
		var b := get_global_mouse_position()
		draw_line(to_local(a), to_local(b), Color(0.35, 0.82, 1.0, 0.5), 2.0)
		draw_arc(to_local(a), 5.0, 0.0, TAU, 12, Color(0.35, 0.82, 1.0, 0.65), 1.5, true)

	if (
			_tool == Tool.PUMP
			and (Input.is_action_pressed(&"expand") or MobileInput.expand_pressed)
			and not _pointer_over_toolbar()
	):
		var hb_draw: int = _pick_blob_at(get_global_mouse_position())
		if hb_draw >= 0:
			var poly: PackedVector2Array = _world.get_hull_polygon(hb_draw)
			if poly.size() >= 2:
				var cx := Vector2.ZERO
				for p in poly:
					cx += p
				cx /= float(poly.size())
				draw_arc(to_local(cx), 14.0, 0.0, TAU, 24, Color(1.0, 0.55, 0.35, 0.45), 2.0, false)

	if _tool == Tool.FRAME and not _pointer_over_toolbar():
		var hb_f: int = _pick_blob_at(get_global_mouse_position())
		if hb_f >= 0:
			var poly_f: PackedVector2Array = _world.get_hull_polygon(hb_f)
			if poly_f.size() >= 2:
				var cxf := Vector2.ZERO
				for p in poly_f:
					cxf += p
				cxf /= float(poly_f.size())
				draw_arc(to_local(cxf), 18.0, 0.0, TAU, 28, Color(0.55, 0.95, 0.65, 0.55), 2.25, false)


func _draw_arrow_world(origin_world: Vector2, vector_world: Vector2, color: Color, width: float) -> void:
	var o: Vector2 = to_local(origin_world)
	var tip: Vector2 = to_local(origin_world + vector_world)
	draw_line(o, tip, color, width)
	var len: float = vector_world.length()
	if len < 2.0:
		return
	var d: Vector2 = vector_world / len
	var head: float = clampf(len * 0.28, 6.0, 18.0)
	var side: float = head * 0.42
	var base_w: Vector2 = origin_world + vector_world - d * head
	var tip_w: Vector2 = origin_world + vector_world
	var p: Vector2 = Vector2(-d.y, d.x)
	draw_line(to_local(tip_w), to_local(base_w + p * side), color, width)
	draw_line(to_local(tip_w), to_local(base_w - p * side), color, width)


func _draw_debug(pts: PackedVector2Array) -> void:
	var vels: PackedVector2Array = _world.get_velocities()

	# Springs: same blob vs different blobs / loose particles.
	var pairs: Array = _world.get_spring_index_pairs()
	for p in pairs:
		var ia: int = p[0]
		var ib: int = p[1]
		var ba: int = _world.get_blob_id_for_point_index(ia)
		var bb: int = _world.get_blob_id_for_point_index(ib)
		var inter: bool = ba >= 0 and bb >= 0 and ba != bb
		var col: Color = Color(0.95, 0.45, 0.95, 0.72) if inter else Color(0.35, 0.95, 0.45, 0.38)
		var w: float = 1.65 if inter else 1.0
		draw_line(to_local(pts[ia]), to_local(pts[ib]), col, w)

	# Shape-matching target frame (rest pose in estimated orientation + scale).
	for bi in range(_world.get_blob_count()):
		var target: PackedVector2Array = _world.get_blob_shape_match_target_hull(bi)
		var tn: int = target.size()
		if tn >= 2:
			var tc := Color(0.55, 0.75, 1.0, 0.55)
			for i in range(tn):
				var j: int = (i + 1) % tn
				draw_line(to_local(target[i]), to_local(target[j]), tc, 1.75)

	# Current hull outline.
	for bi in range(_world.get_blob_count()):
		var hp: PackedVector2Array = _world.get_hull_polygon(bi)
		var hn: int = hp.size()
		if hn < 2:
			continue
		for i in range(hn):
			var j: int = (i + 1) % hn
			draw_line(to_local(hp[i]), to_local(hp[j]), Color(1.0, 1.0, 0.95, 0.85), 2.0)

	# Center-of-mass velocity per blob.
	for bi in range(_world.get_blob_count()):
		var ci: int = _world.get_blob_center_point_index(bi)
		if ci < 0 or ci >= pts.size():
			continue
		var vw: Vector2 = vels[ci] * DEBUG_VEL_ARROW_SCALE
		if vw.length_squared() > 4.0:
			_draw_arrow_world(pts[ci], vw, Color(1.0, 0.85, 0.25, 0.9), 2.0)

	# Pump: edge impulse direction and budget (matches [method SoftBodyWorld.apply_blob_expand]).
	if (
			_tool == Tool.PUMP
			and (Input.is_action_pressed(&"expand") or MobileInput.expand_pressed)
			and not _pointer_over_toolbar()
	):
		var hb: int = _pick_blob_at(get_global_mouse_position())
		if hb >= 0:
			var pump_f: float = _slider_pump.value if _slider_pump else 1100.0
			var expand: float = pump_f * PUMP_FORCE_SCALE
			for e in _world.get_blob_pump_edge_impulses(hb, expand):
				var mid: Vector2 = e["mid"]
				var n_out: Vector2 = e["normal"]
				var imp: float = float(e["impulse"])
				var arrow: Vector2 = n_out * imp * DEBUG_PUMP_ARROW_SCALE
				_draw_arrow_world(mid, arrow, Color(1.0, 0.45, 0.2, 0.88), 2.25)

	var n_pts: int = _world.get_point_count()
	for i in range(n_pts):
		var c := Color(1.0, 0.92, 0.35, 0.75)
		var player_id: int = _player_blob_id()
		if player_id >= 0 and i == _world.get_blob_center_point_index(player_id):
			c = Color(1.0, 0.35, 0.35, 0.9)
		draw_circle(to_local(pts[i]), 4.0, c)
