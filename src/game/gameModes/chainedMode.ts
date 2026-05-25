import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";
import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager, ManagedPlayer } from '../playerManager';
import { LevelData, ZoneDef } from '../../levels/types';
import { chainedLevel } from '../../levels/chainedLevel';
import { drawGoalZone } from '../../renderer/zoneRenderer';
import { drawTimer } from '../../renderer/hudRenderer';
import { Vec2, sub, length } from '../../physics/vec2';

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
  /** Particle indices of the intermediate rope segments, in order from A to B. */
  segmentIndices: number[];
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
        segmentIndices: rope.particleIndices,
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

  private renderChains(ctx: CanvasRenderingContext2D, playerManager: PlayerManager): void {
    const world = this.world;
    if (!world) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const pair of this.chainPairs) {
      const a = playerManager.getPlayer(pair.pidA);
      const b = playerManager.getPlayer(pair.pidB);
      if (!a || !b) continue;

      const posA = a.blob.getCentroid();
      const posB = b.blob.getCentroid();

      // Walk the physical rope: endpoint A -> each segment particle -> endpoint B.
      const pts: Vec2[] = [posA];
      for (const segIdx of pair.segmentIndices) {
        const p = world.pos[segIdx];
        if (p) pts.push(p);
      }
      pts.push(posB);

      // Tension color: distance between endpoints vs the rope's full slack length.
      const straightLine = length(sub(posB, posA));
      const tension = Math.min(Math.max(0, (straightLine - CHAIN_TOTAL_LENGTH * 0.85) / (CHAIN_TOTAL_LENGTH * 0.15)), 1);
      let r: number, g: number, bv: number;
      if (tension < 0.5) {
        const t = tension * 2;
        r = Math.floor(110 * t + 60 * (1 - t));
        g = Math.floor(180 * (1 - t) + 200 * t);
        bv = Math.floor(60 * (1 - t) + 40 * t);
      } else {
        const t = (tension - 0.5) * 2;
        r = Math.floor(255 * t + 200 * (1 - t));
        g = Math.floor(180 * (1 - t) + 80 * t);
        bv = 40;
      }

      // Dark outline + colored fill — two passes give the rope a comic-book chain
      // look without needing per-link art.
      ctx.lineWidth = 9;
      ctx.strokeStyle = '#0a0612';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();

      ctx.lineWidth = 6;
      ctx.strokeStyle = `rgb(${r}, ${g}, ${bv})`;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }

    ctx.restore();
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
