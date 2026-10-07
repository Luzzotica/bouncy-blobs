// Polygon collision primitives. Direct port of src/physics/collision.ts.
//
// All ops in Fx (Q32.32). Where the TS source uses an EPS of 1e-6 we use
// `EPS_LIN_SQ` (squared) and `EPS_LIN`; chosen as a small number of ULPs
// so that the behavioral threshold is comparable but expressed in our
// units (1 Fx ULP = 1/2^32 ≈ 2.3e-10, so 1e-6 ≈ 4295 ULPs).

use crate::fx::{Fx, FxVec2};
use crate::types::Aabb;

/// Linear epsilon (~4.3e-6 in world units).
pub const EPS_LIN: Fx = Fx::from_raw(1 << 14);
/// Squared linear epsilon (~1.8e-11) — used for length-squared comparisons.
pub const EPS_LIN_SQ: Fx = Fx::from_raw(1 << 4);

pub fn polygon_aabb(poly: &[FxVec2]) -> Aabb {
    if poly.is_empty() {
        return Aabb::default();
    }
    let mut min_x = poly[0].x;
    let mut max_x = poly[0].x;
    let mut min_y = poly[0].y;
    let mut max_y = poly[0].y;
    for p in &poly[1..] {
        if p.x < min_x { min_x = p.x; }
        if p.x > max_x { max_x = p.x; }
        if p.y < min_y { min_y = p.y; }
        if p.y > max_y { max_y = p.y; }
    }
    Aabb { min_x, min_y, max_x, max_y }
}

#[inline]
pub fn aabb_overlap(a: Aabb, b: Aabb) -> bool {
    a.min_x < b.max_x && a.max_x > b.min_x && a.min_y < b.max_y && a.max_y > b.min_y
}

/// Standard ray-cast even-odd point-in-polygon test, ported verbatim.
pub fn is_point_in_polygon(point: FxVec2, polygon: &[FxVec2]) -> bool {
    let n = polygon.len();
    if n < 3 { return false; }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let pi = polygon[i];
        let pj = polygon[j];
        let cond_y = (pi.y > point.y) != (pj.y > point.y);
        if cond_y {
            // x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y) + pi.x
            let dy = pj.y - pi.y;
            if !dy.is_zero() {
                let lhs = point.x - pi.x;
                let rhs = (pj.x - pi.x) * (point.y - pi.y) / dy;
                if lhs < rhs {
                    inside = !inside;
                }
            }
        }
        j = i;
    }
    inside
}

pub fn closest_point_on_segment(p: FxVec2, a: FxVec2, b: FxVec2) -> FxVec2 {
    let ab = b.sub(a);
    let ab_len_sq = ab.length_squared();
    if ab_len_sq < EPS_LIN_SQ {
        return a;
    }
    let mut t = p.sub(a).dot(ab) / ab_len_sq;
    if t < Fx::ZERO { t = Fx::ZERO; }
    if t > Fx::ONE  { t = Fx::ONE;  }
    a.add(ab.scale(t))
}

#[derive(Clone, Debug)]
pub struct ClosestPointResult {
    pub closest: FxVec2,
    pub edge_i: usize,
    pub normal: FxVec2,
    pub a: FxVec2,
    pub b: FxVec2,
    pub edge_dir: FxVec2,
    pub edge_len: Fx,
}

pub fn closest_point_on_polygon_boundary(point: FxVec2, polygon: &[FxVec2]) -> ClosestPointResult {
    let n = polygon.len();
    debug_assert!(n >= 2, "closest_point_on_polygon_boundary: polygon < 2 verts");

    let mut best_dist = Fx::MAX;
    let mut best_closest = FxVec2::ZERO;
    let mut best_i: usize = 0;
    for i in 0..n {
        let a = polygon[i];
        let b = polygon[(i + 1) % n];
        let c = closest_point_on_segment(point, a, b);
        let d = point.sub(c).length_squared();
        if d < best_dist {
            best_dist = d;
            best_closest = c;
            best_i = i;
        }
    }
    let a = polygon[best_i];
    let b = polygon[(best_i + 1) % n];
    let edge = b.sub(a);
    let len_e = edge.length();
    let mut edge_dir = if len_e > EPS_LIN {
        edge.scale(Fx::ONE / len_e)
    } else {
        FxVec2::new(Fx::ONE, Fx::ZERO)
    };
    // Normal = (tangent.y, -tangent.x), normalized.
    let mut normal = FxVec2::new(edge_dir.y, -edge_dir.x).normalize();
    let from_c_to_p = point.sub(best_closest);
    if from_c_to_p.dot(normal) < Fx::ZERO {
        normal = normal.neg();
    }
    // If the closest point lands on a vertex, the picked edge tangent is
    // arbitrary — use the radial direction (corner→point) instead, so
    // tangential friction doesn't pin the particle.
    let at_vertex =
        best_closest.sub(a).length_squared() < EPS_LIN_SQ
        || best_closest.sub(b).length_squared() < EPS_LIN_SQ;
    if at_vertex && from_c_to_p.length_squared() > EPS_LIN_SQ {
        normal = from_c_to_p.normalize();
        edge_dir = FxVec2::new(-normal.y, normal.x);
    }
    ClosestPointResult { closest: best_closest, edge_i: best_i, normal, a, b, edge_dir, edge_len: len_e }
}

pub struct EdgeWeights { pub wb: Fx, pub wc: Fx }

pub fn edge_vertex_weights(point: FxVec2, a: FxVec2, b: FxVec2) -> EdgeWeights {
    let ab = b.sub(a);
    let lab_sq = ab.length_squared();
    if lab_sq < EPS_LIN_SQ {
        return EdgeWeights { wb: Fx::HALF, wc: Fx::HALF };
    }
    let mut t = point.sub(a).dot(ab) / lab_sq;
    if t < Fx::ZERO { t = Fx::ZERO; }
    if t > Fx::ONE  { t = Fx::ONE;  }
    EdgeWeights { wb: Fx::ONE - t, wc: t }
}

pub fn signed_area_polygon(poly: &[FxVec2]) -> Fx {
    let mut a = Fx::ZERO;
    let n = poly.len();
    for i in 0..n {
        let j = (i + 1) % n;
        a = a + (poly[i].x * poly[j].y - poly[j].x * poly[i].y);
    }
    Fx::from_raw(a.raw() / 2) // multiply by 0.5
}

/// Three-body collision response: normal impulse + Coulomb friction
/// between a query particle (a) and two polygon-edge vertices (b, c)
/// weighted by (wb, wc). Returns the new velocities.
///
/// `mu` ≤ 0 disables friction. `resting_load` is the gravity load the
/// surface must support (mass·g·dt·support·scale) and lets friction act
/// when there's no inbound normal velocity (e.g. blob sitting on a
/// soft platform's slope).
#[allow(clippy::too_many_arguments)]
pub fn resolve_three_body_velocity(
    va: FxVec2, ma: Fx,
    vb: FxVec2, mb: Fx,
    vc: FxVec2, mc: Fx,
    normal: FxVec2,
    wb: Fx, wc: Fx,
    restitution: Fx,
    mu: Fx,
    tangent: FxVec2,
    friction_impulse_scale: Fx,
    resting_load: Fx,
) -> (FxVec2, FxVec2, FxVec2) {
    let n = normal.normalize();
    let v_rel_n = n.dot(va) - (wb * n.dot(vb) + wc * n.dot(vc));

    let mut inv_sum = Fx::ZERO;
    if ma > EPS_LIN { inv_sum += Fx::ONE / ma; }
    if mb > EPS_LIN { inv_sum += (wb * wb) / mb; }
    if mc > EPS_LIN { inv_sum += (wc * wc) / mc; }
    if inv_sum < EPS_LIN { return (va, vb, vc); }

    let mut va_new = va;
    let mut vb_new = vb;
    let mut vc_new = vc;
    let mut j = Fx::ZERO;
    if v_rel_n < Fx::ZERO {
        j = (-(Fx::ONE + restitution) * v_rel_n) / inv_sum;
        va_new = va.add(n.scale(if ma > EPS_LIN { j / ma } else { Fx::ZERO }));
        vb_new = vb.sub(n.scale(if mb > EPS_LIN { (j * wb) / mb } else { Fx::ZERO }));
        vc_new = vc.sub(n.scale(if mc > EPS_LIN { (j * wc) / mc } else { Fx::ZERO }));
    } else if resting_load <= EPS_LIN {
        return (va, vb, vc);
    }

    if mu <= EPS_LIN || tangent.length_squared() < EPS_LIN_SQ {
        return (va_new, vb_new, vc_new);
    }

    let mut t = tangent.normalize();
    // If the supplied tangent is mostly along the normal (rare numerical case),
    // synthesize one from the normal.
    let along = t.dot(n).abs();
    let small = Fx::from_raw(FX_FIVE_HUNDREDTHS_RAW); // 0.05
    if along > small {
        t = FxVec2::new(-n.y, n.x).normalize();
    }

    let v_rel_t = t.dot(va_new) - (wb * t.dot(vb_new) + wc * t.dot(vc_new));
    let min_tang = Fx::from_raw(FX_FORTY_TWO_HUNDREDTHS_RAW); // 0.42
    if v_rel_t.abs() < min_tang {
        return (va_new, vb_new, vc_new);
    }

    let jt_uncap = -v_rel_t / inv_sum;
    let jn_abs = j.abs().max(resting_load);
    let max_t = mu * jn_abs.max(EPS_LIN_SQ);
    let scale_clamped = friction_impulse_scale.max(Fx::ZERO).min(Fx::ONE);
    let mut jt = jt_uncap;
    if jt > max_t { jt = max_t; }
    if jt < -max_t { jt = -max_t; }
    jt = jt * scale_clamped;

    va_new = va_new.add(t.scale(if ma > EPS_LIN { jt / ma } else { Fx::ZERO }));
    vb_new = vb_new.sub(t.scale(if mb > EPS_LIN { (jt * wb) / mb } else { Fx::ZERO }));
    vc_new = vc_new.sub(t.scale(if mc > EPS_LIN { (jt * wc) / mc } else { Fx::ZERO }));
    (va_new, vb_new, vc_new)
}

// 0.05 = (5 * FX_ONE) / 100 — precomputed const-eval to keep this in the const path.
const FX_FIVE_HUNDREDTHS_RAW: i64 = (5 * (1i64 << 32)) / 100;
const FX_FORTY_TWO_HUNDREDTHS_RAW: i64 = (42 * (1i64 << 32)) / 100;

// =====================================================================
// Segment-segment intersection, fixed-point edition.
//
// Solves the parametric system
//      p1 + t * (p2 - p1) = p3 + u * (p4 - p3)
// for (t, u). The hit is "real" iff t ∈ [0,1] AND u ∈ [0,1].
//
// Math, with d1 = p2-p1, d2 = p4-p3, d3 = p3-p1:
//      cross = d1.x*d2.y - d1.y*d2.x       (parallelism: 0 ⇒ parallel/colinear)
//      t = (d3.x*d2.y - d3.y*d2.x) / cross
//      u = (d3.x*d1.y - d3.y*d1.x) / cross
//
// Why i128 everywhere here:
//   Each d-component is Q32.32 stored in i64.
//   A product like d1.x * d2.y conceptually multiplies two Q32.32 numbers.
//   In raw integer terms the product spans up to (i64::MAX)² ≈ 2^126 — way
//   beyond i64. We widen to i128 to keep the full result, then divide.
//   `cross`, `t_num`, `u_num` are all Q64.64 raw values living in i128.
//
// Why the ε guard on cross:
//   If the two segments are (nearly) parallel, `cross` is near zero and the
//   division t = t_num / cross becomes catastrophic — the result saturates
//   and a tangent contact would teleport a particle to (≈MAX, ≈MAX). The
//   guard `|cross_raw_q64| < CROSS_EPS_RAW` rejects those as "no intersection",
//   matching the TS `Math.abs(cross) < 1e-10` check translated into our raw
//   Q64.64 units (real_cross × 2^64).
//
// Coordinate-range assumption:
//   We shift `t_num` left by 32 bits to materialize the result in Q32.32. For
//   that to fit in i128, the inputs need to keep their products comfortably
//   below 2^95 (the input squared shifted left 32). With our world coords
//   under ~16k, raw values are ≤ 2^46; squared ≤ 2^92; shifted left 32 ≤ 2^124.
//   Comfortably inside the i128 envelope. A `debug_assert` guards regressions.
// =====================================================================

/// Cross-product magnitude (in Q64.64 raw i128 units) below which two
/// segments are treated as parallel. Real-units equivalent: ~5.4e-10.
///
/// TS source uses `1e-10`. We're slightly more permissive (2^31 ≈ 2.15e9
/// raw ≈ 1.17e-10 real) to absorb 1–2 ULPs of mul-precision fuzz in the
/// cross product itself.
pub const CROSS_EPS_RAW: i128 = 1i128 << 31;

/// Segment intersection with parametric `t` on the first segment.
/// Returns `(t, intersection_point)` on hit, `None` otherwise.
pub fn segment_intersection_t(
    p1: FxVec2, p2: FxVec2, p3: FxVec2, p4: FxVec2,
) -> Option<(Fx, FxVec2)> {
    let d1x = (p2.x - p1.x).raw() as i128;
    let d1y = (p2.y - p1.y).raw() as i128;
    let d2x = (p4.x - p3.x).raw() as i128;
    let d2y = (p4.y - p3.y).raw() as i128;

    let cross = d1x * d2y - d1y * d2x;
    if cross.unsigned_abs() < CROSS_EPS_RAW as u128 {
        return None;
    }

    let d3x = (p3.x - p1.x).raw() as i128;
    let d3y = (p3.y - p1.y).raw() as i128;
    let t_num = d3x * d2y - d3y * d2x;
    let u_num = d3x * d1y - d3y * d1x;

    // Materialize t and u in Q32.32 by shifting numerator left 32 before
    // dividing. The shift is the source of the coord-range assumption above.
    debug_assert!(t_num.checked_shl(32).is_some(), "segment intersect: t_num overflow");
    debug_assert!(u_num.checked_shl(32).is_some(), "segment intersect: u_num overflow");
    let t_q32 = (t_num << 32) / cross;
    let u_q32 = (u_num << 32) / cross;

    let one_q32: i128 = 1i128 << 32;
    if t_q32 < 0 || t_q32 > one_q32 { return None; }
    if u_q32 < 0 || u_q32 > one_q32 { return None; }

    let t = Fx::from_raw(t_q32 as i64);
    // point = p1 + d1 * t  (d1 components are raw Q32.32 ≤ i64::MAX in normal worlds)
    let d1x_fx = Fx::from_raw(d1x as i64);
    let d1y_fx = Fx::from_raw(d1y as i64);
    let point = FxVec2::new(p1.x + d1x_fx * t, p1.y + d1y_fx * t);
    Some((t, point))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx_int(n: i32) -> Fx { Fx::from_int(n) }
    fn v(x: i32, y: i32) -> FxVec2 { FxVec2::new(fx_int(x), fx_int(y)) }

    #[test]
    fn aabb_of_quad() {
        let poly = vec![v(0,0), v(10,0), v(10,5), v(0,5)];
        let a = polygon_aabb(&poly);
        assert_eq!(a.min_x.floor_to_i32(), 0);
        assert_eq!(a.min_y.floor_to_i32(), 0);
        assert_eq!(a.max_x.floor_to_i32(), 10);
        assert_eq!(a.max_y.floor_to_i32(), 5);
    }

    #[test]
    fn point_in_square() {
        let square = vec![v(0,0), v(10,0), v(10,10), v(0,10)];
        assert!(is_point_in_polygon(v(5,5), &square));
        assert!(!is_point_in_polygon(v(-1, 5), &square));
        assert!(!is_point_in_polygon(v(11, 5), &square));
    }

    fn approx_eq(a: FxVec2, b: FxVec2, tol_raw: i64) {
        assert!(
            (a.x.raw() - b.x.raw()).abs() <= tol_raw &&
            (a.y.raw() - b.y.raw()).abs() <= tol_raw,
            "approx_eq failed: {:?} vs {:?} (tol {})", a, b, tol_raw
        );
    }

    #[test]
    fn closest_on_segment_basic() {
        // segment (0,0)-(10,0), query (3,5) -> (3,0). t=0.3 is inexact in Fx
        // so allow a few ULPs of slop (≈ FX-rep error of 0.3 × |ab|).
        let c = closest_point_on_segment(v(3,5), v(0,0), v(10,0));
        approx_eq(c, v(3,0), 1 << 8);
        // clamped past end
        let c = closest_point_on_segment(v(15,5), v(0,0), v(10,0));
        assert_eq!(c, v(10,0));
    }

    #[test]
    fn segment_intersect_x_cross() {
        // Two segments forming an X through origin.
        let r = segment_intersection_t(v(-1,0), v(1,0), v(0,-1), v(0,1));
        let (t, p) = r.expect("should intersect");
        // t = 0.5 along (-1,0)..(1,0) → point at (0,0)
        assert!((t.raw() - Fx::HALF.raw()).abs() < (1 << 4));
        assert_eq!(p, FxVec2::ZERO);
    }

    #[test]
    fn segment_intersect_parallel_returns_none() {
        // Two parallel horizontal segments.
        let r = segment_intersection_t(v(0,0), v(10,0), v(0,5), v(10,5));
        assert!(r.is_none());
    }

    #[test]
    fn segment_intersect_outside_t_range() {
        // Cross point exists mathematically but lies past the end of seg 1.
        let r = segment_intersection_t(v(0,0), v(1,0), v(2,-1), v(2,1));
        assert!(r.is_none(), "intersection at x=2 is past seg 1's endpoint x=1");
    }

    #[test]
    fn signed_area_unit_square_ccw_is_one() {
        let square = vec![v(0,0), v(1,0), v(1,1), v(0,1)];
        assert_eq!(signed_area_polygon(&square), Fx::HALF * Fx::from_int(2));
    }
}
