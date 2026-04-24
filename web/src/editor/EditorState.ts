import { LevelData, LevelType, PlatformDef, SpawnPointDef, NpcBlobDef, SpringPadDef, SpikeDef, ZoneDef, PowerupSpawnDef } from '../levels/types';
import { defaultLevel } from '../levels/defaultLevel';
import type { HullPreset } from '../physics/slimeBlob';

export type EditorTool = 'select' | 'platform' | 'spawn' | 'npc' | 'spring' | 'spike' | 'goalZone' | 'hillZone' | 'powerup';

export type EditorElement =
  | { type: 'platform'; id: string }
  | { type: 'spawn'; id: string }
  | { type: 'npc'; id: string }
  | { type: 'wall'; id: string }
  | { type: 'spring'; id: string }
  | { type: 'spike'; id: string }
  | { type: 'goalZone'; id: string }
  | { type: 'hillZone'; id: string }
  | { type: 'powerup'; id: string };

export type ResizeHandle = 'left' | 'right' | 'top' | 'bottom';

export const TOOL_HOTKEYS: Record<string, EditorTool> = {
  '1': 'select',
  '2': 'platform',
  '3': 'spawn',
  '4': 'npc',
  '5': 'spring',
  '6': 'spike',
  '7': 'goalZone',
  '8': 'hillZone',
  '9': 'powerup',
};

const RECT_TYPES = new Set<string>(['platform', 'spring', 'spike', 'goalZone', 'hillZone']);
const ROTATABLE_TYPES = new Set<string>(['platform', 'spring', 'spike']);

export interface UndoEntry {
  level: LevelData;
}

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

export class EditorState {
  level: LevelData;
  selectedTool: EditorTool = 'select';
  selectedElement: EditorElement | null = null;
  undoStack: UndoEntry[] = [];
  redoStack: UndoEntry[] = [];

  // Camera
  panX = 0;
  panY = 400;
  zoom = 0.4;

  // Dragging
  isDragging = false;
  dragStartX = 0;
  dragStartY = 0;
  dragElementStartX = 0;
  dragElementStartY = 0;
  isPanning = false;
  panStartX = 0;
  panStartY = 0;
  panStartCamX = 0;
  panStartCamY = 0;

  // Drag-to-place
  isPlacing = false;
  placementStartX = 0;
  placementStartY = 0;
  placementTool: EditorTool | null = null;

  // Resize
  isResizing = false;
  activeResizeHandle: ResizeHandle | null = null;
  resizeStartMouseX = 0;
  resizeStartMouseY = 0;
  resizeInitState: { x: number; y: number; width: number; height: number; rotation: number } | null = null;

  // Grid
  gridSize = 20;
  snapToGrid = true;

  // Cloud save tracking
  contentId: string | null = null;
  isPublished = false;

  onChange?: () => void;

  constructor(level?: LevelData) {
    this.level = level ? JSON.parse(JSON.stringify(level)) : JSON.parse(JSON.stringify(defaultLevel));
  }

  private pushUndo(): void {
    this.undoStack.push({ level: JSON.parse(JSON.stringify(this.level)) });
    this.redoStack = [];
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push({ level: JSON.parse(JSON.stringify(this.level)) });
    this.level = entry.level;
    this.selectedElement = null;
    this.onChange?.();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push({ level: JSON.parse(JSON.stringify(this.level)) });
    this.level = entry.level;
    this.selectedElement = null;
    this.onChange?.();
  }

  snap(v: number): number {
    if (!this.snapToGrid) return v;
    return Math.round(v / this.gridSize) * this.gridSize;
  }

  // --- Find selected element data ---

  findSelectedData(): any | null {
    if (!this.selectedElement) return null;
    const { type, id } = this.selectedElement;
    switch (type) {
      case 'platform': return this.level.platforms.find(p => p.id === id);
      case 'spring': return (this.level.springPads ?? []).find(s => s.id === id);
      case 'spike': return (this.level.spikes ?? []).find(s => s.id === id);
      case 'goalZone': return (this.level.goalZones ?? []).find(z => z.id === id);
      case 'hillZone': return (this.level.hillZones ?? []).find(z => z.id === id);
      case 'spawn': return this.level.spawnPoints.find(s => s.id === id);
      case 'npc': return this.level.npcBlobs.find(n => n.id === id);
      case 'powerup': return (this.level.powerupSpawns ?? []).find(p => p.id === id);
      default: return null;
    }
  }

  isSelectedRect(): boolean {
    return this.selectedElement !== null && RECT_TYPES.has(this.selectedElement.type);
  }

  isSelectedRotatable(): boolean {
    return this.selectedElement !== null && ROTATABLE_TYPES.has(this.selectedElement.type);
  }

  // --- Add elements ---

  addPlatform(x: number, y: number): void {
    this.pushUndo();
    const platform: PlatformDef = {
      id: genId('plat'), x: this.snap(x), y: this.snap(y),
      width: 200, height: 24, rotation: 0,
    };
    this.level.platforms.push(platform);
    this.selectedElement = { type: 'platform', id: platform.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  addSpawnPoint(x: number, y: number): void {
    this.pushUndo();
    const sp: SpawnPointDef = {
      id: genId('sp'), x: this.snap(x), y: this.snap(y), type: 'player',
    };
    this.level.spawnPoints.push(sp);
    this.selectedElement = { type: 'spawn', id: sp.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  addNpcBlob(x: number, y: number): void {
    this.pushUndo();
    const npc: NpcBlobDef = {
      id: genId('npc'), x: this.snap(x), y: this.snap(y),
      hullPreset: 'circle16', hue: Math.random(),
    };
    this.level.npcBlobs.push(npc);
    this.selectedElement = { type: 'npc', id: npc.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  addSpring(x: number, y: number): void {
    this.pushUndo();
    if (!this.level.springPads) this.level.springPads = [];
    const spring: SpringPadDef = {
      id: genId('spring'), x: this.snap(x), y: this.snap(y),
      width: 100, height: 40, rotation: -Math.PI / 2, force: 500,
    };
    this.level.springPads.push(spring);
    this.selectedElement = { type: 'spring', id: spring.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  addSpike(x: number, y: number): void {
    this.pushUndo();
    if (!this.level.spikes) this.level.spikes = [];
    const spike: SpikeDef = {
      id: genId('spike'), x: this.snap(x), y: this.snap(y),
      width: 200, height: 35, rotation: 0,
    };
    this.level.spikes.push(spike);
    this.selectedElement = { type: 'spike', id: spike.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  addGoalZone(x: number, y: number): void {
    this.pushUndo();
    if (!this.level.goalZones) this.level.goalZones = [];
    const zone: ZoneDef = {
      id: genId('goal'), x: this.snap(x), y: this.snap(y),
      width: 400, height: 400,
    };
    this.level.goalZones.push(zone);
    this.selectedElement = { type: 'goalZone', id: zone.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  addHillZone(x: number, y: number): void {
    this.pushUndo();
    if (!this.level.hillZones) this.level.hillZones = [];
    const zone: ZoneDef = {
      id: genId('hill'), x: this.snap(x), y: this.snap(y),
      width: 500, height: 250,
    };
    this.level.hillZones.push(zone);
    this.selectedElement = { type: 'hillZone', id: zone.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  addPowerupSpawn(x: number, y: number): void {
    this.pushUndo();
    if (!this.level.powerupSpawns) this.level.powerupSpawns = [];
    const pu: PowerupSpawnDef = {
      id: genId('pu'), x: this.snap(x), y: this.snap(y),
    };
    this.level.powerupSpawns.push(pu);
    this.selectedElement = { type: 'powerup', id: pu.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  // --- Drag-to-place for rect tools ---

  startPlacement(tool: EditorTool, x: number, y: number): void {
    this.placementTool = tool;
    this.placementStartX = this.snap(x);
    this.placementStartY = this.snap(y);
    this.isPlacing = true;

    // Create the element at the start point with minimal size — the add methods
    // set defaults, we immediately override in updatePlacement.
    switch (tool) {
      case 'platform': this.addPlatform(x, y); break;
      case 'spring': this.addSpring(x, y); break;
      case 'spike': this.addSpike(x, y); break;
      case 'goalZone': this.addGoalZone(x, y); break;
      case 'hillZone': this.addHillZone(x, y); break;
      default: this.isPlacing = false; return;
    }

    // The add methods switch tool to 'select' — keep the tool active during placement
    this.selectedTool = tool;

    // Set initial size to 0; the drag will define it
    const data = this.findSelectedData();
    if (data && 'width' in data) {
      data.x = this.placementStartX;
      data.y = this.placementStartY;
      data.width = 0;
      data.height = 0;
    }
  }

  updatePlacement(x: number, y: number): void {
    if (!this.isPlacing) return;
    const data = this.findSelectedData();
    if (!data || !('width' in data)) return;

    const sx = this.placementStartX;
    const sy = this.placementStartY;
    const ex = this.snap(x);
    const ey = this.snap(y);

    // Position is the center of the rectangle defined by the two corners
    data.x = (sx + ex) / 2;
    data.y = (sy + ey) / 2;
    data.width = Math.abs(ex - sx);
    data.height = Math.abs(ey - sy);
    this.onChange?.();
  }

  finishPlacement(): void {
    if (!this.isPlacing) return;
    this.isPlacing = false;

    const data = this.findSelectedData();
    if (data && 'width' in data) {
      // If the user just clicked without dragging, apply sensible defaults
      if (data.width < 20 && data.height < 20) {
        switch (this.placementTool) {
          case 'platform': data.width = 200; data.height = 24; break;
          case 'spring': data.width = 100; data.height = 40; break;
          case 'spike': data.width = 200; data.height = 35; break;
          case 'goalZone': data.width = 400; data.height = 400; break;
          case 'hillZone': data.width = 500; data.height = 250; break;
        }
      }
    }

    this.selectedTool = 'select';
    this.placementTool = null;
    this.onChange?.();
  }

  // --- Delete ---

  deleteSelected(): void {
    if (!this.selectedElement) return;
    this.pushUndo();
    const { type, id } = this.selectedElement;
    switch (type) {
      case 'platform': this.level.platforms = this.level.platforms.filter(p => p.id !== id); break;
      case 'spawn': this.level.spawnPoints = this.level.spawnPoints.filter(s => s.id !== id); break;
      case 'npc': this.level.npcBlobs = this.level.npcBlobs.filter(n => n.id !== id); break;
      case 'wall': this.level.walls = this.level.walls.filter(w => w.id !== id); break;
      case 'spring': this.level.springPads = (this.level.springPads ?? []).filter(s => s.id !== id); break;
      case 'spike': this.level.spikes = (this.level.spikes ?? []).filter(s => s.id !== id); break;
      case 'goalZone': this.level.goalZones = (this.level.goalZones ?? []).filter(z => z.id !== id); break;
      case 'hillZone': this.level.hillZones = (this.level.hillZones ?? []).filter(z => z.id !== id); break;
      case 'powerup': this.level.powerupSpawns = (this.level.powerupSpawns ?? []).filter(p => p.id !== id); break;
    }
    this.selectedElement = null;
    this.onChange?.();
  }

  // --- Move ---

  moveSelected(worldX: number, worldY: number): void {
    const data = this.findSelectedData();
    if (!data) return;
    const dx = worldX - this.dragStartX;
    const dy = worldY - this.dragStartY;
    data.x = this.snap(this.dragElementStartX + dx);
    data.y = this.snap(this.dragElementStartY + dy);
    this.onChange?.();
  }

  startDrag(worldX: number, worldY: number): void {
    const data = this.findSelectedData();
    if (!data) return;
    this.isDragging = true;
    this.dragStartX = worldX;
    this.dragStartY = worldY;
    this.dragElementStartX = data.x;
    this.dragElementStartY = data.y;
    this.pushUndo();
  }

  stopDrag(): void {
    this.isDragging = false;
  }

  // --- Rotate ---

  rotateSelected(deltaRad: number): void {
    if (!this.isSelectedRotatable()) return;
    const data = this.findSelectedData();
    if (!data || data.rotation === undefined) return;
    this.pushUndo();
    data.rotation += deltaRad;
    // Normalize to [-PI, PI]
    while (data.rotation > Math.PI) data.rotation -= 2 * Math.PI;
    while (data.rotation < -Math.PI) data.rotation += 2 * Math.PI;
    this.onChange?.();
  }

  // --- Resize ---

  hitTestHandle(worldX: number, worldY: number): ResizeHandle | null {
    if (!this.isSelectedRect()) return null;
    const data = this.findSelectedData();
    if (!data || !data.width) return null;

    const rotation = data.rotation ?? 0;
    const hw = data.width / 2;
    const hh = data.height / 2;
    const threshold = 10 / this.zoom;

    const handles: { handle: ResizeHandle; lx: number; ly: number }[] = [
      { handle: 'right', lx: hw, ly: 0 },
      { handle: 'left', lx: -hw, ly: 0 },
      { handle: 'top', lx: 0, ly: -hh },
      { handle: 'bottom', lx: 0, ly: hh },
    ];

    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    for (const h of handles) {
      const hx = data.x + h.lx * cos - h.ly * sin;
      const hy = data.y + h.lx * sin + h.ly * cos;
      const dx = worldX - hx;
      const dy = worldY - hy;
      if (dx * dx + dy * dy < threshold * threshold) {
        return h.handle;
      }
    }
    return null;
  }

  startResize(handle: ResizeHandle, worldX: number, worldY: number): void {
    const data = this.findSelectedData();
    if (!data) return;
    this.pushUndo();
    this.isResizing = true;
    this.activeResizeHandle = handle;
    this.resizeStartMouseX = worldX;
    this.resizeStartMouseY = worldY;
    this.resizeInitState = {
      x: data.x, y: data.y,
      width: data.width, height: data.height,
      rotation: data.rotation ?? 0,
    };
  }

  resizeSelected(worldX: number, worldY: number): void {
    if (!this.isResizing || !this.activeResizeHandle || !this.resizeInitState) return;
    const data = this.findSelectedData();
    if (!data) return;

    const init = this.resizeInitState;
    const handle = this.activeResizeHandle;
    const cos = Math.cos(init.rotation);
    const sin = Math.sin(init.rotation);

    // Mouse delta in world space
    const dwx = worldX - this.resizeStartMouseX;
    const dwy = worldY - this.resizeStartMouseY;

    // Project delta onto element's local axes
    const localDx = dwx * cos + dwy * sin;
    const localDy = -dwx * sin + dwy * cos;

    const minSize = 20;

    switch (handle) {
      case 'right': {
        const newW = Math.max(minSize, this.snap(init.width + localDx));
        const shift = (newW - init.width) / 2;
        data.width = newW;
        data.x = init.x + shift * cos;
        data.y = init.y + shift * sin;
        break;
      }
      case 'left': {
        const newW = Math.max(minSize, this.snap(init.width - localDx));
        const shift = -(newW - init.width) / 2;
        data.width = newW;
        data.x = init.x + shift * cos;
        data.y = init.y + shift * sin;
        break;
      }
      case 'bottom': {
        const newH = Math.max(minSize, this.snap(init.height + localDy));
        const shift = (newH - init.height) / 2;
        data.height = newH;
        data.x = init.x - shift * sin;
        data.y = init.y + shift * cos;
        break;
      }
      case 'top': {
        const newH = Math.max(minSize, this.snap(init.height - localDy));
        const shift = -(newH - init.height) / 2;
        data.height = newH;
        data.x = init.x - shift * sin;
        data.y = init.y + shift * cos;
        break;
      }
    }
    this.onChange?.();
  }

  stopResize(): void {
    this.isResizing = false;
    this.activeResizeHandle = null;
    this.resizeInitState = null;
  }

  // --- Hit test ---

  hitTest(worldX: number, worldY: number): EditorElement | null {
    // Rectangular elements (with rotation-aware test)
    for (const p of this.level.platforms) {
      if (this.hitTestRect(worldX, worldY, p, p.rotation)) return { type: 'platform', id: p.id };
    }
    for (const s of this.level.springPads ?? []) {
      if (this.hitTestRect(worldX, worldY, s, s.rotation)) return { type: 'spring', id: s.id };
    }
    for (const s of this.level.spikes ?? []) {
      if (this.hitTestRect(worldX, worldY, s, s.rotation)) return { type: 'spike', id: s.id };
    }
    for (const z of this.level.goalZones ?? []) {
      if (this.hitTestRect(worldX, worldY, z)) return { type: 'goalZone', id: z.id };
    }
    for (const z of this.level.hillZones ?? []) {
      if (this.hitTestRect(worldX, worldY, z)) return { type: 'hillZone', id: z.id };
    }
    // Point elements
    for (const s of this.level.spawnPoints) {
      const dx = worldX - s.x, dy = worldY - s.y;
      if (dx * dx + dy * dy < 400) return { type: 'spawn', id: s.id };
    }
    for (const n of this.level.npcBlobs) {
      const dx = worldX - n.x, dy = worldY - n.y;
      if (dx * dx + dy * dy < 900) return { type: 'npc', id: n.id };
    }
    for (const p of this.level.powerupSpawns ?? []) {
      const dx = worldX - p.x, dy = worldY - p.y;
      if (dx * dx + dy * dy < 400) return { type: 'powerup', id: p.id };
    }
    return null;
  }

  private hitTestRect(
    worldX: number, worldY: number,
    rect: { x: number; y: number; width: number; height: number },
    rotation: number = 0,
  ): boolean {
    const dx = worldX - rect.x;
    const dy = worldY - rect.y;
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const hw = rect.width / 2;
    const hh = rect.height / 2;
    return localX >= -hw && localX <= hw && localY >= -hh && localY <= hh;
  }

  // --- Property updates ---

  updateProperty(key: string, value: any): void {
    const data = this.findSelectedData();
    if (!data) return;
    this.pushUndo();
    data[key] = value;
    this.onChange?.();
  }

  updateNpcPreset(id: string, preset: HullPreset): void {
    this.pushUndo();
    const n = this.level.npcBlobs.find(n => n.id === id);
    if (n) n.hullPreset = preset;
    this.onChange?.();
  }

  updateSpawnType(id: string, type: 'player' | 'npc'): void {
    this.pushUndo();
    const s = this.level.spawnPoints.find(s => s.id === id);
    if (s) s.type = type;
    this.onChange?.();
  }

  // --- Serialization ---

  toJSON(): string {
    return JSON.stringify(this.level, null, 2);
  }

  loadJSON(json: string): void {
    try {
      const parsed = JSON.parse(json) as LevelData;
      this.pushUndo();
      this.level = parsed;
      this.selectedElement = null;
      this.onChange?.();
    } catch (e) {
      console.error('Invalid level JSON', e);
    }
  }

  newLevel(levelTypes?: LevelType[]): void {
    this.pushUndo();
    this.level = {
      name: 'New Level',
      version: 1,
      levelTypes: levelTypes ?? [],
      bounds: { width: 4400, height: 2248 },
      platforms: [],
      walls: [
        { id: 'floor', points: [{ x: -2200, y: 1600 }, { x: 2200, y: 1600 }, { x: 2200, y: 1650 }, { x: -2200, y: 1650 }] },
        { id: 'ceiling', points: [{ x: -2200, y: -700 }, { x: 2200, y: -700 }, { x: 2200, y: -650 }, { x: -2200, y: -650 }] },
        { id: 'left', points: [{ x: -2250, y: -700 }, { x: -2200, y: -700 }, { x: -2200, y: 1650 }, { x: -2250, y: 1650 }] },
        { id: 'right', points: [{ x: 2200, y: -700 }, { x: 2250, y: -700 }, { x: 2250, y: 1650 }, { x: 2200, y: 1650 }] },
      ],
      spawnPoints: [{ id: 'sp1', x: 0, y: 380, type: 'player' }],
      npcBlobs: [],
    };
    this.selectedElement = null;
    this.onChange?.();
  }
}
