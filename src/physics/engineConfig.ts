import { Vec2 } from './vec2';

/**
 * Construction-time config for the soft-body engine. Most fields are physics
 * tuning knobs honoured by the engine; the runtime engine (Rust integer sim)
 * reads `gravity`, `substeps` and `rngSeed`. The remaining fields are retained
 * for API compatibility with callers/tests that set them.
 */
export interface SoftBodyWorldConfig {
  gravity?: Vec2;
  gravityScale?: number;
  fixedDt?: number;
  substeps?: number;
  collisionMargin?: number;
  collisionRestitution?: number;
  constraintIters?: number;
  staticRestitution?: number;
  staticContactSlop?: number;
  blobBlobFrictionMu?: number;
  blobBlobFrictionImpulseScale?: number;
  staticEdgeFrictionMu?: number;
  staticFrictionMinTangSpeed?: number;
  staticFrictionNormalLoadScale?: number;
  hullVertexDampingPerSec?: number;
  centerHullDampingPerSec?: number;
  hullDampSkipAboveSpeed?: number;
  /** Seed for the world's deterministic RNG. Anything that affects physics
   * (AI decisions, spawn jitter, powerup type, spike spawn) consumes from
   * this stream — never `Math.random()`. Two clients seeded the same and
   * fed the same inputs in the same order produce identical states. */
  rngSeed?: number;
}
