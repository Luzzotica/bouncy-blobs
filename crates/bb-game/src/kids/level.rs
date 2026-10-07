//! The Kids Playground, converted from legacy `public/levels/kids-playground.json`.
//!
//! Legacy is y-down with 48 px blobs in an 1800 × 1100 box. The port uses
//! y-up and 32 px blobs, so everything is scaled by 2/3 (which also makes
//! the floor → side-platform hop exactly one comfortable jump):
//! `new = ((x, 1100 − y)) · 2/3`.
//!
//! The walls and floor extend well past the box so the paper-craft surround
//! fills any screen aspect; the floor doubles as the colour-chip tray and
//! the ceiling as the button shelf.

use bb_level::{Level, LevelBuilder, Mode, Theme, v};
use bb_physics::Vec2;

/// Legacy → port coordinates.
pub fn conv(x: f32, y: f32) -> Vec2 {
    v(x, 1100.0 - y) * (2.0 / 3.0)
}

/// Interior of the box (where blobs play).
pub const INNER_MIN: Vec2 = Vec2::new(53.3, 80.0);
pub const INNER_MAX: Vec2 = Vec2::new(1146.7, 680.0);
/// World rectangle the camera always fits on screen (box + chrome bands).
pub const VIEW_MIN: Vec2 = Vec2::new(-40.0, -170.0);
pub const VIEW_MAX: Vec2 = Vec2::new(1240.0, 830.0);

/// Kid-facing shape cycle (legacy `KIDS_SHAPES`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KidsShape {
    Star,
    Square,
    Triangle,
}

pub const KIDS_SHAPES: [KidsShape; 3] = [KidsShape::Star, KidsShape::Square, KidsShape::Triangle];

impl KidsShape {
    pub fn stem(self) -> &'static str {
        match self {
            KidsShape::Star => "star",
            KidsShape::Square => "square",
            KidsShape::Triangle => "triangle",
        }
    }

    /// Hull outline at port scale (legacy hullPresets × 2/3), y-up, point up.
    pub fn outline(self) -> Vec<Vec2> {
        let s = 2.0 / 3.0;
        let ring = |n: usize, r: f32, inner: Option<f32>| -> Vec<Vec2> {
            let k = if inner.is_some() { n * 2 } else { n };
            (0..k)
                .map(|i| {
                    let a = std::f32::consts::FRAC_PI_2 + i as f32 / k as f32 * std::f32::consts::TAU;
                    let rr = match inner {
                        Some(ir) if i % 2 == 1 => ir,
                        _ => r,
                    };
                    v(a.cos(), a.sin()) * rr * s
                })
                .collect()
        };
        match self {
            KidsShape::Star => ring(5, 56.0, Some(22.0)),
            KidsShape::Square => {
                let h = 48.0 * s;
                vec![v(-h, -h), v(h, -h), v(h, h), v(-h, h)]
            }
            KidsShape::Triangle => ring(3, 52.0, None),
        }
    }
}

/// The 8 friends: (legacy position, shape).
pub fn friends() -> Vec<(Vec2, KidsShape)> {
    use KidsShape::*;
    [
        (320.0, 860.0, Star),
        (520.0, 640.0, Square),
        (900.0, 400.0, Triangle),
        (1280.0, 640.0, Star),
        (1480.0, 860.0, Square),
        (700.0, 860.0, Triangle),
        (1100.0, 860.0, Star),
        (900.0, 640.0, Square),
    ]
    .into_iter()
    .map(|(x, y, s)| (conv(x, y), s))
    .collect()
}

pub fn playground() -> Level {
    let mut b = LevelBuilder::new("kids-playground", "Kids Playground", Theme::Kids);
    b.level.modes = vec![Mode::Kids];
    let (lo, hi) = (INNER_MIN, INNER_MAX);
    // A picture frame of four non-overlapping slabs (clean seams), plus
    // one wobbly jelly skin on the floor.
    b.spawn(conv(900.0, 860.0))
        .block(v(-700.0, -400.0), v(1900.0, lo.y - 26.0))
        .block(v(-700.0, hi.y), v(1900.0, 1300.0))
        .block(v(-700.0, lo.y - 26.0), v(lo.x, hi.y))
        .block(v(hi.x, lo.y - 26.0), v(1900.0, hi.y))
        .jelly(v(lo.x, lo.y - 26.0), v(hi.x, lo.y), 0.5)
        .kill_y(-500.0);
    // Platforms: legacy centre + size, now soft jelly slabs that bob.
    for (x, y, w) in [(420.0, 720.0, 280.0), (1380.0, 720.0, 280.0), (900.0, 480.0, 320.0)] {
        let c = conv(x, y);
        let h = v(w, 48.0) * (1.0 / 3.0);
        b.jelly(c - h, c + h, 0.35);
    }
    b.build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playground_matches_legacy_layout() {
        let l = playground();
        assert_eq!(l.spawn, v(600.0, 160.0));
        assert_eq!(l.jelly.iter().filter(|j| j.wobble == 0.35).count(), 3);
        assert_eq!(l.terrain.len(), 4);
        let back = Level::from_json(&l.to_json()).unwrap();
        assert_eq!(back.terrain.len(), l.terrain.len());
        // Every friend and the spawn sit inside the box.
        for (p, _) in friends() {
            assert!(p.x > INNER_MIN.x && p.x < INNER_MAX.x && p.y > INNER_MIN.y && p.y < INNER_MAX.y, "{p}");
        }
    }

    #[test]
    fn friends_stay_in_the_box_and_never_pop() {
        let mut sim = bb_sim::Sim::new(playground());
        sim.rules.players_pop = false;
        for (i, (p, shape)) in friends().into_iter().enumerate() {
            let body = sim.add_player(i as u8 + 1, "", 0xffffff).ctl.body;
            assert!(sim.world.body_mut(body).unwrap().set_rest_shape(&shape.outline()));
            sim.world.respawn(body, p);
        }
        for k in 0..600 {
            for i in 1..=8u8 {
                let dir = if (k / 90 + i as usize) % 2 == 0 { 1.0 } else { -1.0 };
                sim.set_input(i, bb_sim::Input { stick: bb_sim::Vec2::new(dir * 0.55, 0.0), button: k % 150 < 30 });
            }
            sim.step();
        }
        for p in &sim.players {
            assert!(p.dead.is_none());
            let c = sim.world.body(p.ctl.body).unwrap().centroid();
            assert!(c.x > INNER_MIN.x && c.x < INNER_MAX.x && c.y > INNER_MIN.y - 5.0 && c.y < INNER_MAX.y, "slot {} at {c}", p.slot);
        }
    }
}
