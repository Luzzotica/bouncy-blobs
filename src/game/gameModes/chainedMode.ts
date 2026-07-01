import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData, ZoneDef } from '../../levels/types';
import { chainedLevel } from '../../levels/chainedLevel';
import { drawGoalZone } from '../../renderer/zoneRenderer';
import { drawTimer } from '../../renderer/hudRenderer';
import { drawChain } from '../../renderer/chainRenderer';

const CHAIN_TOTAL_LENGTH = 700;
const TETHER_STIFFNESS = 4;
const TETHER_MAX_FORCE = 560;

interface ChainPair { particleIndices: number[]; }

/**
 * Chained Together (team race). The all-in-goal win rule + timer now run in the
 * Rust engine (Phase 9); this class registers the mode + goal zone, still
 * creates the blob tethers TS-side (depends on player-spawn completion), and
 * renders the chains + goal zone.
 */
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
  private chainsCreated = false;

  constructor(levelData?: LevelData) {
    this.levelData = levelData ?? chainedLevel;
  }

  getLevel(): LevelData { return this.levelData; }

  initialize(world: SoftBodyEngine, _playerManager: PlayerManager): void {
    this.world = world;
    this.goalZone = this.levelData.goalZones?.[0] ?? null;
    world.setGameMode(2, this.config.timeLimitSec ?? 0, 0);
    if (this.goalZone) world.setGoalZone(this.goalZone.x, this.goalZone.y, this.goalZone.width, this.goalZone.height);
  }

  onPhaseStart(phase: GamePhase, _state: GameModeState): void {
    if (phase === 'playing') {
      this.chainPairs = [];
      this.chainsCreated = false;
    }
  }

  update(_dt: number, _state: GameModeState, playerManager: PlayerManager, world: SoftBodyEngine): void {
    // The engine scores the all-in-goal rule; TS only creates the tethers once
    // the players exist (they depend on spawn completion).
    if (!this.chainsCreated && playerManager.getPlayerCount() > 1) {
      this.createChains(playerManager, world);
      this.chainsCreated = true;
    }
  }

  private createChains(playerManager: PlayerManager, world: SoftBodyEngine): void {
    const players = playerManager.getAllPlayers();
    if (players.length < 2) return;
    for (let i = 0; i < players.length - 1; i++) {
      const a = players[i];
      const b = players[i + 1];
      world.addBlobTether(a.blob.blobId, b.blob.blobId, CHAIN_TOTAL_LENGTH, TETHER_STIFFNESS, TETHER_MAX_FORCE);
      this.chainPairs.push({ particleIndices: [a.blob.centerIdx, b.blob.centerIdx] });
    }
  }

  checkWinCondition(_state: GameModeState, playerManager: PlayerManager): string | null {
    if (!this.world?.modeDecided()) return null;
    const gid = this.world.modeWinner();
    if (gid < 0) return null;
    return playerManager.getPlayerByGameplayId(gid)?.playerId ?? null;
  }

  renderWorld(ctx: CanvasRenderingContext2D, _camera: Camera, _state: GameModeState, _playerManager: PlayerManager): void {
    if (this.goalZone) drawGoalZone(ctx, this.goalZone, this.world?.modeGameTime() ?? 0);
    if (this.world) {
      for (const pair of this.chainPairs) drawChain(ctx, this.world, pair.particleIndices, CHAIN_TOTAL_LENGTH);
    }
  }

  renderHUD(ctx: CanvasRenderingContext2D, width: number, height: number, state: GameModeState, _playerManager: PlayerManager): void {
    if (state.timeRemaining !== null) drawTimer(ctx, width, state.timeRemaining);
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
    return { x: this.goalZone.x, y: this.goalZone.y, width: this.goalZone.width, height: this.goalZone.height };
  }
}
