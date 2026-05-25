import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";
import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData } from '../../levels/types';

/**
 * Lobby playground mode. No goal, no scoring, no timer — players can spawn
 * and move freely while the host configures the next match in the React panel.
 * `checkWinCondition` always returns null so the phase never advances to
 * `results` on its own; the host transitions out by calling `startGameWithLevel`
 * with a real mode when they hit Start.
 */
export class FreeplayMode implements GameMode {
  readonly config: GameModeConfig = {
    id: 'freeplay',
    name: 'Freeplay',
    description: 'Lobby playground',
    minPlayers: 0,
    maxPlayers: 16,
    countdownDuration: 0,
    resultsDuration: 0,
  };

  private levelData: LevelData;

  constructor(levelData: LevelData) {
    this.levelData = levelData;
  }

  getLevel(): LevelData {
    return this.levelData;
  }

  initialize(_world: SoftBodyEngine, _playerManager: PlayerManager): void {
    // No triggers, no win-state to hook.
  }

  onPhaseStart(_phase: GamePhase, _state: GameModeState): void {}

  update(_dt: number, _state: GameModeState, _playerManager: PlayerManager, _world: SoftBodyEngine): void {}

  checkWinCondition(_state: GameModeState, _playerManager: PlayerManager): string | null {
    return null;
  }

  renderWorld(_ctx: CanvasRenderingContext2D, _camera: Camera, _state: GameModeState, _playerManager: PlayerManager): void {}

  renderHUD(_ctx: CanvasRenderingContext2D, _width: number, _height: number, _state: GameModeState, _playerManager: PlayerManager): void {}

  cleanup(): void {}
}
