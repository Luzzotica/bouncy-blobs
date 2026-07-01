import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData, ZoneDef } from '../../levels/types';
import { classicLevel } from '../../levels/classicLevel';
import { drawGoalZone } from '../../renderer/zoneRenderer';
import { drawTimer } from '../../renderer/hudRenderer';

/**
 * Race mode. The win/timer rules now run in the Rust engine (Phase 9 of the
 * JS→Rust migration): this class registers the mode + goal zone at init and
 * reads `modeDecided`/`modeWinner` for the result. TS keeps rendering + the
 * goal-zone definition.
 */
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
  private world: SoftBodyEngine | null = null;

  constructor(levelData?: LevelData) {
    this.levelData = levelData ?? classicLevel;
  }

  getLevel(): LevelData { return this.levelData; }

  initialize(world: SoftBodyEngine, _playerManager: PlayerManager, _triggerIndices?: Map<string, number>): void {
    this.world = world;
    this.goalZone = this.levelData.goalZones?.[0] ?? null;
    world.setGameMode(0, this.config.timeLimitSec ?? 0, 0);
    if (this.goalZone) world.setGoalZone(this.goalZone.x, this.goalZone.y, this.goalZone.width, this.goalZone.height);
  }

  onPhaseStart(_phase: GamePhase, _state: GameModeState): void {}

  /** No-op: the engine advances the race rules inside `world.step()`. */
  update(_dt: number, _state: GameModeState, _playerManager: PlayerManager, _world: SoftBodyEngine): void {}

  checkWinCondition(_state: GameModeState, playerManager: PlayerManager): string | null {
    if (!this.world?.modeDecided()) return null;
    const gid = this.world.modeWinner();
    if (gid < 0) return null;
    return playerManager.getPlayerByGameplayId(gid)?.playerId ?? null;
  }

  renderWorld(ctx: CanvasRenderingContext2D, _camera: Camera, _state: GameModeState, _playerManager: PlayerManager): void {
    if (this.goalZone) drawGoalZone(ctx, this.goalZone, this.world?.modeGameTime() ?? 0);
  }

  renderHUD(ctx: CanvasRenderingContext2D, width: number, _height: number, state: GameModeState, _playerManager: PlayerManager): void {
    if (state.timeRemaining !== null) drawTimer(ctx, width, state.timeRemaining);
  }

  cleanup(): void { this.world = null; }

  getGoalForBlob(): { x: number; y: number; width: number; height: number } | null {
    if (!this.goalZone) return null;
    return { x: this.goalZone.x, y: this.goalZone.y, width: this.goalZone.width, height: this.goalZone.height };
  }
}
