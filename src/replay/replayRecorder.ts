// Bouncy Blobs replay recording — a module singleton the host sim tees its
// authoritative input stream into. Replays are deterministic input logs: the
// header rebuilds the sim (rngSeed + level), and the per-tick tagged inputs
// drive it — exactly how a live guest replays the host. See party-kit replay.ts.

import { ReplayRecorder, type ReplayFile } from '../lib/party';
import type { LevelData, LevelType } from '../levels/types';

/** Bump when a sim/wasm change breaks determinism vs older replays. */
export const REPLAY_BUILD = 'bouncy-blobs-1';

export interface BbReplayPlayer {
  playerId: string;
  name?: string;
  colorIndex?: number;
  isBot?: boolean;
}

export interface BbReplayHeader {
  rngSeed: number;
  levelData: LevelData;
  levelType: LevelType;
  players: BbReplayPlayer[];
}

/** One authoritative input at a tick (dedup'd by {tick, playerId}). */
export interface BbReplayInput {
  t: number; // applyTick
  p: string; // playerId
  mx: number;
  my: number;
  e: boolean; // expanding
}

export type BbReplay = ReplayFile<BbReplayHeader, BbReplayInput>;

let recorder: ReplayRecorder<BbReplayHeader, BbReplayInput> | null = null;
let seen: Set<string> | null = null;
let lastReplay: BbReplay | null = null;

export function beginReplayRecording(header: BbReplayHeader): void {
  recorder = new ReplayRecorder<BbReplayHeader, BbReplayInput>('bouncy-blobs', REPLAY_BUILD);
  recorder.start(header);
  seen = new Set();
  lastReplay = null;
}

/** Record an authoritative input, dedup'd by {tick, playerId} (the host's
 *  relay window resends recent ticks for loss recovery). */
export function recordReplayInput(entry: BbReplayInput): void {
  if (!recorder || !seen) return;
  const key = `${entry.t}:${entry.p}`;
  if (seen.has(key)) return;
  seen.add(key);
  recorder.push(entry);
}

export function finishReplayRecording(durationTicks: number): void {
  lastReplay = recorder?.finalize(durationTicks) ?? null;
  recorder = null;
  seen = null;
}

export function isRecording(): boolean {
  return recorder !== null;
}

export function getLastReplay(): BbReplay | null {
  return lastReplay;
}

export function clearReplay(): void {
  recorder = null;
  seen = null;
  lastReplay = null;
}
