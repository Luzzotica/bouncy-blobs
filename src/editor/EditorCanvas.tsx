import React, { useRef, useEffect, useCallback } from 'react';
import { EditorState, TOOL_HOTKEYS, snapToAngle } from './EditorState';
import { PLATFORM_COLOR, PLATFORM_BORDER, BACKGROUND_COLOR } from '../renderer/colors';
import { drawSpring, PLATE_THICKNESS, PLATE_WIDTH_SCALE } from '../game/springRenderer';
import { getSprite } from '../assets/spriteRegistry';
import { drawSprite } from '../renderer/spriteRenderer';
import { BLOB_RADIUS, BLOB_EXPAND_MAX_SCALE, BLOB_SQUASH_X_AMOUNT, BLOB_SQUASH_Y_AMOUNT } from '../physics/slimeBlob';
import type { SpringPadDef, ActionTarget } from '../levels/types';

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
      // Anchor dots — show 'corners' as a sensible visual default; this is a
      // schematic preview, the actual anchors at runtime depend on def.anchors.
      ctx.fillStyle = '#ffcc55';
      ctx.strokeStyle = '#0f1629';
      ctx.lineWidth = 1.5;
      for (const [cx, cy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
        ctx.beginPath();
        ctx.arc(sp.x + cx, sp.y + cy, 5, 0, Math.PI * 2);
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
      for (const e of ps.edges) {
        const pa = ps.points[e.a];
        const pb = ps.points[e.b];
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
      if (ps.closed && ps.points.length > 2) {
        const pa = ps.points[ps.points.length - 1];
        const pb = ps.points[0];
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
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
        const r = (pt.anchored ? 8 : 6) + (vertexSelected ? 2 : 0);
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
        ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Helpers to resolve a target's source (closed) position and draw the right end ghost.
    const sourcePos = (t: ActionTarget): { x: number; y: number } | null => {
      if (t.kind === 'shapePoint') {
        const shape = (state.level.pointShapes ?? []).find(s => s.id === t.shapeId);
        const pt = shape?.points[t.pointIndex];
        return pt ? { x: pt.x, y: pt.y } : null;
      }
      const plat = state.level.platforms.find(p => p.id === t.platformId);
      return plat ? { x: plat.x, y: plat.y } : null;
    };
    const drawEndGhost = (t: ActionTarget) => {
      if (t.kind === 'shapePoint') {
        ctx.beginPath();
        ctx.arc(t.endX, t.endY, 7, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const plat = state.level.platforms.find(p => p.id === t.platformId);
        if (!plat) return;
        ctx.save();
        ctx.translate(t.endX, t.endY);
        ctx.rotate(plat.rotation);
        ctx.globalAlpha = 0.5;
        ctx.fillRect(-plat.width / 2, -plat.height / 2, plat.width, plat.height);
        ctx.globalAlpha = 1;
        ctx.strokeRect(-plat.width / 2, -plat.height / 2, plat.width, plat.height);
        ctx.restore();
      }
    };

    // Actions — render arrows from each target's source to its endXY.
    for (const action of state.level.actions ?? []) {
      const selected = state.selectedElement?.type === 'action' && state.selectedElement.id === action.id;
      ctx.save();
      ctx.strokeStyle = selected ? '#ffaaff' : '#9966cc';
      ctx.fillStyle = selected ? '#ffaaff' : '#9966cc';
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.setLineDash([4, 4]);
      for (const t of action.targets) {
        const src = sourcePos(t);
        if (!src) continue;
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(t.endX, t.endY);
        ctx.stroke();
        drawEndGhost(t);
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
          ctx.beginPath();
          ctx.moveTo(src.x, src.y);
          ctx.lineTo(t.endX, t.endY);
          ctx.stroke();
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

    ctx.restore();

    // HUD: show current tool + hotkey hint
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const hasShapes = (state.level.pointShapes ?? []).length > 0;
    const hasPlatforms = state.level.platforms.length > 0;
    const actionHint = state.selectedTool === 'action' && !state.draftAction
      ? (hasShapes || hasPlatforms
          ? ` | action: click a shape vertex or platform to add a move target`
          : ` | action: needs a Shape or Platform first`)
      : '';
    const draftHint = state.draftPointShape
      ? ` | shape: ${state.draftPointShape.points.length} pts · Shift=15° snap · Alt=anchor · Enter/C: commit · Esc: cancel`
      : state.draftAction
        ? state.draftAction.phase === 'pickPoints'
          ? ` | action: ${state.draftAction.targets.length} targets · Enter: set end positions · Esc: cancel`
          : ` | action: drag ghost ends to destination · Enter: commit · Esc: cancel`
        : actionHint;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(8, h - 28, Math.min(800, 240 + draftHint.length * 6), 22);
    ctx.fillStyle = '#aaa';
    ctx.fillText(`Tool: ${state.selectedTool} | R: rotate | 1-9,Q,W,E: tools${draftHint}`, 14, h - 17);
  }, [state]);

  useEffect(() => {
    const loop = () => {
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x: wx, y: wy } = screenToWorld(sx, sy);

    // Middle mouse, right click, or Space+left = pan (Godot-style)
    if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceHeldRef.current)) {
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
      if (e.shiftKey && hit) {
        // Shift-click: add/remove from multi-select set without disturbing primary selection.
        state.toggleMultiSelect(hit);
        onUpdate();
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
      if (e.shiftKey && state.draftPointShape && state.draftPointShape.points.length > 0) {
        const last = state.draftPointShape.points[state.draftPointShape.points.length - 1];
        const snapped = snapToAngle(last.x, last.y, wx, wy);
        px = snapped.x; py = snapped.y;
      }
      state.appendDraftPoint(px, py, e.altKey);
      onUpdate();
    } else if (state.selectedTool === 'action') {
      // Pick a shape vertex or a platform to add as a target.
      const vhit = state.hitTestPointShapeVertex(wx, wy);
      if (vhit) {
        if (!state.draftAction) state.beginDraftAction();
        state.appendActionTargetAtVertex(vhit.shapeId, vhit.pointIndex);
        onUpdate();
        return;
      }
      // Pre-empt platform hit-test before falling through.
      for (const plat of state.level.platforms) {
        if (Math.abs(wx - plat.x) <= plat.width / 2 && Math.abs(wy - plat.y) <= plat.height / 2) {
          if (!state.draftAction) state.beginDraftAction();
          state.appendActionTargetAtPlatform(plat.id);
          onUpdate();
          return;
        }
      }
      // Click empty space while in placeEnds: drag an end ghost if hit.
      if (state.draftAction?.phase === 'placeEnds') {
        const idx = state.hitTestDraftActionEnd(wx, wy);
        if (idx !== null) {
          state.draggingActionTarget = idx;
          onUpdate();
          return;
        }
      }
      onUpdate();
    } else {
      const tool = state.selectedTool;
      // Rect-based tools use drag-to-place
      if (tool === 'platform' || tool === 'spike' || tool === 'goalZone' || tool === 'hillZone' || tool === 'deathZone' || tool === 'trigger' || tool === 'softPlatform') {
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

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x: cwx, y: cwy } = screenToWorld(sx, sy);
    state.cursorX = cwx;
    state.cursorY = cwy;
    // Track Shift for shape-draft angle-snap preview.
    state.angleSnapHeld = e.shiftKey;

    if (state.draggingActionTarget !== null) {
      state.setDraftActionTargetEnd(state.draggingActionTarget, cwx, cwy);
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

  const handleMouseUp = useCallback(() => {
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
    state.stopDrag();
    state.isPanning = false;
  }, [state, onUpdate]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    // Continuous zoom — exp(deltaY * k) gives smooth, framerate-independent feel.
    // k=0.0015 = ~10% per typical wheel notch, much gentler than the old 0.9/1.1 step.
    const zoomFactor = Math.exp(-e.deltaY * 0.0015);
    const newZoom = Math.max(0.1, Math.min(3, state.zoom * zoomFactor));
    state.zoom = newZoom;
    // Keep the world point under the cursor fixed (Godot-style cursor anchor).
    const after = screenToWorld(sx, sy);
    state.panX += before.x - after.x;
    state.panY += before.y - after.y;
  }, [state, screenToWorld]);

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

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') { state.undo(); onUpdate(); return; }
      if (e.key === 'y') { state.redo(); onUpdate(); return; }
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        state.duplicateSelected();
        onUpdate();
        return;
      }
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
      state.selectedTool = tool;
      if (tool === 'pointShape' && !state.draftPointShape) state.beginDraftPointShape();
      if (tool === 'action' && !state.draftAction) state.beginDraftAction();
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
  }, [state, onUpdate]);

  const cursor = state.isPanning
    ? 'grabbing'
    : spaceHeldRef.current
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
