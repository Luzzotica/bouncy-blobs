import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData, LevelType, PlatformDef } from '../../levels/types';
import { vec2 } from '../../physics/vec2';
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

const PLATFORM_WIDTH = 350;
const PLATFORM_HEIGHT = 50;
const PLATFORM_SPACING = 600;
const PLATFORM_Y = 800;
const MODE_SELECTOR_WIDTH = 360;
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
  private platformRanges: { candidateIdx: number; xMin: number; xMax: number }[] = [];
  private modeSelectorRange: { xMin: number; xMax: number; yMin: number; yMax: number } = { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
  private voteCounts: number[] = [];
  private selectedCandidate: VotingCandidate | null = null;
  private onVoteComplete?: (candidate: VotingCandidate) => void;
  private gameTime = 0;

  // Mode selector state
  private currentModeIndex = 0;
  private modeSelectorOccupied = false;
  private lastModeSwitchTime = -1;
  /** Smooth 0→1 press animation for the mode button */
  private buttonPressAmount = 0;
  /** Brief flash timer when mode switches */
  private modeSwitchFlash = 0;

  // Auto-countdown state
  private autoCountdown = AUTO_COUNTDOWN_DURATION;
  private countdownActive = false;

  // Physics world reference for rebuilding platforms
  private world: SoftBodyWorld | null = null;

  // Shared game mode state reference
  private modeState: GameModeState | null = null;

  constructor(candidates: VotingCandidate[], onVoteComplete: (candidate: VotingCandidate) => void) {
    this.allCandidates = candidates;
    this.onVoteComplete = onVoteComplete;

    // Group candidates by mode (multi-mode candidates appear in multiple groups)
    this.candidatesByMode = new Map();
    for (const opt of GAME_MODE_OPTIONS) {
      this.candidatesByMode.set(opt.id, []);
    }
    for (const c of candidates) {
      const modes = c.levelTypes && c.levelTypes.length > 0 ? c.levelTypes : [c.levelType];
      for (const m of modes) {
        const group = this.candidatesByMode.get(m);
        if (group) {
          group.push(c);
        }
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
    // Mode selector on the left, map platforms on the right
    const modeSelectorX = -400;
    const mapStartX = 400;
    const mapEndX = mapStartX + Math.max(0, n - 1) * PLATFORM_SPACING;
    const totalLeftEdge = modeSelectorX - MODE_SELECTOR_WIDTH / 2 - 400;
    const totalRightEdge = mapEndX + PLATFORM_WIDTH / 2 + 400;
    const totalWidth = totalRightEdge - totalLeftEdge;

    // Mode selector platform
    const modeSelectorPlat = {
      id: 'mode-selector',
      x: modeSelectorX,
      y: PLATFORM_Y,
      width: MODE_SELECTOR_WIDTH,
      height: PLATFORM_HEIGHT,
      rotation: 0,
    };

    // Mode selector detection range
    this.modeSelectorRange = {
      xMin: modeSelectorX - MODE_SELECTOR_WIDTH / 2,
      xMax: modeSelectorX + MODE_SELECTOR_WIDTH / 2,
      yMin: PLATFORM_Y - 200,
      yMax: PLATFORM_Y,
    };

    // Map platforms
    const mapPlatforms = this.visibleCandidates.map((_, i) => ({
      id: `vote-plat-${i}`,
      x: mapStartX + i * PLATFORM_SPACING,
      y: PLATFORM_Y,
      width: PLATFORM_WIDTH,
      height: PLATFORM_HEIGHT,
      rotation: 0,
    }));

    this.platformRanges = mapPlatforms.map((p, i) => ({
      candidateIdx: i,
      xMin: p.x - p.width / 2,
      xMax: p.x + p.width / 2,
    }));

    const platforms = [modeSelectorPlat, ...mapPlatforms];

    // Spawn in the center between mode selector and first map platform
    const spawnX = (modeSelectorX + mapStartX) / 2;
    const spawnY = PLATFORM_Y - 80;

    return {
      name: 'Level Vote',
      version: 1,
      bounds: { width: totalWidth + 400, height: 1400 },
      platforms,
      walls: [
        // Floor
        { id: 'floor', points: [
          { x: totalLeftEdge - 50, y: 1100 },
          { x: totalRightEdge + 50, y: 1100 },
          { x: totalRightEdge + 50, y: 1200 },
          { x: totalLeftEdge - 50, y: 1200 },
        ]},
        // Left wall
        { id: 'left', points: [
          { x: totalLeftEdge - 100, y: -200 },
          { x: totalLeftEdge - 50, y: -200 },
          { x: totalLeftEdge - 50, y: 1200 },
          { x: totalLeftEdge - 100, y: 1200 },
        ]},
        // Right wall
        { id: 'right', points: [
          { x: totalRightEdge + 50, y: -200 },
          { x: totalRightEdge + 100, y: -200 },
          { x: totalRightEdge + 100, y: 1200 },
          { x: totalRightEdge + 50, y: 1200 },
        ]},
        // Ceiling
        { id: 'ceiling', points: [
          { x: totalLeftEdge - 100, y: -200 },
          { x: totalRightEdge + 100, y: -200 },
          { x: totalRightEdge + 100, y: -100 },
          { x: totalLeftEdge - 100, y: -100 },
        ]},
      ],
      spawnPoints: [
        { id: 'sp1', x: spawnX - 60, y: spawnY, type: 'player' as const },
        { id: 'sp2', x: spawnX - 20, y: spawnY, type: 'player' as const },
        { id: 'sp3', x: spawnX + 20, y: spawnY, type: 'player' as const },
        { id: 'sp4', x: spawnX + 60, y: spawnY, type: 'player' as const },
      ],
      npcBlobs: [],
    };
  }

  /** Rebuild map platforms after mode switch. Clears and re-registers all static polygons. */
  private rebuildMapPlatforms(): void {
    this.visibleCandidates = this.getVisibleCandidates();
    this.voteCounts = new Array(this.visibleCandidates.length).fill(0);
    this.level = this.generateVotingLevel();

    // Re-register all static geometry in physics world
    if (this.world) {
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

    // Reset auto-countdown on mode change
    this.autoCountdown = AUTO_COUNTDOWN_DURATION;
    this.countdownActive = false;
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
      // Cycle to next mode that has candidates
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

    // Animate button press (smooth lerp toward target)
    const pressTarget = anyOnModeSelector ? 1 : 0;
    const pressSpeed = anyOnModeSelector ? 8 : 5; // press faster than release
    this.buttonPressAmount += (pressTarget - this.buttonPressAmount) * Math.min(1, pressSpeed * dt);

    // Decay switch flash
    if (this.modeSwitchFlash > 0) {
      this.modeSwitchFlash = Math.max(0, this.modeSwitchFlash - dt);
    }

    // --- Count votes on map platforms ---
    this.voteCounts = new Array(this.visibleCandidates.length).fill(0);
    let playersOnPlatforms = 0;
    for (const player of allPlayers) {
      const centroid = player.blob.getCentroid();
      for (const range of this.platformRanges) {
        if (centroid.x >= range.xMin && centroid.x <= range.xMax &&
            centroid.y < PLATFORM_Y && centroid.y > PLATFORM_Y - 200) {
          this.voteCounts[range.candidateIdx]++;
          playersOnPlatforms++;
          break;
        }
      }
    }

    // --- Auto-countdown: all players on map platforms ---
    const totalPlayers = allPlayers.length;
    if (totalPlayers > 0 && playersOnPlatforms >= totalPlayers) {
      this.countdownActive = true;
      this.autoCountdown -= dt;
      if (this.autoCountdown <= 0) {
        // Resolve vote and trigger results transition
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

  /** Called when the voting timer expires. Performs weighted random selection. */
  resolveVote(): VotingCandidate {
    if (this.selectedCandidate) return this.selectedCandidate;

    const totalVotes = this.voteCounts.reduce((a, b) => a + b, 0);

    if (totalVotes === 0) {
      // No one voted — random pick from visible candidates
      if (this.visibleCandidates.length === 0) {
        // Fallback to any candidate
        this.selectedCandidate = this.allCandidates[Math.floor(Math.random() * this.allCandidates.length)];
        return this.selectedCandidate;
      }
      this.selectedCandidate = this.visibleCandidates[Math.floor(Math.random() * this.visibleCandidates.length)];
      return this.selectedCandidate;
    }

    // Weighted random
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
    const msPlat = this.level.platforms[0];
    const bx = msPlat.x;
    const by = msPlat.y;
    const bw = msPlat.width;

    // --- Draw jelly mode-selector button ---
    const press = this.buttonPressAmount;
    const btnHeight = 90;           // total button height when unpressed
    const squish = press * 30;      // how much the top sinks
    const bulge = press * 14;       // how much sides bulge out

    const topY = by - btnHeight + squish;
    const botY = by;
    const halfW = bw / 2 + bulge;
    const cornerR = 22 + bulge * 0.5;

    // Base/shadow (darker, slightly wider, always at bottom)
    ctx.save();
    const baseHalfW = bw / 2 + 10;
    const baseH = 16;
    ctx.beginPath();
    this.roundRect(ctx, bx - baseHalfW, botY - baseH / 2, baseHalfW * 2, baseH, 8);
    ctx.fillStyle = this.darkenColor(modeOpt.color, 0.35);
    ctx.fill();
    ctx.restore();

    // Button body (rounded rect with squish)
    ctx.save();
    const bodyH = botY - topY;

    // Outer glow when pressed or on flash
    const glowAlpha = Math.max(press * 0.25, this.modeSwitchFlash * 0.6);
    if (glowAlpha > 0.01) {
      ctx.shadowColor = modeOpt.color;
      ctx.shadowBlur = 30 + press * 20;
      ctx.globalAlpha = glowAlpha;
      ctx.beginPath();
      this.roundRect(ctx, bx - halfW, topY, halfW * 2, bodyH, cornerR);
      ctx.fillStyle = modeOpt.color;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    // Main body gradient (top lighter, bottom darker)
    const bodyGrad = ctx.createLinearGradient(bx, topY, bx, botY);
    bodyGrad.addColorStop(0, this.lightenColor(modeOpt.color, 0.25));
    bodyGrad.addColorStop(0.5, modeOpt.color);
    bodyGrad.addColorStop(1, this.darkenColor(modeOpt.color, 0.25));
    ctx.beginPath();
    this.roundRect(ctx, bx - halfW, topY, halfW * 2, bodyH, cornerR);
    ctx.fillStyle = bodyGrad;
    ctx.fill();

    // Glossy highlight on top
    ctx.save();
    ctx.globalAlpha = 0.35 - press * 0.15;
    const highlightH = bodyH * 0.35;
    const hlGrad = ctx.createLinearGradient(bx, topY, bx, topY + highlightH);
    hlGrad.addColorStop(0, 'rgba(255,255,255,0.6)');
    hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    this.roundRect(ctx, bx - halfW + 6, topY + 3, (halfW - 6) * 2, highlightH, cornerR - 4);
    ctx.fillStyle = hlGrad;
    ctx.fill();
    ctx.restore();

    // Border
    ctx.beginPath();
    this.roundRect(ctx, bx - halfW, topY, halfW * 2, bodyH, cornerR);
    ctx.strokeStyle = this.darkenColor(modeOpt.color, 0.3);
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    // Mode label on button
    const labelY = topY + bodyH / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 4;
    ctx.fillText(modeOpt.label, bx, labelY - 6);
    ctx.shadowBlur = 0;

    // "Jump to change!" hint below button
    ctx.textBaseline = 'top';
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText('Jump to change!', bx, botY + 16);

    // Small arrows on sides to indicate it's interactive
    ctx.font = '20px sans-serif';
    ctx.fillStyle = modeOpt.color;
    ctx.globalAlpha = 0.5 + Math.sin(this.gameTime * 3) * 0.3;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('\u25C0', bx - halfW - 20, labelY - 6);
    ctx.fillText('\u25B6', bx + halfW + 20, labelY - 6);
    ctx.globalAlpha = 1;

    // --- Draw map platforms with level previews ---
    const PREVIEW_W = 300;
    const PREVIEW_H = 200;

    for (let i = 0; i < this.visibleCandidates.length; i++) {
      const c = this.visibleCandidates[i];
      const plat = this.level.platforms[i + 1]; // +1 because index 0 is mode selector
      if (!plat) continue;
      const votes = this.voteCounts[i];
      const px = plat.x;
      const previewTop = plat.y - PLATFORM_HEIGHT - PREVIEW_H - 40;

      // Preview frame background
      ctx.save();
      ctx.beginPath();
      this.roundRect(ctx, px - PREVIEW_W / 2, previewTop, PREVIEW_W, PREVIEW_H, 12);
      ctx.fillStyle = 'rgba(15, 20, 35, 0.8)';
      ctx.fill();
      ctx.strokeStyle = votes > 0 ? modeOpt.color : 'rgba(60, 80, 120, 0.5)';
      ctx.lineWidth = votes > 0 ? 2 : 1;
      ctx.stroke();
      ctx.restore();

      // Level preview — draw miniature platforms/walls from level data
      if (c.previewLevel) {
        this.drawLevelPreview(ctx, c.previewLevel, px - PREVIEW_W / 2 + 10, previewTop + 10, PREVIEW_W - 20, PREVIEW_H - 20, modeOpt.color);
      } else {
        // No preview data — show placeholder
        ctx.save();
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#444';
        ctx.fillText('Preview unavailable', px, previewTop + PREVIEW_H / 2);
        ctx.restore();
      }

      // Level name below preview, above platform
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(c.name, px, plat.y - PLATFORM_HEIGHT - 12);

      // "Yours" badge for user-owned levels
      if (c.isOwn) {
        ctx.font = 'bold 12px sans-serif';
        ctx.fillStyle = '#c77dff';
        ctx.fillText('yours', px, plat.y - PLATFORM_HEIGHT - 36);
      }

      // Vote count
      if (votes > 0) {
        ctx.font = 'bold 28px sans-serif';
        ctx.fillStyle = '#ffd700';
        ctx.textBaseline = 'top';
        ctx.fillText(`${votes}`, px, previewTop - 34);
      }

      // Platform glow based on votes
      if (votes > 0) {
        ctx.save();
        ctx.globalAlpha = 0.15 + votes * 0.1;
        ctx.fillStyle = modeOpt.color;
        ctx.fillRect(plat.x - plat.width / 2, plat.y - plat.height / 2, plat.width, plat.height);
        ctx.restore();
      }
    }

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
    // Compute level bounds from platforms, walls, spawn points
    const bounds = level.bounds;
    const lw = bounds.width;
    const lh = bounds.height;

    // Scale to fit in the preview area, maintaining aspect ratio
    const scaleX = dw / lw;
    const scaleY = dh / lh;
    const s = Math.min(scaleX, scaleY) * 0.9;
    const ox = dx + (dw - lw * s) / 2;
    const oy = dy + (dh - lh * s) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();

    // Draw platforms as small capsule-ish rectangles
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

    // Draw goal zones
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

    // Draw hill zones
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

    // Draw spikes
    if (level.spikes) {
      ctx.fillStyle = 'rgba(255, 60, 60, 0.4)';
      for (const sp of level.spikes) {
        const sx = ox + sp.x * s - (sp.width * s) / 2;
        const sy = oy + sp.y * s - (sp.height * s) / 2;
        ctx.fillRect(sx, sy, sp.width * s, Math.max(sp.height * s, 2));
      }
    }

    // Draw spawn points
    ctx.fillStyle = 'rgba(199, 125, 255, 0.6)';
    for (const sp of level.spawnPoints) {
      if (sp.type !== 'player') continue;
      ctx.beginPath();
      ctx.arc(ox + sp.x * s, oy + sp.y * s, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /** Draw a rounded rect path (does not fill/stroke). */
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

  /** Lighten a hex color by a factor (0-1). */
  private lightenColor(hex: string, factor: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r + (255 - r) * factor)},${Math.round(g + (255 - g) * factor)},${Math.round(b + (255 - b) * factor)})`;
  }

  /** Darken a hex color by a factor (0-1). */
  private darkenColor(hex: string, factor: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r * (1 - factor))},${Math.round(g * (1 - factor))},${Math.round(b * (1 - factor))})`;
  }

  renderHUD(ctx: CanvasRenderingContext2D, width: number, height: number, _state: GameModeState, _playerManager: PlayerManager): void {
    ctx.save();

    // Mode name at top
    const modeOpt = this.currentModeOption;
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = modeOpt.color;
    ctx.fillText(modeOpt.label, width / 2, 16);

    ctx.font = '15px sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText('Stand on a level to vote!', width / 2, 50);

    // Auto-countdown overlay
    if (this.countdownActive) {
      const count = Math.ceil(this.autoCountdown);
      const text = count > 0 ? String(count) : 'GO!';

      // Semi-transparent background
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
