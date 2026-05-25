// Construct a softbody engine — the wasm-compiled Rust integer sim
// (default) or the legacy TS float sim (`?engine=ts`).
//
// Flag precedence (first match wins):
//   1. URL query string ?engine=ts | ?engine=rust
//   2. localStorage     'bb_engine' = 'ts' | 'rust'
//   3. Default: 'rust' — the deterministic integer sim, which fixes
//      the cross-browser desync that breaks netplay on the TS sim.
//      Fall back to `?engine=ts` if you need to A/B compare or chase
//      a behavioural regression while we're still working out the
//      kinks.
//
// The wasm-backed engine requires the wasm module to be loaded before
// construction. Game bootstrap should `await loadWasm()` at startup.

import type { SoftBodyEngine } from './SoftBodyEngine';
import { SoftBodyWorld, type SoftBodyWorldConfig } from './softBodyWorld';
import { SoftBodyWorldRust, loadWasm } from './softBodyWorldRust';

export type EnginePick = 'ts' | 'rust';

export function getEngine(): EnginePick {
  if (typeof window !== 'undefined') {
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get('engine');
    if (q === 'rust' || q === 'ts') return q;
    const ls = window.localStorage?.getItem('bb_engine');
    if (ls === 'rust' || ls === 'ts') return ls;
  }
  return 'rust';
}

export function setEnginePreference(pick: EnginePick): void {
  if (typeof window !== 'undefined') {
    window.localStorage?.setItem('bb_engine', pick);
  }
}

/** Load any prerequisites for the active engine (wasm module fetch).
 *  Call once at app bootstrap; cheap no-op if already loaded. */
export async function prepareEngine(pick: EnginePick = getEngine()): Promise<void> {
  if (pick === 'rust') await loadWasm();
}

/**
 * Construct an engine satisfying SoftBodyEngine. The Rust path requires
 * `prepareEngine()` to have been awaited first.
 */
export function createSoftBodyEngine(config: SoftBodyWorldConfig = {}): SoftBodyEngine {
  const pick = getEngine();
  if (pick === 'rust') {
    return new SoftBodyWorldRust({
      gravity: config.gravity,
      substeps: config.substeps,
      rngSeed: config.rngSeed,
    });
  }
  return new SoftBodyWorld(config);
}
