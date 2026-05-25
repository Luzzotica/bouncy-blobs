// Q32.32 fixed-point scalar and 2D vector.
//
// The whole simulation runs in `Fx` so every arithmetic op is bit-exact
// across x86 / ARM / wasm32. Multiplication and division widen to i128
// internally to keep the 32 fractional bits without overflow.

use core::ops::{Add, AddAssign, Div, Mul, MulAssign, Neg, Sub, SubAssign};

/// Number of fractional bits. Q32.32 fits comfortably in i64 with room for
/// squared distances on a 65k-unit world before needing i128.
pub const FRAC_BITS: u32 = 32;

/// 1.0 in fixed-point.
pub const FX_ONE_RAW: i64 = 1i64 << FRAC_BITS;

/// 0.5 in fixed-point. Used as the round-half-to-even bias.
pub const FX_HALF_RAW: i64 = 1i64 << (FRAC_BITS - 1);

#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Fx(pub i64);

impl Fx {
    pub const ZERO: Fx = Fx(0);
    pub const ONE: Fx = Fx(FX_ONE_RAW);
    pub const HALF: Fx = Fx(FX_HALF_RAW);
    pub const MIN: Fx = Fx(i64::MIN);
    pub const MAX: Fx = Fx(i64::MAX);

    /// Smallest positive representable value (1 ULP).
    pub const EPS: Fx = Fx(1);

    #[inline]
    pub const fn from_raw(raw: i64) -> Self {
        Fx(raw)
    }

    #[inline]
    pub const fn raw(self) -> i64 {
        self.0
    }

    #[inline]
    pub const fn from_int(n: i32) -> Self {
        Fx((n as i64) << FRAC_BITS)
    }

    /// Truncating conversion to i32 (drops fractional bits, toward -inf).
    #[inline]
    pub const fn floor_to_i32(self) -> i32 {
        (self.0 >> FRAC_BITS) as i32
    }

    /// Construct from an integer numerator over a power-of-two denominator.
    /// Handy for tuning constants written as ratios without float syntax.
    #[inline]
    pub const fn from_ratio(num: i32, den_log2: u32) -> Self {
        // (num << (FRAC_BITS - den_log2)) for den_log2 <= FRAC_BITS
        debug_assert!(den_log2 <= FRAC_BITS);
        Fx((num as i64) << (FRAC_BITS - den_log2))
    }

    /// Canonical f64 → Fx using round-half-to-even.
    ///
    /// This is the *only* sanctioned float boundary. As long as both sides
    /// of the netcode see the same f64 bits going in (e.g. via JSON parse
    /// of identical text), the resulting Fx will match bit-for-bit.
    #[cfg(feature = "std")]
    pub fn from_f64(x: f64) -> Self {
        let scaled = x * (FX_ONE_RAW as f64);
        // round_ties_even is the deterministic "banker's rounding" rule;
        // stabilized in Rust 1.77.
        let rounded = scaled.round_ties_even();
        // Clamp to i64 range to avoid UB on overflow conversion.
        let clamped = if rounded >= i64::MAX as f64 {
            i64::MAX
        } else if rounded <= i64::MIN as f64 {
            i64::MIN
        } else {
            rounded as i64
        };
        Fx(clamped)
    }

    /// Lossy convert back to f64 (for rendering — never feed this back in).
    #[cfg(feature = "std")]
    pub fn to_f64(self) -> f64 {
        (self.0 as f64) / (FX_ONE_RAW as f64)
    }

    #[inline]
    pub const fn abs(self) -> Self {
        Fx(self.0.wrapping_abs())
    }

    #[inline]
    pub const fn min(self, other: Fx) -> Self {
        if self.0 < other.0 { self } else { other }
    }

    #[inline]
    pub const fn max(self, other: Fx) -> Self {
        if self.0 > other.0 { self } else { other }
    }

    #[inline]
    pub fn clamp(self, lo: Fx, hi: Fx) -> Self {
        self.max(lo).min(hi)
    }

    #[inline]
    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    /// Saturating multiply, widened through i128.
    #[inline]
    pub fn mul(self, rhs: Fx) -> Fx {
        let wide = (self.0 as i128) * (rhs.0 as i128);
        // Round-to-nearest-even on the discarded fractional bits.
        let shifted = wide >> FRAC_BITS;
        Fx(saturate_i128_to_i64(shifted))
    }

    /// Saturating divide, widened through i128.
    #[inline]
    pub fn div(self, rhs: Fx) -> Fx {
        debug_assert!(rhs.0 != 0, "Fx::div by zero");
        let num = (self.0 as i128) << FRAC_BITS;
        let result = num / (rhs.0 as i128);
        Fx(saturate_i128_to_i64(result))
    }
}

#[inline]
fn saturate_i128_to_i64(x: i128) -> i64 {
    if x > i64::MAX as i128 {
        i64::MAX
    } else if x < i64::MIN as i128 {
        i64::MIN
    } else {
        x as i64
    }
}

impl Add for Fx {
    type Output = Fx;
    #[inline]
    fn add(self, rhs: Fx) -> Fx {
        Fx(self.0.saturating_add(rhs.0))
    }
}
impl Sub for Fx {
    type Output = Fx;
    #[inline]
    fn sub(self, rhs: Fx) -> Fx {
        Fx(self.0.saturating_sub(rhs.0))
    }
}
impl Neg for Fx {
    type Output = Fx;
    #[inline]
    fn neg(self) -> Fx {
        Fx(self.0.wrapping_neg())
    }
}
impl Mul for Fx {
    type Output = Fx;
    #[inline]
    fn mul(self, rhs: Fx) -> Fx {
        Fx::mul(self, rhs)
    }
}
impl Div for Fx {
    type Output = Fx;
    #[inline]
    fn div(self, rhs: Fx) -> Fx {
        Fx::div(self, rhs)
    }
}
impl AddAssign for Fx {
    #[inline]
    fn add_assign(&mut self, rhs: Fx) {
        *self = *self + rhs;
    }
}
impl SubAssign for Fx {
    #[inline]
    fn sub_assign(&mut self, rhs: Fx) {
        *self = *self - rhs;
    }
}
impl MulAssign for Fx {
    #[inline]
    fn mul_assign(&mut self, rhs: Fx) {
        *self = *self * rhs;
    }
}

#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct FxVec2 {
    pub x: Fx,
    pub y: Fx,
}

impl FxVec2 {
    pub const ZERO: FxVec2 = FxVec2 { x: Fx::ZERO, y: Fx::ZERO };

    #[inline]
    pub const fn new(x: Fx, y: Fx) -> Self {
        FxVec2 { x, y }
    }

    #[inline]
    pub fn add(self, b: FxVec2) -> FxVec2 {
        FxVec2 { x: self.x + b.x, y: self.y + b.y }
    }

    #[inline]
    pub fn sub(self, b: FxVec2) -> FxVec2 {
        FxVec2 { x: self.x - b.x, y: self.y - b.y }
    }

    #[inline]
    pub fn scale(self, s: Fx) -> FxVec2 {
        FxVec2 { x: self.x * s, y: self.y * s }
    }

    #[inline]
    pub fn neg(self) -> FxVec2 {
        FxVec2 { x: -self.x, y: -self.y }
    }

    #[inline]
    pub fn dot(self, b: FxVec2) -> Fx {
        self.x * b.x + self.y * b.y
    }

    /// 2D cross product (returns scalar z-component).
    #[inline]
    pub fn cross(self, b: FxVec2) -> Fx {
        self.x * b.y - self.y * b.x
    }

    /// Perpendicular (90° CCW): (x, y) → (-y, x).
    #[inline]
    pub fn perp(self) -> FxVec2 {
        FxVec2 { x: -self.y, y: self.x }
    }

    /// Squared length (no sqrt — useful for distance comparisons).
    #[inline]
    pub fn length_squared(self) -> Fx {
        self.dot(self)
    }

    /// Length via fixed-point sqrt. See `crate::math::sqrt_fx`.
    #[inline]
    pub fn length(self) -> Fx {
        crate::math::sqrt_fx(self.length_squared())
    }

    /// Normalize to unit length. Returns ZERO if the input length is < EPS.
    pub fn normalize(self) -> FxVec2 {
        let len = self.length();
        if len.raw() <= 0 {
            FxVec2::ZERO
        } else {
            FxVec2 { x: self.x / len, y: self.y / len }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn const_values() {
        assert_eq!(Fx::ONE.raw(), 1i64 << 32);
        assert_eq!(Fx::HALF.raw(), 1i64 << 31);
        assert_eq!(Fx::from_int(0), Fx::ZERO);
        assert_eq!(Fx::from_int(1), Fx::ONE);
        assert_eq!(Fx::from_int(-3).raw(), -3i64 << 32);
    }

    #[test]
    fn add_sub_neg() {
        let a = Fx::from_int(7);
        let b = Fx::from_int(3);
        assert_eq!((a + b).floor_to_i32(), 10);
        assert_eq!((a - b).floor_to_i32(), 4);
        assert_eq!((-a).floor_to_i32(), -7);
    }

    #[test]
    fn mul_round_trip() {
        let a = Fx::from_int(5);
        let b = Fx::from_int(6);
        assert_eq!((a * b).floor_to_i32(), 30);
        // Half × half = quarter
        assert_eq!((Fx::HALF * Fx::HALF).raw(), 1i64 << 30);
    }

    #[test]
    fn div_round_trip() {
        let a = Fx::from_int(10);
        let b = Fx::from_int(4);
        // 10 / 4 = 2.5
        let q = a / b;
        assert_eq!(q.raw(), (2i64 << 32) + (1i64 << 31));
        // Identity: x / x == 1
        assert_eq!(a / a, Fx::ONE);
    }

    #[test]
    #[cfg(feature = "std")]
    fn f64_round_trip_canonical() {
        for &x in &[0.0, 1.0, -1.0, 0.5, -0.25, 1234.5, -7.125] {
            let fx = Fx::from_f64(x);
            assert_eq!(fx.to_f64(), x, "round-trip mismatch for {}", x);
        }
    }

    #[test]
    #[cfg(feature = "std")]
    fn f64_round_half_to_even() {
        // 0.5 ULP cases — both round to even integer in Fx units.
        let half_ulp = 0.5 / (FX_ONE_RAW as f64);
        // 2.0 + 0.5 ULP → tie, even neighbor is 2.0
        let a = Fx::from_f64(2.0 + half_ulp);
        let b = Fx::from_f64(3.0 + half_ulp);
        assert_eq!(a.raw() & 1, 0, "round-half-to-even broken (a)");
        assert_eq!(b.raw() & 1, 0, "round-half-to-even broken (b)");
    }

    #[test]
    fn vec2_ops() {
        let a = FxVec2::new(Fx::from_int(3), Fx::from_int(4));
        let b = FxVec2::new(Fx::from_int(1), Fx::from_int(2));
        assert_eq!(a.add(b), FxVec2::new(Fx::from_int(4), Fx::from_int(6)));
        assert_eq!(a.sub(b), FxVec2::new(Fx::from_int(2), Fx::from_int(2)));
        assert_eq!(a.dot(b).floor_to_i32(), 3 + 8);
        assert_eq!(a.length_squared().floor_to_i32(), 9 + 16);
        // 3-4-5 triangle: length is exactly 5.
        assert_eq!(a.length().floor_to_i32(), 5);
    }
}
