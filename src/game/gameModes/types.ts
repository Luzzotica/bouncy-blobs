import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager, ManagedPlayer } from '../playerManager';
import { LevelData } from '../../levels/types';
import { Vec2 } from '../../physics/vec2';

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
  /**
   * Returns the world-space goal this player should currently be moving toward
   * (the hill in KOTH, the goal zone in racing modes, etc.), or null if the
   * mode has no single goal (e.g. PartyMode mini-games handle their own logic).
   *
   * `width` and `height` describe the AABB of the goal zone — the AI uses the
   * same containment check the mode uses for scoring, so "I'm in the goal"
   * means exactly what the game thinks it means. Used by the AI controller
   * to drive bots.
   */
  getGoalForBlob?(
    self: ManagedPlayer,
    state: GameModeState,
  ): { x: number; y: number; width: number; height: number } | null;
}
