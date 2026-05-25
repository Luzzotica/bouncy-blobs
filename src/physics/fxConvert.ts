// Canonical f64 ↔ Fx (Q32.32) conversion. Mirrors the same operation in
// `crates/softbody/src/fx.rs::Fx::from_f64` (multiply by 2^32, round-ties-
// to-even, clamp to i64 range) so that the JS-side and Rust-side conversion
// of the same f64 bits produce identical Fx raw values.
//
// You almost never need to call these directly from gameplay code — the
// wasm boundary converts on entry/exit. They exist for tests that want
// to assert "this f64 → Fx maps to that raw" and for any future netcode
// path that needs to round-trip values through Fx without going through
// the wasm engine.

const FX_ONE = 2 ** 32; // = 4294967296

const I64_MAX = 9223372036854775807n;
const I64_MIN = -9223372036854775808n;

/** Convert an f64 to a Fx raw bigint (i64). Round half to even. */
export function fxFromF64(x: number): bigint {
  if (!Number.isFinite(x)) return 0n;
  const scaled = x * FX_ONE;
  // Math.round is round half AWAY from zero. We need round half to EVEN.
  // Implement explicitly: floor(x), check distance to 0.5, tie → even.
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  let rounded: number;
  if (frac < 0.5) rounded = floor;
  else if (frac > 0.5) rounded = floor + 1;
  else rounded = (floor % 2 === 0) ? floor : floor + 1; // tie → even
  let big = BigInt(rounded);
  if (big > I64_MAX) big = I64_MAX;
  if (big < I64_MIN) big = I64_MIN;
  return big;
}

/** Convert a Fx raw bigint back to an f64 for rendering. Lossy — never feed back in. */
export function fxToF64(raw: bigint): number {
  return Number(raw) / FX_ONE;
}
