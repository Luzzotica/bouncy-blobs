import React from 'react';
import type { LevelData } from '../levels/types';
import {
  materialPreviewColors,
  SOFT_PLATFORM_PALETTE,
  SPIKE_CRYSTAL_PALETTE,
  SPIKE_BASE_PALETTE,
} from '../renderer/candySkin';

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
  for (const s of level.springPads ?? []) expandRect(s.x, s.y, s.width, s.height);
  for (const s of level.spikes ?? []) expandRect(s.x, s.y, s.width, s.height);
  for (const z of level.goalZones ?? []) expandRect(z.x, z.y, z.width, z.height);
  for (const z of level.hillZones ?? []) expandRect(z.x, z.y, z.width, z.height);
  for (const z of (level as any).deathZones ?? []) expandRect(z.x, z.y, z.width, z.height);
  for (const sp of level.spawnPoints) expandPoint(sp.x, sp.y);
  for (const ps of level.pointShapes ?? []) for (const pt of ps.points) expandPoint(pt.x, pt.y);
  for (const sp of level.softPlatforms ?? []) expandRect(sp.x, sp.y, sp.width, sp.height);
  for (const t of level.triggers ?? []) expandRect(t.x, t.y, t.width, t.height);

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

      {/* Spring pads (blue) */}
      {(level.springPads ?? []).map((s) => (
        <rect
          key={`spring-${s.id}`}
          x={s.x - s.width / 2}
          y={s.y - s.height / 2}
          width={s.width}
          height={s.height}
          fill="#4a9eff"
          opacity={0.7}
          transform={`rotate(${(s.rotation * 180) / Math.PI} ${s.x} ${s.y})`}
        />
      ))}

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

      {/* Spawn points — player only, small white dots */}
      {level.spawnPoints
        .filter((sp) => sp.type === 'player')
        .map((sp) => (
          <circle key={sp.id} cx={sp.x} cy={sp.y} r={14} fill="#fff" opacity={0.7} />
        ))}
    </svg>
  );
}
