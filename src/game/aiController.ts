import type { ManagedPlayer, PlayerManager } from './playerManager';
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import {
  PERSONALITIES,
  type AIWorldView,
  type AIInput,
  type PersonalityName,
  type PersonalityState,
} from './aiPersonalities';
import { Vec2, vec2 } from '../physics/vec2';
import { createRng, type SeededRng } from '../lib/rng';

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

/** Distinct seed per controller so each bot's wander/jitter differs, but
 *  INDEPENDENT of the engine's world.rng. */
let aiRngCounter = 0;

export class AIController {
  public readonly personality: PersonalityName;
  private state: PersonalityState = { scratch: {} };
  private goalProvider:
    | ((self: ManagedPlayer) => { x: number; y: number; width: number; height: number } | null)
    | null = null;
  private hillCenterProvider: (() => Vec2 | null) | null = null;
  /** The AI's OWN rng — deliberately NOT the engine's world.rng. Each peer runs
   *  only the bots IT owns, so drawing from world.rng would advance it
   *  differently per peer and desync the deterministic physics. The bot's input
   *  is authoritative + broadcast, so its randomness needs no cross-peer
   *  determinism; keeping it off world.rng is what keeps the engines identical. */
  private readonly rng: SeededRng;

  constructor(personality: PersonalityName) {
    this.personality = personality;
    // Seeded but independent of world.rng — distinct per controller.
    this.rng = createRng(((aiRngCounter++ * 0x9e3779b1) ^ 0x85ebca6b) >>> 0);
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

  tick(self: ManagedPlayer, manager: PlayerManager, dt: number, physicsWorld?: SoftBodyEngine): AIInput {
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

    // Deterministic elapsed: absolute world tick × fixedDt. NOT relative to
    // this controller's spawn tick — that was a stable-per-controller value
    // on the host but the GUEST creates its AI controller at a different
    // tick (when the keyframe synthesizes the bot), so a per-controller
    // start tick gave host and guest different `elapsed` values for the
    // same physical world tick. Absolute world time is the same on every
    // client in lockstep, so personalities making time-based decisions
    // (lastExpand cooldowns, bouncer sin oscillator) match.
    const elapsed = physicsWorld
      ? physicsWorld.tick * physicsWorld.fixedDt
      : 0;

    const world: AIWorldView = {
      opponents,
      goal,
      goalWidth: goalInfo?.width ?? null,
      goalHeight: goalInfo?.height ?? null,
      hillCenter: this.hillCenterProvider?.() ?? null,
      dt,
      elapsed,
      // The controller's OWN rng — NOT physicsWorld.rng (see the `rng` field
      // doc): drawing from world.rng here desyncs the engine across peers.
      rng: this.rng,
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

/** Minimal RNG shape we need — kept narrow so any seeded RNG implementation
 *  (EngineRng from the SoftBodyEngine, the legacy SeededRng) can be passed. */
interface IdRng { next(): number; }

/** Generate a stable bot id and human-friendly name.
 *
 *  The id includes a 4-digit numeric suffix for collision-avoidance when
 *  multiple bots of the same personality spawn back-to-back. The suffix is
 *  derived from the supplied RNG (always pass `world.rng` so two clients
 *  with the same session seed generate the same bot ids) — never from
 *  `Math.random()`, which would diverge across browsers and break netplay
 *  determinism. */
// Callsign pool — each bot gets a distinct random name (Halo-style guest
// callsigns), drawn deterministically from the session RNG so two clients
// with the same seed name their bots identically. Playful + blobby to match
// the game's identity.
const BOT_NAMES = [
  'Wobblesworth', 'Sir Bounce-a-Lot', 'Goopzilla', 'McSquish', 'Jellybean',
  'Splatatouille', 'Gloopy', 'Bubbles', 'Slime Shady', 'Jiggles',
  'Plopper', 'Goober', 'Wiggles', 'Mochi', 'Puddingcup',
  'Bloblin', 'Squelch', 'Gel-Man', 'Captain Squish', 'Blobzilla',
  'Snot Rocket', 'Gummy', 'Ooze Newton', 'Drippy', 'Boingo',
  'Sir Splats', 'Wobbleton', 'Jiggly Puff', 'Gloob', 'Squidgy',
  'Bouncer', 'Mr. Bubbly', 'Goolius', 'Splooch', 'Tapioca',
  'Blubber', 'Squishy McFly', 'Glorp', 'Bouncey', 'Slurp',
];

let botCounter = 0;
// Names handed out this match — reset implicitly per page load (each
// recording / fresh session). Self-heals if the pool is exhausted.
const usedNames = new Set<string>();

function pickBotName(rng: IdRng): string {
  if (usedNames.size >= BOT_NAMES.length) usedNames.clear();
  const start = Math.floor(rng.next() * BOT_NAMES.length);
  for (let k = 0; k < BOT_NAMES.length; k++) {
    const name = BOT_NAMES[(start + k) % BOT_NAMES.length];
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  return BOT_NAMES[start];
}

export function nextBotIdentity(personality: PersonalityName, rng: IdRng): { id: string; name: string } {
  botCounter += 1;
  const suffix = Math.floor(rng.next() * 9999);
  return {
    id: `bot-${personality}-${botCounter}-${suffix}`,
    name: pickBotName(rng),
  };
}

/** Default spawn near the centre when no spawn points are configured.
 *  Uses the supplied RNG (typically `world.rng`) so spawn jitter is
 *  deterministic across clients given the same session seed. */
export function defaultBotSpawn(rng: IdRng): Vec2 {
  return vec2((rng.next() - 0.5) * 600, 200);
}
