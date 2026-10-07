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

    // ---------------------------------------------------------- contraptions

    /// A see-saw: a terrain wedge with a plank prop balanced on its tip,
    /// held at its centre by a short hidden rope (the pivot). `pivot` is the
    /// tip of the wedge (the plank's centre rests just above it).
    pub fn seesaw(&mut self, id: &str, pivot: Vec2, length: f32, mass: f32) -> &mut Self {
        let base = pivot.y - 70.0;
        self.poly(&[v(pivot.x - 46.0, base - 40.0), v(pivot.x + 46.0, base - 40.0), v(pivot.x + 10.0, pivot.y), v(pivot.x - 10.0, pivot.y)]);
        let centre = pivot + v(0.0, 16.0);
        self.prop(id, PropKind::Block, centre, v(length, 26.0), mass, "#ffd166");
        self.level.ropes.push(RopeDef {
            id: format!("{id}_pivot"),
            from: RopeEnd::World { at: centre },
            to: RopeEnd::Body { id: id.into() },
            length: 1.0,
            grabbable: false,
            style: RopeStyle::Rope,
        });
        self
    }

    /// A stone conveyor belt strip from `a` (left end of its top surface),
    /// `length` long, pushing things along x at `speed` px/s.
    pub fn conveyor(&mut self, a: Vec2, length: f32, speed: f32) -> &mut Self {
        self.stone(a - v(0.0, 40.0), a + v(length, 0.0));
        self.zone(a, a + v(length, 70.0), ZoneKind::Conveyor { speed })
    }

    /// A solid ramp (wedge) rising from `a` to `b` (bottom-left to top-right
    /// or top-left to bottom-right), filled down to the lower end's height.
    pub fn ramp(&mut self, a: Vec2, b: Vec2) -> &mut Self {
        let low = a.y.min(b.y);
        if a.y < b.y {
            self.poly(&[a, v(b.x, low), b])
        } else {
            self.poly(&[v(a.x, low), b, a])
        }
    }

    /// A trampoline mushroom: a jelly mushroom with a spring pad on its cap
    /// that launches you `power` px/s straight up.
    pub fn trampoline(&mut self, base: Vec2, height: f32, cap_w: f32, power: f32) -> &mut Self {
        self.mushroom(base, height, cap_w);
        let top = base + v(0.0, height + cap_w * 0.28 - 4.0);
        self.level.springs.push(SpringPad { pos: top, angle: std::f32::consts::FRAC_PI_2, width: (cap_w * 0.45).max(50.0), power });
        self
    }

    /// A falling jelly drip: a blob of goo that waits on the ceiling at
    /// `top`, drops `fall` px fast, then slowly slurps back up.
    pub fn drip_hazard(&mut self, top: Vec2, fall: f32, radius: f32, phase: f32) -> &mut Self {
        self.level.movers.push(Mover {
            id: String::new(),
            shape: Shape::Circle { center: top - v(0.0, radius), radius },
            path: vec![Vec2::ZERO, v(0.0, -fall)],
            motion: MoverMotion::Crusher { slam: 0.45, hold: 0.3, rise: 1.6, wait: 1.2 },
            period: 3.55,
            phase,
            material: Material::Ice, // renders as a pale jelly drop
            trigger: String::new(),
        });
        self
    }

    /// A floating jelly lily pad bobbing on water at `surface`.
    pub fn lily(&mut self, surface: Vec2, width: f32) -> &mut Self {
        self.level.platforms.push(SoftPlatform {
            id: String::new(),
            center: surface + v(0.0, 4.0),
            size: v(width, 24.0),
            angle: 0.0,
            pins: Pins::Home,
            stiffness: 0.35,
            material: Material::Ground,
        });
        self
    }

    /// A water body with a current.
    pub fn current(&mut self, min: Vec2, max: Vec2, current: Vec2) -> &mut Self {
        self.zone(min, max, ZoneKind::Water { buoyancy: 2600.0, drag: 1.6, current })
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

    pub fn npc_at(&mut self, pos: Vec2, role: NpcRole) -> &mut Self {
        self.npc("", pos, role, "", 30.0)
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

    #[test]
    fn contraption_helpers_emit_parts() {
        let mut b = LevelBuilder::new("t", "T", Theme::Toys);
        b.seesaw("saw", v(0.0, 100.0), 400.0, 2.0)
            .conveyor(v(1000.0, 0.0), 400.0, 250.0)
            .ramp(v(1500.0, 0.0), v(1800.0, 150.0))
            .ramp(v(1900.0, 150.0), v(2200.0, 0.0))
            .trampoline(v(2400.0, 0.0), 100.0, 160.0, 1150.0)
            .drip_hazard(v(2600.0, 600.0), 400.0, 30.0, 0.0)
            .lily(v(2900.0, 0.0), 160.0)
            .current(v(2700.0, -200.0), v(3100.0, 0.0), v(200.0, 0.0));
        let l = b.build();
        assert_eq!(l.props.len(), 1);
        assert_eq!(l.ropes.len(), 1);
        assert!(!l.ropes.iter().any(|r| r.grabbable), "contraption ropes are not vines");
        assert_eq!(l.springs.len(), 1);
        assert_eq!(l.movers.len(), 1);
        assert_eq!(l.platforms.len(), 1);
        assert_eq!(l.zones.len(), 2);
        // Ramps are counter-clockwise-agnostic but non-degenerate.
        for t in &l.terrain {
            let o = t.shape.outline();
            let area: f32 = (0..o.len()).map(|i| o[i].perp_dot(o[(i + 1) % o.len()])).sum();
            assert!(area.abs() > 1.0);
        }
        let back = Level::from_json(&l.to_json()).unwrap();
        assert_eq!(back.ropes[0].length, l.ropes[0].length);
    }
}
