// Shape-matching helpers. Direct port of src/physics/shapeMatching.ts.
//
// The "average angle" computation is the only consumer of atan2 in the
// sim; it folds per-particle angles via wrap-to-[-π, π] before averaging,
// then synthesizes a Transform2D via sin/cos.

use crate::fx::{Fx, FxVec2};
use crate::math::{atan2_fx, cos_fx, sin_fx, FX_PI, FX_TAU};
use crate::types::Transform2D;

const EPS_SQ: Fx = Fx::from_raw(1 << 8); // ~6e-8, mirrors TS 1e-7 squared bound

pub fn centroid_from_indices(pos: &[FxVec2], indices: &[usize]) -> FxVec2 {
    if indices.is_empty() {
        return FxVec2::ZERO;
    }
    let mut c = FxVec2::ZERO;
    for &i in indices {
        c = c.add(pos[i]);
    }
    // Divide by count: build the inverse count as an Fx.
    let inv = Fx::ONE / Fx::from_int(indices.len() as i32);
    c.scale(inv)
}

pub fn average_angle(
    rest_local: &[FxVec2],
    pos: &[FxVec2],
    indices: &[usize],
    center: FxVec2,
) -> Fx {
    let mut sum = Fx::ZERO;
    let mut count = 0i32;
    for k in 0..indices.len() {
        let li = rest_local[k];
        if li.length_squared() < EPS_SQ { continue; }
        let pi = pos[indices[k]].sub(center);
        if pi.length_squared() < EPS_SQ { continue; }
        let a_rest = atan2_fx(li.y, li.x);
        let a_cur = atan2_fx(pi.y, pi.x);
        let mut diff = a_cur - a_rest;
        // Wrap to [-π, π]
        let pi_raw = Fx::from_raw(FX_PI);
        let tau_raw = Fx::from_raw(FX_TAU);
        diff = diff + pi_raw;
        // ((diff % TAU) + TAU) % TAU
        diff = Fx::from_raw(diff.raw().rem_euclid(tau_raw.raw()));
        diff = diff - pi_raw;
        sum += diff;
        count += 1;
    }
    if count > 0 {
        sum / Fx::from_int(count)
    } else {
        Fx::ZERO
    }
}

pub fn frame_transform(center: FxVec2, angle: Fx) -> Transform2D {
    Transform2D {
        cos: cos_fx(angle),
        sin: sin_fx(angle),
        tx: center.x,
        ty: center.y,
    }
}

pub fn apply_transform(t: Transform2D, v: FxVec2) -> FxVec2 {
    FxVec2::new(
        t.cos * v.x - t.sin * v.y + t.tx,
        t.sin * v.x + t.cos * v.y + t.ty,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(n: i32) -> Fx { Fx::from_int(n) }
    fn v(x: i32, y: i32) -> FxVec2 { FxVec2::new(fx(x), fx(y)) }

    #[test]
    fn centroid_of_square_at_origin() {
        let pts = vec![v(-1,-1), v(1,-1), v(1,1), v(-1,1)];
        let c = centroid_from_indices(&pts, &[0,1,2,3]);
        assert_eq!(c, FxVec2::ZERO);
    }

    #[test]
    fn transform_identity() {
        let t = frame_transform(v(0,0), Fx::ZERO);
        let p = apply_transform(t, v(3,4));
        // cos(0)=1, sin(0)=0 → identity (plus tx/ty=0)
        assert!((p.x.raw() - fx(3).raw()).abs() < 1 << 16);
        assert!((p.y.raw() - fx(4).raw()).abs() < 1 << 16);
    }

    #[test]
    fn average_angle_zero_for_identical_rest() {
        // If the live positions match the rest layout exactly (relative to
        // the centroid), the average angle should be ~0.
        let rest = vec![v(1,0), v(0,1), v(-1,0), v(0,-1)];
        let center = FxVec2::ZERO;
        let pos: Vec<FxVec2> = rest.iter().map(|p| p.add(center)).collect();
        let a = average_angle(&rest, &pos, &[0,1,2,3], center);
        assert!(a.raw().abs() < 1 << 16, "expected near zero, got raw {}", a.raw());
    }
}
