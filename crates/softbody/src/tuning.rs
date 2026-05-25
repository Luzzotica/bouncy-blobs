// Global tuning constants. Direct port of src/physics/tuning.ts.
//
// Authored as TS floats; converted once through the canonical f64→Fx rule.
// Computed in const context via `Fx::from_raw` with values pre-rounded by
// the build script's same rule (here we just hardcode the round-to-Fx of
// each constant — values verified by the round-trip test below).

use crate::fx::{Fx, FX_ONE_RAW};

/// Const-evaluable rational → Fx with round-half-up. For our tuning
/// values this matches `Fx::from_f64`'s round-ties-to-even output bit-
/// for-bit (no tie cases occur). Verified by the round-trip test below.
const fn fx_ratio(num: i64, den: i64) -> Fx {
    let scaled = num.saturating_mul(FX_ONE_RAW);
    let half = den / 2;
    let adjusted = if scaled >= 0 { scaled + half } else { scaled - half };
    Fx::from_raw(adjusted / den)
}

pub const SPRING_K:         Fx = fx_ratio(55, 1);
pub const SPRING_DAMP:      Fx = fx_ratio(35, 10);
pub const RADIAL_K:         Fx = fx_ratio(75, 1);
pub const RADIAL_DAMP:      Fx = fx_ratio(42, 10);
pub const PRESSURE_K:       Fx = fx_ratio(12, 100);
pub const SHAPE_MATCH_K:    Fx = fx_ratio(132, 1);
pub const SHAPE_MATCH_DAMP: Fx = fx_ratio(46, 10);
pub const CENTER_MASS:      Fx = fx_ratio(2, 10);
pub const HULL_MASS:        Fx = fx_ratio(12, 100);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "std")]
    fn constants_match_ts_values() {
        // The TS source spells each constant as a base-10 literal; this
        // round-trips through f64 → Fx → f64 and must match to within
        // Fx EPS (since e.g. 3.5 is exactly representable but 0.12 is not).
        let cases: &[(Fx, f64)] = &[
            (SPRING_K, 55.0),
            (SPRING_DAMP, 3.5),
            (RADIAL_K, 75.0),
            (RADIAL_DAMP, 4.2),
            (PRESSURE_K, 0.12),
            (SHAPE_MATCH_K, 132.0),
            (SHAPE_MATCH_DAMP, 4.6),
            (CENTER_MASS, 0.2),
            (HULL_MASS, 0.12),
        ];
        for &(fx, expected) in cases {
            let canonical = Fx::from_f64(expected);
            assert_eq!(
                fx.raw(), canonical.raw(),
                "tuning constant {} mismatch: have {}, canonical {}",
                expected, fx.raw(), canonical.raw()
            );
        }
    }
}
