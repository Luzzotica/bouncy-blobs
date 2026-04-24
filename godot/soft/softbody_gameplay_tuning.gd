extends RefCounted
## Default spring / pressure / shape-match parameters shared by slime blobs and the softbody playground.
## Reference constants via [code]preload("res://soft/softbody_gameplay_tuning.gd")[/code].


const SPRING_K := 55.0
const SPRING_DAMP := 3.5
const RADIAL_K := 75.0
const RADIAL_DAMP := 4.2
const PRESSURE_K := 0.12
const SHAPE_MATCH_K := 88.0
const SHAPE_MATCH_DAMP := 3.85
const CENTER_MASS := 0.2
const HULL_MASS := 0.12
