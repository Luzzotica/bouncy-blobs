//! Per-body XPBD constraints: edges, triangle areas, outline volume, shape
//! matching, and the hard strain limits.
//!
//! One iteration per substep, so the XPBD multiplier starts at zero each
//! time: Δλ = -C / (Σ wᵢ|∇Cᵢ|² + α/h²).

use glam::Vec2;

use crate::body::Body;
use crate::geom;

/// 2.x-style force model: accelerate particles with spring, pressure and
/// shape-matching forces (symplectic Euler, applied before integration).
pub(crate) fn apply_forces(b: &mut Body, fm: &crate::body::ForceModel, h: f32) {
    let n = b.x.len();
    if n < 3 {
        return;
    }
    let mut acc = vec![Vec2::ZERO; n];
    // Edge springs (rest lengths are NOT scaled by expansion, as in 2.x:
    // the ring resists the swell, which is part of the feel).
    let ring = b.boundary.len();
    for (k, e) in b.edges.iter().enumerate() {
        let (ia, ib) = (e.a as usize, e.b as usize);
        let d = b.x[ib] - b.x[ia];
        let dist = d.length();
        if dist < 1e-4 {
            continue;
        }
        let dir = d / dist;
        let ks = fm.spring_k * b.spring_scale * if k >= ring { fm.shear } else { 1.0 };
        let rel_v = (b.v[ib] - b.v[ia]).dot(dir);
        let f = dir * (ks * (dist - e.rest) + fm.spring_damp * rel_v);
        acc[ia] += f;
        acc[ib] -= f;
    }
    // Pressure toward the (expanded) rest area.
    if b.closed && b.rest_area > 0.0 && fm.pressure_k > 0.0 {
        let target = b.rest_area * b.rest_scale * b.rest_scale;
        let area = b.area();
        let err = target - area;
        for k in 0..ring {
            let i = b.boundary[k] as usize;
            let prev = b.x[b.boundary[(k + ring - 1) % ring] as usize];
            let next = b.x[b.boundary[(k + 1) % ring] as usize];
            let grad = Vec2::new((next.y - prev.y) * 0.5, (prev.x - next.x) * 0.5);
            acc[i] += grad * (fm.pressure_k * err);
        }
    }
    // Shape matching toward the scaled (and squashed) rest pose.
    if fm.shape_k > 0.0 {
        let c = crate::geom::centroid(&b.x);
        let mut s_dot = 0.0;
        let mut s_cross = 0.0;
        for i in 0..n {
            let r = b.rest[i];
            let q = b.x[i] - c;
            s_dot += r.dot(q);
            s_cross += r.perp_dot(q);
        }
        let rot = Vec2::new(s_dot, s_cross).normalize_or(Vec2::X);
        let v_com = b.v.iter().copied().sum::<Vec2>() / n as f32;
        // Rigid spin (ω about the centroid). `spin_damp` = 1 damps it like
        // any wobble (2.x); 0 lets the blob roll freely.
        let (mut l, mut inertia) = (0.0, 0.0);
        for i in 0..n {
            let r = b.x[i] - c;
            l += r.perp_dot(b.v[i] - v_com);
            inertia += r.length_squared();
        }
        let omega = if inertia > 1e-6 { l / inertia } else { 0.0 } * (1.0 - fm.spin_damp);
        for i in 0..n {
            let goal = c + rot.rotate(b.rest[i] * b.rest_scale) * b.squash;
            let rigid = v_com + (b.x[i] - c).perp() * omega;
            acc[i] += (goal - b.x[i]) * fm.shape_k - (b.v[i] - rigid) * fm.shape_damp;
        }
    }
    for i in 0..n {
        if b.w[i] > 0.0 {
            b.v[i] += acc[i] * h;
        }
    }
}

pub(crate) fn solve_internal(b: &mut Body, h: f32) {
    if b.params.forces.is_some() {
        return; // shape held by forces (see `apply_forces`)
    }
    let inv_h2 = 1.0 / (h * h);
    let scale = b.rest_scale;

    // Edges.
    let alpha = b.params.edge_compliance * inv_h2;
    for e in &b.edges {
        let (ia, ib) = (e.a as usize, e.b as usize);
        let (wa, wb) = (b.w[ia], b.w[ib]);
        let wsum = wa + wb;
        if wsum == 0.0 {
            continue;
        }
        let d = b.x[ia] - b.x[ib];
        let len = d.length();
        if len < 1e-9 {
            continue;
        }
        let n = d / len;
        let c = len - e.rest * scale;
        let dl = -c / (wsum + alpha);
        b.x[ia] += n * (dl * wa);
        b.x[ib] -= n * (dl * wb);
    }

    // Triangle areas.
    let alpha = b.params.tri_compliance * inv_h2;
    let s2 = scale * scale;
    for t in &b.tris {
        let [i0, i1, i2] = t.i.map(|i| i as usize);
        let (p0, p1, p2) = (b.x[i0], b.x[i1], b.x[i2]);
        let area = 0.5 * (p1 - p0).perp_dot(p2 - p0);
        let c = area - t.rest_area * s2;
        let g0 = grad_area(p1, p2);
        let g1 = grad_area(p2, p0);
        let g2 = grad_area(p0, p1);
        let (w0, w1, w2) = (b.w[i0], b.w[i1], b.w[i2]);
        let denom = w0 * g0.length_squared() + w1 * g1.length_squared() + w2 * g2.length_squared() + alpha;
        if denom < 1e-12 {
            continue;
        }
        let dl = -c / denom;
        b.x[i0] += g0 * (dl * w0);
        b.x[i1] += g1 * (dl * w1);
        b.x[i2] += g2 * (dl * w2);
    }

    // Outline volume ("pressure").
    if b.closed && b.rest_area > 0.0 && b.tris.is_empty() {
        let target = b.rest_area * s2 * b.inflate;
        let alpha = b.params.volume_compliance * inv_h2;
        project_area(b, target, alpha, |c| c != 0.0);
    }

    // Home tethers. Compliance is per unit mass so a finer mesh (lighter
    // particles) keeps the same overall stiffness.
    if let Some(home) = &b.home {
        let (centre, k) = if b.home_scales && (b.rest_scale - 1.0).abs() > 1e-4 {
            (home.iter().copied().sum::<Vec2>() / home.len().max(1) as f32, b.rest_scale)
        } else {
            (Vec2::ZERO, 1.0)
        };
        for i in 0..b.x.len() {
            let w = b.w[i];
            if w == 0.0 {
                continue;
            }
            let alpha = b.home_compliance * w * inv_h2;
            let xi = b.x[i];
            let target = if k == 1.0 { home[i] } else { centre + (home[i] - centre) * k };
            b.x[i] = xi + (target - xi) * (w / (w + alpha));
        }
    }

    // Shape matching: pull every particle toward its rigidly-transformed
    // rest position. Gives blobs and props a memory of their shape.
    if let Some(compliance) = b.params.shape_compliance {
        shape_match(b, compliance * inv_h2);
    }
}

/// Hard (zero-compliance, unilateral) squash floor and stretch ceiling.
pub(crate) fn solve_limits(b: &mut Body) {
    let l = b.params.limits;
    let scale = b.rest_scale;
    // Outline-area limits only make sense for ring blobs. A thin triangulated
    // sheet (a soft bridge) can sag until its outline self-intersects, and a
    // hard projection on that garbage "area" explodes it; meshes keep their
    // area per triangle instead.
    if b.closed && b.rest_area > 0.0 && b.tris.is_empty() {
        let rest = b.rest_area * scale * scale;
        // Squash floor relative to the unswollen size: swelling in a tight
        // spot squeezes you back toward normal, it never pops you.
        let floor = b.rest_area * scale.min(1.0).powi(2) * l.min_area;
        let area = b.area();
        if area < floor {
            project_area(b, floor, 0.0, |c| c < 0.0);
        } else if area > rest * l.max_area {
            project_area(b, rest * l.max_area, 0.0, |c| c > 0.0);
        }
    }
    for k in 0..b.edges.len() {
        let e = b.edges[k];
        let (ia, ib) = (e.a as usize, e.b as usize);
        let max = e.rest * scale * l.max_stretch;
        let d = b.x[ia] - b.x[ib];
        let len = d.length();
        if len <= max {
            continue;
        }
        let wsum = b.w[ia] + b.w[ib];
        if wsum == 0.0 {
            continue;
        }
        let n = d / len;
        let dl = -(len - max) / wsum;
        b.x[ia] += n * (dl * b.w[ia]);
        b.x[ib] -= n * (dl * b.w[ib]);
    }
}

pub(crate) struct Strain {
    pub overshoot: f32,
}

/// How far past its limits the body currently is (relative overshoot),
/// and refresh `area_ratio`.
pub(crate) fn measure_strain(b: &mut Body) -> Strain {
    let l = b.params.limits;
    let scale = b.rest_scale;
    let mut over: f32 = 0.0;
    if b.closed && b.rest_area > 0.0 && b.tris.is_empty() {
        let ratio = b.area() / (b.rest_area * scale * scale);
        b.area_ratio = ratio;
        let squash = b.area() / (b.rest_area * scale.min(1.0).powi(2));
        if squash < l.min_area {
            over = over.max((l.min_area - squash) / l.min_area);
        } else if ratio > l.max_area {
            over = over.max((ratio - l.max_area) / l.max_area);
        }
    }
    for e in &b.edges {
        let len = (b.x[e.a as usize] - b.x[e.b as usize]).length();
        let max = e.rest * scale * l.max_stretch;
        if len > max && max > 0.0 {
            over = over.max((len - max) / max);
        }
    }
    Strain { overshoot: over }
}

#[inline]
fn grad_area(next: Vec2, prev: Vec2) -> Vec2 {
    // ∂A/∂xᵢ = ½ · rot(x_{i+1} − x_{i−1}), rot(v) = (v.y, −v.x)
    let d = next - prev;
    Vec2::new(d.y, -d.x) * 0.5
}

fn project_area(b: &mut Body, target: f32, alpha: f32, active: impl Fn(f32) -> bool) {
    let n = b.boundary.len();
    if n < 3 {
        return;
    }
    let area = geom::signed_area(b.boundary.iter().map(|&i| b.x[i as usize]));
    let c = area - target;
    if !active(c) {
        return;
    }
    let mut denom = alpha;
    // Gradients computed from the pre-projection positions.
    let grads: Vec<Vec2> = (0..n)
        .map(|k| {
            let next = b.x[b.boundary[(k + 1) % n] as usize];
            let prev = b.x[b.boundary[(k + n - 1) % n] as usize];
            let d = next - prev;
            Vec2::new(d.y, -d.x) * 0.5
        })
        .collect();
    for (k, g) in grads.iter().enumerate() {
        denom += b.w[b.boundary[k] as usize] * g.length_squared();
    }
    if denom < 1e-12 {
        return;
    }
    let dl = -c / denom;
    for (k, g) in grads.iter().enumerate() {
        let i = b.boundary[k] as usize;
        b.x[i] += *g * (dl * b.w[i]);
    }
}

fn shape_match(b: &mut Body, alpha: f32) {
    let n = b.x.len();
    let mut mass = 0.0;
    let mut c = Vec2::ZERO;
    for i in 0..n {
        let m = if b.base_w[i] > 0.0 { 1.0 / b.base_w[i] } else { 1.0 };
        c += b.x[i] * m;
        mass += m;
    }
    if mass <= 0.0 {
        return;
    }
    c /= mass;
    let mut s_dot = 0.0;
    let mut s_cross = 0.0;
    for i in 0..n {
        let m = if b.base_w[i] > 0.0 { 1.0 / b.base_w[i] } else { 1.0 };
        let r = b.rest[i];
        let q = b.x[i] - c;
        s_dot += m * r.dot(q);
        s_cross += m * r.perp_dot(q);
    }
    let rot = Vec2::new(s_dot, s_cross).normalize_or(Vec2::X);
    let scale = b.rest_scale;
    for i in 0..n {
        let w = b.w[i];
        if w == 0.0 {
            continue;
        }
        let g = rot.rotate(b.rest[i] * scale);
        let goal = c + g * b.squash;
        let k = w / (w + alpha);
        let xi = b.x[i];
        b.x[i] = xi + (goal - xi) * k;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn area_gradient_matches_finite_difference() {
        let (p0, p1, p2) = (Vec2::new(0.1, 0.2), Vec2::new(3.0, 0.5), Vec2::new(1.0, 2.5));
        let area = |a: Vec2, b: Vec2, c: Vec2| 0.5 * (b - a).perp_dot(c - a);
        let g0 = grad_area(p1, p2);
        let eps = 1e-3;
        let fd = Vec2::new(
            (area(p0 + Vec2::X * eps, p1, p2) - area(p0 - Vec2::X * eps, p1, p2)) / (2.0 * eps),
            (area(p0 + Vec2::Y * eps, p1, p2) - area(p0 - Vec2::Y * eps, p1, p2)) / (2.0 * eps),
        );
        assert!((g0 - fd).length() < 1e-3, "{g0} vs {fd}");
    }
}
