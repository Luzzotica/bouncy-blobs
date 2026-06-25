import React, { useEffect, useRef, useState } from 'react';
import type { BouncyBlobsGame } from '../game/bouncyBlobsGame';

interface KothRow {
  playerId: string;
  name: string;
  color: string;
  score: number;
}

interface KothSnapshot {
  timeRemaining: number | null;
  targetScore: number;
  rows: KothRow[];
}

interface KothHudProps {
  gameRef: React.RefObject<BouncyBlobsGame | null>;
}

/**
 * React overlay for King of the Hill — replaces the old canvas-drawn timer +
 * scoreboard. Polls the live game each animation frame and renders a clean
 * timer pill (top-center) and a per-player score panel (top-right). Renders
 * nothing unless the current mode is KOTH and the match is in the playing
 * phase, so it can be mounted unconditionally over the canvas.
 */
export default function KothHud({ gameRef }: KothHudProps) {
  const [snap, setSnap] = useState<KothSnapshot | null>(null);
  const lastKey = useRef('');

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const game = gameRef.current;
      const mgr = game?.getModeManager?.();
      const mode = mgr?.getMode?.();
      if (!game || !mgr || !mode || mode.config.id !== 'koth') {
        if (lastKey.current !== '') { lastKey.current = ''; setSnap(null); }
        return;
      }
      const state = mgr.getState();
      if (state.phase !== 'playing') {
        if (lastKey.current !== '') { lastKey.current = ''; setSnap(null); }
        return;
      }
      const players = game.getPlayerManager()?.getAllPlayers() ?? [];
      const rows: KothRow[] = players.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        color: p.color,
        score: state.scores.get(p.playerId) ?? 0,
      }));
      const targetScore = mode.config.targetScore ?? 50;
      const next: KothSnapshot = { timeRemaining: state.timeRemaining, targetScore, rows };

      // Only re-render when something visibly changed (rounded values).
      const key = JSON.stringify([
        next.timeRemaining === null ? null : Math.ceil(next.timeRemaining),
        next.targetScore,
        rows.map((r) => [r.playerId, r.name, r.color, Math.floor(r.score)]),
      ]);
      if (key !== lastKey.current) {
        lastKey.current = key;
        setSnap(next);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gameRef]);

  if (!snap) return null;

  const sorted = [...snap.rows].sort((a, b) => b.score - a.score);

  return (
    <div style={wrap}>
      {snap.timeRemaining !== null && (
        <div style={timerPill(snap.timeRemaining)} data-testid="koth-timer">
          {formatTime(snap.timeRemaining)}
        </div>
      )}
      {sorted.length > 0 && (
        <div style={panel} data-testid="koth-scoreboard">
          {sorted.map((r) => {
            const pct = Math.min(r.score / snap.targetScore, 1) * 100;
            return (
              <div key={r.playerId} style={row}>
                <span style={{ ...dot, background: r.color }} />
                <span style={name}>{r.name}</span>
                <div style={track}>
                  <div style={{ ...fill, width: `${pct}%`, background: r.color }} />
                </div>
                <span style={scoreText}>{Math.floor(r.score)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatTime(t: number): string {
  const minutes = Math.floor(t / 60);
  const seconds = Math.ceil(t % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const wrap: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 15,
};

const timerPill = (t: number): React.CSSProperties => ({
  position: 'absolute',
  top: 14,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '6px 18px',
  fontSize: 26,
  fontWeight: 900,
  fontVariantNumeric: 'tabular-nums',
  color: t <= 10 ? '#ff5c5c' : '#fffae6',
  background: 'rgba(10,6,18,0.7)',
  border: '2px solid #0a0612',
  borderRadius: 999,
  letterSpacing: 1,
  boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
});

const panel: React.CSSProperties = {
  position: 'absolute',
  top: 14,
  right: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  padding: '12px 14px',
  minWidth: 220,
  background: 'rgba(10,6,18,0.7)',
  border: '2px solid #0a0612',
  borderRadius: 10,
  boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
};

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const dot: React.CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: '50%',
  flexShrink: 0,
  border: '1.5px solid rgba(0,0,0,0.4)',
};

const name: React.CSSProperties = {
  width: 70,
  fontSize: 13,
  fontWeight: 700,
  color: '#fffae6',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const track: React.CSSProperties = {
  flex: 1,
  height: 10,
  background: 'rgba(255,255,255,0.12)',
  borderRadius: 999,
  overflow: 'hidden',
};

const fill: React.CSSProperties = {
  height: '100%',
  borderRadius: 999,
  transition: 'width 0.2s ease-out',
};

const scoreText: React.CSSProperties = {
  width: 26,
  textAlign: 'right',
  fontSize: 13,
  fontWeight: 800,
  fontVariantNumeric: 'tabular-nums',
  color: '#fff',
};
