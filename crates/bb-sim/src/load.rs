//! Turn level data into physics objects.

use std::collections::HashMap;

use bb_level::{self as lvl, Level, Pins, PropKind, RopeEnd};
use bb_physics::{self as phys, Anchor, BodyDesc, BodyId, RopeDesc, RopeId, StaticDesc, StaticId, Vec2, World};

use crate::{BodyTag, MoverState, RopeState, Sim};

pub fn material(m: lvl::Material) -> phys::Material {
    match m {
        lvl::Material::Ground => phys::Material { static_friction: 0.9, dynamic_friction: 0.7, restitution: 0.0 },
        lvl::Material::Stone => phys::Material { static_friction: 0.8, dynamic_friction: 0.6, restitution: 0.0 },
        lvl::Material::Ice => phys::Material { static_friction: 0.02, dynamic_friction: 0.01, restitution: 0.0 },
        lvl::Material::Sticky => phys::Material { static_friction: 3.0, dynamic_friction: 2.5, restitution: 0.0 },
        lvl::Material::Bouncy => phys::Material { static_friction: 0.8, dynamic_friction: 0.6, restitution: 0.85 },
    }
}

/// Collision layers.
pub mod layer {
    pub const WORLD: u32 = 1;
    pub const PLAYER: u32 = 2;
    pub const PROP: u32 = 4;
    pub const ROPE: u32 = 8;
    pub const NPC: u32 = 16;
    pub const UI: u32 = 32;
    /// Jelly ground tiles and soft platforms: never collide with each
    /// other (adjacent tiles would push apart and open seams).
    pub const JELLY: u32 = 64;
}

pub(crate) fn load(sim: &mut Sim, level: &Level) {
    let w = &mut sim.world;
    if let Some(g) = level.gravity {
        w.config.gravity = g;
    }

    for t in &level.terrain {
        let mut d = StaticDesc::polygon(t.shape.outline());
        d.material = material(t.material);
        d.one_way = t.one_way.then_some(Vec2::Y);
        let id = w.add_static(d);
        sim.terrain.push((id, t.material, t.one_way));
    }

    for j in &level.jelly {
        let mut d = BodyDesc::mesh_from_outline(&j.shape.outline(), 22.0, 0.0);
        let area = bb_physics::geom::signed_area_slice(&d.positions).abs();
        let n = d.positions.len() as f32;
        d.masses = vec![(area / 2500.0).max(0.5) / n; d.positions.len()];
        d.params.material = material(j.material);
        d.params.shape_compliance = None;
        d.params.edge_compliance = 2e-6 * (0.2 + j.wobble);
        d.params.tri_compliance = 2e-6 * (0.2 + j.wobble);
        d.params.internal_damping = 6.0;
        d.params.gravity_scale = 0.0;
        d.params.radius = 1.5;
        d.layer = layer::WORLD | layer::JELLY;
        d.mask = !layer::JELLY;
        let id = w.add_body(d);
        // Wobble 0 → firm (1e-6), wobble 1 → very jiggly (4e-5).
        w.body_mut(id).unwrap().anchor_home(1e-6 + 4e-5 * j.wobble * j.wobble);
        sim.tags.insert(id, BodyTag::Jelly);
        sim.jelly.push((id, j.material));
    }

    let mut named: HashMap<String, BodyId> = HashMap::new();

    for p in &level.platforms {
        let cols = (p.size.x / 20.0).ceil().max(2.0) as usize;
        let rows = (p.size.y / 20.0).ceil().max(1.0) as usize;
        let h = p.size * 0.5;
        let mut d = BodyDesc::grid(-h, h, cols, rows, p.size.x * p.size.y / 3000.0);
        let rot = Vec2::from_angle(p.angle);
        for q in d.positions.iter_mut() {
            *q = p.center + rot.rotate(*q);
        }
        let stiff = p.stiffness.clamp(0.0, 1.0);
        d.params.material = material(p.material);
        d.params.edge_compliance = 1e-5 * (1.0 - stiff) + 1e-8;
        d.params.tri_compliance = 1e-5 * (1.0 - stiff) + 1e-8;
        d.params.shape_compliance = Some(5e-6 * (1.0 - stiff) + 2e-8);
        d.params.internal_damping = 4.0;
        d.params.radius = 1.5;
        d.layer = layer::WORLD | layer::JELLY;
        d.mask = !layer::JELLY;
        let pins = p.pins;
        let id = w.add_body(d);
        {
            let b = w.body_mut(id).unwrap();
            let n = b.len();
            // Local coordinates for pin selection.
            let locals: Vec<Vec2> = b.x.iter().map(|q| Vec2::new(rot.x, -rot.y).rotate(*q - p.center)).collect();
            let eps = 0.5;
            for i in 0..n {
                let l = locals[i];
                let left = l.x < -h.x + eps;
                let right = l.x > h.x - eps;
                let top = l.y > h.y - eps;
                let bottom = l.y < -h.y + eps;
                let pin = match pins {
                    Pins::Ends => left || right,
                    Pins::Left => left,
                    Pins::Right => right,
                    Pins::Corners => (left || right) && (top || bottom),
                    Pins::Top => top,
                    Pins::Home | Pins::None => false,
                };
                if pin {
                    b.pin(i);
                }
            }
            if pins == Pins::Home {
                b.anchor_home(2e-5 * (1.0 - stiff) + 1e-6);
                b.params.shape_compliance = Some(1e-7);
            }
        }
        sim.tags.insert(id, BodyTag::Platform);
        if !p.id.is_empty() {
            named.insert(p.id.clone(), id);
        }
        sim.platforms.push(id);
    }

    for p in &level.props {
        let rot = Vec2::from_angle(p.angle);
        let outline: Vec<Vec2> = match &p.kind {
            PropKind::Block => lvl::Shape::rect_at(Vec2::ZERO, p.size, 0.0).outline(),
            PropKind::Ball => lvl::Shape::Circle { center: Vec2::ZERO, radius: p.size.x * 0.5 }.outline_n(20),
            PropKind::Star => star(5, p.size.x * 0.5, p.size.x * 0.24),
            PropKind::Custom { outline } => outline.clone(),
        };
        let pts: Vec<Vec2> = outline.iter().map(|q| p.center + rot.rotate(*q)).collect();
        let mut d = match p.kind {
            PropKind::Ball => BodyDesc::blob_from_outline(&bb_physics::body::resample_loop(&pts, 14.0), p.mass),
            _ => BodyDesc::mesh_from_outline(&pts, 16.0, p.mass),
        };
        d.params.material = material(p.material);
        d.params.limits.poppable = false;
        d.params.shape_compliance = Some(4e-4);
        d.layer = layer::PROP;
        let id = w.add_body(d);
        if p.pinned {
            let b = w.body_mut(id).unwrap();
            b.anchor_home(1e-6);
        }
        sim.tags.insert(id, BodyTag::Prop);
        if !p.id.is_empty() {
            named.insert(p.id.clone(), id);
        }
        sim.props.push(id);
    }

    for m in &level.movers {
        let poly = m.shape.outline();
        let mut d = StaticDesc::polygon(poly.clone());
        d.material = material(m.material);
        let id = w.add_static(d);
        sim.movers.push(MoverState {
            def: m.clone(),
            id,
            base: phys_ccw(poly),
            active: m.trigger.is_empty(),
            progress: 0.0,
            latched: false,
            pressed: false,
        });
    }

    for r in &level.ropes {
        let a = rope_anchor(w, &named, &r.from);
        let b = rope_anchor(w, &named, &r.to);
        let (Some(a), Some(b)) = (a, b) else { continue };
        let mut desc = RopeDesc::new(a, b);
        if r.length > 0.0 {
            desc.length = Some(r.length);
        }
        desc.spacing = 12.0;
        desc.mass = 0.25 * (r.length.max(100.0) / 300.0);
        desc.radius = 5.0;
        let id = w.add_rope(desc);
        let free = matches!(r.to, RopeEnd::Free { .. });
        if free {
            if let Some(rope) = w.rope_mut(id) {
                rope.end = None;
                rope.remove_when_free = false;
            }
        }
        let body = w.rope(id).unwrap().body;
        if let Some(b) = w.body_mut(body) {
            b.layer = layer::ROPE;
            // Ropes only collide with the world and props, not players
            // (players grab them instead).
            b.mask = layer::WORLD | layer::PROP | layer::JELLY;
        }
        sim.tags.insert(body, BodyTag::Rope);
        sim.ropes.push(RopeState { id: r.id.clone(), rope: id, grabbable: r.grabbable, style: r.style });
    }

    for s in &level.springs {
        let dir = Vec2::from_angle(s.angle);
        let side = dir.perp();
        let base = s.pos;
        let poly = vec![
            base - side * s.width * 0.5,
            base + side * s.width * 0.5,
            base + side * s.width * 0.5 + dir * 18.0,
            base - side * s.width * 0.5 + dir * 18.0,
        ];
        let id = w.add_static(StaticDesc::polygon(poly));
        sim.springs.push(crate::SpringState { def: s.clone(), id, cooldown: 0.0, squash: 0.0 });
    }
    let _ = (RopeId(0), StaticId(0));
}

fn phys_ccw(mut poly: Vec<Vec2>) -> Vec<Vec2> {
    if bb_physics::geom::signed_area_slice(&poly) < 0.0 {
        poly.reverse();
    }
    poly
}

fn rope_anchor(w: &World, named: &HashMap<String, BodyId>, end: &RopeEnd) -> Option<Anchor> {
    match end {
        RopeEnd::World { at } | RopeEnd::Free { at } => Some(Anchor::World(*at)),
        RopeEnd::Body { id } => named.get(id).and_then(|b| Anchor::centre(w, *b)),
    }
}

pub fn star(points: usize, outer: f32, inner: f32) -> Vec<Vec2> {
    (0..points * 2)
        .map(|i| {
            let a = std::f32::consts::FRAC_PI_2 + i as f32 / (points * 2) as f32 * std::f32::consts::TAU;
            let r = if i % 2 == 0 { outer } else { inner };
            Vec2::new(a.cos(), a.sin()) * r
        })
        .collect()
}
