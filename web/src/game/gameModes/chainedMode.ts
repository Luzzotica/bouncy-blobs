import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager, ManagedPlayer } from '../playerManager';
import { LevelData, ZoneDef } from '../../levels/types';
import { chainedLevel } from '../../levels/chainedLevel';
import { drawGoalZone } from '../../renderer/zoneRenderer';
import { drawPlayerLabels, drawTimer } from '../../renderer/hudRenderer';
import { Vec2, vec2, sub, length } from '../../physics/vec2';

const CHAIN_MAX_DIST = 350;

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
  private world: SoftBodyWorld | null = null;
  private chainPairs: { pidA: string; pidB: string }[] = [];
  private allReachedGoal = false;
  private gameTime = 0;

  constructor(levelData?: LevelData) {
    this.levelData = levelData ?? chainedLevel;
  }

  getLevel(): LevelData {
    return this.levelData;
  }

  initialize(world: SoftBodyWorld, _playerManager: PlayerManager): void {
    this.world = world;
    this.goalZone = this.levelData.goalZones?.[0] ?? null;

    // Hook trigger for goal detection
    if (this.goalZone) {
      const prevEntered = world.onTriggerEntered;
      world.onTriggerEntered = (triggerShapeIdx, blobId) => {
        prevEntered?.(triggerShapeIdx, blobId);
      };
    }
  }

  onPhaseStart(phase: GamePhase, state: GameModeState): void {
    if (phase === 'playing') {
      this.allReachedGoal = false;
      this.gameTime = 0;
      // Chains are created when we first know about players — handled in update
      this.chainPairs = [];
    }
  }

  private chainsCreated = false;

  update(dt: number, state: GameModeState, playerManager: PlayerManager, world: SoftBodyWorld): void {
    this.gameTime += dt;

    // Create chains on first update (players are already added by now)
    if (!this.chainsCreated && playerManager.getPlayerCount() > 1) {
      this.createChains(playerManager, world);
      this.chainsCreated = true;
    }

    // Check if all players reached goal
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

  private createChains(playerManager: PlayerManager, world: SoftBodyWorld): void {
    const players = playerManager.getAllPlayers();
    if (players.length < 2) return;

    // Chain each player to the next in a line
    for (let i = 0; i < players.length - 1; i++) {
      const a = players[i];
      const b = players[i + 1];
      world.addDistanceMax(a.blob.centerIdx, b.blob.centerIdx, CHAIN_MAX_DIST);
      this.chainPairs.push({ pidA: a.playerId, pidB: b.playerId });
    }
  }

  checkWinCondition(state: GameModeState, playerManager: PlayerManager): string | null {
    // All players reached goal — everyone wins (return first player as "winner")
    if (this.allReachedGoal) {
      const players = playerManager.getAllPlayers();
      return players[0]?.playerId ?? null;
    }

    // Time's up — highest player (lowest Y in world coords) wins
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

  renderWorld(ctx: CanvasRenderingContext2D, _camera: Camera, state: GameModeState, playerManager: PlayerManager): void {
    // Draw goal zone
    if (this.goalZone) {
      drawGoalZone(ctx, this.goalZone, this.gameTime);
    }

    // Draw chains between connected players
    this.renderChains(ctx, playerManager);

    // Draw player labels
    drawPlayerLabels(ctx, playerManager.getAllPlayers());
  }

  private renderChains(ctx: CanvasRenderingContext2D, playerManager: PlayerManager): void {
    ctx.save();
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';

    for (const pair of this.chainPairs) {
      const a = playerManager.getPlayer(pair.pidA);
      const b = playerManager.getPlayer(pair.pidB);
      if (!a || !b) continue;

      const posA = a.blob.getCentroid();
      const posB = b.blob.getCentroid();
      const dist = length(sub(posB, posA));
      const tension = Math.min(dist / CHAIN_MAX_DIST, 1);

      // Color: green (slack) -> yellow -> red (taut)
      let r: number, g: number, bv: number;
      if (tension < 0.5) {
        const t = tension * 2;
        r = Math.floor(100 * t + 50 * (1 - t));
        g = 200;
        bv = Math.floor(50 * (1 - t));
      } else {
        const t = (tension - 0.5) * 2;
        r = Math.floor(255 * t + 200 * (1 - t));
        g = Math.floor(200 * (1 - t) + 80 * t);
        bv = 50;
      }
      ctx.strokeStyle = `rgb(${r}, ${g}, ${bv})`;

      // Draw chain as dashed line
      ctx.setLineDash([12, 8]);
      ctx.beginPath();
      ctx.moveTo(posA.x, posA.y);
      ctx.lineTo(posB.x, posB.y);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.restore();
  }

  renderHUD(ctx: CanvasRenderingContext2D, width: number, height: number, state: GameModeState, _playerManager: PlayerManager): void {
    if (state.timeRemaining !== null) {
      drawTimer(ctx, width, state.timeRemaining);
    }

    // Show "All players must reach the goal!" hint
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
}
