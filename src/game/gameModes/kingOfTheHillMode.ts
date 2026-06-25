import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData, ZoneDef } from '../../levels/types';
import { kothLevel } from '../../levels/kothLevel';
import { drawHillZone } from '../../renderer/zoneRenderer';
import { isPointInPolygon } from '../../physics/collision';
import { vec2 } from '../../physics/vec2';

const TARGET_SCORE = 50;
const SOLE_OCCUPANT_RATE = 2; // pts/sec
const CONTESTED_RATE = 1; // pts/sec

/** Default move interval when a KOTH level has 2+ hills but no explicit
 *  `hillRotation`. Averages ~10s. Multiple hill zones are meaningless in KOTH
 *  *except* as rotation targets (only one hill is ever active), so 2+ hills
 *  rotate by default — a level pins a single static hill by defining just one. */
const DEFAULT_HILL_ROTATION = { minSeconds: 8, maxSeconds: 13 };

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
  /** Index into `levelData.hillZones` of the currently-active hill. */
  private currentHillIndex = 0;
  /** `gameTime` (seconds) at which the hill next moves, or null until the
   *  first interval is rolled. Only used when hill rotation is enabled. */
  private nextMoveTime: number | null = null;
  /** `gameTime` of the most recent hill move — drives the spawn-flash glow. */
  private lastMoveTime = -999;

  constructor(levelData?: LevelData) {
    this.levelData = levelData ?? kothLevel;
  }

  getLevel(): LevelData {
    return this.levelData;
  }

  initialize(_world: SoftBodyEngine, _playerManager: PlayerManager): void {
    this.currentHillIndex = 0;
    this.hillZone = this.levelData.hillZones?.[0] ?? null;
  }

  onPhaseStart(phase: GamePhase, state: GameModeState): void {
    if (phase === 'playing') {
      state.scores.clear();
      this.gameTime = 0;
      this.currentHillIndex = 0;
      this.hillZone = this.levelData.hillZones?.[0] ?? null;
      this.nextMoveTime = null;
      this.lastMoveTime = -999;
      this.currentKingColor = null;
    }
  }

  /** When hill rotation is configured and 2+ hills exist, move the active hill
   *  to a random *other* zone after a random interval. All randomness is drawn
   *  from `world.rng` (the Rust-owned, host/guest-shared stream) at the same
   *  tick on every client, so the moving hill stays netcode-deterministic. */
  private maybeRotateHill(world: SoftBodyEngine): void {
    const zones = this.levelData.hillZones ?? [];
    if (zones.length < 2) return;
    // 2+ hills rotate by default; `hillRotation` only customizes the interval.
    const rot = this.levelData.hillRotation ?? DEFAULT_HILL_ROTATION;

    const lo = Math.max(0.5, rot.minSeconds);
    const hi = Math.max(lo, rot.maxSeconds);

    if (this.nextMoveTime === null) {
      this.nextMoveTime = this.gameTime + world.rng.range(lo, hi);
      return;
    }
    if (this.gameTime < this.nextMoveTime) return;

    // Pick a uniform index among the OTHER zones (never repeat the current).
    const n = zones.length;
    let next = world.rng.int(0, n - 1); // 0 .. n-2
    if (next >= this.currentHillIndex) next++;
    this.currentHillIndex = next;
    this.hillZone = zones[next];
    this.lastMoveTime = this.gameTime;
    this.nextMoveTime = this.gameTime + world.rng.range(lo, hi);
  }

  update(dt: number, state: GameModeState, playerManager: PlayerManager, world: SoftBodyEngine): void {
    this.gameTime += dt;
    this.maybeRotateHill(world);
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

  renderWorld(ctx: CanvasRenderingContext2D, _camera: Camera, _state: GameModeState, _playerManager: PlayerManager): void {
    if (this.hillZone) {
      // Bright flash for ~0.6s after the hill jumps to a new zone.
      const flash = Math.max(0, 1 - (this.gameTime - this.lastMoveTime) / 0.6);
      drawHillZone(ctx, this.hillZone, this.gameTime, this.currentKingColor, flash);
    }
  }

  // Timer + scoreboard are rendered by the React <KothHud> overlay, not the
  // canvas. The hill zone itself is still drawn in renderWorld above.
  renderHUD(_ctx: CanvasRenderingContext2D, _width: number, _height: number, _state: GameModeState, _playerManager: PlayerManager): void {}

  cleanup(): void {
    this.currentKingColor = null;
  }

  dumpState(): {
    gameTime: number;
    currentKingColor: string | null;
    currentHillIndex: number;
    nextMoveTime: number | null;
    lastMoveTime: number;
  } {
    return {
      gameTime: this.gameTime,
      currentKingColor: this.currentKingColor,
      currentHillIndex: this.currentHillIndex,
      nextMoveTime: this.nextMoveTime,
      lastMoveTime: this.lastMoveTime,
    };
  }
  restoreState(state: {
    gameTime: number;
    currentKingColor: string | null;
    currentHillIndex?: number;
    nextMoveTime?: number | null;
    lastMoveTime?: number;
  }): void {
    this.gameTime = state.gameTime;
    this.currentKingColor = state.currentKingColor;
    if (typeof state.currentHillIndex === 'number') {
      this.currentHillIndex = state.currentHillIndex;
      this.hillZone = this.levelData.hillZones?.[state.currentHillIndex] ?? this.hillZone;
    }
    if (state.nextMoveTime !== undefined) this.nextMoveTime = state.nextMoveTime;
    if (typeof state.lastMoveTime === 'number') this.lastMoveTime = state.lastMoveTime;
  }

  /** The currently-active hill zone (changes over time when hill rotation is
   *  enabled). Exposed for tests/diagnostics. */
  getActiveHill(): ZoneDef | null {
    return this.hillZone;
  }

  getGoalForBlob(): { x: number; y: number; width: number; height: number } | null {
    if (!this.hillZone) return null;
    return {
      x: this.hillZone.x,
      y: this.hillZone.y,
      width: this.hillZone.width,
      height: this.hillZone.height,
    };
  }
}
