/**
 * Kids Mode learn-mode chrome — Alphabet / Music / Shape / Color sticky toggle.
 *
 * Chrome only for Color mode tap rules — eng wires mode-wide playground behavior.
 * Keep slim: four compact sticky options.
 */

import React from 'react';
import { COLORS, PAPER_SHADOW, RADII, tape } from '../theme/uiTheme';

export type KidsLearnMode = 'alphabet' | 'music' | 'shape' | 'color';

interface Props {
  mode: KidsLearnMode;
  onChange: (mode: KidsLearnMode) => void;
}

const OPTIONS: {
  id: KidsLearnMode;
  label: string;
  glyph: string;
  tape: string;
  testId: string;
  aria: string;
}[] = [
  { id: 'alphabet', label: 'ABC', glyph: 'A', tape: COLORS.pink, testId: 'kids-mode-alphabet', aria: 'Alphabet mode' },
  { id: 'music', label: 'Music', glyph: '♪', tape: COLORS.lavender, testId: 'kids-mode-music', aria: 'Music mode' },
  { id: 'shape', label: 'Shape', glyph: '★', tape: COLORS.green, testId: 'kids-mode-shape', aria: 'Shape mode' },
  { id: 'color', label: 'Color', glyph: '⬤', tape: COLORS.yellow, testId: 'kids-mode-color', aria: 'Color mode' },
];

export default function KidsModePicker({ mode, onChange }: Props) {
  return (
    <div
      style={shell}
      role="radiogroup"
      aria-label="Learn mode"
      data-kids-mode-picker
      data-kids-chrome
    >
      <span style={{ ...tape(COLORS.purple), width: '36%', height: 12, top: -8 }} />
      {OPTIONS.map((opt) => {
        const on = mode === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={opt.aria}
            data-testid={opt.testId}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onChange(opt.id);
            }}
            onClick={(e) => {
              if (e.detail === 0) onChange(opt.id);
              else e.preventDefault();
            }}
            style={{
              ...optionBtn,
              background: on ? COLORS.paper : 'rgba(255, 250, 230, 0.72)',
              boxShadow: on
                ? `0 0 0 3px ${COLORS.lavender}, ${PAPER_SHADOW}`
                : '0 3px 8px rgba(0,0,0,0.2)',
              transform: on ? 'scale(1.04)' : 'scale(1)',
              opacity: on ? 1 : 0.88,
            }}
          >
            <span style={{ ...miniTape, background: opt.tape }} />
            <span style={glyph}>{opt.glyph}</span>
            <span style={label}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const shell: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(12px + var(--safe-area-top, 0px))',
  left: '50%',
  transform: 'translateX(-50%) rotate(-0.8deg)',
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'stretch',
  gap: 6,
  padding: '12px 8px 8px',
  background: COLORS.paper,
  border: '4px solid #0a0612',
  borderRadius: RADII.card,
  boxShadow: PAPER_SHADOW,
  zIndex: 25,
  pointerEvents: 'auto',
  touchAction: 'manipulation',
  userSelect: 'none',
  WebkitUserSelect: 'none',
};

const optionBtn: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1,
  minWidth: 56,
  minHeight: 56,
  padding: '8px 10px 6px',
  border: '3px solid #0a0612',
  borderRadius: RADII.control,
  cursor: 'pointer',
  fontFamily: 'inherit',
  color: COLORS.ink,
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
  transition: 'transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease',
};

const miniTape: React.CSSProperties = {
  position: 'absolute',
  top: -6,
  left: '50%',
  transform: 'translateX(-50%) rotate(-2deg)',
  width: '52%',
  height: 9,
  border: '1px solid rgba(0,0,0,0.2)',
  opacity: 0.9,
  pointerEvents: 'none',
};

const glyph: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 900,
  lineHeight: 1,
  letterSpacing: 0.3,
};

const label: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
};
