import React from 'react';
import type { LevelData } from '../levels/types';

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

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${bounds.width} ${bounds.height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ background: '#1a1d28', borderRadius: 4, display: 'block' }}
    >
      {/* World bounds outline */}
      <rect
        x={0}
        y={0}
        width={bounds.width}
        height={bounds.height}
        fill="none"
        stroke="#2a2d3a"
        strokeWidth={4}
      />

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

      {/* Spikes (red) */}
      {(level.spikes ?? []).map((s) => (
        <rect
          key={`spike-${s.id}`}
          x={s.x - s.width / 2}
          y={s.y - s.height / 2}
          width={s.width}
          height={s.height}
          fill="#ff4444"
          opacity={0.8}
          transform={`rotate(${(s.rotation * 180) / Math.PI} ${s.x} ${s.y})`}
        />
      ))}

      {/* Platforms (rotated rectangles) */}
      {level.platforms.map((p) => (
        <rect
          key={p.id}
          x={p.x - p.width / 2}
          y={p.y - p.height / 2}
          width={p.width}
          height={p.height}
          fill="#4a5570"
          stroke="#5a6580"
          strokeWidth={2}
          transform={`rotate(${(p.rotation * 180) / Math.PI} ${p.x} ${p.y})`}
        />
      ))}

      {/* Walls (polylines) */}
      {level.walls.map((w) => (
        <polyline
          key={w.id}
          points={w.points.map((pt) => `${pt.x},${pt.y}`).join(' ')}
          fill="none"
          stroke="#5a6580"
          strokeWidth={6}
          strokeLinecap="round"
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
