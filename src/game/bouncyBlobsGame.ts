import React from 'react';
import { Game, GameContext, GameDefinition, GameState } from './GameInterface';
import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { createSoftBodyEngine } from '../physics/engineSelector';
import { SlimeBlob } from '../physics/slimeBlob';
import { Camera } from '../renderer/camera';
import { render, RenderOptions, PlayerRenderData } from '../renderer/canvasRenderer';
import { GameLoop, recordPhaseTime } from './gameLoop';
import { PlayerManager } from './playerManager';
import { AIController, nextBotIdentity } from './aiController';
import { PERSONALITY_COLORS, type PersonalityName } from './aiPersonalities';
import { loadLevel } from '../levels/levelLoader';
import { preloadSprites, getSprite } from '../assets/spriteRegistry';
import { preloadBackground } from '../renderer/backgroundRenderer';
import type { GetSpriteShape } from '../levels/levelLoader';
import { defaultLevel } from '../levels/defaultLevel';
import { LevelData, getLevelTypes } from '../levels/types';
import { DEFAULT_CONTROLLER_CONFIG } from '../types/controllerConfig';
import { InputEvent } from '../types';
import { Player } from '../types/database';
import { GameModeManager } from './gameModes/gameModeManager';
import { logMatchEvent } from '../lib/matchEvents';
import { GameMode, GamePhase } from './gameModes/types';
import { KingOfTheHillMode } from './gameModes/kingOfTheHillMode';
import { drawScoreBoard, drawTimer } from '../renderer/hudRenderer';
import { PowerupManager } from './powerups/powerupManager';
import { SpringPadManager } from './springPadManager';
import { SpikeManager } from './spikeManager';
import { DynamicItemManager } from './dynamicItemManager';
import { TriggerManager } from './triggerManager';
import { ActionManager } from './actionManager';
import { PlatformMover } from './platformMover';
import { CameraFollower } from '../renderer/cameraFollower';
import { SpectatorDirector } from '../renderer/spectatorCamera';
import { Vec2 } from '../physics/vec2';
import { EffectsBindings } from './effectsBindings';
import { updateParticles, clearParticles } from '../renderer/particles';
import { clearDecals, setDecalBudget, setDecalResolvers } from '../renderer/decals';
import { preloadAll, SFX_NAMES, resumeAudio } from '../utils/audio';
import { getPacingConfig } from '../lib/pacingConfig';
import { consumeStep } from '../lib/frameStep';
import { recordHash, type TickSummary } from '../lib/hashHistory';
import { computeMapAABB, STATIC_MAP_FIT_ZOOM, readStaticCamOverride, FALL_KILL_MARGIN, lavaKillPlaneY } from './mapBounds';

/** Per-tick PRE/POST hash trace logging. Spammy (every tick on host AND
 *  guest), only enable via `?detTrace=1` URL flag when bisecting a
 *  cross-tab determinism mismatch. Disabled by default — without this
 *  gate the console floods with thousands of `[detTrace]` lines per
 *  game which makes ANY other warning/error impossible to spot. */
const detTraceEnabled = (() => {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URLSearchParams(window.location.search).get('detTrace') === '1';
  } catch { return false; }
})();

/** Content camera for the match-shorts recorder (`?shorts=1`). Bots-only
 *  matches normally hold the full-arena wide shot (fit-all with minZoom
 *  0.254), which leaves a portrait 1080×1920 frame mostly empty. This flag
 *  tightens the follow: higher zoom floor + less padding, accepting that a
 *  blob at the far wall occasionally clips offscreen — the camera stays on
 *  the pack, which is what a short wants. Render-only; never affects sim. */
const shortsCamEnabled = (() => {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URLSearchParams(window.location.search).get('shorts') === '1';
  } catch { return false; }
})();

/** Spectator camera for the match-shorts recorder (`?spectate=1`). Locks the
 *  view onto a single blob — zoomed in tight so the player fills the frame —
 *  and cuts to a new blob when its target dies or the action moves elsewhere
 *  (see SpectatorDirector). Takes precedence over the `?shorts=1` wide follow.
 *  Render-only; never affects the sim. */
const spectateCamEnabled = (() => {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URLSearchParams(window.location.search).get('spectate') === '1';
  } catch { return false; }
})();

const staticCamOverride = readStaticCamOverride();

// Tiny indirection so the closure captured by the GameLoop callbacks
// reads the current pacing config every tick (overlay can toggle it
// live). Lives outside the class because both onLogic + the helper
// below need it.
function pausedFlagRef(): boolean {
  return getPacingConfig().paused;
}

/** Snapshot per-tick state for the compare-hashes diagnostic. Captures
 *  the per-blob fields most likely to surface a desync (centroid +
 *  velocity + JS-side expand integrator + engine-side shape scale)
 *  plus the global RNG state and mode phase. Cheap enough to call
 *  every tick. */
function buildTickSummary(state: BouncyBlobsGameState): TickSummary {
  const blobs: TickSummary["blobs"] = [];
  for (const p of state.playerManager.getAllPlayers()) {
    const c = p.blob.getCentroid();
    const cIdx = p.blob.centerIdx;
    const vel = state.world.vel[cIdx] ?? { x: 0, y: 0 };
    blobs.push({
      blobId: p.blob.blobId,
      label: p.playerId,
      cx: c.x, cy: c.y,
      vx: vel.x, vy: vel.y,
      expandScale: (p.blob.dumpState() as { expandShapeScale: number }).expandShapeScale,
    });
  }
  for (let i = 0; i < state.npcBlobs.length; i++) {
    const b = state.npcBlobs[i];
    const c = b.getCentroid();
    const cIdx = b.centerIdx;
    const vel = state.world.vel[cIdx] ?? { x: 0, y: 0 };
    blobs.push({
      blobId: b.blobId,
      label: `npc-${i}`,
      cx: c.x, cy: c.y,
      vx: vel.x, vy: vel.y,
      expandScale: (b.dumpState() as { expandShapeScale: number }).expandShapeScale,
    });
  }
  const mode = state.modeManager?.getState?.();
  return {
    rng: state.world.rng.getState(),
    modePhase: mode?.phase ?? '-',
    modePhaseTimer: mode?.phaseTimer ?? 0,
    blobs,
  };
}

export interface BouncyBlobsGameState {
  world: SoftBodyEngine;
  camera: Camera;
  playerManager: PlayerManager;
  npcBlobs: SlimeBlob[];
  loop: GameLoop;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  canvasWidth: number;
  canvasHeight: number;
  renderOptions: RenderOptions;
  level: LevelData;
  modeManager: GameModeManager | null;
  powerupManager: PowerupManager | null;
  springPadManager: SpringPadManager | null;
  spikeManager: SpikeManager | null;
  dynamicItemManager: DynamicItemManager | null;
  /** Drives editor-authored "trigger area" plates (formerly pressure plates). */
  triggerManager: TriggerManager | null;
  /** Polls triggers + animates platform / shape-point targets each frame. */
  actionManager: ActionManager | null;
  /** Owns moving-platform surfaces — ActionManager talks to it. */
  platformMover: PlatformMover | null;
  triggerIndices: Map<string, number>;
  /** Soft-platform info from levelLoader — id + hull-particle indices. */
  softPlatforms: Array<{ id: string; blobId: number; hullIndices: number[]; staticHullIndices: number[] }>;
  /** Point-shape (soft-blob) info — same shape as softPlatforms; rendered the same way. */
  pointShapes: Array<{ id: string; blobId: number; hullIndices: number[] }>;
  /** Editor-authored chains. */
  chains: Array<{ id: string; particleIndices: number[]; totalLength: number }>;
  /** point-shape id → ordered particle indices in the world. */
  pointShapeParticles: Map<string, number[]>;
  gameTime: number;
  cameraFollower: CameraFollower;
  effects: EffectsBindings;
  /** World-space AABB of the actual map geometry (platforms/walls/soft bodies),
   *  computed at load. Drives the camera's whole-map framing and intro shot —
   *  the real extent, not the declared `level.bounds` hint. */
  mapBounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export class BouncyBlobsGame implements Game {
  gameDefinition: GameDefinition = {
    id: 'bouncy-blobs',
    name: 'Bouncy Blobs',
    description: 'A soft-body physics party game!',
    controllerConfig: DEFAULT_CONTROLLER_CONFIG,
  };

  private state: BouncyBlobsGameState | null = null;
  private onStateChange?: () => void;
  private gameMode: GameMode | null = null;
  /** Seed for the SoftBodyEngine's deterministic RNG. Host generates a seed at
   * session start and broadcasts it via the `level_loaded` reliable event so
   * every guest's local sim consumes the same random stream. */
  private rngSeed: number = 1;
  private onPhaseChange?: (phase: GamePhase) => void;
  private onGameOver?: (winnerId: string | null, winnerName: string | null) => void;
  private broadcastToControllers?: (message: any) => void;

  setStateChangeCallback(cb: () => void): void {
    this.onStateChange = cb;
  }

  setPhaseChangeCallback(cb: (phase: GamePhase) => void): void {
    this.onPhaseChange = cb;
  }

  setGameOverCallback(cb: (winnerId: string | null, winnerName: string | null) => void): void {
    this.onGameOver = cb;
  }

  setRngSeed(seed: number): void {
    this.rngSeed = (seed >>> 0) || 1;
  }

  getRngSeed(): number {
    return this.rngSeed;
  }

  /** Pre-tick gate. If installed and returns false, the logic tick is
   * skipped — physics doesn't step, world.tick doesn't advance, the
   * accumulator doesn't drain. Use case: lockstep guest, which pauses
   * its sim when it doesn't yet have the host's authoritative inputs
   * for the next tick. Default: always allow (single-player + host). */
  private logicGate: ((world: SoftBodyEngine) => boolean) | null = null;
  /** Post-tick hook. Called once per successfully-completed logic tick,
   * AFTER physics has advanced. Use case: host broadcasts the inputs
   * that were just applied, tagged with the exact tick they applied at. */
  private postTickHook: ((world: SoftBodyEngine) => void) | null = null;
  /** Pre-tick hook. Called once per logic tick, AFTER AI controllers have
   * filled ManagedPlayer.moveX/Y/expanding with their intent for this tick,
   * BUT BEFORE the blob.setInput call that pushes those values into physics.
   * Use case: the host's input-delay layer snapshots intents, schedules
   * them for tick T+N, broadcasts the scheduled set tagged T+N (so the
   * message reaches guests N ticks before they need it), then overwrites
   * ManagedPlayer.* with the delayed value previously scheduled for T. */
  private preTickHook: ((world: SoftBodyEngine) => void) | null = null;
  /** Dynamic cap on logic steps per RAF. Lockstep guests set this to keep
   * the sim from burst-fast-forwarding when an input-buffer arrival was
   * jittery. */
  private maxStepsGetter: (() => number) | null = null;
  /** Optional replacement for the per-tick physics step. When set, onLogic
   * calls this INSTEAD of stepOneTick — used by the NetPeer netcode path,
   * which gathers local inputs, runs the symmetric tick-tagged rollback
   * advance (apply + snapshot + step), and sends the tagged inputs. Returning
   * false means "held" (speculation cap); the loop keeps the accumulator. */
  private stepDriver: ((dt: number) => boolean) | null = null;
  /** Per-RAF clock adjustment (seconds) for netcode time-sync — see GameLoop. */
  private clockAdjustGetter: (() => number) | null = null;
  /** Camera framing override. 'auto' = the default small-map-fit heuristic
   *  (whole arena if it fits, else follow local players). 'follow-local' forces
   *  following this client's own player(s) — multiplayer "watch my blob" view.
   *  'fit-all' forces the whole-arena view (e.g. chained/co-op levels). */
  private cameraMode: 'auto' | 'follow-local' | 'fit-all' = 'auto';
  /** Player IDs the camera should follow. If null, follows ALL players
   * (legacy behavior). When set, the camera tracks only these blobs and
   * uses a fixed-zoom view targeted at ~10% blob-on-screen. Used by the
   * host (laptop local player) and online guests so the view stays
   * centered on the player(s) controlled on THIS machine. */
  private localPlayerIds: Set<string> | null = null;
  /** Last game phase the camera saw — to fire the round-start establishing
   *  shot exactly once, on the transition INTO countdown. */
  private lastCameraPhase: GamePhase | null = null;
  /** Drives the `?spectate=1` content camera (one-blob follow + auto cuts). */
  private spectatorDirector = new SpectatorDirector();

  // ── Render-state separation (physics→render interpolation + smoothing) ──────
  /** Optional external render-offset source — the page's DisplaySmoother. Its
   *  PER-NODE offsets (post-rollback ease-in, incl. shape/expansion) are composed
   *  with physics→render interpolation. `tick()` decays them once per frame. */
  private renderOffsetSource: { tick: () => void; getNodeOffsets: (blobId: number) => { x: number; y: number }[] | null } | null = null;
  /** Each blob's HULL NODES at the START of the most recent logic tick — the
   *  "previous" endpoint for per-node interpolation (so SHAPE changes like
   *  expansion lerp too, not just the centroid). Keyed by blobId. */
  private prevHulls = new Map<number, { x: number; y: number }[]>();
  /** Camera pose at the start of the most recent logic tick, so the camera can
   *  interpolate in lockstep with the blobs (keeps world geometry and blobs
   *  moving together — avoids the ghosting the old fixed-dt camera dodged). */
  private prevCameraPos: { x: number; y: number } | null = null;
  private prevCameraZoom = 1;
  /** Debug: overlay each blob's RAW physics hull nodes (un-interpolated) so you
   *  can see how detached the sim is from the smoothed visuals. */
  private showPhysicsPoints = false;
  setShowPhysicsPoints(on: boolean): void { this.showPhysicsPoints = on; }

  setLocalPlayerIds(ids: string[] | null): void {
    this.localPlayerIds = ids ? new Set(ids) : null;
  }

  setLogicGate(fn: ((world: SoftBodyEngine) => boolean) | null): void {
    this.logicGate = fn;
  }

  setPostTickHook(fn: ((world: SoftBodyEngine) => void) | null): void {
    this.postTickHook = fn;
  }

  setPreTickHook(fn: ((world: SoftBodyEngine) => void) | null): void {
    this.preTickHook = fn;
  }

  setMaxStepsPerFrame(fn: (() => number) | null): void {
    this.maxStepsGetter = fn;
  }

  /** Install/clear the NetPeer step driver (see field doc). When set it
   *  replaces the default stepOneTick call inside onLogic. */
  setStepDriver(fn: ((dt: number) => boolean) | null): void {
    this.stepDriver = fn;
  }

  /** Install/clear the per-RAF clock-adjust getter (netcode time-sync). */
  setClockAdjust(fn: (() => number) | null): void {
    this.clockAdjustGetter = fn;
  }

  /** Override camera framing. See the `cameraMode` field doc. */
  setCameraMode(mode: 'auto' | 'follow-local' | 'fit-all'): void {
    this.cameraMode = mode;
  }

  /** Install/clear the external render-offset source (the page's
   *  DisplaySmoother) so post-rollback corrections ease in instead of snapping.
   *  Pure render concern — never affects the sim. */
  setRenderOffsetSource(
    src: { tick: () => void; getNodeOffsets: (blobId: number) => { x: number; y: number }[] | null } | null,
  ): void {
    this.renderOffsetSource = src;
  }

  /** Snapshot each blob's HULL NODES + camera pose at the START of a logic tick so
   *  onRender can interpolate per-node from here to the post-step state by the
   *  accumulator alpha. Per-node (not centroid) so SHAPE changes (expansion) lerp
   *  too. Called once per live tick, before stepOneTick. */
  private captureRenderPrev(): void {
    const s = this.state;
    if (!s) return;
    this.prevHulls.clear();
    for (const p of s.playerManager.getAllPlayers()) {
      this.prevHulls.set(p.blob.blobId, p.blob.getHullPolygon().map((v) => ({ x: v.x, y: v.y })));
    }
    for (const b of s.npcBlobs) {
      if (b.destroyed) continue;
      this.prevHulls.set(b.blobId, b.getHullPolygon().map((v) => ({ x: v.x, y: v.y })));
    }
    this.prevCameraPos = { x: s.camera.position.x, y: s.camera.position.y };
    this.prevCameraZoom = s.camera.zoom;
  }

  /** Build the per-blob INTERPOLATED HULL for this frame: per node,
   *  lerp(prev, cur, alpha) + smoother offset (post-rollback ease-in). Renderers
   *  draw this hull instead of the raw physics one, so both motion AND shape
   *  (expansion/retraction) ease instead of snapping. */
  private computeRenderHulls(alpha: number): Map<number, { x: number; y: number }[]> {
    const out = new Map<number, { x: number; y: number }[]>();
    const s = this.state;
    if (!s) return out;
    const back = 1 - alpha; // weight on the previous (start-of-tick) position
    // Per-node jump beyond this is a teleport (respawn/park) → snap, don't streak.
    const TELEPORT_SQ = 500 * 500;
    const build = (blobId: number, cur: { x: number; y: number }[]) => {
      const prev = this.prevHulls.get(blobId);
      const ext = this.renderOffsetSource?.getNodeOffsets(blobId);
      const usePrev = prev !== undefined && prev.length === cur.length;
      if (!usePrev && !ext) return; // nothing to interpolate/smooth → renderer uses raw hull
      const hull = cur.map((c, i) => {
        let x = c.x, y = c.y;
        if (usePrev) {
          const dx = prev![i].x - c.x, dy = prev![i].y - c.y;
          if (dx * dx + dy * dy <= TELEPORT_SQ) { x += dx * back; y += dy * back; }
        }
        if (ext && ext[i]) { x += ext[i].x; y += ext[i].y; }
        return { x, y };
      });
      out.set(blobId, hull);
    };
    for (const p of s.playerManager.getAllPlayers()) build(p.blob.blobId, p.blob.getHullPolygon());
    for (const b of s.npcBlobs) { if (!b.destroyed) build(b.blobId, b.getHullPolygon()); }
    return out;
  }

  /** Typed accessor for the live sim state. Replaces the `as unknown as
   *  { state }` casts the rollback replay paths used to reach into the
   *  managers. Returns null before init / after teardown. */
  getSimState(): BouncyBlobsGameState | null {
    return this.state;
  }

  /** Advance the simulation by exactly one fixed logic step.
   *
   *  THE single source of truth for "step the sim once" — driven by both the
   *  live game loop (`onLogic`, below) and rollback replay (RollbackController's
   *  `stepOne`). Keeping them on one code path is what makes forward sim and
   *  restore→replay bit-identical; the old hand-copied replay sequence used
   *  `updateAll` (re-deriving AI), skipped the trigger/action managers, and
   *  truncated `effects.update`'s args — all silent replay-divergence sources.
   *
   *  Opts:
   *   - `runAI` (default true): re-decide AI/bot inputs this tick. Replay passes
   *     FALSE — bot inputs come from the recorded InputSet the controller
   *     re-applies, so AI-controller internal state (timers etc., which are NOT
   *     in the engine snapshot) is never advanced a second time during a rewind.
   *   - `runPreTick` (default true): fire the host's `preTickHook` (input
   *     scheduling + broadcast). Replay passes FALSE — re-broadcasting mid-rewind
   *     would duplicate inputs on the wire.
   *
   *  Does NOT advance `gameTime`, particles, camera, or the hash ring — those are
   *  per-RAF / diagnostic concerns the callers own. */
  stepOneTick(dt: number, opts?: { runPreTick?: boolean; runAI?: boolean }): void {
    const s = this.state;
    if (!s) return;
    const runPreTick = opts?.runPreTick ?? true;
    const runAI = opts?.runAI ?? true;
    const {
      world, playerManager, npcBlobs, powerupManager, springPadManager,
      spikeManager, dynamicItemManager, triggerManager, actionManager, modeManager,
    } = s;

    let t0 = performance.now();
    if (runAI) playerManager.tickAIInputs(dt, world);
    if (runPreTick) this.preTickHook?.(world);
    playerManager.applyInputsAndStep(dt);
    // DETERMINISM DIAGNOSTIC (live path only — suppressed during replay so a
    // rewind doesn't spam the trace). PRE = engine hash + per-player input
    // after applyInputsAndStep but before world.step; POST (below) = hash after
    // world.step. See the long-form note this block replaced for the full
    // PRE/POST cross-tab divergence-bisection method.
    if (runPreTick && detTraceEnabled) {
      const nextTick = world.tick + 1;
      const parts: string[] = [];
      for (const p of playerManager.getAllPlayers()) {
        parts.push(`${p.playerId}:${p.moveX.toFixed(3)},${p.moveY.toFixed(3)},${p.expanding ? 1 : 0}`);
      }
      console.info(`[detTrace] PRE tick=${nextTick} hash=${world.stateHash()} inputs=[${parts.join(' | ')}]`);
    }
    recordPhaseTime('playerMgr', performance.now() - t0);

    t0 = performance.now();
    world.step(dt);
    if (runPreTick && detTraceEnabled) {
      console.info(`[detTrace] POST tick=${world.tick} hash=${world.stateHash()}`);
    }
    recordPhaseTime('worldStep', performance.now() - t0);

    t0 = performance.now();
    powerupManager?.update(dt, playerManager);
    springPadManager?.update(dt);
    spikeManager?.update(dt);
    dynamicItemManager?.update(dt);
    // Trigger/action managers run only in mode-managed play (they're null in
    // sandbox). Gating on modeManager reproduces the original onLogic branch
    // split while letting both branches share this one method.
    if (modeManager) {
      triggerManager?.update(dt);
      actionManager?.update(dt);
    }
    recordPhaseTime('managers', performance.now() - t0);

    t0 = performance.now();
    s.effects.update(
      dt, playerManager, npcBlobs, world,
      [...s.softPlatforms, ...s.pointShapes],
      s.platformMover ?? undefined,
      s.spikeManager ? (playerId) => s.spikeManager!.isDead(playerId) : undefined,
      s.springPadManager ?? undefined,
    );
    recordPhaseTime('effects', performance.now() - t0);
  }

  setGameMode(mode: GameMode): void {
    this.gameMode = mode;
  }

  setBroadcastToControllers(cb: (message: any) => void): void {
    this.broadcastToControllers = cb;
  }

  broadcast(message: any): void {
    this.broadcastToControllers?.(message);
  }

  initialize(_context: GameContext): GameState {
    // Lazy-load all SFX in the background. Files are tiny so this is fine
    // to do every game-init; preloadSfx is idempotent on cache hits.
    preloadAll(SFX_NAMES);

    // Sprite registry preload — fire-and-forget. Renderers fall back to
    // their primitive drawing if a sprite hasn't arrived yet, so the first
    // frames are safe to draw before this resolves.
    void preloadSprites();
    // Background image — same fire-and-forget; renderer falls back to the
    // solid color until it's ready.
    preloadBackground();

    // Use the game mode's level if available, otherwise fall back
    const level = this.gameMode?.getLevel() ?? this.state?.level ?? defaultLevel;

    const world = createSoftBodyEngine({
      // 4 substeps: enough for normal CCD on the integer engine.
      // The prev_poly kinematic-CCD sweep (StaticSurface.prev_poly +
      // sweep_static_ccd in world.rs) catches fast-moving platforms
      // tunneling between commits, which previously needed 8 substeps
      // to mask. The discrete pass also iterates 3× to untangle deep
      // merges. At 8 substeps × 3 iterations the logic tick ran ~6ms,
      // burning the whole 60Hz vsync budget; at 4 substeps it's ~3ms
      // with the same gameplay behavior.
      substeps: 4,
      gravityScale: 4.0,
      rngSeed: this.rngSeed,
    });

    const getSpriteShape: GetSpriteShape = (id) => getSprite(id)?.def.shape ?? null;
    const {
      playerSpawnPoints, npcBlobs, triggerIndices,
      softPlatforms, pointShapes, chains, pointShapeParticles,
      triggerShapeIdxToId, softPlatformStaticParticles, platformSurfaces,
    } = loadLevel(world, level, getSpriteShape);
    const playerManager = new PlayerManager(playerSpawnPoints);
    const mapBounds = computeMapAABB(
      world, level, platformSurfaces, softPlatforms, pointShapes, playerSpawnPoints,
    );
    const camera = new Camera();
    // Open on the whole arena. The intro (see the camera block in onLogic) then
    // zooms onto the players during the countdown. Canvas isn't sized yet here,
    // so seed with the declared zoom; the first sized tick reframes correctly.
    camera.snapTo(playerSpawnPoints[0] ?? { x: 0, y: 400 }, 0.592);

    const renderOptions: RenderOptions = {
      showSprings: false,
      showShapeTargets: false,
      showPoints: false,
    };

    const effects = new EffectsBindings();

    // Create mode manager if a game mode is set
    let modeManager: GameModeManager | null = null;
    if (this.gameMode) {
      modeManager = new GameModeManager(this.gameMode, {
        onPhaseChange: (phase) => {
          // Wipe the round's slime splats whenever the round itself ends.
          if (phase !== 'playing') clearDecals();
          // Size the decal budget to the round's roster — more players paint
          // more, so they get a larger splat budget (capped inside setDecalBudget).
          else setDecalBudget(playerManager.getPlayerCount());
          logMatchEvent('phase', { phase });
          effects.onPhaseChange(phase);
          this.onPhaseChange?.(phase);
        },
        onGameOver: (winnerId, winnerName) => {
          logMatchEvent('win', { winnerId, winnerName });
          effects.onGameOver();
          this.onGameOver?.(winnerId, winnerName);
        },
      });
      modeManager.initialize(world, playerManager, triggerIndices);
    }

    // Create powerup manager if level has powerup spawns
    let powerupManager: PowerupManager | null = null;
    if (level.powerupSpawns && level.powerupSpawns.length > 0) {
      powerupManager = new PowerupManager();
      powerupManager.initialize(world, level.powerupSpawns);
      powerupManager.onCollect = (player, color, position) => {
        effects.onPowerupCollect(player, color, position);
      };
    }

    // Create spring pad manager if the level has spring pads.
    let springPadManager: SpringPadManager | null = null;
    if (level.springPads && level.springPads.length > 0) {
      springPadManager = new SpringPadManager();
      springPadManager.initialize(world, level.springPads ?? []);
      springPadManager.onFire = (pos, dir) => effects.onSpringFire(pos, dir);
    }

    // Spike manager is always created: besides spikes it owns the death-zone
    // and fall-off-the-map kill plane, which every mode needs so a blob that
    // drops out of the world dies (and respawns per the mode's death mode).
    const spikeManager: SpikeManager = new SpikeManager();
    spikeManager.initialize(world, playerManager, level.spikes ?? [], npcBlobs);
    if (level.deathZones?.length) spikeManager.setDeathZones(level.deathZones);
    // Kill anyone (players AND NPCs) who falls FALL_KILL_MARGIN units below the
    // lowest point of the actual map geometry (load-time AABB) — i.e. they've
    // left the arena. The in-game lava is drawn at this same Y.
    spikeManager.setKillBelowY(mapBounds.maxY + FALL_KILL_MARGIN);

    // Set death mode based on game mode type
    if (this.gameMode instanceof KingOfTheHillMode) {
      spikeManager.deathMode = 'timer';
    }

    // Create dynamic item manager. Originally party-mode-only, but
    // levels with a `dynamicItems` field (e.g. det-test, custom maps)
    // need it regardless of game mode. Create whenever the level
    // declares items OR party mode is active.
    let dynamicItemManager: DynamicItemManager | null = null;
    const levelDynamicItems = (level as unknown as { dynamicItems?: Array<{ id: string; type: string; x: number; y: number; width: number; height: number; rotation: number }> }).dynamicItems ?? [];
    if (levelDynamicItems.length > 0) {
      dynamicItemManager = new DynamicItemManager();
      dynamicItemManager.initialize(world, playerManager);
      // Auto-register items from level data. Party mode adds items
      // dynamically at runtime via partyMode.placeItem, so it has its
      // own flow — but level-defined items always get loaded here.
      for (const item of levelDynamicItems) {
        dynamicItemManager.addItem(
          item.id,
          item.type as Parameters<DynamicItemManager['addItem']>[1],
          item.x, item.y, item.width, item.height, item.rotation,
        );
      }
    }

    // Trigger / action / platform-mover wiring. Previously these were
    // only set up in Sandbox (the editor's Test Play path); host / online
    // play went through this `initialize()` which never created them, so
    // editor-authored triggers and actions were silently dead in real
    // gameplay. The level loader already registers the trigger polygons
    // in the physics world — we just need the JS-side managers that poll
    // them and drive their actions.
    const platformMover = new PlatformMover();
    platformMover.initialize(level.platforms, platformSurfaces, world);

    // Wire the decal renderer's anchor resolvers so splats on moving platforms,
    // spring plates, and soft bodies follow those surfaces as they move. (This
    // is the game path — Sandbox/PlayLevel wire their own equivalents.)
    setDecalResolvers({
      getPlatformLivePos: (id) => platformMover.getLivePosition(id),
      getPlatformLivePoly: (id) => platformMover.getLivePoly(id),
      getParticlePos: (idx) => world.pos[idx] ?? null,
      getSpringLivePos: (id) => springPadManager?.getSpringLivePosition(id) ?? null,
    });

    const npcBlobIds = new Set(npcBlobs.map(b => b.blobId));
    const triggerManager = new TriggerManager();
    triggerManager.initialize(
      world,
      level.triggers ?? [],
      triggerShapeIdxToId,
      (blobId) => npcBlobIds.has(blobId),
      (blobId) => playerManager.getPlayerByBlobId(blobId) !== undefined,
    );

    const actionManager = new ActionManager();
    actionManager.initialize(
      world,
      level.actions ?? [],
      pointShapeParticles,
      softPlatformStaticParticles,
      platformMover,
      triggerManager,
      spikeManager,
    );

    // Universal spike-kill SFX/VFX.
    if (spikeManager) {
      spikeManager.onKill = (killedPlayerId, deathPos) => {
        const player = playerManager.getPlayer(killedPlayerId);
        if (player) effects.onSpikeKill(player, deathPos);
        logMatchEvent('ko', {
          playerId: killedPlayerId,
          name: player?.name ?? killedPlayerId,
          x: deathPos.x,
          y: deathPos.y,
        });
      };
    }

    // Physics crush events: wired unconditionally. The Rust solver flags
    // a blob whose hull has stretched past CRUSH_HULL_SPREAD_RATIO_SQ ×
    // rest extent — typically a blob pinched against static geometry by
    // a moving platform. The Rust side has already collapsed the blob's
    // particles back to its centroid (defense in depth); here we route
    // the event through the death pipeline when a spike manager exists,
    // and log otherwise so the dev-mode dropout is visible.
    const sm = spikeManager;
    world.onBlobCrushed = (blobId) => {
      console.warn(`[physics] blob ${blobId} crushed — collapsed in solver`);
      sm?.killPlayerByBlobId(blobId);
    };

    // 1 Hz score sampler for the match-event log: emits lead_change /
    // near_target as the mode scores evolve, plus a coarse score_sample
    // every 5 s so the highlight picker can reconstruct the score curve.
    // Observation only — never feeds back into the sim.
    let scoreSampleAccum = 0;
    let scoreSampleCount = 0;
    let lastLeaderId: string | null = null;
    let nearTargetLogged = false;
    const sampleScores = (modeManager: GameModeManager, dt: number): void => {
      if (modeManager.getPhase() !== 'playing') return;
      scoreSampleAccum += dt;
      if (scoreSampleAccum < 1) return;
      scoreSampleAccum = 0;
      scoreSampleCount++;
      const state = modeManager.getState();
      let leaderId: string | null = null;
      let leaderScore = -Infinity;
      for (const [id, score] of state.scores) {
        if (score > leaderScore) { leaderScore = score; leaderId = id; }
      }
      if (leaderId !== null && leaderScore > 0 && leaderId !== lastLeaderId) {
        // Skip the very first leader (someone scoring first isn't a "lead change").
        if (lastLeaderId !== null) {
          logMatchEvent('lead_change', {
            playerId: leaderId,
            name: playerManager.getPlayer(leaderId)?.name ?? leaderId,
            score: leaderScore,
          });
        }
        lastLeaderId = leaderId;
      }
      const target = this.gameMode?.config.targetScore;
      if (!nearTargetLogged && target && leaderId !== null && leaderScore >= target * 0.8) {
        nearTargetLogged = true;
        logMatchEvent('near_target', {
          playerId: leaderId,
          name: playerManager.getPlayer(leaderId)?.name ?? leaderId,
          score: leaderScore,
          target,
        });
      }
      if (scoreSampleCount % 5 === 0) {
        logMatchEvent('score_sample', { scores: Object.fromEntries(state.scores) });
      }
    };

    const loop = new GameLoop({
      getMaxSteps: () => this.maxStepsGetter?.() ?? 5,
      getClockAdjust: () => this.clockAdjustGetter?.() ?? 0,
      onLogic: (dt) => {
      if (!this.state) return false;

      // Global pause — both host and guest stop ticking. Used by the
      // compare-hashes diagnostic so we can freeze both sides and
      // inspect per-tick state without the sim moving under us. Reads
      // pacingConfig.paused live; toggleable from the debug overlay.
      // Paused: normally skip the tick — UNLESS a manual single-step was
      // requested (debug frame-stepping), in which case run exactly one tick.
      if (pausedFlagRef() && !consumeStep()) return false;

      // Pre-tick gate: a lockstep guest pauses its sim here while
      // waiting for the host's authoritative inputs for the next tick.
      // Returning false tells GameLoop to keep the accumulator full so
      // we'll try again on the next RAF.
      if (this.logicGate && !this.logicGate(this.state.world)) return false;

      // Snapshot pre-step centroids + camera so onRender can interpolate between
      // this tick and the next by the accumulator alpha (render-state vs
      // physics-state separation).
      this.captureRenderPrev();

      const { modeManager } = this.state;

      if (modeManager) {
        // Game mode controls when physics runs.
        const shouldRunPhysics = modeManager.update(dt, playerManager, world);
        sampleScores(modeManager, dt);
        if (shouldRunPhysics) {
          // NetPeer path drives the step (gather inputs → tick-tagged rollback
          // advance → send); otherwise the default single-source-of-truth step.
          if (this.stepDriver) this.stepDriver(dt);
          else this.stepOneTick(dt, { runPreTick: true, runAI: true });
        }
        // Countdown ticks fire even though physics is frozen.
        if (modeManager.getPhase() === 'countdown') {
          this.state.effects.onCountdownTimer(modeManager.getState().phaseTimer);
        }
      } else {
        // Sandbox mode — always run. Same shared step (modeManager is null, so
        // stepOneTick skips the trigger/action managers, as this branch did).
        if (this.stepDriver) this.stepDriver(dt);
        else this.stepOneTick(dt, { runPreTick: true, runAI: true });
      }

      // Particles tick every frame regardless of physics — so a dying frame
      // of dust still finishes its arc when the round ends.
      updateParticles(dt);

      this.state.gameTime += dt;

      // Camera: follow actual centroids, lerp the camera itself (once per
      // physics tick). Lives in onLogic — NOT onRender — so the camera
      // moves in lockstep with the physics tick. Decoupling them (camera
      // lerping at wall-clock RAF rate while blobs update at FIXED_DT)
      // produces a visible "ghosting" / double-image artifact at high
      // blob speeds because the camera transform shifts mid-physics-step
      // relative to the last drawn blob position.
      const localIds = this.localPlayerIds;
      const isLocal = (pid: string) => localIds === null || localIds.has(pid);
      const cameraTargets: Vec2[] = playerManager.getAllPlayers()
        .filter(p => isLocal(p.playerId) && !spikeManager?.isDead(p.playerId))
        .map(p => p.blob.getCentroid());

      if (spikeManager) {
        const deadMap = spikeManager.getDeadPlayers();
        if (deadMap.size > 0) {
          const spawnPoints = playerManager.getSpawnPoints();
          const defaultSpawn = spawnPoints[0] ?? { x: 0, y: 400 };
          const { cameraFollower } = this.state;
          const deadTargets = Array.from(deadMap)
            .filter(([pid]) => isLocal(pid))
            .map(([pid, dead]) => ({
              id: pid,
              deathPosition: dead.deathPosition,
              driftTo: defaultSpawn,
            }));
          cameraFollower.update(dt, [], deadTargets);
          cameraTargets.push(...cameraFollower.getPositions());
        }
      }

      // --- Camera framing ----------------------------------------------------
      // Everything keys off mapBounds: the world-space AABB of the actual map
      // geometry (platforms/walls/soft bodies), computed at load.
      const { mapBounds } = this.state;
      const { minX, minY, maxX, maxY } = mapBounds;
      const canW = this.state.canvasWidth;
      const canH = this.state.canvasHeight;

      // Round-start establishing shot: the moment a countdown begins, snap to
      // the whole arena. The follow code below then eases onto the players over
      // the countdown, so by "GO" the camera has zoomed in on the action.
      const phase = modeManager?.getPhase() ?? null;
      if (phase === 'countdown' && this.lastCameraPhase !== 'countdown' && canW > 0) {
        camera.snapToBounds(minX, minY, maxX, maxY, canW, canH);
      }
      this.lastCameraPhase = phase;

      // Small-map static camera: if the whole arena fits on screen at a
      // comfortable zoom, stop following anyone and just watch the full map
      // (KOTH-style). Decided every tick so it survives canvas resizes; takes
      // precedence over every follow mode below.
      // Camera-mode override (multiplayer "watch my blob" vs co-op "fit all")
      // takes precedence over the auto small-map-fit heuristic.
      const watchWholeMap = canW > 0 && (
        this.cameraMode === 'follow-local' ? false
          : this.cameraMode === 'fit-all' ? true
          : staticCamOverride !== null
            ? staticCamOverride
            : Camera.boundsFitZoom(minX, minY, maxX, maxY, canW, canH) >= STATIC_MAP_FIT_ZOOM
      );

      if (watchWholeMap) {
        camera.watchBounds(minX, minY, maxX, maxY, canW, canH);
        camera.update(dt);
      } else if (spectateCamEnabled && this.state.canvasWidth > 0) {
        // Spectator content camera: ignore the local-player filtering and
        // direct the shot from ALL blobs (bots have no local id). The
        // director picks one to follow and frames it tight.
        const scores = modeManager?.getState().scores;
        const allPlayers = playerManager.getAllPlayers();
        const specBlobs = allPlayers.map((p) => ({
          id: p.playerId,
          pos: p.blob.getCentroid(),
          dead: spikeManager?.isDead(p.playerId) ?? false,
          score: scores?.get(p.playerId) ?? 0,
        }));
        // In racing modes, direct the camera as a race: follow first place
        // (closest to the goal). KOTH/brawl modes pass null → action-follow.
        let raceGoal: Vec2 | null = null;
        const mode = modeManager?.getMode();
        const lvlTypes = mode ? getLevelTypes(mode.getLevel()) : [];
        const isRace = lvlTypes.includes('solo_racing') || lvlTypes.includes('team_racing');
        if (isRace && mode?.getGoalForBlob && allPlayers[0]) {
          const g = mode.getGoalForBlob(allPlayers[0], modeManager!.getState());
          if (g) raceGoal = { x: g.x, y: g.y };
        }
        if (specBlobs.length > 0) {
          const f = this.spectatorDirector.update(dt, specBlobs, raceGoal);
          camera.followTargets(
            f.targets,
            this.state.canvasWidth,
            this.state.canvasHeight,
            f.padding,
            f.maxZoom,
            f.minZoom,
          );
          camera.update(dt);
        }
      } else if (cameraTargets.length > 0 && this.state.canvasWidth > 0) {
        // When following only the local player(s): pin the resting view
        // so a single blob is ~5% of the SHORTER screen dimension. Using
        // min(width, height) keeps the blob feeling the same physical
        // size across aspect ratios (ultrawide, square, portrait) — if
        // we keyed off width, an ultrawide would make the blob tiny;
        // off height, a portrait window would make it tiny. If local
        // blobs spread past this view, we zoom OUT to fit.
        // BLOB_RADIUS = 48 → diameter 96. 96 / 0.05 = 1920 world units
        // along the shorter axis at rest.
        if (localIds !== null) {
          const REF_DIM = Math.min(this.state.canvasWidth, this.state.canvasHeight);
          const MIN_VISIBLE_WORLD_DIM = 1920;
          const maxZoom = REF_DIM / MIN_VISIBLE_WORLD_DIM;
          camera.followTargets(
            cameraTargets,
            this.state.canvasWidth,
            this.state.canvasHeight,
            200,
            maxZoom,
            0, // no lower clamp — let the view zoom out as far as it needs to
          );
        } else if (shortsCamEnabled) {
          camera.followTargets(cameraTargets, this.state.canvasWidth, this.state.canvasHeight, 120, 0.592, 0.5);
        } else {
          camera.followTargets(cameraTargets, this.state.canvasWidth, this.state.canvasHeight);
        }
        camera.update(dt);
      }

      // Post-tick hook — host uses this to broadcast the inputs that
      // were just applied, tagged with the exact world.tick they
      // applied at. Inside the game loop guarantees per-tick precision.
      this.postTickHook?.(this.state.world);

      // Record the post-step stateHash for the compare-hashes
      // diagnostic. Both host and guest record into the same ring;
      // the overlay's compare button pulls both sides' rings and
      // displays them side-by-side per tick.
      recordHash(
        this.state.world.tick,
        this.state.world.stateHash(),
        buildTickSummary(this.state),
      );

      return true;
      },
      onRender: (alphaRaw: number) => {
        if (!this.state || !this.state.ctx) return;

        // INTERPOLATE only — never EXTRAPOLATE. When the sim is paused or a RAF
        // ran no logic step, the loop's accumulator overruns and alpha climbs
        // past 1; without clamping, the blob/camera interpolation would project
        // past the current position and the whole view drifts off ("float off
        // when paused"). Clamp to [0,1] so a frozen sim renders frozen.
        const alpha = Math.max(0, Math.min(1, alphaRaw));

        // Decay the external smoother (post-rollback ease-in) once per frame.
        this.renderOffsetSource?.tick();
        // Per-blob INTERPOLATED HULLS: per-node physics→render interp + smoothing
        // (so expansion/shape eases, not just position).
        const renderHulls = this.computeRenderHulls(alpha);

        // Interpolate the camera by the SAME alpha so world geometry and blobs
        // move together (else the static world steps at tick rate while blobs
        // glide). Mutate camera pose for the draw, then restore so the next
        // tick's follow logic sees the true post-step pose.
        const savedCamX = camera.position.x;
        const savedCamY = camera.position.y;
        const savedCamZoom = camera.zoom;
        if (this.prevCameraPos) {
          const back = 1 - alpha;
          camera.position.x = savedCamX + (this.prevCameraPos.x - savedCamX) * back;
          camera.position.y = savedCamY + (this.prevCameraPos.y - savedCamY) * back;
          camera.zoom = savedCamZoom + (this.prevCameraZoom - savedCamZoom) * back;
        }

        // Dead players are hidden entirely while their respawn countdown runs —
        // the engine parks the blob off-screen (y = -9999) and SpikeManager draws
        // the ghost-X + timer in its place, so rendering the blob here would only
        // produce the death-frame "teleport up" interpolation artifact. Filter
        // once and derive BOTH the blob list and playerRenderData from it so the
        // index correlation canvasRenderer relies on (playerBlobs[i] ↔ data[i])
        // is preserved. isDead() is a safe no-op without a spike/death mode.
        const alivePlayers = playerManager
          .getAllPlayers()
          .filter(p => !spikeManager?.isDead(p.playerId));
        // Build player render data for faces and custom colors
        const playerRenderData: PlayerRenderData[] = alivePlayers.map(p => ({
          name: p.name,
          color: p.color,
          faceId: p.faceId,
          expanding: p.blob.isExpanding(),
          expandScale: p.blob.getExpandScale(),
          gaze: { x: p.gazeX, y: p.gazeY },
        }));

        render(
          this.state.ctx,
          world,
          camera,
          alivePlayers.map(p => p.blob),
          npcBlobs,
          this.state.canvasWidth,
          this.state.canvasHeight,
          renderOptions,
          // Pass mode manager for overlay rendering
          modeManager || powerupManager || springPadManager || spikeManager || dynamicItemManager || triggerManager
            ? {
                renderWorld: (ctx) => {
                  modeManager?.renderWorld(ctx, camera, playerManager);
                  springPadManager?.render(ctx);
                  powerupManager?.render(ctx);
                  spikeManager?.render(ctx);
                  spikeManager?.renderDeadPlayers(ctx);
                  dynamicItemManager?.render(ctx);
                  triggerManager.render(ctx);
                },
                renderHUD: (ctx, w, h) => {
                  modeManager?.renderHUD(ctx, w, h, playerManager);
                },
              }
            : undefined,
          playerRenderData,
          [...softPlatforms, ...pointShapes],
          chains,
          lavaKillPlaneY(this.state.level, this.state.mapBounds),
          renderHulls,
          this.showPhysicsPoints,
        );

        // Restore the true post-step camera pose for the next tick's follow math.
        camera.position.x = savedCamX;
        camera.position.y = savedCamY;
        camera.zoom = savedCamZoom;
      },
    });

    this.state = {
      world,
      camera,
      playerManager,
      npcBlobs,
      loop,
      canvas: null,
      ctx: null,
      canvasWidth: 0,
      canvasHeight: 0,
      renderOptions,
      level,
      modeManager,
      powerupManager,
      springPadManager,
      spikeManager,
      dynamicItemManager,
      triggerManager,
      actionManager,
      platformMover,
      triggerIndices,
      softPlatforms,
      pointShapes,
      chains,
      pointShapeParticles,
      gameTime: 0,
      cameraFollower: new CameraFollower(),
      effects,
      mapBounds,
    };

    return {};
  }

  startRound(): void {
    this.state?.modeManager?.startRound();
  }

  getPhase(): GamePhase | null {
    return this.state?.modeManager?.getPhase() ?? null;
  }

  getModeManager(): GameModeManager | null {
    return this.state?.modeManager ?? null;
  }

  setLevel(level: LevelData): void {
    if (this.state) {
      this.state.level = level;
    }
  }

  setCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.state) return;
    this.state.canvas = canvas;
    this.state.ctx = ctx;
    this.state.canvasWidth = width;
    this.state.canvasHeight = height;
  }

  setCanvasSize(width: number, height: number): void {
    if (!this.state) return;
    this.state.canvasWidth = width;
    this.state.canvasHeight = height;
  }

  start(): void {
    // start() is invoked in response to a user gesture (clicking Start),
    // which is the right moment to flip the AudioContext from suspended to
    // running so SFX can fire from sim callbacks.
    resumeAudio();
    this.state?.loop.start();
  }

  stop(): void {
    this.state?.loop.stop();
  }

  onPlayerJoin(_context: GameContext, player: Player): void {
    if (!this.state) return;
    this.state.playerManager.addPlayer(
      player.player_id,
      player.name,
      this.state.world,
      'circle16',
      player.color,
      player.faceId,
    );
    this.onStateChange?.();
  }

  onPlayerDisconnect(_context: GameContext, playerId: string): void {
    if (!this.state) return;
    this.state.playerManager.removePlayer(playerId);
    this.onStateChange?.();
  }

  /**
   * Spawn an AI-controlled player. Uses the same blob/color/spawn pipeline as a
   * real player; the only difference is that input is generated by an AI
   * controller each tick instead of arriving over WebRTC.
   */
  addAIPlayer(
    personality: PersonalityName,
    preset?: { id?: string; name?: string; color?: string },
  ): { playerId: string; name: string; color: string } {
    if (!this.state) throw new Error('Game not initialized');
    const fresh = nextBotIdentity(personality, this.state.world.rng);
    const id = preset?.id ?? fresh.id;
    const name = preset?.name ?? fresh.name;
    const color = preset?.color ?? PERSONALITY_COLORS[personality];
    this.state.playerManager.addPlayer(id, name, this.state.world, 'circle16', color, 'default');
    const controller = new AIController(personality);
    // Wire the live goal lookup through the active game mode so personalities
    // like goal_seeker can ask "where am I trying to go right now?".
    controller.setGoalProvider((self) => {
      const mode = this.state?.modeManager?.getMode();
      const modeState = this.state?.modeManager?.getState();
      if (!mode || !modeState || !mode.getGoalForBlob) return null;
      return mode.getGoalForBlob(self, modeState);
    });
    this.state.playerManager.attachAIController(id, controller);
    this.onStateChange?.();
    return { playerId: id, name, color };
  }

  removeAIPlayer(playerId: string): void {
    if (!this.state) return;
    this.state.playerManager.removePlayer(playerId);
    this.onStateChange?.();
  }

  /** If true, input is allowed during countdown phase (used for voting). */
  private allowCountdownInput = false;

  setAllowCountdownInput(allow: boolean): void {
    this.allowCountdownInput = allow;
  }

  onPlayerCustomizationUpdate(_context: GameContext, playerId: string, color?: string, faceId?: string, name?: string): void {
    if (!this.state) return;
    this.state.playerManager.updateCustomization(playerId, color, faceId, name);
  }

  onPlayerInput(_context: GameContext, playerId: string, inputEvent: InputEvent): void {
    if (!this.state) return;

    // Freeze input during non-playing phases (allow during countdown for voting)
    const phase = this.state.modeManager?.getPhase();
    if (this.state.modeManager && phase !== 'playing') {
      if (!(this.allowCountdownInput && phase === 'countdown')) return;
    }

    const player = this.state.playerManager.getPlayer(playerId);
    if (!player) return;

    // Write BOTH the live intent (read by the netcode's readHumanInput, and held
    // between events) AND moveX/Y/expanding (single-player reads these directly;
    // under netcode they're overwritten each tick by the authoritative value, so
    // reading them back for input would make a held key decay to neutral).
    if (inputEvent.type === 'continuous' && inputEvent.inputType === 'joystick_left') {
      player.moveX = inputEvent.value.x;
      player.moveY = inputEvent.value.y ?? 0;
      player.liveInput.moveX = inputEvent.value.x;
      player.liveInput.moveY = inputEvent.value.y ?? 0;
    } else if (inputEvent.type === 'discrete' && inputEvent.inputType === 'button_right') {
      player.expanding = inputEvent.value.pressed;
      player.liveInput.expanding = inputEvent.value.pressed;
    }
  }

  render(_context: GameContext, _players: Player[], _colors: string[]): React.ReactNode {
    return null;
  }

  getPlayerManager(): PlayerManager | null {
    return this.state?.playerManager ?? null;
  }

  getWorld(): SoftBodyEngine | null {
    return this.state?.world ?? null;
  }

  getNpcBlobs(): SlimeBlob[] {
    return this.state?.npcBlobs ?? [];
  }

  /** Returns soft-platform info (id + ordered hull-particle indices) so callers
   * can read particle positions out of `getWorld().pos` without owning a
   * separate copy. Returns [] if the game isn't initialized. */
  getSoftPlatforms(): Array<{ id: string; hullIndices: number[] }> {
    return this.state?.softPlatforms ?? [];
  }

  /** Map of point-shape id → particle indices in the world. Returns an empty
   * map if there are no point shapes or the game isn't initialized. */
  getPointShapeParticles(): Map<string, number[]> {
    return this.state?.pointShapeParticles ?? new Map();
  }

  /** Stateful managers exposed for network state-sync (keyframe replication).
   * The host calls `.dumpState()` on each one to build a `manager_state`
   * reliable event alongside the keyframe; the guest calls `.restoreState()`
   * on receipt. Any new stateful manager that affects physics needs a getter
   * here and a corresponding case in GameMaster's dump and OnlineGuest's
   * restore. */
  getSpringPadManager(): SpringPadManager | null {
    return this.state?.springPadManager ?? null;
  }

  destroy(): void {
    this.stop();
    this.state?.modeManager?.cleanup();
    this.state?.powerupManager?.cleanup();
    this.state?.springPadManager?.cleanup();
    this.state?.spikeManager?.cleanup();
    this.state?.dynamicItemManager?.cleanup();
    this.state?.playerManager.clear();
    this.state?.effects.reset();
    clearParticles();
    clearDecals();
    this.state = null;
  }

  // =================================================================
  // Rollback netcode snapshot/restore.
  //
  // `snapshotGameState()` captures every TS-side piece of state that
  // affects subsequent physics outcomes — fan-out across all managers
  // and per-blob SlimeBlob state. `restoreGameState()` reverses.
  //
  // Pair with `world.serializeState()` / `world.restoreState()` (engine
  // side) per tick to enable rollback.
  // =================================================================

  /** Capture all TS-side mutable game state to a JSON-serializable
   *  object. ~1–3 KB per call depending on number of blobs + active
   *  managers. */
  snapshotGameState(): GameStateSnapshot {
    const s = this.state;
    if (!s) return { gameTime: 0, slimeBlobs: [] };
    const allBlobs: SlimeBlob[] = [];
    for (const p of s.playerManager.getAllPlayers()) allBlobs.push(p.blob);
    for (const npc of s.npcBlobs) allBlobs.push(npc);
    return {
      gameTime: s.gameTime,
      slimeBlobs: allBlobs.map(b => ({ blobId: b.blobId, state: b.dumpState() })),
      // Triggers + actions now live in the engine snapshot (serializeState),
      // so they're no longer dumped TS-side.
      springPadManager: s.springPadManager?.dumpState?.(),
      // Spikes/death/respawn now live in the engine snapshot.
      powerupManager: s.powerupManager?.dumpState?.(),
      dynamicItemManager: s.dynamicItemManager?.dumpState?.(),
      platformMover: s.platformMover?.dumpState?.(),
      modeManager: s.modeManager?.dumpState?.(),
    };
  }

  /** Restore from a snapshot captured by `snapshotGameState`. */
  restoreGameState(snap: GameStateSnapshot): void {
    const s = this.state;
    if (!s) return;
    s.gameTime = snap.gameTime;
    if (snap.slimeBlobs) {
      const byId = new Map<number, SlimeBlob>();
      for (const p of s.playerManager.getAllPlayers()) byId.set(p.blob.blobId, p.blob);
      for (const npc of s.npcBlobs) byId.set(npc.blobId, npc);
      for (const entry of snap.slimeBlobs) {
        byId.get(entry.blobId)?.restoreState(entry.state as any);
      }
    }
    if (snap.springPadManager) s.springPadManager?.restoreState?.(snap.springPadManager as any);
    if (snap.powerupManager) s.powerupManager?.restoreState?.(snap.powerupManager as any);
    if (snap.dynamicItemManager) s.dynamicItemManager?.restoreState?.(snap.dynamicItemManager as any);
    if (snap.platformMover) s.platformMover?.restoreState?.(snap.platformMover as any);
    if (snap.modeManager) s.modeManager?.restoreState?.(snap.modeManager as any);
  }
}

export interface GameStateSnapshot {
  gameTime: number;
  slimeBlobs: Array<{ blobId: number; state: unknown }>;
  actionManager?: unknown;
  triggerManager?: unknown;
  springPadManager?: unknown;
  spikeManager?: unknown;
  powerupManager?: unknown;
  dynamicItemManager?: unknown;
  platformMover?: unknown;
  modeManager?: unknown;
}
