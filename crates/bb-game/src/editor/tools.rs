//! Editor tools and element creation (engine-free).

use bb_level::*;
use glam::Vec2;

use super::model::{self, Elem, Item};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tool {
    Select,
    TerrainRect,
    TerrainPoly,
    Ground,
    Jelly,
    SoftPlatform,
    Prop,
    Mover,
    Rope,
    Zone,
    Spring,
    Spikes,
    Checkpoint,
    Pickup,
    Npc,
    Goal,
    Hill,
    Story,
    Decor,
    Spawn,
}

/// How a tool is placed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement {
    None,
    /// Press, drag a rectangle, release.
    Rect,
    /// Press at A, release at B.
    Line,
    /// Single click.
    Click,
    /// Click points; Enter / C / double-click / click the first point to finish.
    Polyline { closed: bool, min: usize },
}

impl Tool {
    pub const ALL: [Tool; 20] = [
        Tool::Select,
        Tool::TerrainRect,
        Tool::TerrainPoly,
        Tool::Ground,
        Tool::Jelly,
        Tool::SoftPlatform,
        Tool::Prop,
        Tool::Mover,
        Tool::Rope,
        Tool::Zone,
        Tool::Spring,
        Tool::Spikes,
        Tool::Checkpoint,
        Tool::Pickup,
        Tool::Npc,
        Tool::Goal,
        Tool::Hill,
        Tool::Story,
        Tool::Decor,
        Tool::Spawn,
    ];

    pub fn name(&self) -> &'static str {
        match self {
            Tool::Select => "Select",
            Tool::TerrainRect => "Block",
            Tool::TerrainPoly => "Terrain poly",
            Tool::Ground => "Ground run",
            Tool::Jelly => "Jelly",
            Tool::SoftPlatform => "Soft platform",
            Tool::Prop => "Prop",
            Tool::Mover => "Mover",
            Tool::Rope => "Vine / rope",
            Tool::Zone => "Zone",
            Tool::Spring => "Spring",
            Tool::Spikes => "Spikes",
            Tool::Checkpoint => "Checkpoint",
            Tool::Pickup => "Pickup",
            Tool::Npc => "NPC",
            Tool::Goal => "Goal",
            Tool::Hill => "Hill",
            Tool::Story => "Story trigger",
            Tool::Decor => "Decor",
            Tool::Spawn => "Spawn",
        }
    }

    /// Hotkeys follow the legacy editor (1-9, Q W E R D T C G) where the
    /// element still exists; new elements use free letters.
    pub fn hotkey(&self) -> Option<&'static str> {
        Some(match self {
            Tool::Select => "1",
            Tool::TerrainRect => "2",
            Tool::Spawn => "3",
            Tool::Npc => "4",
            Tool::Spring => "5",
            Tool::Spikes => "6",
            Tool::Goal => "7",
            Tool::Hill => "8",
            Tool::Pickup => "9",
            Tool::TerrainPoly => "Q",
            Tool::Story => "W",
            Tool::Mover => "E",
            Tool::SoftPlatform => "R",
            Tool::Zone => "G",
            Tool::Decor => "T",
            Tool::Rope => "C",
            Tool::Ground => "F",
            Tool::Jelly => "J",
            Tool::Prop => "P",
            Tool::Checkpoint => "K",
        })
    }

    pub fn placement(&self) -> Placement {
        match self {
            Tool::Select => Placement::None,
            Tool::TerrainRect | Tool::Jelly | Tool::SoftPlatform | Tool::Mover | Tool::Zone | Tool::Goal | Tool::Hill | Tool::Story => {
                Placement::Rect
            }
            Tool::Spikes | Tool::Rope => Placement::Line,
            Tool::TerrainPoly => Placement::Polyline { closed: true, min: 3 },
            Tool::Ground => Placement::Polyline { closed: false, min: 2 },
            Tool::Prop | Tool::Spring | Tool::Checkpoint | Tool::Pickup | Tool::Npc | Tool::Decor | Tool::Spawn => Placement::Click,
        }
    }

    pub fn hint(&self) -> &'static str {
        match self.placement() {
            Placement::None => "Click to select (Shift = add, click again = next under cursor), drag to move, drag empty space to box-select. Handles resize, the dot rotates, squares edit vertices.",
            Placement::Rect => "Drag a rectangle (click for the default size).",
            Placement::Line => "Drag from one end to the other.",
            Placement::Click => "Click to place.",
            Placement::Polyline { closed: true, .. } => "Click points; click the first point, double-click, Enter or C to finish. Shift snaps 15°. Esc cancels.",
            Placement::Polyline { closed: false, .. } => "Click the top surface left to right; double-click, Enter or C to finish. Shift snaps 15°. Esc cancels.",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoverPreset {
    Elevator,
    Crusher,
    Spinner,
    Loop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZonePreset {
    Wind,
    Water,
    Kill,
    Conveyor,
    Gravity,
    Goo,
}

impl ZonePreset {
    pub const ALL: [ZonePreset; 6] =
        [ZonePreset::Wind, ZonePreset::Water, ZonePreset::Kill, ZonePreset::Conveyor, ZonePreset::Gravity, ZonePreset::Goo];
    pub fn kind(&self) -> ZoneKind {
        match self {
            ZonePreset::Wind => ZoneKind::Wind { accel: Vec2::new(0.0, 2600.0) },
            ZonePreset::Water => ZoneKind::Water { buoyancy: 2600.0, drag: 1.6, current: Vec2::ZERO },
            ZonePreset::Kill => ZoneKind::Kill,
            ZonePreset::Conveyor => ZoneKind::Conveyor { speed: 300.0 },
            ZonePreset::Gravity => ZoneKind::Gravity { gravity: Vec2::new(0.0, 1800.0) },
            ZonePreset::Goo => ZoneKind::Goo { drag: 6.0 },
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            ZonePreset::Wind => "Wind",
            ZonePreset::Water => "Water",
            ZonePreset::Kill => "Kill",
            ZonePreset::Conveyor => "Conveyor",
            ZonePreset::Gravity => "Gravity",
            ZonePreset::Goo => "Goo",
        }
    }
}

pub const DECOR_KINDS: [&str; 10] =
    ["mushroom", "crystal", "glowworm", "drip", "lantern", "sock", "crayon", "block_letters", "mushroom_spots", "pebble"];

/// Per-tool creation options (shown in the side panel while a tool is active).
#[derive(Clone, Debug)]
pub struct ToolOpts {
    pub material: Material,
    pub prop_kind: u8,
    pub mover: MoverPreset,
    pub zone: ZonePreset,
    pub rope_style: RopeStyle,
    pub npc_role: NpcRole,
    pub decor: String,
    pub ground_depth: f32,
    pub wobble: f32,
    pub pins: Pins,
    pub one_way: bool,
    pub keep_tool: bool,
}

impl Default for ToolOpts {
    fn default() -> Self {
        ToolOpts {
            material: Material::Ground,
            prop_kind: 0,
            mover: MoverPreset::Elevator,
            zone: ZonePreset::Wind,
            rope_style: RopeStyle::Vine,
            npc_role: NpcRole::Huddle,
            decor: "mushroom".into(),
            ground_depth: 300.0,
            wobble: 0.5,
            pins: Pins::Ends,
            one_way: false,
            keep_tool: false,
        }
    }
}

fn rect_or_default(a: Vec2, b: Vec2, default: Vec2) -> (Vec2, Vec2) {
    let d = (b - a).abs();
    if d.x < 12.0 || d.y < 12.0 {
        (a - default * 0.5, a + default * 0.5)
    } else {
        (a.min(b), a.max(b))
    }
}

/// Body ids (props / soft platforms) under `p`, for tying rope ends.
fn body_at(level: &mut Level, p: Vec2) -> Option<String> {
    for e in model::hits_at(level, p, 4.0) {
        match e {
            Elem::Prop(i) => {
                if level.props[i].id.is_empty() {
                    level.props[i].id = model::fresh_id(level, "prop");
                }
                return Some(level.props[i].id.clone());
            }
            Elem::Platform(i) => {
                if level.platforms[i].id.is_empty() {
                    level.platforms[i].id = model::fresh_id(level, "plat");
                }
                return Some(level.platforms[i].id.clone());
            }
            _ => {}
        }
    }
    None
}

/// Create the element(s) for a finished placement. `pts` are the snapped
/// world points (1 for Click, 2 for Rect / Line, N for Polyline).
pub fn create(level: &mut Level, tool: Tool, o: &ToolOpts, pts: &[Vec2]) -> Vec<Elem> {
    let Some(&a) = pts.first() else { return Vec::new() };
    let b = pts.get(1).copied().unwrap_or(a);
    let item = match tool {
        Tool::Select => return Vec::new(),
        Tool::TerrainRect => {
            let (min, max) = rect_or_default(a, b, Vec2::new(200.0, 40.0));
            Item::Terrain(Terrain { shape: Shape::rect(min, max), material: o.material, one_way: o.one_way })
        }
        Tool::TerrainPoly => {
            if pts.len() < 3 {
                return Vec::new();
            }
            Item::Terrain(Terrain { shape: Shape::Poly { points: ccw(pts.to_vec()) }, material: o.material, one_way: o.one_way })
        }
        Tool::Ground => {
            if pts.len() < 2 {
                return Vec::new();
            }
            let mut top = pts.to_vec();
            if top[0].x > top[top.len() - 1].x {
                top.reverse();
            }
            let (t0, j0) = (level.terrain.len(), level.jelly.len());
            let mut b = LevelBuilder { level: std::mem::replace(level, Level::new("", "")) };
            b.ground_with(&top, o.ground_depth.max(40.0), o.material, o.wobble);
            *level = b.level;
            let mut out: Vec<Elem> = (t0..level.terrain.len()).map(Elem::Terrain).collect();
            out.extend((j0..level.jelly.len()).map(Elem::Jelly));
            return out;
        }
        Tool::Jelly => {
            let (min, max) = rect_or_default(a, b, Vec2::new(200.0, 60.0));
            Item::Jelly(Jelly { shape: Shape::rect(min, max), material: o.material, wobble: o.wobble })
        }
        Tool::SoftPlatform => {
            let (min, max) = rect_or_default(a, b, Vec2::new(300.0, 30.0));
            Item::Platform(SoftPlatform {
                id: model::fresh_id(level, "plat"),
                center: (min + max) * 0.5,
                size: max - min,
                angle: 0.0,
                pins: o.pins,
                stiffness: 0.5,
                material: o.material,
            })
        }
        Tool::Prop => {
            let (kind, size) = match o.prop_kind {
                1 => (PropKind::Ball, Vec2::splat(70.0)),
                2 => (PropKind::Star, Vec2::splat(90.0)),
                _ => (PropKind::Block, Vec2::splat(70.0)),
            };
            Item::Prop(Prop {
                id: model::fresh_id(level, "prop"),
                kind,
                center: a,
                size,
                angle: 0.0,
                mass: 1.2,
                material: o.material,
                color: "#ffd166".into(),
                pinned: false,
            })
        }
        Tool::Mover => {
            let (min, max) = rect_or_default(a, b, match o.mover {
                MoverPreset::Crusher => Vec2::new(140.0, 120.0),
                MoverPreset::Spinner => Vec2::new(240.0, 30.0),
                _ => Vec2::new(180.0, 26.0),
            });
            let shape = Shape::rect(min, max);
            let (path, motion, period) = match o.mover {
                MoverPreset::Elevator => (vec![Vec2::ZERO, Vec2::new(0.0, 300.0)], MoverMotion::PingPong, 4.0),
                MoverPreset::Crusher => (
                    vec![Vec2::ZERO, Vec2::new(0.0, -300.0)],
                    MoverMotion::Crusher { slam: 0.25, hold: 0.4, rise: 1.2, wait: 1.0 },
                    2.85,
                ),
                MoverPreset::Spinner => (Vec::new(), MoverMotion::Spin { speed: 1.5 }, 1.0),
                MoverPreset::Loop => (
                    vec![Vec2::ZERO, Vec2::new(300.0, 0.0), Vec2::new(300.0, 200.0), Vec2::new(0.0, 200.0)],
                    MoverMotion::Loop,
                    6.0,
                ),
            };
            Item::Mover(Mover {
                id: model::fresh_id(level, "mover"),
                shape,
                path,
                motion,
                period,
                phase: 0.0,
                material: Material::Stone,
                trigger: String::new(),
                lethal: false,
            })
        }
        Tool::Rope => {
            let (b, len) = if a.distance(b) < 12.0 { (a - Vec2::new(0.0, 300.0), 300.0) } else { (b, a.distance(b)) };
            let from = match body_at(level, a) {
                Some(id) => RopeEnd::Body { id },
                None => RopeEnd::World { at: a },
            };
            let to = match body_at(level, b) {
                Some(id) => RopeEnd::Body { id },
                None if o.rope_style == RopeStyle::Vine => RopeEnd::Free { at: b },
                None => RopeEnd::World { at: b },
            };
            Item::Rope(RopeDef { id: model::fresh_id(level, "rope"), from, to, length: len, grabbable: true, style: o.rope_style })
        }
        Tool::Zone => {
            let (min, max) = rect_or_default(a, b, Vec2::new(300.0, 300.0));
            Item::Zone(Zone { id: model::fresh_id(level, "zone"), shape: Shape::rect(min, max), kind: o.zone.kind() })
        }
        Tool::Spring => Item::Spring(SpringPad { pos: a, angle: std::f32::consts::FRAC_PI_2, width: 90.0, power: 1400.0 }),
        Tool::Spikes => {
            let (a, b) = if a.distance(b) < 12.0 { (a - Vec2::new(100.0, 0.0), a + Vec2::new(100.0, 0.0)) } else { (a, b) };
            Item::Spikes(Spikes { a, b })
        }
        Tool::Checkpoint => Item::Checkpoint(Checkpoint { pos: a }),
        Tool::Pickup => Item::Pickup(a),
        Tool::Npc => Item::Npc(Npc { id: model::fresh_id(level, "npc"), pos: a, role: o.npc_role.clone(), color: String::new(), radius: 30.0 }),
        Tool::Goal => {
            let (min, max) = rect_or_default(a, b, Vec2::new(200.0, 220.0));
            Item::Goal(Shape::rect(min, max))
        }
        Tool::Hill => {
            let (min, max) = rect_or_default(a, b, Vec2::new(340.0, 160.0));
            Item::Hill(Shape::rect(min, max))
        }
        Tool::Story => {
            let (min, max) = rect_or_default(a, b, Vec2::new(200.0, 200.0));
            Item::Story(StoryTrigger { shape: Shape::rect(min, max), script: "new_script".into(), once: true })
        }
        Tool::Decor => Item::Decor(Decor { kind: o.decor.clone(), pos: a, scale: 1.0, angle: 0.0, depth: -1.0 }),
        Tool::Spawn => Item::Spawn(a),
    };
    vec![model::add(level, item)]
}

fn ccw(mut pts: Vec<Vec2>) -> Vec<Vec2> {
    let area: f32 = (0..pts.len()).map(|i| pts[i].perp_dot(pts[(i + 1) % pts.len()])).sum();
    if area < 0.0 {
        pts.reverse();
    }
    pts
}

/// A fresh level with a little starter ground.
pub fn starter_level() -> Level {
    let mut b = LevelBuilder::new("untitled", "Untitled", Theme::Fungus);
    b.spawn(v(0.0, 80.0)).ground(&[v(-800.0, 0.0), v(800.0, 0.0)], 300.0).kill_y(-600.0);
    let mut l = b.build();
    l.modes = vec![Mode::Story];
    l
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_creates() {
        for t in Tool::ALL {
            let mut l = starter_level();
            let pts: Vec<Vec2> = match t.placement() {
                Placement::Polyline { .. } => vec![v(0.0, 0.0), v(200.0, 0.0), v(200.0, 200.0)],
                _ => vec![v(0.0, 300.0), v(200.0, 400.0)],
            };
            let made = create(&mut l, t, &ToolOpts::default(), &pts);
            if t == Tool::Select {
                assert!(made.is_empty());
                continue;
            }
            assert!(!made.is_empty(), "{t:?} created nothing");
            for e in made {
                assert!(model::exists(&l, e), "{t:?} → {e:?}");
            }
            // Serialises.
            Level::from_json(&l.to_json()).unwrap();
        }
    }

    #[test]
    fn rope_ties_to_props() {
        let mut l = starter_level();
        let p = create(&mut l, Tool::Prop, &ToolOpts::default(), &[v(0.0, 300.0)]);
        let id = match p[0] {
            Elem::Prop(i) => l.props[i].id.clone(),
            _ => unreachable!(),
        };
        let r = create(&mut l, Tool::Rope, &ToolOpts::default(), &[v(0.0, 600.0), v(0.0, 300.0)]);
        let Elem::Rope(i) = r[0] else { unreachable!() };
        assert_eq!(l.ropes[i].to, RopeEnd::Body { id });
    }
}
