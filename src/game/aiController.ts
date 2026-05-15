import type { ManagedPlayer, PlayerManager } from './playerManager';
import {
  PERSONALITIES,
  type AIWorldView,
  type AIInput,
  type PersonalityName,
  type PersonalityState,
} from './aiPersonalities';
import { Vec2, vec2 } from '../physics/vec2';

// ─────────────────────────────────────────────────────────────────────────────
// AIController
//
// One per AI player. Held by ManagedPlayer when inputSource === 'ai'.
// PlayerManager.updateAll() calls tick() each frame, then the result is
// written into the player's moveX/moveY/expanding fields just like a real
// joystick input would be.
//
// The controller doesn't know about game modes — instead, BouncyBlobsGame
// installs a goalProvider when the bot is added so the brain can ask "what's
// my objective right now?" without coupling the AI to any specific mode.
// ─────────────────────────────────────────────────────────────────────────────

export class AIController {
  public readonly personality: PersonalityName;
  private state: PersonalityState = { scratch: {} };
  private startedAt: number;
  private goalProvider:
    | ((self: ManagedPlayer) => { x: number; y: number; width: number; height: number } | null)
    | null = null;
  private hillCenterProvider: (() => Vec2 | null) | null = null;

  constructor(personality: PersonalityName) {
    this.personality = personality;
    this.startedAt = performance.now() / 1000;
  }

  /** The current target this bot should pursue (set by BouncyBlobsGame). */
  setGoalProvider(
    fn:
      | ((self: ManagedPlayer) => { x: number; y: number; width: number; height: number } | null)
      | null,
  ): void {
    this.goalProvider = fn;
  }

  /** Optional hook so KOTH-aware personalities can find the hill. */
  setHillCenterProvider(fn: (() => Vec2 | null) | null): void {
    this.hillCenterProvider = fn;
  }

  tick(self: ManagedPlayer, manager: PlayerManager, dt: number): AIInput {
    const allPlayers = manager.getAllPlayers();
    const opponents = allPlayers
      .filter((p) => p.playerId !== self.playerId)
      .map((p) => ({
        playerId: p.playerId,
        centroid: p.blob.getCentroid(),
        grounded: p.blob.isGrounded(),
      }));

    const goalInfo = this.goalProvider?.(self) ?? null;
    const goal: Vec2 | null = goalInfo ? { x: goalInfo.x, y: goalInfo.y } : null;

    const world: AIWorldView = {
      opponents,
      goal,
      goalWidth: goalInfo?.width ?? null,
      goalHeight: goalInfo?.height ?? null,
      hillCenter: this.hillCenterProvider?.() ?? null,
      dt,
      elapsed: performance.now() / 1000 - this.startedAt,
    };

    return PERSONALITIES[this.personality](
      {
        playerId: self.playerId,
        centroid: self.blob.getCentroid(),
        grounded: self.blob.isGrounded(),
      },
      world,
      this.state,
    );
  }
}

/** Generate a stable bot id and human-friendly name. */
let botCounter = 0;
export function nextBotIdentity(personality: PersonalityName): { id: string; name: string } {
  botCounter += 1;
  return {
    id: `bot-${personality}-${botCounter}-${Math.floor(Math.random() * 9999)}`,
    name: `Bot ${botCounter} (${personality})`,
  };
}

/** Convenience: pick a default spawn near the centre when no spawn points are configured. */
export function defaultBotSpawn(): Vec2 {
  return vec2((Math.random() - 0.5) * 600, 200);
}
