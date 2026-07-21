/**
 * Kid-proof Back chrome — hold ~1.5s to leave Kids Mode (no accidental one-tap).
 * Progress fill while holding; cancel on early release. Eng can hook onComplete.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { COLORS, PAPER_SHADOW, RADII, tape } from '../theme/uiTheme';

const HOLD_MS = 1500;

interface Props {
  /** Called when hold completes (default: parent navigates Home). */
  onComplete: () => void;
  /** Hold duration in ms (default 1500). */
  holdMs?: number;
  label?: string;
}

export default function KidsHoldBack({
  onComplete,
  holdMs = HOLD_MS,
  label = '← Home',
}: Props) {
  const [progress, setProgress] = useState(0); // 0..1
  const [holding, setHolding] = useState(false);
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const doneRef = useRef(false);

  const cancel = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    startRef.current = 0;
    doneRef.current = false;
    setHolding(false);
    setProgress(0);
  }, []);

  const tick = useCallback(() => {
    const elapsed = performance.now() - startRef.current;
    const p = Math.min(1, elapsed / holdMs);
    setProgress(p);
    if (p >= 1) {
      if (!doneRef.current) {
        doneRef.current = true;
        setHolding(false);
        setProgress(1);
        onComplete();
      }
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [holdMs, onComplete]);

  const begin = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch { /* ignore */ }
    doneRef.current = false;
    startRef.current = performance.now();
    setHolding(true);
    setProgress(0);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const end = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (doneRef.current) return;
    cancel();
  }, [cancel]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const pct = Math.round(progress * 100);

  return (
    <button
      type="button"
      className="paper-btn"
      data-testid="kids-hold-back"
      data-kids-chrome
      aria-label="Hold to go home"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      title="Hold to go home"
      onPointerDown={begin}
      onPointerUp={end}
      onPointerCancel={end}
      // Don't cancel on leave — pointer capture keeps the hold if finger slides a bit.
      onLostPointerCapture={() => {
        if (!doneRef.current) cancel();
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={btn}
    >
      <span style={{ ...tape(COLORS.lavender), width: '70%', height: 14, top: -9 }} />
      {/* Progress fill behind label */}
      <span
        aria-hidden
        style={{
          ...fill,
          width: `${pct}%`,
          opacity: holding || progress > 0 ? 1 : 0,
        }}
      />
      <span style={labelStyle}>{label}</span>
      {holding && progress > 0 && progress < 1 && (
        <span style={hint} aria-hidden>hold…</span>
      )}
    </button>
  );
}

const btn: React.CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  fontSize: 20,
  fontWeight: 800,
  padding: '16px 22px 14px',
  minHeight: 56,
  minWidth: 110,
  border: '4px solid #0a0612',
  borderRadius: RADII.control,
  background: COLORS.paper,
  color: COLORS.ink,
  boxShadow: PAPER_SHADOW,
  transform: 'rotate(-2deg)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  letterSpacing: 0.4,
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
};

const fill: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  background: 'rgba(199, 125, 255, 0.45)',
  transition: 'opacity 0.08s ease',
  pointerEvents: 'none',
  zIndex: 0,
};

const labelStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'block',
};

const hint: React.CSSProperties = {
  position: 'absolute',
  right: 8,
  bottom: 4,
  zIndex: 1,
  fontSize: 10,
  fontWeight: 700,
  color: COLORS.inkDim,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  pointerEvents: 'none',
};
