import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData, LevelType, PlatformDef } from '../../levels/types';
import { Vec2, vec2 } from '../../physics/vec2';
import { drawPlayerLabels } from '../../renderer/hudRenderer';

export interface VotingCandidate {
  id: string;
  name: string;
  levelType: LevelType;
  levelTypes?: LevelType[];
  source: 'builtin' | 'cloud';
  /** Optional level data for rendering a miniature preview. */
  previewLevel?: LevelData;
  /** True if this level belongs to the current user (private or public). */
  isOwn?: boolean;
}

interface GameModeOption {
  id: LevelType;
  label: string;
  color: string;
}

const GAME_MODE_OPTIONS: GameModeOption[] = [
  { id: 'solo_racing', label: 'Racing', color: '#4a9eff' },
  { id: 'team_racing', label: 'Team Race', color: '#4ae04a' },
  { id: 'party', label: 'Party', color: '#ff6a9e' },
  { id: 'koth', label: 'King of the Hill', color: '#ffa500' },
];

// Level zone dimensions (no raised platforms — zones painted on the floor)
const LEVEL_ZONE_WIDTH = 900;
const LEVEL_ZONE_SPACING = 1200;
const FLOOR_Y = 1100;

// Horseshoe enclosure for mode selector
const HORSESHOE_INNER_W = 500;
const HORSESHOE_WALL_THICKNESS = 50;
const HORSESHOE_LEG_HEIGHT = 250; // how far the legs extend down from the top bar
const MODE_SELECTOR_WIDTH = 360;
const MODE_SELECTOR_HEIGHT = 80;

const MODE_SWITCH_DEBOUNCE = 0.5; // seconds
const AUTO_COUNTDOWN_DURATION = 3.0; // seconds

export class VotingMode implements GameMode {
  readonly config: GameModeConfig = {
    id: 'voting',
    name: 'Level Vote',
    description: 'Stand on a level to vote!',
    minPlayers: 1,
    maxPlayers: 8,
    timeLimitSec: undefined,
    countdownDuration: 0,
    resultsDuration: 2.5,
  };

  private allCandidates: VotingCandidate[];
  private candidatesByMode: Map<LevelType, VotingCandidate[]>;
  private visibleCandidates: VotingCandidate[] = [];
  private level: LevelData;
  private zoneRanges: { candidateIdx: number; xMin: number; xMax: number }[] = [];
  private modeSelectorRange: { xMin: number; xMax: number; yMin: number; yMax: number } = { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
  private voteCounts: number[] = [];
  private selectedCandidate: VotingCandidate | null = null;
  private onVoteComplete?: (candidate: VotingCandidate) => void;
  private gameTime = 0;

  // Mode selector state
  private currentModeIndex = 0;
  private modeSelectorOccupied = false;
  private lastModeSwitchTime = -1;
  private buttonPressAmount = 0;
  private modeSwitchFlash = 0;

  // Auto-countdown state
  private autoCountdown = AUTO_COUNTDOWN_DURATION;
  private countdownActive = false;

  // Physics world reference for rebuilding
  private world: SoftBodyWorld | null = null;

  // Shared game mode state reference
  private modeState: GameModeState | null = null;

  // Smooth wall transition — current right wall X lerps to target
  private currentRightWallX = 0;
  private targetRightWallX = 0;
  // Horseshoe center X (fixed)
  private horseshoeX = 0;

  constructor(candidates: VotingCandidate[], onVoteComplete: (candidate: VotingCandidate) => void) {
    this.allCandidates = candidates;
    this.onVoteComplete = onVoteComplete;

    // Group candidates by mode
    this.candidatesByMode = new Map();
    for (const opt of GAME_MODE_OPTIONS) {
      this.candidatesByMode.set(opt.id, []);
    }
    for (const c of candidates) {
      const modes = c.levelTypes && c.levelTypes.length > 0 ? c.levelTypes : [c.levelType];
      for (const m of modes) {
        const group = this.candidatesByMode.get(m);
        if (group) group.push(c);
      }
    }

    // Find first mode that has candidates
    for (let i = 0; i < GAME_MODE_OPTIONS.length; i++) {
      const group = this.candidatesByMode.get(GAME_MODE_OPTIONS[i].id);
      if (group && group.length > 0) {
        this.currentModeIndex = i;
        break;
      }
    }

    this.visibleCandidates = this.getVisibleCandidates();
    this.voteCounts = new Array(this.visibleCandidates.length).fill(0);
    this.level = this.generateVotingLevel();
    this.currentRightWallX = this.targetRightWallX;
  }

  private getVisibleCandidates(): VotingCandidate[] {
    const modeId = GAME_MODE_OPTIONS[this.currentModeIndex].id;
    return this.candidatesByMode.get(modeId) ?? [];
  }

  private get currentModeOption(): GameModeOption {
    return GAME_MODE_OPTIONS[this.currentModeIndex];
  }

  private generateVotingLevel(): LevelData {
    const n = this.visibleCandidates.length;

    // Layout: horseshoe → spawn area → level zones stretching right
    const SPAWN_AREA_WIDTH = 800;

    const horseshoeOuterW = HORSESHOE_INNER_W + HORSESHOE_WALL_THICKNESS * 2;
    this.horseshoeX = -SPAWN_AREA_WIDTH / 2 - horseshoeOuterW / 2 - 300;
    const horseshoeCenterX = this.horseshoeX;

    const mapStartX = SPAWN_AREA_WIDTH / 2 + 600;
    const mapEndX = mapStartX + Math.max(0, n - 1) * LEVEL_ZONE_SPACING + LEVEL_ZONE_WIDTH / 2;

    const totalLeftEdge = horseshoeCenterX - horseshoeOuterW / 2 - 100;
    this.targetRightWallX = mapEndX + 400;
    const totalRightEdge = Math.max(this.currentRightWallX || this.targetRightWallX, this.targetRightWallX);
    const totalWidth = totalRightEdge - totalLeftEdge;

    // Horseshoe enclosure: top bar + two short legs, opening at bottom
    //   ┌────────────────────┐
    //   │                    │
    //   └──┐              ┌──┘
    //      │  (open)      │
    //      (legs end here, above floor so players can walk under)
    const hLeft = horseshoeCenterX - HORSESHOE_INNER_W / 2 - HORSESHOE_WALL_THICKNESS;
    const hRight = horseshoeCenterX + HORSESHOE_INNER_W / 2;
    const hTopY = FLOOR_Y - 500; // top of horseshoe
    const hLegBottomY = hTopY + HORSESHOE_WALL_THICKNESS + HORSESHOE_LEG_HEIGHT; // legs end well above floor

    // No platform — the button floats inside the horseshoe. Detection is based on
    // being inside the horseshoe area (between the legs, near the top).
    const buttonCenterY = hTopY + HORSESHOE_WALL_THICKNESS + 80;
    this.modeSelectorRange = {
      xMin: horseshoeCenterX - HORSESHOE_INNER_W / 2,
      xMax: horseshoeCenterX + HORSESHOE_INNER_W / 2,
      yMin: hTopY + HORSESHOE_WALL_THICKNESS,
      yMax: hLegBottomY,
    };

    // Level zones on the floor — no raised platforms, just detection areas
    this.zoneRanges = [];
    for (let i = 0; i < n; i++) {
      const zoneX = mapStartX + i * LEVEL_ZONE_SPACING;
      this.zoneRanges.push({
        candidateIdx: i,
        xMin: zoneX - LEVEL_ZONE_WIDTH / 2,
        xMax: zoneX + LEVEL_ZONE_WIDTH / 2,
      });
    }

    // Spawn area centered at x=0
    const spawnX = 0;
    const spawnY = FLOOR_Y - 80;

    // Walls
    const walls = [
      // Floor
      { id: 'floor', points: [
        { x: totalLeftEdge - 50, y: FLOOR_Y },
        { x: totalRightEdge + 200, y: FLOOR_Y },
        { x: totalRightEdge + 200, y: FLOOR_Y + 100 },
        { x: totalLeftEdge - 50, y: FLOOR_Y + 100 },
      ]},
      // Left boundary wall
      { id: 'left', points: [
        { x: totalLeftEdge - 100, y: -400 },
        { x: totalLeftEdge - 50, y: -400 },
        { x: totalLeftEdge - 50, y: FLOOR_Y + 100 },
        { x: totalLeftEdge - 100, y: FLOOR_Y + 100 },
      ]},
      // Right boundary wall (smoothly moved)
      { id: 'right', points: [
        { x: totalRightEdge + 150, y: -400 },
        { x: totalRightEdge + 200, y: -400 },
        { x: totalRightEdge + 200, y: FLOOR_Y + 100 },
        { x: totalRightEdge + 150, y: FLOOR_Y + 100 },
      ]},
      // Ceiling
      { id: 'ceiling', points: [
        { x: totalLeftEdge - 100, y: -400 },
        { x: totalRightEdge + 200, y: -400 },
        { x: totalRightEdge + 200, y: -300 },
        { x: totalLeftEdge - 100, y: -300 },
      ]},
      // Horseshoe left leg (short, ends above floor)
      { id: 'horseshoe-left', points: [
        { x: hLeft, y: hTopY },
        { x: hLeft + HORSESHOE_WALL_THICKNESS, y: hTopY },
        { x: hLeft + HORSESHOE_WALL_THICKNESS, y: hLegBottomY },
        { x: hLeft, y: hLegBottomY },
      ]},
      // Horseshoe right leg (short, ends above floor)
      { id: 'horseshoe-right', points: [
        { x: hRight, y: hTopY },
        { x: hRight + HORSESHOE_WALL_THICKNESS, y: hTopY },
        { x: hRight + HORSESHOE_WALL_THICKNESS, y: hLegBottomY },
        { x: hRight, y: hLegBottomY },
      ]},
      // Horseshoe top bar (connects the two legs)
      { id: 'horseshoe-top', points: [
        { x: hLeft, y: hTopY },
        { x: hRight + HORSESHOE_WALL_THICKNESS, y: hTopY },
        { x: hRight + HORSESHOE_WALL_THICKNESS, y: hTopY + HORSESHOE_WALL_THICKNESS },
        { x: hLeft, y: hTopY + HORSESHOE_WALL_THICKNESS },
      ]},
    ];

    return {
      name: 'Level Vote',
      version: 1,
      bounds: { width: totalWidth + 600, height: 1600 },
      platforms: [], // no platforms — button is visual only
      walls,
      spawnPoints: [
        { id: 'sp1', x: spawnX - 60, y: spawnY, type: 'player' as const },
        { id: 'sp2', x: spawnX - 20, y: spawnY, type: 'player' as const },
        { id: 'sp3', x: spawnX + 20, y: spawnY, type: 'player' as const },
        { id: 'sp4', x: spawnX + 60, y: spawnY, type: 'player' as const },
        { id: 'sp5', x: spawnX + 100, y: spawnY, type: 'player' as const },
        { id: 'sp6', x: spawnX + 140, y: spawnY, type: 'player' as const },
        { id: 'sp7', x: spawnX + 180, y: spawnY, type: 'player' as const },
        { id: 'sp8', x: spawnX + 220, y: spawnY, type: 'player' as const },
      ],
      npcBlobs: [],
    };
  }

  /** Rebuild level geometry after mode switch. Smoothly transitions the right wall. */
  private rebuildMapPlatforms(): void {
    const prevRightWall = this.currentRightWallX;
    this.visibleCandidates = this.getVisibleCandidates();
    this.voteCounts = new Array(this.visibleCandidates.length).fill(0);
    // Keep the current right wall position for smooth transition
    this.currentRightWallX = prevRightWall;
    this.level = this.generateVotingLevel();
    this.syncPhysicsGeometry();

    this.autoCountdown = AUTO_COUNTDOWN_DURATION;
    this.countdownActive = false;
  }

  /** Sync physics world with current level geometry. */
  private syncPhysicsGeometry(): void {
    if (!this.world) return;
    this.world.clearStaticPolygons();
    for (const platform of this.level.platforms) {
      const hw = platform.width / 2;
      const hh = platform.height / 2;
      this.world.registerStaticPolygon([
        vec2(platform.x - hw, platform.y - hh),
        vec2(platform.x + hw, platform.y - hh),
        vec2(platform.x + hw, platform.y + hh),
        vec2(platform.x - hw, platform.y + hh),
      ]);
    }
    for (const wall of this.level.walls) {
      this.world.registerStaticPolygon(wall.points.map(p => vec2(p.x, p.y)));
    }
  }

  getLevel(): LevelData {
    return this.level;
  }

  initialize(world: SoftBodyWorld, _playerManager: PlayerManager): void {
    this.world = world;
  }

  onPhaseStart(phase: GamePhase, state: GameModeState): void {
    this.modeState = state;
    if (phase === 'playing') {
      this.gameTime = 0;
      this.selectedCandidate = null;
      this.autoCountdown = AUTO_COUNTDOWN_DURATION;
      this.countdownActive = false;
    }
  }

  update(dt: number, _state: GameModeState, playerManager: PlayerManager, _world: SoftBodyWorld): void {
    this.gameTime += dt;

    // --- Smooth right wall transition ---
    if (Math.abs(this.currentRightWallX - this.targetRightWallX) > 1) {
      const wallAlpha = 1 - Math.exp(-2.0 * dt);
      this.currentRightWallX += (this.targetRightWallX - this.currentRightWallX) * wallAlpha;
      // Regenerate level with new wall position and re-sync physics
      this.level = this.generateVotingLevel();
      this.syncPhysicsGeometry();
    }

    const allPlayers = playerManager.getAllPlayers();

    // --- Mode selector: cycle on first-land ---
    let anyOnModeSelector = false;
    for (const player of allPlayers) {
      const centroid = player.blob.getCentroid();
      if (centroid.x >= this.modeSelectorRange.xMin && centroid.x <= this.modeSelectorRange.xMax &&
          centroid.y >= this.modeSelectorRange.yMin && centroid.y <= this.modeSelectorRange.yMax) {
        anyOnModeSelector = true;
        break;
      }
    }

    if (anyOnModeSelector && !this.modeSelectorOccupied &&
        this.gameTime - this.lastModeSwitchTime > MODE_SWITCH_DEBOUNCE) {
      let nextIndex = this.currentModeIndex;
      for (let i = 0; i < GAME_MODE_OPTIONS.length; i++) {
        nextIndex = (nextIndex + 1) % GAME_MODE_OPTIONS.length;
        const group = this.candidatesByMode.get(GAME_MODE_OPTIONS[nextIndex].id);
        if (group && group.length > 0) break;
      }
      if (nextIndex !== this.currentModeIndex) {
        this.currentModeIndex = nextIndex;
        this.lastModeSwitchTime = this.gameTime;
        this.modeSwitchFlash = 0.4;
        this.rebuildMapPlatforms();
      }
    }
    this.modeSelectorOccupied = anyOnModeSelector;

    // Animate button press
    const pressTarget = anyOnModeSelector ? 1 : 0;
    const pressSpeed = anyOnModeSelector ? 8 : 5;
    this.buttonPressAmount += (pressTarget - this.buttonPressAmount) * Math.min(1, pressSpeed * dt);

    if (this.modeSwitchFlash > 0) {
      this.modeSwitchFlash = Math.max(0, this.modeSwitchFlash - dt);
    }

    // --- Count votes in level zones (on the floor, no platforms needed) ---
    this.voteCounts = new Array(this.visibleCandidates.length).fill(0);
    let playersInZones = 0;
    for (const player of allPlayers) {
      const centroid = player.blob.getCentroid();
      // Player must be on or near the floor
      if (centroid.y < FLOOR_Y - 200 || centroid.y > FLOOR_Y + 10) continue;
      for (const range of this.zoneRanges) {
        if (centroid.x >= range.xMin && centroid.x <= range.xMax) {
          this.voteCounts[range.candidateIdx]++;
          playersInZones++;
          break;
        }
      }
    }

    // --- Auto-countdown: all players in level zones ---
    const totalPlayers = allPlayers.length;
    if (totalPlayers > 0 && playersInZones >= totalPlayers) {
      this.countdownActive = true;
      this.autoCountdown -= dt;
      if (this.autoCountdown <= 0) {
        if (this.modeState) {
          this.modeState.timeRemaining = 0;
        }
      }
    } else {
      this.autoCountdown = AUTO_COUNTDOWN_DURATION;
      this.countdownActive = false;
    }
  }

  checkWinCondition(_state: GameModeState, _playerManager: PlayerManager): string | null {
    return null;
  }

  resolveVote(): VotingCandidate {
    if (this.selectedCandidate) return this.selectedCandidate;

    const totalVotes = this.voteCounts.reduce((a, b) => a + b, 0);

    if (totalVotes === 0) {
      if (this.visibleCandidates.length === 0) {
        this.selectedCandidate = this.allCandidates[Math.floor(Math.random() * this.allCandidates.length)];
        return this.selectedCandidate;
      }
      this.selectedCandidate = this.visibleCandidates[Math.floor(Math.random() * this.visibleCandidates.length)];
      return this.selectedCandidate;
    }

    let r = Math.random() * totalVotes;
    for (let i = 0; i < this.visibleCandidates.length; i++) {
      r -= this.voteCounts[i];
      if (r <= 0) {
        this.selectedCandidate = this.visibleCandidates[i];
        return this.selectedCandidate;
      }
    }

    this.selectedCandidate = this.visibleCandidates[this.visibleCandidates.length - 1];
    return this.selectedCandidate;
  }

  renderWorld(ctx: CanvasRenderingContext2D, _camera: Camera, _state: GameModeState, playerManager: PlayerManager): void {
    ctx.save();

    const modeOpt = this.currentModeOption;

    // --- Draw level zones on the floor ---
    const n = this.visibleCandidates.length;
    const PREVIEW_W = 500;
    const PREVIEW_H = 300;

    for (let i = 0; i < n; i++) {
      const c = this.visibleCandidates[i];
      const range = this.zoneRanges[i];
      if (!range) continue;
      const votes = this.voteCounts[i];
      const zoneX = (range.xMin + range.xMax) / 2;
      const zoneW = range.xMax - range.xMin;

      // Zone highlight on floor
      ctx.save();
      const zoneAlpha = votes > 0 ? 0.15 + votes * 0.08 : 0.04;
      ctx.globalAlpha = zoneAlpha;
      ctx.fillStyle = votes > 0 ? modeOpt.color : '#4a5a7a';
      ctx.fillRect(range.xMin, FLOOR_Y - 300, zoneW, 300);
      ctx.restore();

      // Zone border lines
      ctx.save();
      ctx.strokeStyle = votes > 0 ? modeOpt.color : 'rgba(80, 100, 140, 0.3)';
      ctx.lineWidth = votes > 0 ? 2 : 1;
      ctx.setLineDash([8, 8]);
      // Left border
      ctx.beginPath();
      ctx.moveTo(range.xMin, FLOOR_Y);
      ctx.lineTo(range.xMin, FLOOR_Y - 300);
      ctx.stroke();
      // Right border
      ctx.beginPath();
      ctx.moveTo(range.xMax, FLOOR_Y);
      ctx.lineTo(range.xMax, FLOOR_Y - 300);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Preview frame
      const previewTop = FLOOR_Y - PREVIEW_H - 340;
      ctx.save();
      ctx.beginPath();
      this.roundRect(ctx, zoneX - PREVIEW_W / 2, previewTop, PREVIEW_W, PREVIEW_H, 12);
      ctx.fillStyle = 'rgba(15, 20, 35, 0.8)';
      ctx.fill();
      ctx.strokeStyle = votes > 0 ? modeOpt.color : 'rgba(60, 80, 120, 0.5)';
      ctx.lineWidth = votes > 0 ? 2 : 1;
      ctx.stroke();
      ctx.restore();

      // Level preview
      if (c.previewLevel) {
        this.drawLevelPreview(ctx, c.previewLevel, zoneX - PREVIEW_W / 2 + 10, previewTop + 10, PREVIEW_W - 20, PREVIEW_H - 20, modeOpt.color);
      } else {
        ctx.save();
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#444';
        ctx.fillText('Preview unavailable', zoneX, previewTop + PREVIEW_H / 2);
        ctx.restore();
      }

      // Level name
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(c.name, zoneX, previewTop - 14);

      // "Yours" badge
      if (c.isOwn) {
        ctx.font = 'bold 13px sans-serif';
        ctx.fillStyle = '#c77dff';
        ctx.fillText('yours', zoneX, previewTop - 44);
      }

      // Vote count
      if (votes > 0) {
        ctx.font = 'bold 32px sans-serif';
        ctx.fillStyle = '#ffd700';
        ctx.textBaseline = 'top';
        ctx.fillText(`${votes}`, zoneX, previewTop - 54);
      }
    }

    // --- Draw jelly button floating inside the horseshoe ---
    const bx = this.horseshoeX;
    const hTopY = FLOOR_Y - 500;
    const buttonCenterY = hTopY + HORSESHOE_WALL_THICKNESS + 80;
    const bw = MODE_SELECTOR_WIDTH;

    const press = this.buttonPressAmount;
    const btnHeight = 70;
    const squish = press * 18;
    const bulge = press * 10;

    const btnBotY = buttonCenterY + btnHeight / 2;
    const btnTopY = buttonCenterY - btnHeight / 2 + squish;
    const halfW = bw / 2 + bulge;
    const cornerR = 18 + bulge * 0.5;

    // Base/shadow
    ctx.save();
    const baseHalfW = bw / 2 + 8;
    ctx.beginPath();
    this.roundRect(ctx, bx - baseHalfW, btnBotY - 10, baseHalfW * 2, 10, 5);
    ctx.fillStyle = this.darkenColor(modeOpt.color, 0.35);
    ctx.fill();
    ctx.restore();

    // Button body
    ctx.save();
    const bodyH = btnBotY - btnTopY;

    const glowAlpha = Math.max(press * 0.25, this.modeSwitchFlash * 0.6);
    if (glowAlpha > 0.01) {
      ctx.shadowColor = modeOpt.color;
      ctx.shadowBlur = 30 + press * 20;
      ctx.globalAlpha = glowAlpha;
      ctx.beginPath();
      this.roundRect(ctx, bx - halfW, btnTopY, halfW * 2, bodyH, cornerR);
      ctx.fillStyle = modeOpt.color;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    const bodyGrad = ctx.createLinearGradient(bx, btnTopY, bx, btnBotY);
    bodyGrad.addColorStop(0, this.lightenColor(modeOpt.color, 0.25));
    bodyGrad.addColorStop(0.5, modeOpt.color);
    bodyGrad.addColorStop(1, this.darkenColor(modeOpt.color, 0.25));
    ctx.beginPath();
    this.roundRect(ctx, bx - halfW, btnTopY, halfW * 2, bodyH, cornerR);
    ctx.fillStyle = bodyGrad;
    ctx.fill();

    // Glossy highlight
    ctx.save();
    ctx.globalAlpha = 0.35 - press * 0.15;
    const highlightH = bodyH * 0.35;
    const hlGrad = ctx.createLinearGradient(bx, btnTopY, bx, btnTopY + highlightH);
    hlGrad.addColorStop(0, 'rgba(255,255,255,0.6)');
    hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    this.roundRect(ctx, bx - halfW + 6, btnTopY + 3, (halfW - 6) * 2, highlightH, cornerR - 4);
    ctx.fillStyle = hlGrad;
    ctx.fill();
    ctx.restore();

    // Border
    ctx.beginPath();
    this.roundRect(ctx, bx - halfW, btnTopY, halfW * 2, bodyH, cornerR);
    ctx.strokeStyle = this.darkenColor(modeOpt.color, 0.3);
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    // Mode label
    const labelY = btnTopY + bodyH / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 4;
    ctx.fillText(modeOpt.label, bx, labelY - 3);
    ctx.shadowBlur = 0;

    // Hint above button
    ctx.textBaseline = 'bottom';
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText('Jump to change!', bx, btnTopY - 10);

    // Arrows
    ctx.font = '18px sans-serif';
    ctx.fillStyle = modeOpt.color;
    ctx.globalAlpha = 0.5 + Math.sin(this.gameTime * 3) * 0.3;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('\u25C0', bx - halfW - 18, labelY - 3);
    ctx.fillText('\u25B6', bx + halfW + 18, labelY - 3);
    ctx.globalAlpha = 1;

    // --- Player name labels ---
    drawPlayerLabels(ctx, playerManager.getAllPlayers());

    ctx.restore();
  }

  /** Draw a miniature level preview inside a bounding box. */
  private drawLevelPreview(
    ctx: CanvasRenderingContext2D,
    level: LevelData,
    dx: number, dy: number, dw: number, dh: number,
    accentColor: string,
  ): void {
    const bounds = level.bounds;
    const lw = bounds.width;
    const lh = bounds.height;

    const scaleX = dw / lw;
    const scaleY = dh / lh;
    const s = Math.min(scaleX, scaleY) * 0.9;
    const ox = dx + (dw - lw * s) / 2;
    const oy = dy + (dh - lh * s) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();

    ctx.fillStyle = 'rgba(100, 140, 200, 0.5)';
    ctx.strokeStyle = 'rgba(140, 180, 240, 0.4)';
    ctx.lineWidth = 1;
    for (const p of level.platforms) {
      const pw = p.width * s;
      const ph = Math.max(p.height * s, 3);
      const ppx = ox + p.x * s - pw / 2;
      const ppy = oy + p.y * s - ph / 2;
      const pr = Math.min(ph / 2, 4);
      ctx.beginPath();
      this.roundRect(ctx, ppx, ppy, pw, ph, pr);
      ctx.fill();
      ctx.stroke();
    }

    if (level.goalZones) {
      ctx.fillStyle = 'rgba(80, 255, 80, 0.2)';
      ctx.strokeStyle = 'rgba(80, 255, 80, 0.4)';
      for (const z of level.goalZones) {
        const zx = ox + (z.x - z.width / 2) * s;
        const zy = oy + (z.y - z.height / 2) * s;
        ctx.fillRect(zx, zy, z.width * s, z.height * s);
        ctx.strokeRect(zx, zy, z.width * s, z.height * s);
      }
    }

    if (level.hillZones) {
      ctx.fillStyle = 'rgba(255, 165, 0, 0.2)';
      ctx.strokeStyle = 'rgba(255, 165, 0, 0.4)';
      for (const z of level.hillZones) {
        const zx = ox + (z.x - z.width / 2) * s;
        const zy = oy + (z.y - z.height / 2) * s;
        ctx.fillRect(zx, zy, z.width * s, z.height * s);
        ctx.strokeRect(zx, zy, z.width * s, z.height * s);
      }
    }

    if (level.spikes) {
      ctx.fillStyle = 'rgba(255, 60, 60, 0.4)';
      for (const sp of level.spikes) {
        const sx = ox + sp.x * s - (sp.width * s) / 2;
        const sy = oy + sp.y * s - (sp.height * s) / 2;
        ctx.fillRect(sx, sy, sp.width * s, Math.max(sp.height * s, 2));
      }
    }

    ctx.fillStyle = 'rgba(199, 125, 255, 0.6)';
    for (const sp of level.spawnPoints) {
      if (sp.type !== 'player') continue;
      ctx.beginPath();
      ctx.arc(ox + sp.x * s, oy + sp.y * s, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  private lightenColor(hex: string, factor: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r + (255 - r) * factor)},${Math.round(g + (255 - g) * factor)},${Math.round(b + (255 - b) * factor)})`;
  }

  private darkenColor(hex: string, factor: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r * (1 - factor))},${Math.round(g * (1 - factor))},${Math.round(b * (1 - factor))})`;
  }

  renderHUD(ctx: CanvasRenderingContext2D, width: number, height: number, _state: GameModeState, _playerManager: PlayerManager): void {
    ctx.save();

    const modeOpt = this.currentModeOption;
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = modeOpt.color;
    ctx.fillText(modeOpt.label, width / 2, 16);

    ctx.font = '15px sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText('Stand on a level to vote!', width / 2, 50);

    if (this.countdownActive) {
      const count = Math.ceil(this.autoCountdown);
      const text = count > 0 ? String(count) : 'GO!';

      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(0, height / 2 - 80, width, 160);

      ctx.font = 'bold 100px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = count > 0 ? '#fff' : '#4eff4e';
      ctx.fillText(text, width / 2, height / 2);

      ctx.font = '18px sans-serif';
      ctx.fillStyle = '#ccc';
      ctx.fillText('All players ready!', width / 2, height / 2 + 65);
    }

    ctx.restore();
  }

  cleanup(): void {
    this.onVoteComplete = undefined;
    this.modeState = null;
    this.world = null;
  }
}
