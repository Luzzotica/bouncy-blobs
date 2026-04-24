extends Node
## Each physics frame, rebuilds [SoftBodyWorld] static collision from:
## - every [Polygon2D] under [member bounds_root] (level art / platforms drawn as polygons), and
## - every [CollisionObject2D] in group [code]softbody_collision[/code] (RigidBody2D, StaticBody2D, etc.),
##   using [CollisionPolygon2D] and [CollisionShape2D] (rectangle, convex, circle) in world space.
##
## Place this node **before** [SoftBodyWorld] in the tree (or lower [member process_priority]) so
## collision is ready when the soft solver runs. Default [code]process_priority = -100[/code].

const GROUP_SOFTBODY_COLLISION := "softbody_collision"

@export var soft_body_world_path: NodePath = ^"../SoftBodyWorld"
## Root whose [Polygon2D] descendants become static soft-body collision (e.g. [code]World[/code] or [code]World/LevelBounds[/code]).
@export var bounds_root_path: NodePath = ^"../World"
## Lower runs earlier in the physics frame; must run before [SoftBodyWorld] (default 0).
const SYNC_PHYSICS_PRIORITY := -100


func _ready() -> void:
	set_physics_process(true)
	process_priority = SYNC_PHYSICS_PRIORITY


func _physics_process(_delta: float) -> void:
	var world: SoftBodyWorld = get_node_or_null(soft_body_world_path) as SoftBodyWorld
	var root: Node = get_node_or_null(bounds_root_path)
	if world == null or root == null:
		return
	world.clear_static_polygons()
	_register_polygon2d_under(root, world)
	_register_grouped_collision_objects(world)


func _register_polygon2d_under(n: Node, world: SoftBodyWorld) -> void:
	if n is Polygon2D:
		var vis: Polygon2D = n as Polygon2D
		var poly := vis.polygon
		if poly.size() >= 3:
			var gp := PackedVector2Array()
			gp.resize(poly.size())
			for i in range(poly.size()):
				gp[i] = vis.to_global(poly[i])
			world.register_static_polygon(gp)
	for c in n.get_children():
		_register_polygon2d_under(c, world)


func _register_grouped_collision_objects(world: SoftBodyWorld) -> void:
	var nodes: Array[Node] = get_tree().get_nodes_in_group(GROUP_SOFTBODY_COLLISION)
	for node in nodes:
		if not (node is CollisionObject2D):
			continue
		var co: CollisionObject2D = node as CollisionObject2D
		for ch in co.get_children():
			if ch is CollisionPolygon2D:
				var poly := SoftCollisionShapeUtil.collision_polygon_to_world(ch as CollisionPolygon2D)
				if poly.size() >= 3:
					world.register_static_polygon(poly)
			elif ch is CollisionShape2D:
				var poly2 := SoftCollisionShapeUtil.collision_shape_to_world_polygon(ch as CollisionShape2D)
				if poly2.size() >= 3:
					world.register_static_polygon(poly2)
