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
import { getFrameProfile, resetFrameProfile, type FrameSample } from "../game/gameLoop";
import { getHashHistory, type HashHistoryEntry } from "./hashHistory";

/** Result of the compare-hashes diagnostic. Returned to the host's
 *  overlay; null while a request is in flight, populated once all
 *  guests have responded (or the wait timeout elapses). */
export interface CompareHashesResult {
  /** All side IDs we got responses from, plus 'host' for the local
   *  side. Used as column headers in the overlay table. */
  peerIds: string[];
  /** Per-tick map: tick → { peerId → { hash, summary? } }. The
   *  summary is the structured per-tick breakdown (per-blob centroid
   *  + velocity + expand scale, RNG state, mode phase) — when a hash
   *  mismatches, the overlay expands the row to diff these fields
   *  side-by-side so you can SEE which subsystem is drifting.
   *  Sorted ascending. */
  byTick: Array<{
    tick: number;
    hashes: Record<string, { hash: string | null; summary?: import("./hashHistory").TickSummary }>;
  }>;
}

/** Functions the host overlay calls to drive the compare-hashes flow.
 *  Wired by GameMaster.tsx via `setCompareHashesAccessor`. Null on
 *  guest tabs (button doesn't render). */
export type CompareHashesFn = () => Promise<CompareHashesResult>;
export type TogglePauseFn = (paused: boolean) => void;

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
  /** Rollback netcode stats (guest only, prediction mode on). Returns
   *  null if rollback isn't enabled. */
  /** Returns the recent frame samples captured by `GameLoop`. Each sample
   *  carries timestamp + frame/logic/render millisecond costs. Used by
   *  the playwright diagnostic harness. */
  getFrameProfile: () => FrameSample[];
  /** Drops the in-memory frame samples. Used at the start of a profiling
   *  session so the ring captures only the period of interest. */
  resetFrameProfile: () => void;
  getRollbackStats: () => {
    rollbacksApplied: number;
    lastDepth: number;
    smoothingActive: number;
    ringInvalidations: number;
    failedRestores: number;
    avgSnapshotMs: number;
    avgCheapTickMs: number;
    avgReconcileMs: number;
  } | null;
  /** Local per-tick hash history (the same ring the compare-hashes
   *  diagnostic ships across the wire). Useful for console
   *  inspection (`__bbDebug.getHashHistory()`) when the modal table
   *  isn't enough. */
  getHashHistory: () => HashHistoryEntry[];
  /** Trigger the cross-side compare. Resolves to a side-by-side table
   *  ready to render, or null if the host hasn't wired up an
   *  accessor yet (guest tab, or pre-canvas-init). Resolves via the
   *  module-level accessor at CALL time (not bridge-install time) so
   *  the host can set up accessors after the bridge installs. */
  compareHashes: () => Promise<CompareHashesResult | null>;
  /** Toggle sim-paused on both sides. Host's invocation also
   *  broadcasts to guests so they pause together. No-op on guests
   *  (their pause comes from the host's `set_paused` event). */
  togglePause: (paused: boolean) => void;
  /** Test-only: directly script the local player's input. Bypasses
   *  Playwright's keyboard-event-to-canvas-focus flakiness so e2e
   *  determinism tests can deterministically drive blob motion and
   *  interaction with spring pads / spikes / trigger zones. */
  setPlayerInput: (playerId: string, moveX: number, moveY: number, expanding: boolean) => void;
}

let netDiagAccessor: (() => { bufferSize: number; latestHostTick: number; gap: number } | null) | null = null;
let snapsAccessor: (() => Array<{ tick: number; playerId: string; dist: number; dx: number; dy: number; at: number }>) | null = null;
let rollbackStatsAccessor: (() => {
  rollbacksApplied: number;
  lastDepth: number;
  smoothingActive: number;
  ringInvalidations: number;
  failedRestores: number;
  avgSnapshotMs: number;
  avgCheapTickMs: number;
  avgReconcileMs: number;
} | null) | null = null;

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

export function setRollbackStatsAccessor(
  fn: (() => {
    rollbacksApplied: number;
    lastDepth: number;
    smoothingActive: number;
    ringInvalidations: number;
    failedRestores: number;
    avgSnapshotMs: number;
    avgCheapTickMs: number;
    avgReconcileMs: number;
  } | null) | null,
): void {
  rollbackStatsAccessor = fn;
}

let installedGame: BouncyBlobsGame | null = null;
let compareHashesAccessor: CompareHashesFn | null = null;
let togglePauseAccessor: TogglePauseFn | null = null;

export function setCompareHashesAccessor(fn: CompareHashesFn | null): void {
  compareHashesAccessor = fn;
}
export function setTogglePauseAccessor(fn: TogglePauseFn | null): void {
  togglePauseAccessor = fn;
}

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
    getRollbackStats: () => rollbackStatsAccessor ? rollbackStatsAccessor() : null,
    getFrameProfile: () => getFrameProfile(),
    resetFrameProfile: () => resetFrameProfile(),
    getHashHistory: () => getHashHistory(),
    // Resolve through the module-level accessors at call time so
    // installDebugBridge order vs setCompareHashesAccessor doesn't
    // matter. Without this indirection, the bridge captures whatever
    // value the accessor had at install time (typically null) and
    // late-wiring never reaches it.
    compareHashes: async () => {
      if (!compareHashesAccessor) return null;
      return await compareHashesAccessor();
    },
    togglePause: (paused: boolean) => {
      togglePauseAccessor?.(paused);
    },
    setPlayerInput: (playerId, moveX, moveY, expanding) => {
      const pm = installedGame?.getPlayerManager();
      const p = pm?.getPlayer(playerId);
      if (!p) return;
      p.moveX = moveX;
      p.moveY = moveY;
      p.expanding = expanding;
    },
  };
  (window as unknown as { __bbDebug: DebugBridge }).__bbDebug = bridge;
}
