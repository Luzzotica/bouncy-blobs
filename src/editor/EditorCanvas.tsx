import React, { useRef, useEffect, useCallback } from 'react';
import { EditorState, TOOL_HOTKEYS, snapToAngle } from './EditorState';
import { PLATFORM_COLOR, PLATFORM_BORDER, BACKGROUND_COLOR } from '../renderer/colors';
import { drawSpring, PLATE_THICKNESS, PLATE_WIDTH_SCALE } from '../game/springRenderer';
import { getSprite } from '../assets/spriteRegistry';
import { drawSprite } from '../renderer/spriteRenderer';
import { drawLava } from '../renderer/lavaRenderer';
import { computeLevelAABB, FALL_KILL_MARGIN } from '../game/mapBounds';
import { BLOB_RADIUS, BLOB_EXPAND_MAX_SCALE, BLOB_SQUASH_X_AMOUNT, BLOB_SQUASH_Y_AMOUNT } from '../physics/slimeBlob';
import type { SpringPadDef, ActionTarget } from '../levels/types';
import { rect as hullRect, rectAnchorIndices } from '../physics/hullPresets';

/** Detect macOS for platform-appropriate modifier labels. On Mac the
 *  physical key is labelled "Option" (or "⌥"), not "Alt". `e.altKey` IS
 *  true when Option is held, but the UI hint needs to say "Option" or
 *  Mac users won't know what to press. */
const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
const ALT_LABEL = IS_MAC ? 'Option' : 'Alt';
/** True for either the Alt/Option key OR the Ctrl key — Ctrl as a fallback
 *  in case the OS captures Option-click for a system shortcut. */
function isModifierHeld(e: { altKey: boolean; ctrlKey: boolean }): boolean {
  return e.altKey || e.ctrlKey;
}

/** Standard ray-cast point-in-polygon. Local helper so this file isn't
 *  coupled to the EditorState's internal helper. */
function pointInPolygonPts(x: number, y: number, pts: { x: number; y: number }[]): boolean {
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

/** Rotation-aware hit-test for a spike's bbox (anchored at the base bar; teeth
 *  extend up so local y spans [-height, 4]). Used by the Action tool. */
function hitSpikeForAction(
  wx: number, wy: number,
  s: { x: number; y: number; width: number; height: number; rotation: number },
): boolean {
  const dx = wx - s.x, dy = wy - s.y;
  const cos = Math.cos(-s.rotation), sin = Math.sin(-s.rotation);
  const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
  return Math.abs(lx) <= s.width / 2 && ly >= -s.height && ly <= 4;
}

/** Local-space bounding box covering the full spring visual (coils + plate + back wall + arrow). */
function springVisualBox(s: SpringPadDef): { x: number; y: number; w: number; h: number } {
  const hw = s.width / 2;
  const hh = (s.height * PLATE_WIDTH_SCALE) / 2;
  // Back wall extends 6px left of -hw; arrow extends ~20px right of hw.
  const xMin = -hw - 6;
  const xMax = hw + 20;
  // Back wall extends ±1.2*hh perpendicular to the launch axis.
  const yExt = hh * 1.2;
  return { x: xMin, y: -yExt, w: xMax - xMin, h: yExt * 2 };
}

interface EditorCanvasProps {
  state: EditorState;
  onUpdate: () => void;
}

/** Pointer-agnostic gesture input: the mouse handlers and the touch layer
 *  both funnel into pointerDown/Move/Up with this shape, so every tool's
 *  interaction logic lives exactly once. `pan` = an explicit pan gesture
 *  (middle/right button, Space+left on mouse; two-finger on touch);
 *  `primary` = the main button (always true for touch); `shiftKey`/`modifier`
 *  come from the keyboard on desktop and from the touch modifier chips on
 *  phones. */
interface EditorPointer {
  sx: number;
  sy: number;
  shiftKey: boolean;
  modifier: boolean;
  pan: boolean;
  primary: boolean;
}

export default function EditorCanvas({ state, onUpdate }: EditorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const spaceHeldRef = useRef(false);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    return {
      x: (sx - cx) / state.zoom + state.panX,
      y: (sy - cy) / state.zoom + state.panY,
    };
  }, [state]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;

    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2 - state.panX * state.zoom, h / 2 - state.panY * state.zoom);
    ctx.scale(state.zoom, state.zoom);

    // Grid
    drawGrid(ctx, state, w, h);

    // Death-zone lava: the fall-off-the-map kill plane, at the same height the
    // game kills (lowest geometry + FALL_KILL_MARGIN). Recomputed each frame so
    // it tracks live edits. Drawn over the grid but under the geometry. The kill
    // plane is always active; this visual is gated by the level's showLava flag.
    if (state.level.showLava !== false) {
      const aabb = computeLevelAABB(state.level);
      const halfW = w / 2 / state.zoom;
      const halfH = h / 2 / state.zoom;
      const left = state.panX - halfW - 80;
      const right = state.panX + halfW + 80;
      const bottom = state.panY + halfH + 80;
      const lavaY = aabb.maxY + FALL_KILL_MARGIN;
      if (bottom > lavaY) drawLava(ctx, lavaY, left, right, bottom, performance.now() / 1000);
    }

    // Walls
    for (const wall of state.level.walls) {
      ctx.beginPath();
      ctx.moveTo(wall.points[0].x, wall.points[0].y);
      for (let i = 1; i < wall.points.length; i++) {
        ctx.lineTo(wall.points[i].x, wall.points[i].y);
      }
      ctx.closePath();
      ctx.fillStyle = '#333';
      ctx.fill();
    }

    // Death zones — translucent red rects with hatched border.
    for (const z of state.level.deathZones ?? []) {
      const selected = state.selectedElement?.type === 'deathZone' && state.selectedElement.id === z.id;
      ctx.save();
      ctx.translate(z.x, z.y);
      ctx.fillStyle = selected ? 'rgba(220, 40, 40, 0.30)' : 'rgba(220, 40, 40, 0.18)';
      ctx.fillRect(-z.width / 2, -z.height / 2, z.width, z.height);
      ctx.strokeStyle = selected ? '#ff5050' : 'rgba(255, 70, 70, 0.9)';
      ctx.lineWidth = selected ? 3 : 2;
      ctx.setLineDash([10, 6]);
      ctx.strokeRect(-z.width / 2, -z.height / 2, z.width, z.height);
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff5050';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('DEATH', 0, 0);
      ctx.restore();
    }

    // Goal zones (behind gameplay elements)
    for (const z of state.level.goalZones ?? []) {
      const selected = state.selectedElement?.type === 'goalZone' && state.selectedElement.id === z.id;
      ctx.save();
      ctx.translate(z.x, z.y);
      ctx.fillStyle = selected ? 'rgba(0, 200, 80, 0.3)' : 'rgba(0, 180, 60, 0.2)';
      ctx.fillRect(-z.width / 2, -z.height / 2, z.width, z.height);
      ctx.strokeStyle = selected ? '#0f8' : '#0a6';
      ctx.lineWidth = selected ? 3 : 2;
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(-z.width / 2, -z.height / 2, z.width, z.height);
      ctx.setLineDash([]);
      ctx.fillStyle = selected ? '#0f8' : '#0a6';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GOAL', 0, 0);
      ctx.restore();
    }

    // Hill zones
    for (const z of state.level.hillZones ?? []) {
      const selected = state.selectedElement?.type === 'hillZone' && state.selectedElement.id === z.id;
      ctx.save();
      ctx.translate(z.x, z.y);
      ctx.fillStyle = selected ? 'rgba(255, 200, 50, 0.3)' : 'rgba(200, 160, 30, 0.2)';
      ctx.fillRect(-z.width / 2, -z.height / 2, z.width, z.height);
      ctx.strokeStyle = selected ? '#fc0' : '#a80';
      ctx.lineWidth = selected ? 3 : 2;
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(-z.width / 2, -z.height / 2, z.width, z.height);
      ctx.setLineDash([]);
      ctx.fillStyle = selected ? '#fc0' : '#a80';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('HILL', 0, 0);
      ctx.restore();
    }

    // Gravity zones — uniform shows an arrow indicating direction; point
    // shows a radial gradient hint with the centre marker.
    for (const z of state.level.gravityZones ?? []) {
      const selected = state.selectedElement?.type === 'gravityZone' && state.selectedElement.id === z.id;
      const f = z.field;
      ctx.save();
      if (f.kind === 'uniform') {
        const isZero = Math.abs(f.vector.x) + Math.abs(f.vector.y) < 1e-3;
        ctx.fillStyle = isZero
          ? (selected ? 'rgba(80, 220, 220, 0.30)' : 'rgba(80, 220, 220, 0.18)')
          : (selected ? 'rgba(255, 160, 60, 0.28)' : 'rgba(255, 160, 60, 0.16)');
        ctx.fillRect(z.x - z.width / 2, z.y - z.height / 2, z.width, z.height);
        ctx.strokeStyle = isZero
          ? (selected ? '#aaf0f0' : 'rgba(80, 220, 220, 0.7)')
          : (selected ? '#ffd28a' : 'rgba(255, 160, 60, 0.7)');
        ctx.lineWidth = selected ? 3 : 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(z.x - z.width / 2, z.y - z.height / 2, z.width, z.height);
        ctx.setLineDash([]);
        if (!isZero) {
          const mag = Math.sqrt(f.vector.x * f.vector.x + f.vector.y * f.vector.y);
          const dx = f.vector.x / mag, dy = f.vector.y / mag;
          const arrowLen = Math.min(70, Math.min(z.width, z.height) * 0.4);
          const ex = z.x + dx * arrowLen, ey = z.y + dy * arrowLen;
          ctx.beginPath();
          ctx.moveTo(z.x - dx * arrowLen, z.y - dy * arrowLen);
          ctx.lineTo(ex, ey);
          ctx.strokeStyle = 'rgba(255, 200, 100, 0.95)';
          ctx.lineWidth = 3;
          ctx.stroke();
          // Arrowhead
          const ah = 12;
          const pX = -dy, pY = dx;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - dx * ah + pX * ah * 0.5, ey - dy * ah + pY * ah * 0.5);
          ctx.lineTo(ex - dx * ah - pX * ah * 0.5, ey - dy * ah - pY * ah * 0.5);
          ctx.closePath();
          ctx.fillStyle = 'rgba(255, 200, 100, 0.95)';
          ctx.fill();
        }
      } else {
        // Point gravity: radial gradient hint plus centre marker.
        const grad = ctx.createRadialGradient(f.center.x, f.center.y, 5, f.center.x, f.center.y, Math.max(z.width, z.height) * 0.5);
        grad.addColorStop(0, selected ? 'rgba(200, 90, 240, 0.65)' : 'rgba(180, 60, 220, 0.50)');
        grad.addColorStop(1, 'rgba(180, 60, 220, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(z.x - z.width / 2, z.y - z.height / 2, z.width, z.height);
        ctx.strokeStyle = selected ? '#d6a0ff' : 'rgba(180, 60, 220, 0.7)';
        ctx.lineWidth = selected ? 3 : 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(z.x - z.width / 2, z.y - z.height / 2, z.width, z.height);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(f.center.x, f.center.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 230, 255, 0.9)';
        ctx.fill();
      }
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.kind === 'uniform' ? 'GRAVITY' : 'PULL', z.x, z.y - z.height / 2 - 12);
      ctx.restore();
    }

    // Soft platforms (drawn first so platforms render on top)
    for (const sp of state.level.softPlatforms ?? []) {
      const selected = state.selectedElement?.type === 'softPlatform' && state.selectedElement.id === sp.id;
      const hw = sp.width / 2;
      const hh = sp.height / 2;
      ctx.save();
      ctx.fillStyle = selected ? '#5a6a90' : '#9aa6c0';
      ctx.strokeStyle = selected ? '#8ab4f8' : '#4f5874';
      ctx.lineWidth = selected ? 3 : 2;
      const r = Math.min(8, hh, hw);
      // Rounded rectangle
      ctx.beginPath();
      ctx.moveTo(sp.x - hw + r, sp.y - hh);
      ctx.lineTo(sp.x + hw - r, sp.y - hh);
      ctx.quadraticCurveTo(sp.x + hw, sp.y - hh, sp.x + hw, sp.y - hh + r);
      ctx.lineTo(sp.x + hw, sp.y + hh - r);
      ctx.quadraticCurveTo(sp.x + hw, sp.y + hh, sp.x + hw - r, sp.y + hh);
      ctx.lineTo(sp.x - hw + r, sp.y + hh);
      ctx.quadraticCurveTo(sp.x - hw, sp.y + hh, sp.x - hw, sp.y + hh - r);
      ctx.lineTo(sp.x - hw, sp.y - hh + r);
      ctx.quadraticCurveTo(sp.x - hw, sp.y - hh, sp.x - hw + r, sp.y - hh);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Hull preview — show every particle the loader will create from the
      // current segW/segH/rotation, with anchored ones highlighted.
      const segW = sp.segW ?? 8;
      const segH = sp.segH ?? 1;
      const hullPts = hullRect(sp.width, sp.height, segW, segH);
      const anchorSet = new Set(
        Array.isArray(sp.anchors) ? sp.anchors : rectAnchorIndices(segW, segH, sp.anchors ?? 'corners'),
      );
      const rot = sp.rotation ?? 0;
      const rc = Math.cos(rot), rs = Math.sin(rot);
      ctx.strokeStyle = '#0f1629';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < hullPts.length; i++) {
        const p = hullPts[i];
        const wx = sp.x + p.x * rc - p.y * rs;
        const wy = sp.y + p.x * rs + p.y * rc;
        const isAnchor = anchorSet.has(i);
        ctx.fillStyle = isAnchor ? '#ffcc55' : '#88c0ff';
        ctx.beginPath();
        ctx.arc(wx, wy, isAnchor ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Platforms
    for (const p of state.level.platforms) {
      const selected = state.selectedElement?.type === 'platform' && state.selectedElement.id === p.id;
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.rotation) ctx.rotate(p.rotation);
      ctx.fillStyle = selected ? '#4a6a8a' : PLATFORM_COLOR;
      ctx.strokeStyle = selected ? '#8ab4f8' : PLATFORM_BORDER;
      ctx.lineWidth = selected ? 3 : 2;
      ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
      ctx.strokeRect(-p.width / 2, -p.height / 2, p.width, p.height);
      ctx.restore();
    }

    // Spikes
    for (const spike of state.level.spikes ?? []) {
      const selected = state.selectedElement?.type === 'spike' && state.selectedElement.id === spike.id;
      ctx.save();
      ctx.translate(spike.x, spike.y);
      if (spike.rotation) ctx.rotate(spike.rotation);

      const hw = spike.width / 2;
      const numTeeth = Math.max(2, Math.floor(spike.width / 30));
      const toothW = spike.width / numTeeth;

      // Base bar
      ctx.fillStyle = '#555';
      ctx.fillRect(-hw, -4, spike.width, 8);

      // Teeth
      ctx.fillStyle = selected ? '#ff4444' : '#cc3333';
      ctx.strokeStyle = selected ? '#ff8888' : '#991111';
      ctx.lineWidth = selected ? 2 : 1.5;
      for (let i = 0; i < numTeeth; i++) {
        const tx = -hw + i * toothW;
        ctx.beginPath();
        ctx.moveTo(tx, 0);
        ctx.lineTo(tx + toothW, 0);
        ctx.lineTo(tx + toothW / 2, -spike.height);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // Selection outline
      if (selected) {
        ctx.strokeStyle = '#ff8888';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(-hw, -spike.height, spike.width, spike.height + 4);
        ctx.setLineDash([]);
      }

      ctx.restore();
    }

    // Spring pads — share the in-game renderer for visual parity.
    for (const sp of state.level.springPads ?? []) {
      const selected = state.selectedElement?.type === 'spring' && state.selectedElement.id === sp.id;
      drawSpring(ctx, sp);
      if (selected) {
        const box = springVisualBox(sp);
        ctx.save();
        ctx.translate(sp.x, sp.y);
        ctx.rotate(sp.rotation);
        ctx.strokeStyle = '#8ab4f8';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // Spawn points
    for (const sp of state.level.spawnPoints) {
      const selected = state.selectedElement?.type === 'spawn' && state.selectedElement.id === sp.id;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = sp.type === 'player' ? (selected ? '#5a9' : '#398') : '#963';
      ctx.fill();
      ctx.strokeStyle = selected ? '#fff' : '#666';
      ctx.lineWidth = selected ? 3 : 1;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', sp.x, sp.y);
    }

    // NPC blobs
    for (const npc of state.level.npcBlobs) {
      const selected = state.selectedElement?.type === 'npc' && state.selectedElement.id === npc.id;
      ctx.beginPath();
      ctx.arc(npc.x, npc.y, 24, 0, Math.PI * 2);
      ctx.fillStyle = selected ? 'rgba(200, 150, 255, 0.6)' : 'rgba(150, 100, 200, 0.5)';
      ctx.fill();
      ctx.strokeStyle = selected ? '#fff' : '#888';
      ctx.lineWidth = selected ? 3 : 1;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(npc.hullPreset.slice(0, 4), npc.x, npc.y);
    }

    // Trigger areas (behind powerups). Visual count = how many actions subscribe to this trigger.
    const triggerToActionCount = new Map<string, number>();
    for (const action of state.level.actions ?? []) {
      for (const tid of action.sourceTriggerIds) {
        triggerToActionCount.set(tid, (triggerToActionCount.get(tid) ?? 0) + 1);
      }
    }
    for (const trig of state.level.triggers ?? []) {
      const selected = state.selectedElement?.type === 'trigger' && state.selectedElement.id === trig.id;
      ctx.save();
      ctx.translate(trig.x, trig.y);
      ctx.rotate(trig.rotation);
      const hw = trig.width / 2;
      const hh = trig.height / 2;
      ctx.fillStyle = selected ? '#3a7e3a' : '#345';
      ctx.strokeStyle = selected ? '#9fffa0' : '#789';
      ctx.lineWidth = selected ? 3 : 2;
      ctx.beginPath();
      ctx.roundRect(-hw, -hh, trig.width, trig.height, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = selected ? '#5ec85e' : '#7ad27a';
      ctx.beginPath();
      ctx.roundRect(-hw + 4, -hh + 1, trig.width - 8, trig.height - 5, 3);
      ctx.fill();
      const count = triggerToActionCount.get(trig.id) ?? 0;
      if (count > 0) {
        ctx.fillStyle = '#fff';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`→ ${count}`, 0, -hh - 8);
      }
      if ((trig.chargeSeconds ?? 0) > 0) {
        ctx.fillStyle = '#ffd84a';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${trig.chargeSeconds}s`, 0, hh + 10);
      }
      ctx.restore();
    }

    // PointShapes
    for (const ps of state.level.pointShapes ?? []) {
      const selectedShape = state.selectedElement?.type === 'pointShape' && state.selectedElement.id === ps.id;
      ctx.save();
      ctx.strokeStyle = selectedShape ? '#aaddff' : '#5588aa';
      ctx.lineWidth = selectedShape ? 3 : 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Point shapes are closed soft-blob hulls; draw the full polygon
      // outline directly from the point ring. (Legacy `ps.edges` is now
      // always empty — the loader rebuilds springs from the closed hull
      // via `addBlobFromHull`, so edges-as-data is vestigial.)
      if (ps.points.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(ps.points[0].x, ps.points[0].y);
        for (let i = 1; i < ps.points.length; i++) {
          ctx.lineTo(ps.points[i].x, ps.points[i].y);
        }
        if (ps.points.length > 2) ctx.closePath();
        ctx.stroke();
      }
      for (let i = 0; i < ps.points.length; i++) {
        const pt = ps.points[i];
        const vertexSelected = state.selectedElement?.type === 'pointShapeVertex'
          && state.selectedElement.id === ps.id
          && state.selectedElement.pointIndex === i;
        ctx.fillStyle = pt.anchored ? '#ffcc55' : '#88c0ff';
        ctx.strokeStyle = vertexSelected ? '#fff' : '#0f1629';
        ctx.lineWidth = vertexSelected ? 3 / state.zoom : 2 / state.zoom;
        const r = (pt.anchored ? 13 : 11) + (vertexSelected ? 3 : 0);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Draft PointShape preview
    if (state.draftPointShape) {
      const draft = state.draftPointShape;
      ctx.save();
      ctx.strokeStyle = '#aaff88';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      for (let i = 0; i < draft.points.length - 1; i++) {
        const a = draft.points[i];
        const b = draft.points[i + 1];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // Closing-edge hint: once the user has ≥3 points the shape is a valid
      // soft-blob hull; show the implicit close so it reads as one.
      if (draft.points.length >= 3) {
        ctx.save();
        ctx.strokeStyle = 'rgba(170, 255, 136, 0.4)';
        ctx.setLineDash([4, 6]);
        const first = draft.points[0];
        const last = draft.points[draft.points.length - 1];
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(first.x, first.y);
        ctx.stroke();
        ctx.restore();
      }
      // Ghost line from last point to cursor (snapped to 15° if Shift held).
      if (draft.points.length > 0) {
        const last = draft.points[draft.points.length - 1];
        const ghost = state.angleSnapHeld
          ? snapToAngle(last.x, last.y, state.cursorX, state.cursorY)
          : { x: state.cursorX, y: state.cursorY };
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(ghost.x, ghost.y);
        ctx.stroke();
        if (state.angleSnapHeld) {
          // Mark the snapped endpoint so the user sees where the click will land.
          ctx.fillStyle = '#aaff88';
          ctx.beginPath();
          ctx.arc(ghost.x, ghost.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.setLineDash([]);
      for (let i = 0; i < draft.points.length; i++) {
        const pt = draft.points[i];
        ctx.fillStyle = pt.anchored ? '#ffcc55' : '#aaff88';
        ctx.strokeStyle = '#0f1629';
        ctx.lineWidth = 2 / state.zoom;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Chains — straight line between resolved endpoints. Anchored ends draw
    // a pinned dot, blob-anchored ends draw a hollow ring.
    const drawAnchorMarker = (
      ref: { kind: 'fixed' } | { kind: 'blob' },
      x: number, y: number,
    ) => {
      ctx.save();
      ctx.strokeStyle = '#0f1629';
      ctx.lineWidth = 2 / state.zoom;
      if (ref.kind === 'fixed') {
        ctx.fillStyle = '#ffcc55';
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = '#88c0ff';
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };

    for (const chain of state.level.chains ?? []) {
      const a = state.anchorPosition(chain.endpointA);
      const b = state.anchorPosition(chain.endpointB);
      if (!a || !b) continue;
      const selected = state.selectedElement?.type === 'chain' && state.selectedElement.id === chain.id;
      ctx.save();
      ctx.strokeStyle = selected ? '#ffd84a' : '#c0a070';
      ctx.lineWidth = selected ? 4 : 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
      drawAnchorMarker(chain.endpointA, a.x, a.y);
      drawAnchorMarker(chain.endpointB, b.x, b.y);
    }

    // Chain draft preview: first endpoint placed → ghost line to cursor.
    if (state.draftChain && state.draftChain.endpointA) {
      const a = state.anchorPosition(state.draftChain.endpointA);
      if (a) {
        ctx.save();
        ctx.strokeStyle = '#ffd84a';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(state.cursorX, state.cursorY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        drawAnchorMarker(state.draftChain.endpointA, a.x, a.y);
      }
    }

    // Helpers to resolve a target's source (closed) position and draw the right end ghost.
    const shapeCentroid = (shapeId: string): { x: number; y: number } | null => {
      const shape = (state.level.pointShapes ?? []).find(s => s.id === shapeId);
      if (!shape || shape.points.length === 0) return null;
      let sx = 0, sy = 0;
      for (const p of shape.points) { sx += p.x; sy += p.y; }
      return { x: sx / shape.points.length, y: sy / shape.points.length };
    };
    const sourcePos = (t: ActionTarget): { x: number; y: number } | null => {
      if (t.kind === 'shapePoint') {
        const shape = (state.level.pointShapes ?? []).find(s => s.id === t.shapeId);
        const pt = shape?.points[t.pointIndex];
        return pt ? { x: pt.x, y: pt.y } : null;
      }
      if (t.kind === 'rotateShape' || t.kind === 'moveShape') {
        return shapeCentroid(t.shapeId);
      }
      if (t.kind === 'spike') {
        const spike = (state.level.spikes ?? []).find(s => s.id === t.spikeId);
        return spike ? { x: spike.x, y: spike.y } : null;
      }
      const plat = state.level.platforms.find(p => p.id === t.platformId);
      return plat ? { x: plat.x, y: plat.y } : null;
    };
    /** Compact rotation badge ("↻ 90°") drawn near the ghost in world
     *  coords so the user can read the rotation magnitude at a glance.
     *  `deltaRad` is the rotation the action ADDS to the closed-pose
     *  rotation (i.e. 0 means "no rotation animation"). */
    const drawRotationBadge = (cx: number, cy: number, deltaRad: number) => {
      if (Math.abs(deltaRad) < 0.001) return;
      // Normalise to (-180°..180°] so the label reads naturally for both
      // directions (-90° = quarter-turn CCW, 90° = quarter-turn CW).
      let d = (deltaRad * 180 / Math.PI) % 360;
      if (d > 180) d -= 360;
      if (d <= -180) d += 360;
      const text = `↻ ${Math.round(d)}°`;
      ctx.save();
      ctx.font = `${11 / state.zoom}px sans-serif`;
      const padX = 4 / state.zoom;
      const padY = 2 / state.zoom;
      ctx.textBaseline = 'top';
      const w = ctx.measureText(text).width;
      const x = cx + 8 / state.zoom;
      const y = cy + 8 / state.zoom;
      ctx.fillStyle = 'rgba(20, 30, 50, 0.92)';
      ctx.fillRect(x, y, w + padX * 2, 14 / state.zoom + padY);
      ctx.strokeStyle = ctx.fillStyle as string;
      ctx.lineWidth = 1 / state.zoom;
      ctx.fillStyle = '#ffd6ff';
      ctx.fillText(text, x + padX, y + padY);
      ctx.restore();
    };

    const drawEndGhost = (t: ActionTarget) => {
      if (t.kind === 'shapePoint') {
        ctx.beginPath();
        ctx.arc(t.endX, t.endY, 7, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      if (t.kind === 'moveShape') {
        // Draw the rest hull translated to the open-pose centroid (endX/endY).
        const shape = (state.level.pointShapes ?? []).find(s => s.id === t.shapeId);
        const c = shapeCentroid(t.shapeId);
        if (!shape || !c || shape.points.length < 2) return;
        const ddx = t.endX - c.x, ddy = t.endY - c.y;
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        for (let i = 0; i < shape.points.length; i++) {
          const wx = shape.points[i].x + ddx, wy = shape.points[i].y + ddy;
          if (i === 0) ctx.moveTo(wx, wy); else ctx.lineTo(wx, wy);
        }
        ctx.closePath();
        ctx.stroke();
        // Solid dot at the destination centroid (the draggable handle).
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(t.endX, t.endY, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
      }
      if (t.kind === 'rotateShape') {
        // Draw the soft body's REST hull rotated by endRotation around its
        // centroid — visual preview of where the rotation will end up.
        const shape = (state.level.pointShapes ?? []).find(s => s.id === t.shapeId);
        const c = shapeCentroid(t.shapeId);
        if (!shape || !c || shape.points.length < 2) return;
        const cos = Math.cos(t.endRotation);
        const sin = Math.sin(t.endRotation);
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        for (let i = 0; i < shape.points.length; i++) {
          const p = shape.points[i];
          const ox = p.x - c.x, oy = p.y - c.y;
          const wx = c.x + ox * cos - oy * sin;
          const wy = c.y + ox * sin + oy * cos;
          if (i === 0) ctx.moveTo(wx, wy); else ctx.lineTo(wx, wy);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.restore();
        drawRotationBadge(c.x, c.y, t.endRotation);
        return;
      }
      if (t.kind === 'spike') {
        // Ghost of the spike teeth at the open pose (endX/endY = base).
        const spike = (state.level.spikes ?? []).find(s => s.id === t.spikeId);
        if (!spike) return;
        const endRot = t.endRotation ?? spike.rotation;
        const hw = spike.width / 2;
        const numTeeth = Math.max(2, Math.floor(spike.width / 30));
        const toothW = spike.width / numTeeth;
        ctx.save();
        ctx.translate(t.endX, t.endY);
        ctx.rotate(endRot);
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        for (let i = 0; i < numTeeth; i++) {
          const tx = -hw + i * toothW;
          ctx.moveTo(tx, 0);
          ctx.lineTo(tx + toothW, 0);
          ctx.lineTo(tx + toothW / 2, -spike.height);
          ctx.closePath();
        }
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.stroke();
        ctx.restore();
        if (t.endRotation !== undefined) drawRotationBadge(t.endX, t.endY, t.endRotation - spike.rotation);
        return;
      }
      const plat = state.level.platforms.find(p => p.id === t.platformId);
      if (!plat) return;
      // Use the target's endRotation if set (animated rotation); otherwise
      // the platform's closed-pose rotation.
      const endRot = t.endRotation ?? plat.rotation;
      ctx.save();
      ctx.translate(t.endX, t.endY);
      ctx.rotate(endRot);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(-plat.width / 2, -plat.height / 2, plat.width, plat.height);
      ctx.globalAlpha = 1;
      ctx.strokeRect(-plat.width / 2, -plat.height / 2, plat.width, plat.height);
      ctx.restore();
      // Show the DELTA from the platform's closed-pose rotation — that's
      // what the action will animate. When endRotation is absent (pure
      // translation), delta is 0 and the badge is suppressed.
      if (t.endRotation !== undefined) {
        drawRotationBadge(t.endX, t.endY, t.endRotation - plat.rotation);
      }
    };

    // Compute the link-highlight set for the currently selected entity:
    // - selected trigger → highlight all actions it fires
    // - selected action  → highlight all triggers in sourceTriggerIds
    // Used to draw a cyan ring around the linked counterparts so the user
    // can see the trigger ↔ action wiring at a glance.
    const linkedActions = new Set<string>();
    const linkedTriggers = new Set<string>();
    if (state.selectedElement?.type === 'trigger') {
      const tid = state.selectedElement.id;
      for (const a of state.level.actions ?? []) {
        if (a.sourceTriggerIds.includes(tid)) linkedActions.add(a.id);
      }
    } else if (state.selectedElement?.type === 'action') {
      const a = (state.level.actions ?? []).find(x => x.id === state.selectedElement!.id);
      if (a) for (const tid of a.sourceTriggerIds) linkedTriggers.add(tid);
    }

    // Actions — render arrows from each target's source to its endXY.
    for (const action of state.level.actions ?? []) {
      const selected = state.selectedElement?.type === 'action' && state.selectedElement.id === action.id;
      const linkedFromTrigger = linkedActions.has(action.id);
      ctx.save();
      ctx.strokeStyle = selected ? '#ffaaff' : '#9966cc';
      ctx.fillStyle = selected ? '#ffaaff' : '#9966cc';
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.setLineDash([4, 4]);
      for (const t of action.targets) {
        const src = sourcePos(t);
        if (!src) continue;
        // rotateShape has no endX/endY — only draw the rotated ghost hull,
        // skip the arrow. Other kinds (shapePoint, platform) draw the arrow.
        if (t.kind !== 'rotateShape') {
          ctx.beginPath();
          ctx.moveTo(src.x, src.y);
          ctx.lineTo(t.endX, t.endY);
          ctx.stroke();
        }
        drawEndGhost(t);
      }
      ctx.setLineDash([]);
      // Link-highlight: cyan ring around every target ghost when this
      // action is wired to the currently-selected trigger.
      if (linkedFromTrigger) {
        ctx.strokeStyle = '#5ef0ff';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 4]);
        for (const t of action.targets) {
          if (t.kind === 'shapePoint') {
            ctx.beginPath();
            ctx.arc(t.endX, t.endY, 14, 0, Math.PI * 2);
            ctx.stroke();
          } else if (t.kind === 'platform') {
            const plat = state.level.platforms.find(p => p.id === t.platformId);
            if (!plat) continue;
            const endRot = t.endRotation ?? plat.rotation;
            ctx.save();
            ctx.translate(t.endX, t.endY);
            ctx.rotate(endRot);
            ctx.strokeRect(-plat.width / 2 - 4, -plat.height / 2 - 4, plat.width + 8, plat.height + 8);
            ctx.restore();
          } else if (t.kind === 'rotateShape') {
            const c = shapeCentroid(t.shapeId);
            if (c) {
              ctx.beginPath();
              ctx.arc(c.x, c.y, 32, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // Link-highlight pass for triggers: cyan ring around each trigger
    // wired to the currently-selected action.
    if (linkedTriggers.size > 0) {
      ctx.save();
      ctx.strokeStyle = '#5ef0ff';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      for (const trig of state.level.triggers ?? []) {
        if (!linkedTriggers.has(trig.id)) continue;
        ctx.save();
        ctx.translate(trig.x, trig.y);
        ctx.rotate(trig.rotation);
        ctx.strokeRect(-trig.width / 2 - 4, -trig.height / 2 - 4, trig.width + 8, trig.height + 8);
        ctx.restore();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Draft Action preview
    if (state.draftAction) {
      const dt = state.draftAction;
      ctx.save();
      ctx.strokeStyle = '#ffccff';
      ctx.fillStyle = '#ffccff';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      for (const t of dt.targets) {
        const src = sourcePos(t);
        if (!src) continue;
        if (dt.phase === 'placeEnds') {
          if (t.kind !== 'rotateShape') {
            ctx.beginPath();
            ctx.moveTo(src.x, src.y);
            ctx.lineTo(t.endX, t.endY);
            ctx.stroke();
          }
          drawEndGhost(t);
        }
        // Highlight selected source
        ctx.beginPath();
        ctx.arc(src.x, src.y, 11, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Powerup spawns
    for (const pu of state.level.powerupSpawns ?? []) {
      const selected = state.selectedElement?.type === 'powerup' && state.selectedElement.id === pu.id;
      ctx.beginPath();
      ctx.arc(pu.x, pu.y, 16, 0, Math.PI * 2);
      ctx.fillStyle = selected ? 'rgba(255, 220, 50, 0.7)' : 'rgba(200, 180, 30, 0.5)';
      ctx.fill();
      ctx.strokeStyle = selected ? '#fff' : '#aa8';
      ctx.lineWidth = selected ? 3 : 1.5;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u2605', pu.x, pu.y);
    }

    // Sprite instances \u2014 draw the sprite image when available, fall back to
    // a placeholder rectangle when not. Overlay the auto-traced collision
    // hull from the registry so authors can see what they'll be colliding
    // with. Editing the hull itself is deferred to a follow-up pass.
    for (const inst of state.level.sprites ?? []) {
      const selected = state.selectedElement?.type === 'sprite' && state.selectedElement.id === inst.id;
      const sp = getSprite(inst.spriteId);
      const scale = inst.scale ?? 1;
      if (sp) {
        drawSprite(ctx, sp, inst.x, inst.y, inst.rotation, scale, 1);
      } else {
        ctx.save();
        ctx.translate(inst.x, inst.y);
        ctx.rotate(inst.rotation);
        ctx.fillStyle = 'rgba(180, 100, 220, 0.4)';
        ctx.strokeStyle = '#c77dff';
        ctx.lineWidth = 1.5;
        ctx.fillRect(-30, -30, 60, 60);
        ctx.strokeRect(-30, -30, 60, 60);
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(inst.spriteId, 0, 0);
        ctx.restore();
      }
      // Collision-hull overlay when selected
      if (selected && sp) {
        ctx.save();
        ctx.translate(inst.x, inst.y);
        ctx.rotate(inst.rotation);
        ctx.scale(scale, scale);
        ctx.strokeStyle = 'rgba(199, 125, 255, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        const shape = sp.def.shape;
        if (shape.kind === 'polygon' && shape.points.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(shape.points[0][0], shape.points[0][1]);
          for (let i = 1; i < shape.points.length; i++) {
            ctx.lineTo(shape.points[i][0], shape.points[i][1]);
          }
          ctx.closePath();
          ctx.stroke();
        } else if (shape.kind === 'pointShape') {
          ctx.beginPath();
          for (const e of shape.edges) {
            const a = shape.points[e.a];
            const b = shape.points[e.b];
            if (!a || !b) continue;
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#c77dff';
          for (const p of shape.points) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (shape.kind === 'circle') {
          ctx.beginPath();
          ctx.arc(0, 0, shape.radius, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // Resize handles on selected rect element
    if (state.isSelectedRect()) {
      const data = state.findSelectedData();
      if (data && data.width) {
        const rotation = data.rotation ?? 0;
        const hw = data.width / 2;
        const hh = data.height / 2;
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        const hs = 6 / state.zoom; // handle size in world units

        const isSpike = state.selectedElement?.type === 'spike';
        const handles = isSpike
          ? [
              { lx: hw, ly: -data.height / 2 },
              { lx: -hw, ly: -data.height / 2 },
              { lx: 0, ly: -data.height },
              { lx: 0, ly: 0 },
            ]
          : [
              { lx: hw, ly: 0 },
              { lx: -hw, ly: 0 },
              { lx: 0, ly: -hh },
              { lx: 0, ly: hh },
            ];

        for (const h of handles) {
          const hx = data.x + h.lx * cos - h.ly * sin;
          const hy = data.y + h.lx * sin + h.ly * cos;
          ctx.fillStyle = '#8ab4f8';
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1 / state.zoom;
          ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
          ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
        }
      }
    }

    // Multi-select halos
    for (const el of state.multiSelect) {
      const prev = state.selectedElement;
      state.selectedElement = el;
      const d = state.findSelectedData();
      state.selectedElement = prev;
      if (!d || typeof d.x !== 'number' || typeof d.y !== 'number') continue;
      const w = (d.width ?? 24);
      const h = (d.height ?? 24);
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rotation ?? 0);
      ctx.strokeStyle = '#ffb84a';
      ctx.lineWidth = 2 / state.zoom;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(-w / 2 - 4, -h / 2 - 4, w + 8, h + 8);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Blob reference ghosts (pinned to cursor world position)
    const ghosts = state.blobGhosts;
    if (ghosts.normal || ghosts.large || ghosts.crouching) {
      const gx = state.cursorX;
      const gy = state.cursorY;
      ctx.save();
      ctx.lineWidth = 2 / state.zoom;
      if (ghosts.large) {
        const r = BLOB_RADIUS * BLOB_EXPAND_MAX_SCALE;
        ctx.fillStyle = 'rgba(80, 220, 255, 0.10)';
        ctx.strokeStyle = 'rgba(80, 220, 255, 0.7)';
        ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (ghosts.normal) {
        ctx.fillStyle = 'rgba(120, 255, 160, 0.15)';
        ctx.strokeStyle = 'rgba(120, 255, 160, 0.85)';
        ctx.beginPath(); ctx.arc(gx, gy, BLOB_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (ghosts.crouching) {
        const rx = BLOB_RADIUS * (1 + BLOB_SQUASH_X_AMOUNT);
        const ry = BLOB_RADIUS * (1 - BLOB_SQUASH_Y_AMOUNT);
        ctx.fillStyle = 'rgba(255, 200, 120, 0.15)';
        ctx.strokeStyle = 'rgba(255, 200, 120, 0.85)';
        ctx.beginPath(); ctx.ellipse(gx, gy, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }

    // ── Rotation-target preview highlight ────────────────────────────────
    // While in the Action tool with Option/Alt/Ctrl held, outline whatever
    // the user's cursor is over IF it would be turned into a rotation
    // target on click. Removes the guessing game ("click the platform or
    // the pink ghost?"). Point-shape hulls take priority over platforms
    // when they overlap, matching the modifier-click handler order.
    if (state.selectedTool === 'action' && state.modifierHeld) {
      let target: { kind: 'shape' | 'platform'; bounds: () => void; label: string } | null = null;
      for (const ps of state.level.pointShapes ?? []) {
        if (ps.points.length >= 3 && pointInPolygonPts(state.cursorX, state.cursorY, ps.points)) {
          target = {
            kind: 'shape',
            label: 'Rotate this soft body',
            bounds: () => {
              ctx.beginPath();
              ctx.moveTo(ps.points[0].x, ps.points[0].y);
              for (let i = 1; i < ps.points.length; i++) ctx.lineTo(ps.points[i].x, ps.points[i].y);
              ctx.closePath();
            },
          };
          break;
        }
      }
      if (!target) {
        for (const plat of state.level.platforms) {
          if (Math.abs(state.cursorX - plat.x) <= plat.width / 2
              && Math.abs(state.cursorY - plat.y) <= plat.height / 2) {
            target = {
              kind: 'platform',
              label: 'Rotate this platform',
              bounds: () => {
                ctx.save();
                ctx.translate(plat.x, plat.y);
                ctx.rotate(plat.rotation);
                ctx.beginPath();
                ctx.rect(-plat.width / 2, -plat.height / 2, plat.width, plat.height);
                ctx.restore();
              },
            };
            break;
          }
        }
      }
      if (target) {
        ctx.save();
        ctx.strokeStyle = '#5ef0ff';
        ctx.lineWidth = 4 / state.zoom; // keep highlight ~constant pixel width at any zoom
        ctx.setLineDash([10 / state.zoom, 6 / state.zoom]);
        target.bounds();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        // Small in-world label near the cursor explaining what'll happen.
        ctx.save();
        ctx.font = `${12 / state.zoom}px sans-serif`;
        const padX = 6 / state.zoom;
        const padY = 4 / state.zoom;
        ctx.textBaseline = 'top';
        const text = `↻ ${target.label}`;
        const textW = ctx.measureText(text).width;
        const bx = state.cursorX + 14 / state.zoom;
        const by = state.cursorY + 14 / state.zoom;
        ctx.fillStyle = 'rgba(20, 30, 50, 0.92)';
        ctx.fillRect(bx, by, textW + padX * 2, 16 / state.zoom + padY);
        ctx.strokeStyle = '#5ef0ff';
        ctx.lineWidth = 1.5 / state.zoom;
        ctx.strokeRect(bx, by, textW + padX * 2, 16 / state.zoom + padY);
        ctx.fillStyle = '#5ef0ff';
        ctx.fillText(text, bx + padX, by + padY);
        ctx.restore();
      }
    }

    // ── ID label pass ────────────────────────────────────────────────
    // Single pass that draws each entity's id over the top of everything
    // else in world space. Skipped when state.showIds is false. Font is
    // deliberately LARGER than the existing trigger/action mini-labels so
    // names are readable without zooming in; scaled inverse to the camera
    // zoom so the displayed size is constant in pixels regardless of the
    // user's zoom level.
    if (state.showIds) {
      const fontPx = 14; // screen-space size; scaled by 1/zoom to keep constant
      ctx.font = `bold ${fontPx / state.zoom}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const drawIdLabel = (x: number, y: number, id: string, color = '#ffe88a') => {
        const padX = 5 / state.zoom;
        const padY = 2 / state.zoom;
        const w = ctx.measureText(id).width;
        const h = fontPx / state.zoom;
        ctx.fillStyle = 'rgba(10, 10, 20, 0.88)';
        ctx.fillRect(x - w / 2 - padX, y - h / 2 - padY, w + padX * 2, h + padY * 2);
        ctx.fillStyle = color;
        ctx.fillText(id, x, y);
      };
      for (const p of state.level.platforms) drawIdLabel(p.x, p.y, p.id);
      for (const s of state.level.springPads ?? []) drawIdLabel(s.x, s.y, s.id, '#ffd066');
      for (const s of state.level.spikes ?? []) drawIdLabel(s.x, s.y - s.height / 2 - 10 / state.zoom, s.id, '#ff8a8a');
      for (const z of state.level.goalZones ?? []) drawIdLabel(z.x, z.y, z.id, '#9fffa0');
      for (const z of state.level.hillZones ?? []) drawIdLabel(z.x, z.y, z.id, '#ffd84a');
      for (const z of state.level.deathZones ?? []) drawIdLabel(z.x, z.y, z.id, '#ff8080');
      for (const z of state.level.gravityZones ?? []) drawIdLabel(z.x, z.y + 22 / state.zoom, z.id, '#d6a0ff');
      for (const z of state.level.triggers ?? []) drawIdLabel(z.x, z.y - z.height / 2 - 22 / state.zoom, z.id, '#bdf6c5');
      for (const sp of state.level.spawnPoints) drawIdLabel(sp.x, sp.y + 26 / state.zoom, sp.id, '#aaccff');
      for (const n of state.level.npcBlobs) drawIdLabel(n.x, n.y + 26 / state.zoom, n.id, '#c0e0ff');
      for (const pu of state.level.powerupSpawns ?? []) drawIdLabel(pu.x, pu.y + 26 / state.zoom, pu.id, '#ffe066');
      for (const sp of state.level.softPlatforms ?? []) drawIdLabel(sp.x, sp.y, sp.id, '#aaccdd');
      for (const ps of state.level.pointShapes ?? []) {
        // Centroid of the rest hull.
        let cx = 0, cy = 0;
        for (const pt of ps.points) { cx += pt.x; cy += pt.y; }
        const n = Math.max(1, ps.points.length);
        drawIdLabel(cx / n, cy / n, ps.id, '#aaddff');
      }
      for (const inst of state.level.sprites ?? []) drawIdLabel(inst.x, inst.y, inst.id, '#dbb6ff');
      for (const c of state.level.chains ?? []) {
        // Midpoint of the chain — average of the two endpoint anchor world
        // positions (use blob centroid when endpoint is a blob ref).
        const ep = (ref: { kind: 'fixed'; x: number; y: number } | { kind: 'blob'; entity: 'npc' | 'softPlatform' | 'pointShape'; id: string }): { x: number; y: number } | null => {
          if (ref.kind === 'fixed') return { x: ref.x, y: ref.y };
          if (ref.entity === 'npc') {
            const npc = state.level.npcBlobs.find(n => n.id === ref.id);
            return npc ? { x: npc.x, y: npc.y } : null;
          }
          if (ref.entity === 'softPlatform') {
            const sp = (state.level.softPlatforms ?? []).find(s => s.id === ref.id);
            return sp ? { x: sp.x, y: sp.y } : null;
          }
          const ps = (state.level.pointShapes ?? []).find(s => s.id === ref.id);
          if (!ps) return null;
          let cx = 0, cy = 0;
          for (const pt of ps.points) { cx += pt.x; cy += pt.y; }
          return { x: cx / Math.max(1, ps.points.length), y: cy / Math.max(1, ps.points.length) };
        };
        const a = ep(c.endpointA);
        const b = ep(c.endpointB);
        if (a && b) drawIdLabel((a.x + b.x) / 2, (a.y + b.y) / 2, c.id, '#ffd0a0');
      }
      // Actions — anchor at the first target's endpoint (or source for
      // rotateShape) so the id sits near where the action visually starts.
      for (const action of state.level.actions ?? []) {
        const first = action.targets[0];
        if (!first) continue;
        let x = 0, y = 0;
        if (first.kind === 'platform') { x = first.endX; y = first.endY; }
        else if (first.kind === 'shapePoint') { x = first.endX; y = first.endY; }
        else if (first.kind === 'rotateShape') {
          const ps = (state.level.pointShapes ?? []).find(s => s.id === first.shapeId);
          if (!ps) continue;
          for (const pt of ps.points) { x += pt.x; y += pt.y; }
          const n = Math.max(1, ps.points.length);
          x /= n; y /= n;
        }
        drawIdLabel(x, y - 36 / state.zoom, `${action.id} (${action.mode})`, '#ffaaff');
      }
    }

    ctx.restore();

    // HUD: show current tool + hotkey hint
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const hasShapes = (state.level.pointShapes ?? []).length > 0;
    const hasPlatforms = state.level.platforms.length > 0;
    const shapeAdd = state.actionPerVertex ? 'click vertices' : 'click a shape to move the whole thing';
    const actionHint = state.selectedTool === 'action' && !state.draftAction
      ? (hasShapes || hasPlatforms
          ? ` | action: ${shapeAdd} or a platform to add · ${ALT_LABEL}-click a soft body or platform to rotate it`
          : ` | action: needs a Shape or Platform first`)
      : '';
    const draftHint = state.draftPointShape
      ? ` | shape: ${state.draftPointShape.points.length} pts · Shift=15° snap · ${ALT_LABEL}=anchor · Enter/C: commit · Esc: cancel`
      : state.draftAction
        ? state.draftAction.phase === 'pickPoints'
          ? ` | action: ${state.draftAction.targets.length} targets · ${shapeAdd}/platform to add · ${ALT_LABEL}-click to rotate · Enter: next · Esc: cancel`
          : ` | action: ${state.draftAction.targets.length} targets · drag ghosts to position · ${ALT_LABEL}-click to add rotation · panel: tune end · Enter: commit · Esc: cancel`
        : actionHint;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(8, h - 28, Math.min(1100, 240 + draftHint.length * 6), 22);
    ctx.fillStyle = '#aaa';
    ctx.fillText(`Tool: ${state.selectedTool} | R: rotate | 1-9,Q,W,E: tools${draftHint}`, 14, h - 17);

    // Top-of-canvas banner during action drafting — bigger, more obvious
    // than the bottom-line status. Tells the user exactly what to do next.
    if (state.draftAction) {
      const banner = state.draftAction.phase === 'pickPoints'
        ? `Drafting Action — click a platform or shape vertex to add it as a target. ${ALT_LABEL}-click a soft body or platform to rotate it. Esc to cancel.`
        : `Drafting Action — drag a dashed ghost to set where each target moves to. Use the side panel to fine-tune position or rotation. Press Enter to commit.`;
      ctx.font = 'bold 13px sans-serif';
      const textW = ctx.measureText(banner).width;
      const padX = 16, padY = 8;
      const bx = (w - textW - padX * 2) / 2;
      const by = 16;
      ctx.fillStyle = 'rgba(60, 30, 90, 0.92)';
      ctx.fillRect(bx, by, textW + padX * 2, 22 + padY);
      ctx.strokeStyle = '#c77dff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, by, textW + padX * 2, 22 + padY);
      ctx.fillStyle = '#fff5e6';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(banner, bx + padX, by + (22 + padY) / 2);
    }
  }, [state]);

  useEffect(() => {
    const loop = () => {
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  const pointerDown = useCallback((p: EditorPointer) => {
    const { sx, sy } = p;
    const { x: wx, y: wy } = screenToWorld(sx, sy);

    // Middle mouse, right click, Space+left, or Shift+left = pan (Godot-style).
    // Shift+left also doubles as multi-select on hits in the select tool, so
    // that path is handled below; we only enter pan mode here when the user
    // is on a non-select tool OR shift-clicked empty space.
    if (p.pan) {
      state.isPanning = true;
      state.panStartX = sx;
      state.panStartY = sy;
      state.panStartCamX = state.panX;
      state.panStartCamY = state.panY;
      return;
    }
    if (p.primary && p.shiftKey && state.selectedTool !== 'select') {
      state.isPanning = true;
      state.panStartX = sx;
      state.panStartY = sy;
      state.panStartCamX = state.panX;
      state.panStartCamY = state.panY;
      return;
    }

    if (state.selectedTool === 'select') {
      // If editing a trigger in placeEnds phase, allow dragging its end ghosts.
      const draftEndIdx = state.hitTestDraftActionEnd(wx, wy);
      if (draftEndIdx !== null) {
        state.draggingActionTarget = draftEndIdx;
        onUpdate();
        return;
      }

      // Check resize handles first
      const handle = state.hitTestHandle(wx, wy);
      if (handle) {
        state.startResize(handle, wx, wy);
        onUpdate();
        return;
      }

      const hit = state.hitTest(wx, wy);
      if (p.shiftKey && hit) {
        // Shift-click on an element: add/remove from multi-select.
        state.toggleMultiSelect(hit);
        onUpdate();
        return;
      }
      if (p.shiftKey && !hit) {
        // Shift-drag on empty space: pan. Same handler as Space+drag.
        state.isPanning = true;
        state.panStartX = sx;
        state.panStartY = sy;
        state.panStartCamX = state.panX;
        state.panStartCamY = state.panY;
        return;
      }
      // Plain click: reset multi-select & set primary selection.
      state.multiSelect = [];
      state.selectedElement = hit;
      if (hit) {
        state.startDrag(wx, wy);
      }
      onUpdate();
    } else if (state.selectedTool === 'pointShape') {
      // Shift = snap angle (from previous point); Alt = anchor the new point.
      let px = wx, py = wy;
      if (p.shiftKey && state.draftPointShape && state.draftPointShape.points.length > 0) {
        const last = state.draftPointShape.points[state.draftPointShape.points.length - 1];
        const snapped = snapToAngle(last.x, last.y, wx, wy);
        px = snapped.x; py = snapped.y;
      }
      state.appendDraftPoint(px, py, p.modifier);
      onUpdate();
    } else if (state.selectedTool === 'chain') {
      state.appendChainEndpoint(wx, wy);
      onUpdate();
    } else if (state.selectedTool === 'action') {
      // Ghost drag takes priority over re-adding a target. Without this, a
      // click on a ghost rectangle that happens to overlap a platform
      // would re-add the platform as a NEW target instead of dragging the
      // existing one.
      if (state.draftAction?.phase === 'placeEnds') {
        const idx = state.hitTestDraftActionEnd(wx, wy);
        if (idx !== null) {
          state.draggingActionTarget = idx;
          onUpdate();
          return;
        }
      }
      // Dragging a ghost of a selected, already-committed action.
      const committedHit = state.hitTestSelectedActionEnd(wx, wy);
      if (committedHit) {
        state.draggingCommittedActionTarget = committedHit;
        onUpdate();
        return;
      }
      // Alt/Option/Ctrl-click on a soft body OR static platform → add a
      // ROTATION target instead of the default behavior.
      if (p.modifier) {
        for (const ps of state.level.pointShapes ?? []) {
          if (ps.points.length >= 3 && pointInPolygonPts(wx, wy, ps.points)) {
            if (!state.draftAction) state.beginDraftAction();
            state.appendActionTargetRotateShape(ps.id);
            onUpdate();
            return;
          }
        }
        for (const plat of state.level.platforms) {
          if (Math.abs(wx - plat.x) <= plat.width / 2 && Math.abs(wy - plat.y) <= plat.height / 2) {
            if (!state.draftAction) state.beginDraftAction();
            state.appendActionTargetRotatePlatform(plat.id);
            onUpdate();
            return;
          }
        }
        for (const s of state.level.spikes ?? []) {
          if (hitSpikeForAction(wx, wy, s)) {
            if (!state.draftAction) state.beginDraftAction();
            state.appendActionTargetRotateSpike(s.id);
            onUpdate();
            return;
          }
        }
      }
      // Add a SHAPE target. Default: click anywhere on a soft body to move the
      // WHOLE shape (one moveShape target). Per-vertex mode: click individual
      // vertices to add shapePoint targets (the old behavior).
      if (state.actionPerVertex) {
        const vhit = state.hitTestPointShapeVertex(wx, wy);
        if (vhit) {
          if (!state.draftAction) state.beginDraftAction();
          state.appendActionTargetAtVertex(vhit.shapeId, vhit.pointIndex);
          onUpdate();
          return;
        }
      } else {
        for (const ps of state.level.pointShapes ?? []) {
          if (ps.points.length >= 3 && pointInPolygonPts(wx, wy, ps.points)) {
            if (!state.draftAction) state.beginDraftAction();
            state.appendActionTargetMoveShape(ps.id);
            onUpdate();
            return;
          }
        }
      }
      for (const plat of state.level.platforms) {
        if (Math.abs(wx - plat.x) <= plat.width / 2 && Math.abs(wy - plat.y) <= plat.height / 2) {
          if (!state.draftAction) state.beginDraftAction();
          state.appendActionTargetAtPlatform(plat.id);
          onUpdate();
          return;
        }
      }
      for (const s of state.level.spikes ?? []) {
        if (hitSpikeForAction(wx, wy, s)) {
          if (!state.draftAction) state.beginDraftAction();
          state.appendActionTargetAtSpike(s.id);
          onUpdate();
          return;
        }
      }
      onUpdate();
    } else {
      const tool = state.selectedTool;
      // Rect-based tools use drag-to-place
      if (tool === 'platform' || tool === 'spike' || tool === 'goalZone' || tool === 'hillZone' || tool === 'deathZone' || tool === 'trigger' || tool === 'softPlatform' || tool === 'gravityZone') {
        state.startPlacement(tool, wx, wy);
      } else {
        switch (tool) {
          case 'spawn': state.addSpawnPoint(wx, wy); break;
          case 'npc': state.addNpcBlob(wx, wy); break;
          case 'powerup': state.addPowerupSpawn(wx, wy); break;
          case 'spring': state.addSpring(wx, wy); break;
          case 'sprite': state.addSpriteInstance(wx, wy); break;
        }
      }
      onUpdate();
    }
  }, [state, screenToWorld, onUpdate]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    pointerDown({
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
      shiftKey: e.shiftKey,
      modifier: isModifierHeld(e),
      pan: e.button === 1 || e.button === 2 || (e.button === 0 && spaceHeldRef.current),
      primary: e.button === 0,
    });
  }, [pointerDown]);

  const pointerMove = useCallback((p: EditorPointer) => {
    const { sx, sy } = p;
    const { x: cwx, y: cwy } = screenToWorld(sx, sy);
    state.cursorX = cwx;
    state.cursorY = cwy;
    // Track Shift for shape-draft angle-snap preview.
    state.angleSnapHeld = p.shiftKey;
    // Track Alt/Option/Ctrl for the action-tool rotation-target highlight.
    state.modifierHeld = p.modifier;

    if (state.draggingActionTarget !== null) {
      state.setDraftActionTargetEnd(state.draggingActionTarget, cwx, cwy);
      return;
    }
    if (state.draggingCommittedActionTarget !== null) {
      const { actionId, index } = state.draggingCommittedActionTarget;
      state.setActionTargetEnd(actionId, index, cwx, cwy);
      return;
    }

    if (state.isPanning) {
      const dx = (sx - state.panStartX) / state.zoom;
      const dy = (sy - state.panStartY) / state.zoom;
      state.panX = state.panStartCamX - dx;
      state.panY = state.panStartCamY - dy;
      return;
    }

    if (state.isPlacing) {
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      state.updatePlacement(wx, wy);
      return;
    }

    if (state.isResizing) {
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      state.resizeSelected(wx, wy);
      return;
    }

    if (state.isDragging) {
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      state.moveSelected(wx, wy);
      return;
    }

    // Update cursor based on handle hover
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (state.selectedTool === 'select' && state.selectedElement) {
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      const handle = state.hitTestHandle(wx, wy);
      if (handle === 'left' || handle === 'right') {
        canvas.style.cursor = 'ew-resize';
      } else if (handle === 'top' || handle === 'bottom') {
        canvas.style.cursor = 'ns-resize';
      } else {
        canvas.style.cursor = 'default';
      }
    } else {
      canvas.style.cursor = state.selectedTool === 'select' ? 'default' : 'crosshair';
    }
  }, [state, screenToWorld]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    pointerMove({
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
      shiftKey: e.shiftKey,
      modifier: isModifierHeld(e),
      pan: false,
      primary: true,
    });
  }, [pointerMove]);

  const pointerUp = useCallback(() => {
    if (state.isPlacing) {
      state.finishPlacement();
      onUpdate();
    }
    if (state.isResizing) {
      state.stopResize();
    }
    if (state.draggingActionTarget !== null) {
      state.draggingActionTarget = null;
    }
    if (state.draggingCommittedActionTarget !== null) {
      state.draggingCommittedActionTarget = null;
    }
    state.stopDrag();
    state.isPanning = false;
  }, [state, onUpdate]);

  const handleMouseUp = pointerUp;

  /** Zoom by `zoomFactor` keeping the world point under (sx, sy) fixed
   *  (Godot-style anchor). Shared by wheel zoom and touch pinch. */
  const applyZoomAt = useCallback((sx: number, sy: number, zoomFactor: number) => {
    const before = screenToWorld(sx, sy);
    const newZoom = Math.max(0.1, Math.min(3, state.zoom * zoomFactor));
    state.zoom = newZoom;
    // Keep the world point under the cursor fixed (Godot-style cursor anchor).
    const after = screenToWorld(sx, sy);
    state.panX += before.x - after.x;
    state.panY += before.y - after.y;
  }, [state, screenToWorld]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // Continuous zoom — exp(deltaY * k) gives smooth, framerate-independent feel.
    // k=0.0015 = ~10% per typical wheel notch, much gentler than the old 0.9/1.1 step.
    applyZoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
  }, [applyZoomAt]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't capture hotkeys when typing in inputs
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.key === 'Shift') {
      if (!state.angleSnapHeld) {
        state.angleSnapHeld = true;
        onUpdate();
      }
      // Don't return — let other Shift+key combos through (Shift+R, etc.).
    }
    if (e.key === 'Alt' || e.key === 'Control') {
      if (!state.modifierHeld) {
        state.modifierHeld = true;
        onUpdate();
      }
    }

    // Space = pan modifier (Godot-style). Don't preventDefault for repeats — keydown fires once.
    if (e.key === ' ' || e.code === 'Space') {
      if (!spaceHeldRef.current) {
        spaceHeldRef.current = true;
        onUpdate();
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      state.deleteSelected();
      onUpdate();
      return;
    }

    // Undo / redo / duplicate (Ctrl/Cmd+Z, +Shift+Z or +Y, +D) are handled by a
    // window-level listener below so they work without canvas focus.
    if (e.ctrlKey || e.metaKey) return;

    // Toggle id labels with I.
    if (e.key === 'i' || e.key === 'I') {
      state.showIds = !state.showIds;
      onUpdate();
      return;
    }

    // Spring size cycle (S / Shift+S)
    if ((e.key === 's' || e.key === 'S') && state.selectedElement?.type === 'spring') {
      state.cycleSpringSize(state.selectedElement.id, e.shiftKey ? -1 : 1);
      onUpdate();
      return;
    }

    // Rotation: R / Shift+R
    if (e.key === 'r' || e.key === 'R') {
      if (state.selectedElement && state.isSelectedRotatable()) {
        const delta = e.shiftKey ? -Math.PI / 12 : Math.PI / 12; // 15 deg
        state.rotateSelected(delta);
        onUpdate();
        return;
      }
    }

    // Enter: commit drafts
    if (e.key === 'Enter') {
      if (state.draftPointShape) {
        state.commitDraftPointShape(false);
        onUpdate();
        return;
      }
      if (state.draftAction) {
        if (state.draftAction.phase === 'pickPoints') {
          state.advanceDraftActionPhase();
        } else {
          state.commitDraftAction();
        }
        onUpdate();
        return;
      }
    }

    // 'c' while drafting a PointShape: close it.
    if ((e.key === 'c' || e.key === 'C') && state.draftPointShape) {
      state.commitDraftPointShape(true);
      onUpdate();
      return;
    }

    // Escape: cancel any draft, then deselect
    if (e.key === 'Escape') {
      if (state.draftPointShape) {
        state.cancelDraftPointShape();
        onUpdate();
        return;
      }
      if (state.draftAction) {
        state.cancelDraftAction();
        onUpdate();
        return;
      }
      if (state.draftChain) {
        state.cancelDraftChain();
        onUpdate();
        return;
      }
      state.selectedElement = null;
      state.multiSelect = [];
      state.selectedTool = 'select';
      onUpdate();
      return;
    }

    // Blob reference ghost toggles
    if (!e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { state.blobGhosts.normal = !state.blobGhosts.normal; onUpdate(); return; }
      if (k === 'n') { state.blobGhosts.large = !state.blobGhosts.large; onUpdate(); return; }
      if (k === 'm') { state.blobGhosts.crouching = !state.blobGhosts.crouching; onUpdate(); return; }
    }

    // Tool hotkeys (1-9, q/w/e)
    const tool = TOOL_HOTKEYS[e.key.toLowerCase()];
    if (tool) {
      // Bail out of any in-progress draft when switching tools.
      if (state.draftPointShape && tool !== 'pointShape') state.cancelDraftPointShape();
      if (state.draftAction && tool !== 'action') state.cancelDraftAction();
      if (state.draftChain && tool !== 'chain') state.cancelDraftChain();
      state.selectedTool = tool;
      if (tool === 'pointShape' && !state.draftPointShape) state.beginDraftPointShape();
      if (tool === 'action' && !state.draftAction) state.beginDraftAction();
      if (tool === 'chain' && !state.draftChain) state.beginDraftChain();
      onUpdate();
    }
  }, [state, onUpdate]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.code === 'Space') {
      if (spaceHeldRef.current) {
        spaceHeldRef.current = false;
        onUpdate();
      }
    }
    if (e.key === 'Shift') {
      if (state.angleSnapHeld) {
        state.angleSnapHeld = false;
        onUpdate();
      }
    }
    if (e.key === 'Alt' || e.key === 'Control') {
      if (state.modifierHeld) {
        state.modifierHeld = false;
        onUpdate();
      }
    }
  }, [state, onUpdate]);

  // Editor-wide shortcuts (undo / redo / duplicate) on `window`, so they work
  // regardless of which element has focus. The canvas's own onKeyDown only
  // fires while the canvas is focused, which is easy to lose (clicking the
  // property panel, a toolbar button, etc.). Using `e.code` keeps these
  // layout/locale-independent. Typing into a field is excluded.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      if (e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) state.redo(); else state.undo();
        onUpdate();
      } else if (e.code === 'KeyY') {
        e.preventDefault();
        state.redo();
        onUpdate();
      } else if (e.code === 'KeyD') {
        e.preventDefault();
        state.duplicateSelected();
        onUpdate();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onUpdate]);

  const cursor = state.isPanning
    ? 'grabbing'
    : (spaceHeldRef.current || state.angleSnapHeld)
      ? 'grab'
      : state.selectedTool === 'select' ? 'default' : 'crosshair';

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        cursor,
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

function drawGrid(ctx: CanvasRenderingContext2D, state: EditorState, canvasW: number, canvasH: number) {
  const gs = state.gridSize;
  if (gs < 5 || state.zoom < 0.15) return;

  const halfW = canvasW / 2 / state.zoom;
  const halfH = canvasH / 2 / state.zoom;
  const left = state.panX - halfW;
  const top = state.panY - halfH;
  const right = state.panX + halfW;
  const bottom = state.panY + halfH;

  const startX = Math.floor(left / gs) * gs;
  const startY = Math.floor(top / gs) * gs;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 0.5;

  for (let x = startX; x <= right; x += gs) {
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let y = startY; y <= bottom; y += gs) {
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
}
