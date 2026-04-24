extends Node2D

const SLIME_SCENE := preload("res://slime_blob.tscn")
const SlimeBlobScript := preload("res://slime_blob.gd")

@onready var _players: Node2D = $Players
@onready var _props: Node2D = $Props
@onready var _soft_world: Variant = $SoftBodyWorld


func _ready() -> void:
	if _soft_world:
		_soft_world.substeps = 4
	$MultiplayerSpawner.add_spawnable_scene("res://slime_blob.tscn")
	Lobby.game_in_progress = true
	multiplayer.peer_connected.connect(_on_peer_connected)
	if multiplayer.multiplayer_peer == null:
		_spawn_for_peer(1)
	elif multiplayer.is_server():
		_spawn_for_peer(1)
		for peer_id in multiplayer.get_peers():
			_spawn_for_peer(peer_id)
	call_deferred("_spawn_soft_props")


func _on_peer_connected(peer_id: int) -> void:
	if multiplayer.is_server():
		_spawn_for_peer(peer_id)


func _spawn_for_peer(peer_id: int) -> void:
	if _players.has_node(str(peer_id)):
		return
	var slime: Node2D = SLIME_SCENE.instantiate()
	slime.name = str(peer_id)
	slime.set_multiplayer_authority(peer_id)
	slime.hull_preset = SlimeBlobScript.HullPreset.CIRCLE_16
	var x := float((peer_id % 5) - 2) * 220.0
	slime.position = Vector2(x, 380.0)
	_players.add_child(slime, true)


func _spawn_soft_props() -> void:
	if _props == null or SLIME_SCENE == null:
		return
	var defs: Array[Dictionary] = [
		{"preset": SlimeBlobScript.HullPreset.SQUARE, "pos": Vector2(-920, 320), "hue": 0.08},
		{"preset": SlimeBlobScript.HullPreset.TRIANGLE, "pos": Vector2(920, 320), "hue": 0.33},
		{"preset": SlimeBlobScript.HullPreset.STAR, "pos": Vector2(-520, 620), "hue": 0.12},
		{"preset": SlimeBlobScript.HullPreset.DIAMOND, "pos": Vector2(520, 620), "hue": 0.75},
		{"preset": SlimeBlobScript.HullPreset.HEX, "pos": Vector2(0, 920), "hue": 0.45},
	]
	var i := 0
	for d in defs:
		var prop: Node2D = SLIME_SCENE.instantiate() as Node2D
		if prop == null:
			continue
		prop.player_controlled = false
		prop.hull_preset = d["preset"]
		prop.npc_hue = d["hue"]
		prop.global_position = d["pos"]
		prop.name = "SoftProp_%d" % i
		i += 1
		_props.add_child(prop, true)


func _process(_delta: float) -> void:
	var my_id := multiplayer.get_unique_id()
	if multiplayer.multiplayer_peer == null:
		my_id = 1
	var mine := _players.get_node_or_null(str(my_id))
	if mine:
		$Camera2D.global_position = mine.global_position
