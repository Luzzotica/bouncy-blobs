// Standard bitmask collision-filtering pattern. Every collidable thing
// (particle, blob hull, static surface) carries TWO numbers:
//
//   layer — which class it belongs to (a single bit set)
//   mask  — which classes it WANTS to collide with (any number of bits)
//
// A collision is allowed iff:
//   (A.layer & B.mask) !== 0   // B wants to collide with A's class
//   AND
//   (B.layer & A.mask) !== 0   // A wants to collide with B's class
//
// Both sides must opt in. That's what lets a chain say "I only hit the
// world, not blobs" without every blob having to know about chains.

export const LAYER_DEFAULT = 0b00000001
export const LAYER_BLOB    = 0b00000010
export const LAYER_CHAIN   = 0b00000100
export const LAYER_WORLD   = 0b00001000
// Reserved bits for future use (hazards, sensors, team-A, team-B, etc.).
// Up to 31 layers fit in a JS 32-bit integer.

export const LAYER_ALL = 0xFFFF

/** Test whether two layer/mask pairs are allowed to collide. */
export function canCollide(
  layerA: number,
  maskA: number,
  layerB: number,
  maskB: number,
): boolean {
  return (layerA & maskB) !== 0 && (layerB & maskA) !== 0
}
