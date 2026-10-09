//! Importer for the legacy (TS app, `version: 1`) level JSON.
//!
//! The legacy format is **y-down**, rects are **centre-anchored**, angles are
//! radians (clockwise-positive on screen because y is down), and the world was
//! tuned for a 48 px blob under 3920 px/s² gravity. The v3 format is y-up and
//! tuned for a 32 px blob under 1800 px/s², so geometry is scaled by
//! [`ImportOptions::scale`] (default 2/3 = 32/48) to keep every gap and ledge
//! the same size *relative to the blob*.
//!
//! Mapping (see [`import_legacy`] for the lossy cases):
//!
//! | legacy | v3 |
//! |---|---|
//! | `platforms` (rotated rect) | `terrain` rect (material carried) |
//! | `walls` (polygon) | `terrain` poly |
//! | `spawnPoints` (player) | `spawn` = first player spawn |
//! | `npcBlobs` | `npcs` (Huddle, colour from hue) |
//! | `goalZones` / `hillZones` | `goal` (first) / `hills` |
//! | `gravityZones` uniform | `zones` Gravity (vector flipped + rescaled) |
//! | `gravityZones` point | 4 triangular Gravity zones aimed at the centre |
//! | `springPads` | `springs` (direction flipped, face position) |
//! | `spikes` | `spikes` (base line a→b, teeth up the local −y) |
//! | `deathZones` | `zones` Kill |
//! | `powerupSpawns` | `pickups` |
//! | `pointShapes` | Jelly (pinned / ≥2 anchors), Terrain (huge pinned hills), Prop Custom (free), Prop + rope (1 anchor), Mover (moved by an action) |
//! | `softPlatforms` | `platforms` with `Pins` from the anchor pattern |
//! | `triggers` | `story` trigger with script `plate:<id>` (`once: false`) |
//! | `actions` (movePoints) | the target becomes a `Mover` gated by the plate ids |
//! | `chains` | `ropes` (Chain style) |
//! | `sprites` | `decor` (`kind` = sprite id; collision dropped) |
//! | `dynamicItems` | wind/conveyor/goo/gravity zones, bumper jelly, cannon/catapult springs, wrecking-ball prop on a chain |
//!
//! Mover trigger strings (`Mover::trigger`) use the convention
//! `"<plate>[|<plate>…]"` (any) or `"<plate>&<plate>"` (all), optionally
//! suffixed `#toggle` (switch) or `#once` (one shot); no suffix = held
//! (continuous). bb-sim drives these from the `plate:` story triggers.

use std::collections::{HashMap, HashSet};

use glam::Vec2;
use serde::Deserialize;

use crate::types::*;

/// Legacy default gravity (px/s², y-down).
pub const LEGACY_GRAVITY: f32 = 3920.0;
/// v3 default gravity magnitude.
pub const GRAVITY: f32 = 1800.0;

#[derive(Clone, Debug)]
pub struct ImportOptions {
    /// Uniform geometry scale applied to every coordinate and size.
    pub scale: f32,
    /// Level id (defaults to a slug of the legacy name).
    pub id: Option<String>,
    /// Pinned point shapes larger than this (v3 px²) become solid terrain
    /// instead of jelly (a jelly mesh of a whole hillside is thousands of
    /// particles).
    pub max_jelly_area: f32,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions { scale: 2.0 / 3.0, id: None, max_jelly_area: 140_000.0 }
    }
}

#[derive(Debug)]
pub enum ImportError {
    Json(serde_json::Error),
    /// Parsed, but not a legacy level (e.g. already v3).
    NotLegacy(String),
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::Json(e) => write!(f, "invalid legacy level JSON: {e}"),
            ImportError::NotLegacy(s) => write!(f, "not a legacy level: {s}"),
        }
    }
}

impl std::error::Error for ImportError {}

impl From<serde_json::Error> for ImportError {
    fn from(e: serde_json::Error) -> Self {
        ImportError::Json(e)
    }
}

/// Result of an import: the level plus human-readable notes about anything
/// that could not be represented exactly.
#[derive(Clone, Debug)]
pub struct Imported {
    pub level: Level,
    pub notes: Vec<String>,
}

// ------------------------------------------------------------ legacy schema

#[derive(Deserialize, Clone, Copy, Debug, Default)]
struct P {
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct LRect {
    #[serde(default)]
    id: String,
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default)]
    width: f32,
    #[serde(default)]
    height: f32,
    #[serde(default)]
    rotation: f32,
    #[serde(default)]
    material: Option<String>,
}

#[derive(Deserialize, Debug)]
struct LWall {
    #[serde(default)]
    points: Vec<P>,
    #[serde(default)]
    material: Option<String>,
}

#[derive(Deserialize, Debug)]
struct LSpawn {
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default, rename = "type")]
    kind: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct LNpc {
    #[serde(default)]
    id: String,
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default)]
    hull_preset: String,
    #[serde(default)]
    hue: Option<f32>,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LField {
    Uniform {
        vector: P,
    },
    Point {
        #[serde(default)]
        center: P,
        #[serde(default)]
        strength: f32,
    },
}

#[derive(Deserialize, Debug)]
struct LGravZone {
    #[serde(flatten)]
    r: LRect,
    field: Option<LField>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct LSpring {
    #[serde(flatten)]
    r: LRect,
    #[serde(default)]
    fire_speed: Option<f32>,
    #[serde(default)]
    force: Option<f32>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct LPoint {
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default)]
    anchored: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct LShape {
    #[serde(default)]
    id: String,
    #[serde(default)]
    points: Vec<LPoint>,
    #[serde(default)]
    stiffness: Option<f32>,
    #[serde(default)]
    pinned: bool,
}

#[derive(Deserialize, Debug)]
#[serde(untagged)]
enum LAnchors {
    Pattern(String),
    Indices(#[allow(dead_code)] Vec<u32>),
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct LSoft {
    #[serde(flatten)]
    r: LRect,
    #[serde(default)]
    anchors: Option<LAnchors>,
    #[serde(default)]
    stiffness: Option<f32>,
    #[serde(default)]
    pinned: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct LTrigger {
    #[serde(flatten)]
    r: LRect,
    #[serde(default)]
    sensor_width: Option<f32>,
    #[serde(default)]
    sensor_height: Option<f32>,
    #[serde(default)]
    charge_seconds: Option<f32>,
    #[serde(default)]
    ignore_npcs: bool,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LTarget {
    #[serde(rename_all = "camelCase")]
    ShapePoint { shape_id: String, point_index: usize, end_x: f32, end_y: f32 },
    #[serde(rename_all = "camelCase")]
    Platform { platform_id: String, end_x: f32, end_y: f32, #[serde(default)] end_rotation: Option<f32> },
    #[serde(rename_all = "camelCase")]
    Spike { spike_id: String, end_x: f32, end_y: f32, #[serde(default)] end_rotation: Option<f32> },
    #[serde(rename_all = "camelCase")]
    RotateShape { shape_id: String, #[allow(dead_code)] end_rotation: f32 },
    #[serde(rename_all = "camelCase")]
    MoveShape { shape_id: String, end_x: f32, end_y: f32 },
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct LAction {
    #[serde(default)]
    id: String,
    #[serde(default)]
    targets: Vec<serde_json::Value>,
    #[serde(default = "one")]
    duration: f32,
    #[serde(default)]
    source_trigger_ids: Vec<String>,
    #[serde(default)]
    require_mode: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    interval_seconds: Option<f32>,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LChainEnd {
    Fixed { x: f32, y: f32 },
    Blob { #[serde(default)] entity: String, id: String },
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct LChain {
    #[serde(default)]
    id: String,
    endpoint_a: LChainEnd,
    endpoint_b: LChainEnd,
    #[serde(default)]
    total_length: f32,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct LSprite {
    #[serde(default)]
    sprite_id: String,
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default)]
    rotation: f32,
    #[serde(default)]
    scale: Option<f32>,
}

#[derive(Deserialize, Debug)]
struct LDynamic {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(flatten)]
    r: LRect,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct LLevel {
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    level_type: Option<String>,
    #[serde(default)]
    level_types: Vec<String>,
    #[serde(default)]
    platforms: Vec<LRect>,
    #[serde(default)]
    walls: Vec<LWall>,
    #[serde(default)]
    spawn_points: Vec<LSpawn>,
    #[serde(default)]
    npc_blobs: Vec<LNpc>,
    #[serde(default)]
    goal_zones: Vec<LRect>,
    #[serde(default)]
    hill_zones: Vec<LRect>,
    #[serde(default)]
    hill_rotation: Option<serde_json::Value>,
    #[serde(default)]
    gravity_zones: Vec<LGravZone>,
    #[serde(default)]
    powerup_spawns: Vec<P>,
    #[serde(default)]
    spring_pads: Vec<LSpring>,
    #[serde(default)]
    spikes: Vec<LRect>,
    #[serde(default)]
    death_zones: Vec<LRect>,
    #[serde(default)]
    point_shapes: Vec<LShape>,
    #[serde(default)]
    soft_platforms: Vec<LSoft>,
    #[serde(default)]
    triggers: Vec<LTrigger>,
    #[serde(default)]
    actions: Vec<LAction>,
    #[serde(default)]
    chains: Vec<LChain>,
    #[serde(default)]
    sprites: Vec<LSprite>,
    #[serde(default)]
    dynamic_items: Vec<LDynamic>,
}

fn one() -> f32 {
    1.0
}

/// Is this JSON a legacy level (as opposed to a v3 level)?
pub fn is_legacy(json: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return false };
    let ver = v.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    ver < 3 && (v.get("platforms").is_some() || v.get("walls").is_some() || v.get("spawnPoints").is_some())
}

/// Load either format: v3 JSON as is, legacy JSON through the importer.
pub fn load_any(json: &str) -> Result<Level, ImportError> {
    if is_legacy(json) { import_legacy(json) } else { Ok(Level::from_json(json)?) }
}

/// Import a legacy level with default options.
pub fn import_legacy(json: &str) -> Result<Level, ImportError> {
    Ok(import_legacy_with(json, &ImportOptions::default())?.level)
}

/// Lowercase, non-alphanumerics → `-`, trimmed, ≤ 48 chars (legacy
/// `slugifyMapId`).
pub fn slugify(name: &str) -> String {
    let mut s: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').chars().take(48).collect::<String>();
    if s.is_empty() { "untitled".into() } else { s }
}

fn material(m: &Option<String>) -> Material {
    match m.as_deref() {
        Some("ice") => Material::Ice,
        Some("sticky") => Material::Sticky,
        Some("bouncy") => Material::Bouncy,
        _ => Material::Ground,
    }
}

/// HSL (s=0.65, l=0.6) → "#rrggbb", matching the legacy NPC tint.
fn hue_hex(h: f32) -> String {
    let (s, l) = (0.65f32, 0.6f32);
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(1.0)) * 6.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c * 0.5;
    let to = |v: f32| ((v + m).clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", to(r), to(g), to(b))
}

struct Ctx {
    s: f32,
}

impl Ctx {
    /// Legacy point → v3 point.
    fn p(&self, x: f32, y: f32) -> Vec2 {
        Vec2::new(x * self.s, -y * self.s)
    }
    fn len(&self, l: f32) -> f32 {
        l * self.s
    }
    /// Legacy centre-anchored rect → v3 rect shape.
    fn rect(&self, r: &LRect) -> Shape {
        Shape::Rect {
            center: self.p(r.x, r.y),
            size: Vec2::new(self.len(r.width.abs()), self.len(r.height.abs())),
            angle: if r.rotation.abs() > 0.001 { -r.rotation } else { 0.0 },
        }
    }
    /// Axis-aligned zone rect (legacy zones ignore rotation).
    fn zone(&self, r: &LRect) -> Shape {
        Shape::Rect { center: self.p(r.x, r.y), size: Vec2::new(self.len(r.width.abs()), self.len(r.height.abs())), angle: 0.0 }
    }
    /// Legacy direction vector (y-down) → v3.
    fn dir(&self, v: P) -> Vec2 {
        Vec2::new(v.x, -v.y)
    }
}

fn ccw(mut pts: Vec<Vec2>) -> Vec<Vec2> {
    let area: f32 = (0..pts.len()).map(|i| pts[i].perp_dot(pts[(i + 1) % pts.len()])).sum::<f32>() * 0.5;
    if area < 0.0 {
        pts.reverse();
    }
    pts
}

fn poly_area(pts: &[Vec2]) -> f32 {
    ((0..pts.len()).map(|i| pts[i].perp_dot(pts[(i + 1) % pts.len()])).sum::<f32>() * 0.5).abs()
}

/// How a mover reacts to its plates.
fn trigger_string(a: &LAction) -> String {
    let join = if a.require_mode == "all" { "&" } else { "|" };
    let ids = a.source_trigger_ids.join(join);
    match a.mode.as_str() {
        "switch" => format!("{ids}#toggle"),
        "oneShot" => format!("{ids}#once"),
        _ => ids,
    }
}

/// Import with options; returns the level and lossy-mapping notes.
pub fn import_legacy_with(json: &str, opts: &ImportOptions) -> Result<Imported, ImportError> {
    let raw: serde_json::Value = serde_json::from_str(json)?;
    if raw.get("version").and_then(|v| v.as_u64()).unwrap_or(1) >= 3 {
        return Err(ImportError::NotLegacy("version ≥ 3".into()));
    }
    let l: LLevel = serde_json::from_value(raw)?;
    let _ = l.version;
    let c = Ctx { s: opts.scale };
    let mut notes: Vec<String> = Vec::new();
    let name = if l.name.is_empty() { "Untitled".to_string() } else { l.name.clone() };
    let id = opts.id.clone().unwrap_or_else(|| slugify(&name));
    let mut level = Level::new(&id, &name);
    level.theme = Theme::Party;
    level.decor.clear();

    // ------------------------------------------------------------ modes
    let mut types: Vec<String> = l.level_types.clone();
    if types.is_empty() {
        if let Some(t) = &l.level_type {
            types.push(t.clone());
        }
    }
    let mut modes = Vec::new();
    for t in &types {
        let m = match t.as_str() {
            "solo_racing" | "team_racing" => Some(Mode::Race),
            "koth" => Some(Mode::Koth),
            "party" => None,
            _ => None,
        };
        if let Some(m) = m {
            if !modes.contains(&m) {
                modes.push(m);
            }
        }
    }
    if modes.is_empty() {
        // Infer from content.
        if !l.goal_zones.is_empty() {
            modes.push(Mode::Race);
        }
        if !l.hill_zones.is_empty() {
            modes.push(Mode::Koth);
        }
        if modes.is_empty() {
            modes.push(Mode::Sandbox);
        }
    }
    level.modes = modes;

    // ------------------------------------------- what do actions move?
    // platform id → (action, open-pose centre); shape id → (action, rigid delta)
    let mut moved_platforms: HashMap<String, (usize, Vec2)> = HashMap::new();
    let mut moved_spikes: HashMap<String, (usize, Vec2)> = HashMap::new();
    let mut moved_shapes: HashMap<String, (usize, Vec2)> = HashMap::new();
    let shape_by_id: HashMap<&str, &LShape> = l.point_shapes.iter().map(|s| (s.id.as_str(), s)).collect();
    for (ai, a) in l.actions.iter().enumerate() {
        let gated = !a.source_trigger_ids.is_empty();
        if !gated && a.mode != "timer" {
            notes.push(format!("action {}: no source triggers and not a timer, so it never fires; dropped", a.id));
            continue;
        }
        // Collect shapePoint deltas per shape so a shape whose points all move
        // together becomes a rigid mover.
        let mut point_deltas: HashMap<String, Vec<Vec2>> = HashMap::new();
        for t in &a.targets {
            let t: LTarget = match serde_json::from_value(t.clone()) {
                Ok(t) => t,
                Err(e) => {
                    notes.push(format!("action {}: unreadable target ({e}); skipped", a.id));
                    continue;
                }
            };
            match t {
                LTarget::Platform { platform_id, end_x, end_y, end_rotation } => {
                    if end_rotation.is_some() {
                        notes.push(format!("action {}: platform {platform_id} end rotation dropped (movers translate only)", a.id));
                    }
                    if moved_platforms.contains_key(&platform_id) {
                        notes.push(format!("action {}: platform {platform_id} already driven by another action; ignored", a.id));
                    } else {
                        moved_platforms.insert(platform_id, (ai, Vec2::new(end_x, end_y)));
                    }
                }
                LTarget::Spike { spike_id, end_x, end_y, end_rotation } => {
                    let _ = end_rotation;
                    notes.push(format!("action {}: spike {spike_id} becomes a moving stone block (v3 spikes are static)", a.id));
                    moved_spikes.entry(spike_id).or_insert((ai, Vec2::new(end_x, end_y)));
                }
                LTarget::MoveShape { shape_id, end_x, end_y } => {
                    if let Some(s) = shape_by_id.get(shape_id.as_str()) {
                        let n = s.points.len().max(1) as f32;
                        let cx = s.points.iter().map(|p| p.x).sum::<f32>() / n;
                        let cy = s.points.iter().map(|p| p.y).sum::<f32>() / n;
                        moved_shapes.entry(shape_id).or_insert((ai, Vec2::new(end_x - cx, end_y - cy)));
                    }
                }
                LTarget::ShapePoint { shape_id, point_index, end_x, end_y } => {
                    if let Some(p) = shape_by_id.get(shape_id.as_str()).and_then(|s| s.points.get(point_index)) {
                        point_deltas.entry(shape_id).or_default().push(Vec2::new(end_x - p.x, end_y - p.y));
                    }
                }
                LTarget::RotateShape { shape_id, .. } => {
                    notes.push(format!("action {}: rotateShape on {shape_id} dropped (no rotating movers)", a.id));
                }
            }
        }
        for (sid, ds) in point_deltas {
            let avg = ds.iter().copied().sum::<Vec2>() / ds.len() as f32;
            if ds.iter().any(|d| d.distance(avg) > 20.0) {
                notes.push(format!("action {}: points of {sid} move by different amounts; approximated as a rigid move", a.id));
            }
            moved_shapes.entry(sid).or_insert((ai, avg));
        }
    }

    let mover_for = |action: &LAction, shape: Shape, delta_legacy: Vec2, material: Material| -> Mover {
        let path = vec![Vec2::ZERO, Vec2::new(delta_legacy.x * c.s, -delta_legacy.y * c.s)];
        let timer = action.mode == "timer";
        let period = if timer {
            2.0 * action.interval_seconds.unwrap_or(4.0).max(action.duration).max(0.1)
        } else {
            2.0 * action.duration.max(0.05)
        };
        Mover {
            id: action.id.clone(),
            shape,
            path,
            motion: MoverMotion::PingPong,
            period,
            phase: 0.0,
            material,
            trigger: if timer { String::new() } else { trigger_string(action) },
            lethal: false,
        }
    };

    // ------------------------------------------------------- platforms
    for p in &l.platforms {
        let shape = c.rect(p);
        let mat = material(&p.material);
        if let Some((ai, end)) = moved_platforms.get(&p.id) {
            let delta = *end - Vec2::new(p.x, p.y);
            level.movers.push(mover_for(&l.actions[*ai], shape, delta, mat));
        } else {
            level.terrain.push(Terrain { shape, material: mat, one_way: false });
        }
    }
    for w in &l.walls {
        if w.points.len() < 3 {
            continue;
        }
        let pts = ccw(w.points.iter().map(|q| c.p(q.x, q.y)).collect());
        level.terrain.push(Terrain { shape: Shape::Poly { points: pts }, material: material(&w.material), one_way: false });
    }

    // ---------------------------------------------------------- spawns
    let players: Vec<&LSpawn> = l.spawn_points.iter().filter(|s| s.kind != "npc").collect();
    if let Some(s) = players.first() {
        level.spawn = c.p(s.x, s.y);
    } else if let Some(s) = l.spawn_points.first() {
        level.spawn = c.p(s.x, s.y);
        notes.push("no player spawn; used the first spawn point".into());
    } else {
        notes.push("no spawn points; spawn at origin".into());
    }
    if players.len() > 1 {
        notes.push(format!("{} extra player spawns dropped (v3 has one spawn; players spread around it)", players.len() - 1));
    }

    // ------------------------------------------------------------ NPCs
    for n in &l.npc_blobs {
        level.npcs.push(Npc {
            id: n.id.clone(),
            pos: c.p(n.x, n.y),
            role: NpcRole::Huddle,
            color: n.hue.map(hue_hex).unwrap_or_default(),
            radius: c.len(48.0).max(18.0),
        });
        if !n.hull_preset.is_empty() && n.hull_preset != "circle16" {
            notes.push(format!("npc {}: hull preset '{}' becomes a round blob", n.id, n.hull_preset));
        }
    }

    // ----------------------------------------------------------- zones
    for (i, g) in l.goal_zones.iter().enumerate() {
        if i == 0 {
            level.goal = Some(c.zone(g));
        } else {
            notes.push(format!("goal zone {} dropped (v3 has one goal)", g.id));
        }
    }
    for h in &l.hill_zones {
        level.hills.push(c.zone(h));
    }
    if l.hill_rotation.is_some() {
        notes.push("hillRotation dropped (the KOTH mode decides how hills move)".into());
    }
    let gscale = GRAVITY / LEGACY_GRAVITY;
    for gz in &l.gravity_zones {
        match &gz.field {
            Some(LField::Uniform { vector }) => {
                level.zones.push(Zone {
                    id: gz.r.id.clone(),
                    shape: c.zone(&gz.r),
                    kind: ZoneKind::Gravity { gravity: c.dir(*vector) * gscale },
                });
            }
            Some(LField::Point { center, strength }) => {
                // Four triangles from the centre to each edge, each pulling
                // toward the centre (pushing out if strength < 0).
                let (min, max) = c.zone(&gz.r).bounds();
                let ctr = c.p(center.x, center.y).clamp(min, max);
                let corners = [Vec2::new(min.x, min.y), Vec2::new(max.x, min.y), max, Vec2::new(min.x, max.y)];
                let mag = GRAVITY * (strength.abs() / 40000.0).clamp(0.5, 2.0) * strength.signum();
                for k in 0..4 {
                    let a = corners[k];
                    let b = corners[(k + 1) % 4];
                    let mid = (a + b) * 0.5;
                    let toward = (ctr - mid).normalize_or_zero();
                    level.zones.push(Zone {
                        id: format!("{}_{k}", gz.r.id),
                        shape: Shape::Poly { points: ccw(vec![ctr, a, b]) },
                        kind: ZoneKind::Gravity { gravity: toward * mag },
                    });
                }
                notes.push(format!("gravity zone {}: point field approximated by 4 inward uniform zones", gz.r.id));
            }
            None => {}
        }
    }
    for d in &l.death_zones {
        level.zones.push(Zone { id: d.id.clone(), shape: c.zone(d), kind: ZoneKind::Kill });
    }
    for p in &l.powerup_spawns {
        level.pickups.push(c.p(p.x, p.y));
    }
    if !l.powerup_spawns.is_empty() {
        notes.push("powerup spawns become glow-drop pickups".into());
    }

    // -------------------------------------------------- springs & spikes
    for s in &l.spring_pads {
        // Legacy: rotation = launch direction, `width` along it, plate is
        // `height * 8` wide across it; centre = plate centre.
        let dir_legacy = Vec2::new(s.r.rotation.cos(), s.r.rotation.sin());
        let dir = Vec2::new(dir_legacy.x, -dir_legacy.y);
        let centre = c.p(s.r.x, s.r.y);
        let face = centre + dir * (c.len(s.r.width) * 0.5 - 18.0).max(0.0);
        let speed = s.fire_speed.or(s.force.map(|f| f.max(500.0))).unwrap_or(1100.0).clamp(500.0, 2500.0);
        level.springs.push(SpringPad {
            pos: face,
            angle: dir.y.atan2(dir.x),
            width: c.len(s.r.height * 8.0).clamp(60.0, 260.0),
            power: speed * 1.3,
        });
    }
    for s in &l.spikes {
        let rot = Vec2::new(s.rotation.cos(), -s.rotation.sin());
        let base = c.p(s.x, s.y);
        let half = rot * c.len(s.width) * 0.5;
        if let Some((ai, end)) = moved_spikes.get(&s.id) {
            // A moving spike strip becomes a stone block mover.
            let n = rot.perp();
            let h = c.len(s.height);
            let shape = Shape::Poly { points: ccw(vec![base - half, base + half, base + half + n * h, base - half + n * h]) };
            let delta = *end - Vec2::new(s.x, s.y);
            level.movers.push(mover_for(&l.actions[*ai], shape, delta, Material::Stone));
            continue;
        }
        level.spikes.push(Spikes { a: base - half, b: base + half });
    }

    // ---------------------------------------------------- point shapes
    let mut prop_ids: HashSet<String> = HashSet::new();
    for s in &l.point_shapes {
        if s.points.len() < 3 {
            notes.push(format!("point shape {} has < 3 points; skipped", s.id));
            continue;
        }
        let pts: Vec<Vec2> = s.points.iter().map(|q| c.p(q.x, q.y)).collect();
        let outline = ccw(pts.clone());
        let anchored: Vec<Vec2> = s.points.iter().filter(|q| q.anchored).map(|q| c.p(q.x, q.y)).collect();
        let stiffness = s.stiffness.unwrap_or(1.0);
        let wobble = (1.0 - stiffness * 0.5).clamp(0.1, 0.9);
        if let Some((ai, delta)) = moved_shapes.get(&s.id) {
            level.movers.push(mover_for(&l.actions[*ai], Shape::Poly { points: outline }, *delta, Material::Ground));
            notes.push(format!("point shape {}: moved by an action, so it becomes a rigid mover", s.id));
            continue;
        }
        let area = poly_area(&outline);
        if s.pinned || anchored.len() >= 2 {
            if area > opts.max_jelly_area {
                level.terrain.push(Terrain { shape: Shape::Poly { points: outline }, material: Material::Ground, one_way: false });
                notes.push(format!("point shape {}: large pinned soft hill becomes solid terrain", s.id));
            } else {
                level.jelly.push(Jelly { shape: Shape::Poly { points: outline }, material: Material::Ground, wobble });
                if !s.pinned {
                    notes.push(format!("point shape {}: anchored points become a home-tethered jelly", s.id));
                }
            }
            continue;
        }
        // Free (or single-anchor) soft blob → dynamic prop.
        let ctr = outline.iter().copied().sum::<Vec2>() / outline.len() as f32;
        let local: Vec<Vec2> = outline.iter().map(|q| *q - ctr).collect();
        let (min, max) = Shape::Poly { points: outline.clone() }.bounds();
        let id = if s.id.is_empty() { format!("shape_{}", level.props.len()) } else { s.id.clone() };
        level.props.push(Prop {
            id: id.clone(),
            kind: PropKind::Custom { outline: local },
            center: ctr,
            size: max - min,
            angle: 0.0,
            mass: (area / 3600.0).clamp(0.3, 20.0),
            material: Material::Ground,
            color: String::new(),
            pinned: false,
        });
        prop_ids.insert(id.clone());
        if let Some(a) = anchored.first() {
            level.ropes.push(RopeDef {
                id: format!("{id}_tether"),
                from: RopeEnd::World { at: *a },
                to: RopeEnd::Body { id },
                length: a.distance(ctr),
                grabbable: false,
                style: RopeStyle::Rope,
            });
            notes.push(format!("point shape {}: single anchor becomes a tether rope to the shape's centre", s.id));
        }
    }

    // ---------------------------------------------------- soft platforms
    for sp in &l.soft_platforms {
        let pins = match &sp.anchors {
            _ if sp.pinned => Pins::Home,
            None => Pins::Corners,
            Some(LAnchors::Pattern(p)) => match p.as_str() {
                "ends" => Pins::Ends,
                "left" => Pins::Left,
                "right" => Pins::Right,
                "top" => Pins::Top,
                "bottom" => {
                    notes.push(format!("soft platform {}: bottom anchors become a home-tethered slab", sp.r.id));
                    Pins::Home
                }
                _ => Pins::Corners,
            },
            Some(LAnchors::Indices(_)) => {
                notes.push(format!("soft platform {}: custom anchor indices become corner pins", sp.r.id));
                Pins::Corners
            }
        };
        level.platforms.push(SoftPlatform {
            id: sp.r.id.clone(),
            center: c.p(sp.r.x, sp.r.y),
            size: Vec2::new(c.len(sp.r.width.abs()), c.len(sp.r.height.abs()).max(12.0)),
            angle: -sp.r.rotation,
            pins,
            stiffness: (sp.stiffness.unwrap_or(1.0) * 0.5).clamp(0.05, 1.0),
            material: material(&sp.r.material),
        });
    }

    // ---------------------------------------------------------- plates
    let used_plates: HashSet<&str> =
        l.actions.iter().flat_map(|a| a.source_trigger_ids.iter().map(|s| s.as_str())).collect();
    for t in &l.triggers {
        // Sensor rect: bottom aligned with the plate's bottom (legacy).
        let sw = t.sensor_width.unwrap_or(t.r.width);
        let sh = t.sensor_height.unwrap_or(t.r.height);
        let rot = t.r.rotation;
        // Local (y-down) offset of the sensor centre from the plate centre.
        let off = Vec2::new(0.0, (t.r.height - sh) * 0.5);
        let (sn, cs) = rot.sin_cos();
        let off_rot = Vec2::new(off.x * cs - off.y * sn, off.x * sn + off.y * cs);
        let sensor = LRect { id: t.r.id.clone(), x: t.r.x + off_rot.x, y: t.r.y + off_rot.y, width: sw, height: sh, rotation: rot, material: None };
        level.story.push(StoryTrigger { shape: c.rect(&sensor), script: format!("plate:{}", t.r.id), once: false });
        if t.charge_seconds.unwrap_or(0.0) > 0.0 {
            notes.push(format!("trigger {}: charge time dropped (plates fire instantly)", t.r.id));
        }
        if t.ignore_npcs {
            notes.push(format!("trigger {}: ignoreNpcs dropped", t.r.id));
        }
        if !used_plates.contains(t.r.id.as_str()) {
            notes.push(format!("trigger {} drives no action", t.r.id));
        }
    }

    // ----------------------------------------------------------- chains
    let soft_ids: HashSet<&str> = l.soft_platforms.iter().map(|s| s.r.id.as_str()).collect();
    for ch in &l.chains {
        let end = |e: &LChainEnd, notes: &mut Vec<String>| -> Option<RopeEnd> {
            match e {
                LChainEnd::Fixed { x, y } => Some(RopeEnd::World { at: c.p(*x, *y) }),
                LChainEnd::Blob { entity, id } => {
                    if prop_ids.contains(id) || soft_ids.contains(id.as_str()) {
                        Some(RopeEnd::Body { id: id.clone() })
                    } else {
                        notes.push(format!("chain {}: {entity} end '{id}' can't be tied in v3; chain dropped", ch.id));
                        None
                    }
                }
            }
        };
        let (Some(a), Some(b)) = (end(&ch.endpoint_a, &mut notes), end(&ch.endpoint_b, &mut notes)) else { continue };
        level.ropes.push(RopeDef {
            id: ch.id.clone(),
            from: a,
            to: b,
            length: c.len(ch.total_length),
            grabbable: true,
            style: RopeStyle::Chain,
        });
    }

    // ---------------------------------------------------------- sprites
    for s in &l.sprites {
        level.decor.push(Decor {
            kind: s.sprite_id.clone(),
            pos: c.p(s.x, s.y),
            scale: s.scale.unwrap_or(1.0),
            angle: -s.rotation,
            depth: -1.0,
        });
    }
    if !l.sprites.is_empty() {
        notes.push(format!("{} sprites become decor (sprite collision dropped)", l.sprites.len()));
    }

    // ---------------------------------------------------- dynamic items
    for d in &l.dynamic_items {
        let shape = c.rect(&d.r);
        let dir = Vec2::new(d.r.rotation.cos(), -d.r.rotation.sin());
        let ctr = c.p(d.r.x, d.r.y);
        match d.kind.as_str() {
            "wind_zone" => level.zones.push(Zone { id: d.r.id.clone(), shape, kind: ZoneKind::Wind { accel: dir * 350.0 * gscale * 4.0 } }),
            "conveyor_left" => level.zones.push(Zone { id: d.r.id.clone(), shape, kind: ZoneKind::Conveyor { speed: -250.0 } }),
            "conveyor_right" => level.zones.push(Zone { id: d.r.id.clone(), shape, kind: ZoneKind::Conveyor { speed: 250.0 } }),
            "sticky_goo" => level.zones.push(Zone { id: d.r.id.clone(), shape, kind: ZoneKind::Goo { drag: 9.0 } }),
            "gravity_flipper" => {
                level.zones.push(Zone { id: d.r.id.clone(), shape, kind: ZoneKind::Gravity { gravity: Vec2::new(0.0, GRAVITY) } })
            }
            "bumper" => level.jelly.push(Jelly {
                shape: Shape::Circle { center: ctr, radius: c.len(d.r.width * 0.5).max(16.0) },
                material: Material::Bouncy,
                wobble: 0.8,
            }),
            "cannon" | "catapult" => {
                let angle = if d.kind == "catapult" { std::f32::consts::FRAC_PI_2 } else { dir.y.atan2(dir.x) };
                level.springs.push(SpringPad { pos: ctr, angle, width: c.len(d.r.width).clamp(60.0, 200.0), power: 1600.0 });
                notes.push(format!("{} {}: periodic launcher becomes a spring pad", d.kind, d.r.id));
            }
            "wrecking_ball" => {
                let id = if d.r.id.is_empty() { format!("wrecking_{}", level.props.len()) } else { d.r.id.clone() };
                let r = c.len(d.r.width * 0.5).max(30.0);
                level.props.push(Prop {
                    id: id.clone(),
                    kind: PropKind::Ball,
                    center: ctr,
                    size: Vec2::splat(r * 2.0),
                    angle: 0.0,
                    mass: 6.0,
                    material: Material::Stone,
                    color: "#6c7385".into(),
                    pinned: false,
                });
                level.ropes.push(RopeDef {
                    id: format!("{id}_chain"),
                    from: RopeEnd::World { at: ctr + Vec2::new(0.0, 300.0) },
                    to: RopeEnd::Body { id },
                    length: 300.0,
                    grabbable: true,
                    style: RopeStyle::Chain,
                });
                notes.push(format!("wrecking ball {}: becomes a heavy ball on a chain (no blast)", d.r.id));
            }
            other => notes.push(format!("dynamic item {} of type '{other}' dropped", d.r.id)),
        }
    }

    // --------------------------------------------------------- kill_y
    let (min, _) = level.bounds();
    level.kill_y = min.y - c.len(100.0).max(60.0);
    if level.spawn.y < level.kill_y {
        level.kill_y = level.spawn.y - 400.0;
    }

    Ok(Imported { level, notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
      "name": "Minimal Race", "version": 1, "levelTypes": ["solo_racing"],
      "bounds": { "width": 4400, "height": 2248 },
      "platforms": [{ "id": "plat_1", "x": 0, "y": 500, "width": 1200, "height": 40, "rotation": 0, "material": "ice" }],
      "walls": [],
      "spawnPoints": [{ "id": "sp1", "x": -400, "y": 380, "type": "player" }],
      "npcBlobs": [],
      "goalZones": [{ "id": "goal_2", "x": 400, "y": 280, "width": 400, "height": 400 }],
      "spikes": [{ "id": "s", "x": 0, "y": 480, "width": 300, "height": 40, "rotation": 0 }],
      "springPads": [{ "id": "sp", "x": 0, "y": 470, "width": 100, "height": 40, "rotation": -1.5708 }]
    }"#;

    #[test]
    fn minimal_maps_y_up_and_scale() {
        let l = import_legacy(MINIMAL).unwrap();
        assert_eq!(l.id, "minimal-race");
        assert_eq!(l.modes, vec![Mode::Race]);
        let s = 2.0 / 3.0;
        assert!((l.spawn - Vec2::new(-400.0 * s, -380.0 * s)).length() < 0.01);
        let Shape::Rect { center, size, .. } = l.terrain[0].shape else { panic!() };
        assert!((center.y + 500.0 * s).abs() < 0.01);
        assert!((size.x - 800.0).abs() < 0.01);
        assert_eq!(l.terrain[0].material, Material::Ice);
        // Spawn is above the platform in y-up.
        assert!(l.spawn.y > center.y);
        // Spikes point up: a→b left to right.
        assert!(l.spikes[0].a.x < l.spikes[0].b.x);
        // Spring launches up.
        assert!((l.springs[0].angle - std::f32::consts::FRAC_PI_2).abs() < 0.01);
        assert!(l.kill_y < center.y - 20.0);
        assert!(l.goal.is_some());
    }

    #[test]
    fn plate_action_becomes_gated_mover() {
        let j = r#"{"name":"T","version":1,"platforms":[{"id":"p","x":0,"y":0,"width":100,"height":20,"rotation":0}],
          "walls":[],"spawnPoints":[],"npcBlobs":[],
          "triggers":[{"id":"t1","x":0,"y":-100,"width":50,"height":20,"rotation":0}],
          "actions":[{"id":"a","kind":"movePoints","targets":[{"kind":"platform","platformId":"p","endX":0,"endY":-300}],
            "duration":1,"sourceTriggerIds":["t1"],"requireMode":"any","mode":"switch"}]}"#;
        let l = import_legacy(j).unwrap();
        assert!(l.terrain.is_empty());
        assert_eq!(l.movers.len(), 1);
        assert_eq!(l.movers[0].trigger, "t1#toggle");
        assert!(l.movers[0].path[1].y > 0.0, "moves up in y-up");
        assert_eq!(l.story[0].script, "plate:t1");
    }

    #[test]
    fn load_any_detects_format() {
        let v3 = Level::new("x", "X").to_json();
        assert_eq!(load_any(&v3).unwrap().id, "x");
        assert_eq!(load_any(MINIMAL).unwrap().id, "minimal-race");
        assert!(is_legacy(MINIMAL));
        assert!(!is_legacy(&v3));
    }
}
