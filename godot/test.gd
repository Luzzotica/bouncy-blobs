extends Node2D

const SLIME_SCENE := preload("res://slime_blob.tscn")

@onready var _soft_world: Variant = $SoftBodyWorld
@onready var _blob: Node2D = null


func _ready() -> void:
	_register_static_polygons()
	_blob = SLIME_SCENE.instantiate()
	_blob.name = "1"
	_blob.set_multiplayer_authority(1)
	_blob.position = Vector2(0, 180)
	$Players.add_child(_blob, true)

	_spawn_npc_slime("npc_left", Vector2(-300, 180), 0.08)
	_spawn_npc_slime("npc_right", Vector2(300, 180), 0.62)


func _spawn_npc_slime(node_name: String, local_pos: Vector2, hue: float) -> void:
	var npc := SLIME_SCENE.instantiate()
	npc.name = node_name
	npc.player_controlled = false
	npc.npc_hue = hue
	npc.position = local_pos
	$Players.add_child(npc, true)


func _register_static_polygons() -> void:
	_register_polygon_from_vis($World/Floor/FloorVis)
	_register_polygon_from_vis($World/WallLeft/WallVis)
	_register_polygon_from_vis($World/WallRight/WallVis)
	_register_polygon_from_vis($World/Ceiling/CeilingVis)


func _register_polygon_from_vis(vis: Polygon2D) -> void:
	var poly := vis.polygon
	var gp := PackedVector2Array()
	gp.resize(poly.size())
	for i in range(poly.size()):
		gp[i] = vis.to_global(poly[i])
	_soft_world.register_static_polygon(gp)


func _process(_delta: float) -> void:
	if _blob:
		$Camera2D.global_position = _blob.global_position
