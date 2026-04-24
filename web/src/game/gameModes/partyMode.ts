import { GameMode, GameModeConfig, GameModeState, GamePhase } from './types';
import { SoftBodyWorld } from '../../physics/softBodyWorld';
import { Camera } from '../../renderer/camera';
import { PlayerManager } from '../playerManager';
import { LevelData, ZoneDef, PlatformDef, SpikeDef, SpringPadDef } from '../../levels/types';
import { drawGoalZone } from '../../renderer/zoneRenderer';
import { drawPlayerLabels, drawTimer } from '../../renderer/hudRenderer';
import { PARTY_ITEM_CATALOG, PartyItem } from '../partyItems/types';
import { DynamicItemManager } from '../dynamicItemManager';

type PartySubPhase = 'run' | 'scoring' | 'party_box' | 'placement';

const POINTS_TO_WIN = 25;
const RUN_TIME = 60;
const SCORING_DISPLAY_TIME = 4;
const PARTY_BOX_TIME = 10;
const PLACEMENT_TIME = 15;
const ITEMS_PER_ROUND = 5;

interface PlacedItemRecord {
  playerId: string;
  item: PartyItem;
  x: number;
  y: number;
}

export class PartyMode implements GameMode {
  readonly config: GameModeConfig = {
    id: 'party',
    name: 'Party Mode',
    description: 'UCH-style rounds with item placement!',
    minPlayers: 1,
    maxPlayers: 8,
    // No time limit — managed internally per sub-phase
    countdownDuration: 3,
    resultsDuration: 5,
  };

  private levelData: LevelData;
  private goalZone: ZoneDef | null = null;
  private world: SoftBodyWorld | null = null;
  private playerManager: PlayerManager | null = null;

  // Internal state machine
  private subPhase: PartySubPhase = 'run';
  private subPhaseTimer = 0;
  private round = 0;
  private scores = new Map<string, number>();
  private roundFinishers: string[] = [];
  private firstFinisher: string | null = null;
  private trapKills = new Map<string, number>(); // killed player -> count (for scoring)
  private tooEasy = false;
  private gameTime = 0;

  // Party box state
  private availableItems: PartyItem[] = [];
  private playerSelections = new Map<string, number>(); // playerId -> item index

  // Placement state
  private placementCursors = new Map<string, { x: number; y: number }>();
  private placementConfirmed = new Set<string>();
  private placedItems: PlacedItemRecord[] = [];

  // Scoring display
  private roundScoreChanges = new Map<string, { points: number; reasons: string[] }>();

  // Tracking committed items
  private committedCount = 0;

  // Game over
  private gameWinner: string | null = null;

  // Callbacks
  private onBroadcast?: (message: any) => void;
  private onSpikeKill?: (killedPlayerId: string) => void;

  // External managers (set after initialization)
  private spikeManager: import('../spikeManager').SpikeManager | null = null;
  private springPadManager: import('../springPadManager').SpringPadManager | null = null;
  private dynamicItemManager: DynamicItemManager | null = null;

  constructor(levelData: LevelData, onBroadcast?: (message: any) => void) {
    this.levelData = levelData;
    this.onBroadcast = onBroadcast;
  }

  getLevel(): LevelData {
    return this.levelData;
  }

  shouldRunPhysics(): boolean {
    return this.subPhase === 'run';
  }

  initialize(world: SoftBodyWorld, playerManager: PlayerManager): void {
    this.world = world;
    this.playerManager = playerManager;
    this.goalZone = this.levelData.goalZones?.[0] ?? null;

    // Hook trigger for goal detection
    if (this.goalZone) {
      const prevEntered = world.onTriggerEntered;
      world.onTriggerEntered = (triggerShapeIdx, blobId) => {
        prevEntered?.(triggerShapeIdx, blobId);
        this.onTriggerEntered(blobId, playerManager);
      };
    }

    // Initialize scores
    for (const p of playerManager.getAllPlayers()) {
      this.scores.set(p.playerId, 0);
    }
  }

  /** Set external managers for dynamic item placement */
  setManagers(
    spikeManager: import('../spikeManager').SpikeManager | null,
    springPadManager: import('../springPadManager').SpringPadManager | null,
    dynamicItemManager?: DynamicItemManager | null,
  ): void {
    this.spikeManager = spikeManager;
    this.springPadManager = springPadManager;
    this.dynamicItemManager = dynamicItemManager ?? null;
  }

  /** Called by external SpikeManager.onKill */
  handleSpikeKill(killedPlayerId: string): void {
    if (this.subPhase === 'run') {
      const current = this.trapKills.get(killedPlayerId) ?? 0;
      this.trapKills.set(killedPlayerId, current + 1);
    }
  }

  private onTriggerEntered(blobId: number, playerManager: PlayerManager): void {
    if (this.subPhase !== 'run') return;

    const player = playerManager.getPlayerByBlobId(blobId);
    if (!player) return;
    if (this.roundFinishers.includes(player.playerId)) return;

    if (!this.firstFinisher) {
      this.firstFinisher = player.playerId;
    }
    this.roundFinishers.push(player.playerId);
  }

  onPhaseStart(phase: GamePhase, _state: GameModeState): void {
    if (phase === 'playing') {
      this.startRun();
    }
  }

  update(dt: number, state: GameModeState, playerManager: PlayerManager, _world: SoftBodyWorld): void {
    this.gameTime += dt;
    this.subPhaseTimer -= dt;

    switch (this.subPhase) {
      case 'run':
        this.updateRun(dt, state, playerManager);
        break;
      case 'scoring':
        this.updateScoring(dt, state);
        break;
      case 'party_box':
        this.updatePartyBox(dt, state);
        break;
      case 'placement':
        this.updatePlacement(dt, state, playerManager);
        break;
    }
  }

  private startRun(): void {
    this.subPhase = 'run';
    this.subPhaseTimer = RUN_TIME;
    this.round++;
    this.roundFinishers = [];
    this.firstFinisher = null;
    this.trapKills.clear();
    this.tooEasy = false;
    this.roundScoreChanges.clear();

    // Broadcast to controllers: normal mode
    this.onBroadcast?.({ type: 'host_phase_update', value: { phase: 'run' } });
  }

  private updateRun(dt: number, state: GameModeState, playerManager: PlayerManager): void {
    const totalPlayers = playerManager.getPlayerCount();

    // Check if all players finished
    if (totalPlayers > 0 && this.roundFinishers.length >= totalPlayers) {
      this.endRun(playerManager);
      return;
    }

    // Check if all players are dead — end round early
    if (totalPlayers > 0 && this.spikeManager) {
      const allDead = playerManager.getAllPlayers().every(p => this.spikeManager!.isDead(p.playerId));
      if (allDead) {
        this.endRun(playerManager);
        return;
      }
    }

    // Time's up
    if (this.subPhaseTimer <= 0) {
      this.endRun(playerManager);
    }
  }

  private endRun(playerManager: PlayerManager): void {
    const totalPlayers = playerManager.getPlayerCount();

    // Check if "too easy"
    this.tooEasy = totalPlayers > 1 && this.roundFinishers.length >= totalPlayers;

    // Calculate scores
    this.roundScoreChanges.clear();

    if (!this.tooEasy) {
      // Points for finishing
      for (const pid of this.roundFinishers) {
        const change = this.getOrCreateScoreChange(pid);
        change.points += 1;
        change.reasons.push('+1 finish');
      }

      // First finish bonus
      if (this.firstFinisher) {
        const change = this.getOrCreateScoreChange(this.firstFinisher);
        change.points += 2;
        change.reasons.push('+2 first');
      }

      // Sole survivor (only one person made it)
      if (this.roundFinishers.length === 1 && totalPlayers > 1) {
        const change = this.getOrCreateScoreChange(this.roundFinishers[0]);
        change.points += 3;
        change.reasons.push('+3 sole survivor');
      }

      // Trap kills (points for killed player count — simplified)
      for (const [_killedId, killCount] of this.trapKills) {
        // In UCH, the person who placed the trap gets points.
        // Since we don't track WHO placed which spike (simplified), we give points to finishers
        // for surviving. This is a simplification; full tracking added in Phase 8.
      }

      // Apply scores
      for (const [pid, change] of this.roundScoreChanges) {
        const current = this.scores.get(pid) ?? 0;
        this.scores.set(pid, current + change.points);
      }
    }

    // Check for winner
    for (const [pid, score] of this.scores) {
      if (score >= POINTS_TO_WIN) {
        this.gameWinner = pid;
        break;
      }
    }

    this.subPhase = 'scoring';
    this.subPhaseTimer = SCORING_DISPLAY_TIME;
  }

  private getOrCreateScoreChange(pid: string): { points: number; reasons: string[] } {
    let change = this.roundScoreChanges.get(pid);
    if (!change) {
      change = { points: 0, reasons: [] };
      this.roundScoreChanges.set(pid, change);
    }
    return change;
  }

  private updateScoring(dt: number, state: GameModeState): void {
    if (this.subPhaseTimer <= 0) {
      if (this.gameWinner) {
        // Game is over — let the mode manager handle results
        state.winner = this.gameWinner;
        const player = this.playerManager?.getPlayer(this.gameWinner);
        state.winnerName = player?.name ?? 'Unknown';
        return;
      }

      // Move to party box
      this.startPartyBox();
    }
  }

  private startPartyBox(): void {
    this.subPhase = 'party_box';
    this.subPhaseTimer = PARTY_BOX_TIME;
    this.playerSelections.clear();

    // Generate items ensuring variety: pick from different categories
    const byCategory = new Map<string, PartyItem[]>();
    for (const item of PARTY_ITEM_CATALOG) {
      const list = byCategory.get(item.category) ?? [];
      list.push(item);
      byCategory.set(item.category, list);
    }
    const picks: PartyItem[] = [];
    const categories = [...byCategory.keys()].sort(() => Math.random() - 0.5);
    // Pick one from each category first, then fill randomly
    for (const cat of categories) {
      const items = byCategory.get(cat)!;
      const pick = items[Math.floor(Math.random() * items.length)];
      picks.push(pick);
      if (picks.length >= ITEMS_PER_ROUND) break;
    }
    while (picks.length < ITEMS_PER_ROUND) {
      const all = PARTY_ITEM_CATALOG.filter(i => !picks.includes(i));
      if (all.length === 0) break;
      picks.push(all[Math.floor(Math.random() * all.length)]);
    }
    this.availableItems = picks;

    // Broadcast items to controllers
    this.onBroadcast?.({
      type: 'host_phase_update',
      value: {
        phase: 'party_box',
        items: this.availableItems.map(i => ({
          type: i.type,
          label: i.label,
          category: i.category,
          desc: i.desc,
          width: i.width,
          height: i.height,
        })),
      },
    });
  }

  private updatePartyBox(dt: number, state: GameModeState): void {
    const totalPlayers = this.playerManager?.getPlayerCount() ?? 0;

    // All players selected or time's up
    if (this.playerSelections.size >= totalPlayers || this.subPhaseTimer <= 0) {
      // Auto-assign random items to players who didn't pick
      if (this.playerManager) {
        for (const p of this.playerManager.getAllPlayers()) {
          if (!this.playerSelections.has(p.playerId)) {
            this.playerSelections.set(p.playerId, Math.floor(Math.random() * this.availableItems.length));
          }
        }
      }

      this.startPlacement();
    }
  }

  /** Called when a controller sends item_select */
  handleItemSelect(playerId: string, itemIndex: number): void {
    if (this.subPhase !== 'party_box') return;
    if (itemIndex >= 0 && itemIndex < this.availableItems.length) {
      this.playerSelections.set(playerId, itemIndex);
    }
  }

  private startPlacement(): void {
    this.subPhase = 'placement';
    this.subPhaseTimer = PLACEMENT_TIME;
    this.placementCursors.clear();
    this.placementConfirmed.clear();

    // Initialize cursors at center of level
    const cx = this.levelData.bounds.width / 2;
    const cy = this.levelData.bounds.height / 2;
    if (this.playerManager) {
      for (const p of this.playerManager.getAllPlayers()) {
        this.placementCursors.set(p.playerId, { x: cx, y: cy });
      }
    }

    // Broadcast to controllers: placement mode
    this.onBroadcast?.({ type: 'host_phase_update', value: { phase: 'placement' } });
  }

  private updatePlacement(dt: number, state: GameModeState, playerManager: PlayerManager): void {
    const totalPlayers = playerManager.getPlayerCount();

    // All confirmed or time's up
    if (this.placementConfirmed.size >= totalPlayers || this.subPhaseTimer <= 0) {
      this.commitPlacements();
      this.spikeManager?.respawnAll();
      this.respawnAllPlayers(playerManager);
      this.startRun();
    }
  }

  /** Called when a controller sends cursor_move */
  handleCursorMove(playerId: string, dx: number, dy: number): void {
    if (this.subPhase !== 'placement') return;
    if (this.placementConfirmed.has(playerId)) return;

    const cursor = this.placementCursors.get(playerId);
    if (!cursor) return;

    // Move cursor based on joystick input (grid-snapped)
    const speed = 300; // units per second at full joystick
    const gridSize = 20;
    cursor.x = Math.round((cursor.x + dx * speed * (1 / 30)) / gridSize) * gridSize;
    cursor.y = Math.round((cursor.y + dy * speed * (1 / 30)) / gridSize) * gridSize;

    // Clamp to level bounds
    cursor.x = Math.max(0, Math.min(cursor.x, this.levelData.bounds.width));
    cursor.y = Math.max(0, Math.min(cursor.y, this.levelData.bounds.height));
  }

  /** Called when a controller sends placement_confirm */
  handlePlacementConfirm(playerId: string): void {
    if (this.subPhase !== 'placement') return;
    if (this.placementConfirmed.has(playerId)) return;

    const cursor = this.placementCursors.get(playerId);
    const itemIdx = this.playerSelections.get(playerId);
    if (!cursor || itemIdx === undefined) return;

    const item = this.availableItems[itemIdx];
    if (!item) return;

    // Check overlap with existing elements
    if (this.checkOverlap(cursor.x, cursor.y, item.width, item.height)) {
      // Can't place here — don't confirm
      return;
    }

    this.placedItems.push({ playerId, item, x: cursor.x, y: cursor.y });
    this.placementConfirmed.add(playerId);
  }

  private checkOverlap(x: number, y: number, w: number, h: number): boolean {
    const hw = w / 2;
    const hh = h / 2;

    // Check against all platforms
    for (const plat of this.levelData.platforms) {
      if (this.aabbOverlap(x, y, hw, hh, plat.x, plat.y, plat.width / 2, plat.height / 2)) {
        return true;
      }
    }

    // Check against placed items
    for (const placed of this.placedItems) {
      if (this.aabbOverlap(x, y, hw, hh, placed.x, placed.y, placed.item.width / 2, placed.item.height / 2)) {
        return true;
      }
    }

    return false;
  }

  private aabbOverlap(ax: number, ay: number, ahw: number, ahh: number,
    bx: number, by: number, bhw: number, bhh: number): boolean {
    return Math.abs(ax - bx) < ahw + bhw && Math.abs(ay - by) < ahh + bhh;
  }

  private commitPlacements(): void {
    if (!this.world) return;

    // Commit only newly placed items since last commit
    for (let i = this.committedCount; i < this.placedItems.length; i++) {
      const placed = this.placedItems[i];
      const { item, x, y } = placed;
      const id = `party_${this.round}_${i}`;

      switch (item.type) {
        // === Static rectangular platforms ===
        case 'platform_small':
        case 'platform_medium':
        case 'platform_large':
        case 'bridge': {
          this.registerRect(id, x, y, item.width, item.height);
          this.levelData.platforms.push({
            id, x, y, width: item.width, height: item.height, rotation: 0,
          });
          break;
        }

        case 'wall_small': {
          this.registerRect(id, x, y, item.width, item.height);
          if (!this.levelData.walls) this.levelData.walls = [];
          this.levelData.walls.push({
            id,
            points: this.rectPoints(x, y, item.width, item.height),
          });
          break;
        }

        // === L-Shape: two perpendicular rectangles ===
        case 'l_shape': {
          const armW = item.width;
          const armH = 24;
          // Horizontal arm (bottom)
          this.registerRect(`${id}_h`, x, y, armW, armH);
          this.levelData.platforms.push({
            id: `${id}_h`, x, y, width: armW, height: armH, rotation: 0,
          });
          // Vertical arm (left side, going up)
          const vx = x - armW / 2 + armH / 2;
          const vy = y - item.height / 2 + armH / 2;
          this.registerRect(`${id}_v`, vx, vy, armH, item.height - armH);
          this.levelData.platforms.push({
            id: `${id}_v`, x: vx, y: vy, width: armH, height: item.height - armH, rotation: 0,
          });
          break;
        }

        // === Ramps: angled triangular wedge (uses polygon) ===
        case 'ramp_left': {
          const hw = item.width / 2;
          const hh = item.height / 2;
          const pts = [
            { x: x + hw, y: y + hh },    // bottom-right
            { x: x - hw, y: y + hh },    // bottom-left
            { x: x - hw, y: y - hh },    // top-left
          ];
          this.world.registerStaticPolygon(pts);
          // Add as wall for overlap checking
          if (!this.levelData.walls) this.levelData.walls = [];
          this.levelData.walls.push({ id, points: pts });
          break;
        }

        case 'ramp_right': {
          const hw = item.width / 2;
          const hh = item.height / 2;
          const pts = [
            { x: x - hw, y: y + hh },    // bottom-left
            { x: x + hw, y: y + hh },    // bottom-right
            { x: x + hw, y: y - hh },    // top-right
          ];
          this.world.registerStaticPolygon(pts);
          if (!this.levelData.walls) this.levelData.walls = [];
          this.levelData.walls.push({ id, points: pts });
          break;
        }

        // === Funnel: two angled walls forming a V ===
        case 'funnel': {
          const hw = item.width / 2;
          const hh = item.height / 2;
          const gap = 50; // opening at bottom
          const thickness = 20;
          // Left wall of funnel
          const lPts = [
            { x: x - hw, y: y - hh },
            { x: x - hw + thickness, y: y - hh },
            { x: x - gap / 2 + thickness, y: y + hh },
            { x: x - gap / 2, y: y + hh },
          ];
          this.world.registerStaticPolygon(lPts);
          // Right wall of funnel
          const rPts = [
            { x: x + hw - thickness, y: y - hh },
            { x: x + hw, y: y - hh },
            { x: x + gap / 2, y: y + hh },
            { x: x + gap / 2 - thickness, y: y + hh },
          ];
          this.world.registerStaticPolygon(rPts);
          if (!this.levelData.walls) this.levelData.walls = [];
          this.levelData.walls.push({ id: `${id}_l`, points: lPts });
          this.levelData.walls.push({ id: `${id}_r`, points: rPts });
          break;
        }

        // === Spikes ===
        case 'spike':
        case 'spike_pit':
        case 'spike_wall': {
          const spikeDef: SpikeDef = {
            id, x, y, width: item.width, height: item.height, rotation: item.rotation,
          };
          if (this.spikeManager) {
            this.spikeManager.addSpike(spikeDef, true);
          }
          if (!this.levelData.spikes) this.levelData.spikes = [];
          this.levelData.spikes.push(spikeDef);
          break;
        }

        // === Spring pads / Trampoline ===
        case 'spring_pad':
        case 'trampoline': {
          const force = item.type === 'trampoline' ? 700 : 500;
          const springDef: SpringPadDef = {
            id, x, y, width: item.width, height: item.height,
            rotation: item.rotation, force,
          };
          if (this.springPadManager) {
            this.springPadManager.addSpring(springDef);
          }
          if (!this.levelData.springPads) this.levelData.springPads = [];
          this.levelData.springPads.push(springDef);
          break;
        }

        // === Dynamic / force-based items ===
        case 'cannon':
        case 'catapult':
        case 'bumper':
        case 'wind_zone':
        case 'gravity_flipper':
        case 'conveyor_left':
        case 'conveyor_right':
        case 'sticky_goo':
        case 'wrecking_ball': {
          if (this.dynamicItemManager) {
            this.dynamicItemManager.addItem(
              id, item.type, x, y, item.width, item.height, item.rotation,
            );
          }
          break;
        }
      }
    }

    this.committedCount = this.placedItems.length;
  }

  /** Register a rectangle as static collision geometry */
  private registerRect(id: string, x: number, y: number, w: number, h: number): void {
    if (!this.world) return;
    this.world.registerStaticPolygon(this.rectPoints(x, y, w, h));
  }

  private rectPoints(x: number, y: number, w: number, h: number): { x: number; y: number }[] {
    const hw = w / 2;
    const hh = h / 2;
    return [
      { x: x - hw, y: y - hh },
      { x: x + hw, y: y - hh },
      { x: x + hw, y: y + hh },
      { x: x - hw, y: y + hh },
    ];
  }

  private respawnAllPlayers(playerManager: PlayerManager): void {
    if (!this.world) return;
    const spawnPoints = playerManager.getSpawnPoints();
    let i = 0;
    for (const p of playerManager.getAllPlayers()) {
      const sp = spawnPoints[i % spawnPoints.length];
      this.world.teleportBlob(p.blob.blobId, sp);
      i++;
    }
  }

  checkWinCondition(state: GameModeState, _playerManager: PlayerManager): string | null {
    if (this.gameWinner) {
      state.winner = this.gameWinner;
      const player = this.playerManager?.getPlayer(this.gameWinner);
      state.winnerName = player?.name ?? 'Unknown';
      return this.gameWinner;
    }
    return null;
  }

  renderWorld(ctx: CanvasRenderingContext2D, _camera: Camera, state: GameModeState, playerManager: PlayerManager): void {
    // Draw goal zone
    if (this.goalZone) {
      drawGoalZone(ctx, this.goalZone, this.gameTime);
    }

    // Draw dynamic items (force-based)
    this.dynamicItemManager?.render(ctx);

    // Draw placed items preview during placement phase
    if (this.subPhase === 'placement') {
      this.renderPlacementCursors(ctx);
    }

    // Draw player labels
    drawPlayerLabels(ctx, playerManager.getAllPlayers());
  }

  private renderPlacementCursors(ctx: CanvasRenderingContext2D): void {
    for (const [playerId, cursor] of this.placementCursors) {
      if (this.placementConfirmed.has(playerId)) continue;

      const itemIdx = this.playerSelections.get(playerId);
      if (itemIdx === undefined) continue;
      const item = this.availableItems[itemIdx];
      if (!item) continue;

      const hw = item.width / 2;
      const hh = item.height / 2;
      const overlapping = this.checkOverlap(cursor.x, cursor.y, item.width, item.height);
      const catColor = PartyMode.CATEGORY_COLORS[item.category] ?? '#888';

      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = overlapping ? '#ff4444' : '#44ff44';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);

      // Draw shape preview based on item type
      if (item.type === 'bumper' || item.type === 'wrecking_ball') {
        // Circle preview
        ctx.beginPath();
        ctx.arc(cursor.x, cursor.y, hw, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = overlapping ? 'rgba(255,68,68,0.15)' : `${catColor}33`;
        ctx.fill();
      } else if (item.type === 'l_shape') {
        // L-shape preview
        ctx.beginPath();
        ctx.moveTo(cursor.x - hw, cursor.y - hh);
        ctx.lineTo(cursor.x - hw + 24, cursor.y - hh);
        ctx.lineTo(cursor.x - hw + 24, cursor.y + hh - 24);
        ctx.lineTo(cursor.x + hw, cursor.y + hh - 24);
        ctx.lineTo(cursor.x + hw, cursor.y + hh);
        ctx.lineTo(cursor.x - hw, cursor.y + hh);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = overlapping ? 'rgba(255,68,68,0.15)' : `${catColor}33`;
        ctx.fill();
      } else if (item.type === 'ramp_left' || item.type === 'ramp_right') {
        // Triangle preview
        ctx.beginPath();
        if (item.type === 'ramp_left') {
          ctx.moveTo(cursor.x + hw, cursor.y + hh);
          ctx.lineTo(cursor.x - hw, cursor.y + hh);
          ctx.lineTo(cursor.x - hw, cursor.y - hh);
        } else {
          ctx.moveTo(cursor.x - hw, cursor.y + hh);
          ctx.lineTo(cursor.x + hw, cursor.y + hh);
          ctx.lineTo(cursor.x + hw, cursor.y - hh);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = overlapping ? 'rgba(255,68,68,0.15)' : `${catColor}33`;
        ctx.fill();
      } else if (item.type === 'funnel') {
        // V-shape preview
        const gap = 50;
        ctx.beginPath();
        ctx.moveTo(cursor.x - hw, cursor.y - hh);
        ctx.lineTo(cursor.x - gap / 2, cursor.y + hh);
        ctx.moveTo(cursor.x + hw, cursor.y - hh);
        ctx.lineTo(cursor.x + gap / 2, cursor.y + hh);
        ctx.stroke();
      } else {
        // Default rectangle
        ctx.strokeRect(cursor.x - hw, cursor.y - hh, item.width, item.height);
        ctx.fillStyle = overlapping ? 'rgba(255,68,68,0.15)' : `${catColor}33`;
        ctx.fillRect(cursor.x - hw, cursor.y - hh, item.width, item.height);
      }

      // Label
      ctx.setLineDash([]);
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = 0.9;
      ctx.fillText(item.label, cursor.x, cursor.y + 4);

      // Player indicator
      const player = this.playerManager?.getPlayer(playerId);
      if (player) {
        ctx.fillStyle = player.color ?? '#fff';
        ctx.beginPath();
        ctx.arc(cursor.x, cursor.y - hh - 10, 5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  renderHUD(ctx: CanvasRenderingContext2D, width: number, height: number, state: GameModeState, playerManager: PlayerManager): void {
    // Scoreboard
    this.renderScoreboard(ctx, width, height, playerManager);

    // Sub-phase specific overlays
    switch (this.subPhase) {
      case 'run':
        this.renderRunHUD(ctx, width, height);
        break;
      case 'scoring':
        this.renderScoringOverlay(ctx, width, height, playerManager);
        break;
      case 'party_box':
        this.renderPartyBoxHUD(ctx, width, height);
        break;
      case 'placement':
        this.renderPlacementHUD(ctx, width, height);
        break;
    }
  }

  private renderScoreboard(ctx: CanvasRenderingContext2D, width: number, _height: number, playerManager: PlayerManager): void {
    ctx.save();
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';

    const players = playerManager.getAllPlayers();
    const sorted = [...players].sort((a, b) =>
      (this.scores.get(b.playerId) ?? 0) - (this.scores.get(a.playerId) ?? 0)
    );

    let y = 50;
    ctx.fillStyle = '#aaa';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`Round ${this.round} · First to ${POINTS_TO_WIN}`, width - 16, y);
    y += 20;

    for (const p of sorted) {
      const score = this.scores.get(p.playerId) ?? 0;
      ctx.fillStyle = p.color ?? '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(`${p.name}: ${score}`, width - 16, y);
      y += 18;
    }

    ctx.restore();
  }

  private renderRunHUD(ctx: CanvasRenderingContext2D, width: number, _height: number): void {
    // Timer
    if (this.subPhaseTimer > 0) {
      drawTimer(ctx, width, this.subPhaseTimer);
    }

    // "Round X" label
    ctx.save();
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#c77dff';
    ctx.fillText(`Round ${this.round}`, width / 2, 16);
    ctx.restore();
  }

  private renderScoringOverlay(ctx: CanvasRenderingContext2D, width: number, height: number, playerManager: PlayerManager): void {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, width, height);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (this.tooEasy) {
      ctx.font = 'bold 48px sans-serif';
      ctx.fillStyle = '#ff6a6a';
      ctx.fillText('TOO EASY!', width / 2, height / 2 - 40);
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#aaa';
      ctx.fillText('Everyone made it — no points!', width / 2, height / 2 + 20);
    } else {
      ctx.font = 'bold 32px sans-serif';
      ctx.fillStyle = '#ffd700';
      ctx.fillText(`Round ${this.round} Results`, width / 2, height / 2 - 80);

      let y = height / 2 - 30;
      ctx.font = '18px sans-serif';
      for (const [pid, change] of this.roundScoreChanges) {
        const player = playerManager.getPlayer(pid);
        if (!player) continue;
        ctx.fillStyle = player.color ?? '#fff';
        ctx.fillText(`${player.name}: +${change.points} (${change.reasons.join(', ')})`, width / 2, y);
        y += 28;
      }

      if (this.roundScoreChanges.size === 0) {
        ctx.fillStyle = '#888';
        ctx.fillText('No one scored this round', width / 2, height / 2);
      }
    }

    ctx.restore();
  }

  private static CATEGORY_COLORS: Record<string, string> = {
    platform: '#4a9eff',
    trap: '#ff4444',
    launcher: '#ff8800',
    zone: '#aa55ff',
    hazard: '#ff3366',
  };

  private renderPartyBoxHUD(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, width, height);

    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#c77dff';
    ctx.fillText('Party Box!', width / 2, 60);

    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText('Pick an item on your controller', width / 2, 95);

    // Timer
    ctx.font = 'bold 24px sans-serif';
    ctx.fillStyle = this.subPhaseTimer < 3 ? '#ff6a6a' : '#fff';
    ctx.fillText(`${Math.ceil(this.subPhaseTimer)}`, width / 2, 130);

    // Show available items in a card layout
    const itemW = 130;
    const itemH = 120;
    const gap = 14;
    const totalW = this.availableItems.length * itemW + (this.availableItems.length - 1) * gap;
    let x = (width - totalW) / 2 + itemW / 2;
    const y = height / 2;

    for (let i = 0; i < this.availableItems.length; i++) {
      const item = this.availableItems[i];
      const catColor = PartyMode.CATEGORY_COLORS[item.category] ?? '#888';

      const ix = x - itemW / 2;
      const iy = y - itemH / 2;

      // Card background
      ctx.fillStyle = '#1a2240';
      ctx.strokeStyle = catColor;
      ctx.lineWidth = 2;
      ctx.fillRect(ix, iy, itemW, itemH);
      ctx.strokeRect(ix, iy, itemW, itemH);

      // Category badge
      ctx.fillStyle = catColor;
      ctx.font = 'bold 10px sans-serif';
      ctx.globalAlpha = 0.8;
      ctx.fillText(item.category.toUpperCase(), x, iy + 14);
      ctx.globalAlpha = 1;

      // Item name
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(item.label, x, y - 10);

      // Description or size
      ctx.fillStyle = '#aaa';
      ctx.font = '11px sans-serif';
      if (item.desc) {
        ctx.fillText(item.desc, x, y + 12);
      } else {
        ctx.fillText(`${item.width}x${item.height}`, x, y + 12);
      }

      // Index number
      ctx.fillStyle = '#555';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(`${i + 1}`, x, iy + itemH - 14);

      x += itemW + gap;
    }

    // Show who has selected
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#4ae04a';
    ctx.fillText(`${this.playerSelections.size} / ${this.playerManager?.getPlayerCount() ?? 0} selected`, width / 2, height - 40);

    ctx.restore();
  }

  private renderPlacementHUD(ctx: CanvasRenderingContext2D, width: number, _height: number): void {
    ctx.save();
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#c77dff';
    ctx.fillText('Place Your Item!', width / 2, 16);

    ctx.font = 'bold 24px sans-serif';
    ctx.fillStyle = this.subPhaseTimer < 3 ? '#ff6a6a' : '#fff';
    ctx.fillText(`${Math.ceil(this.subPhaseTimer)}`, width / 2, 44);

    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#4ae04a';
    ctx.fillText(
      `${this.placementConfirmed.size} / ${this.playerManager?.getPlayerCount() ?? 0} placed`,
      width / 2, 72,
    );

    ctx.restore();
  }

  cleanup(): void {
    this.world = null;
    this.playerManager = null;
    this.scores.clear();
    this.playerSelections.clear();
    this.placementCursors.clear();
    this.placementConfirmed.clear();
    this.placedItems = [];
  }
}
