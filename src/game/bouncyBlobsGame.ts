import React from 'react';
import { Game, GameContext, GameDefinition, GameState } from './GameInterface';
import { SoftBodyWorld } from '../physics/softBodyWorld';
import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { createSoftBodyEngine } from '../physics/engineSelector';
import { SlimeBlob } from '../physics/slimeBlob';
import { Camera } from '../renderer/camera';
import { render, RenderOptions, PlayerRenderData } from '../renderer/canvasRenderer';
import { GameLoop } from './gameLoop';
import { PlayerManager } from './playerManager';
import { AIController, nextBotIdentity } from './aiController';
import { PERSONALITY_COLORS, type PersonalityName } from './aiPersonalities';
import { loadLevel } from '../levels/levelLoader';
import { preloadSprites, getSprite } from '../assets/spriteRegistry';
import { drawSprite } from '../renderer/spriteRenderer';
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
import { CameraFollower } from '../renderer/cameraFollower';
import { Vec2 } from '../physics/vec2';
import { EffectsBindings } from './effectsBindings';
import { updateParticles, clearParticles } from '../renderer/particles';
import { clearDecals } from '../renderer/decals';
import { preloadAll, SFX_NAMES, resumeAudio } from '../utils/audio';

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
  triggerIndices: Map<string, number>;
  /** Soft-platform info from levelLoader — id + hull-particle indices. */
  softPlatforms: Array<{ id: string; hullIndices: number[] }>;
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

  setLogicGate(fn: ((world: SoftBodyEngine) => boolean) | null): void {
    this.logicGate = fn;
  }

  setPostTickHook(fn: ((world: SoftBodyEngine) => void) | null): void {
    this.postTickHook = fn;
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

    // Use the game mode's level if available, otherwise fall back
    const level = this.gameMode?.getLevel() ?? this.state?.level ?? defaultLevel;

    const world = createSoftBodyEngine({
      substeps: 4,
      gravityScale: 4.0,
      rngSeed: this.rngSeed,
    });

    const { playerSpawnPoints, npcBlobs, triggerIndices, softPlatforms, pointShapeParticles } = loadLevel(world, level);
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
      modeManager.initialize(world, playerManager);
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

    // Create dynamic item manager for party mode
    let dynamicItemManager: DynamicItemManager | null = null;
    if (isPartyMode) {
      dynamicItemManager = new DynamicItemManager();
      dynamicItemManager.initialize(world, playerManager);
    }

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

    const loop = new GameLoop({
      onLogic: (dt) => {
      if (!this.state) return false;

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
          playerManager.updateAll(dt, world);
          world.step(dt);
          powerupManager?.update(dt, playerManager);
          springPadManager?.update(dt);
          spikeManager?.update(dt);
          dynamicItemManager?.update(dt);
          this.state.effects.update(dt, playerManager);
        }
        // Countdown ticks fire even though physics is frozen.
        if (modeManager.getPhase() === 'countdown') {
          this.state.effects.onCountdownTimer(modeManager.getState().phaseTimer);
        }
      } else {
        // Sandbox mode — always run
        playerManager.updateAll(dt, world);
        world.step(dt);
        powerupManager?.update(dt, playerManager);
        springPadManager?.update(dt);
        spikeManager?.update(dt);
        dynamicItemManager?.update(dt);
        this.state.effects.update(dt, playerManager);
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
      const cameraTargets: Vec2[] = playerManager.getAllPlayers()
        .filter(p => !spikeManager?.isDead(p.playerId))
        .map(p => p.blob.getCentroid());

      if (spikeManager) {
        const deadMap = spikeManager.getDeadPlayers();
        if (deadMap.size > 0) {
          const spawnPoints = playerManager.getSpawnPoints();
          const defaultSpawn = spawnPoints[0] ?? { x: 0, y: 400 };
          const { cameraFollower } = this.state;
          const deadTargets = Array.from(deadMap).map(([pid, dead]) => ({
            id: pid,
            deathPosition: dead.deathPosition,
            driftTo: defaultSpawn,
          }));
          cameraFollower.update(dt, [], deadTargets);
          cameraTargets.push(...cameraFollower.getPositions());
        }
      }

      if (cameraTargets.length > 0 && this.state.canvasWidth > 0) {
        camera.followTargets(cameraTargets, this.state.canvasWidth, this.state.canvasHeight);
        camera.update(dt);
      }

      // Post-tick hook — host uses this to broadcast the inputs that
      // were just applied, tagged with the exact world.tick they
      // applied at. Inside the game loop guarantees per-tick precision.
      this.postTickHook?.(this.state.world);

      return true;
      },
      onRender: () => {
        if (!this.state || !this.state.ctx) return;

        const allPlayers = playerManager.getAllPlayers();
        // Build player render data for faces and custom colors
        const playerRenderData: PlayerRenderData[] = allPlayers.map(p => ({
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
          modeManager || powerupManager || springPadManager || spikeManager || dynamicItemManager
            ? {
                renderWorld: (ctx) => {
                  modeManager?.renderWorld(ctx, camera, playerManager);
                  // Placed sprite instances — decorative props for now;
                  // collision wiring per asset comes in follow-up batches.
                  for (const inst of level.sprites ?? []) {
                    const sp = getSprite(inst.spriteId);
                    if (!sp) continue;
                    drawSprite(ctx, sp, inst.x, inst.y, inst.rotation, inst.scale ?? 1, 1);
                  }
                  springPadManager?.render(ctx);
                  powerupManager?.render(ctx);
                  spikeManager?.render(ctx);
                  spikeManager?.renderDeadPlayers(ctx);
                  dynamicItemManager?.render(ctx);
                },
                renderHUD: (ctx, w, h) => {
                  modeManager?.renderHUD(ctx, w, h, playerManager);
                },
              }
            : undefined,
          playerRenderData,
          softPlatforms,
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
      triggerIndices,
      softPlatforms,
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

  onPlayerCustomizationUpdate(_context: GameContext, playerId: string, color?: string, faceId?: string): void {
    if (!this.state) return;
    this.state.playerManager.updateCustomization(playerId, color, faceId);
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
}
