//! Joints and ropes.
//!
//! Ropes are the classic failure point of softbody games: a chain of N
//! distance constraints solved Gauss-Seidel converges slowly, so a heavy blob
//! hanging off a long rope stretches it like taffy, and tying two bodies
//! together lets them drift apart. Three things fix that here:
//!
//! 1. **Small steps.** One iteration per substep, many substeps.
//! 2. **A global path-length constraint.** The whole rope is ONE inequality
//!    `Σ|xₖ₊₁ − xₖ| ≤ L`, whose gradient touches every node and both
//!    anchored bodies. A single projection removes all excess length at
//!    once and transmits the pull between the tied bodies directly, even
//!    when the rope is wrapped around geometry (the per-node gradients follow
//!    the rope's actual path).
//! 3. **Long-range attachments.** Each node may be at most its rest distance
//!    along the rope from either anchor, so nodes can't sag below where a
//!    taut rope would hold them.

use glam::Vec2;

use crate::body::{BodyDesc, BodyId};
use crate::world::World;

/// A point attached to the world or to a body. A body anchor is a weighted
/// blend of particles (weights sum to 1), so a rope can hang from a single
/// vertex, a point on an edge, or a body's centre.
#[derive(Clone, Debug)]
pub enum Anchor {
    World(Vec2),
    Body { body: BodyId, points: Vec<(u32, f32)> },
}

impl Anchor {
    pub fn body(&self) -> Option<BodyId> {
        match self {
            Anchor::World(_) => None,
            Anchor::Body { body, .. } => Some(*body),
        }
    }

    pub fn particle(body: BodyId, i: u32) -> Anchor {
        Anchor::Body { body, points: vec![(i, 1.0)] }
    }

    /// Centre of mass of all of a body's particles.
    pub fn centre(world: &World, body: BodyId) -> Option<Anchor> {
        let b = world.body(body)?;
        let total: f32 = b.base_w.iter().map(|&w| if w > 0.0 { 1.0 / w } else { 0.0 }).sum();
        if total <= 0.0 {
            return None;
        }
        let points = b
            .base_w
            .iter()
            .enumerate()
            .filter(|(_, w)| **w > 0.0)
            .map(|(i, &w)| (i as u32, (1.0 / w) / total))
            .collect();
        Some(Anchor::Body { body, points })
    }

    /// The point on the body's outline nearest to `p`.
    pub fn nearest_on_outline(world: &World, body: BodyId, p: Vec2) -> Option<Anchor> {
        let b = world.body(body)?;
        let n = b.boundary.len();
        let edges = if b.closed { n } else { n.saturating_sub(1) };
        let mut best = (f32::MAX, 0usize, 0.0f32);
        for k in 0..edges {
            let (q, t) = crate::geom::closest_on_segment(p, b.x[b.boundary[k] as usize], b.x[b.boundary[(k + 1) % n] as usize]);
            let d = q.distance_squared(p);
            if d < best.0 {
                best = (d, k, t);
            }
        }
        let (_, k, t) = best;
        let (i0, i1) = (b.boundary[k], b.boundary[(k + 1) % n]);
        Some(Anchor::Body { body, points: vec![(i0, 1.0 - t), (i1, t)] })
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub struct JointId(pub u32);

/// Distance constraint between two anchors.
#[derive(Clone, Debug)]
pub struct Joint {
    pub a: Anchor,
    pub b: Anchor,
    pub rest: f32,
    /// XPBD compliance. 0 = rigid.
    pub compliance: f32,
    /// Only resist stretching beyond `rest` (a tether), never pushing.
    pub max_only: bool,
    pub ignore_collision: bool,
    /// Break if stretched beyond `rest * break_stretch` for 0.1 s.
    pub break_stretch: Option<f32>,
    pub(crate) over_time: f32,
}

impl Joint {
    pub fn new(a: Anchor, b: Anchor, rest: f32) -> Joint {
        Joint { a, b, rest, compliance: 0.0, max_only: false, ignore_collision: true, break_stretch: None, over_time: 0.0 }
    }

    pub fn pin(a: Anchor, b: Anchor) -> Joint {
        Self::new(a, b, 0.0)
    }

    pub fn with_compliance(mut self, c: f32) -> Joint {
        self.compliance = c;
        self
    }

    pub fn tether(mut self) -> Joint {
        self.max_only = true;
        self
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub struct RopeId(pub u32);

#[derive(Clone, Debug)]
pub struct Rope {
    /// The chain body holding the rope's particles.
    pub body: BodyId,
    pub start: Option<Anchor>,
    pub end: Option<Anchor>,
    /// Maximum length along the rope.
    pub length: f32,
    pub break_stretch: Option<f32>,
    /// Remove the chain once neither end is attached.
    pub remove_when_free: bool,
    /// Path length after the last step.
    pub current_length: f32,
    pub(crate) over_time: f32,
}

impl Rope {
    pub fn tension_ratio(&self) -> f32 {
        if self.length > 0.0 { self.current_length / self.length } else { 0.0 }
    }
}

#[derive(Clone, Debug)]
pub struct RopeDesc {
    pub from: Anchor,
    pub to: Anchor,
    /// Rope length. `None` = current distance between the anchors (taut).
    pub length: Option<f32>,
    /// Approximate spacing between rope particles.
    pub spacing: f32,
    /// Total rope mass.
    pub mass: f32,
    pub radius: f32,
    /// Snap when stretched past `length * break_stretch` (needs something
    /// immovable pulling — the path constraint wins against dynamics).
    pub break_stretch: Option<f32>,
    /// Let the rope collide with the bodies it's tied to.
    pub collide_with_anchors: bool,
    /// Lay the rope along these points (e.g. over a pulley peg) instead of
    /// a sagging arc. Should start/end at the anchors.
    pub path: Option<Vec<Vec2>>,
}

impl RopeDesc {
    pub fn new(from: Anchor, to: Anchor) -> RopeDesc {
        RopeDesc {
            from,
            to,
            length: None,
            spacing: 10.0,
            mass: 0.4,
            radius: 3.0,
            break_stretch: None,
            collide_with_anchors: false,
            path: None,
        }
    }

    pub fn length(mut self, l: f32) -> RopeDesc {
        self.length = Some(l);
        self
    }
}

pub(crate) fn add_rope(world: &mut World, d: RopeDesc) -> RopeId {
    let a = world.anchor_position(&d.from).unwrap_or(Vec2::ZERO);
    let b = world.anchor_position(&d.to).unwrap_or(a + Vec2::X);
    let dist = a.distance(b);
    let length = d.length.unwrap_or(dist).max(1e-3);
    let segs = (length / d.spacing.max(1.0)).ceil().max(2.0) as usize;
    // Lay slack rope as a shallow arc of (approximately) the right length so
    // it doesn't start compressed. L ≈ D + 8s²/(3D)  ⇒  s = √(3D(L−D)/8).
    let sag = if length > dist && dist > 1e-3 { (3.0 * dist * (length - dist) / 8.0).sqrt() } else { 0.0 };
    let along = (b - a).normalize_or(Vec2::X);
    let mut perp = along.perp();
    if perp.y > 0.0 {
        perp = -perp;
    }
    let pts: Vec<Vec2> = match &d.path {
        Some(path) if path.len() >= 2 => resample_polyline(path, segs + 1),
        _ => (0..=segs)
            .map(|k| {
                let t = k as f32 / segs as f32;
                a.lerp(b, t) + perp * (sag * 4.0 * t * (1.0 - t))
            })
            .collect(),
    };
    let mut desc = BodyDesc::chain(&pts, d.mass);
    desc.params.radius = d.radius;
    let body = world.add_body(desc);
    let seg_rest = length / segs as f32;
    if let Some(rb) = world.body_mut(body) {
        for e in rb.edges.iter_mut() {
            e.rest = seg_rest;
        }
    }
    if !d.collide_with_anchors {
        for anchor in [&d.from, &d.to] {
            if let Some(ab) = anchor.body() {
                world.ignore_collision(body, ab);
            }
        }
    }
    world.ropes.push(Some(Rope {
        body,
        start: Some(d.from),
        end: Some(d.to),
        length,
        break_stretch: d.break_stretch,
        remove_when_free: true,
        current_length: length,
        over_time: 0.0,
    }));
    RopeId(world.ropes.len() as u32 - 1)
}

/// `n` points evenly spaced along a polyline.
fn resample_polyline(path: &[Vec2], n: usize) -> Vec<Vec2> {
    let lens: Vec<f32> = path.windows(2).map(|w| (w[1] - w[0]).length()).collect();
    let total: f32 = lens.iter().sum::<f32>().max(1e-3);
    (0..n)
        .map(|k| {
            let mut s = total * k as f32 / (n - 1).max(1) as f32;
            for (i, l) in lens.iter().enumerate() {
                if s <= *l || i == lens.len() - 1 {
                    return path[i].lerp(path[i + 1], (s / l.max(1e-6)).min(1.0));
                }
                s -= l;
            }
            path[path.len() - 1]
        })
        .collect()
}

/// A resolved weighted point: (body slot index, particle, weight, inv mass).
#[derive(Copy, Clone)]
struct Term {
    slot: u32,
    i: u32,
    wt: f32,
    w: f32,
}

/// A point made of weighted particles, or a fixed world point.
#[derive(Clone, Default)]
struct Compound {
    terms: Vec<Term>,
    fixed: Option<Vec2>,
}

impl Compound {
    fn pos(&self, world: &World) -> Vec2 {
        if let Some(p) = self.fixed {
            return p;
        }
        self.terms.iter().map(|t| world_body_x(world, t.slot, t.i) * t.wt).sum()
    }

    fn inv_mass(&self) -> f32 {
        self.terms.iter().map(|t| t.wt * t.wt * t.w).sum()
    }

    fn apply(&self, world: &mut World, delta_per_w: Vec2) {
        for t in &self.terms {
            if let Some(b) = world.body_by_index_mut(t.slot) {
                b.x[t.i as usize] += delta_per_w * (t.w * t.wt);
            }
        }
    }
}

fn world_body_x(world: &World, slot: u32, i: u32) -> Vec2 {
    let id = world.id_of(slot);
    world.body(id).map_or(Vec2::ZERO, |b| b.x[i as usize])
}

fn resolve(world: &World, a: &Anchor) -> Option<Compound> {
    match a {
        Anchor::World(p) => Some(Compound { terms: Vec::new(), fixed: Some(*p) }),
        Anchor::Body { body, points } => {
            let b = world.body(*body)?;
            if !b.enabled {
                return None;
            }
            Some(Compound {
                terms: points
                    .iter()
                    .filter(|(i, _)| (*i as usize) < b.x.len())
                    .map(|&(i, wt)| Term { slot: body.index, i, wt, w: b.w[i as usize] })
                    .collect(),
                fixed: None,
            })
        }
    }
}

fn particle_compound(world: &World, body: BodyId, i: u32) -> Option<Compound> {
    let b = world.body(body)?;
    Some(Compound { terms: vec![Term { slot: body.index, i, wt: 1.0, w: b.w[i as usize] }], fixed: None })
}

/// Distance constraint between two compounds. Returns the signed violation.
fn solve_distance(world: &mut World, a: &Compound, b: &Compound, rest: f32, alpha: f32, max_only: bool) -> f32 {
    let (pa, pb) = (a.pos(world), b.pos(world));
    let d = pa - pb;
    let len = d.length();
    let c = len - rest;
    if max_only && c <= 0.0 {
        return c;
    }
    let wsum = a.inv_mass() + b.inv_mass();
    if wsum + alpha <= 0.0 || (len < 1e-9 && rest == 0.0) {
        return c;
    }
    let n = if len > 1e-9 { d / len } else { Vec2::X };
    let dl = -c / (wsum + alpha);
    a.apply(world, n * dl);
    b.apply(world, -n * dl);
    c
}

pub(crate) fn solve_joints(world: &mut World, h: f32) {
    let inv_h2 = 1.0 / (h * h);
    for k in 0..world.joints.len() {
        let Some(j) = world.joints[k].clone() else { continue };
        let (Some(a), Some(b)) = (resolve(world, &j.a), resolve(world, &j.b)) else { continue };
        solve_distance(world, &a, &b, j.rest, j.compliance * inv_h2, j.max_only);
    }
}

pub(crate) fn solve_ropes(world: &mut World, _h: f32) {
    for k in 0..world.ropes.len() {
        let Some(rope) = world.ropes[k].clone() else { continue };
        let Some(chain) = world.body(rope.body) else { continue };
        if !chain.enabled {
            continue;
        }
        let n = chain.x.len();
        if n < 2 {
            continue;
        }
        let seg_rest = rope.length / (n - 1) as f32;
        let start = rope.start.as_ref().and_then(|a| resolve(world, a));
        let end = rope.end.as_ref().and_then(|a| resolve(world, a));

        // 1. Pin the end nodes to their anchors.
        let first = particle_compound(world, rope.body, 0).unwrap();
        let last = particle_compound(world, rope.body, (n - 1) as u32).unwrap();
        if let Some(s) = &start {
            solve_distance(world, &first, s, 0.0, 0.0, false);
        }
        if let Some(e) = &end {
            solve_distance(world, &last, e, 0.0, 0.0, false);
        }

        // 2. Global path length over [start anchor, nodes…, end anchor].
        //    One projection removes all excess length and pulls the tied
        //    bodies directly.
        let mut verts: Vec<Compound> = Vec::with_capacity(n + 2);
        verts.extend(start.clone());
        for i in 0..n {
            verts.push(particle_compound(world, rope.body, i as u32).unwrap());
        }
        verts.extend(end.clone());
        // Linearised projection under-shoots when light nodes straighten a
        // kinked rope (length only drops second-order), so re-project a few
        // times; each pass is O(n).
        for _ in 0..8 {
            let pts: Vec<Vec2> = verts.iter().map(|v| v.pos(world)).collect();
            let path: f32 = pts.windows(2).map(|w| (w[1] - w[0]).length()).sum();
            if path <= rope.length * 1.0005 {
                break;
            }
            let m = pts.len();
            let dirs: Vec<Vec2> = pts.windows(2).map(|w| (w[1] - w[0]).normalize_or_zero()).collect();
            let grads: Vec<Vec2> = (0..m)
                .map(|i| {
                    let into = if i > 0 { dirs[i - 1] } else { Vec2::ZERO };
                    let out = if i + 1 < m { dirs[i] } else { Vec2::ZERO };
                    into - out
                })
                .collect();
            let denom: f32 = verts.iter().zip(&grads).map(|(v, g)| v.inv_mass() * g.length_squared()).sum();
            if denom <= 1e-12 {
                break;
            }
            let dl = -(path - rope.length) / denom;
            for (v, g) in verts.iter().zip(&grads) {
                v.apply(world, *g * dl);
            }
        }

        // 3. Long-range attachments (node-only).
        let sp = start.as_ref().map(|s| s.pos(world));
        let ep = end.as_ref().map(|e| e.pos(world));
        let rb = world.body_mut(rope.body).unwrap();
        for i in 1..n - 1 {
            if rb.w[i] == 0.0 {
                continue;
            }
            if let Some(a) = sp {
                let max = seg_rest * i as f32;
                let d = rb.x[i] - a;
                let l = d.length();
                if l > max {
                    rb.x[i] = a + d * (max / l);
                }
            }
            if let Some(b) = ep {
                let max = seg_rest * (n - 1 - i) as f32;
                let d = rb.x[i] - b;
                let l = d.length();
                if l > max {
                    rb.x[i] = b + d * (max / l);
                }
            }
        }
    }
}

pub(crate) fn check_breaks(world: &mut World, dt: f32) {
    const HOLD: f32 = 0.1;
    let mut events = Vec::new();
    for k in 0..world.ropes.len() {
        let Some(rope) = world.ropes[k].as_ref() else { continue };
        let Some(chain) = world.body(rope.body) else { continue };
        let path: f32 = chain.x.windows(2).map(|w| (w[1] - w[0]).length()).sum();
        let rope = world.ropes[k].as_mut().unwrap();
        rope.current_length = path;
        if let Some(bs) = rope.break_stretch {
            if path > rope.length * bs {
                rope.over_time += dt;
                if rope.over_time >= HOLD && rope.end.is_some() {
                    rope.end = None;
                    rope.over_time = 0.0;
                    events.push(crate::world::Event::RopeSnapped { rope: RopeId(k as u32) });
                }
            } else {
                rope.over_time = 0.0;
            }
        }
    }
    for k in 0..world.joints.len() {
        let Some(j) = world.joints[k].clone() else { continue };
        let Some(bs) = j.break_stretch else { continue };
        let (Some(pa), Some(pb)) = (world.anchor_position(&j.a), world.anchor_position(&j.b)) else { continue };
        let limit = (j.rest * bs).max(j.rest + 1.0);
        let jm = world.joints[k].as_mut().unwrap();
        if pa.distance(pb) > limit {
            jm.over_time += dt;
            if jm.over_time >= HOLD {
                world.joints[k] = None;
                events.push(crate::world::Event::JointBroke { joint: JointId(k as u32) });
            }
        } else {
            jm.over_time = 0.0;
        }
    }
    world.push_events(events);
}
