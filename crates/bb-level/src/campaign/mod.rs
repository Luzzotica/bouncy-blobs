//! **Up & Out** — the 10-chapter story campaign, authored as code.
//!
//! Each chapter is a long, hand-built level (JellyCar length) plus its
//! *critical path*: the waypoints a player must pass, each tagged with how
//! you get there from the previous one. Tests use the path to audit jump
//! heights and gaps against the controller metrics and to drive an
//! autopilot playtest bot (see `tests/campaign.rs`).
//!
//! Waypoints are **feet positions** (on the surface you stand on).

use std::ops::{Deref, DerefMut};

use glam::Vec2;

pub(crate) use crate::builder::v;
use crate::builder::metrics;
use crate::builder::LevelBuilder;
use crate::types::*;

mod ch01;
mod ch02;
mod ch03;
mod ch04;
mod ch05;
mod ch06;
mod ch07;
mod ch08;
mod ch09;
mod ch10;

pub const CHAPTERS: u8 = 10;

/// How the player gets from the previous waypoint to this one.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Move {
    /// Roll along connected ground (slopes and small bumps included).
    Walk,
    /// A required jump: take off at the previous waypoint, land here.
    Jump,
    /// Roll off a ledge and fall to here.
    Drop,
    /// Roll through a low tunnel.
    Squeeze,
    /// Wait for a gap in a hazard's rhythm (crushers, drips), then roll
    /// through underneath.
    Dash,
    /// Push a prop ahead of you.
    Push,
    /// Launched by a spring pad or trampoline mushroom.
    Spring,
    /// Swing on vines / ropes and let go.
    Rope,
    /// Ride an updraft or gust (puff up to float).
    Wind,
    /// Ride a moving platform / elevator.
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

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Waypoint {
    pub at: Vec2,
    pub how: Move,
}

/// A chapter: the level and its declared critical path.
#[derive(Clone, Debug)]
pub struct Course {
    pub level: Level,
    pub path: Vec<Waypoint>,
}

/// Chapter `n` (1-based) with its critical path.
pub fn course(n: u8) -> Course {
    match n {
        1 => ch01::build(),
        2 => ch02::build(),
        3 => ch03::build(),
        4 => ch04::build(),
        5 => ch05::build(),
        6 => ch06::build(),
        7 => ch07::build(),
        8 => ch08::build(),
        9 => ch09::build(),
        10 => ch10::build(),
        _ => panic!("no chapter {n} (1..={CHAPTERS})"),
    }
}

/// Chapter `n` (1-based).
pub fn chapter(n: u8) -> Level {
    course(n).level
}

/// All ten chapters in order.
pub fn campaign() -> Vec<Level> {
    (1..=CHAPTERS).map(chapter).collect()
}

/// Look up a chapter by id ("ch01" … "ch10").
pub fn by_id(id: &str) -> Option<Level> {
    let n: u8 = id.strip_prefix("ch")?.parse().ok()?;
    (1..=CHAPTERS).contains(&n).then(|| chapter(n))
}

// ------------------------------------------------------------- authoring

/// Chapter authoring wrapper: a [`LevelBuilder`] (via `Deref`) plus the
/// critical path and a few cave-building shortcuts.
pub(crate) struct Ch {
    pub b: LevelBuilder,
    pub path: Vec<Waypoint>,
    /// Solid ground is filled down to here.
    pub bottom: f32,
    /// Roof undersides, for hanging decor.
    roofs: Vec<Vec<Vec2>>,
}

impl Deref for Ch {
    type Target = LevelBuilder;
    fn deref(&self) -> &LevelBuilder {
        &self.b
    }
}

impl DerefMut for Ch {
    fn deref_mut(&mut self) -> &mut LevelBuilder {
        &mut self.b
    }
}

impl Ch {
    pub fn new(n: u8, name: &str, theme: Theme, bottom: f32) -> Ch {
        let id = format!("ch{n:02}");
        let mut b = LevelBuilder::new(&id, name, theme);
        b.intro(&format!("{id}_intro")).outro(&format!("{id}_outro")).kill_y(bottom + 200.0);
        Ch { b, path: Vec::new(), bottom, roofs: Vec::new() }
    }

    /// Jelly-skinned ground following `top`, solid down to the level bottom.
    pub fn floor(&mut self, top: &[Vec2]) -> &mut Self {
        let min = top.iter().map(|p| p.y).fold(f32::MAX, f32::min);
        self.b.ground(top, (min - self.bottom).max(80.0));
        self
    }

    /// Flat ground from `x0` to `x1` at height `y`, down to the bottom.
    pub fn ledge(&mut self, x0: f32, x1: f32, y: f32) -> &mut Self {
        self.floor(&[v(x0, y), v(x1, y)])
    }

    /// A floating shelf of jelly-topped rock, `depth` thick.
    pub fn shelf(&mut self, x0: f32, x1: f32, y: f32, depth: f32) -> &mut Self {
        self.b.ground(&[v(x0, y), v(x1, y)], depth);
        self
    }

    /// Cave roof whose underside follows `bottom` (left to right).
    pub fn roof(&mut self, bottom: &[Vec2]) -> &mut Self {
        self.b.ceiling(bottom, 500.0);
        self.roofs.push(bottom.to_vec());
        self
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

    /// Hang decor `kind` from the roof along x0..x1 every `step` px.
    pub fn hang(&mut self, kind: &str, x0: f32, x1: f32, step: f32) -> &mut Self {
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
        self
    }

    /// A solid rock wall / pillar.
    pub fn wall(&mut self, x0: f32, x1: f32, y0: f32, y1: f32) -> &mut Self {
        self.b.block(v(x0, y0), v(x1, y1));
        self
    }

    /// Append a critical-path waypoint (feet position).
    pub fn wp(&mut self, how: Move, x: f32, y: f32) -> &mut Self {
        self.path.push(Waypoint { at: v(x, y), how });
        self
    }

    /// A checkpoint whose respawn sits just above the surface at (x, y).
    pub fn cp(&mut self, x: f32, y: f32) -> &mut Self {
        self.b.checkpoint(v(x, y + 40.0));
        self
    }

    /// A row of glow drops hovering over a surface.
    pub fn drops(&mut self, x0: f32, x1: f32, y: f32, n: usize) -> &mut Self {
        self.b.pickups(v(x0, y + 45.0), v(x1, y + 45.0), n);
        self
    }

    /// A story trigger: a tall band across the path at x0..x1.
    pub fn say(&mut self, x0: f32, x1: f32, y: f32, script: &str) -> &mut Self {
        self.b.story(v(x0, y - 200.0), v(x1, y + 600.0), script);
        self
    }

    /// Scatter decor `kind` along x0..x1 at height y every `step` px.
    pub fn scatter(&mut self, kind: &str, x0: f32, x1: f32, y: f32, step: f32, depth: f32) -> &mut Self {
        let mut x = x0;
        let mut k = 0;
        while x <= x1 {
            let s = 0.8 + ((k * 37) % 5) as f32 * 0.1;
            self.b.decor(kind, v(x, y), s, depth);
            x += step;
            k += 1;
        }
        self
    }

    /// Spikes along the underside of the roof from x0 to x1 (teeth down),
    /// following its slope, leaving `keep` px clear either side of each x in
    /// `gaps` (vine roots, slinky hooks). Over sections a mechanic gates, so
    /// crawling along the ceiling is never a shortcut. Call after `roof`.
    pub fn roof_spikes(&mut self, x0: f32, x1: f32, gaps: &[f32], keep: f32) -> &mut Self {
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
        self
    }

    /// The level's opening wall with a **sealed entry cave**: rock from
    /// `x_far` to the face at `x_face` (floor height `y`, up to `top`), with a
    /// shallow tunnel mouth at floor level that glows with the previous
    /// chapter's colour (a rock-fall plugs it: scenery, not a way back).
    /// The tunnel runs away from the level (towards `x_far`).
    pub fn entry_cave(&mut self, x_far: f32, x_face: f32, y: f32, top: f32, prev: Theme) -> &mut Self {
        let facing = (x_far - x_face).signum();
        let size = v(260.0, 280.0);
        self.cave_rock(x_face, x_far, y, top, size, facing);
        self.b.level.mouths.push(CaveMouth { pos: v(x_face, y), facing, kind: MouthKind::Entry, theme: prev, size, daylight: false });
        self
    }

    /// The level's closing wall with an **exit cave**: rock from the face at
    /// `x_face` to `x_far`, with a tunnel at floor height `y` that you walk
    /// into; it glows with the next chapter's colour and holds the goal.
    pub fn exit_cave(&mut self, x_face: f32, x_far: f32, y: f32, top: f32, next: Theme) -> &mut Self {
        let facing = (x_far - x_face).signum();
        let size = v(560.0, 300.0);
        self.cave_rock(x_face, x_far, y, top, size, facing);
        self.b.level.mouths.push(CaveMouth { pos: v(x_face, y), facing, kind: MouthKind::Exit, theme: next, size, daylight: false });
        // The goal sits deep inside, so you see yourself walk in.
        let (g0, g1) = (x_face + facing * (size.x - 300.0), x_face + facing * (size.x - 70.0));
        self.b.goal(v(g0.min(g1), y), v(g0.max(g1), y + size.y - 40.0));
        self
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
        // Outline (for facing +1: counter-clockwise). One piece of rock
        // from a deep plinth up to `top` (not all the way down to the level
        // bottom: the finale's exit is high above other things), so no
        // buried ledge edges sprout cave-grass inside it.
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
        // The tunnel floor: jelly-skinned like any floor.
        let (a, b) = (x_face, x(d));
        self.b.ground(&[v(a.min(b), y), v(a.max(b), y)], y - base);
    }

    pub fn finish(self) -> Course {
        Course { level: self.b.build(), path: self.path }
    }
}
