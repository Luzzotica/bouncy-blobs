import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";
import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData, ZoneDef } from '../../levels/types';
import { classicLevel } from '../../levels/classicLevel';
import { drawGoalZone } from '../../renderer/zoneRenderer';
import { drawTimer } from '../../renderer/hudRenderer';

export class ClassicMode implements GameMode {
  readonly config: GameModeConfig = {
    id: 'classic',
    name: 'Classic',
    description: 'Race to the finish line!',
    minPlayers: 1,
    maxPlayers: 8,
    timeLimitSec: 120,
    countdownDuration: 3,
    resultsDuration: 5,
  };

  private levelData: LevelData;
  private goalZone: ZoneDef | null = null;
  private goalTriggerIdx: number = -1;
  private world: SoftBodyEngine | null = null;
  private finishedPlayerId: string | null = null;
  private gameTime = 0;

  constructor(levelData?: LevelData) {
    this.levelData = levelData ?? classicLevel;
  }

  getLevel(): LevelData {
    return this.levelData;
  }

  initialize(world: SoftBodyEngine, playerManager: PlayerManager, triggerIndices?: Map<string, number>): void {
    this.world = world;
    this.goalZone = this.levelData.goalZones?.[0] ?? null;
    this.goalTriggerIdx = (this.goalZone && triggerIndices?.get(this.goalZone.id)) ?? -1;

    if (this.goalZone) {
      const prevEntered = world.onTriggerEntered;
      world.onTriggerEntered = (triggerShapeIdx, blobId) => {
        prevEntered?.(triggerShapeIdx, blobId);
        this.onTriggerEntered(triggerShapeIdx, blobId, playerManager);
      };
    }
  }

  private onTriggerEntered(triggerShapeIdx: number, blobId: number, playerManager: PlayerManager): void {
    if (this.finishedPlayerId) return; // already have a winner
    if (this.goalTriggerIdx >= 0 && triggerShapeIdx !== this.goalTriggerIdx) return; // not the goal zone

    const player = playerManager.getPlayerByBlobId(blobId);
    if (player) {
      this.finishedPlayerId = player.playerId;
    }
  }

  onPhaseStart(phase: GamePhase, state: GameModeState): void {
    if (phase === 'playing') {
      this.finishedPlayerId = null;
      this.gameTime = 0;
    }
  }

  update(dt: number, state: GameModeState, playerManager: PlayerManager, _world: SoftBodyEngine): void {
    this.gameTime += dt;
  }

  checkWinCondition(state: GameModeState, playerManager: PlayerManager): string | null {
    if (this.finishedPlayerId) return this.finishedPlayerId;

    // Time's up — furthest-right player wins
    if (state.timeRemaining !== null && state.timeRemaining <= 0) {
      let bestId: string | null = null;
      let bestX = -Infinity;
      for (const p of playerManager.getAllPlayers()) {
        const centroid = p.blob.getCentroid();
        if (centroid.x > bestX) {
          bestX = centroid.x;
          bestId = p.playerId;
        }
      }
      return bestId;
    }

    return null;
  }

  renderWorld(ctx: CanvasRenderingContext2D, _camera: Camera, _state: GameModeState, _playerManager: PlayerManager): void {
    if (this.goalZone) {
      drawGoalZone(ctx, this.goalZone, this.gameTime);
    }
  }

  renderHUD(ctx: CanvasRenderingContext2D, width: number, height: number, state: GameModeState, _playerManager: PlayerManager): void {
    if (state.timeRemaining !== null) {
      drawTimer(ctx, width, state.timeRemaining);
    }
  }

  cleanup(): void {
    this.world = null;
    this.finishedPlayerId = null;
  }

  dumpState(): { finishedPlayerId: string | null; gameTime: number } {
    return { finishedPlayerId: this.finishedPlayerId, gameTime: this.gameTime };
  }
  restoreState(state: { finishedPlayerId: string | null; gameTime: number }): void {
    this.finishedPlayerId = state.finishedPlayerId;
    this.gameTime = state.gameTime;
  }

  getGoalForBlob(): { x: number; y: number; width: number; height: number } | null {
    if (!this.goalZone) return null;
    return {
      x: this.goalZone.x,
      y: this.goalZone.y,
      width: this.goalZone.width,
      height: this.goalZone.height,
    };
  }
}
