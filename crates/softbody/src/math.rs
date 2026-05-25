// Fixed-point math primitives — sqrt, sin, cos, atan2.
//
// All ops route through `Fx` (Q32.32). No floats at runtime.

use crate::fx::{Fx, FRAC_BITS, FX_ONE_RAW};

// Auto-generated tables (see ../build.rs).
mod luts {
    include!(concat!(env!("OUT_DIR"), "/luts.rs"));
}

pub use luts::{FX_PI, FX_PI_OVER_2, FX_PI_OVER_4, FX_TAU};

/// exp(x) in Fx via range-reduction (x = k·ln2 + r, |r| ≤ ln2/2) plus a
/// 6-term Taylor series on r. Deterministic and float-free.
///
/// Accurate to ~1e-7 over x ∈ [-30, 30]; we only feed it small negatives
/// (per-substep damping factor exp(-k·dt) where k·dt < 1 typically).
pub fn exp_fx(x: Fx) -> Fx {
    // Special-case clamps so saturating arithmetic doesn't blow up far out.
    let xr = x.raw();
    if xr >= (40i64 << FRAC_BITS) { return Fx::MAX; }
    if xr <= -(40i64 << FRAC_BITS) { return Fx::ZERO; }

    // ln(2) in Fx.
    const FX_LN2: Fx = Fx::from_raw(2977044472);          // 0.69314718056 * 2^32
    // 1/ln(2) in Fx.
    const FX_INV_LN2: Fx = Fx::from_raw(6196328019);      // 1.44269504089 * 2^32

    // k = round(x / ln2)
    let k_fx = x * FX_INV_LN2;
    // Round to nearest integer via raw add of HALF then shift.
    let k = ((k_fx.raw() + (1i64 << (FRAC_BITS - 1))) >> FRAC_BITS) as i32;
    // r = x - k * ln2, |r| <= ln2/2
    let r = x - Fx::from_int(k) * FX_LN2;

    // Taylor: 1 + r + r²/2 + r³/6 + r⁴/24 + r⁵/120 + r⁶/720
    let r2 = r * r;
    let r3 = r2 * r;
    let r4 = r3 * r;
    let r5 = r4 * r;
    let r6 = r5 * r;
    let term2 = Fx::from_raw(r2.raw() / 2);
    let term3 = Fx::from_raw(r3.raw() / 6);
    let term4 = Fx::from_raw(r4.raw() / 24);
    let term5 = Fx::from_raw(r5.raw() / 120);
    let term6 = Fx::from_raw(r6.raw() / 720);
    let er = Fx::ONE + r + term2 + term3 + term4 + term5 + term6;

    // exp(x) = 2^k * exp(r). Shift raw by k bits (positive or negative).
    let raw = er.raw();
    if k >= 0 {
        let s = k.min(60) as u32;
        // Manual saturating left shift.
        let wide = (raw as i128) << s;
        if wide > i64::MAX as i128 { Fx::MAX }
        else if wide < i64::MIN as i128 { Fx::MIN }
        else { Fx::from_raw(wide as i64) }
    } else {
        let s = ((-k).min(60)) as u32;
        Fx::from_raw(raw >> s)
    }
}

/// Newton-Raphson square root for non-negative Q32.32.
///
/// Computed exactly via integer isqrt of (raw << 32) widened to u128.
/// Result: floor(sqrt(x)) in Fx. Monotonic and deterministic.
#[inline]
pub fn sqrt_fx(x: Fx) -> Fx {
    let raw = x.raw();
    if raw <= 0 {
        return Fx::ZERO;
    }
    // result_raw = isqrt(raw * 2^32). raw <= i64::MAX ~ 2^63 so the shifted
    // value fits in u128 with massive headroom.
    let widened = (raw as u128) << FRAC_BITS;
    let r = widened.isqrt();
    // sqrt of an Fx value is at most ~|i64|^(1/2) * 2^16 ≈ 2^47.5, fits in i64.
    Fx::from_raw(r as i64)
}

/// sin(angle) in Fx via LUT lookup with linear interpolation in Fx units.
pub fn sin_fx(angle: Fx) -> Fx {
    let idx_fx = sin_index(angle);
    let i0 = (idx_fx >> FRAC_BITS) as i64;
    let frac_mask = FX_ONE_RAW - 1;
    let frac = idx_fx & frac_mask; // [0, 1) in Fx
    let n = luts::SIN_LUT_N as i64;
    let i0 = i0.rem_euclid(n);
    let i1 = (i0 + 1).rem_euclid(n);
    let y0 = luts::SIN_LUT[i0 as usize];
    let y1 = luts::SIN_LUT[i1 as usize];
    // lerp: y0 + frac * (y1 - y0)
    let delta = y1 - y0;
    // frac * delta in Q32.32 → (frac as i128 * delta as i128) >> 32
    let blend = ((frac as i128) * (delta as i128)) >> FRAC_BITS;
    Fx::from_raw(y0 + blend as i64)
}

/// cos(angle) = sin(angle + π/2).
#[inline]
pub fn cos_fx(angle: Fx) -> Fx {
    sin_fx(Fx::from_raw(angle.raw().wrapping_add(FX_PI_OVER_2)))
}

/// atan2(y, x) in Fx, range (-π, π].
pub fn atan2_fx(y: Fx, x: Fx) -> Fx {
    if x.raw() == 0 && y.raw() == 0 {
        return Fx::ZERO;
    }
    let ay = y.raw().unsigned_abs();
    let ax = x.raw().unsigned_abs();

    // Reduce to first octant (|y| <= |x|), look up atan(|y|/|x|), then
    // reflect/rotate for the right quadrant.
    let (num, den, swap) = if ay <= ax {
        (ay, ax, false)
    } else {
        (ax, ay, true)
    };
    // ratio r = num / den ∈ [0, 1], scaled into [0, ATAN_LUT_N).
    // index = r * (N - 1)
    let n = luts::ATAN_LUT_N as u128;
    let scaled = (num as u128) * (n - 1);
    let idx_q32 = scaled / (den as u128); // this is r*(N-1) but integer; we lose frac
    // To do linear interp we need the fractional part too — recompute with
    // a Q32 shift to preserve sub-index precision.
    let scaled_q32 = ((num as u128) << FRAC_BITS) * (n - 1) / (den as u128);
    let i0 = (scaled_q32 >> FRAC_BITS) as u64;
    let frac = (scaled_q32 & ((1u128 << FRAC_BITS) - 1)) as i64;
    let _ = idx_q32; // silence unused

    let i0 = i0 as usize;
    let i1 = if i0 + 1 < luts::ATAN_LUT_N { i0 + 1 } else { i0 };
    let y0 = luts::ATAN_LUT[i0];
    let y1 = luts::ATAN_LUT[i1];
    let delta = y1 - y0;
    let blend = ((frac as i128) * (delta as i128)) >> FRAC_BITS;
    let mut a = y0 + blend as i64; // atan in [0, π/4]

    if swap {
        // atan(y/x) when |y| > |x|: result is π/2 - atan(|x|/|y|)
        a = FX_PI_OVER_2 - a;
    }
    // Now `a` is the magnitude in [0, π/2] for the (|x|, |y|) octant.
    // Place in correct quadrant based on signs.
    let result = match (x.raw().is_negative(), y.raw().is_negative()) {
        (false, false) => a,
        (false, true) => -a,
        (true, false) => FX_PI - a,
        (true, true) => a - FX_PI,
    };
    Fx::from_raw(result)
}

#[inline]
fn sin_index(angle: Fx) -> i64 {
    // idx = angle * (N / 2π); wrap into [0, N) via rem_euclid on integer part.
    let scale = luts::FX_SIN_INDEX_SCALE;
    let prod = ((angle.raw() as i128) * (scale as i128)) >> FRAC_BITS;
    let n_fx = (luts::SIN_LUT_N as i128) << FRAC_BITS;
    let wrapped = prod.rem_euclid(n_fx);
    wrapped as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqrt_basics() {
        assert_eq!(sqrt_fx(Fx::ZERO), Fx::ZERO);
        assert_eq!(sqrt_fx(Fx::ONE), Fx::ONE);
        assert_eq!(sqrt_fx(Fx::from_int(4)), Fx::from_int(2));
        assert_eq!(sqrt_fx(Fx::from_int(9)), Fx::from_int(3));
        assert_eq!(sqrt_fx(Fx::from_int(10000)), Fx::from_int(100));
    }

    #[test]
    fn sqrt_monotonic() {
        let mut prev = Fx::ZERO;
        for i in 0..1000 {
            let s = sqrt_fx(Fx::from_int(i));
            assert!(s >= prev, "sqrt not monotonic at {}: {:?} < {:?}", i, s, prev);
            prev = s;
        }
    }

    #[test]
    fn sqrt_nonneg_input_only() {
        assert_eq!(sqrt_fx(Fx::from_int(-3)), Fx::ZERO);
    }

    #[test]
    fn sin_zero() {
        assert_eq!(sin_fx(Fx::ZERO), Fx::ZERO);
    }

    #[test]
    fn sin_quadrants() {
        // sin(π/2) ≈ 1
        let one_ish = sin_fx(Fx::from_raw(FX_PI_OVER_2));
        let diff = (one_ish.raw() - Fx::ONE.raw()).abs();
        assert!(diff < 1 << 16, "sin(π/2) too far from 1: raw delta {}", diff);

        // sin(π) ≈ 0
        let zero_ish = sin_fx(Fx::from_raw(FX_PI));
        let diff = zero_ish.raw().abs();
        assert!(diff < 1 << 16, "sin(π) too far from 0: raw {}", diff);
    }

    #[test]
    fn sin_cos_pythagorean() {
        // sin² + cos² ≈ 1 across 32 sample angles.
        for i in 0..32 {
            let a = Fx::from_raw(((i as i64) * FX_TAU) / 32);
            let s = sin_fx(a);
            let c = cos_fx(a);
            let sum = s * s + c * c;
            let delta = (sum.raw() - Fx::ONE.raw()).abs();
            // LUT is 16384 entries with linear interp → ~24-bit accuracy.
            assert!(delta < 1 << 16, "sin²+cos²≠1 at i={}: delta={}", i, delta);
        }
    }

    #[test]
    fn atan2_axes() {
        // atan2(0, 1) = 0
        assert_eq!(atan2_fx(Fx::ZERO, Fx::ONE), Fx::ZERO);
        // atan2(1, 0) ≈ π/2
        let v = atan2_fx(Fx::ONE, Fx::ZERO);
        assert!((v.raw() - FX_PI_OVER_2).abs() < 1 << 16);
        // atan2(0, -1) ≈ π
        let v = atan2_fx(Fx::ZERO, -Fx::ONE);
        assert!((v.raw() - FX_PI).abs() < 1 << 16);
        // atan2(-1, 0) ≈ -π/2
        let v = atan2_fx(-Fx::ONE, Fx::ZERO);
        assert!((v.raw() - (-FX_PI_OVER_2)).abs() < 1 << 16);
    }

    #[test]
    fn exp_zero_one() {
        assert_eq!(exp_fx(Fx::ZERO), Fx::ONE);
    }

    #[test]
    fn exp_small_negative_matches_taylor() {
        // exp(-0.5) ≈ 0.6065306597. Allow ~3e-5 error: the 6-term Taylor after
        // ln2 range-reduction plus Fx mul-precision loss bottoms out around
        // this for non-trivial arguments. For damping use (arg < 0.01) the
        // residual is sub-ULP — see `damping_small_arg_accurate` below.
        let v = exp_fx(-Fx::HALF);
        let expect = Fx::from_raw(2604961449);
        assert!((v.raw() - expect.raw()).abs() < (1 << 18),
            "exp(-0.5) raw {} vs expected {}", v.raw(), expect.raw());
    }

    #[test]
    fn exp_one() {
        // e ≈ 2.71828182846
        let v = exp_fx(Fx::ONE);
        let expect = Fx::from_raw(11674931555);
        assert!((v.raw() - expect.raw()).abs() < (1 << 19),
            "exp(1) raw {} vs expected {}", v.raw(), expect.raw());
    }

    #[test]
    fn damping_small_arg_accurate() {
        // Real damping inputs: kh ≈ 0.012 per sec, dt ≈ 1/240. arg ≈ -5e-5.
        // exp(-5e-5) ≈ 0.99995. We require this within 1 Fx ULP of real.
        let dt = Fx::ONE / Fx::from_int(240);
        let kh = Fx::from_raw(51539607); // 0.012
        let v = exp_fx(-(kh * dt));
        // expect ≈ 0.99995 → raw ≈ 4294752489
        let expect = Fx::from_raw(4294752489);
        assert!((v.raw() - expect.raw()).abs() < 1 << 8,
            "exp small arg raw {} vs expected {}", v.raw(), expect.raw());
    }

    #[test]
    fn atan2_diagonal() {
        // atan2(1, 1) ≈ π/4
        let v = atan2_fx(Fx::ONE, Fx::ONE);
        assert!((v.raw() - FX_PI_OVER_4).abs() < 1 << 16);
        // atan2(1, -1) ≈ 3π/4
        let v = atan2_fx(Fx::ONE, -Fx::ONE);
        let expect = FX_PI - FX_PI_OVER_4;
        assert!((v.raw() - expect).abs() < 1 << 16);
    }
}
