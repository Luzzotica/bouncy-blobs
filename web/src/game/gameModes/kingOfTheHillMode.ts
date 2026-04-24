import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData, ZoneDef } from '../../levels/types';
import { kothLevel } from '../../levels/kothLevel';
import { drawHillZone } from '../../renderer/zoneRenderer';
import { drawPlayerLabels, drawScoreBoard, drawTimer } from '../../renderer/hudRenderer';
import { isPointInPolygon } from '../../physics/collision';
import { vec2 } from '../../physics/vec2';

const TARGET_SCORE = 50;
const SOLE_OCCUPANT_RATE = 2; // pts/sec
const CONTESTED_RATE = 1; // pts/sec

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
  private hillZone: ZoneDef | null = null;
  private gameTime = 0;
  private currentKingColor: string | null = null;

  constructor(levelData?: LevelData) {
    this.levelData = levelData ?? kothLevel;
  }

  getLevel(): LevelData {
    return this.levelData;
  }

  initialize(_world: SoftBodyWorld, _playerManager: PlayerManager): void {
    this.hillZone = this.levelData.hillZones?.[0] ?? null;
  }

  onPhaseStart(phase: GamePhase, state: GameModeState): void {
    if (phase === 'playing') {
      state.scores.clear();
      this.gameTime = 0;
    }
  }

  update(dt: number, state: GameModeState, playerManager: PlayerManager, _world: SoftBodyWorld): void {
    this.gameTime += dt;
    if (!this.hillZone) return;

    // Build hill polygon for point-in-polygon checks
    const hz = this.hillZone;
    const hw = hz.width / 2;
    const hh = hz.height / 2;
    const hillPoly = [
      vec2(hz.x - hw, hz.y - hh),
      vec2(hz.x + hw, hz.y - hh),
      vec2(hz.x + hw, hz.y + hh),
      vec2(hz.x - hw, hz.y + hh),
    ];

    // Check which players are on the hill
    const onHill: string[] = [];
    for (const p of playerManager.getAllPlayers()) {
      const centroid = p.blob.getCentroid();
      if (isPointInPolygon(centroid, hillPoly)) {
        onHill.push(p.playerId);
      }
    }

    // Score players on the hill
    const rate = onHill.length === 1 ? SOLE_OCCUPANT_RATE : CONTESTED_RATE;
    for (const pid of onHill) {
      const prev = state.scores.get(pid) ?? 0;
      state.scores.set(pid, prev + rate * dt);
    }

    // Track king color for rendering
    if (onHill.length === 1) {
      const king = playerManager.getPlayer(onHill[0]);
      this.currentKingColor = king?.color ?? null;
    } else {
      this.currentKingColor = null;
    }
  }

  checkWinCondition(state: GameModeState, playerManager: PlayerManager): string | null {
    // Check target score
    for (const [pid, score] of state.scores) {
      if (score >= TARGET_SCORE) return pid;
    }

    // Time's up — highest score wins
    if (state.timeRemaining !== null && state.timeRemaining <= 0) {
      let bestId: string | null = null;
      let bestScore = -1;
      for (const [pid, score] of state.scores) {
        if (score > bestScore) {
          bestScore = score;
          bestId = pid;
        }
      }
      return bestId;
    }

    return null;
  }

  renderWorld(ctx: CanvasRenderingContext2D, _camera: Camera, state: GameModeState, playerManager: PlayerManager): void {
    if (this.hillZone) {
      drawHillZone(ctx, this.hillZone, this.gameTime, this.currentKingColor);
    }
    drawPlayerLabels(ctx, playerManager.getAllPlayers());
  }

  renderHUD(ctx: CanvasRenderingContext2D, width: number, height: number, state: GameModeState, playerManager: PlayerManager): void {
    if (state.timeRemaining !== null) {
      drawTimer(ctx, width, state.timeRemaining);
    }
    drawScoreBoard(ctx, width, playerManager.getAllPlayers(), state.scores, TARGET_SCORE);
  }

  cleanup(): void {
    this.currentKingColor = null;
  }
}
