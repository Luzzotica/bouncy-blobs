//! The simulation world: bodies, static colliders, joints, ropes, and the
//! XPBD substep loop.
//!
//! Each `step(dt)` runs `substeps` small steps with ONE constraint iteration
//! each ("small steps" XPBD, Macklin et al. 2019). Small steps converge far
//! better than many iterations of one big step, which is what makes long
//! ropes, dense platforms and heavy-vs-light contacts stable.
//!
//! Solve order inside a substep is deliberate:
//!   1. body internals (edges, triangle areas, volume, shape matching)
//!   2. hard strain limits (squash floor / stretch ceiling)
//!   3. joints and ropes
//!   4. collisions (always last: geometry is non-negotiable)
//! Because the limits are solved before joints and collisions, anything still
//! violating a limit at the end of the substep was forced there by a joint or
//! geometry. That residual is the "strain" that eventually pops a body.

use std::collections::{HashMap, HashSet};

use glam::Vec2;

use crate::body::{Body, BodyDesc, BodyId, BodyKind, Material};
use crate::collide;
use crate::constraints;
use crate::geom::{self, Aabb};
use crate::rope::{Anchor, Joint, JointId, Rope, RopeDesc, RopeId};

#[derive(Copy, Clone, Debug)]
pub struct Config {
    pub gravity: Vec2,
    pub substeps: u32,
    /// Hard cap on particle speed (units/s) — last line of defence against
    /// tunnelling and energy blow-ups.
    pub max_speed: f32,
    /// Approach speed above which a new contact emits [`Event::Impact`].
    pub impact_threshold: f32,
    /// Approach speed below which restitution is ignored (resting contact).
    pub restitution_threshold: f32,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            gravity: Vec2::new(0.0, -1800.0),
            substeps: 12,
            max_speed: 5000.0,
            impact_threshold: 120.0,
            restitution_threshold: 60.0,
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StaticId(pub u32);

/// Immovable (or script-moved) polygon collider: level geometry.
#[derive(Clone, Debug)]
pub struct Static {
    /// Counter-clockwise outline.
    pub poly: Vec<Vec2>,
    /// Outline at the start of the current step (kinematic interpolation).
    pub(crate) from: Vec<Vec2>,
    /// Outline requested for the end of the current step.
    pub(crate) to: Vec<Vec2>,
    /// Outline at the start of the current substep.
    pub(crate) sub_prev: Vec<Vec2>,
    pub material: Material,
    pub layer: u32,
    pub mask: u32,
    pub aabb: Aabb,
    pub user_data: u64,
    pub enabled: bool,
    /// One-way platform: only blocks particles approaching against this
    /// direction (e.g. `Vec2::Y` lets you jump up through it).
    pub one_way: Option<Vec2>,
}

#[derive(Clone, Debug)]
pub struct StaticDesc {
    pub poly: Vec<Vec2>,
    pub material: Material,
    pub layer: u32,
    pub mask: u32,
    pub user_data: u64,
    pub one_way: Option<Vec2>,
}

impl StaticDesc {
    pub fn polygon(poly: Vec<Vec2>) -> StaticDesc {
        StaticDesc { poly, material: Material::default(), layer: 1, mask: u32::MAX, user_data: 0, one_way: None }
    }

    pub fn rect(min: Vec2, max: Vec2) -> StaticDesc {
        Self::polygon(vec![min, Vec2::new(max.x, min.y), max, Vec2::new(min.x, max.y)])
    }
}

/// What a body touched.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum Collider {
    Static(StaticId),
    Body(BodyId),
}

#[derive(Copy, Clone, Debug)]
pub struct Contact {
    pub body: BodyId,
    pub particle: u32,
    pub other: Collider,
    /// Unit normal pointing from `other` toward `body`.
    pub normal: Vec2,
    pub point: Vec2,
    /// Approach speed along the normal at the moment of contact (≥ 0).
    pub approach_speed: f32,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum PopCause {
    Crushed,
    Overstretched,
}

#[derive(Copy, Clone, Debug)]
pub enum Event {
    /// A body exceeded its strain limits and was disabled. The game decides
    /// what to do (burst VFX, respawn, remove).
    Popped { body: BodyId, position: Vec2, velocity: Vec2, cause: PopCause },
    /// A new contact with a significant approach speed this step.
    Impact { body: BodyId, other: Collider, point: Vec2, normal: Vec2, speed: f32 },
    /// A rope exceeded its break stretch and detached its far end.
    RopeSnapped { rope: RopeId },
    /// A joint exceeded its break stretch and was removed.
    JointBroke { joint: JointId },
}

struct Slot {
    generation: u32,
    body: Option<Body>,
}

pub struct World {
    pub config: Config,
    slots: Vec<Slot>,
    free: Vec<u32>,
    statics: Vec<Option<Static>>,
    pub(crate) joints: Vec<Option<Joint>>,
    pub(crate) ropes: Vec<Option<Rope>>,
    /// Body pairs that never collide (rope ↔ the bodies it's tied to, etc.).
    ignore_pairs: HashSet<(BodyId, BodyId)>,
    contacts: Vec<Contact>,
    touching: HashSet<(BodyId, Collider)>,
    /// Bodies each body touched this step (pop immunity propagation).
    neighbours: HashMap<BodyId, Vec<BodyId>>,
    events: Vec<Event>,
    time: f64,
}

pub(crate) struct SubstepCtx {
    pub h: f32,
    pub record: bool,
}

impl World {
    pub fn new(config: Config) -> World {
        World {
            config,
            slots: Vec::new(),
            free: Vec::new(),
            statics: Vec::new(),
            joints: Vec::new(),
            ropes: Vec::new(),
            ignore_pairs: HashSet::new(),
            contacts: Vec::new(),
            touching: HashSet::new(),
            neighbours: HashMap::new(),
            events: Vec::new(),
            time: 0.0,
        }
    }

    pub fn time(&self) -> f64 {
        self.time
    }

    // ---------------------------------------------------------------- bodies

    pub fn add_body(&mut self, desc: BodyDesc) -> BodyId {
        let body = Body::from_desc(desc);
        if let Some(index) = self.free.pop() {
            let slot = &mut self.slots[index as usize];
            slot.generation += 1;
            slot.body = Some(body);
            BodyId { index, generation: slot.generation }
        } else {
            self.slots.push(Slot { generation: 0, body: Some(body) });
            BodyId { index: self.slots.len() as u32 - 1, generation: 0 }
        }
    }

    /// Remove a body and everything attached to it (joints, ropes whose
    /// chain it was). Ropes merely anchored to it lose that anchor.
    pub fn remove_body(&mut self, id: BodyId) -> Option<Body> {
        let slot = self.slots.get_mut(id.index as usize)?;
        if slot.generation != id.generation {
            return None;
        }
        let body = slot.body.take()?;
        self.free.push(id.index);
        self.detach_all(id);
        self.ignore_pairs.retain(|(a, b)| *a != id && *b != id);
        Some(body)
    }

    fn detach_all(&mut self, id: BodyId) {
        for j in self.joints.iter_mut() {
            if j.as_ref().is_some_and(|j| j.a.body() == Some(id) || j.b.body() == Some(id)) {
                *j = None;
            }
        }
        let mut dead_chains = Vec::new();
        for r in self.ropes.iter_mut() {
            let Some(rope) = r else { continue };
            if rope.body == id {
                *r = None;
                continue;
            }
            if rope.start.as_ref().and_then(|a| a.body()) == Some(id) {
                rope.start = None;
            }
            if rope.end.as_ref().and_then(|a| a.body()) == Some(id) {
                rope.end = None;
            }
            if rope.start.is_none() && rope.end.is_none() && rope.remove_when_free {
                dead_chains.push(rope.body);
                *r = None;
            }
        }
        for b in dead_chains {
            self.remove_body(b);
        }
    }

    pub fn body(&self, id: BodyId) -> Option<&Body> {
        let slot = self.slots.get(id.index as usize)?;
        if slot.generation != id.generation {
            return None;
        }
        slot.body.as_ref()
    }

    pub fn body_mut(&mut self, id: BodyId) -> Option<&mut Body> {
        let slot = self.slots.get_mut(id.index as usize)?;
        if slot.generation != id.generation {
            return None;
        }
        slot.body.as_mut()
    }

    pub fn bodies(&self) -> impl Iterator<Item = (BodyId, &Body)> {
        self.slots.iter().enumerate().filter_map(|(i, s)| {
            s.body.as_ref().map(|b| (BodyId { index: i as u32, generation: s.generation }, b))
        })
    }

    pub fn body_count(&self) -> usize {
        self.slots.iter().filter(|s| s.body.is_some()).count()
    }

    /// Re-enable a popped body at `at`, rest shape, zero velocity.
    pub fn respawn(&mut self, id: BodyId, at: Vec2) {
        if let Some(b) = self.body_mut(id) {
            b.enabled = true;
            b.reset_to(at);
            b.immunity = b.params.limits.immunity;
        }
    }

    /// Never collide `a` with `b`.
    pub fn ignore_collision(&mut self, a: BodyId, b: BodyId) {
        self.ignore_pairs.insert(ordered(a, b));
    }

    pub fn allow_collision(&mut self, a: BodyId, b: BodyId) {
        self.ignore_pairs.remove(&ordered(a, b));
    }

    // --------------------------------------------------------------- statics

    pub fn add_static(&mut self, desc: StaticDesc) -> StaticId {
        let mut poly = desc.poly;
        if geom::signed_area_slice(&poly) < 0.0 {
            poly.reverse();
        }
        let aabb = Aabb::from_points(poly.iter().copied());
        self.statics.push(Some(Static {
            from: poly.clone(),
            to: poly.clone(),
            sub_prev: poly.clone(),
            poly,
            material: desc.material,
            layer: desc.layer,
            mask: desc.mask,
            aabb,
            user_data: desc.user_data,
            enabled: true,
            one_way: desc.one_way,
        }));
        StaticId(self.statics.len() as u32 - 1)
    }

    pub fn static_collider(&self, id: StaticId) -> Option<&Static> {
        self.statics.get(id.0 as usize)?.as_ref()
    }

    pub fn static_mut(&mut self, id: StaticId) -> Option<&mut Static> {
        self.statics.get_mut(id.0 as usize)?.as_mut()
    }

    pub fn statics(&self) -> impl Iterator<Item = (StaticId, &Static)> {
        self.statics.iter().enumerate().filter_map(|(i, s)| s.as_ref().map(|s| (StaticId(i as u32), s)))
    }

    pub fn remove_static(&mut self, id: StaticId) {
        if let Some(s) = self.statics.get_mut(id.0 as usize) {
            *s = None;
        }
    }

    /// Move a static collider to a new outline over the course of the next
    /// step. Particles it touches are carried and pushed smoothly (moving
    /// platforms, pistons, the crusher).
    pub fn move_static(&mut self, id: StaticId, poly: Vec<Vec2>) {
        if let Some(Some(s)) = self.statics.get_mut(id.0 as usize) {
            debug_assert_eq!(s.poly.len(), poly.len(), "move_static must keep the vertex count");
            s.to = poly;
        }
    }

    // ------------------------------------------------------------ joints/ropes

    pub fn add_joint(&mut self, joint: Joint) -> JointId {
        if joint.ignore_collision {
            if let (Some(a), Some(b)) = (joint.a.body(), joint.b.body()) {
                if a != b {
                    self.ignore_collision(a, b);
                }
            }
        }
        self.joints.push(Some(joint));
        JointId(self.joints.len() as u32 - 1)
    }

    pub fn remove_joint(&mut self, id: JointId) {
        if let Some(j) = self.joints.get_mut(id.0 as usize) {
            *j = None;
        }
    }

    pub fn joint(&self, id: JointId) -> Option<&Joint> {
        self.joints.get(id.0 as usize)?.as_ref()
    }

    pub fn add_rope(&mut self, desc: RopeDesc) -> RopeId {
        crate::rope::add_rope(self, desc)
    }

    pub fn rope(&self, id: RopeId) -> Option<&Rope> {
        self.ropes.get(id.0 as usize)?.as_ref()
    }

    pub fn rope_mut(&mut self, id: RopeId) -> Option<&mut Rope> {
        self.ropes.get_mut(id.0 as usize)?.as_mut()
    }

    pub fn ropes(&self) -> impl Iterator<Item = (RopeId, &Rope)> {
        self.ropes.iter().enumerate().filter_map(|(i, r)| r.as_ref().map(|r| (RopeId(i as u32), r)))
    }

    pub fn remove_rope(&mut self, id: RopeId) {
        if let Some(Some(r)) = self.ropes.get_mut(id.0 as usize).map(|r| r.take()) {
            self.remove_body(r.body);
        }
    }

    /// World position of an anchor right now.
    pub fn anchor_position(&self, a: &Anchor) -> Option<Vec2> {
        match a {
            Anchor::World(p) => Some(*p),
            Anchor::Body { body, points } => {
                let b = self.body(*body)?;
                Some(points.iter().map(|&(i, wt)| b.x[i as usize] * wt).sum())
            }
        }
    }

    // ---------------------------------------------------------------- queries

    pub fn drain_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    /// Contacts from the final substep of the last step.
    pub fn contacts(&self) -> &[Contact] {
        &self.contacts
    }

    pub fn contacts_of(&self, id: BodyId) -> impl Iterator<Item = &Contact> {
        self.contacts.iter().filter(move |c| c.body == id)
    }

    /// Topmost (last-added) enabled closed body containing `p`, filtered by
    /// layer mask. This is what a tap/click hits.
    pub fn pick(&self, p: Vec2, mask: u32) -> Option<BodyId> {
        self.bodies().filter(|(_, b)| b.enabled && b.layer & mask != 0 && b.contains_point(p)).map(|(id, _)| id).last()
    }

    /// Closest dynamic particle of `id` to `p`.
    pub fn nearest_particle(&self, id: BodyId, p: Vec2) -> Option<u32> {
        let b = self.body(id)?;
        b.x.iter().enumerate().min_by(|a, c| a.1.distance_squared(p).total_cmp(&c.1.distance_squared(p))).map(|(i, _)| i as u32)
    }

    /// Raycast against statics and closed bodies. Returns the nearest hit
    /// (collider, point, normal, distance).
    pub fn raycast(&self, origin: Vec2, dir: Vec2, max_dist: f32, mask: u32, skip: Option<BodyId>) -> Option<(Collider, Vec2, Vec2, f32)> {
        let dir = dir.normalize_or_zero();
        let end = origin + dir * max_dist;
        let mut best: Option<(Collider, Vec2, Vec2, f32)> = None;
        let mut test = |a: Vec2, b: Vec2, who: Collider| {
            if let Some((t, n)) = ray_segment(origin, end, a, b) {
                let d = t * max_dist;
                if best.as_ref().is_none_or(|bst| d < bst.3) {
                    let n = if n.dot(dir) > 0.0 { -n } else { n };
                    best = Some((who, origin + dir * d, n, d));
                }
            }
        };
        for (sid, s) in self.statics() {
            if !s.enabled || s.layer & mask == 0 {
                continue;
            }
            for k in 0..s.poly.len() {
                test(s.poly[k], s.poly[(k + 1) % s.poly.len()], Collider::Static(sid));
            }
        }
        for (bid, b) in self.bodies() {
            if !b.enabled || b.layer & mask == 0 || Some(bid) == skip || !b.closed {
                continue;
            }
            let n = b.boundary.len();
            for k in 0..n {
                test(b.x[b.boundary[k] as usize], b.x[b.boundary[(k + 1) % n] as usize], Collider::Body(bid));
            }
        }
        best
    }

    // ------------------------------------------------------------------- step

    pub fn step(&mut self, dt: f32) {
        if dt <= 0.0 {
            return;
        }
        let substeps = self.config.substeps.max(1);
        let h = dt / substeps as f32;

        for s in self.statics.iter_mut().flatten() {
            s.from = s.poly.clone();
        }
        for slot in self.slots.iter_mut() {
            if let Some(b) = slot.body.as_mut() {
                for k in b.kinematic.iter_mut() {
                    k.1 = b.x[k.0 as usize];
                }
            }
        }
        let prev_touching = std::mem::take(&mut self.touching);
        self.neighbours.clear();
        let mut impacts: HashMap<(BodyId, Collider), Contact> = HashMap::new();
        let mut forced = vec![false; self.slots.len()];

        for sub in 0..substeps {
            let alpha = (sub + 1) as f32 / substeps as f32;
            let ctx = SubstepCtx { h, record: sub + 1 == substeps };
            self.contacts.clear();

            // Kinematic statics move along their interpolated path.
            for s in self.statics.iter_mut().flatten() {
                std::mem::swap(&mut s.sub_prev, &mut s.poly);
                s.poly.clear();
                s.poly.extend(s.from.iter().zip(&s.to).map(|(a, b)| a.lerp(*b, alpha)));
                s.aabb = Aabb::from_points(s.poly.iter().copied());
            }

            self.predict(h, alpha);
            for slot in self.slots.iter_mut() {
                if let Some(b) = slot.body.as_mut().filter(|b| b.enabled) {
                    constraints::solve_internal(b, h);
                    constraints::solve_limits(b);
                }
            }
            crate::rope::solve_joints(self, h);
            crate::rope::solve_ropes(self, h);
            self.collide(&ctx, &mut impacts);

            // Velocity update + restitution.
            for slot in self.slots.iter_mut() {
                if let Some(b) = slot.body.as_mut().filter(|b| b.enabled) {
                    let inv_h = 1.0 / h;
                    for i in 0..b.x.len() {
                        b.v[i] = (b.x[i] - b.prev[i]) * inv_h;
                    }
                }
            }
            collide::apply_restitution(self, h);

            // Strain bookkeeping.
            for (i, slot) in self.slots.iter_mut().enumerate() {
                if let Some(b) = slot.body.as_mut().filter(|b| b.enabled) {
                    let s = constraints::measure_strain(b);
                    b.strain = b.strain.max(s.overshoot);
                    if s.overshoot > b.params.limits.tolerance {
                        b.strain_time += h;
                        forced[i] = true;
                    }
                }
            }
        }

        for (key, c) in impacts {
            if !prev_touching.contains(&key) && c.approach_speed >= self.config.impact_threshold {
                self.events.push(Event::Impact {
                    body: c.body,
                    other: c.other,
                    point: c.point,
                    normal: c.normal,
                    speed: c.approach_speed,
                });
            }
        }

        self.resolve_pops(dt, &forced);
        crate::rope::check_breaks(self, dt);

        for slot in self.slots.iter_mut() {
            if let Some(b) = slot.body.as_mut() {
                b.accel = Vec2::ZERO;
                b.point_accel.iter_mut().for_each(|a| *a = Vec2::ZERO);
                b.kinematic.retain(|k| k.1 != k.2);
                for k in b.kinematic.iter_mut() {
                    k.1 = k.2;
                }
                b.update_aabb();
            }
        }
        for s in self.statics.iter_mut().flatten() {
            s.from = s.to.clone();
            s.sub_prev = s.poly.clone();
        }
        self.time += dt as f64;
    }

    fn predict(&mut self, h: f32, alpha: f32) {
        let g = self.config.gravity;
        let max_speed = self.config.max_speed;
        for slot in self.slots.iter_mut() {
            let Some(b) = slot.body.as_mut().filter(|b| b.enabled) else { continue };
            let p = b.params;
            let lin = (1.0 - p.linear_damping * h).max(0.0);
            let internal = (1.0 - p.internal_damping * h).max(0.0);
            let mean_v = if p.internal_damping > 0.0 { b.velocity() } else { Vec2::ZERO };
            let a = g * p.gravity_scale + b.accel;
            for i in 0..b.x.len() {
                b.prev[i] = b.x[i];
                if b.w[i] == 0.0 {
                    continue;
                }
                let mut v = b.v[i] + (a + b.point_accel[i]) * h;
                if p.internal_damping > 0.0 {
                    v = mean_v + (v - mean_v) * internal;
                }
                v *= lin;
                let sp = v.length();
                if sp > max_speed {
                    v *= max_speed / sp;
                }
                b.v[i] = v;
                b.x[i] += v * h;
            }
            for &(i, from, to) in &b.kinematic {
                b.x[i as usize] = from.lerp(to, alpha);
            }
            b.update_aabb();
        }
    }

    fn collide(&mut self, ctx: &SubstepCtx, impacts: &mut HashMap<(BodyId, Collider), Contact>) {
        // Broadphase: sort-and-sweep on x over enabled bodies.
        let mut order: Vec<(f32, u32)> = self
            .slots
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.body.as_ref().filter(|b| b.enabled).map(|b| (b.aabb.min.x, i as u32)))
            .collect();
        order.sort_by(|a, b| a.0.total_cmp(&b.0));

        let mut new_contacts = Vec::new();
        // Bodies vs statics.
        for &(_, i) in &order {
            let id = self.id_of(i);
            let b = self.slots[i as usize].body.as_mut().unwrap();
            for (si, s) in self.statics.iter().enumerate() {
                let Some(s) = s.as_ref().filter(|s| s.enabled) else { continue };
                if s.layer & b.mask == 0 || b.layer & s.mask == 0 || !b.aabb.overlaps(&s.aabb) {
                    continue;
                }
                collide::body_vs_static(b, id, s, StaticId(si as u32), ctx, &mut new_contacts);
            }
        }
        // Bodies vs bodies.
        for a in 0..order.len() {
            let ia = order[a].1;
            for &(min_x, ib) in &order[a + 1..] {
                let (aabb_a, la, ma) = {
                    let ba = self.slots[ia as usize].body.as_ref().unwrap();
                    (ba.aabb, ba.layer, ba.mask)
                };
                if min_x > aabb_a.max.x {
                    break;
                }
                let bb = self.slots[ib as usize].body.as_ref().unwrap();
                if !aabb_a.overlaps(&bb.aabb) || la & bb.mask == 0 || bb.layer & ma == 0 {
                    continue;
                }
                let (ida, idb) = (self.id_of(ia), self.id_of(ib));
                if self.ignore_pairs.contains(&ordered(ida, idb)) {
                    continue;
                }
                let (ba, bb) = two_mut(&mut self.slots, ia as usize, ib as usize);
                let (ba, bb) = (ba.body.as_mut().unwrap(), bb.body.as_mut().unwrap());
                collide::body_vs_body(ba, ida, bb, idb, ctx, &mut new_contacts);
                collide::body_vs_body(bb, idb, ba, ida, ctx, &mut new_contacts);
            }
        }
        for c in &new_contacts {
            let key = (c.body, c.other);
            let e = impacts.entry(key).or_insert(*c);
            if c.approach_speed > e.approach_speed {
                *e = *c;
            }
            if ctx.record {
                self.touching.insert(key);
                if let Collider::Body(o) = c.other {
                    let n = self.neighbours.entry(c.body).or_default();
                    if !n.contains(&o) {
                        n.push(o);
                    }
                }
            }
        }
        self.contacts.extend(new_contacts);
    }

    fn resolve_pops(&mut self, dt: f32, forced: &[bool]) {
        let mut candidates: Vec<(f32, u32)> = Vec::new();
        for (i, slot) in self.slots.iter_mut().enumerate() {
            let Some(b) = slot.body.as_mut().filter(|b| b.enabled) else { continue };
            b.immunity = (b.immunity - dt).max(0.0);
            if !forced.get(i).copied().unwrap_or(false) {
                // Relax gradually so brief, repeated squeezes don't add up
                // forever but a sustained crush still accumulates.
                b.strain_time = (b.strain_time - dt).max(0.0);
            }
            let l = b.params.limits;
            if l.poppable && b.immunity <= 0.0 && b.strain_time >= l.grace {
                candidates.push((b.strain, i as u32));
            }
        }
        // Worst first: popping it usually relieves its neighbours.
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (_, i) in candidates {
            let id = self.id_of(i);
            let Some(b) = self.slots[i as usize].body.as_mut() else { continue };
            if b.immunity > 0.0 || !b.enabled {
                continue;
            }
            let cause = if b.area_ratio < 1.0 { PopCause::Crushed } else { PopCause::Overstretched };
            let (pos, vel) = (b.centroid(), b.velocity());
            let immunity = b.params.limits.immunity;
            b.enabled = false;
            b.strain_time = 0.0;
            self.events.push(Event::Popped { body: id, position: pos, velocity: vel, cause });
            let neighbours = self.neighbours.get(&id).cloned().unwrap_or_default();
            for n in neighbours {
                if let Some(nb) = self.body_mut(n) {
                    nb.immunity = nb.immunity.max(immunity);
                    nb.strain_time = 0.0;
                }
            }
            // Anything that touched the popped body counts as a neighbour too.
            let touched_by: Vec<BodyId> =
                self.neighbours.iter().filter(|(_, v)| v.contains(&id)).map(|(k, _)| *k).collect();
            for n in touched_by {
                if let Some(nb) = self.body_mut(n) {
                    nb.immunity = nb.immunity.max(immunity);
                    nb.strain_time = 0.0;
                }
            }
            self.detach_all(id);
        }
    }

    pub(crate) fn id_of(&self, index: u32) -> BodyId {
        BodyId { index, generation: self.slots[index as usize].generation }
    }

    pub(crate) fn body_by_index_mut(&mut self, index: u32) -> Option<&mut Body> {
        self.slots.get_mut(index as usize)?.body.as_mut()
    }

    pub(crate) fn static_list(&self) -> &[Option<Static>] {
        &self.statics
    }

    pub(crate) fn slot_bodies_mut(&mut self) -> impl Iterator<Item = (BodyId, &mut Body)> {
        self.slots.iter_mut().enumerate().filter_map(|(i, s)| {
            let generation = s.generation;
            s.body.as_mut().map(|b| (BodyId { index: i as u32, generation }, b))
        })
    }

    pub(crate) fn push_events(&mut self, mut e: Vec<Event>) {
        self.events.append(&mut e);
    }

    pub(crate) fn kind_of(&self, id: BodyId) -> Option<BodyKind> {
        self.body(id).map(|b| b.kind)
    }
}

pub(crate) fn ordered(a: BodyId, b: BodyId) -> (BodyId, BodyId) {
    if a <= b { (a, b) } else { (b, a) }
}

fn two_mut<T>(v: &mut [T], i: usize, j: usize) -> (&mut T, &mut T) {
    assert_ne!(i, j);
    if i < j {
        let (l, r) = v.split_at_mut(j);
        (&mut l[i], &mut r[0])
    } else {
        let (l, r) = v.split_at_mut(i);
        (&mut r[0], &mut l[j])
    }
}

/// Segment-segment intersection of ray `o..e` with `a..b`. Returns the ray
/// parameter t in [0,1] and the segment normal.
fn ray_segment(o: Vec2, e: Vec2, a: Vec2, b: Vec2) -> Option<(f32, Vec2)> {
    let r = e - o;
    let s = b - a;
    let denom = r.perp_dot(s);
    if denom.abs() < 1e-9 {
        return None;
    }
    let t = (a - o).perp_dot(s) / denom;
    let u = (a - o).perp_dot(r) / denom;
    if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
        Some((t, Vec2::new(s.y, -s.x).normalize_or_zero()))
    } else {
        None
    }
}
