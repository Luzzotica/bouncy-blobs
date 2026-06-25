import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";
import { Camera } from '../../renderer/camera';
import { PlayerManager, ManagedPlayer } from '../playerManager';
import { LevelData, ZoneDef } from '../../levels/types';
import { chainedLevel } from '../../levels/chainedLevel';
import { drawGoalZone } from '../../renderer/zoneRenderer';
import { drawTimer } from '../../renderer/hudRenderer';
import { drawChain } from '../../renderer/chainRenderer';

// Phase 1 leash: a unilateral distance constraint between two blobs, applied
// in the Rust engine (`addBlobTether`). No rope particles, no weight — while
// the blobs are within CHAIN_TOTAL_LENGTH it does nothing at all; past it, an
// elastic pull is spread evenly across every hull particle of both blobs, so
// each is translated as a whole toward the other (no single-point yank, never
// drags you to the ground). The visual is just a line between the two
// centroids that reddens as it goes taut. This is the same tether used in the
// editor test mode (Sandbox) — the single chain implementation everywhere.
const CHAIN_TOTAL_LENGTH = 700;
const TETHER_STIFFNESS = 4;   // pull per world-unit past the slack budget
const TETHER_MAX_FORCE = 560; // peak pull, in MOVE_FORCE (≈240) units

interface ChainPair {
  pidA: string;
  pidB: string;
  /** Two endpoints for the rendered line: each blob's centre particle. */
  particleIndices: number[];
}

export class ChainedMode implements GameMode {
  readonly config: GameModeConfig = {
    id: 'chained',
    name: 'Chained Together',
    description: 'Cooperate while tethered!',
    minPlayers: 1,
    maxPlayers: 8,
    timeLimitSec: 180,
    countdownDuration: 3,
    resultsDuration: 5,
  };

  private levelData: LevelData;
  private goalZone: ZoneDef | null = null;
  private world: SoftBodyEngine | null = null;
  private chainPairs: ChainPair[] = [];
  private allReachedGoal = false;
  private gameTime = 0;

  constructor(levelData?: LevelData) {
    this.levelData = levelData ?? chainedLevel;
  }

  getLevel(): LevelData {
    return this.levelData;
  }

  initialize(world: SoftBodyEngine, _playerManager: PlayerManager): void {
    this.world = world;
    this.goalZone = this.levelData.goalZones?.[0] ?? null;

    if (this.goalZone) {
      const prevEntered = world.onTriggerEntered;
      world.onTriggerEntered = (triggerShapeIdx, blobId) => {
        prevEntered?.(triggerShapeIdx, blobId);
      };
    }
  }

  onPhaseStart(phase: GamePhase, _state: GameModeState): void {
    if (phase === 'playing') {
      this.allReachedGoal = false;
      this.gameTime = 0;
      this.chainPairs = [];
      this.chainsCreated = false;
    }
  }

  private chainsCreated = false;

  update(dt: number, _state: GameModeState, playerManager: PlayerManager, world: SoftBodyEngine): void {
    this.gameTime += dt;

    if (!this.chainsCreated && playerManager.getPlayerCount() > 1) {
      this.createChains(playerManager, world);
      this.chainsCreated = true;
    }

    if (this.goalZone && playerManager.getPlayerCount() > 0) {
      const gz = this.goalZone;
      const hw = gz.width / 2;
      const hh = gz.height / 2;
      let allInGoal = true;
      for (const p of playerManager.getAllPlayers()) {
        const c = p.blob.getCentroid();
        if (c.x < gz.x - hw || c.x > gz.x + hw || c.y < gz.y - hh || c.y > gz.y + hh) {
          allInGoal = false;
          break;
        }
      }
      this.allReachedGoal = allInGoal;
    }
  }

  private createChains(playerManager: PlayerManager, world: SoftBodyEngine): void {
    const players = playerManager.getAllPlayers();
    if (players.length < 2) return;

    for (let i = 0; i < players.length - 1; i++) {
      const a = players[i];
      const b = players[i + 1];
      world.addBlobTether(
        a.blob.blobId, b.blob.blobId,
        CHAIN_TOTAL_LENGTH, TETHER_STIFFNESS, TETHER_MAX_FORCE,
      );
      this.chainPairs.push({
        pidA: a.playerId,
        pidB: b.playerId,
        particleIndices: [a.blob.centerIdx, b.blob.centerIdx],
      });
    }
  }

  checkWinCondition(_state: GameModeState, playerManager: PlayerManager): string | null {
    // Co-op: the team only wins if EVERYONE reaches the summit. If time runs
    // out with anyone still short, nobody wins — everyone loses together (the
    // results overlay shows "Everyone loses!"). No "closest player" winner.
    if (this.allReachedGoal) {
      const players = playerManager.getAllPlayers();
      return players[0]?.playerId ?? null;
    }
    return null;
  }

  renderWorld(ctx: CanvasRenderingContext2D, _camera: Camera, _state: GameModeState, playerManager: PlayerManager): void {
    if (this.goalZone) {
      drawGoalZone(ctx, this.goalZone, this.gameTime);
    }

    this.renderChains(ctx, playerManager);
  }

  private renderChains(ctx: CanvasRenderingContext2D, _playerManager: PlayerManager): void {
    const world = this.world;
    if (!world) return;
    for (const pair of this.chainPairs) {
      drawChain(ctx, world, pair.particleIndices, CHAIN_TOTAL_LENGTH);
    }
  }

  renderHUD(ctx: CanvasRenderingContext2D, width: number, height: number, state: GameModeState, _playerManager: PlayerManager): void {
    if (state.timeRemaining !== null) {
      drawTimer(ctx, width, state.timeRemaining);
    }

    ctx.save();
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('All players must reach the summit!', width / 2, height - 12);
    ctx.restore();
  }

  cleanup(): void {
    this.world = null;
    this.chainPairs = [];
    this.chainsCreated = false;
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
