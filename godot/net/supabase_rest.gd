extends Node
class_name SupabaseRest
## Minimal PostgREST client for Supabase (anon key). Add as child of [Lobby] or autoload.

var _base: String = ""
var _key: String = ""
var _http: HTTPRequest
var _request_lock: bool = false


func _ready() -> void:
	_http = HTTPRequest.new()
	add_child(_http)


func configure(base_url: String, anon_key: String) -> void:
	_base = base_url.rstrip("/")
	_key = anon_key


func is_ready() -> bool:
	return not _base.is_empty() and not _key.is_empty() and _http != null


func _headers() -> PackedStringArray:
	return PackedStringArray([
		"Content-Type: application/json",
		"apikey: %s" % _key,
		"Authorization: Bearer %s" % _key,
		"Prefer: return=representation",
	])


func post_json(path: String, body: Dictionary) -> Dictionary:
	## path like "/rest/v1/signaling"
	await _acquire_lock()
	var err := _http.request(_base + path, _headers(), HTTPClient.METHOD_POST, JSON.stringify(body))
	if err != OK:
		_release_lock()
		return {"ok": false, "error": "request_failed", "code": err}
	var args: Array = await _http.request_completed
	_release_lock()
	return _parse_response(args)


func get_json(path_with_query: String) -> Dictionary:
	await _acquire_lock()
	var err := _http.request(_base + path_with_query, PackedStringArray([
		"apikey: %s" % _key,
		"Authorization: Bearer %s" % _key,
	]), HTTPClient.METHOD_GET)
	if err != OK:
		_release_lock()
		return {"ok": false, "error": "request_failed", "code": err}
	var args: Array = await _http.request_completed
	_release_lock()
	return _parse_response(args)


func _acquire_lock() -> void:
	while _request_lock:
		await get_tree().process_frame
	_request_lock = true


func _release_lock() -> void:
	_request_lock = false


func _parse_response(args: Array) -> Dictionary:
	var result: int = args[0]
	var code: int = args[1]
	var body: PackedByteArray = args[3]
	var text := body.get_string_from_utf8()
	if result != HTTPRequest.RESULT_SUCCESS:
		return {"ok": false, "error": "http_result", "result": result, "code": code}
	if code < 200 or code >= 300:
		return {"ok": false, "error": "status", "code": code, "body": text}
	if text.is_empty():
		return {"ok": true, "data": []}
	var parsed: Variant = JSON.parse_string(text)
	if parsed == null:
		return {"ok": false, "error": "json", "body": text}
	return {"ok": true, "data": parsed}
