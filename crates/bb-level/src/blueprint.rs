//! **Blueprints**: hand-editable level files.
//!
//! A blueprint is a level written as a list of *pieces* in the order they're
//! built: `{"ledge": {"x0": 2150, "x1": 2700, "y": 80}}`,
//! `{"floor": [[0, 0], [900, 0], [1150, 45]]}`, `{"spikes": {...}}`, … Each
//! piece expands into plain [`Level`] data (a ledge becomes a rock core plus
//! a row of jelly tiles; a cave mouth becomes rock, a tunnel floor, a mouth
//! and a goal), so a hand edit changes one number instead of ten.
//!
//! Expansion is deterministic: the same blueprint always yields the same
//! level, bit for bit. Pieces that read earlier state (`roof_spikes` and
//! `hang` follow the roofs placed before them) see exactly what came first.
//!
//! The story campaign lives in `crates/bb-game/assets/levels/campaign/` as
//! blueprints; see `docs/LevelFormat.md` for the full piece reference.

use glam::Vec2;
use serde::{Deserialize, Serialize};

use crate::builder::{LevelBuilder, metrics, v};
use crate::types::*;

// ------------------------------------------------------------- critical path

/// How the player gets from the previous waypoint to this one.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Move {
    /// Roll along connected ground (slopes and small bumps included).
    Walk,
    /// A required jump: take off at the previous waypoint, land here.
    Jump,
    /// Roll off a ledge and fall to here.
    Drop,
    /// Roll (squished) through a low tunnel.
    Squeeze,
    /// Wait for a gap in a hazard's rhythm (crushers, drips), then roll
    /// through underneath.
    Dash,
    /// Push a prop ahead of you.
    Push,
    /// Launched by a spring pad, mushroom, gear or seed pod.
    Spring,
    /// Swing on vines / ropes and let go.
    Rope,
    /// Ride an updraft or gust (puff up to float), or a balloon.
    Wind,
    /// Ride a moving platform / elevator / crane.
    Ride,
    /// Swim / float through water.
    Swim,
    /// Wall-jump up sticky walls.
    Wall,
    /// Cross using a prop you put in place (a ball pushed into a gap).
    Prop,
}

impl Move {
    /// Assisted moves may exceed the plain jump metrics.
    pub fn assisted(self) -> bool {
        !matches!(self, Move::Walk | Move::Jump | Move::Drop | Move::Squeeze | Move::Push | Move::Dash)
    }
}

/// A critical-path waypoint (a **feet** position: on the surface you stand on).
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Waypoint {
    pub at: Vec2,
    pub how: Move,
}

/// A level plus its declared critical path (what the playtest bot follows
/// and the metric audits check).
#[derive(Clone, Debug)]
pub struct Course {
    pub level: Level,
    pub path: Vec<Waypoint>,
}

// ------------------------------------------------------------------ format

/// Marker value of [`Blueprint::blueprint`] (bump on incompatible changes).
pub const BLUEPRINT_VERSION: u32 = 1;

/// A whole level as a blueprint file.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Blueprint {
    /// Format marker (always 1 for now).
    #[serde(default = "blueprint_version")]
    pub blueprint: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub theme: Theme,
    /// Free-form notes about the level (one string per line).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub about: Vec<String>,
    /// Floors and ledges are solid rock down to this height.
    #[serde(default = "default_bottom")]
    pub bottom: f32,
    /// Anything below this pops (usually `bottom + 200`).
    pub kill_y: f32,
    pub spawn: Vec2,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub intro: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub outro: String,
    pub pieces: Vec<Piece>,
}

/// One building step. Positions are `[x, y]` in pixels, **y up**. Angles
/// written `angle` here are in **degrees** (90 = up) unless the piece embeds
/// raw level data (`prop`, `mover`, `gadget`, `terrain`, `npc`), which uses
/// the level format's radians.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Piece {
    // --------------------------------------------------- notes (no effect)
    /// A heading that splits the file into sections.
    Section(String),
    /// A designer's note.
    Note(String),

    // --------------------------------------------------------- the path
    /// Critical-path waypoint: `["jump", x, y]` (feet position).
    Wp(Move, f32, f32),

    // --------------------------------------------------- ground and rock
    /// Jelly-skinned ground whose top follows the points (left to right),
    /// solid rock down to the level `bottom`.
    Floor(Vec<Vec2>),
    /// Flat floor from x0 to x1 at height y (down to the bottom).
    Ledge { x0: f32, x1: f32, y: f32 },
    /// A floating jelly-topped rock shelf `depth` thick.
    Shelf { x0: f32, x1: f32, y: f32, depth: f32 },
    /// Jelly-skinned ground following `top`, `depth` deep below its lowest
    /// point (`floor`/`shelf` are shortcuts for this).
    Ground {
        top: Vec<Vec2>,
        depth: f32,
        #[serde(default, skip_serializing_if = "is_ground")]
        material: Material,
        #[serde(default = "half", skip_serializing_if = "is_half")]
        wobble: f32,
    },
    /// Cave roof whose underside follows the points (500 px thick). Later
    /// `hang` and `roof_spikes` pieces follow it.
    Roof(Vec<Vec2>),
    /// A ceiling whose underside follows `bottom`, `height` thick (not a
    /// roof: decor doesn't hang from it).
    Ceiling { bottom: Vec<Vec2>, height: f32 },
    /// A rock wall / pillar spanning x0..x1, y0..y1.
    Wall { x0: f32, x1: f32, y0: f32, y1: f32 },
    /// A rock rectangle (any material).
    Block {
        min: Vec2,
        max: Vec2,
        #[serde(default, skip_serializing_if = "is_ground")]
        material: Material,
    },
    /// A rock polygon (counter-clockwise points).
    Poly {
        points: Vec<Vec2>,
        #[serde(default, skip_serializing_if = "is_ground")]
        material: Material,
    },
    /// A one-way jelly membrane / board: jump up through it, land on top.
    /// `y` is its top surface.
    OneWay { x0: f32, x1: f32, y: f32, thick: f32 },
    /// A solid wedge from `a` to `b` (filled down to the lower end).
    Ramp { a: Vec2, b: Vec2 },
    /// Raw terrain (level format).
    Terrain(Terrain),
    /// A free-standing wobbly jelly block (0 = firm, 1 = very wobbly).
    Jelly { min: Vec2, max: Vec2, wobble: f32 },
    /// The level's opening wall with a sealed entry tunnel at floor height
    /// `y` (glowing with the previous chapter's `theme`). Rock spans
    /// x_face..x_far up to `top`.
    EntryCave { x_far: f32, x_face: f32, y: f32, top: f32, theme: Theme },
    /// The closing wall with the exit tunnel you walk into (the goal sits
    /// inside). `daylight`: sunlight beyond (the finale).
    ExitCave {
        x_face: f32,
        x_far: f32,
        y: f32,
        top: f32,
        theme: Theme,
        #[serde(default, skip_serializing_if = "is_false")]
        daylight: bool,
    },

    // ------------------------------------------------- soft and dynamic
    /// A soft bridge pinned at both ends (stiffness 0 = floppy, 1 = firm).
    Bridge { a: Vec2, b: Vec2, thick: f32, stiffness: f32 },
    /// A floating jelly slab that bobs when you land on it.
    Slab { center: Vec2, size: Vec2, stiffness: f32 },
    /// A lily pad floating on water whose surface is at `surface`.
    Lily { surface: Vec2, width: f32 },
    /// A raw prop (level format).
    Prop(Prop),
    /// A pushable crate `size` px square (mass from size).
    Crate { at: Vec2, size: f32 },
    /// A ball of `radius` (mass from size).
    Ball { at: Vec2, radius: f32, color: String },
    /// A see-saw: rock wedge with a plank balanced on its tip at `pivot`.
    Seesaw { id: String, pivot: Vec2, length: f32, mass: f32 },

    // ------------------------------------------------------------ movers
    /// A raw mover (level format).
    Mover(Mover),
    /// A platform ping-ponging between centres `a` and `b` every `period` s.
    Elevator {
        a: Vec2,
        b: Vec2,
        width: f32,
        period: f32,
        #[serde(default, skip_serializing_if = "is_zero")]
        phase: f32,
    },
    /// A 210 px stone crusher hanging from a roof at height `roof` that
    /// slams down onto the floor at `floor`. `spiked`: teeth underneath.
    Piston {
        x: f32,
        roof: f32,
        floor: f32,
        phase: f32,
        #[serde(default, skip_serializing_if = "is_false")]
        spiked: bool,
    },
    /// A stone crusher whose top is at `top`, slamming `drop` px down.
    Crusher {
        top: Vec2,
        width: f32,
        drop: f32,
        phase: f32,
        #[serde(default, skip_serializing_if = "is_false")]
        spiked: bool,
    },
    /// A spinning blade (pops what it touches), `speed` rad/s.
    Blade { center: Vec2, size: Vec2, speed: f32 },
    /// A falling spiky drip: waits on the ceiling at `top`, drops `fall` px.
    Drip { top: Vec2, fall: f32, radius: f32, phase: f32 },
    /// A stone conveyor strip whose top-left is `at`, pushing at `speed`.
    Conveyor { at: Vec2, length: f32, speed: f32 },

    // ------------------------------------------------------------- ropes
    /// A grabbable vine hanging from `top`. `knob`: a little root knob of
    /// rock to hang it from.
    Vine {
        top: Vec2,
        length: f32,
        #[serde(default, skip_serializing_if = "is_false")]
        knob: bool,
    },
    /// A rope / chain / slinky between two ends (`knob` puts a root knob
    /// at a world-anchored `from`).
    Rope {
        from: RopeEnd,
        to: RopeEnd,
        length: f32,
        style: RopeStyle,
        #[serde(default, skip_serializing_if = "is_false")]
        knob: bool,
    },

    // ------------------------------------------------------------- zones
    /// Any zone over a rectangle.
    Zone { min: Vec2, max: Vec2, kind: ZoneKind },
    /// Still water.
    Water { min: Vec2, max: Vec2 },
    /// Water with a current (px/s² push).
    Current { min: Vec2, max: Vec2, flow: Vec2 },
    /// Wind / updraft (acceleration; 1400 up = lifts the puffed, 2200+
    /// lifts anyone).
    Wind { min: Vec2, max: Vec2, accel: Vec2 },

    // ------------------------------------ springs, mushrooms and hazards
    /// A spring pad launching along `angle` (degrees) at `power` px/s.
    Spring { at: Vec2, angle: f32, power: f32 },
    /// A spike strip along a→b; teeth point to the left of a→b (left to
    /// right = teeth up).
    Spikes { a: Vec2, b: Vec2 },
    /// Teeth hanging down from a ceiling underside at `y`.
    CeilingSpikes { x0: f32, x1: f32, y: f32 },
    /// Teeth along the roof underside from x0 to x1, leaving `keep` px
    /// clear around each x in `gaps` (vine roots).
    RoofSpikes {
        x0: f32,
        x1: f32,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        gaps: Vec<f32>,
        #[serde(default, skip_serializing_if = "is_zero")]
        keep: f32,
    },
    /// A jelly-capped trampoline mushroom with a spring pad on top.
    Trampoline { base: Vec2, height: f32, cap: f32, power: f32 },
    /// A bouncy mushroom: rock stalk `height` tall at `base`, soft cap
    /// `size` wide launching at `power` (flat caps along `angle`, degrees).
    Mushroom {
        base: Vec2,
        height: f32,
        shape: MushroomShape,
        size: f32,
        power: f32,
        #[serde(default = "up_deg", skip_serializing_if = "is_up_deg")]
        angle: f32,
    },
    /// A bouncy mushroom by its **cap top** (x, cap) standing on `base`
    /// height (adds a rock pedestal under low caps, and cap spots).
    Shroom { x: f32, base: f32, cap: f32, power: f32, shape: MushroomShape },
    /// A trampoline by its cap top (x, cap) standing on `base` height (adds
    /// a pedestal under low caps).
    Tramp { x: f32, base: f32, cap: f32, power: f32 },

    // ------------------------------------------------------------ gadgets
    /// A spinning launch gear centred at `center` (angle in degrees).
    LaunchPlate { center: Vec2, radius: f32, speed: f32, angle: f32, clockwise: bool },
    /// A seed-pod cannon on a stalk standing at `base` (angles in degrees).
    SeedPod { base: Vec2, height: f32, angle: f32, sweep: f32, power: f32 },
    /// A raw gadget (level format, radians).
    Gadget(Gadget),
    /// A balloon floating at `at` lasting `duration` s.
    Balloon { at: Vec2, duration: f32 },
    /// A claw crane gripping at `home` that carries you to `drop`.
    Crane { home: Vec2, drop: Vec2, travel: f32 },

    // ---------------------------------------------- progression and story
    /// A checkpoint on the surface at `[x, y]` (respawn 40 px above).
    Checkpoint(Vec2),
    /// One glow drop.
    Pickup(Vec2),
    /// `n` drops evenly from a to b.
    Pickups { a: Vec2, b: Vec2, n: usize },
    /// `n` drops along a jump arc from a to b peaking `h` above.
    PickupArc { a: Vec2, b: Vec2, h: f32, n: usize },
    /// `n` drops hovering 45 px over the surface at y, from x0 to x1.
    Drops { x0: f32, x1: f32, y: f32, n: usize },
    /// A character (level format).
    Npc(Npc),
    /// A story trigger: a tall band (y-200 .. y+600) across x0..x1.
    Say { x0: f32, x1: f32, y: f32, script: String },
    /// A story trigger over any rectangle.
    Story { min: Vec2, max: Vec2, script: String },
    /// The goal rectangle (exit caves place their own).
    Goal { min: Vec2, max: Vec2 },

    // --------------------------------------------------------------- decor
    /// One decor sprite (depth < 0 behind, > 0 in front).
    Decor { kind: String, at: Vec2, scale: f32, depth: f32 },
    /// Decor every `step` px along x0..x1 at height y.
    Scatter { kind: String, x0: f32, x1: f32, y: f32, step: f32, depth: f32 },
    /// Decor hanging from the roof every `step` px along x0..x1.
    Hang { kind: String, x0: f32, x1: f32, step: f32 },
}

impl Piece {
    /// The piece's key in the file (`"ledge"`, `"roof_spikes"`, …).
    pub fn kind(&self) -> String {
        let j = serde_json::to_value(self).expect("pieces serialise");
        j.as_object().and_then(|o| o.keys().next().cloned()).unwrap_or_default()
    }
}

fn blueprint_version() -> u32 {
    BLUEPRINT_VERSION
}
fn default_bottom() -> f32 {
    -1400.0
}
fn half() -> f32 {
    0.5
}
fn is_half(x: &f32) -> bool {
    *x == 0.5
}
fn is_zero(x: &f32) -> bool {
    *x == 0.0
}
fn is_false(b: &bool) -> bool {
    !*b
}
fn is_ground(m: &Material) -> bool {
    *m == Material::Ground
}
fn up_deg() -> f32 {
    90.0
}
fn is_up_deg(x: &f32) -> bool {
    *x == 90.0
}

// --------------------------------------------------------------- expansion

impl Blueprint {
    pub fn from_json(s: &str) -> Result<Blueprint, serde_json::Error> {
        serde_json::from_str(s)
    }

    /// Canonical, diff-friendly text (see [`crate::pretty`]).
    pub fn to_json(&self) -> String {
        crate::pretty::to_pretty(self)
    }

    /// Build the level (and its critical path).
    pub fn expand(&self) -> Course {
        let mut e = Expander::new(self);
        for p in &self.pieces {
            e.apply(p);
        }
        e.finish()
    }

    pub fn level(&self) -> Level {
        self.expand().level
    }

    /// Build the level, noting which terrain / jelly each piece made
    /// (for validation messages that point at the piece to edit).
    pub fn expand_traced(&self) -> (Course, Vec<PieceSpan>) {
        let mut e = Expander::new(self);
        let mut spans = Vec::with_capacity(self.pieces.len());
        for p in &self.pieces {
            let (t0, j0) = (e.b.level.terrain.len(), e.b.level.jelly.len());
            e.apply(p);
            spans.push(PieceSpan { terrain: t0..e.b.level.terrain.len(), jelly: j0..e.b.level.jelly.len() });
        }
        (e.finish(), spans)
    }
}

/// What one piece added to the level (index ranges).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PieceSpan {
    pub terrain: std::ops::Range<usize>,
    pub jelly: std::ops::Range<usize>,
}

/// Replays pieces onto a [`LevelBuilder`].
pub struct Expander {
    pub b: LevelBuilder,
    pub path: Vec<Waypoint>,
    /// Solid ground is filled down to here.
    pub bottom: f32,
    /// Roof undersides so far (for `hang` and `roof_spikes`).
    roofs: Vec<Vec<Vec2>>,
    /// Floor tops so far (pedestals stand on them).
    floors: Vec<Vec<Vec2>>,
}

impl Expander {
    pub fn new(bp: &Blueprint) -> Expander {
        let mut b = LevelBuilder::new(&bp.id, &bp.name, bp.theme);
        b.intro(&bp.intro).outro(&bp.outro).kill_y(bp.kill_y).spawn(bp.spawn);
        Expander { b, path: Vec::new(), bottom: bp.bottom, roofs: Vec::new(), floors: Vec::new() }
    }

    pub fn finish(self) -> Course {
        Course { level: self.b.build(), path: self.path }
    }

    pub fn apply(&mut self, p: &Piece) {
        match p {
            Piece::Floor(top) | Piece::Ground { top, .. } => self.floors.push(top.clone()),
            Piece::Ledge { x0, x1, y } | Piece::Shelf { x0, x1, y, .. } => self.floors.push(vec![v(*x0, *y), v(*x1, *y)]),
            _ => {}
        }
        let pedestal = |e: &Expander, x: f32, base: f32, height: f32| {
            // A rock pedestal so nobody gets stuck under a low cap. Its foot
            // follows the floor it stands on (no corner poking into the skin
            // on a slope).
            let (l, r) = (e.surface_at(x - 70.0, base).unwrap_or(base), e.surface_at(x + 70.0, base).unwrap_or(base));
            vec![v(x - 70.0, l), v(x + 70.0, r), v(x + 40.0, base + height - 6.0), v(x - 40.0, base + height - 6.0)]
        };
        let ped = match p {
            Piece::Shroom { x, base, cap, shape, .. } => {
                let size = if *shape == MushroomShape::Ball { 110.0 } else { 160.0 };
                let height = cap - base - shape.cap_height(size);
                (height < 130.0).then(|| pedestal(self, *x, *base, height))
            }
            Piece::Tramp { x, base, cap, .. } => {
                let height = cap - base - 160.0 * 0.28;
                (height < 130.0).then(|| pedestal(self, *x, *base, height))
            }
            _ => None,
        };
        let b = &mut self.b;
        match p {
            Piece::Section(_) | Piece::Note(_) => {}
            Piece::Wp(how, x, y) => self.path.push(Waypoint { at: v(*x, *y), how: *how }),

            Piece::Floor(top) => self.floor(top),
            Piece::Ledge { x0, x1, y } => self.floor(&[v(*x0, *y), v(*x1, *y)]),
            Piece::Shelf { x0, x1, y, depth } => {
                b.ground(&[v(*x0, *y), v(*x1, *y)], *depth);
            }
            Piece::Ground { top, depth, material, wobble } => {
                b.ground_with(top, *depth, *material, *wobble);
            }
            Piece::Roof(bottom) => {
                b.ceiling(bottom, 500.0);
                self.roofs.push(bottom.clone());
            }
            Piece::Ceiling { bottom, height } => {
                b.ceiling(bottom, *height);
            }
            Piece::Wall { x0, x1, y0, y1 } => {
                b.block(v(*x0, *y0), v(*x1, *y1));
            }
            Piece::Block { min, max, material } => {
                b.terrain(Shape::rect(*min, *max), *material);
            }
            Piece::Poly { points, material } => {
                b.terrain(Shape::Poly { points: points.clone() }, *material);
            }
            Piece::OneWay { x0, x1, y, thick } => {
                b.one_way(v(*x0, *y - *thick), v(*x1, *y));
            }
            Piece::Ramp { a, b: bb } => {
                b.ramp(*a, *bb);
            }
            Piece::Terrain(t) => b.level.terrain.push(t.clone()),
            Piece::Jelly { min, max, wobble } => {
                b.jelly(*min, *max, *wobble);
            }
            Piece::EntryCave { x_far, x_face, y, top, theme } => self.entry_cave(*x_far, *x_face, *y, *top, *theme),
            Piece::ExitCave { x_face, x_far, y, top, theme, daylight } => self.exit_cave(*x_face, *x_far, *y, *top, *theme, *daylight),

            Piece::Bridge { a, b: bb, thick, stiffness } => {
                b.bridge(*a, *bb, *thick, *stiffness);
            }
            Piece::Slab { center, size, stiffness } => {
                b.slab(*center, *size, *stiffness);
            }
            Piece::Lily { surface, width } => {
                b.lily(*surface, *width);
            }
            Piece::Prop(prop) => b.level.props.push(prop.clone()),
            Piece::Crate { at, size } => {
                b.crate_box(*at, *size);
            }
            Piece::Ball { at, radius, color } => {
                b.ball(*at, *radius, color);
            }
            Piece::Seesaw { id, pivot, length, mass } => {
                b.seesaw(id, *pivot, *length, *mass);
            }

            Piece::Mover(m) => b.level.movers.push(m.clone()),
            Piece::Elevator { a, b: bb, width, period, phase } => {
                b.elevator(*a, *bb, *width, *period);
                if let Some(m) = b.level.movers.last_mut() {
                    m.phase = *phase;
                }
            }
            Piece::Piston { x, roof, floor, phase, spiked } => {
                // Wide enough that puffing up can't squeeze you out from under it.
                b.crusher(v(*x, *roof), 210.0, *roof - 120.0 - *floor - 4.0, *phase);
                if *spiked {
                    b.spiked();
                }
            }
            Piece::Crusher { top, width, drop, phase, spiked } => {
                b.crusher(*top, *width, *drop, *phase);
                if *spiked {
                    b.spiked();
                }
            }
            Piece::Blade { center, size, speed } => {
                b.blade(*center, *size, *speed);
            }
            Piece::Drip { top, fall, radius, phase } => {
                b.drip_hazard(*top, *fall, *radius, *phase);
            }
            Piece::Conveyor { at, length, speed } => {
                b.conveyor(*at, *length, *speed);
            }

            Piece::Vine { top, length, knob } => {
                if *knob {
                    knob_at(b, *top);
                }
                b.vine(*top, *length);
            }
            Piece::Rope { from, to, length, style, knob } => {
                if let (true, RopeEnd::World { at }) = (*knob, from) {
                    knob_at(b, *at);
                }
                b.rope(from.clone(), to.clone(), *length, *style);
            }

            Piece::Zone { min, max, kind } => {
                b.zone(*min, *max, kind.clone());
            }
            Piece::Water { min, max } => {
                b.water(*min, *max);
            }
            Piece::Current { min, max, flow } => {
                b.current(*min, *max, *flow);
            }
            Piece::Wind { min, max, accel } => {
                b.wind(*min, *max, *accel);
            }

            Piece::Spring { at, angle, power } => {
                b.spring(*at, *angle, *power);
            }
            Piece::Spikes { a, b: bb } => {
                b.spikes(*a, *bb);
            }
            Piece::CeilingSpikes { x0, x1, y } => {
                b.ceiling_spikes(*x0, *x1, *y);
            }
            Piece::RoofSpikes { x0, x1, gaps, keep } => self.roof_spikes(*x0, *x1, gaps, *keep),
            Piece::Trampoline { base, height, cap, power } => {
                b.trampoline(*base, *height, *cap, *power);
            }
            Piece::Mushroom { base, height, shape, size, power, angle } => {
                b.bouncy_mushroom_angled(*base, *height, *shape, *size, *power, *angle);
            }
            Piece::Shroom { x, base, cap, power, shape } => {
                let (x, base_y, cap_y, power, shape) = (*x, *base, *cap, *power, *shape);
                let size = if shape == MushroomShape::Ball { 110.0 } else { 160.0 };
                let height = cap_y - base_y - shape.cap_height(size);
                if let Some(ped) = &ped {
                    b.poly(ped);
                }
                b.bouncy_mushroom(v(x, base_y), height, shape, size, power);
                b.decor("mushroom_spots", v(x, base_y + height), size / 120.0, 0.5);
            }
            Piece::Tramp { x, base, cap, power } => {
                let (x, base, cap) = (*x, *base, *cap);
                let height = cap - base - 160.0 * 0.28;
                if let Some(ped) = &ped {
                    b.poly(ped);
                }
                b.trampoline(v(x, base), height, 160.0, *power);
            }

            Piece::LaunchPlate { center, radius, speed, angle, clockwise } => {
                b.launch_plate(*center, *radius, *speed, *angle, *clockwise);
            }
            Piece::SeedPod { base, height, angle, sweep, power } => {
                b.seed_pod(*base, *height, *angle, *sweep, *power);
            }
            Piece::Gadget(g) => b.level.gadgets.push(g.clone()),
            Piece::Balloon { at, duration } => {
                b.balloon(*at, *duration);
            }
            Piece::Crane { home, drop, travel } => {
                b.crane(*home, *drop, *travel);
            }

            Piece::Checkpoint(at) => {
                b.checkpoint(v(at.x, at.y + 40.0));
            }
            Piece::Pickup(at) => {
                b.pickup(*at);
            }
            Piece::Pickups { a, b: bb, n } => {
                b.pickups(*a, *bb, *n);
            }
            Piece::PickupArc { a, b: bb, h, n } => {
                b.pickup_arc(*a, *bb, *h, *n);
            }
            Piece::Drops { x0, x1, y, n } => {
                b.pickups(v(*x0, *y + 45.0), v(*x1, *y + 45.0), *n);
            }
            Piece::Npc(n) => b.level.npcs.push(n.clone()),
            Piece::Say { x0, x1, y, script } => {
                b.story(v(*x0, *y - 200.0), v(*x1, *y + 600.0), script);
            }
            Piece::Story { min, max, script } => {
                b.story(*min, *max, script);
            }
            Piece::Goal { min, max } => {
                b.goal(*min, *max);
            }

            Piece::Decor { kind, at, scale, depth } => {
                b.decor(kind, *at, *scale, *depth);
            }
            Piece::Scatter { kind, x0, x1, y, step, depth } => {
                let mut x = *x0;
                let mut k = 0;
                while x <= *x1 {
                    let s = 0.8 + ((k * 37) % 5) as f32 * 0.1;
                    b.decor(kind, v(x, *y), s, *depth);
                    x += step;
                    k += 1;
                }
            }
            Piece::Hang { kind, x0, x1, step } => self.hang(kind, *x0, *x1, *step),
        }
    }

    /// Jelly-skinned ground following `top`, solid down to the level bottom.
    fn floor(&mut self, top: &[Vec2]) {
        let min = top.iter().map(|p| p.y).fold(f32::MAX, f32::min);
        self.b.ground(top, (min - self.bottom).max(80.0));
    }

    /// Height at `x` of the floor top nearest `near_y` (within 40 px).
    pub fn surface_at(&self, x: f32, near_y: f32) -> Option<f32> {
        self.floors
            .iter()
            .flat_map(|r| r.windows(2))
            .filter(|w| w[0].x <= x && x <= w[1].x && w[1].x > w[0].x)
            .map(|w| w[0].y + (w[1].y - w[0].y) * (x - w[0].x) / (w[1].x - w[0].x))
            .filter(|y| (y - near_y).abs() < 40.0)
            .min_by(|a, b| (a - near_y).abs().total_cmp(&(b - near_y).abs()))
    }

    /// Height of the roof underside at `x` (lowest roof covering x).
    pub fn roof_at(&self, x: f32) -> Option<f32> {
        self.roofs
            .iter()
            .flat_map(|r| r.windows(2))
            .filter(|w| w[0].x <= x && x <= w[1].x && w[1].x > w[0].x)
            .map(|w| w[0].y + (w[1].y - w[0].y) * (x - w[0].x) / (w[1].x - w[0].x))
            .reduce(f32::min)
    }

    fn hang(&mut self, kind: &str, x0: f32, x1: f32, step: f32) {
        let mut x = x0;
        let mut k = 0;
        while x <= x1 {
            if let Some(y) = self.roof_at(x) {
                let s = 0.8 + ((k * 37) % 5) as f32 * 0.1;
                let dy = if kind == "glowworm" { 14.0 + ((k * 53) % 4) as f32 * 10.0 } else { 0.0 };
                self.b.decor(kind, v(x, y - dy), s, -1.0);
            }
            x += step;
            k += 1;
        }
    }

    /// Spikes along the underside of the roof from x0 to x1 (teeth down),
    /// following its slope, leaving `keep` px clear either side of each x in
    /// `gaps` (vine roots, slinky hooks).
    fn roof_spikes(&mut self, x0: f32, x1: f32, gaps: &[f32], keep: f32) {
        // Split x0..x1 at every roof vertex and around every gap.
        let mut cuts: Vec<f32> = vec![x0, x1];
        for r in &self.roofs {
            cuts.extend(r.iter().map(|p| p.x).filter(|x| *x > x0 && *x < x1));
        }
        for g in gaps {
            cuts.push((g - keep).clamp(x0, x1));
            cuts.push((g + keep).clamp(x0, x1));
        }
        cuts.sort_by(f32::total_cmp);
        cuts.dedup_by(|a, b| (*a - *b).abs() < 1.0);
        for w in cuts.windows(2) {
            let (a, b) = (w[0], w[1]);
            let mid = (a + b) * 0.5;
            if b - a < 30.0 || gaps.iter().any(|g| (mid - g).abs() < keep) {
                continue;
            }
            let (Some(ya), Some(yb)) = (self.roof_at(a + 0.5), self.roof_at(b - 0.5)) else { continue };
            // Right to left: teeth point down.
            self.b.spikes(v(b, yb), v(a, ya));
        }
    }

    fn entry_cave(&mut self, x_far: f32, x_face: f32, y: f32, top: f32, prev: Theme) {
        let facing = (x_far - x_face).signum();
        let size = v(260.0, 280.0);
        self.cave_rock(x_face, x_far, y, top, size, facing);
        self.b.level.mouths.push(CaveMouth { pos: v(x_face, y), facing, kind: MouthKind::Entry, theme: prev, size, daylight: false });
    }

    fn exit_cave(&mut self, x_face: f32, x_far: f32, y: f32, top: f32, next: Theme, daylight: bool) {
        let facing = (x_far - x_face).signum();
        let size = v(560.0, 300.0);
        self.cave_rock(x_face, x_far, y, top, size, facing);
        self.b.level.mouths.push(CaveMouth { pos: v(x_face, y), facing, kind: MouthKind::Exit, theme: next, size, daylight });
        // The goal sits deep inside, so you see yourself walk in.
        let (g0, g1) = (x_face + facing * (size.x - 300.0), x_face + facing * (size.x - 70.0));
        self.b.goal(v(g0.min(g1), y), v(g0.max(g1), y + size.y - 40.0));
    }

    /// Rock with a floor-level tunnel cut into its face (rounded lip and
    /// back), plus the tunnel floor.
    fn cave_rock(&mut self, x_face: f32, x_far: f32, y: f32, top: f32, size: Vec2, facing: f32) {
        let (d, h) = (size.x, size.y);
        let x = |dx: f32| x_face + facing * dx;
        let arc = |pts: &mut Vec<Vec2>, c: Vec2, r: f32, a0: f32, a1: f32| {
            for i in 0..=6 {
                let a = a0 + (a1 - a0) * i as f32 / 6.0;
                pts.push(c + v(facing * a.cos() * r, a.sin() * r));
            }
        };
        // One piece of rock from a deep plinth up to `top` (not all the way
        // down to the level bottom: the finale's exit is high above other
        // things), so no buried ledge edges sprout cave-grass inside it.
        let base = (y - 700.0).max(self.bottom);
        let (r1, r2) = (46.0, 90.0);
        let mut pts = vec![v(x_far, base), v(x_far, top), v(x_face, top)];
        // Down the face, round the lip into the tunnel roof.
        arc(&mut pts, v(x(r1), y + h + r1), r1, std::f32::consts::PI, std::f32::consts::PI * 1.5);
        // Along the roof, round the back into the floor.
        arc(&mut pts, v(x(d - r2), y + h - r2), r2, std::f32::consts::FRAC_PI_2, 0.0);
        pts.push(v(x(d), y - metrics::SKIN));
        pts.push(v(x(d), base));
        if facing < 0.0 {
            pts.reverse();
        }
        self.b.poly(&pts);
        // The tunnel floor: jelly-skinned like any floor. Its skin runs a
        // few px out of the mouth, under the floor outside, so the two
        // skins overlap like neighbouring tiles instead of butting together.
        let (a, b) = (x_face, x(d));
        let j0 = self.b.level.jelly.len();
        self.b.ground(&[v(a.min(b), y), v(a.max(b), y)], y - base);
        let lap = -facing * metrics::SEAM_LAP;
        for j in &mut self.b.level.jelly[j0..] {
            if let Shape::Poly { points } = &mut j.shape {
                for p in points.iter_mut().filter(|p| (p.x - x_face).abs() < 0.01) {
                    p.x += lap;
                }
            }
        }
    }
}

/// A little root knob of rock for a vine / slinky hanging from `top`.
fn knob_at(b: &mut LevelBuilder, top: Vec2) {
    let (x, top) = (top.x, top.y);
    b.poly(&[v(x - 34.0, top + 30.0), v(x + 34.0, top + 30.0), v(x + 14.0, top - 4.0), v(x - 14.0, top - 4.0)]);
}
