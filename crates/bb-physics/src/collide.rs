//! Contact generation and projection.
//!
//! Particles of one body are tested against the outline of a static polygon
//! or another body. A particle inside a closed outline (or within the
//! combined skin radius of an edge) is pushed out along the shortest path;
//! for dynamic outlines the push is shared with the two edge endpoints by
//! inverse mass and barycentric weight. Friction is position-based: the
//! tangential part of the relative displacement this substep is removed
//! (static) or reduced (kinetic) in proportion to the penetration depth.

use glam::Vec2;

use crate::body::{Body, BodyId, BodyKind};
use crate::geom;
use crate::world::{Collider, Contact, Static, StaticId, SubstepCtx, World};

fn collision_particles(b: &Body) -> impl Iterator<Item = usize> + '_ {
    let all = b.kind == BodyKind::Rope;
    let n = if all { b.x.len() } else { b.boundary.len() };
    (0..n).map(move |k| if all { k } else { b.boundary[k] as usize })
}

struct Closest {
    point: Vec2,
    dist2: f32,
    edge: usize,
    t: f32,
}

fn closest_edge(p: Vec2, n: usize, closed: bool, vert: impl Fn(usize) -> Vec2) -> Option<Closest> {
    let edges = if closed { n } else { n.saturating_sub(1) };
    let mut best: Option<Closest> = None;
    for k in 0..edges {
        let a = vert(k);
        let b = vert((k + 1) % n);
        let (q, t) = geom::closest_on_segment(p, a, b);
        let d2 = q.distance_squared(p);
        if best.as_ref().is_none_or(|bst| d2 < bst.dist2) {
            best = Some(Closest { point: q, dist2: d2, edge: k, t });
        }
    }
    best
}

fn mix_friction(a: f32, b: f32) -> f32 {
    (a * b).sqrt()
}

pub(crate) fn body_vs_static(
    b: &mut Body,
    id: BodyId,
    s: &Static,
    sid: StaticId,
    _ctx: &SubstepCtx,
    out: &mut Vec<Contact>,
) {
    let r = b.params.radius;
    let n = s.poly.len();
    let bb = s.aabb.expand(r);
    let mu_s = mix_friction(b.params.material.static_friction, s.material.static_friction);
    let mu_k = mix_friction(b.params.material.dynamic_friction, s.material.dynamic_friction);
    let idx: Vec<usize> = collision_particles(b).collect();
    for i in idx {
        if b.w[i] == 0.0 {
            continue;
        }
        let p = b.x[i];
        if !bb.contains(p) {
            continue;
        }
        let inside = geom::point_in_polygon(p, &s.poly);
        let Some(cl) = closest_edge(p, n, true, |k| s.poly[k]) else { continue };
        let dist = cl.dist2.sqrt();
        let (normal, depth) = if inside {
            let nrm = if dist > 1e-6 { (cl.point - p) / dist } else { edge_normal(&s.poly, cl.edge) };
            (nrm, dist + r)
        } else if dist < r {
            let nrm = if dist > 1e-6 { (p - cl.point) / dist } else { edge_normal(&s.poly, cl.edge) };
            (nrm, r - dist)
        } else {
            continue;
        };
        if let Some(dir) = s.one_way {
            // Only block particles landing on the solid side from outside.
            if normal.dot(dir) < 0.5 || geom::point_in_polygon(b.prev[i], &s.sub_prev) {
                continue;
            }
        }
        let approach = -(b.v[i].dot(normal)).min(0.0);
        b.x[i] += normal * depth;

        // Friction relative to the (possibly moving) surface point.
        let a0 = s.sub_prev.get(cl.edge).copied().unwrap_or(s.poly[cl.edge]);
        let a1 = s.sub_prev.get((cl.edge + 1) % n).copied().unwrap_or(s.poly[(cl.edge + 1) % n]);
        let surf_disp = (s.poly[cl.edge] - a0).lerp(s.poly[(cl.edge + 1) % n] - a1, cl.t);
        let rel = (b.x[i] - b.prev[i]) - surf_disp;
        let tang = rel - normal * rel.dot(normal);
        let tl = tang.length();
        if tl > 1e-9 {
            if tl < mu_s * depth {
                b.x[i] -= tang;
            } else {
                b.x[i] -= tang * (mu_k * depth / tl).min(1.0);
            }
        }
        out.push(Contact { body: id, particle: i as u32, other: Collider::Static(sid), normal, point: cl.point, approach_speed: approach });
    }
}

fn edge_normal(poly: &[Vec2], k: usize) -> Vec2 {
    let a = poly[k];
    let b = poly[(k + 1) % poly.len()];
    let d = b - a;
    Vec2::new(d.y, -d.x).normalize_or(Vec2::Y)
}

/// Push particles of `a` out of the outline of `b`.
pub(crate) fn body_vs_body(a: &mut Body, ida: BodyId, b: &mut Body, idb: BodyId, _ctx: &SubstepCtx, out: &mut Vec<Contact>) {
    let r = a.params.radius + b.params.radius;
    let bb = b.aabb.expand(a.params.radius);
    let nb = b.boundary.len();
    if nb < 2 {
        return;
    }
    let mu_s = mix_friction(a.params.material.static_friction, b.params.material.static_friction);
    let mu_k = mix_friction(a.params.material.dynamic_friction, b.params.material.dynamic_friction);
    let idx: Vec<usize> = collision_particles(a).collect();
    for i in idx {
        let p = a.x[i];
        if !bb.contains(p) {
            continue;
        }
        let inside = b.closed && geom::point_in_loop(p, &b.x, &b.boundary);
        let Some(cl) = closest_edge(p, nb, b.closed, |k| b.x[b.boundary[k] as usize]) else { continue };
        let dist = cl.dist2.sqrt();
        let e0 = b.boundary[cl.edge] as usize;
        let e1 = b.boundary[(cl.edge + 1) % nb] as usize;
        let edge_n = {
            let d = b.x[e1] - b.x[e0];
            Vec2::new(d.y, -d.x).normalize_or(Vec2::Y)
        };
        let (normal, depth) = if inside {
            let nrm = if dist > 1e-6 { (cl.point - p) / dist } else { edge_n };
            (nrm, dist + r)
        } else if dist < r {
            let nrm = if dist > 1e-6 { (p - cl.point) / dist } else { edge_n };
            (nrm, r - dist)
        } else {
            continue;
        };
        let t = cl.t;
        let (wp, w0, w1) = (a.w[i], b.w[e0], b.w[e1]);
        let wsum = wp + (1.0 - t) * (1.0 - t) * w0 + t * t * w1;
        if wsum <= 0.0 {
            continue;
        }
        let edge_v = b.v[e0].lerp(b.v[e1], t);
        let approach = -((a.v[i] - edge_v).dot(normal)).min(0.0);
        let dl = depth / wsum;
        a.x[i] += normal * (dl * wp);
        b.x[e0] -= normal * (dl * w0 * (1.0 - t));
        b.x[e1] -= normal * (dl * w1 * t);

        // Friction on relative tangential displacement.
        let disp_p = a.x[i] - a.prev[i];
        let disp_e = (b.x[e0] - b.prev[e0]).lerp(b.x[e1] - b.prev[e1], t);
        let rel = disp_p - disp_e;
        let tang = rel - normal * rel.dot(normal);
        let tl = tang.length();
        if tl > 1e-9 {
            let corr = if tl < mu_s * depth { tang } else { tang * (mu_k * depth / tl).min(1.0) };
            let k = 1.0 / wsum;
            a.x[i] -= corr * (wp * k);
            b.x[e0] += corr * (w0 * (1.0 - t) * k);
            b.x[e1] += corr * (w1 * t * k);
        }
        out.push(Contact { body: ida, particle: i as u32, other: Collider::Body(idb), normal, point: cl.point, approach_speed: approach });
        if w0 == 0.0 || w1 == 0.0 {
            // Touching something immovable; nothing else to record.
        }
    }
}

/// Bounce off bouncy statics: after the velocity update, reflect the normal
/// velocity of particles that hit a surface hard enough.
pub(crate) fn apply_restitution(world: &mut World, _h: f32) {
    let threshold = world.config.restitution_threshold;
    let contacts: Vec<Contact> = world.contacts().to_vec();
    let statics: Vec<f32> =
        world.static_list().iter().map(|s| s.as_ref().map_or(0.0, |s| s.material.restitution)).collect();
    for c in contacts {
        let Collider::Static(sid) = c.other else { continue };
        if c.approach_speed < threshold {
            continue;
        }
        let Some(b) = world.body_by_index_mut(c.body.index) else { continue };
        let e = b.params.material.restitution.max(statics[sid.0 as usize]);
        if e <= 0.0 {
            continue;
        }
        let i = c.particle as usize;
        let vn = b.v[i].dot(c.normal);
        b.v[i] += c.normal * (e * c.approach_speed - vn);
    }
}
