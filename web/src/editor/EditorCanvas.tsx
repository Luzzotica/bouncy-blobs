import React, { useRef, useEffect, useCallback } from 'react';
import { EditorState, TOOL_HOTKEYS } from './EditorState';
import { PLATFORM_COLOR, PLATFORM_BORDER, BACKGROUND_COLOR } from '../renderer/colors';

interface EditorCanvasProps {
  state: EditorState;
  onUpdate: () => void;
}

export default function EditorCanvas({ state, onUpdate }: EditorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

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

    // Spring pads
    for (const sp of state.level.springPads ?? []) {
      const selected = state.selectedElement?.type === 'spring' && state.selectedElement.id === sp.id;
      ctx.save();
      ctx.translate(sp.x, sp.y);
      ctx.rotate(sp.rotation);

      const hw = sp.width / 2;
      const hh = sp.height / 2;

      // Coils (zigzag)
      const coilLen = sp.width * 0.8;
      const coilAmp = hh * 0.7;
      const numZigs = 5;
      const zigStep = coilLen / numZigs;
      const coilStartX = -hw * 0.2;

      ctx.strokeStyle = selected ? '#eee' : '#ccc';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(coilStartX, 0);
      for (let i = 0; i < numZigs; i++) {
        const x = coilStartX - (i + 0.5) * zigStep;
        ctx.lineTo(x, (i % 2 === 0 ? -1 : 1) * coilAmp);
      }
      ctx.lineTo(coilStartX - coilLen, 0);
      ctx.stroke();

      // Base plate
      ctx.fillStyle = selected ? '#f0f0f0' : '#e8e8e8';
      ctx.strokeStyle = selected ? '#ccc' : '#aaa';
      ctx.lineWidth = 2;
      ctx.fillRect(coilStartX, -hh, 8, sp.height);
      ctx.strokeRect(coilStartX, -hh, 8, sp.height);

      // Back plate
      ctx.fillStyle = '#888';
      ctx.fillRect(coilStartX - coilLen - 6, -hh * 1.2, 6, sp.height * 1.2);

      // Direction arrow
      ctx.fillStyle = 'rgba(255, 200, 50, 0.7)';
      ctx.beginPath();
      const ax = coilStartX + 20;
      ctx.moveTo(ax + 12, 0);
      ctx.lineTo(ax, -5);
      ctx.lineTo(ax, 5);
      ctx.closePath();
      ctx.fill();

      // Selection outline
      if (selected) {
        ctx.strokeStyle = '#8ab4f8';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(-hw, -hh, sp.width, sp.height);
        ctx.setLineDash([]);
      }

      ctx.restore();
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

        const handles = [
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

    ctx.restore();

    // HUD: show current tool + hotkey hint
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(8, h - 28, 220, 22);
    ctx.fillStyle = '#aaa';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Tool: ${state.selectedTool} | R: rotate | 1-9: tools`, 14, h - 17);
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

    // Middle mouse or right click = pan
    if (e.button === 1 || e.button === 2) {
      state.isPanning = true;
      state.panStartX = sx;
      state.panStartY = sy;
      state.panStartCamX = state.panX;
      state.panStartCamY = state.panY;
      return;
    }

    if (state.selectedTool === 'select') {
      // Check resize handles first
      const handle = state.hitTestHandle(wx, wy);
      if (handle) {
        state.startResize(handle, wx, wy);
        onUpdate();
        return;
      }

      const hit = state.hitTest(wx, wy);
      state.selectedElement = hit;
      if (hit) {
        state.startDrag(wx, wy);
      }
      onUpdate();
    } else {
      const tool = state.selectedTool;
      // Rect-based tools use drag-to-place
      if (tool === 'platform' || tool === 'spring' || tool === 'spike' || tool === 'goalZone' || tool === 'hillZone') {
        state.startPlacement(tool, wx, wy);
      } else {
        switch (tool) {
          case 'spawn': state.addSpawnPoint(wx, wy); break;
          case 'npc': state.addNpcBlob(wx, wy); break;
          case 'powerup': state.addPowerupSpawn(wx, wy); break;
        }
      }
      onUpdate();
    }
  }, [state, screenToWorld, onUpdate]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

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
    state.stopDrag();
    state.isPanning = false;
  }, [state, onUpdate]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    state.zoom = Math.max(0.1, Math.min(3, state.zoom * zoomFactor));
  }, [state]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't capture hotkeys when typing in inputs
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      state.deleteSelected();
      onUpdate();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') { state.undo(); onUpdate(); return; }
      if (e.key === 'y') { state.redo(); onUpdate(); return; }
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

    // Escape: deselect
    if (e.key === 'Escape') {
      state.selectedElement = null;
      state.selectedTool = 'select';
      onUpdate();
      return;
    }

    // Tool hotkeys (1-9)
    const tool = TOOL_HOTKEYS[e.key];
    if (tool) {
      state.selectedTool = tool;
      onUpdate();
    }
  }, [state, onUpdate]);

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        cursor: state.selectedTool === 'select' ? 'default' : 'crosshair',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
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
