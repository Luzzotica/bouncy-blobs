import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData } from '../../levels/types';

export type GamePhase = 'lobby' | 'countdown' | 'playing' | 'results';

export interface GameModeConfig {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  timeLimitSec?: number;
  targetScore?: number;
  countdownDuration: number;
  resultsDuration: number;
}

export interface GameModeState {
  phase: GamePhase;
  phaseTimer: number;
  scores: Map<string, number>;
  winner: string | null;
  winnerName: string | null;
  timeRemaining: number | null;
}

export interface GameMode {
  readonly config: GameModeConfig;
  getLevel(): LevelData;
  initialize(world: SoftBodyWorld, playerManager: PlayerManager): void;
  onPhaseStart(phase: GamePhase, state: GameModeState): void;
  update(dt: number, state: GameModeState, playerManager: PlayerManager, world: SoftBodyWorld): void;
  /** Returns winner playerId or null. */
  checkWinCondition(state: GameModeState, playerManager: PlayerManager): string | null;
  /** Draw world-space overlays (zones, chains) — called inside camera transform. */
  renderWorld(ctx: CanvasRenderingContext2D, camera: Camera, state: GameModeState, playerManager: PlayerManager): void;
  /** Draw screen-space HUD — called outside camera transform. */
  renderHUD(ctx: CanvasRenderingContext2D, width: number, height: number, state: GameModeState, playerManager: PlayerManager): void;
  cleanup(): void;
  /** If implemented, controls whether physics runs during playing phase. Default: true. */
  shouldRunPhysics?(): boolean;
}
