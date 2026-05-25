// ─────────────────────────────────────────────────────────────────────────────
// Seeded deterministic RNG.
//
// Mulberry32: tiny, fast, good enough statistically for game physics
// jitter / AI decisions. The whole point is that two clients seeded with
// the same value, consumed in the same order, produce identical streams —
// so simulations stay in sync without us shipping the result of every
// roll on the wire.
//
// Usage:
//   const rng = createRng(seed);
//   const r = rng.next();        // [0, 1)
//   const n = rng.int(0, 16);    // [0, 16)
//   const j = rng.range(-200, 200);
//
// State save/restore for snapshot keyframes:
//   const s = rng.getState();
//   rng.setState(s);
// ─────────────────────────────────────────────────────────────────────────────

export interface SeededRng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform int in [min, max). max exclusive. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Coin flip. */
  bool(): boolean;
  /** Snapshot the current state (for keyframes / save). */
  getState(): number;
  /** Restore a previously snapshotted state. */
  setState(state: number): void;
}

export function createRng(seed: number): SeededRng {
  // Force seed into a uint32 so behavior matches across signedness quirks.
  let a = (seed >>> 0) || 1;

  function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    int(min, max) {
      return Math.floor(next() * (max - min)) + min;
    },
    range(min, max) {
      return next() * (max - min) + min;
    },
    bool() {
      return next() < 0.5;
    },
    getState() {
      return a;
    },
    setState(state) {
      a = (state >>> 0) || 1;
    },
  };
}

/** Hash a string to a 32-bit unsigned int. Useful for deriving stable per-
 * entity sub-seeds from string ids (e.g. "npc-0", "plat:floor-3"). */
export function hashStringSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
