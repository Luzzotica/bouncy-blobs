// ─────────────────────────────────────────────────────────────────────────────
// Debug bridge — exposes a tiny `window.__bbDebug` API so Playwright tests
// (and the dev console) can inspect simulation state without poking through
// the React tree. ONLY for test/diagnostic use.
//
// The bridge is installed by GameMaster (host) and OnlineGuest (guest) once
// their `BouncyBlobsGame` is initialised. Both call the same setter; latest
// wins, so a test driving two browser contexts can read from each
// independently via `page.evaluate(...)`.
// ─────────────────────────────────────────────────────────────────────────────

import type { BouncyBlobsGame } from "../game/bouncyBlobsGame";

interface DebugBridge {
  /** Returns the latest installed game (host or guest) or null if none. */
  game: () => BouncyBlobsGame | null;
  /** Centroid of a specific player blob, or null if the player isn't
   * spawned locally yet. */
  getPlayerPos: (playerId: string) => { x: number; y: number } | null;
  /** All players' centroids, keyed by id. */
  getAllPlayerPositions: () => Record<string, { x: number; y: number }>;
  /** Local sim's current tick. */
  getTick: () => number;
  /** Networking diagnostics (guest only). Buffer size + latest host tick
   * + the gap between local tick and host tick. If `gap` is negative the
   * guest is ahead (shouldn't happen). If `gap` is climbing, the guest's
   * sim isn't keeping up with broadcasts. If `bufferSize` is 0 long after
   * connecting, broadcasts aren't arriving. */
  getNetDiag: () => { bufferSize: number; latestHostTick: number; gap: number } | null;
  /** Per-keyframe snap magnitudes per player (guest only). Inspect via
   * `window.__bbDebug.lastSnaps()` in the guest console to see whether
   * visible "snaps" are tiny float-drift corrections or large
   * state-divergence corrections. Returns up to 200 most recent entries. */
  lastSnaps: () => Array<{ tick: number; playerId: string; dist: number; dx: number; dy: number; at: number }>;
  /** Cheap deterministic hash of the full sim state. Empty string on the
   *  TS sim (non-deterministic). On the Rust+wasm engine, FNV-1a hex over
   *  every (pos, vel) raw integer — equal across clients iff the sims
   *  agree on every bit of physics state. Used by Playwright to validate
   *  cross-context determinism and by netcode to detect desyncs. */
  getStateHash: () => string | null;
}

let netDiagAccessor: (() => { bufferSize: number; latestHostTick: number; gap: number } | null) | null = null;
let snapsAccessor: (() => Array<{ tick: number; playerId: string; dist: number; dx: number; dy: number; at: number }>) | null = null;

export function setNetDiagAccessor(
  fn: (() => { bufferSize: number; latestHostTick: number; gap: number } | null) | null,
): void {
  netDiagAccessor = fn;
}

export function setSnapsAccessor(
  fn: (() => Array<{ tick: number; playerId: string; dist: number; dx: number; dy: number; at: number }>) | null,
): void {
  snapsAccessor = fn;
}

let installedGame: BouncyBlobsGame | null = null;

export function installDebugBridge(game: BouncyBlobsGame | null): void {
  installedGame = game;
  if (typeof window === "undefined") return;
  const bridge: DebugBridge = {
    game: () => installedGame,
    getPlayerPos: (playerId) => {
      const pm = installedGame?.getPlayerManager();
      const p = pm?.getPlayer(playerId);
      if (!p) return null;
      const c = p.blob.getCentroid();
      return { x: c.x, y: c.y };
    },
    getAllPlayerPositions: () => {
      const pm = installedGame?.getPlayerManager();
      const out: Record<string, { x: number; y: number }> = {};
      if (!pm) return out;
      for (const p of pm.getAllPlayers()) {
        const c = p.blob.getCentroid();
        out[p.playerId] = { x: c.x, y: c.y };
      }
      return out;
    },
    getTick: () => installedGame?.getWorld()?.tick ?? 0,
    getNetDiag: () => (netDiagAccessor ? netDiagAccessor() : null),
    lastSnaps: () => (snapsAccessor ? snapsAccessor() : []),
    getStateHash: () => {
      const w = installedGame?.getWorld();
      if (!w) return null;
      // TS sim returns ''; Rust sim returns FNV-1a hex.
      return w.stateHash();
    },
  };
  (window as unknown as { __bbDebug: DebugBridge }).__bbDebug = bridge;
}
