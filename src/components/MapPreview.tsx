import React from 'react';
import type { LevelData, ActionTarget } from '../levels/types';
import {
  materialPreviewColors,
  SOFT_PLATFORM_PALETTE,
  SPIKE_CRYSTAL_PALETTE,
  SPIKE_BASE_PALETTE,
} from '../renderer/candySkin';
import { PLATE_THICKNESS, PLATE_WIDTH_SCALE } from '../game/springRenderer';

interface MapPreviewProps {
  level: LevelData;
  width?: number;
  height?: number;
}

/**
 * Static SVG preview of a level. Renders platforms, walls, goal/hill zones,
 * spawn points, springs, and spikes scaled to fit the requested box via
 * SVG's viewBox. Cheap (no canvas, no animation) so it's safe to instance
 * dozens of times in a picker modal.
 */
export default function MapPreview({ level, width = 200, height = 130 }: MapPreviewProps) {
  const { bounds } = level;

  // Compute the actual content bounds so previews stay centered on the level
  // geometry, not the (often off-center) `bounds` rectangle. Falls back to
  // `bounds` when there's no content yet.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const expandRect = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x - w / 2);
    minY = Math.min(minY, y - h / 2);
    maxX = Math.max(maxX, x + w / 2);
    maxY = Math.max(maxY, y + h / 2);
  };
  const expandPoint = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const p of level.platforms) expandRect(p.x, p.y, p.width, p.height);
  for (const w of level.walls) for (const pt of w.points) expandPoint(pt.x, pt.y);
  // Springs draw much larger than their def rect (full plate + coils), so
  // frame them by their visual radius to avoid clipping.
  for (const s of level.springPads ?? []) {
    const r = PLATE_THICKNESS + (s.height * PLATE_WIDTH_SCALE) / 2;
    expandRect(s.x, s.y, r * 2, r * 2);
  }
  for (const s of level.spikes ?? []) expandRect(s.x, s.y, s.width, s.height);
  for (const z of level.goalZones ?? []) expandRect(z.x, z.y, z.width, z.height);
  for (const z of level.hillZones ?? []) expandRect(z.x, z.y, z.width, z.height);
  for (const z of (level as any).deathZones ?? []) expandRect(z.x, z.y, z.width, z.height);
  for (const sp of level.spawnPoints) expandPoint(sp.x, sp.y);
  for (const ps of level.pointShapes ?? []) for (const pt of ps.points) expandPoint(pt.x, pt.y);
  for (const sp of level.softPlatforms ?? []) expandRect(sp.x, sp.y, sp.width, sp.height);
  for (const t of level.triggers ?? []) expandRect(t.x, t.y, t.width, t.height);
  for (const z of level.gravityZones ?? []) expandRect(z.x, z.y, z.width, z.height);
  for (const a of level.actions ?? []) for (const t of a.targets) {
    if (t.kind !== 'rotateShape') expandPoint(t.endX, t.endY);
  }

  let vbX: number, vbY: number, vbW: number, vbH: number;
  if (!Number.isFinite(minX)) {
    vbX = 0; vbY = 0; vbW = bounds.width; vbH = bounds.height;
  } else {
    const pad = Math.max((maxX - minX), (maxY - minY)) * 0.08 + 50;
    vbX = minX - pad;
    vbY = minY - pad;
    vbW = (maxX - minX) + pad * 2;
    vbH = (maxY - minY) + pad * 2;
  }

  // Resolve where an action target starts (closed pose), so we can draw an
  // arrow to its open pose (endX/endY). Mirrors EditorCanvas.
  const shapeCentroid = (shapeId: string): { x: number; y: number } | null => {
    const shape = (level.pointShapes ?? []).find((s) => s.id === shapeId);
    if (!shape || shape.points.length === 0) return null;
    let sx = 0, sy = 0;
    for (const p of shape.points) { sx += p.x; sy += p.y; }
    return { x: sx / shape.points.length, y: sy / shape.points.length };
  };
  const sourcePos = (t: ActionTarget): { x: number; y: number } | null => {
    if (t.kind === 'shapePoint') {
      const shape = (level.pointShapes ?? []).find((s) => s.id === t.shapeId);
      const pt = shape?.points[t.pointIndex];
      return pt ? { x: pt.x, y: pt.y } : null;
    }
    if (t.kind === 'rotateShape' || t.kind === 'moveShape') return shapeCentroid(t.shapeId);
    if (t.kind === 'spike') {
      const spike = (level.spikes ?? []).find((s) => s.id === t.spikeId);
      return spike ? { x: spike.x, y: spike.y } : null;
    }
    const plat = level.platforms.find((p) => p.id === t.platformId);
    return plat ? { x: plat.x, y: plat.y } : null;
  };

  const GRAVITY_COLOR = '#c77dff';
  const ACTION_COLOR = '#5ef0ff';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ background: '#1a1d28', borderRadius: 4, display: 'block' }}
    >
      {/* Backdrop fills the visible viewBox area (replaces the old world-bounds rect,
          which assumed (0,0) was a corner of the level — wrong for centered levels). */}
      <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="#1a1d28" />

      {/* Gravity zones (purple, dashed) — drawn behind solids. Uniform fields
          show a direction arrow; point fields mark their centre. */}
      {(level.gravityZones ?? []).map((z) => {
        const f = z.field;
        const parts: React.ReactNode[] = [
          <rect
            key="rect"
            x={z.x - z.width / 2}
            y={z.y - z.height / 2}
            width={z.width}
            height={z.height}
            fill="rgba(180, 60, 220, 0.16)"
            stroke={GRAVITY_COLOR}
            strokeWidth={2}
            strokeDasharray="6 4"
          />,
        ];
        if (f.kind === 'uniform') {
          const mag = Math.hypot(f.vector.x, f.vector.y);
          if (mag > 1e-3) {
            const dx = f.vector.x / mag, dy = f.vector.y / mag;
            const len = Math.min(70, Math.min(z.width, z.height) * 0.4);
            const sx = z.x - dx * len, sy = z.y - dy * len;
            const ex = z.x + dx * len, ey = z.y + dy * len;
            const ah = 14, pX = -dy, pY = dx;
            parts.push(
              <line key="arrow" x1={sx} y1={sy} x2={ex} y2={ey} stroke={GRAVITY_COLOR} strokeWidth={3} />,
              <polygon
                key="head"
                points={`${ex},${ey} ${ex - dx * ah + pX * ah * 0.5},${ey - dy * ah + pY * ah * 0.5} ${ex - dx * ah - pX * ah * 0.5},${ey - dy * ah - pY * ah * 0.5}`}
                fill={GRAVITY_COLOR}
              />,
            );
          }
        } else {
          parts.push(
            <circle key="center" cx={f.center.x} cy={f.center.y} r={7} fill="rgba(255,230,255,0.95)" stroke={GRAVITY_COLOR} strokeWidth={2} />,
          );
        }
        return <g key={`grav-${z.id}`}>{parts}</g>;
      })}

      {/* Goal zones (green, racing modes) */}
      {(level.goalZones ?? []).map((z) => (
        <rect
          key={`goal-${z.id}`}
          x={z.x - z.width / 2}
          y={z.y - z.height / 2}
          width={z.width}
          height={z.height}
          fill="rgba(78, 255, 78, 0.35)"
          stroke="#4eff4e"
          strokeWidth={3}
        />
      ))}

      {/* Hill zones (orange, KOTH) */}
      {(level.hillZones ?? []).map((z) => (
        <rect
          key={`hill-${z.id}`}
          x={z.x - z.width / 2}
          y={z.y - z.height / 2}
          width={z.width}
          height={z.height}
          fill="rgba(255, 165, 0, 0.35)"
          stroke="#ffa500"
          strokeWidth={3}
        />
      ))}

      {/* Spring pads — yellow bounce plate + coils + a bold launch arrow in
          the firing direction (rotation). Mirrors the in-game spring visual. */}
      {(level.springPads ?? []).map((s) => {
        const hh = (s.height * PLATE_WIDTH_SCALE) / 2; // half plate width (⊥ to launch)
        const thick = PLATE_THICKNESS;                 // plate depth (along launch)
        const deg = (s.rotation * 180) / Math.PI;
        const aLen = Math.max(22, hh * 0.7);           // arrow length
        const aw = Math.max(10, hh * 0.5);             // arrow half-width
        const ax = 8;                                  // arrow start, just past the plate front
        return (
          <g key={`spring-${s.id}`} transform={`translate(${s.x} ${s.y}) rotate(${deg})`}>
            {/* coils behind the plate */}
            <polyline
              points={`${-thick},0 ${-thick - hh * 0.45},${-hh * 0.6} ${-thick - hh * 0.9},${hh * 0.6} ${-thick - hh * 1.35},${-hh * 0.6} ${-thick - hh * 1.7},0`}
              fill="none"
              stroke="#cccccc"
              strokeWidth={5}
              strokeLinejoin="round"
              opacity={0.85}
            />
            {/* bounce plate (front face at x=0, facing the launch direction) */}
            <rect
              x={-thick}
              y={-hh}
              width={thick}
              height={hh * 2}
              rx={6}
              ry={6}
              fill="#ffe066"
              stroke="#a8841f"
              strokeWidth={4}
            />
            {/* launch arrow */}
            <polygon
              points={`${ax + aLen},0 ${ax},${-aw} ${ax},${aw}`}
              fill="#ffcf33"
              stroke="#a8841f"
              strokeWidth={3}
              strokeLinejoin="round"
            />
          </g>
        );
      })}

      {/* Soft platforms — green-apple jelly */}
      {(level.softPlatforms ?? []).map((sp) => (
        <rect
          key={`soft-${sp.id}`}
          x={sp.x - sp.width / 2}
          y={sp.y - sp.height / 2}
          width={sp.width}
          height={sp.height}
          fill={SOFT_PLATFORM_PALETTE.base}
          stroke={SOFT_PLATFORM_PALETTE.deep}
          strokeWidth={2}
          opacity={0.92}
          rx={sp.width * 0.12}
          ry={sp.height * 0.12}
          transform={`rotate(${((sp.rotation ?? 0) * 180) / Math.PI} ${sp.x} ${sp.y})`}
        />
      ))}

      {/* Point shapes (custom soft-body blobs from the Shape tool) — closed
          jelly hulls, same green as soft platforms. */}
      {(level.pointShapes ?? []).map((ps) => (
        ps.points.length >= 3 ? (
          <polygon
            key={`pointshape-${ps.id}`}
            points={ps.points.map((pt) => `${pt.x},${pt.y}`).join(' ')}
            fill={SOFT_PLATFORM_PALETTE.base}
            stroke={SOFT_PLATFORM_PALETTE.deep}
            strokeWidth={2}
            strokeLinejoin="round"
            opacity={0.9}
          />
        ) : null
      ))}

      {/* Spikes — caramel base + pink rock-candy teeth */}
      {(level.spikes ?? []).map((s) => {
        const cx = s.x;
        const cy = s.y;
        const hw = s.width / 2;
        const numTeeth = Math.max(2, Math.floor(s.width / 30));
        const toothW = s.width / numTeeth;
        const rot = `rotate(${(s.rotation * 180) / Math.PI} ${cx} ${cy})`;
        const teeth: string[] = [];
        for (let i = 0; i < numTeeth; i++) {
          const tx = -hw + i * toothW;
          teeth.push(
            `M ${tx} 0 L ${tx + toothW} 0 L ${tx + toothW / 2} ${-s.height} Z`,
          );
        }
        return (
          <g key={`spike-${s.id}`} transform={`translate(${cx} ${cy}) ${rot.replace(`${cx} ${cy}`, '0 0')}`}>
            <rect
              x={-hw}
              y={-4}
              width={s.width}
              height={8}
              fill={SPIKE_BASE_PALETTE.base}
              stroke={SPIKE_BASE_PALETTE.outline}
              strokeWidth={1}
            />
            <path
              d={teeth.join(' ')}
              fill={SPIKE_CRYSTAL_PALETTE.base}
              stroke={SPIKE_CRYSTAL_PALETTE.outline}
              strokeWidth={1}
              strokeLinejoin="round"
            />
          </g>
        );
      })}

      {/* Platforms (rotated rectangles) — colored by material */}
      {level.platforms.map((p) => {
        const colors = materialPreviewColors(p.material);
        return (
          <rect
            key={p.id}
            x={p.x - p.width / 2}
            y={p.y - p.height / 2}
            width={p.width}
            height={p.height}
            fill={colors.fill}
            stroke={colors.outline}
            strokeWidth={2}
            opacity={0.92}
            transform={`rotate(${(p.rotation * 180) / Math.PI} ${p.x} ${p.y})`}
          />
        );
      })}

      {/* Walls (polylines) — colored by material */}
      {level.walls.map((w) => {
        const colors = materialPreviewColors(w.material);
        return (
          <polyline
            key={w.id}
            points={w.points.map((pt) => `${pt.x},${pt.y}`).join(' ')}
            fill="none"
            stroke={colors.fill}
            strokeWidth={6}
            strokeLinecap="round"
            opacity={0.95}
          />
        );
      })}

      {/* Trigger plates (editor-authored "trigger area" sensors) — yellow
          dashed rect so they're visually distinct from zones and platforms.
          Drawn near the top of the z-order so they're visible above the
          things they typically sit on. */}
      {(level.triggers ?? []).map((t) => (
        <rect
          key={`trig-${t.id}`}
          x={t.x - t.width / 2}
          y={t.y - t.height / 2}
          width={t.width}
          height={t.height}
          fill="rgba(255, 215, 64, 0.25)"
          stroke="#ffd740"
          strokeWidth={2}
          strokeDasharray="6 4"
          transform={`rotate(${(t.rotation * 180) / Math.PI} ${t.x} ${t.y})`}
        />
      ))}

      {/* Actions (cyan) — for each moving block, a dashed arrow from its
          closed pose to a ghost of its open pose. Shows which blocks animate. */}
      {(level.actions ?? []).flatMap((action) =>
        action.targets.map((t, ti) => {
          const src = sourcePos(t);
          if (!src) return null;
          const parts: React.ReactNode[] = [];
          if (t.kind !== 'rotateShape') {
            parts.push(
              <line key="line" x1={src.x} y1={src.y} x2={t.endX} y2={t.endY} stroke={ACTION_COLOR} strokeWidth={6} strokeLinecap="round" strokeDasharray="10 7" opacity={0.95} />,
            );
          }
          if (t.kind === 'platform') {
            const plat = level.platforms.find((p) => p.id === t.platformId);
            if (plat) {
              const endRot = ((t.endRotation ?? plat.rotation) * 180) / Math.PI;
              parts.push(
                <rect
                  key="ghost"
                  x={t.endX - plat.width / 2}
                  y={t.endY - plat.height / 2}
                  width={plat.width}
                  height={plat.height}
                  fill="rgba(94,240,255,0.18)"
                  stroke={ACTION_COLOR}
                  strokeWidth={4}
                  strokeDasharray="8 5"
                  opacity={0.95}
                  transform={`rotate(${endRot} ${t.endX} ${t.endY})`}
                />,
              );
            }
          } else if (t.kind === 'shapePoint') {
            parts.push(<circle key="ghost" cx={t.endX} cy={t.endY} r={9} fill="rgba(94,240,255,0.18)" stroke={ACTION_COLOR} strokeWidth={4} opacity={0.95} />);
          } else if (t.kind === 'spike') {
            const spike = (level.spikes ?? []).find((s) => s.id === t.spikeId);
            if (spike) {
              const hw = spike.width / 2;
              const numTeeth = Math.max(2, Math.floor(spike.width / 30));
              const toothW = spike.width / numTeeth;
              const teeth: string[] = [];
              for (let i = 0; i < numTeeth; i++) {
                const tx = -hw + i * toothW;
                teeth.push(`M ${tx} 0 L ${tx + toothW} 0 L ${tx + toothW / 2} ${-spike.height} Z`);
              }
              const endRot = ((t.endRotation ?? spike.rotation) * 180) / Math.PI;
              parts.push(
                <path key="ghost" d={teeth.join(' ')} fill="rgba(94,240,255,0.18)" stroke={ACTION_COLOR}
                  strokeWidth={4} strokeLinejoin="round" opacity={0.95}
                  transform={`translate(${t.endX} ${t.endY}) rotate(${endRot})`} />,
              );
            }
          } else if (t.kind === 'moveShape') {
            const shape = (level.pointShapes ?? []).find((s) => s.id === t.shapeId);
            if (shape && shape.points.length >= 3 && src) {
              const ddx = t.endX - src.x, ddy = t.endY - src.y;
              parts.push(
                <polygon
                  key="ghost"
                  points={shape.points.map((pt) => `${pt.x + ddx},${pt.y + ddy}`).join(' ')}
                  fill="rgba(94,240,255,0.18)"
                  stroke={ACTION_COLOR}
                  strokeWidth={4}
                  strokeDasharray="8 5"
                  strokeLinejoin="round"
                  opacity={0.95}
                />,
              );
            }
          } else if (t.kind === 'rotateShape') {
            const c = shapeCentroid(t.shapeId);
            if (c) parts.push(<circle key="ghost" cx={c.x} cy={c.y} r={18} fill="none" stroke={ACTION_COLOR} strokeWidth={4} strokeDasharray="8 5" opacity={0.95} />);
          }
          return <g key={`action-${action.id}-${ti}`}>{parts}</g>;
        }),
      )}

      {/* Spawn points — player only, small white dots */}
      {level.spawnPoints
        .filter((sp) => sp.type === 'player')
        .map((sp) => (
          <circle key={sp.id} cx={sp.x} cy={sp.y} r={14} fill="#fff" opacity={0.7} />
        ))}
    </svg>
  );
}
