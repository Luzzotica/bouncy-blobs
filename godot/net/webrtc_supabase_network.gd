extends Node
class_name WebRtcSupabaseNetwork
## Hosts or joins a [WebRTCMultiplayerPeer] using Supabase [code]signaling[/code] table (same shape as [code]reference/src/services/signalingService.ts[/code]).
## Host (Godot peer [code]1[/code]) creates the SDP offer for peer [code]2[/code]; the joining client calls [method start_client].

signal webrtc_connection_failed(reason: String)
signal webrtc_connected

const POLL_SEC := 0.5
const TARGET_PEER_ID := 2
const ROLE_GM := "gamemaster"
const ROLE_CTRL := "controller"
const SupabaseRestScript := preload("res://net/supabase_rest.gd")
const SupabaseConfigScript := preload("res://config/supabase_config.gd")

var _session_id: int = 0
var _rtc: WebRTCMultiplayerPeer = WebRTCMultiplayerPeer.new()
var _rest
var _poll_t: float = 0.0
var _mode: String = "" # "host" | "client"
var _processed: Dictionary = {} # sdp hash -> true
var _client_pc_ready: bool = false
var _mp_peer_connected_cb: Callable = Callable()
var _mp_connected_to_server_cb: Callable = Callable()


func _ready() -> void:
	_rest = SupabaseRestScript.new()
	add_child(_rest)
	_rest.configure(SupabaseConfigScript.get_url(), SupabaseConfigScript.get_anon_key())


func _process(delta: float) -> void:
	if _mode.is_empty():
		return
	_rtc.poll()
	_poll_t += delta
	if _poll_t < POLL_SEC:
		return
	_poll_t = 0.0
	if _mode == "host":
		_poll_host_pipeline()
	else:
		_poll_client_pipeline()


func start_host(session_id: int) -> Error:
	if not SupabaseConfigScript.is_configured():
		webrtc_connection_failed.emit("Supabase not configured (copy config/supabase_env.example → config/supabase.env).")
		return ERR_UNAVAILABLE
	_session_id = session_id
	_mode = "host"
	_processed.clear()
	var err := _rtc.create_server()
	if err != OK:
		webrtc_connection_failed.emit("create_server failed: %s" % error_string(err))
		return err
	get_tree().get_multiplayer().multiplayer_peer = _rtc
	_register_host_signals()
	_host_add_peer_and_offer()
	return OK


func start_client(session_id: int) -> Error:
	if not SupabaseConfigScript.is_configured():
		webrtc_connection_failed.emit("Supabase not configured.")
		return ERR_UNAVAILABLE
	_session_id = session_id
	_mode = "client"
	_processed.clear()
	var err := _rtc.create_client(TARGET_PEER_ID)
	if err != OK:
		webrtc_connection_failed.emit("create_client failed: %s" % error_string(err))
		return err
	get_tree().get_multiplayer().multiplayer_peer = _rtc
	_register_client_signals()
	_client_add_peer_for_host()
	return OK


func stop() -> void:
	_unregister_mp_signals()
	_mode = ""
	_poll_t = 0.0
	_processed.clear()
	_client_pc_ready = false
	if get_tree() and get_tree().get_multiplayer():
		get_tree().get_multiplayer().multiplayer_peer = OfflineMultiplayerPeer.new()
	_rtc.close()


func _configure_rest() -> bool:
	_rest.configure(SupabaseConfigScript.get_url(), SupabaseConfigScript.get_anon_key())
	return _rest.is_ready()


func _register_host_signals() -> void:
	_unregister_mp_signals()
	_mp_peer_connected_cb = _on_mp_peer_connected
	get_tree().get_multiplayer().peer_connected.connect(_mp_peer_connected_cb)


func _register_client_signals() -> void:
	_unregister_mp_signals()
	_mp_connected_to_server_cb = _on_mp_connected_to_server
	get_tree().get_multiplayer().connected_to_server.connect(_mp_connected_to_server_cb)


func _unregister_mp_signals() -> void:
	var mp := get_tree().get_multiplayer() if get_tree() else null
	if mp == null:
		return
	if _mp_peer_connected_cb.is_valid() and mp.peer_connected.is_connected(_mp_peer_connected_cb):
		mp.peer_connected.disconnect(_mp_peer_connected_cb)
	if _mp_connected_to_server_cb.is_valid() and mp.connected_to_server.is_connected(_mp_connected_to_server_cb):
		mp.connected_to_server.disconnect(_mp_connected_to_server_cb)
	_mp_peer_connected_cb = Callable()
	_mp_connected_to_server_cb = Callable()


func _on_mp_peer_connected(_peer_id: int) -> void:
	if _mode == "host":
		webrtc_connected.emit()


func _on_mp_connected_to_server() -> void:
	if _mode == "client":
		webrtc_connected.emit()


func _poll_host_pipeline() -> void:
	await _poll_host()


func _poll_client_pipeline() -> void:
	if not _client_pc_ready:
		return
	await _poll_client()


func _host_add_peer_and_offer() -> void:
	var pc := WebRTCPeerConnection.new()
	pc.initialize({
		"iceServers": [{"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}],
	})
	pc.session_description_created.connect(_on_host_session_created.bind(pc, TARGET_PEER_ID))
	pc.ice_candidate_created.connect(_on_host_ice_candidate.bind(TARGET_PEER_ID))
	_rtc.add_peer(pc, TARGET_PEER_ID)
	pc.create_offer()


func _on_host_session_created(pc: WebRTCPeerConnection, target_peer_id: int, type: String, sdp: String) -> void:
	pc.set_local_description(type, sdp)
	if type != "offer":
		return
	var row := {
		"session_id": _session_id,
		"role": ROLE_GM,
		"player_id": str(target_peer_id),
		"offer": {"type": type, "sdp": sdp},
	}
	var res: Dictionary = await _rest.post_json("/rest/v1/signaling", row)
	if not res.get("ok", false):
		webrtc_connection_failed.emit("Failed to post offer: %s" % str(res))


func _on_host_ice_candidate(target_peer_id: int, mid_name: String, mline_index: int, sdp_name: String) -> void:
	var row := {
		"session_id": _session_id,
		"role": ROLE_GM,
		"player_id": str(target_peer_id),
		"ice_candidate": {
			"candidate": sdp_name,
			"sdpMLineIndex": mline_index,
			"sdpMid": mid_name,
		},
	}
	var res: Dictionary = await _rest.post_json("/rest/v1/signaling", row)
	if not res.get("ok", false):
		push_warning("ICE post failed: %s" % str(res))


func _client_add_peer_for_host() -> void:
	var pc := WebRTCPeerConnection.new()
	pc.initialize({
		"iceServers": [{"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}],
	})
	pc.session_description_created.connect(_on_client_local_description.bind(pc))
	pc.ice_candidate_created.connect(_on_client_ice_candidate)
	_rtc.add_peer(pc, 1)
	_client_pc_ready = true


func _on_client_local_description(pc: WebRTCPeerConnection, type: String, sdp: String) -> void:
	pc.set_local_description(type, sdp)
	if type != "answer":
		return
	var row := {
		"session_id": _session_id,
		"role": ROLE_CTRL,
		"player_id": str(TARGET_PEER_ID),
		"answer": {"type": type, "sdp": sdp},
	}
	var res: Dictionary = await _rest.post_json("/rest/v1/signaling", row)
	if not res.get("ok", false):
		webrtc_connection_failed.emit("Failed to post answer: %s" % str(res))


func _on_client_ice_candidate(mid_name: String, mline_index: int, sdp_name: String) -> void:
	var row := {
		"session_id": _session_id,
		"role": ROLE_CTRL,
		"player_id": str(TARGET_PEER_ID),
		"ice_candidate": {
			"candidate": sdp_name,
			"sdpMLineIndex": mline_index,
			"sdpMid": mid_name,
		},
	}
	var res: Dictionary = await _rest.post_json("/rest/v1/signaling", row)
	if not res.get("ok", false):
		push_warning("Client ICE post failed: %s" % str(res))


func _poll_host() -> void:
	await _poll_host_answers()
	await _poll_host_ice_from_client()


func _poll_host_answers() -> void:
	var q := (
		"/rest/v1/signaling?session_id=eq.%d&role=eq.%s&answer=not.is.null&order=created_at.desc&limit=10"
		% [_session_id, ROLE_CTRL]
	)
	var res: Dictionary = await _rest.get_json(q)
	if not res.get("ok", false):
		return
	var data: Variant = res.get("data", [])
	if typeof(data) != TYPE_ARRAY:
		return
	for row in data:
		if typeof(row) != TYPE_DICTIONARY:
			continue
		var ans: Variant = row.get("answer", null)
		if ans == null or typeof(ans) != TYPE_DICTIONARY:
			continue
		var sdp: String = str(ans.get("sdp", ""))
		var h := sdp.substr(0, min(64, sdp.length()))
		if _processed.has("a:" + h):
			continue
		_processed["a:" + h] = true
		if not _rtc.has_peer(TARGET_PEER_ID):
			continue
		var conn: WebRTCPeerConnection = _rtc.get_peer(TARGET_PEER_ID)["connection"]
		if conn.get_signaling_state() != WebRTCPeerConnection.SIGNALING_STATE_HAVE_LOCAL_OFFER:
			continue
		var err := conn.set_remote_description("answer", sdp)
		if err != OK:
			push_warning("set_remote_description answer failed: %s" % error_string(err))


func _poll_host_ice_from_client() -> void:
	var q := (
		"/rest/v1/signaling?session_id=eq.%d&role=eq.%s&ice_candidate=not.is.null&order=created_at.desc&limit=30"
		% [_session_id, ROLE_CTRL]
	)
	var res: Dictionary = await _rest.get_json(q)
	if not res.get("ok", false):
		return
	var data: Variant = res.get("data", [])
	if typeof(data) != TYPE_ARRAY:
		return
	for row in data:
		if typeof(row) != TYPE_DICTIONARY:
			continue
		var ice: Variant = row.get("ice_candidate", null)
		if ice == null or typeof(ice) != TYPE_DICTIONARY:
			continue
		var cand: String = str(ice.get("candidate", ""))
		var mid: String = str(ice.get("sdpMid", ""))
		var idx: int = int(ice.get("sdpMLineIndex", 0))
		var h := cand.substr(0, min(48, cand.length()))
		if _processed.has("icec:" + h):
			continue
		_processed["icec:" + h] = true
		if not _rtc.has_peer(TARGET_PEER_ID):
			continue
		var conn: WebRTCPeerConnection = _rtc.get_peer(TARGET_PEER_ID)["connection"]
		conn.add_ice_candidate(mid, idx, cand)


func _poll_client() -> void:
	if not _client_pc_ready:
		return
	await _poll_client_offer()
	await _poll_client_ice_from_host()


func _poll_client_offer() -> void:
	var q := (
		"/rest/v1/signaling?session_id=eq.%d&role=eq.%s&player_id=eq.%s&offer=not.is.null&order=created_at.desc&limit=1"
		% [_session_id, ROLE_GM, str(TARGET_PEER_ID)]
	)
	var res: Dictionary = await _rest.get_json(q)
	if not res.get("ok", false):
		return
	var data: Variant = res.get("data", [])
	if typeof(data) != TYPE_ARRAY or data.is_empty():
		return
	var row: Dictionary = data[0]
	var offer: Variant = row.get("offer", null)
	if offer == null or typeof(offer) != TYPE_DICTIONARY:
		return
	var sdp: String = str(offer.get("sdp", ""))
	var h := sdp.substr(0, min(64, sdp.length()))
	if _processed.has("o:" + h):
		return
	_processed["o:" + h] = true
	if not _rtc.has_peer(1):
		return
	var conn: WebRTCPeerConnection = _rtc.get_peer(1)["connection"]
	if conn.get_signaling_state() != WebRTCPeerConnection.SIGNALING_STATE_STABLE:
		return
	var err := conn.set_remote_description("offer", sdp)
	if err != OK:
		push_warning("set_remote_description offer failed: %s" % error_string(err))
		return
	conn.create_answer()


func _poll_client_ice_from_host() -> void:
	var q := (
		"/rest/v1/signaling?session_id=eq.%d&role=eq.%s&ice_candidate=not.is.null&order=created_at.desc&limit=30"
		% [_session_id, ROLE_GM]
	)
	var res: Dictionary = await _rest.get_json(q)
	if not res.get("ok", false):
		return
	var data: Variant = res.get("data", [])
	if typeof(data) != TYPE_ARRAY:
		return
	for row in data:
		if typeof(row) != TYPE_DICTIONARY:
			continue
		var ice: Variant = row.get("ice_candidate", null)
		if ice == null or typeof(ice) != TYPE_DICTIONARY:
			continue
		var cand: String = str(ice.get("candidate", ""))
		var mid: String = str(ice.get("sdpMid", ""))
		var idx: int = int(ice.get("sdpMLineIndex", 0))
		var h := cand.substr(0, min(48, cand.length()))
		if _processed.has("iceh:" + h):
			continue
		_processed["iceh:" + h] = true
		if not _rtc.has_peer(1):
			continue
		var conn: WebRTCPeerConnection = _rtc.get_peer(1)["connection"]
		conn.add_ice_candidate(mid, idx, cand)
