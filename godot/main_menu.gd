extends Control

@onready var _port: SpinBox = %Port
@onready var _address: LineEdit = %Address
@onready var _session_id: LineEdit = %SessionId
@onready var _status: Label = %Status
@onready var _host: Button = %Host
@onready var _join: Button = %Join
@onready var _host_webrtc: Button = %HostWebRTC
@onready var _join_webrtc: Button = %JoinWebRTC
@onready var _start: Button = %Start
@onready var _disconnect_btn: Button = %Disconnect


func _ready() -> void:
	_port.value = Lobby.DEFAULT_PORT
	_address.text = "ws://127.0.0.1:%d" % int(_port.value)
	_port.value_changed.connect(_on_port_changed)
	_host.pressed.connect(_on_host_pressed)
	_join.pressed.connect(_on_join_pressed)
	_host_webrtc.pressed.connect(_on_host_webrtc_pressed)
	_join_webrtc.pressed.connect(_on_join_webrtc_pressed)
	_start.pressed.connect(_on_start_pressed)
	_disconnect_btn.pressed.connect(_on_disconnect_pressed)
	multiplayer.connected_to_server.connect(_on_connected)
	multiplayer.connection_failed.connect(_on_failed)
	multiplayer.server_disconnected.connect(_on_server_gone)
	Lobby.webrtc_ready.connect(_on_webrtc_ready)
	Lobby.webrtc_failed.connect(_on_webrtc_failed)
	_refresh_ui()


func _on_port_changed(value: float) -> void:
	_address.text = "ws://127.0.0.1:%d" % int(value)


func _parse_session_id() -> int:
	var t := _session_id.text.strip_edges()
	if t.is_empty():
		return 0
	if t.is_valid_int():
		return int(t)
	return 0


func _on_host_pressed() -> void:
	var err := Lobby.host(int(_port.value))
	if err != OK:
		_status.text = "Host failed: %s" % error_string(err)
		return
	_status.text = "Hosting on port %d — share this URL with phones / other tabs: ws://<your-ip>:%d" % [int(_port.value), int(_port.value)]
	_refresh_ui()


func _on_join_pressed() -> void:
	var err := Lobby.join(_address.text.strip_edges())
	if err != OK:
		_status.text = "Join failed: %s" % error_string(err)
		return
	_status.text = "Connecting…"


func _on_host_webrtc_pressed() -> void:
	var sid := _parse_session_id()
	if sid < 1:
		_status.text = "Enter a valid session id (matches game_sessions.session_id in Supabase)."
		return
	var err := Lobby.host_webrtc(sid)
	if err != OK:
		_status.text = "WebRTC host failed: %s" % error_string(err)
		return
	_status.text = "WebRTC hosting — session %d. Waiting for a peer…" % sid
	_refresh_ui()


func _on_join_webrtc_pressed() -> void:
	var sid := _parse_session_id()
	if sid < 1:
		_status.text = "Enter a valid session id (matches game_sessions.session_id in Supabase)."
		return
	var err := Lobby.join_webrtc(sid)
	if err != OK:
		_status.text = "WebRTC join failed: %s" % error_string(err)
		return
	_status.text = "WebRTC connecting (signaling + ICE)…"


func _on_start_pressed() -> void:
	Lobby.begin_game_from_host()


func _on_disconnect_pressed() -> void:
	Lobby.disconnect_multiplayer()
	_status.text = "Disconnected."
	_refresh_ui()


func _on_connected() -> void:
	_status.text = "Connected — waiting for host to start."
	_refresh_ui()


func _on_webrtc_ready() -> void:
	_status.text = "WebRTC connected — waiting for host to start (or press Start if you are host)."
	_refresh_ui()


func _on_webrtc_failed(reason: String) -> void:
	_status.text = "WebRTC: %s" % reason
	_refresh_ui()


func _on_failed() -> void:
	_status.text = "Connection failed."
	_refresh_ui()


func _on_server_gone() -> void:
	_status.text = "Server disconnected."
	_refresh_ui()


func _refresh_ui() -> void:
	var active := multiplayer.multiplayer_peer != null
	var is_host := active and multiplayer.is_server()
	_host.disabled = active
	_join.disabled = active
	_host_webrtc.disabled = active
	_join_webrtc.disabled = active
	_start.visible = is_host
	_disconnect_btn.visible = active
