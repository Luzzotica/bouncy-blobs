import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData, ZoneDef } from '../../levels/types';
import { kothLevel } from '../../levels/kothLevel';
import { drawHillZone } from '../../renderer/zoneRenderer';

const TARGET_SCORE = 50;
const DEFAULT_HILL_ROTATION = { minSeconds: 8, maxSeconds: 13 };

/**
 * King of the Hill. Scoring (sole 2/s, contested 1/s), seeded hill rotation,
 * and the win rule all run in the Rust engine (Phase 9). This class registers
 * the hills + rotation, and reads the active hill / king / scores back for
 * rendering. The React <KothHud> reads scores from `GameModeState`.
 */
export class KingOfTheHillMode implements GameMode {
  readonly config: GameModeConfig = {
    id: 'koth',
    name: 'King of the Hill',
    description: 'Hold the hill to score points!',
    minPlayers: 1,
    maxPlayers: 8,
    timeLimitSec: 90,
    targetScore: TARGET_SCORE,
    countdownDuration: 3,
    resultsDuration: 5,
  };

  private levelData: LevelData;
  private world: SoftBodyEngine | null = null;

  constructor(levelData?: LevelData) {
    this.levelData = levelData ?? kothLevel;
  }

  getLevel(): LevelData { return this.levelData; }

  initialize(world: SoftBodyEngine, _playerManager: PlayerManager): void {
    this.world = world;
    world.setGameMode(1, this.config.timeLimitSec ?? 0, TARGET_SCORE);
    const zones = this.levelData.hillZones ?? [];
    for (const z of zones) world.addHillZone(z.x, z.y, z.width, z.height);
    if (zones.length >= 2) {
      const rot = this.levelData.hillRotation ?? DEFAULT_HILL_ROTATION;
      world.setHillRotation(rot.minSeconds, rot.maxSeconds);
    }
  }

  onPhaseStart(_phase: GamePhase, _state: GameModeState): void {}

  /** No-op: the engine advances scoring + hill rotation inside `world.step()`. */
  update(_dt: number, _state: GameModeState, _playerManager: PlayerManager, _world: SoftBodyEngine): void {}

  checkWinCondition(_state: GameModeState, playerManager: PlayerManager): string | null {
    if (!this.world?.modeDecided()) return null;
    const gid = this.world.modeWinner();
    if (gid < 0) return null;
    return playerManager.getPlayerByGameplayId(gid)?.playerId ?? null;
  }

  renderWorld(ctx: CanvasRenderingContext2D, _camera: Camera, _state: GameModeState, playerManager: PlayerManager): void {
    const hill = this.getActiveHill();
    if (!hill || !this.world) return;
    const gameTime = this.world.modeGameTime();
    const flash = Math.max(0, 1 - (gameTime - this.world.kothLastMoveTime()) / 0.6);
    const kingId = this.world.kothKingId();
    const kingColor = kingId >= 0 ? (playerManager.getPlayerByGameplayId(kingId)?.color ?? null) : null;
    drawHillZone(ctx, hill, gameTime, kingColor, flash);
  }

  renderHUD(): void {}

  cleanup(): void { this.world = null; }

  getActiveHill(): ZoneDef | null {
    const h = this.world?.kothActiveHill();
    if (!h || h.length !== 4) return null;
    return { id: 'hill', x: h[0], y: h[1], width: h[2], height: h[3] };
  }

  getGoalForBlob(): { x: number; y: number; width: number; height: number } | null {
    const h = this.getActiveHill();
    if (!h) return null;
    return { x: h.x, y: h.y, width: h.width, height: h.height };
  }
}
