// ─────────────────────────────────────────────────────────────────────────────
// Snapshot + event schema for screen↔screen multiplayer.
//
// Architecture: every client (host + every guest) runs the full BouncyBlobsGame
// simulation locally. The host is authoritative for game-state outcomes
// (scores, mode phase, winner, level changes). The host periodically emits
// snapshots that carry:
//   - per-player input state (so guests apply the same inputs to their sim)
//   - per-player centroid + expand state (so guests can reconcile drift)
// Guests then nudge their local blobs toward the host's centroid each snapshot,
// keeping the simulations converged without ever overriding local rendering.
// ─────────────────────────────────────────────────────────────────────────────

import type { LevelData, LevelType } from "../levels/types";

export interface SnapshotPlayer {
  id: string;
  name: string;
  color: string;
  faceId: string;
  /** Authoritative centroid (host's local sim). */
  x: number;
  y: number;
  /** Reserved for future velocity-based prediction. Currently always 0. */
  vx: number;
  vy: number;
  /** Display radius — non-authoritative, just a fallback hint. */
  radius: number;
  /** Last input frame the host applied for this player. Guests apply the same. */
  moveX: number;
  moveY: number;
  expanding: boolean;
  /** Host's current expand-shape factor. Guests reconcile their local blob. */
  expandScale: number;
  /** Score is host-authoritative. Reflects modeState.scores[id] for convenience. */
  score: number;
  /** Index of the screen that owns this player (host=1, joiners 2..N). */
  ownerScreenSlot: number;
}

export interface ModeStateSnapshot {
  /** GamePhase from the host's GameModeManager. */
  phase: "voting" | "countdown" | "playing" | "results" | string;
  timeRemainingMs?: number;
  scores?: Record<string, number>;
  winner?: { playerId: string | null; name: string | null } | null;
  /** KOTH: id/color of the current king. */
  kingPlayerId?: string;
  kingColor?: string;
}

export interface WorldSnapshot {
  /** Monotonic tick counter — used by clients to drop stale frames. */
  tick: number;
  /** Wall-clock time in ms when serialized. */
  ts: number;
  /** Host-side level id so a guest can detect a level swap mid-stream. */
  levelId: string | null;
  players: SnapshotPlayer[];
  modeState: ModeStateSnapshot;
}

export function serializeSnapshot(snap: WorldSnapshot): string {
  return JSON.stringify(snap);
}

export function deserializeSnapshot(data: string | ArrayBuffer): WorldSnapshot | null {
  try {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    return JSON.parse(text) as WorldSnapshot;
  } catch {
    return null;
  }
}

// ─── Input frames (client → host, unreliable channel) ──────────────────────

export interface InputFrame {
  /** Local player id on the sending screen. */
  playerId: string;
  moveX: number;
  moveY: number;
  expanding: boolean;
  /** Sender's tick counter — host uses this to detect drops, not authoritative. */
  tick: number;
}

export interface InputBatch {
  type: "input";
  /** All local players on this screen this frame. */
  frames: InputFrame[];
}

// ─── Reliable events (either direction) ──────────────────────────────────

export type ReliableEvent =
  | { type: "player_join"; playerId: string; name: string; color?: string; faceId?: string }
  | { type: "player_leave"; playerId: string }
  | { type: "customization"; playerId: string; color?: string; faceId?: string }
  | {
      /**
       * Host → all guests. Whenever the host enters a new level (after voting,
       * during a restart, or on the first connect), it broadcasts the full
       * LevelData so each guest can rebuild its local game with identical
       * geometry. Sent point-to-point on connect for late joiners.
       */
      type: "level_loaded";
      levelId: string;
      levelData: LevelData;
      /** Pre-resolved level type so guests pick the same GameMode. */
      levelType: LevelType;
    }
  | { type: "match_ended"; reason: string };
