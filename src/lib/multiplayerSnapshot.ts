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
import type { GameStateSnapshot } from "../game/bouncyBlobsGame";

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
  /** Seconds-on-the-wall left in the current non-`playing` phase (countdown
   * or results). Guests use this to drive the same overlay/timer the host
   * shows, since without it they have no way to render the "Next round…"
   * countdown after the host ends a round. */
  phaseTimerMs?: number;
  scores?: Record<string, number>;
  winner?: { playerId: string | null; name: string | null } | null;
  /** KOTH: id/color of the current king. */
  kingPlayerId?: string;
  kingColor?: string;
}

/**
 * Snapshot of a non-player soft body (NPC blob, soft platform, or point
 * shape). Positions are stored as a flat `[x0,y0,x1,y1,…]` number array to
 * keep the JSON wire small without yet going binary (that's the Stage 2
 * wire-protocol rewrite). `cx/cy` is the centroid for fast existence checks.
 */
export interface SnapshotEntity {
  /** Stable id within its kind — npcBlob id, softPlatform id, pointShape id. */
  id: string;
  /** Centroid of the relevant particles. */
  cx: number;
  cy: number;
  /** Particle positions as [x0, y0, x1, y1, …]. May be empty when sleeping. */
  pos: number[];
}

export interface WorldSnapshot {
  /** Monotonic tick counter — used by clients to drop stale frames. */
  tick: number;
  /** Wall-clock time in ms when serialized. */
  ts: number;
  /** Host-side level id so a guest can detect a level swap mid-stream. */
  levelId: string | null;
  players: SnapshotPlayer[];
  /** Optional — host omits these arrays when no entities of that kind exist. */
  npcBlobs?: SnapshotEntity[];
  softPlatforms?: SnapshotEntity[];
  pointShapes?: SnapshotEntity[];
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

/**
 * Read-only mirror of host's lobby UI state. Sent on screen-peer connect
 * and whenever any of these fields change while the host is in the lobby
 * phase. Guest renders a GuestLobbyPanel from this; everything is display-
 * only except the player's own customization (handled via `customization`
 * events).
 */
export interface LobbyStateEvent {
  type: "lobby_state";
  /** "lobby" while in pre-round playground; "playing" once a real round has begun. */
  phase: "lobby" | "playing";
  selectedMapId: string | null;
  selectedModeId: string | null;
  maxPlayers: number;
  isPublic: boolean;
  mapOptions: Array<{ id: string; name: string }>;
  players: Array<{
    id: string;
    name: string;
    color: string;
    faceId: string;
    kind: "host" | "guest" | "bot";
    /** Wire-protocol slot assigned by the host (0..15). The compact
     *  v2 input format encodes inputs by slot rather than by playerId
     *  to keep packets small enough for K=120-tick redundancy on the
     *  unreliable channel. Guests build a slot→playerId map from this
     *  field and consult it in decodeAggregatedInputs. */
    slot: number;
  }>;
  /** Mode state (formerly inside WorldSnapshot.modeState). Stage 2 moved
   * scores/winner/phase out of the per-tick binary frame and into this
   * low-rate reliable event, since the binary frame is purely physics. */
  modeState?: ModeStateSnapshot;
}

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
      /** True when the host is showing the pre-round playground arena. Guests
       * use FreeplayMode in this case — same as the host — so they don't run
       * the level's normal countdown / round timer in the lobby phase. */
      freeplay?: boolean;
      /** Seed for the world's deterministic RNG. Without this, host and
       * guest each pick their own default seed and AI decisions / powerup
       * types / spawn jitter diverge immediately. */
      rngSeed?: number;
    }
  | {
      /**
       * Host → guest. Aligns the guest's PRNG state to the host's so any
       * subsequent random draw (AI decisions, powerup type rolls, etc.)
       * produces the same value on both sides. Sent on peer connect (as
       * part of the late-joiner replay bundle) and again periodically as
       * a drift-recovery safety net.
       */
      type: "rng_state";
      tick: number;
      state: number;
    }
  | LobbyStateEvent
  | { type: "match_ended"; reason: string }
  | {
      /**
       * Host → all guests. Pause/resume the sim on both sides at the
       * same wall-clock instant (the guest receives this and sets its
       * local pacingConfig.paused). Used by the compare-hashes
       * diagnostic so both sides freeze and stop drifting while we
       * inspect per-tick state. Not for any gameplay purpose.
       */
      type: "set_paused";
      paused: boolean;
    }
  | {
      /**
       * Host → all guests. "Send me your last N (tick, hash) entries
       * so I can compare them to mine side-by-side." Reply is the
       * matching `hashes_response` reliable event with the same
       * requestId, sent guest → host.
       */
      type: "request_hashes";
      requestId: number;
    }
  | {
      /**
       * Guest → host. Reply to `request_hashes` carrying the guest's
       * own per-tick (tick, hash) ring. The host's overlay merges
       * these into a side-by-side table.
       */
      type: "hashes_response";
      requestId: number;
      peerId: string;
      entries: Array<{ tick: number; hash: string; summary?: import("./hashHistory").TickSummary }>;
    }
  | {
      /**
       * Host → all guests. Full game-state snapshot — every JS-side
       * field that affects sim continuity (per-blob SlimeBlob state +
       * every manager's dumpState). Broadcast alongside the binary
       * keyframe at ~1Hz; together they form a lossless sync of
       * engine state (keyframe carries `engine.serializeState()`) +
       * everything outside the engine (this event).
       *
       * Sent on the reliable 'state' channel so apply order is
       * deterministic: keyframe binary arrives first, restoring
       * engine state; then this event arrives, restoring JS state
       * via `game.restoreGameState(state)`. Without BOTH, the next
       * `blob.update()` on the guest reads un-synced JS state and
       * writes different forces into the engine — sims diverge.
       */
      type: "manager_state";
      tick: number;
      state: GameStateSnapshot;
    };
