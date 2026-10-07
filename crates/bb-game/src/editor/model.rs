//! Engine-free level editing: element references, hit testing, outlines,
//! move / resize / rotate frames, vertex editing, add / delete / duplicate.
//! Everything here works on `bb_level::Level` directly so it can be unit
//! tested headless.

use bb_level::*;
use glam::Vec2;

/// A reference to one element of a level.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum Elem {
    Spawn,
    Goal,
    Terrain(usize),
    Jelly(usize),
    Platform(usize),
    Prop(usize),
    Mover(usize),
    Rope(usize),
    Zone(usize),
    Spring(usize),
    Spikes(usize),
    Checkpoint(usize),
    Pickup(usize),
    Npc(usize),
    Hill(usize),
    Story(usize),
    Decor(usize),
}

impl Elem {
    pub fn label(&self) -> &'static str {
        match self {
            Elem::Spawn => "Spawn",
            Elem::Goal => "Goal",
            Elem::Terrain(_) => "Terrain",
            Elem::Jelly(_) => "Jelly",
            Elem::Platform(_) => "Soft platform",
            Elem::Prop(_) => "Prop",
            Elem::Mover(_) => "Mover",
            Elem::Rope(_) => "Rope",
            Elem::Zone(_) => "Zone",
            Elem::Spring(_) => "Spring",
            Elem::Spikes(_) => "Spikes",
            Elem::Checkpoint(_) => "Checkpoint",
            Elem::Pickup(_) => "Pickup",
            Elem::Npc(_) => "NPC",
            Elem::Hill(_) => "Hill",
            Elem::Story(_) => "Story trigger",
            Elem::Decor(_) => "Decor",
        }
    }

    pub fn index(&self) -> Option<usize> {
        match *self {
            Elem::Spawn | Elem::Goal => None,
            Elem::Terrain(i)
            | Elem::Jelly(i)
            | Elem::Platform(i)
            | Elem::Prop(i)
            | Elem::Mover(i)
            | Elem::Rope(i)
            | Elem::Zone(i)
            | Elem::Spring(i)
            | Elem::Spikes(i)
            | Elem::Checkpoint(i)
            | Elem::Pickup(i)
            | Elem::Npc(i)
            | Elem::Hill(i)
            | Elem::Story(i)
            | Elem::Decor(i) => Some(i),
        }
    }

    /// Same kind, different index.
    pub fn with_index(&self, i: usize) -> Elem {
        match self {
            Elem::Spawn => Elem::Spawn,
            Elem::Goal => Elem::Goal,
            Elem::Terrain(_) => Elem::Terrain(i),
            Elem::Jelly(_) => Elem::Jelly(i),
            Elem::Platform(_) => Elem::Platform(i),
            Elem::Prop(_) => Elem::Prop(i),
            Elem::Mover(_) => Elem::Mover(i),
            Elem::Rope(_) => Elem::Rope(i),
            Elem::Zone(_) => Elem::Zone(i),
            Elem::Spring(_) => Elem::Spring(i),
            Elem::Spikes(_) => Elem::Spikes(i),
            Elem::Checkpoint(_) => Elem::Checkpoint(i),
            Elem::Pickup(_) => Elem::Pickup(i),
            Elem::Npc(_) => Elem::Npc(i),
            Elem::Hill(_) => Elem::Hill(i),
            Elem::Story(_) => Elem::Story(i),
            Elem::Decor(_) => Elem::Decor(i),
        }
    }
}

/// Every element in hit-test priority order (small things first, big
/// background regions last).
pub fn all(level: &Level) -> Vec<Elem> {
    let mut v = vec![Elem::Spawn];
    v.extend((0..level.pickups.len()).map(Elem::Pickup));
    v.extend((0..level.checkpoints.len()).map(Elem::Checkpoint));
    v.extend((0..level.npcs.len()).map(Elem::Npc));
    v.extend((0..level.springs.len()).map(Elem::Spring));
    v.extend((0..level.decor.len()).map(Elem::Decor));
    v.extend((0..level.props.len()).map(Elem::Prop));
    v.extend((0..level.ropes.len()).map(Elem::Rope));
    v.extend((0..level.spikes.len()).map(Elem::Spikes));
    v.extend((0..level.movers.len()).map(Elem::Mover));
    v.extend((0..level.platforms.len()).map(Elem::Platform));
    v.extend((0..level.jelly.len()).map(Elem::Jelly));
    v.extend((0..level.story.len()).map(Elem::Story));
    if level.goal.is_some() {
        v.push(Elem::Goal);
    }
    v.extend((0..level.hills.len()).map(Elem::Hill));
    v.extend((0..level.zones.len()).map(Elem::Zone));
    v.extend((0..level.terrain.len()).map(Elem::Terrain));
    v
}

pub fn exists(level: &Level, e: Elem) -> bool {
    match e {
        Elem::Spawn => true,
        Elem::Goal => level.goal.is_some(),
        Elem::Terrain(i) => i < level.terrain.len(),
        Elem::Jelly(i) => i < level.jelly.len(),
        Elem::Platform(i) => i < level.platforms.len(),
        Elem::Prop(i) => i < level.props.len(),
        Elem::Mover(i) => i < level.movers.len(),
        Elem::Rope(i) => i < level.ropes.len(),
        Elem::Zone(i) => i < level.zones.len(),
        Elem::Spring(i) => i < level.springs.len(),
        Elem::Spikes(i) => i < level.spikes.len(),
        Elem::Checkpoint(i) => i < level.checkpoints.len(),
        Elem::Pickup(i) => i < level.pickups.len(),
        Elem::Npc(i) => i < level.npcs.len(),
        Elem::Hill(i) => i < level.hills.len(),
        Elem::Story(i) => i < level.story.len(),
        Elem::Decor(i) => i < level.decor.len(),
    }
}

/// The element's `Shape`, for elements that have one.
pub fn shape(level: &Level, e: Elem) -> Option<&Shape> {
    match e {
        Elem::Terrain(i) => level.terrain.get(i).map(|t| &t.shape),
        Elem::Jelly(i) => level.jelly.get(i).map(|t| &t.shape),
        Elem::Mover(i) => level.movers.get(i).map(|t| &t.shape),
        Elem::Zone(i) => level.zones.get(i).map(|t| &t.shape),
        Elem::Story(i) => level.story.get(i).map(|t| &t.shape),
        Elem::Hill(i) => level.hills.get(i),
        Elem::Goal => level.goal.as_ref(),
        _ => None,
    }
}

pub fn shape_mut(level: &mut Level, e: Elem) -> Option<&mut Shape> {
    match e {
        Elem::Terrain(i) => level.terrain.get_mut(i).map(|t| &mut t.shape),
        Elem::Jelly(i) => level.jelly.get_mut(i).map(|t| &mut t.shape),
        Elem::Mover(i) => level.movers.get_mut(i).map(|t| &mut t.shape),
        Elem::Zone(i) => level.zones.get_mut(i).map(|t| &mut t.shape),
        Elem::Story(i) => level.story.get_mut(i).map(|t| &mut t.shape),
        Elem::Hill(i) => level.hills.get_mut(i),
        Elem::Goal => level.goal.as_mut(),
        _ => None,
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

fn circle(c: Vec2, r: f32, n: usize) -> Vec<Vec2> {
    Shape::Circle { center: c, radius: r }.outline_n(n)
}

/// World position of a rope end, if it is resolvable.
pub fn rope_end_pos(level: &Level, end: &RopeEnd) -> Option<Vec2> {
    match end {
        RopeEnd::World { at } | RopeEnd::Free { at } => Some(*at),
        RopeEnd::Body { id } => level
            .props
            .iter()
            .find(|p| &p.id == id)
            .map(|p| p.center)
            .or_else(|| level.platforms.iter().find(|p| &p.id == id).map(|p| p.center)),
    }
}

/// Outline for drawing and hit testing. `closed` = false for ropes.
pub fn outline(level: &Level, e: Elem) -> (Vec<Vec2>, bool) {
    if let Some(s) = shape(level, e) {
        return (s.outline(), true);
    }
    match e {
        Elem::Spawn => (circle(level.spawn, 32.0, 16), true),
        Elem::Platform(i) => {
            let p = &level.platforms[i];
            (Shape::rect_at(p.center, p.size, p.angle).outline(), true)
        }
        Elem::Prop(i) => {
            let p = &level.props[i];
            let rot = Vec2::from_angle(p.angle);
            let local = match &p.kind {
                PropKind::Block => Shape::rect_at(Vec2::ZERO, p.size, 0.0).outline(),
                PropKind::Ball => circle(Vec2::ZERO, p.size.x * 0.5, 20),
                PropKind::Star => star(5, p.size.x * 0.5, p.size.x * 0.24),
                PropKind::Custom { outline } => outline.clone(),
            };
            (local.iter().map(|q| p.center + rot.rotate(*q)).collect(), true)
        }
        Elem::Rope(i) => {
            let r = &level.ropes[i];
            let a = rope_end_pos(level, &r.from).unwrap_or(Vec2::ZERO);
            let b = rope_end_pos(level, &r.to).unwrap_or(a);
            (vec![a, b], false)
        }
        Elem::Spring(i) => {
            let s = &level.springs[i];
            let dir = Vec2::from_angle(s.angle);
            let side = dir.perp() * s.width * 0.5;
            (vec![s.pos - side, s.pos + side, s.pos + side + dir * 30.0, s.pos - side + dir * 30.0], true)
        }
        Elem::Spikes(i) => {
            let s = &level.spikes[i];
            let n = (s.b - s.a).perp().normalize_or(Vec2::Y);
            (vec![s.a, s.b, s.b + n * 26.0, s.a + n * 26.0], true)
        }
        Elem::Checkpoint(i) => {
            let p = level.checkpoints[i].pos;
            (Shape::rect(p + Vec2::new(-46.0, -30.0), p + Vec2::new(46.0, 60.0)).outline(), true)
        }
        Elem::Pickup(i) => (circle(level.pickups[i], 14.0, 10), true),
        Elem::Npc(i) => (circle(level.npcs[i].pos, level.npcs[i].radius, 16), true),
        Elem::Decor(i) => {
            let d = &level.decor[i];
            (circle(d.pos, 30.0 * d.scale.max(0.2), 12), true)
        }
        _ => (Vec::new(), true),
    }
}

pub fn point_in_poly(p: Vec2, poly: &[Vec2]) -> bool {
    let mut inside = false;
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn seg_dist(p: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let t = if ab.length_squared() > 0.0 { ((p - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) } else { 0.0 };
    p.distance(a + ab * t)
}

pub fn hit(level: &Level, e: Elem, p: Vec2, tol: f32) -> bool {
    let (o, closed) = outline(level, e);
    if o.is_empty() {
        return false;
    }
    if closed && point_in_poly(p, &o) {
        return true;
    }
    let n = o.len();
    let segs = if closed { n } else { n - 1 };
    (0..segs).any(|k| seg_dist(p, o[k], o[(k + 1) % n]) < tol)
}

/// Every element under `p`, in priority order.
pub fn hits_at(level: &Level, p: Vec2, tol: f32) -> Vec<Elem> {
    all(level).into_iter().filter(|e| hit(level, *e, p, tol)).collect()
}

pub fn bounds(level: &Level, e: Elem) -> (Vec2, Vec2) {
    let (o, _) = outline(level, e);
    let mut min = Vec2::splat(f32::MAX);
    let mut max = Vec2::splat(f32::MIN);
    for p in o {
        min = min.min(p);
        max = max.max(p);
    }
    (min, max)
}

pub fn center(level: &Level, e: Elem) -> Vec2 {
    let (a, b) = bounds(level, e);
    (a + b) * 0.5
}

pub fn translate(level: &mut Level, e: Elem, d: Vec2) {
    if let Some(s) = shape_mut(level, e) {
        *s = s.translated(d);
        return;
    }
    match e {
        Elem::Spawn => level.spawn += d,
        Elem::Platform(i) => level.platforms[i].center += d,
        Elem::Prop(i) => level.props[i].center += d,
        Elem::Rope(i) => {
            let r = &mut level.ropes[i];
            for end in [&mut r.from, &mut r.to] {
                if let RopeEnd::World { at } | RopeEnd::Free { at } = end {
                    *at += d;
                }
            }
        }
        Elem::Spring(i) => level.springs[i].pos += d,
        Elem::Spikes(i) => {
            level.spikes[i].a += d;
            level.spikes[i].b += d;
        }
        Elem::Checkpoint(i) => level.checkpoints[i].pos += d,
        Elem::Pickup(i) => level.pickups[i] += d,
        Elem::Npc(i) => level.npcs[i].pos += d,
        Elem::Decor(i) => level.decor[i].pos += d,
        _ => {}
    }
}

/// An oriented box used for resize / rotate handles.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub center: Vec2,
    pub size: Vec2,
    pub angle: f32,
}

impl Frame {
    pub fn to_world(&self, local: Vec2) -> Vec2 {
        self.center + Vec2::from_angle(self.angle).rotate(local)
    }
    pub fn to_local(&self, world: Vec2) -> Vec2 {
        Vec2::from_angle(-self.angle).rotate(world - self.center)
    }
    pub fn corners(&self) -> [Vec2; 4] {
        let h = self.size * 0.5;
        [
            self.to_world(Vec2::new(-h.x, -h.y)),
            self.to_world(Vec2::new(h.x, -h.y)),
            self.to_world(Vec2::new(h.x, h.y)),
            self.to_world(Vec2::new(-h.x, h.y)),
        ]
    }
}

fn aabb_frame(pts: &[Vec2]) -> Frame {
    let mut min = Vec2::splat(f32::MAX);
    let mut max = Vec2::splat(f32::MIN);
    for p in pts {
        min = min.min(*p);
        max = max.max(*p);
    }
    Frame { center: (min + max) * 0.5, size: (max - min).max(Vec2::splat(1.0)), angle: 0.0 }
}

/// Resizable / rotatable frame of an element.
pub fn frame(level: &Level, e: Elem) -> Option<Frame> {
    if let Some(s) = shape(level, e) {
        return Some(match s {
            Shape::Rect { center, size, angle } => Frame { center: *center, size: *size, angle: *angle },
            Shape::Circle { center, radius } => Frame { center: *center, size: Vec2::splat(radius * 2.0), angle: 0.0 },
            Shape::Poly { points } => aabb_frame(points),
        });
    }
    match e {
        Elem::Platform(i) => {
            let p = &level.platforms[i];
            Some(Frame { center: p.center, size: p.size, angle: p.angle })
        }
        Elem::Prop(i) => {
            let p = &level.props[i];
            let size = match &p.kind {
                PropKind::Custom { outline } => aabb_frame(outline).size,
                _ => p.size,
            };
            Some(Frame { center: p.center, size, angle: p.angle })
        }
        Elem::Spikes(i) => {
            let s = &level.spikes[i];
            let d = s.b - s.a;
            Some(Frame { center: (s.a + s.b) * 0.5, size: Vec2::new(d.length().max(1.0), 26.0), angle: d.y.atan2(d.x) })
        }
        Elem::Spring(i) => {
            let s = &level.springs[i];
            Some(Frame { center: s.pos, size: Vec2::new(s.width, 30.0), angle: s.angle - std::f32::consts::FRAC_PI_2 })
        }
        Elem::Npc(i) => Some(Frame { center: level.npcs[i].pos, size: Vec2::splat(level.npcs[i].radius * 2.0), angle: 0.0 }),
        Elem::Decor(i) => {
            let d = &level.decor[i];
            Some(Frame { center: d.pos, size: Vec2::splat(60.0 * d.scale), angle: d.angle })
        }
        _ => None,
    }
}

/// Can this element be resized with handles? (Points, ropes can't.)
pub fn resizable(e: Elem) -> bool {
    !matches!(e, Elem::Spawn | Elem::Checkpoint(_) | Elem::Pickup(_) | Elem::Rope(_))
}

pub fn rotatable(level: &Level, e: Elem) -> bool {
    match e {
        Elem::Npc(_) => false,
        _ => frame(level, e).is_some() && !matches!(shape(level, e), Some(Shape::Circle { .. })),
    }
}

/// Re-map an element from frame `old` to frame `new` (move, resize, and
/// rotate in one).
pub fn set_frame(level: &mut Level, e: Elem, old: Frame, new: Frame) {
    let map = |p: Vec2| -> Vec2 {
        let l = old.to_local(p);
        let s = new.size / old.size.max(Vec2::splat(1e-3));
        new.to_world(l * s)
    };
    if let Some(s) = shape_mut(level, e) {
        match s {
            Shape::Rect { center, size, angle } => {
                *center = new.center;
                *size = new.size.abs();
                *angle = new.angle;
            }
            Shape::Circle { center, radius } => {
                *center = new.center;
                let grow = (new.size - old.size).abs();
                *radius = if grow.x >= grow.y { new.size.x.abs() * 0.5 } else { new.size.y.abs() * 0.5 };
            }
            Shape::Poly { points } => {
                for p in points.iter_mut() {
                    *p = map(*p);
                }
            }
        }
        return;
    }
    match e {
        Elem::Platform(i) => {
            let p = &mut level.platforms[i];
            p.center = new.center;
            p.size = new.size.abs();
            p.angle = new.angle;
        }
        Elem::Prop(i) => {
            let p = &mut level.props[i];
            p.center = new.center;
            p.angle = new.angle;
            match &mut p.kind {
                PropKind::Custom { outline } => {
                    let s = new.size / old.size.max(Vec2::splat(1e-3));
                    for q in outline.iter_mut() {
                        *q *= s;
                    }
                    p.size = aabb_frame(outline).size;
                }
                PropKind::Ball | PropKind::Star => {
                    let grow = (new.size - old.size).abs();
                    let d = if grow.x >= grow.y { new.size.x } else { new.size.y };
                    p.size = Vec2::splat(d.abs());
                }
                PropKind::Block => p.size = new.size.abs(),
            }
        }
        Elem::Spikes(i) => {
            let dir = Vec2::from_angle(new.angle) * new.size.x.abs() * 0.5;
            level.spikes[i].a = new.center - dir;
            level.spikes[i].b = new.center + dir;
        }
        Elem::Spring(i) => {
            let s = &mut level.springs[i];
            s.pos = new.center;
            s.width = new.size.x.abs().max(20.0);
            s.angle = new.angle + std::f32::consts::FRAC_PI_2;
        }
        Elem::Npc(i) => {
            level.npcs[i].pos = new.center;
            level.npcs[i].radius = (new.size.x.abs().max(new.size.y.abs()) * 0.5).clamp(10.0, 200.0);
        }
        Elem::Decor(i) => {
            let d = &mut level.decor[i];
            d.pos = new.center;
            d.scale = (new.size.x.abs().max(new.size.y.abs()) / 60.0).max(0.05);
            d.angle = new.angle;
        }
        _ => {}
    }
}

pub fn rotate(level: &mut Level, e: Elem, by: f32) {
    if let Some(f) = frame(level, e) {
        let mut n = f;
        n.angle = f.angle + by;
        set_frame(level, e, f, n);
    }
}

/// Editable points of an element.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PtKind {
    /// Polygon vertex (can be inserted / deleted).
    Vertex,
    /// Spike / rope end.
    End,
    /// Mover path waypoint (stored relative to the shape's centre).
    Path,
}

pub fn points(level: &Level, e: Elem) -> Vec<(Vec2, PtKind)> {
    let mut v = Vec::new();
    if let Some(Shape::Poly { points }) = shape(level, e) {
        v.extend(points.iter().map(|p| (*p, PtKind::Vertex)));
    }
    match e {
        Elem::Spikes(i) => {
            v.push((level.spikes[i].a, PtKind::End));
            v.push((level.spikes[i].b, PtKind::End));
        }
        Elem::Rope(i) => {
            let r = &level.ropes[i];
            for end in [&r.from, &r.to] {
                if let Some(p) = rope_end_pos(level, end) {
                    v.push((p, PtKind::End));
                }
            }
        }
        Elem::Mover(i) => {
            let m = &level.movers[i];
            let c = m.shape.center();
            v.extend(m.path.iter().skip(1).map(|o| (c + *o, PtKind::Path)));
        }
        _ => {}
    }
    v
}

/// Move editable point `idx` (an index into `points()`) to `p`.
pub fn set_point(level: &mut Level, e: Elem, idx: usize, p: Vec2) {
    let nverts = match shape(level, e) {
        Some(Shape::Poly { points }) => points.len(),
        _ => 0,
    };
    if idx < nverts {
        if let Some(Shape::Poly { points }) = shape_mut(level, e) {
            points[idx] = p;
        }
        return;
    }
    let k = idx - nverts;
    match e {
        Elem::Spikes(i) => {
            if k == 0 {
                level.spikes[i].a = p
            } else {
                level.spikes[i].b = p
            }
        }
        Elem::Rope(i) => {
            // Only world / free ends move; body ends follow their body.
            let movable: Vec<bool> =
                [&level.ropes[i].from, &level.ropes[i].to].iter().map(|e| !matches!(e, RopeEnd::Body { .. })).collect();
            let resolvable: Vec<usize> = [&level.ropes[i].from, &level.ropes[i].to]
                .iter()
                .enumerate()
                .filter(|(_, e)| rope_end_pos(level, e).is_some())
                .map(|(j, _)| j)
                .collect();
            let Some(&which) = resolvable.get(k) else { return };
            if !movable[which] {
                return;
            }
            let r = &mut level.ropes[i];
            let end = if which == 0 { &mut r.from } else { &mut r.to };
            if let RopeEnd::World { at } | RopeEnd::Free { at } = end {
                *at = p;
            }
        }
        Elem::Mover(i) => {
            let c = level.movers[i].shape.center();
            if let Some(o) = level.movers[i].path.get_mut(k + 1) {
                *o = p - c;
            }
        }
        _ => {}
    }
}

/// Insert a vertex after `idx` (polygon shapes only).
pub fn insert_vertex(level: &mut Level, e: Elem, idx: usize, p: Vec2) -> bool {
    if let Some(Shape::Poly { points }) = shape_mut(level, e) {
        let at = (idx + 1).min(points.len());
        points.insert(at, p);
        return true;
    }
    false
}

pub fn delete_vertex(level: &mut Level, e: Elem, idx: usize) -> bool {
    if let Some(Shape::Poly { points }) = shape_mut(level, e) {
        if points.len() > 3 && idx < points.len() {
            points.remove(idx);
            return true;
        }
    }
    if let Elem::Mover(i) = e {
        let nverts = match &level.movers[i].shape {
            Shape::Poly { points } => points.len(),
            _ => 0,
        };
        if idx >= nverts {
            let k = idx - nverts + 1;
            if k < level.movers[i].path.len() {
                level.movers[i].path.remove(k);
                return true;
            }
        }
    }
    false
}

/// Convert a rect / circle shape into an editable polygon.
pub fn to_poly(level: &mut Level, e: Elem) -> bool {
    if let Some(s) = shape_mut(level, e) {
        if !matches!(s, Shape::Poly { .. }) {
            let pts = s.outline_n(16);
            *s = Shape::Poly { points: pts };
            return true;
        }
    }
    false
}

// ------------------------------------------------------------ clipboard

/// A detached copy of one element (for copy / paste / duplicate).
#[derive(Clone, Debug)]
pub enum Item {
    Spawn(Vec2),
    Goal(Shape),
    Terrain(Terrain),
    Jelly(Jelly),
    Platform(SoftPlatform),
    Prop(Prop),
    Mover(Mover),
    Rope(RopeDef),
    Zone(Zone),
    Spring(SpringPad),
    Spikes(Spikes),
    Checkpoint(Checkpoint),
    Pickup(Vec2),
    Npc(Npc),
    Hill(Shape),
    Story(StoryTrigger),
    Decor(Decor),
}

pub fn copy(level: &Level, e: Elem) -> Option<Item> {
    if !exists(level, e) {
        return None;
    }
    Some(match e {
        Elem::Spawn => Item::Spawn(level.spawn),
        Elem::Goal => Item::Goal(level.goal.clone()?),
        Elem::Terrain(i) => Item::Terrain(level.terrain[i].clone()),
        Elem::Jelly(i) => Item::Jelly(level.jelly[i].clone()),
        Elem::Platform(i) => Item::Platform(level.platforms[i].clone()),
        Elem::Prop(i) => Item::Prop(level.props[i].clone()),
        Elem::Mover(i) => Item::Mover(level.movers[i].clone()),
        Elem::Rope(i) => Item::Rope(level.ropes[i].clone()),
        Elem::Zone(i) => Item::Zone(level.zones[i].clone()),
        Elem::Spring(i) => Item::Spring(level.springs[i].clone()),
        Elem::Spikes(i) => Item::Spikes(level.spikes[i].clone()),
        Elem::Checkpoint(i) => Item::Checkpoint(level.checkpoints[i].clone()),
        Elem::Pickup(i) => Item::Pickup(level.pickups[i]),
        Elem::Npc(i) => Item::Npc(level.npcs[i].clone()),
        Elem::Hill(i) => Item::Hill(level.hills[i].clone()),
        Elem::Story(i) => Item::Story(level.story[i].clone()),
        Elem::Decor(i) => Item::Decor(level.decor[i].clone()),
    })
}

/// A unique id with the given prefix (`prefix_N`).
pub fn fresh_id(level: &Level, prefix: &str) -> String {
    let used: std::collections::HashSet<&str> = level
        .props
        .iter()
        .map(|p| p.id.as_str())
        .chain(level.platforms.iter().map(|p| p.id.as_str()))
        .chain(level.movers.iter().map(|p| p.id.as_str()))
        .chain(level.ropes.iter().map(|p| p.id.as_str()))
        .chain(level.zones.iter().map(|p| p.id.as_str()))
        .chain(level.npcs.iter().map(|p| p.id.as_str()))
        .collect();
    (1..).map(|n| format!("{prefix}_{n}")).find(|s| !used.contains(s.as_str())).unwrap()
}

/// Add an item; returns its new reference. Ids of named items are made
/// unique.
pub fn add(level: &mut Level, item: Item) -> Elem {
    fn uniq(level: &Level, id: &str, prefix: &str) -> String {
        if id.is_empty() {
            return String::new();
        }
        let taken = level.props.iter().any(|p| p.id == id)
            || level.platforms.iter().any(|p| p.id == id)
            || level.movers.iter().any(|p| p.id == id)
            || level.ropes.iter().any(|p| p.id == id)
            || level.zones.iter().any(|p| p.id == id)
            || level.npcs.iter().any(|p| p.id == id);
        if taken { fresh_id(level, prefix) } else { id.to_string() }
    }
    match item {
        Item::Spawn(p) => {
            level.spawn = p;
            Elem::Spawn
        }
        Item::Goal(s) => {
            level.goal = Some(s);
            Elem::Goal
        }
        Item::Terrain(t) => {
            level.terrain.push(t);
            Elem::Terrain(level.terrain.len() - 1)
        }
        Item::Jelly(t) => {
            level.jelly.push(t);
            Elem::Jelly(level.jelly.len() - 1)
        }
        Item::Platform(mut t) => {
            t.id = uniq(level, &t.id, "plat");
            level.platforms.push(t);
            Elem::Platform(level.platforms.len() - 1)
        }
        Item::Prop(mut t) => {
            t.id = uniq(level, &t.id, "prop");
            level.props.push(t);
            Elem::Prop(level.props.len() - 1)
        }
        Item::Mover(mut t) => {
            t.id = uniq(level, &t.id, "mover");
            level.movers.push(t);
            Elem::Mover(level.movers.len() - 1)
        }
        Item::Rope(mut t) => {
            t.id = uniq(level, &t.id, "rope");
            level.ropes.push(t);
            Elem::Rope(level.ropes.len() - 1)
        }
        Item::Zone(mut t) => {
            t.id = uniq(level, &t.id, "zone");
            level.zones.push(t);
            Elem::Zone(level.zones.len() - 1)
        }
        Item::Spring(t) => {
            level.springs.push(t);
            Elem::Spring(level.springs.len() - 1)
        }
        Item::Spikes(t) => {
            level.spikes.push(t);
            Elem::Spikes(level.spikes.len() - 1)
        }
        Item::Checkpoint(t) => {
            level.checkpoints.push(t);
            Elem::Checkpoint(level.checkpoints.len() - 1)
        }
        Item::Pickup(p) => {
            level.pickups.push(p);
            Elem::Pickup(level.pickups.len() - 1)
        }
        Item::Npc(mut t) => {
            t.id = uniq(level, &t.id, "npc");
            level.npcs.push(t);
            Elem::Npc(level.npcs.len() - 1)
        }
        Item::Hill(s) => {
            level.hills.push(s);
            Elem::Hill(level.hills.len() - 1)
        }
        Item::Story(t) => {
            level.story.push(t);
            Elem::Story(level.story.len() - 1)
        }
        Item::Decor(t) => {
            level.decor.push(t);
            Elem::Decor(level.decor.len() - 1)
        }
    }
}

/// Delete elements (indices handled highest-first so the rest stay valid).
/// The spawn can't be deleted. Ropes tied to a deleted body are removed too.
pub fn delete(level: &mut Level, elems: &[Elem]) {
    let mut v: Vec<Elem> = elems.iter().copied().filter(|e| exists(level, *e)).collect();
    v.sort();
    v.dedup();
    let mut dead_ids: Vec<String> = Vec::new();
    for e in v.iter().rev() {
        match *e {
            Elem::Spawn => {}
            Elem::Goal => level.goal = None,
            Elem::Terrain(i) => {
                level.terrain.remove(i);
            }
            Elem::Jelly(i) => {
                level.jelly.remove(i);
            }
            Elem::Platform(i) => dead_ids.push(level.platforms.remove(i).id),
            Elem::Prop(i) => dead_ids.push(level.props.remove(i).id),
            Elem::Mover(i) => {
                level.movers.remove(i);
            }
            Elem::Rope(i) => {
                level.ropes.remove(i);
            }
            Elem::Zone(i) => {
                level.zones.remove(i);
            }
            Elem::Spring(i) => {
                level.springs.remove(i);
            }
            Elem::Spikes(i) => {
                level.spikes.remove(i);
            }
            Elem::Checkpoint(i) => {
                level.checkpoints.remove(i);
            }
            Elem::Pickup(i) => {
                level.pickups.remove(i);
            }
            Elem::Npc(i) => {
                level.npcs.remove(i);
            }
            Elem::Hill(i) => {
                level.hills.remove(i);
            }
            Elem::Story(i) => {
                level.story.remove(i);
            }
            Elem::Decor(i) => {
                level.decor.remove(i);
            }
        }
    }
    dead_ids.retain(|s| !s.is_empty());
    if !dead_ids.is_empty() {
        level.ropes.retain(|r| {
            ![&r.from, &r.to].iter().any(|e| matches!(e, RopeEnd::Body { id } if dead_ids.contains(id)))
        });
    }
}

pub fn translate_item(item: &mut Item, d: Vec2) {
    let mut tmp = Level::new("tmp", "tmp");
    let e = add(&mut tmp, item.clone());
    translate(&mut tmp, e, d);
    if let Some(i) = copy(&tmp, e) {
        *item = i;
    }
}

pub fn snap(v: Vec2, grid: f32) -> Vec2 {
    if grid <= 0.0 { v } else { (v / grid).round() * grid }
}

/// Snap `p` so the segment from `from` has a 15° multiple angle.
pub fn snap_angle(from: Vec2, p: Vec2) -> Vec2 {
    let d = p - from;
    let step = 15f32.to_radians();
    let a = (d.y.atan2(d.x) / step).round() * step;
    from + Vec2::from_angle(a) * d.length()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bb_level::{LevelBuilder, v};

    fn sample() -> Level {
        let mut b = LevelBuilder::new("t", "T", Theme::Hollow);
        b.spawn(v(0.0, 50.0))
            .block(v(-100.0, -50.0), v(100.0, 0.0))
            .poly(&[v(200.0, 0.0), v(300.0, 0.0), v(250.0, 100.0)])
            .spikes(v(-50.0, 0.0), v(50.0, 0.0))
            .prop("box", PropKind::Block, v(0.0, 200.0), v(40.0, 40.0), 1.0, "")
            .rope(RopeEnd::World { at: v(0.0, 400.0) }, RopeEnd::Body { id: "box".into() }, 200.0, RopeStyle::Rope)
            .pickup(v(500.0, 50.0));
        b.build()
    }

    #[test]
    fn hit_priority_and_translate() {
        let mut l = sample();
        let h = hits_at(&l, v(0.0, 200.0), 4.0);
        assert_eq!(h[0], Elem::Prop(0));
        assert!(hits_at(&l, v(0.0, -20.0), 4.0).contains(&Elem::Terrain(0)));
        translate(&mut l, Elem::Terrain(1), v(10.0, 0.0));
        assert!(hit(&l, Elem::Terrain(1), v(305.0, 1.0), 2.0));
        assert!(hit(&l, Elem::Rope(0), v(0.0, 300.0), 4.0));
    }

    #[test]
    fn frame_resize_and_rotate() {
        let mut l = sample();
        let f = frame(&l, Elem::Terrain(0)).unwrap();
        assert_eq!(f.size, v(200.0, 50.0));
        let mut n = f;
        n.size.x = 400.0;
        set_frame(&mut l, Elem::Terrain(0), f, n);
        assert_eq!(frame(&l, Elem::Terrain(0)).unwrap().size.x, 400.0);
        // Poly scales about its frame.
        let f = frame(&l, Elem::Terrain(1)).unwrap();
        let mut n = f;
        n.size *= 2.0;
        set_frame(&mut l, Elem::Terrain(1), f, n);
        assert!((frame(&l, Elem::Terrain(1)).unwrap().size - f.size * 2.0).length() < 0.01);
        rotate(&mut l, Elem::Spikes(0), std::f32::consts::FRAC_PI_2);
        let s = &l.spikes[0];
        assert!((s.a - v(0.0, -50.0)).length() < 0.01 && (s.b - v(0.0, 50.0)).length() < 0.01);
    }

    #[test]
    fn delete_cascades_ropes_and_keeps_order() {
        let mut l = sample();
        delete(&mut l, &[Elem::Prop(0), Elem::Pickup(0), Elem::Spawn]);
        assert!(l.props.is_empty() && l.ropes.is_empty() && l.pickups.is_empty());
        assert_eq!(l.spawn, v(0.0, 50.0));
    }

    #[test]
    fn copy_paste_unique_ids() {
        let mut l = sample();
        let mut it = copy(&l, Elem::Prop(0)).unwrap();
        translate_item(&mut it, v(20.0, 0.0));
        let e = add(&mut l, it);
        assert_eq!(e, Elem::Prop(1));
        assert_ne!(l.props[1].id, "box");
        assert_eq!(l.props[1].center, v(20.0, 200.0));
    }

    #[test]
    fn vertices() {
        let mut l = sample();
        let pts = points(&l, Elem::Terrain(1));
        assert_eq!(pts.len(), 3);
        set_point(&mut l, Elem::Terrain(1), 2, v(250.0, 200.0));
        assert!(insert_vertex(&mut l, Elem::Terrain(1), 0, v(250.0, -10.0)));
        assert_eq!(points(&l, Elem::Terrain(1)).len(), 4);
        assert!(delete_vertex(&mut l, Elem::Terrain(1), 1));
        assert!(!delete_vertex(&mut l, Elem::Terrain(1), 0), "keeps ≥ 3");
        assert!(to_poly(&mut l, Elem::Terrain(0)));
        assert_eq!(points(&l, Elem::Terrain(0)).len(), 4);
    }
}
