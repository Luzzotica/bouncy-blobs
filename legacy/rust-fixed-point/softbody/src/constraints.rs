// Positional constraint solvers. Direct port of src/physics/constraints.ts.

use crate::fx::{Fx, FxVec2};

const EPS: Fx = Fx::from_raw(1 << 8); // ~6e-8, mirrors TS 1e-7

#[inline]
fn inv_mass(inv_mass: &[Fx], i: usize) -> Fx {
    if i < inv_mass.len() { inv_mass[i] } else { Fx::ZERO }
}

pub fn solve_weld(pos: &mut [FxVec2], inv_mass_arr: &[Fx], i: usize, j: usize) {
    let wi = inv_mass(inv_mass_arr, i);
    let wj = inv_mass(inv_mass_arr, j);
    let w_sum = wi + wj;
    if w_sum < EPS { return; }
    // PBD distance constraint — each particle moves by its OWN inverse-mass
    // fraction of the correction. With i anchored (wi=0), i stays put and
    // j absorbs the full correction; vice-versa for j anchored. The TS
    // sim had `corr.scale(wj)` / `corr.scale(wi)` (swapped weights), which
    // moved the anchored particle by the full delta and left the free
    // particle in place — the root cause of chains "not working" in TS.
    let delta = pos[j].sub(pos[i]);
    let corr = delta.scale(Fx::ONE / w_sum);
    pos[i] = pos[i].add(corr.scale(wi));
    pos[j] = pos[j].sub(corr.scale(wj));
}

pub fn solve_weighted_anchor(
    pos: &mut [FxVec2], inv_mass_arr: &[Fx],
    indices_a: &[usize], weights_a: &[Fx],
    indices_b: &[usize], weights_b: &[Fx],
) {
    let mut pa = FxVec2::ZERO;
    let mut wa_sum = Fx::ZERO;
    for k in 0..indices_a.len() {
        let w = weights_a[k];
        pa = pa.add(pos[indices_a[k]].scale(w));
        wa_sum += w;
    }
    let mut pb = FxVec2::ZERO;
    let mut wb_sum = Fx::ZERO;
    for k in 0..indices_b.len() {
        let w = weights_b[k];
        pb = pb.add(pos[indices_b[k]].scale(w));
        wb_sum += w;
    }
    if wa_sum < EPS || wb_sum < EPS { return; }
    pa = pa.scale(Fx::ONE / wa_sum);
    pb = pb.scale(Fx::ONE / wb_sum);
    let delta = pb.sub(pa);

    let mut w_total = Fx::ZERO;
    for k in 0..indices_a.len() {
        let w = weights_a[k] / wa_sum;
        w_total += inv_mass(inv_mass_arr, indices_a[k]) * w * w;
    }
    for k in 0..indices_b.len() {
        let w = weights_b[k] / wb_sum;
        w_total += inv_mass(inv_mass_arr, indices_b[k]) * w * w;
    }
    if w_total < EPS { return; }
    let corr = delta.scale(Fx::ONE / w_total);
    for k in 0..indices_a.len() {
        let idx = indices_a[k];
        let w = weights_a[k] / wa_sum;
        pos[idx] = pos[idx].add(corr.scale(inv_mass(inv_mass_arr, idx) * w));
    }
    for k in 0..indices_b.len() {
        let idx = indices_b[k];
        let w = weights_b[k] / wb_sum;
        pos[idx] = pos[idx].sub(corr.scale(inv_mass(inv_mass_arr, idx) * w));
    }
}

pub fn solve_distance_max(pos: &mut [FxVec2], inv_mass_arr: &[Fx], i: usize, j: usize, max_dist: Fx) {
    let d = pos[j].sub(pos[i]);
    let len = d.length();
    if len <= max_dist || len < EPS { return; }
    let n = d.scale(Fx::ONE / len);
    let overlap = len - max_dist;
    let wi = inv_mass(inv_mass_arr, i);
    let wj = inv_mass(inv_mass_arr, j);
    let w_sum = wi + wj;
    if w_sum < EPS { return; }
    // Each particle moves by its OWN inverse-mass fraction. See solve_weld
    // for the TS-bug story.
    let corr = overlap / w_sum;
    pos[i] = pos[i].add(n.scale(corr * wi));
    pos[j] = pos[j].sub(n.scale(corr * wj));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(n: i32) -> Fx { Fx::from_int(n) }
    fn v(x: i32, y: i32) -> FxVec2 { FxVec2::new(fx(x), fx(y)) }

    #[test]
    fn weld_pulls_two_equal_masses_together() {
        let mut p = vec![v(0,0), v(4,0)];
        let im = vec![Fx::ONE, Fx::ONE];
        solve_weld(&mut p, &im, 0, 1);
        // Equal masses meet at midpoint
        assert_eq!(p[0], v(2,0));
        assert_eq!(p[1], v(2,0));
    }

    fn approx_eq(a: FxVec2, b: FxVec2, tol_raw: i64) {
        assert!(
            (a.x.raw() - b.x.raw()).abs() <= tol_raw &&
            (a.y.raw() - b.y.raw()).abs() <= tol_raw,
            "approx_eq failed: {:?} vs {:?} (tol {})", a, b, tol_raw
        );
    }

    #[test]
    fn distance_max_clamps() {
        let mut p = vec![v(0,0), v(10,0)];
        let im = vec![Fx::ONE, Fx::ONE];
        solve_distance_max(&mut p, &im, 0, 1, fx(6));
        // 10 → 6, overshoot 4 split equally. Path divides by len=10 which
        // is inexact in Fx (1/10 has finite-precision representation);
        // tolerate ~ Fx ULP × overlap ≈ a few hundred ULPs.
        approx_eq(p[0], v(2,0), 1 << 8);
        approx_eq(p[1], v(8,0), 1 << 8);
    }

    #[test]
    fn anchor_does_not_move_under_weld() {
        // i is anchored (mass=0 → invMass=0), j is free with invMass=1.
        // The weld should pull j to meet the anchor, leaving the anchor
        // in place. Previously (TS-style swapped weights) the anchor
        // moved to meet j, which is what made chains "not work".
        let mut p = vec![v(0,0), v(10,0)];
        let im = vec![Fx::ZERO, Fx::ONE];
        solve_weld(&mut p, &im, 0, 1);
        assert_eq!(p[0], v(0,0), "anchor moved: {:?}", p[0]);
        assert_eq!(p[1], v(0,0), "free particle didn't meet anchor: {:?}", p[1]);
    }

    #[test]
    fn anchor_does_not_move_under_distance_max() {
        // Anchored i + free j, stretched past the max — only j should
        // pull in.
        let mut p = vec![v(0,0), v(10,0)];
        let im = vec![Fx::ZERO, Fx::ONE];
        solve_distance_max(&mut p, &im, 0, 1, fx(6));
        assert_eq!(p[0], v(0,0), "anchor moved: {:?}", p[0]);
        approx_eq(p[1], v(6,0), 1 << 8);
    }

    #[test]
    fn distance_max_skips_when_under() {
        let mut p = vec![v(0,0), v(3,0)];
        let im = vec![Fx::ONE, Fx::ONE];
        solve_distance_max(&mut p, &im, 0, 1, fx(6));
        assert_eq!(p[0], v(0,0));
        assert_eq!(p[1], v(3,0));
    }
}
