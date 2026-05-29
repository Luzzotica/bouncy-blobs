import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";
import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager, ManagedPlayer } from '../playerManager';
import { LevelData, ZoneDef } from '../../levels/types';
import { chainedLevel } from '../../levels/chainedLevel';
import { drawGoalZone } from '../../renderer/zoneRenderer';
import { drawTimer } from '../../renderer/hudRenderer';
import { drawChain } from '../../renderer/chainRenderer';

// Total length of the rope between any two chained players. The rope is
// only this long — when the bots are this far apart in rope-path terms
// (not straight-line), they can't go further. No spring, no leash:
// physics does it through the constraint chain alone.
const CHAIN_TOTAL_LENGTH = 750;
// Max distance between any two adjacent chain particles. Smaller = denser
// rope, smoother visual, less clip-through, more compute. 25 against a
// 750-unit rope gives ~30 segments.
const CHAIN_MAX_SEGMENT_LEN = 25;
// Mass close enough to a blob's that the PBD constraint solver actually
// transmits force through the chain instead of dumping every correction
// into the segment particles. Blob mass ≈ 5; 0.5 is a 10× ratio.
const CHAIN_SEGMENT_MASS = 0.5;
// Roughly 40% of MAX_SEGMENT_LEN so adjacent particles overlap visually —
// thin walls can't fit between them, no rope-through-wall artefacts.
const CHAIN_SEGMENT_RADIUS = 10;
// Bi-directional sweeps per substep inside the chain-specific solver.
const CHAIN_SOLVER_ITERS = 12;

interface ChainPair {
  pidA: string;
  pidB: string;
  /** Full particle index list including both player centroids:
   *  [centerIdxA, ...inner segments, centerIdxB]. */
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
      const rope = world.addRopeChain(a.blob.centerIdx, b.blob.centerIdx, {
        totalLength: CHAIN_TOTAL_LENGTH,
        maxSegmentLength: CHAIN_MAX_SEGMENT_LEN,
        segmentMass: CHAIN_SEGMENT_MASS,
        segmentRadius: CHAIN_SEGMENT_RADIUS,
        iterations: CHAIN_SOLVER_ITERS,
      });
      this.chainPairs.push({
        pidA: a.playerId,
        pidB: b.playerId,
        particleIndices: [a.blob.centerIdx, ...rope.particleIndices, b.blob.centerIdx],
      });
    }
  }

  checkWinCondition(state: GameModeState, playerManager: PlayerManager): string | null {
    if (this.allReachedGoal) {
      const players = playerManager.getAllPlayers();
      return players[0]?.playerId ?? null;
    }
    if (state.timeRemaining !== null && state.timeRemaining <= 0) {
      let bestId: string | null = null;
      let bestY = Infinity;
      for (const p of playerManager.getAllPlayers()) {
        const c = p.blob.getCentroid();
        if (c.y < bestY) {
          bestY = c.y;
          bestId = p.playerId;
        }
      }
      return bestId;
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
