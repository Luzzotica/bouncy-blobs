extends CanvasLayer
## Left drag = move, right button = expand. Hidden on desktop unless touchscreen.

@onready var _stick_base: Control = %StickBase
@onready var _stick_knob: Control = %StickKnob
@onready var _expand_btn: Button = %ExpandBtn

var _stick_id: int = -1
var _stick_radius: float = 72.0


func _ready() -> void:
	visible = DisplayServer.is_touchscreen_available() or OS.has_feature("mobile")
	_expand_btn.button_down.connect(func() -> void: MobileInput.expand_pressed = true)
	_expand_btn.button_up.connect(func() -> void: MobileInput.expand_pressed = false)
	call_deferred(&"_reset_knob")


func _process(_delta: float) -> void:
	if not visible:
		MobileInput.stick = Vector2.ZERO
		return
	if _stick_id < 0:
		MobileInput.stick = Vector2.ZERO


func _input(event: InputEvent) -> void:
	if not visible:
		return
	var rect := _stick_base.get_global_rect()
	if event is InputEventScreenTouch:
		var st := event as InputEventScreenTouch
		if st.pressed and rect.has_point(st.position) and _stick_id < 0:
			_stick_id = st.index
			_move_knob(st.position)
		elif not st.pressed and st.index == _stick_id:
			_stick_id = -1
			_reset_knob()
	elif event is InputEventScreenDrag and event.index == _stick_id:
		_move_knob((event as InputEventScreenDrag).position)


func _move_knob(screen_pos: Vector2) -> void:
	var center := _stick_base.global_position + _stick_base.size * 0.5
	var delta := screen_pos - center
	var len := delta.length()
	if len > _stick_radius:
		delta = delta * (_stick_radius / len)
	MobileInput.stick = delta / _stick_radius
	_stick_knob.position = _stick_base.size * 0.5 - _stick_knob.size * 0.5 + delta


func _reset_knob() -> void:
	MobileInput.stick = Vector2.ZERO
	_stick_knob.position = _stick_base.size * 0.5 - _stick_knob.size * 0.5
