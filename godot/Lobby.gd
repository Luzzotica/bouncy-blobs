extends Node
## WebSocket multiplayer lobby (works in HTML5; use ws:// or wss:// URLs).
## WebRTC over Supabase signaling: [method host_webrtc] / [method join_webrtc] ([WebRtcSupabaseNetwork]).

const DEFAULT_PORT := 9080
const GAME_SCENE := "res://game.tscn"
const WebRtcSupabaseNetworkScript := preload("res://net/webrtc_supabase_network.gd")

var game_in_progress: bool = false

## Emitted when the WebRTC data channel / multiplayer link is up (host: peer joined; client: connected to host).
signal webrtc_ready
signal webrtc_failed(reason: String)
## Remote controller clients call [method submit_controller_input]; host can listen here to drive a player slot.
signal controller_input_received(sender_peer_id: int, move: Vector2, expand_pressed: bool)

var _webrtc

func _ready() -> void:
	_webrtc = WebRtcSupabaseNetworkScript.new()
	add_child(_webrtc)
	_webrtc.webrtc_connected.connect(webrtc_ready.emit)
	_webrtc.webrtc_connection_failed.connect(_on_webrtc_connection_failed)
	_ensure_default_input_map()
	multiplayer.peer_connected.connect(_on_peer_connected)
	multiplayer.peer_disconnected.connect(_on_peer_disconnected)
	multiplayer.connected_to_server.connect(_on_connected_ok)
	multiplayer.connection_failed.connect(_on_connection_failed)
	multiplayer.server_disconnected.connect(_on_server_disconnected)


func host(port: int = DEFAULT_PORT) -> Error:
	var p := WebSocketMultiplayerPeer.new()
	var err := p.create_server(port)
	if err != OK:
		return err
	multiplayer.multiplayer_peer = p
	return OK


func join(url: String) -> Error:
	var p := WebSocketMultiplayerPeer.new()
	var err := p.create_client(url)
	if err != OK:
		return err
	multiplayer.multiplayer_peer = p
	return OK


func host_webrtc(session_id: int) -> Error:
	disconnect_multiplayer()
	return _webrtc.start_host(session_id)


func join_webrtc(session_id: int) -> Error:
	disconnect_multiplayer()
	return _webrtc.start_client(session_id)


func _on_webrtc_connection_failed(reason: String) -> void:
	push_warning("WebRTC: %s" % reason)
	webrtc_failed.emit(reason)


func _ensure_default_input_map() -> void:
	# Add each action only if missing. Do not bail when move_left exists but expand does not
	# (otherwise Space / pump and slime expand never get registered).
	if not InputMap.has_action(&"move_left"):
		_add_key_action(&"move_left", KEY_A)
	if not InputMap.has_action(&"move_right"):
		_add_key_action(&"move_right", KEY_D)
	if not InputMap.has_action(&"move_up"):
		_add_key_action(&"move_up", KEY_W)
	if not InputMap.has_action(&"move_down"):
		_add_key_action(&"move_down", KEY_S)
	if not InputMap.has_action(&"expand"):
		_add_key_action(&"expand", KEY_SPACE)


func _add_key_action(action: StringName, keycode: Key) -> void:
	InputMap.add_action(action)
	var ev := InputEventKey.new()
	ev.physical_keycode = keycode
	InputMap.action_add_event(action, ev)


func disconnect_multiplayer() -> void:
	game_in_progress = false
	if _webrtc:
		_webrtc.stop()
	if multiplayer.multiplayer_peer:
		multiplayer.multiplayer_peer.close()
		multiplayer.multiplayer_peer = null


func begin_game_from_host() -> void:
	if not multiplayer.is_server():
		return
	begin_game.rpc(GAME_SCENE)


@rpc("authority", "call_local", "reliable")
func begin_game(path: String) -> void:
	get_tree().change_scene_to_file(path)


@rpc("authority", "reliable")
func client_begin_game(path: String) -> void:
	get_tree().change_scene_to_file(path)


func _on_peer_connected(id: int) -> void:
	if multiplayer.is_server() and id != 1 and game_in_progress:
		client_begin_game.rpc_id(id, GAME_SCENE)


func _on_peer_disconnected(_id: int) -> void:
	pass


func _on_connected_ok() -> void:
	pass


func _on_connection_failed() -> void:
	pass


func _on_server_disconnected() -> void:
	pass


@rpc("any_peer", "call_remote", "unreliable")
func submit_controller_input(move: Vector2, expand_pressed: bool) -> void:
	if not multiplayer.is_server():
		return
	var sender := multiplayer.get_remote_sender_id()
	controller_input_received.emit(sender, move, expand_pressed)
