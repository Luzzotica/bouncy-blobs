import { LevelData, LevelType, PlatformDef, SpawnPointDef, NpcBlobDef, SpringPadDef, SpikeDef, ZoneDef, PowerupSpawnDef, PointShapeDef, PointShapePoint, TriggerDef, ActionDef, ActionTarget, SoftPlatformDef, SoftAnchorPattern, SpriteInstanceDef } from '../levels/types';
import { defaultLevel } from '../levels/defaultLevel';
import type { HullPreset } from '../physics/slimeBlob';

export type EditorTool =
  | 'select' | 'platform' | 'spawn' | 'npc' | 'spring' | 'spike'
  | 'goalZone' | 'hillZone' | 'powerup' | 'deathZone'
  | 'pointShape' | 'trigger' | 'action' | 'softPlatform' | 'sprite';

export type EditorElement =
  | { type: 'platform'; id: string }
  | { type: 'spawn'; id: string }
  | { type: 'npc'; id: string }
  | { type: 'wall'; id: string }
  | { type: 'spring'; id: string }
  | { type: 'spike'; id: string }
  | { type: 'goalZone'; id: string }
  | { type: 'hillZone'; id: string }
  | { type: 'deathZone'; id: string }
  | { type: 'powerup'; id: string }
  | { type: 'pointShape'; id: string }
  | { type: 'pointShapeVertex'; id: string; pointIndex: number }
  | { type: 'trigger'; id: string }
  | { type: 'action'; id: string }
  | { type: 'softPlatform'; id: string }
  | { type: 'sprite'; id: string };

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
  'q': 'pointShape',
  'w': 'trigger',
  'e': 'action',
  'r': 'softPlatform',
  'd': 'deathZone',
  't': 'sprite',
};

/** Default sprite id placed by the Sprite tool when the user hasn't picked
 * a specific asset yet. Cycle through this list with `placementSpriteId`
 * for now — a proper sprite picker UI comes in a follow-up pass. */
export const DEFAULT_SPRITE_PALETTE = ['pencil', 'spring_pad', 'spike', 'goal_flag', 'powerup_orb'];

const POINT_HIT_RADIUS_SQ = 200;

const RECT_TYPES = new Set<string>(['platform', 'spike', 'goalZone', 'hillZone', 'deathZone', 'trigger', 'softPlatform']);

export const SPRING_SIZE_PRESETS: { label: string; width: number; height: number }[] = [
  { label: 'Small', width: 70, height: 30 },
  { label: 'Medium', width: 100, height: 40 },
  { label: 'Large', width: 150, height: 55 },
];
const ROTATABLE_TYPES = new Set<string>(['platform', 'spring', 'spike', 'trigger']);

export interface UndoEntry {
  level: LevelData;
}

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

/** Snap (x, y) so its angle from (ox, oy) lands on the nearest 15° increment,
 * preserving radial distance. Used during shape drafting when Shift is held. */
export function snapToAngle(ox: number, oy: number, x: number, y: number, stepDeg = 15): { x: number; y: number } {
  const dx = x - ox;
  const dy = y - oy;
  const r = Math.hypot(dx, dy);
  if (r < 1e-3) return { x, y };
  const stepRad = (stepDeg * Math.PI) / 180;
  const angle = Math.atan2(dy, dx);
  const snapped = Math.round(angle / stepRad) * stepRad;
  return { x: ox + r * Math.cos(snapped), y: oy + r * Math.sin(snapped) };
}

/** Standard ray-cast point-in-polygon. */
function pointInPolygon(x: number, y: number, pts: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const intersect = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export class EditorState {
  level: LevelData;
  selectedTool: EditorTool = 'select';
  selectedElement: EditorElement | null = null;
  /** Additional elements selected for batch ops (shift-click). Keys are `${type}:${id}`. */
  multiSelect: EditorElement[] = [];
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

  // Draft state for multi-click PointShape authoring
  draftPointShape: { id: string; points: PointShapePoint[]; closed: boolean } | null = null;
  /** Cursor world position, updated on mouse move — used for ghost preview lines. */
  cursorX = 0;
  cursorY = 0;
  /** Whether Shift is currently held — used by shape drafting to snap angles. */
  angleSnapHeld = false;

  /** Which blob reference ghosts are currently shown at the cursor. */
  blobGhosts: { normal: boolean; large: boolean; crouching: boolean } = {
    normal: false,
    large: false,
    crouching: false,
  };

  // Draft state for Action authoring
  /** Phase 'pickPoints': click vertices/platforms to add. Phase 'placeEnds': drag ghosts to set end positions. */
  draftAction: {
    id: string;
    targets: ActionTarget[];
    phase: 'pickPoints' | 'placeEnds';
    duration: number;
    /** Default require + mode used at commit time. The user can edit these in the
     *  Action properties panel after commit. */
    sourceTriggerIds: string[];
  } | null = null;
  /** Index of the action target ghost currently being dragged (in placeEnds phase). */
  draggingActionTarget: number | null = null;

  // Local + Workshop tracking
  /** Local file id (uuid) once saved to disk. Null for unsaved levels. */
  localId: string | null = null;
  /** Steam Workshop PublishedFileId once this map has been published. */
  workshopId: string | null = null;

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
    const sel = this.selectedElement;
    switch (sel.type) {
      case 'platform': return this.level.platforms.find(p => p.id === sel.id);
      case 'spring': return (this.level.springPads ?? []).find(s => s.id === sel.id);
      case 'spike': return (this.level.spikes ?? []).find(s => s.id === sel.id);
      case 'goalZone': return (this.level.goalZones ?? []).find(z => z.id === sel.id);
      case 'hillZone': return (this.level.hillZones ?? []).find(z => z.id === sel.id);
      case 'deathZone': return (this.level.deathZones ?? []).find(z => z.id === sel.id);
      case 'spawn': return this.level.spawnPoints.find(s => s.id === sel.id);
      case 'npc': return this.level.npcBlobs.find(n => n.id === sel.id);
      case 'powerup': return (this.level.powerupSpawns ?? []).find(p => p.id === sel.id);
      case 'trigger': return (this.level.triggers ?? []).find(p => p.id === sel.id);
      case 'pointShape': return (this.level.pointShapes ?? []).find(p => p.id === sel.id);
      case 'pointShapeVertex': {
        const shape = (this.level.pointShapes ?? []).find(p => p.id === sel.id);
        return shape?.points[sel.pointIndex];
      }
      case 'action': return (this.level.actions ?? []).find(a => a.id === sel.id);
      case 'sprite': return (this.level.sprites ?? []).find(s => s.id === sel.id);
      case 'softPlatform': return (this.level.softPlatforms ?? []).find(s => s.id === sel.id);
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

  addSoftPlatform(x: number, y: number): void {
    this.pushUndo();
    if (!this.level.softPlatforms) this.level.softPlatforms = [];
    const sp: SoftPlatformDef = {
      id: genId('soft'), x: this.snap(x), y: this.snap(y),
      width: 400, height: 60, anchors: 'corners',
    };
    this.level.softPlatforms.push(sp);
    this.selectedElement = { type: 'softPlatform', id: sp.id };
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

  setSpringSize(id: string, presetIdx: number): void {
    const s = (this.level.springPads ?? []).find(s => s.id === id);
    if (!s) return;
    const preset = SPRING_SIZE_PRESETS[presetIdx];
    if (!preset) return;
    this.pushUndo();
    s.width = preset.width;
    s.height = preset.height;
    this.onChange?.();
  }

  /** Set a spring's size to the next preset. Wraps around. */
  cycleSpringSize(id: string, direction: 1 | -1 = 1): void {
    const s = (this.level.springPads ?? []).find(s => s.id === id);
    if (!s) return;
    this.pushUndo();
    const idx = SPRING_SIZE_PRESETS.findIndex(p => p.width === s.width && p.height === s.height);
    const next = (idx + direction + SPRING_SIZE_PRESETS.length) % SPRING_SIZE_PRESETS.length;
    const preset = SPRING_SIZE_PRESETS[idx < 0 ? 1 : next]; // unknown size → snap to Medium first
    s.width = preset.width;
    s.height = preset.height;
    this.onChange?.();
  }

  addSpring(x: number, y: number): void {
    this.pushUndo();
    if (!this.level.springPads) this.level.springPads = [];
    const spring: SpringPadDef = {
      id: genId('spring'), x: this.snap(x), y: this.snap(y),
      width: 100, height: 40, rotation: -Math.PI / 2, fireSpeed: 1100,
    };
    this.level.springPads.push(spring);
    this.selectedElement = { type: 'spring', id: spring.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  /** Drop a sprite instance at the cursor. Defaults to the first id in
   * DEFAULT_SPRITE_PALETTE; a proper picker comes later. */
  addSpriteInstance(x: number, y: number, spriteId: string = DEFAULT_SPRITE_PALETTE[0]): void {
    this.pushUndo();
    if (!this.level.sprites) this.level.sprites = [];
    const inst: SpriteInstanceDef = {
      id: genId('sprite'),
      spriteId,
      x: this.snap(x),
      y: this.snap(y),
      rotation: 0,
      scale: 1,
    };
    this.level.sprites.push(inst);
    this.selectedElement = { type: 'sprite', id: inst.id };
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

  addDeathZone(x: number, y: number): void {
    this.pushUndo();
    if (!this.level.deathZones) this.level.deathZones = [];
    const zone: ZoneDef = {
      id: genId('death'), x: this.snap(x), y: this.snap(y),
      width: 400, height: 120,
    };
    this.level.deathZones.push(zone);
    this.selectedElement = { type: 'deathZone', id: zone.id };
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

  // --- PointShape authoring ---

  beginDraftPointShape(): void {
    this.draftPointShape = { id: genId('shape'), points: [], closed: false };
  }

  /** Add a point to the active draft shape. Hold Shift = anchored. */
  appendDraftPoint(x: number, y: number, anchored: boolean): void {
    if (!this.draftPointShape) this.beginDraftPointShape();
    const draft = this.draftPointShape!;
    // If clicking near the first point, close the shape and commit.
    if (draft.points.length >= 3) {
      const first = draft.points[0];
      const dx = x - first.x;
      const dy = y - first.y;
      if (dx * dx + dy * dy < 200) {
        draft.closed = true;
        this.commitDraftPointShape();
        return;
      }
    }
    draft.points.push({ x: this.snap(x), y: this.snap(y), anchored });
    this.onChange?.();
  }

  /** Finalize the active draft shape into a real PointShapeDef. Esc cancels. */
  commitDraftPointShape(closed?: boolean): void {
    const draft = this.draftPointShape;
    this.draftPointShape = null;
    if (!draft || draft.points.length < 2) {
      this.onChange?.();
      return;
    }
    this.pushUndo();
    if (closed !== undefined) draft.closed = closed;
    if (!this.level.pointShapes) this.level.pointShapes = [];
    const edges = [];
    for (let i = 0; i < draft.points.length - 1; i++) edges.push({ a: i, b: i + 1 });
    const shape: PointShapeDef = {
      id: draft.id,
      points: draft.points,
      edges,
      closed: draft.closed,
    };
    this.level.pointShapes.push(shape);
    this.selectedElement = { type: 'pointShape', id: shape.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  cancelDraftPointShape(): void {
    this.draftPointShape = null;
    this.onChange?.();
  }

  /** Toggle anchored state of the specified vertex on a PointShape. */
  togglePointAnchored(shapeId: string, pointIndex: number): void {
    const shape = (this.level.pointShapes ?? []).find(p => p.id === shapeId);
    if (!shape) return;
    const pt = shape.points[pointIndex];
    if (!pt) return;
    this.pushUndo();
    pt.anchored = !pt.anchored;
    this.onChange?.();
  }

  movePointShapeVertex(shapeId: string, pointIndex: number, x: number, y: number): void {
    const shape = (this.level.pointShapes ?? []).find(p => p.id === shapeId);
    if (!shape) return;
    const pt = shape.points[pointIndex];
    if (!pt) return;
    pt.x = this.snap(x);
    pt.y = this.snap(y);
    this.onChange?.();
  }

  // --- Trigger (area) ---

  addTrigger(x: number, y: number): void {
    this.pushUndo();
    if (!this.level.triggers) this.level.triggers = [];
    const trig: TriggerDef = {
      id: genId('trig'),
      x: this.snap(x), y: this.snap(y),
      width: 120, height: 24, rotation: 0,
    };
    this.level.triggers.push(trig);
    this.selectedElement = { type: 'trigger', id: trig.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  toggleActionSourceTrigger(actionId: string, triggerId: string): void {
    const action = (this.level.actions ?? []).find(a => a.id === actionId);
    if (!action) return;
    this.pushUndo();
    const idx = action.sourceTriggerIds.indexOf(triggerId);
    if (idx >= 0) action.sourceTriggerIds.splice(idx, 1);
    else action.sourceTriggerIds.push(triggerId);
    this.onChange?.();
  }

  // --- Action authoring ---

  beginDraftAction(): void {
    this.draftAction = {
      id: genId('act'),
      targets: [],
      phase: 'pickPoints',
      duration: 1.0,
      sourceTriggerIds: [],
    };
  }

  /** In pickPoints phase: clicking a vertex adds it as a target. */
  appendActionTargetAtVertex(shapeId: string, pointIndex: number): void {
    const shape = (this.level.pointShapes ?? []).find(p => p.id === shapeId);
    if (!shape) return;
    const pt = shape.points[pointIndex];
    if (!pt) return;
    if (!this.draftAction) this.beginDraftAction();
    const draft = this.draftAction!;
    // Avoid dup
    if (draft.targets.some(t => t.kind === 'shapePoint' && t.shapeId === shapeId && t.pointIndex === pointIndex)) return;
    draft.targets.push({
      kind: 'shapePoint',
      shapeId, pointIndex,
      endX: pt.x + 100, endY: pt.y - 100,
    });
    this.onChange?.();
  }

  /** In pickPoints phase: clicking a platform adds it as a movable target. */
  appendActionTargetAtPlatform(platformId: string): void {
    const plat = this.level.platforms.find(p => p.id === platformId);
    if (!plat) return;
    if (!this.draftAction) this.beginDraftAction();
    const draft = this.draftAction!;
    if (draft.targets.some(t => t.kind === 'platform' && t.platformId === platformId)) return;
    draft.targets.push({
      kind: 'platform',
      platformId,
      endX: plat.x + 200, endY: plat.y,
    });
    this.onChange?.();
  }

  advanceDraftActionPhase(): void {
    if (!this.draftAction) return;
    if (this.draftAction.phase === 'pickPoints' && this.draftAction.targets.length > 0) {
      this.draftAction.phase = 'placeEnds';
    }
    this.onChange?.();
  }

  commitDraftAction(): void {
    const draft = this.draftAction;
    this.draftAction = null;
    if (!draft || draft.targets.length === 0) { this.onChange?.(); return; }
    this.pushUndo();
    if (!this.level.actions) this.level.actions = [];
    const action: ActionDef = {
      id: draft.id,
      kind: 'movePoints',
      targets: draft.targets,
      duration: draft.duration,
      easing: 'easeInOut',
      sourceTriggerIds: draft.sourceTriggerIds,
      requireMode: 'any',
      mode: 'switch',
    };
    this.level.actions.push(action);
    this.selectedElement = { type: 'action', id: action.id };
    this.selectedTool = 'select';
    this.onChange?.();
  }

  cancelDraftAction(): void {
    this.draftAction = null;
    this.draggingActionTarget = null;
    this.onChange?.();
  }

  /** Drag a target endpoint while in placeEnds phase. */
  setDraftActionTargetEnd(index: number, x: number, y: number): void {
    if (!this.draftAction) return;
    const t = this.draftAction.targets[index];
    if (!t) return;
    t.endX = this.snap(x);
    t.endY = this.snap(y);
    this.onChange?.();
  }

  /** Edit an existing committed action's target end position. */
  setActionTargetEnd(actionId: string, index: number, x: number, y: number): void {
    const action = (this.level.actions ?? []).find(a => a.id === actionId);
    if (!action) return;
    const t = action.targets[index];
    if (!t) return;
    t.endX = this.snap(x);
    t.endY = this.snap(y);
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
      case 'spike': this.addSpike(x, y); break;
      case 'goalZone': this.addGoalZone(x, y); break;
      case 'hillZone': this.addHillZone(x, y); break;
      case 'deathZone': this.addDeathZone(x, y); break;
      case 'trigger': this.addTrigger(x, y); break;
      case 'softPlatform': this.addSoftPlatform(x, y); break;
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
          case 'spike': data.width = 200; data.height = 35; break;
          case 'goalZone': data.width = 400; data.height = 400; break;
          case 'hillZone': data.width = 500; data.height = 250; break;
          case 'deathZone': data.width = 400; data.height = 120; break;
          case 'trigger': data.width = 120; data.height = 24; break;
          case 'softPlatform': data.width = 400; data.height = 60; break;
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
    const sel = this.selectedElement;
    switch (sel.type) {
      case 'platform': this.level.platforms = this.level.platforms.filter(p => p.id !== sel.id); break;
      case 'spawn': this.level.spawnPoints = this.level.spawnPoints.filter(s => s.id !== sel.id); break;
      case 'npc': this.level.npcBlobs = this.level.npcBlobs.filter(n => n.id !== sel.id); break;
      case 'wall': this.level.walls = this.level.walls.filter(w => w.id !== sel.id); break;
      case 'spring': this.level.springPads = (this.level.springPads ?? []).filter(s => s.id !== sel.id); break;
      case 'spike': this.level.spikes = (this.level.spikes ?? []).filter(s => s.id !== sel.id); break;
      case 'goalZone': this.level.goalZones = (this.level.goalZones ?? []).filter(z => z.id !== sel.id); break;
      case 'hillZone': this.level.hillZones = (this.level.hillZones ?? []).filter(z => z.id !== sel.id); break;
      case 'deathZone': this.level.deathZones = (this.level.deathZones ?? []).filter(z => z.id !== sel.id); break;
      case 'powerup': this.level.powerupSpawns = (this.level.powerupSpawns ?? []).filter(p => p.id !== sel.id); break;
      case 'softPlatform': this.level.softPlatforms = (this.level.softPlatforms ?? []).filter(s => s.id !== sel.id); break;
      case 'trigger': {
        const removedId = sel.id;
        this.level.triggers = (this.level.triggers ?? []).filter(t => t.id !== removedId);
        // Drop this trigger from every action's source list.
        for (const action of this.level.actions ?? []) {
          action.sourceTriggerIds = action.sourceTriggerIds.filter(id => id !== removedId);
        }
        break;
      }
      case 'pointShape': {
        const removedId = sel.id;
        this.level.pointShapes = (this.level.pointShapes ?? []).filter(p => p.id !== removedId);
        // Drop action targets that referenced this shape; remove now-empty actions.
        this.level.actions = (this.level.actions ?? []).map(a => ({
          ...a,
          targets: a.targets.filter(t => t.kind !== 'shapePoint' || t.shapeId !== removedId),
        })).filter(a => a.targets.length > 0);
        break;
      }
      case 'pointShapeVertex': {
        const shape = (this.level.pointShapes ?? []).find(p => p.id === sel.id);
        if (shape) {
          shape.points.splice(sel.pointIndex, 1);
          // Reindex edges; drop edges that referenced the removed point.
          shape.edges = shape.edges
            .filter(e => e.a !== sel.pointIndex && e.b !== sel.pointIndex)
            .map(e => ({
              ...e,
              a: e.a > sel.pointIndex ? e.a - 1 : e.a,
              b: e.b > sel.pointIndex ? e.b - 1 : e.b,
            }));
          // Tidy actions — drop targets pointing at removed/now-shifted indices.
          for (const a of this.level.actions ?? []) {
            a.targets = a.targets
              .filter(tt => !(tt.kind === 'shapePoint' && tt.shapeId === sel.id && tt.pointIndex === sel.pointIndex))
              .map(tt => tt.kind === 'shapePoint' && tt.shapeId === sel.id && tt.pointIndex > sel.pointIndex
                ? { ...tt, pointIndex: tt.pointIndex - 1 } : tt);
          }
        }
        break;
      }
      case 'action': {
        const removedId = sel.id;
        this.level.actions = (this.level.actions ?? []).filter(a => a.id !== removedId);
        break;
      }
    }
    this.selectedElement = null;
    this.onChange?.();
  }

  // --- Duplicate ---

  /** Duplicate the currently selected element, offset by (24, 24), and select the copy. */
  duplicateSelected(offsetX: number = 24, offsetY: number = 24): void {
    if (!this.selectedElement) return;
    const sel = this.selectedElement;
    const src = this.findSelectedData();
    if (!src) return;
    this.pushUndo();

    const clone = JSON.parse(JSON.stringify(src));
    if (typeof clone.x === 'number') clone.x = this.snap(clone.x + offsetX);
    if (typeof clone.y === 'number') clone.y = this.snap(clone.y + offsetY);

    let newId: string | null = null;
    switch (sel.type) {
      case 'platform': clone.id = genId('plat'); this.level.platforms.push(clone); newId = clone.id; break;
      case 'spring':
        clone.id = genId('spring');
        if (!this.level.springPads) this.level.springPads = [];
        this.level.springPads.push(clone); newId = clone.id; break;
      case 'spike':
        clone.id = genId('spike');
        if (!this.level.spikes) this.level.spikes = [];
        this.level.spikes.push(clone); newId = clone.id; break;
      case 'goalZone':
        clone.id = genId('goal');
        if (!this.level.goalZones) this.level.goalZones = [];
        this.level.goalZones.push(clone); newId = clone.id; break;
      case 'hillZone':
        clone.id = genId('hill');
        if (!this.level.hillZones) this.level.hillZones = [];
        this.level.hillZones.push(clone); newId = clone.id; break;
      case 'deathZone':
        clone.id = genId('death');
        if (!this.level.deathZones) this.level.deathZones = [];
        this.level.deathZones.push(clone); newId = clone.id; break;
      case 'spawn': clone.id = genId('sp'); this.level.spawnPoints.push(clone); newId = clone.id; break;
      case 'npc': clone.id = genId('npc'); this.level.npcBlobs.push(clone); newId = clone.id; break;
      case 'powerup':
        clone.id = genId('pu');
        if (!this.level.powerupSpawns) this.level.powerupSpawns = [];
        this.level.powerupSpawns.push(clone); newId = clone.id; break;
      case 'softPlatform':
        clone.id = genId('soft');
        if (!this.level.softPlatforms) this.level.softPlatforms = [];
        this.level.softPlatforms.push(clone); newId = clone.id; break;
      case 'trigger':
        clone.id = genId('trig');
        if (!this.level.triggers) this.level.triggers = [];
        this.level.triggers.push(clone); newId = clone.id; break;
      case 'pointShape': {
        clone.id = genId('shape');
        for (const pt of clone.points) {
          pt.x = this.snap(pt.x + offsetX);
          pt.y = this.snap(pt.y + offsetY);
        }
        if (!this.level.pointShapes) this.level.pointShapes = [];
        this.level.pointShapes.push(clone); newId = clone.id; break;
      }
      // wall / action / pointShapeVertex: skip — not meaningfully duplicable.
      default: return;
    }

    if (newId) {
      this.selectedElement = { type: sel.type, id: newId } as EditorElement;
    }
    this.onChange?.();
  }

  // --- Move ---

  /** Saved point positions when dragging a whole PointShape — used to translate all vertices together. */
  private dragShapePoints: { x: number; y: number }[] | null = null;

  moveSelected(worldX: number, worldY: number): void {
    const data = this.findSelectedData();
    if (!data) return;
    const dx = worldX - this.dragStartX;
    const dy = worldY - this.dragStartY;
    if (this.selectedElement?.type === 'pointShape' && this.dragShapePoints && data.points) {
      // Translate every vertex by the same delta.
      for (let i = 0; i < data.points.length; i++) {
        const start = this.dragShapePoints[i];
        data.points[i].x = this.snap(start.x + dx);
        data.points[i].y = this.snap(start.y + dy);
      }
      this.onChange?.();
      return;
    }
    if (typeof data.x !== 'number' || typeof data.y !== 'number') return;
    data.x = this.snap(this.dragElementStartX + dx);
    data.y = this.snap(this.dragElementStartY + dy);
    this.onChange?.();
  }

  startDrag(worldX: number, worldY: number): void {
    const data = this.findSelectedData();
    if (!data) return;
    if (this.selectedElement?.type === 'pointShape' && data.points) {
      this.isDragging = true;
      this.dragStartX = worldX;
      this.dragStartY = worldY;
      this.dragShapePoints = data.points.map((p: { x: number; y: number }) => ({ x: p.x, y: p.y }));
      this.pushUndo();
      return;
    }
    if (typeof data.x !== 'number' || typeof data.y !== 'number') return;
    this.isDragging = true;
    this.dragStartX = worldX;
    this.dragStartY = worldY;
    this.dragElementStartX = data.x;
    this.dragElementStartY = data.y;
    this.dragShapePoints = null;
    this.pushUndo();
  }

  stopDrag(): void {
    this.isDragging = false;
    this.dragShapePoints = null;
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

    // Spikes anchor at the base bar (def.y = base); visual extends UP from there.
    // Handles must follow that asymmetric layout so they sit on the spike's edges.
    const isSpike = this.selectedElement?.type === 'spike';
    const handles: { handle: ResizeHandle; lx: number; ly: number }[] = isSpike
      ? [
          { handle: 'right', lx: hw, ly: -data.height / 2 },
          { handle: 'left', lx: -hw, ly: -data.height / 2 },
          { handle: 'top', lx: 0, ly: -data.height },
          { handle: 'bottom', lx: 0, ly: 0 },
        ]
      : [
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
    // Spikes anchor at the base bar — top/bottom resize changes height without
    // shifting def.y (which would move the base off the ground).
    const isSpike = this.selectedElement?.type === 'spike';

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
        data.height = newH;
        if (!isSpike) {
          const shift = (newH - init.height) / 2;
          data.x = init.x - shift * sin;
          data.y = init.y + shift * cos;
        }
        break;
      }
      case 'top': {
        const newH = Math.max(minSize, this.snap(init.height - localDy));
        data.height = newH;
        if (!isSpike) {
          const shift = -(newH - init.height) / 2;
          data.x = init.x - shift * sin;
          data.y = init.y + shift * cos;
        }
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

  /** Hit-test a vertex of any PointShape. Returns the closest hit within radius. */
  hitTestPointShapeVertex(worldX: number, worldY: number): { shapeId: string; pointIndex: number } | null {
    let best: { shapeId: string; pointIndex: number; distSq: number } | null = null;
    for (const shape of this.level.pointShapes ?? []) {
      for (let i = 0; i < shape.points.length; i++) {
        const pt = shape.points[i];
        const dx = worldX - pt.x;
        const dy = worldY - pt.y;
        const d = dx * dx + dy * dy;
        if (d < POINT_HIT_RADIUS_SQ && (!best || d < best.distSq)) {
          best = { shapeId: shape.id, pointIndex: i, distSq: d };
        }
      }
    }
    return best ? { shapeId: best.shapeId, pointIndex: best.pointIndex } : null;
  }

  /** Hit-test a draft-action end ghost handle (in placeEnds phase). Returns index in targets. */
  hitTestDraftActionEnd(worldX: number, worldY: number): number | null {
    if (!this.draftAction || this.draftAction.phase !== 'placeEnds') return null;
    for (let i = 0; i < this.draftAction.targets.length; i++) {
      const t = this.draftAction.targets[i];
      const dx = worldX - t.endX;
      const dy = worldY - t.endY;
      if (dx * dx + dy * dy < POINT_HIT_RADIUS_SQ) return i;
    }
    return null;
  }

  hitTest(worldX: number, worldY: number): EditorElement | null {
    // PointShape vertices take priority — they're small handles.
    const vhit = this.hitTestPointShapeVertex(worldX, worldY);
    if (vhit) return { type: 'pointShapeVertex', id: vhit.shapeId, pointIndex: vhit.pointIndex };

    // Click inside a closed shape selects the whole shape (for moving).
    for (const ps of this.level.pointShapes ?? []) {
      if (ps.closed && ps.points.length >= 3 && pointInPolygon(worldX, worldY, ps.points)) {
        return { type: 'pointShape', id: ps.id };
      }
    }

    // Pressure plates (rect with rotation)
    for (const p of this.level.triggers ?? []) {
      if (this.hitTestRect(worldX, worldY, p, p.rotation)) return { type: 'trigger', id: p.id };
    }

    // Rectangular elements (with rotation-aware test)
    for (const s of this.level.softPlatforms ?? []) {
      if (this.hitTestRect(worldX, worldY, s)) return { type: 'softPlatform', id: s.id };
    }
    for (const p of this.level.platforms) {
      if (this.hitTestRect(worldX, worldY, p, p.rotation)) return { type: 'platform', id: p.id };
    }
    for (const s of this.level.springPads ?? []) {
      if (this.hitTestSpring(worldX, worldY, s)) return { type: 'spring', id: s.id };
    }
    for (const s of this.level.spikes ?? []) {
      if (this.hitTestSpike(worldX, worldY, s)) return { type: 'spike', id: s.id };
    }
    for (const z of this.level.goalZones ?? []) {
      if (this.hitTestRect(worldX, worldY, z)) return { type: 'goalZone', id: z.id };
    }
    for (const z of this.level.hillZones ?? []) {
      if (this.hitTestRect(worldX, worldY, z)) return { type: 'hillZone', id: z.id };
    }
    for (const z of this.level.deathZones ?? []) {
      if (this.hitTestRect(worldX, worldY, z)) return { type: 'deathZone', id: z.id };
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

  /** Hit-test for spring pads — uses the full visual extent (coils + plate + back wall),
   * which is much taller perpendicular to the launch axis than the bare def.height. */
  private hitTestSpring(worldX: number, worldY: number, s: SpringPadDef): boolean {
    const dx = worldX - s.x;
    const dy = worldY - s.y;
    const cos = Math.cos(-s.rotation);
    const sin = Math.sin(-s.rotation);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const hw = s.width / 2;
    // Same constants as springRenderer: perpendicular = height * PLATE_WIDTH_SCALE * 1.2 (back wall flare).
    const hh = s.height * 8 * 0.5 * 1.2;
    // x extent: back wall (-hw - 6) to arrow tip (+hw + 20).
    return localX >= -hw - 6 && localX <= hw + 20 && localY >= -hh && localY <= hh;
  }

  /** Hit-test for spikes — local y range is [-height, 4] (teeth go up from base bar). */
  private hitTestSpike(worldX: number, worldY: number, s: SpikeDef): boolean {
    const dx = worldX - s.x;
    const dy = worldY - s.y;
    const cos = Math.cos(-s.rotation);
    const sin = Math.sin(-s.rotation);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const hw = s.width / 2;
    return localX >= -hw && localX <= hw && localY >= -s.height && localY <= 4;
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

  // --- Multi-select & distribute ---

  /** Add or remove an element from the multi-select set. */
  toggleMultiSelect(el: EditorElement): void {
    const key = `${el.type}:${el.id}`;
    const idx = this.multiSelect.findIndex(e => `${e.type}:${e.id}` === key);
    if (idx >= 0) this.multiSelect.splice(idx, 1);
    else this.multiSelect.push(el);
    this.onChange?.();
  }

  clearMultiSelect(): void {
    this.multiSelect = [];
    this.onChange?.();
  }

  /** Returns the union of the primary selection and the multi-select set. */
  getMultiSelected(): EditorElement[] {
    const out: EditorElement[] = [...this.multiSelect];
    if (this.selectedElement) {
      const k = `${this.selectedElement.type}:${this.selectedElement.id}`;
      if (!out.some(e => `${e.type}:${e.id}` === k)) out.unshift(this.selectedElement);
    }
    return out;
  }

  private elementCoords(el: EditorElement): { data: any } | null {
    const prev = this.selectedElement;
    this.selectedElement = el;
    const data = this.findSelectedData();
    this.selectedElement = prev;
    if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return null;
    return { data };
  }

  /** Distribute selected elements with equal spacing along the given axis. */
  distribute(axis: 'x' | 'y'): void {
    const items = this.getMultiSelected()
      .map(el => this.elementCoords(el))
      .filter((x): x is { data: any } => x !== null);
    if (items.length < 3) return;
    this.pushUndo();
    items.sort((a, b) => a.data[axis] - b.data[axis]);
    const lo = items[0].data[axis];
    const hi = items[items.length - 1].data[axis];
    const step = (hi - lo) / (items.length - 1);
    for (let i = 0; i < items.length; i++) {
      items[i].data[axis] = this.snap(lo + i * step);
    }
    this.onChange?.();
  }

  /** Align selected elements' coordinate on the given axis to the first one. */
  align(axis: 'x' | 'y'): void {
    const items = this.getMultiSelected()
      .map(el => this.elementCoords(el))
      .filter((x): x is { data: any } => x !== null);
    if (items.length < 2) return;
    this.pushUndo();
    const v = items[0].data[axis];
    for (let i = 1; i < items.length; i++) items[i].data[axis] = v;
    this.onChange?.();
  }

  newLevel(levelTypes?: LevelType[]): void {
    this.pushUndo();
    this.level = {
      name: 'New Level',
      version: 1,
      levelTypes: levelTypes ?? [],
      bounds: { width: 4400, height: 2248 },
      platforms: [],
      walls: [],
      spawnPoints: [{ id: 'sp1', x: 0, y: 380, type: 'player' }],
      npcBlobs: [],
    };
    this.selectedElement = null;
    this.onChange?.();
  }
}
