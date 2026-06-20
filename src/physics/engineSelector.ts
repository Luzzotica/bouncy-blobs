// Construct a softbody engine. The Rust integer sim is the only engine —
// the legacy TS float sim has been deleted so there's a single deterministic
// codebase that runs everywhere (local, online, ranked).
//
// The wasm-backed engine requires the wasm module to be loaded before
// construction. Game bootstrap should `await prepareEngine()` at startup.

import type { SoftBodyEngine } from './SoftBodyEngine';
import type { SoftBodyWorldConfig } from './engineConfig';
import { SoftBodyWorldRust, loadWasm } from './softBodyWorldRust';

export type EnginePick = 'rust';

export function getEngine(): EnginePick {
  return 'rust';
}

export function setEnginePreference(_pick: EnginePick): void {
  // No-op — Rust is the only engine. Kept to avoid touching callers.
}

/** Load any prerequisites for the active engine (wasm module fetch).
 *  Call once at app bootstrap; cheap no-op if already loaded. */
export async function prepareEngine(_pick: EnginePick = 'rust'): Promise<void> {
  await loadWasm();
}

/**
 * Construct an engine satisfying SoftBodyEngine. Requires
 * `prepareEngine()` to have been awaited first.
 */
export function createSoftBodyEngine(config: SoftBodyWorldConfig = {}): SoftBodyEngine {
  return new SoftBodyWorldRust({
    gravity: config.gravity,
    substeps: config.substeps,
    rngSeed: config.rngSeed,
  });
}
