import { GameMode, GameModeState, GamePhase } from './types';
import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';

export class GameModeManager {
  private mode: GameMode;
  private state: GameModeState;
  private onPhaseChange?: (phase: GamePhase) => void;
  private onGameOver?: (winnerId: string | null, winnerName: string | null) => void;

  constructor(
    mode: GameMode,
    callbacks?: {
      onPhaseChange?: (phase: GamePhase) => void;
      onGameOver?: (winnerId: string | null, winnerName: string | null) => void;
    },
  ) {
    this.mode = mode;
    this.onPhaseChange = callbacks?.onPhaseChange;
    this.onGameOver = callbacks?.onGameOver;
    this.state = {
      phase: 'lobby',
      phaseTimer: 0,
      scores: new Map(),
      winner: null,
      winnerName: null,
      timeRemaining: mode.config.timeLimitSec ?? null,
    };
  }

  getState(): GameModeState {
    return this.state;
  }

  getPhase(): GamePhase {
    return this.state.phase;
  }

  getMode(): GameMode {
    return this.mode;
  }

  initialize(world: SoftBodyWorld, playerManager: PlayerManager): void {
    this.mode.initialize(world, playerManager);
  }

  startRound(): void {
    if (this.mode.config.countdownDuration <= 0) {
      // Skip countdown — go directly to playing
      this.setPhase('playing');
    } else {
      this.setPhase('countdown');
    }
  }

  /** Returns true if physics/input should run this frame. */
  update(dt: number, playerManager: PlayerManager, world: SoftBodyWorld): boolean {
    const { phase } = this.state;

    if (phase === 'countdown') {
      this.state.phaseTimer -= dt;
      if (this.state.phaseTimer <= 0) {
        this.setPhase('playing');
      }
      return false; // freeze physics during countdown
    }

    if (phase === 'playing') {
      // Time limit
      if (this.state.timeRemaining !== null) {
        this.state.timeRemaining -= dt;
        if (this.state.timeRemaining <= 0) {
          this.state.timeRemaining = 0;
          // Time's up — find winner by highest score or let mode decide
          const winnerId = this.mode.checkWinCondition(this.state, playerManager);
          if (winnerId) {
            const player = playerManager.getPlayer(winnerId);
            this.state.winner = winnerId;
            this.state.winnerName = player?.name ?? 'Unknown';
          }
          this.onGameOver?.(this.state.winner, this.state.winnerName);
          this.setPhase('results');
          return false;
        }
      }

      // Let mode update (scoring, etc.)
      this.mode.update(dt, this.state, playerManager, world);

      // Check win condition
      const winnerId = this.mode.checkWinCondition(this.state, playerManager);
      if (winnerId) {
        const player = playerManager.getPlayer(winnerId);
        this.state.winner = winnerId;
        this.state.winnerName = player?.name ?? 'Unknown';
        this.onGameOver?.(this.state.winner, this.state.winnerName);
        this.setPhase('results');
        return false;
      }

      // Let mode control physics (e.g., party mode freezes during non-run sub-phases)
      if (this.mode.shouldRunPhysics) {
        return this.mode.shouldRunPhysics();
      }
      return true; // physics should run
    }

    if (phase === 'results') {
      this.state.phaseTimer -= dt;
      return false;
    }

    // lobby
    return false;
  }

  renderWorld(ctx: CanvasRenderingContext2D, camera: Camera, playerManager: PlayerManager): void {
    this.mode.renderWorld(ctx, camera, this.state, playerManager);
  }

  renderHUD(ctx: CanvasRenderingContext2D, width: number, height: number, playerManager: PlayerManager): void {
    this.mode.renderHUD(ctx, width, height, this.state, playerManager);
    this.renderPhaseOverlay(ctx, width, height);
  }

  private renderPhaseOverlay(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const { phase, phaseTimer, winner, winnerName } = this.state;

    if (phase === 'countdown') {
      const count = Math.ceil(phaseTimer);
      const text = count > 0 ? String(count) : 'GO!';
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(0, 0, width, height);
      ctx.font = 'bold 120px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = count > 0 ? '#fff' : '#4eff4e';
      ctx.fillText(text, width / 2, height / 2);
      ctx.restore();
    }

    if (phase === 'results') {
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, width, height);
      ctx.font = 'bold 48px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (this.mode.config.id === 'voting') {
        // Voting results — show the selected level
        ctx.fillStyle = '#c77dff';
        ctx.fillText('Level Selected!', width / 2, height / 2 - 20);
      } else {
        ctx.fillStyle = '#ffd700';
        ctx.fillText(winnerName ? `${winnerName} wins!` : 'Time\'s up!', width / 2, height / 2 - 30);
        ctx.font = '20px sans-serif';
        ctx.fillStyle = '#aaa';
        ctx.fillText('Next round...', width / 2, height / 2 + 30);
      }

      ctx.restore();
    }
  }

  private setPhase(phase: GamePhase): void {
    this.state.phase = phase;

    if (phase === 'countdown') {
      this.state.phaseTimer = this.mode.config.countdownDuration;
      this.state.winner = null;
      this.state.winnerName = null;
      this.state.timeRemaining = this.mode.config.timeLimitSec ?? null;
    } else if (phase === 'results') {
      this.state.phaseTimer = this.mode.config.resultsDuration;
    }

    this.mode.onPhaseStart(phase, this.state);
    this.onPhaseChange?.(phase);
  }

  cleanup(): void {
    this.mode.cleanup();
  }
}
