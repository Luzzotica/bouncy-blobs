//! Ergonomic level authoring. Campaign levels are written as code with these
//! helpers, then serialised like any other level.

use glam::Vec2;

use crate::types::*;

/// Player-scale metrics the campaign is designed around. Keep in sync with
/// the player controller tuning (tests in bb-game verify them).
pub mod metrics {
    /// Player blob radius.
    pub const PLAYER_R: f32 = 32.0;
    /// Comfortable jump height (expand-jump from flat jelly ground).
    pub const JUMP_H: f32 = 190.0;
    /// Comfortable running-jump gap.
    pub const GAP: f32 = 260.0;
    /// Thickness of jelly skins on top of ground.
    pub const SKIN: f32 = 26.0;
    /// Max jelly tile length before splitting.
    pub const TILE: f32 = 280.0;
}

pub fn v(x: f32, y: f32) -> Vec2 {
    Vec2::new(x, y)
}

pub struct LevelBuilder {
    pub level: Level,
}

impl LevelBuilder {
    pub fn new(id: &str, name: &str, theme: Theme) -> LevelBuilder {
        let mut level = Level::new(id, name);
        level.theme = theme;
        LevelBuilder { level }
    }

    pub fn build(self) -> Level {
        self.level
    }

    pub fn spawn(&mut self, p: Vec2) -> &mut Self {
        self.level.spawn = p;
        self
    }

    pub fn kill_y(&mut self, y: f32) -> &mut Self {
        self.level.kill_y = y;
        self
    }

    pub fn intro(&mut self, script: &str) -> &mut Self {
        self.level.intro = script.into();
        self
    }

    pub fn outro(&mut self, script: &str) -> &mut Self {
        self.level.outro = script.into();
        self
    }

    // ------------------------------------------------------------- terrain

    pub fn terrain(&mut self, shape: Shape, material: Material) -> &mut Self {
        self.level.terrain.push(Terrain { shape, material, one_way: false });
        self
    }

    pub fn block(&mut self, min: Vec2, max: Vec2) -> &mut Self {
        self.terrain(Shape::rect(min, max), Material::Ground)
    }

    pub fn stone(&mut self, min: Vec2, max: Vec2) -> &mut Self {
        self.terrain(Shape::rect(min, max), Material::Stone)
    }

    pub fn poly(&mut self, points: &[Vec2]) -> &mut Self {
        self.terrain(Shape::Poly { points: points.to_vec() }, Material::Ground)
    }

    pub fn one_way(&mut self, min: Vec2, max: Vec2) -> &mut Self {
        self.level.terrain.push(Terrain { shape: Shape::rect(min, max), material: Material::Ground, one_way: true });
        self
    }

    /// Solid ground whose top surface follows `top` (left to right), `depth`
    /// deep, covered by a wobbly jelly skin.
    pub fn ground(&mut self, top: &[Vec2], depth: f32) -> &mut Self {
        self.ground_with(top, depth, Material::Ground, 0.5)
    }

    pub fn ground_with(&mut self, top: &[Vec2], depth: f32, material: Material, wobble: f32) -> &mut Self {
        if top.len() < 2 {
            return self;
        }
        let skin = metrics::SKIN;
        let floor = top.iter().map(|p| p.y).fold(f32::MAX, f32::min) - depth;
        // Solid core under the skin.
        let mut core: Vec<Vec2> = vec![v(top[0].x, floor)];
        core.push(v(top[top.len() - 1].x, floor));
        for p in top.iter().rev() {
            core.push(*p - v(0.0, skin));
        }
        self.level.terrain.push(Terrain { shape: Shape::Poly { points: core }, material, one_way: false });
        // Jelly tiles along the surface.
        for w in top.windows(2) {
            let (a, b) = (w[0], w[1]);
            let n = ((b - a).length() / metrics::TILE).ceil().max(1.0) as usize;
            for k in 0..n {
                let p0 = a.lerp(b, k as f32 / n as f32);
                let p1 = a.lerp(b, (k + 1) as f32 / n as f32);
                let pts = vec![p0 - v(0.0, skin), p1 - v(0.0, skin), p1, p0];
                self.level.jelly.push(Jelly { shape: Shape::Poly { points: pts }, material, wobble });
            }
        }
        self
    }

    /// Ceiling whose bottom surface follows `bottom`, `height` tall.
    pub fn ceiling(&mut self, bottom: &[Vec2], height: f32) -> &mut Self {
        if bottom.len() < 2 {
            return self;
        }
        let top = bottom.iter().map(|p| p.y).fold(f32::MIN, f32::max) + height;
        let mut pts: Vec<Vec2> = bottom.to_vec();
        pts.push(v(bottom[bottom.len() - 1].x, top));
        pts.push(v(bottom[0].x, top));
        self.level.terrain.push(Terrain { shape: Shape::Poly { points: pts }, material: Material::Ground, one_way: false });
        self
    }

    /// A free-standing jelly block (wobbly ledge).
    pub fn jelly(&mut self, min: Vec2, max: Vec2, wobble: f32) -> &mut Self {
        self.level.jelly.push(Jelly { shape: Shape::rect(min, max), material: Material::Ground, wobble });
        self
    }

    pub fn jelly_mat(&mut self, shape: Shape, material: Material, wobble: f32) -> &mut Self {
        self.level.jelly.push(Jelly { shape, material, wobble });
        self
    }

    /// Bouncy mushroom cap on a stalk (stalk is solid, cap is bouncy jelly).
    pub fn mushroom(&mut self, base: Vec2, height: f32, cap_w: f32) -> &mut Self {
        self.block(base + v(-14.0, 0.0), base + v(14.0, height - 10.0));
        let c = base + v(0.0, height);
        let cap: Vec<Vec2> = (0..=10)
            .map(|i| {
                let a = std::f32::consts::PI * i as f32 / 10.0;
                c + v(a.cos() * cap_w * 0.5, a.sin() * cap_w * 0.28)
            })
            .collect();
        self.level.jelly.push(Jelly { shape: Shape::Poly { points: cap }, material: Material::Bouncy, wobble: 0.9 });
        self.level.decor.push(Decor { kind: "mushroom_spots".into(), pos: c, scale: cap_w / 120.0, angle: 0.0, depth: 0.5 });
        self
    }

    // ------------------------------------------------------- soft & dynamic

    /// Soft bridge between two points (pinned at both ends).
    pub fn bridge(&mut self, a: Vec2, b: Vec2, thickness: f32, stiffness: f32) -> &mut Self {
        let center = (a + b) * 0.5;
        let d = b - a;
        self.level.platforms.push(SoftPlatform {
            id: String::new(),
            center,
            size: v(d.length(), thickness),
            angle: d.y.atan2(d.x),
            pins: Pins::Ends,
            stiffness,
            material: Material::Ground,
        });
        self
    }

    /// Floating jelly slab that bobs when you land on it.
    pub fn slab(&mut self, center: Vec2, size: Vec2, stiffness: f32) -> &mut Self {
        self.level.platforms.push(SoftPlatform {
            id: String::new(),
            center,
            size,
            angle: 0.0,
            pins: Pins::Home,
            stiffness,
            material: Material::Ground,
        });
        self
    }

    pub fn platform(&mut self, p: SoftPlatform) -> &mut Self {
        self.level.platforms.push(p);
        self
    }

    pub fn prop(&mut self, id: &str, kind: PropKind, center: Vec2, size: Vec2, mass: f32, color: &str) -> &mut Self {
        self.level.props.push(Prop {
            id: id.into(),
            kind,
            center,
            size,
            angle: 0.0,
            mass,
            material: Material::Ground,
            color: color.into(),
            pinned: false,
        });
        self
    }

    pub fn crate_box(&mut self, center: Vec2, size: f32) -> &mut Self {
        self.prop("", PropKind::Block, center, Vec2::splat(size), size * size / 3600.0, "")
    }

    pub fn ball(&mut self, center: Vec2, radius: f32, color: &str) -> &mut Self {
        self.prop("", PropKind::Ball, center, Vec2::splat(radius * 2.0), (radius / 30.0).powi(2), color)
    }

    // ------------------------------------------------------------- movers

    pub fn mover(&mut self, shape: Shape, path: &[Vec2], period: f32, motion: MoverMotion) -> &mut Self {
        self.level.movers.push(Mover {
            id: String::new(),
            shape,
            path: path.to_vec(),
            motion,
            period,
            phase: 0.0,
            material: Material::Stone,
            trigger: String::new(),
        });
        self
    }

    /// An elevator platform that ping-pongs between `a` and `b` (centres).
    pub fn elevator(&mut self, a: Vec2, b: Vec2, width: f32, period: f32) -> &mut Self {
        self.mover(Shape::rect_at(a, v(width, 26.0), 0.0), &[Vec2::ZERO, b - a], period, MoverMotion::PingPong)
    }

    /// A stone piston that slams down from `top` by `drop` px.
    pub fn crusher(&mut self, top: Vec2, width: f32, drop: f32, phase: f32) -> &mut Self {
        let h = 120.0;
        self.level.movers.push(Mover {
            id: String::new(),
            shape: Shape::rect_at(top - v(0.0, h * 0.5), v(width, h), 0.0),
            path: vec![Vec2::ZERO, v(0.0, -drop)],
            motion: MoverMotion::Crusher { slam: 0.25, hold: 0.4, rise: 1.2, wait: 1.0 },
            period: 2.85,
            phase,
            material: Material::Stone,
            trigger: String::new(),
        });
        self
    }

    pub fn spinner(&mut self, center: Vec2, size: Vec2, speed: f32) -> &mut Self {
        self.mover(Shape::rect_at(center, size, 0.0), &[], 1.0, MoverMotion::Spin { speed })
    }

    // -------------------------------------------------------------- ropes

    /// A hanging vine from `top`, `length` long, free at the bottom.
    pub fn vine(&mut self, top: Vec2, length: f32) -> &mut Self {
        self.level.ropes.push(RopeDef {
            id: String::new(),
            from: RopeEnd::World { at: top },
            to: RopeEnd::Free { at: top - v(0.0, length) },
            length,
            grabbable: true,
            style: RopeStyle::Vine,
        });
        self
    }

    pub fn rope(&mut self, from: RopeEnd, to: RopeEnd, length: f32, style: RopeStyle) -> &mut Self {
        self.level.ropes.push(RopeDef { id: String::new(), from, to, length, grabbable: true, style });
        self
    }

    // ------------------------------------------------------------ hazards

    pub fn spring(&mut self, pos: Vec2, angle_deg: f32, power: f32) -> &mut Self {
        self.level.springs.push(SpringPad { pos, angle: angle_deg.to_radians(), width: 90.0, power });
        self
    }

    pub fn spikes(&mut self, a: Vec2, b: Vec2) -> &mut Self {
        self.level.spikes.push(Spikes { a, b });
        self
    }

    pub fn zone(&mut self, min: Vec2, max: Vec2, kind: ZoneKind) -> &mut Self {
        self.level.zones.push(Zone { id: String::new(), shape: Shape::rect(min, max), kind });
        self
    }

    pub fn water(&mut self, min: Vec2, max: Vec2) -> &mut Self {
        self.zone(min, max, ZoneKind::Water { buoyancy: 2600.0, drag: 1.6, current: Vec2::ZERO })
    }

    pub fn wind(&mut self, min: Vec2, max: Vec2, accel: Vec2) -> &mut Self {
        self.zone(min, max, ZoneKind::Wind { accel })
    }

    pub fn kill(&mut self, min: Vec2, max: Vec2) -> &mut Self {
        self.zone(min, max, ZoneKind::Kill)
    }

    // -------------------------------------------------------- progression

    pub fn checkpoint(&mut self, pos: Vec2) -> &mut Self {
        self.level.checkpoints.push(Checkpoint { pos });
        self
    }

    pub fn pickup(&mut self, p: Vec2) -> &mut Self {
        self.level.pickups.push(p);
        self
    }

    /// `n` pickups evenly along a line.
    pub fn pickups(&mut self, a: Vec2, b: Vec2, n: usize) -> &mut Self {
        for i in 0..n {
            let t = if n == 1 { 0.5 } else { i as f32 / (n - 1) as f32 };
            self.level.pickups.push(a.lerp(b, t));
        }
        self
    }

    /// `n` pickups along a jump arc from `a` to `b` peaking `h` above.
    pub fn pickup_arc(&mut self, a: Vec2, b: Vec2, h: f32, n: usize) -> &mut Self {
        for i in 0..n {
            let t = (i as f32 + 1.0) / (n as f32 + 1.0);
            let p = a.lerp(b, t) + v(0.0, 4.0 * h * t * (1.0 - t));
            self.level.pickups.push(p);
        }
        self
    }

    pub fn npc(&mut self, id: &str, pos: Vec2, role: NpcRole, color: &str, radius: f32) -> &mut Self {
        self.level.npcs.push(Npc { id: id.into(), pos, role, color: color.into(), radius });
        self
    }

    pub fn goal(&mut self, min: Vec2, max: Vec2) -> &mut Self {
        self.level.goal = Some(Shape::rect(min, max));
        self
    }

    pub fn story(&mut self, min: Vec2, max: Vec2, script: &str) -> &mut Self {
        self.level.story.push(StoryTrigger { shape: Shape::rect(min, max), script: script.into(), once: true });
        self
    }

    pub fn decor(&mut self, kind: &str, pos: Vec2, scale: f32, depth: f32) -> &mut Self {
        self.level.decor.push(Decor { kind: kind.into(), pos, scale, angle: 0.0, depth });
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ground_makes_core_and_tiles() {
        let mut b = LevelBuilder::new("t", "T", Theme::Hollow);
        b.ground(&[v(0.0, 0.0), v(600.0, 0.0), v(900.0, 100.0)], 200.0);
        let l = b.build();
        assert_eq!(l.terrain.len(), 1);
        // 600 px / 280 → 3 tiles, plus the slope (≈316 px → 2 tiles).
        assert_eq!(l.jelly.len(), 5);
        let json = l.to_json();
        let back = Level::from_json(&json).unwrap();
        assert_eq!(back.jelly.len(), 5);
    }
}
