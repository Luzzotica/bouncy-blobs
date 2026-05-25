// Cheap netplay desync detector.
//
// Periodically samples `engine.stateHash()` and sends it over the
// network. The receiving side compares against its own sampled hash at
// the same tick; mismatch = the sims have diverged.
//
// Empty hash strings (returned by the legacy TS sim — see SoftBodyWorld
// .stateHash) are treated as "unknown, skip" — the detector only does
// useful work on the Rust engine which has true bit-exact state.
//
// Sampling frequency is hardcoded to every 60 ticks (~1 Hz at 60 Hz
// sim). That's frequent enough to catch a desync within a second of
// it happening, and cheap enough that the hash compute is rounding-
// error in CPU profile.

import type { SoftBodyEngine } from './SoftBodyEngine';

export interface DesyncSample {
  tick: number;
  hash: string;
}

const SAMPLE_INTERVAL = 60;

export class DesyncDetector {
  private samples = new Map<number, string>(); // tick → our hash
  private lastSampledTick = -1;

  /** Call once per `step()` after the engine has advanced. Returns a
   *  fresh sample to broadcast on every Nth tick, else null. */
  maybeSample(engine: SoftBodyEngine): DesyncSample | null {
    const tick = engine.tick;
    if (tick === this.lastSampledTick) return null;
    if (tick % SAMPLE_INTERVAL !== 0) return null;
    const hash = engine.stateHash();
    if (!hash) return null; // TS sim returns ''; skip
    this.samples.set(tick, hash);
    this.lastSampledTick = tick;
    // Don't let the map grow unbounded.
    if (this.samples.size > 256) {
      const oldest = Math.min(...this.samples.keys());
      this.samples.delete(oldest);
    }
    return { tick, hash };
  }

  /** Compare a peer's sample against ours. Returns:
   *    'match'   — hashes equal at the same tick
   *    'differ'  — hashes differ → DESYNC
   *    'unknown' — we don't have a sample for that tick (yet) */
  comparePeer(peer: DesyncSample): 'match' | 'differ' | 'unknown' {
    const ours = this.samples.get(peer.tick);
    if (!ours) return 'unknown';
    return ours === peer.hash ? 'match' : 'differ';
  }
}
