import React from 'react';
import { Game, GameContext, GameDefinition, GameState } from './GameInterface';
import { SoftBodyWorld } from '../physics/softBodyWorld';
import { SlimeBlob } from '../physics/slimeBlob';
import { Camera } from '../renderer/camera';
import { render, RenderOptions, PlayerRenderData } from '../renderer/canvasRenderer';
import { GameLoop } from './gameLoop';
import { PlayerManager } from './playerManager';
import { loadLevel } from '../levels/levelLoader';
import { defaultLevel } from '../levels/defaultLevel';
import { LevelData } from '../levels/types';
import { DEFAULT_CONTROLLER_CONFIG } from '../types/controllerConfig';
import { InputEvent } from '../types';
import { Player } from '../types/database';
import { GameModeManager } from './gameModes/gameModeManager';
import { GameMode, GamePhase } from './gameModes/types';
import { PartyMode } from './gameModes/partyMode';
import { KingOfTheHillMode } from './gameModes/kingOfTheHillMode';
import { drawPlayerLabels, drawScoreBoard, drawTimer } from '../renderer/hudRenderer';
import { PowerupManager } from './powerups/powerupManager';
import { SpringPadManager } from './springPadManager';
import { SpikeManager } from './spikeManager';
import { DynamicItemManager } from './dynamicItemManager';
import { CameraFollower } from '../renderer/cameraFollower';
import { Vec2 } from '../physics/vec2';

export interface BouncyBlobsGameState {
  world: SoftBodyWorld;
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
  gameTime: number;
  cameraFollower: CameraFollower;
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
    // Use the game mode's level if available, otherwise fall back
    const level = this.gameMode?.getLevel() ?? this.state?.level ?? defaultLevel;

    const world = new SoftBodyWorld({
      substeps: 4,
      gravityScale: 4.0,
    });

    const { playerSpawnPoints, npcBlobs, triggerIndices } = loadLevel(world, level);
    const playerManager = new PlayerManager(playerSpawnPoints);
    const camera = new Camera();
    camera.snapTo(playerSpawnPoints[0] ?? { x: 0, y: 400 }, 0.592);

    const renderOptions: RenderOptions = {
      showSprings: false,
      showShapeTargets: false,
    };

    // Create mode manager if a game mode is set
    let modeManager: GameModeManager | null = null;
    if (this.gameMode) {
      modeManager = new GameModeManager(this.gameMode, {
        onPhaseChange: this.onPhaseChange,
        onGameOver: this.onGameOver,
      });
      modeManager.initialize(world, playerManager);
    }

    // Create powerup manager if level has powerup spawns
    let powerupManager: PowerupManager | null = null;
    if (level.powerupSpawns && level.powerupSpawns.length > 0) {
      powerupManager = new PowerupManager();
      powerupManager.initialize(world, level.powerupSpawns);
    }

    // Create spring pad manager if level has spring pads or if party mode (items may be placed)
    const isPartyMode = this.gameMode instanceof PartyMode;
    let springPadManager: SpringPadManager | null = null;
    if ((level.springPads && level.springPads.length > 0) || isPartyMode) {
      springPadManager = new SpringPadManager();
      springPadManager.initialize(world, level.springPads ?? []);
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
      if (spikeManager) {
        spikeManager.onKill = (killedPlayerId) => {
          partyMode.handleSpikeKill(killedPlayerId);
        };
      }
    }

    const loop = new GameLoop((dt) => {
      if (!this.state) return;

      const { modeManager } = this.state;

      if (modeManager) {
        // Game mode controls when physics runs
        const shouldRunPhysics = modeManager.update(dt, playerManager, world);
        if (shouldRunPhysics) {
          playerManager.updateAll(dt);
          world.step(dt);
          powerupManager?.update(dt, playerManager);
          springPadManager?.update(dt);
          spikeManager?.update(dt);
          dynamicItemManager?.update(dt);
        }
      } else {
        // Sandbox mode — always run
        playerManager.updateAll(dt);
        world.step(dt);
        powerupManager?.update(dt, playerManager);
        springPadManager?.update(dt);
        spikeManager?.update(dt);
        dynamicItemManager?.update(dt);
      }

      this.state.gameTime += dt;

      // Camera: follow actual centroids, lerp the camera itself (once per frame)
      const allPlayers = playerManager.getAllPlayers();

      // Alive players: use actual physics centroids
      const cameraTargets: Vec2[] = allPlayers
        .filter(p => !spikeManager?.isDead(p.playerId))
        .map(p => p.blob.getCentroid());

      // Dead players: ghost dot lingers at death pos, drifts to spawn
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

      // Render
      if (this.state.ctx) {
        // Build player render data for faces and custom colors
        const playerRenderData: PlayerRenderData[] = allPlayers.map(p => ({
          color: p.color,
          faceId: p.faceId,
          expanding: p.blob.isExpanding(),
          expandScale: p.blob.getExpandScale(),
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
        );
      }
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
      gameTime: 0,
      cameraFollower: new CameraFollower(),
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

  destroy(): void {
    this.stop();
    this.state?.modeManager?.cleanup();
    this.state?.powerupManager?.cleanup();
    this.state?.springPadManager?.cleanup();
    this.state?.spikeManager?.cleanup();
    this.state?.dynamicItemManager?.cleanup();
    this.state?.playerManager.clear();
    this.state = null;
  }
}
