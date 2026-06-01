import React from 'react';
import { Game, GameContext, GameDefinition, GameState } from './GameInterface';
import { SoftBodyWorld } from '../physics/softBodyWorld';
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
import { LevelData } from '../levels/types';
import { DEFAULT_CONTROLLER_CONFIG } from '../types/controllerConfig';
import { InputEvent } from '../types';
import { Player } from '../types/database';
import { GameModeManager } from './gameModes/gameModeManager';
import { GameMode, GamePhase } from './gameModes/types';
import { PartyMode } from './gameModes/partyMode';
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
import { Vec2 } from '../physics/vec2';
import { EffectsBindings } from './effectsBindings';
import { updateParticles, clearParticles } from '../renderer/particles';
import { clearDecals } from '../renderer/decals';
import { preloadAll, SFX_NAMES, resumeAudio } from '../utils/audio';
import { getPacingConfig } from '../lib/pacingConfig';
import { recordHash, type TickSummary } from '../lib/hashHistory';

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
  /** Seed for the SoftBodyWorld's deterministic RNG. Host generates a seed at
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
  /** Player IDs the camera should follow. If null, follows ALL players
   * (legacy behavior). When set, the camera tracks only these blobs and
   * uses a fixed-zoom view targeted at ~10% blob-on-screen. Used by the
   * host (laptop local player) and online guests so the view stays
   * centered on the player(s) controlled on THIS machine. */
  private localPlayerIds: Set<string> | null = null;

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
    const camera = new Camera();
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
          effects.onPhaseChange(phase);
          this.onPhaseChange?.(phase);
        },
        onGameOver: (winnerId, winnerName) => {
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

    // Create spring pad manager if level has spring pads or if party mode (items may be placed)
    const isPartyMode = this.gameMode instanceof PartyMode;
    let springPadManager: SpringPadManager | null = null;
    if ((level.springPads && level.springPads.length > 0) || isPartyMode) {
      springPadManager = new SpringPadManager();
      springPadManager.initialize(world, level.springPads ?? []);
      springPadManager.onFire = (pos, dir) => effects.onSpringFire(pos, dir);
    }

    // Create spike manager if level has spikes or if party mode
    let spikeManager: SpikeManager | null = null;
    if ((level.spikes && level.spikes.length > 0) || isPartyMode) {
      spikeManager = new SpikeManager();
      spikeManager.initialize(world, playerManager, level.spikes ?? []);

      // Set death mode based on game mode type
      if (this.gameMode instanceof PartyMode) {
        spikeManager.deathMode = 'no_respawn';
      } else if (this.gameMode instanceof KingOfTheHillMode) {
        spikeManager.deathMode = 'timer';
      }
    }

    // Create dynamic item manager. Originally party-mode-only, but
    // levels with a `dynamicItems` field (e.g. det-test, custom maps)
    // need it regardless of game mode. Create whenever the level
    // declares items OR party mode is active.
    let dynamicItemManager: DynamicItemManager | null = null;
    const levelDynamicItems = (level as unknown as { dynamicItems?: Array<{ id: string; type: string; x: number; y: number; width: number; height: number; rotation: number }> }).dynamicItems ?? [];
    if (isPartyMode || levelDynamicItems.length > 0) {
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

    const npcBlobIds = new Set(npcBlobs.map(b => b.blobId));
    const triggerManager = new TriggerManager();
    triggerManager.initialize(
      world,
      level.triggers ?? [],
      triggerShapeIdxToId,
      (blobId) => npcBlobIds.has(blobId),
    );

    const actionManager = new ActionManager();
    actionManager.initialize(
      world,
      level.actions ?? [],
      pointShapeParticles,
      softPlatformStaticParticles,
      platformMover,
      triggerManager,
    );

    // Wire party mode integrations
    if (this.gameMode instanceof PartyMode) {
      const partyMode = this.gameMode;
      partyMode.setManagers(spikeManager, springPadManager, dynamicItemManager);
    }

    // Universal spike-kill SFX/VFX, chained with the mode's own handler.
    if (spikeManager) {
      const partyMode = this.gameMode instanceof PartyMode ? this.gameMode : null;
      spikeManager.onKill = (killedPlayerId, deathPos) => {
        const player = playerManager.getPlayer(killedPlayerId);
        if (player) effects.onSpikeKill(player, deathPos);
        partyMode?.handleSpikeKill(killedPlayerId);
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

    const loop = new GameLoop({
      getMaxSteps: () => this.maxStepsGetter?.() ?? 5,
      onLogic: (dt) => {
      if (!this.state) return false;

      // Global pause — both host and guest stop ticking. Used by the
      // compare-hashes diagnostic so we can freeze both sides and
      // inspect per-tick state without the sim moving under us. Reads
      // pacingConfig.paused live; toggleable from the debug overlay.
      if (pausedFlagRef()) return false;

      // Pre-tick gate: a lockstep guest pauses its sim here while
      // waiting for the host's authoritative inputs for the next tick.
      // Returning false tells GameLoop to keep the accumulator full so
      // we'll try again on the next RAF.
      if (this.logicGate && !this.logicGate(this.state.world)) return false;

      const { modeManager } = this.state;

      if (modeManager) {
        // Game mode controls when physics runs
        const shouldRunPhysics = modeManager.update(dt, playerManager, world);
        if (shouldRunPhysics) {
          let t0 = performance.now();
          playerManager.tickAIInputs(dt, world);
          this.preTickHook?.(world);
          playerManager.applyInputsAndStep(dt);
          // DETERMINISM DIAGNOSTIC. Three observations per tick:
          //   PRE = engine hash + per-player input AFTER applyInputsAndStep
          //         but BEFORE world.step. If host's PRE ≠ guest's PRE at
          //         the same tick, the JS calls between the previous step
          //         and this step wrote different values into the engine.
          //   POST = engine hash AFTER world.step. If PRE matches across
          //          tabs but POST diverges, the wasm step itself is the
          //          source — and that'd be a cross-instance wasm bug.
          // The next tick's PRE compared with this tick's POST then tells
          // us whether the post-step managers (powerup/spring/spike/etc.)
          // wrote different values.
          if (detTraceEnabled) {
            const nextTick = world.tick + 1;
            const parts: string[] = [];
            for (const p of playerManager.getAllPlayers()) {
              parts.push(`${p.playerId}:${p.moveX.toFixed(3)},${p.moveY.toFixed(3)},${p.expanding ? 1 : 0}`);
            }
            const preHash = world.stateHash();
            console.info(`[detTrace] PRE tick=${nextTick} hash=${preHash} inputs=[${parts.join(' | ')}]`);
          }
          recordPhaseTime('playerMgr', performance.now() - t0);
          t0 = performance.now();
          world.step(dt);
          if (detTraceEnabled) {
            const tick = world.tick;
            console.info(`[detTrace] POST tick=${tick} hash=${world.stateHash()}`);
          }
          recordPhaseTime('worldStep', performance.now() - t0);
          t0 = performance.now();
          powerupManager?.update(dt, playerManager);
          springPadManager?.update(dt);
          spikeManager?.update(dt);
          dynamicItemManager?.update(dt);
          triggerManager.update(dt);
          actionManager.update(dt);
          recordPhaseTime('managers', performance.now() - t0);
          t0 = performance.now();
          this.state.effects.update(
            dt, playerManager, npcBlobs, world,
            [...this.state.softPlatforms, ...this.state.pointShapes],
          );
          recordPhaseTime('effects', performance.now() - t0);
        }
        // Countdown ticks fire even though physics is frozen.
        if (modeManager.getPhase() === 'countdown') {
          this.state.effects.onCountdownTimer(modeManager.getState().phaseTimer);
        }
      } else {
        // Sandbox mode — always run.
        // Per-phase timing — folded into the frame profile so we can
        // see which inner sub-system dominates a slow tick.
        let t0 = performance.now();
        playerManager.tickAIInputs(dt, world);
        this.preTickHook?.(world);
        playerManager.applyInputsAndStep(dt);
        recordPhaseTime('playerMgr', performance.now() - t0);
        t0 = performance.now();
        world.step(dt);
        recordPhaseTime('worldStep', performance.now() - t0);
        t0 = performance.now();
        powerupManager?.update(dt, playerManager);
        springPadManager?.update(dt);
        spikeManager?.update(dt);
        dynamicItemManager?.update(dt);
        recordPhaseTime('managers', performance.now() - t0);
        t0 = performance.now();
        this.state.effects.update(
          dt, playerManager, npcBlobs, world,
          [...this.state.softPlatforms, ...this.state.pointShapes],
        );
        recordPhaseTime('effects', performance.now() - t0);
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

      if (cameraTargets.length > 0 && this.state.canvasWidth > 0) {
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
      onRender: () => {
        if (!this.state || !this.state.ctx) return;

        const allPlayers = playerManager.getAllPlayers();
        // Build player render data for faces and custom colors
        const playerRenderData: PlayerRenderData[] = allPlayers.map(p => ({
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
          playerManager.getPlayerBlobs(),
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
        );
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

    if (inputEvent.type === 'continuous' && inputEvent.inputType === 'joystick_left') {
      player.moveX = inputEvent.value.x;
      player.moveY = inputEvent.value.y ?? 0;
    } else if (inputEvent.type === 'discrete' && inputEvent.inputType === 'button_right') {
      player.expanding = inputEvent.value.pressed;
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
      actionManager: s.actionManager?.dumpState?.(),
      triggerManager: s.triggerManager?.dumpState?.(),
      springPadManager: s.springPadManager?.dumpState?.(),
      spikeManager: s.spikeManager?.dumpState?.(),
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
    if (snap.actionManager) s.actionManager?.restoreState?.(snap.actionManager as any);
    if (snap.triggerManager) s.triggerManager?.restoreState?.(snap.triggerManager as any);
    if (snap.springPadManager) s.springPadManager?.restoreState?.(snap.springPadManager as any);
    if (snap.spikeManager) s.spikeManager?.restoreState?.(snap.spikeManager as any);
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
