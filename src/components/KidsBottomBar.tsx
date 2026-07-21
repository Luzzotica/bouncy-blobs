/**
 * Kids Mode bottom chrome: [ stick | color rail | puff ] in one landscape row.
 * Slimmed (§13) so more playfield shows shapes; finger targets stay ~48pt+.
 * No face-changing UI — colors only between stick and puff.
 */

import React, { useRef, useState } from 'react';
import type { TouchInput } from '../game/touchInput';
import { COLOR_PALETTE } from '../constants/customization';
import { COLORS, PAPER_SHADOW, RADII, tape } from '../theme/uiTheme';
import { colorName } from '../utils/colorNames';
import { useIsNarrow } from '../lib/useIsNarrow';

const JOY_RADIUS = 44;

interface Props {
  input: TouchInput;
  color: string;
  onColor: (hex: string) => void;
}

export default function KidsBottomBar({ input, color, onColor }: Props) {
  const isNarrow = useIsNarrow();
  const joyRef = useRef<HTMLDivElement>(null);
  const joyTouchId = useRef<number | null>(null);
  const joyOrigin = useRef({ x: 0, y: 0 });
  const btnTouchId = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [pressed, setPressed] = useState(false);

  // §13 slim pass — maximize shape playfield; still ~48pt+ hits.
  const chipPx = isNarrow ? 44 : 48;
  const joySize = isNarrow ? 88 : 96;
  const puffSize = isNarrow ? 76 : 84;

  const updateJoy = (cx: number, cy: number) => {
    const dx = cx - joyOrigin.current.x;
    const dy = cy - joyOrigin.current.y;
    const nx = Math.max(-1, Math.min(1, dx / JOY_RADIUS));
    const ny = Math.max(-1, Math.min(1, dy / JOY_RADIUS));
    input.setVector(nx, ny);
    const mag = Math.hypot(dx, dy);
    const k = mag > JOY_RADIUS ? JOY_RADIUS / mag : 1;
    setKnob({ x: dx * k, y: dy * k });
  };

  const onJoyStart = (e: React.TouchEvent) => {
    if (joyTouchId.current !== null) return;
    const t = e.changedTouches[0];
    joyTouchId.current = t.identifier;
    const rect = joyRef.current!.getBoundingClientRect();
    joyOrigin.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    updateJoy(t.clientX, t.clientY);
  };
  const onJoyMove = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === joyTouchId.current) { updateJoy(t.clientX, t.clientY); break; }
    }
  };
  const onJoyEnd = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === joyTouchId.current) {
        joyTouchId.current = null;
        input.release();
        setKnob({ x: 0, y: 0 });
        break;
      }
    }
  };

  const onBtnStart = (e: React.TouchEvent) => {
    if (btnTouchId.current !== null) return;
    btnTouchId.current = e.changedTouches[0].identifier;
    input.setExpanding(true);
    setPressed(true);
  };
  const onBtnEnd = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === btnTouchId.current) {
        btnTouchId.current = null;
        input.setExpanding(false);
        setPressed(false);
        break;
      }
    }
  };

  return (
    <div
      data-kids-bottom-bar
      data-kids-pad
      data-kids-chrome
      style={bar}
      aria-label="Kids controls"
    >
      {/* Stick */}
      <div
        ref={joyRef}
        style={{ ...joyBase, width: joySize, height: joySize }}
        onTouchStart={onJoyStart}
        onTouchMove={onJoyMove}
        onTouchEnd={onJoyEnd}
        onTouchCancel={onJoyEnd}
        aria-label="Move stick"
      >
        <div style={{ ...joyKnob, transform: `translate(${knob.x}px, ${knob.y}px)` }} />
      </div>

      {/* Color rail only (no face row) */}
      <div
        style={colorStrip}
        role="listbox"
        aria-label="Pick your color"
        data-kids-color-rail
      >
        <span style={{ ...tape(COLORS.yellow), width: '16%', height: 9, top: -6 }} />
        {COLOR_PALETTE.map((hex) => {
          const isOn = color.toLowerCase() === hex.toLowerCase();
          const name = colorName(hex);
          return (
            <button
              key={hex}
              type="button"
              role="option"
              aria-selected={isOn}
              aria-label={name}
              title={name}
              data-testid={`kids-color-${hex.slice(1)}`}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onColor(hex);
              }}
              onClick={(e) => {
                if (e.detail === 0) onColor(hex);
                else e.preventDefault();
              }}
              style={{
                ...chip,
                background: hex,
                width: chipPx,
                height: chipPx,
                minWidth: chipPx,
                minHeight: chipPx,
                boxShadow: isOn
                  ? `0 0 0 2px ${COLORS.paper}, 0 0 0 5px ${COLORS.lavender}, 0 2px 6px rgba(0,0,0,0.28)`
                  : '0 2px 5px rgba(0,0,0,0.2)',
                transform: isOn ? 'scale(1.06)' : 'scale(1)',
              }}
            />
          );
        })}
      </div>

      {/* Puff */}
      <div
        style={{
          ...expandBtn,
          width: puffSize,
          height: puffSize,
          transform: pressed ? 'scale(0.92)' : 'scale(1)',
          opacity: pressed ? 1 : 0.92,
        }}
        onTouchStart={onBtnStart}
        onTouchEnd={onBtnEnd}
        onTouchCancel={onBtnEnd}
        aria-label="Puff expand"
        role="button"
      >
        PUFF
      </div>
    </div>
  );
}

const bar: React.CSSProperties = {
  position: 'absolute',
  left: 'calc(4px + var(--safe-area-left, 0px))',
  right: 'calc(4px + var(--safe-area-right, 0px))',
  bottom: 'calc(4px + var(--safe-area-bottom, 0px))',
  zIndex: 40,
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  pointerEvents: 'none',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
};

const joyBase: React.CSSProperties = {
  flex: '0 0 auto',
  borderRadius: '50%',
  background: 'rgba(20, 12, 30, 0.32)',
  border: '3px solid rgba(199, 125, 255, 0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
  touchAction: 'none',
};

const joyKnob: React.CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: '50%',
  background: 'rgba(255, 248, 235, 0.94)',
  border: '3px solid rgba(199, 125, 255, 0.95)',
  willChange: 'transform',
};

const colorStrip: React.CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minWidth: 0,
  display: 'flex',
  flexWrap: 'nowrap',
  justifyContent: 'center',
  alignItems: 'center',
  gap: 6,
  padding: '5px 8px 4px',
  overflowX: 'auto',
  overflowY: 'hidden',
  background: COLORS.paper,
  border: '3px solid #0a0612',
  borderRadius: RADII.card,
  boxShadow: PAPER_SHADOW,
  pointerEvents: 'auto',
  touchAction: 'manipulation',
  transform: 'rotate(-0.15deg)',
  // Cap strip height so bar never balloons above control diameter.
  maxHeight: 58,
};

const chip: React.CSSProperties = {
  borderRadius: '50%',
  border: '2px solid #0a0612',
  cursor: 'pointer',
  padding: 0,
  flex: '0 0 auto',
  transition: 'transform 0.12s ease, box-shadow 0.12s ease',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
};

const expandBtn: React.CSSProperties = {
  flex: '0 0 auto',
  borderRadius: '50%',
  background: 'rgba(123, 104, 238, 0.9)',
  border: '3px solid rgba(255, 248, 235, 0.95)',
  color: '#fff8eb',
  fontWeight: 900,
  fontSize: 14,
  letterSpacing: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
  touchAction: 'none',
  userSelect: 'none',
  transition: 'transform 0.06s ease-out, opacity 0.06s ease-out',
};
