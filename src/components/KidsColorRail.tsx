/**
 * Kids Mode color chips — slim bar at the TRUE bottom of the screen.
 *
 * With the touch pad: sits BETWEEN left joystick and right PUFF (not pushed
 * up above the controls). Without pad: full-width bottom strip.
 */

import React from 'react';
import { COLOR_PALETTE } from '../constants/customization';
import { COLORS, PAPER_SHADOW, RADII, tape } from '../theme/uiTheme';
import { colorName } from '../utils/colorNames';
import { useIsNarrow } from '../lib/useIsNarrow';

interface Props {
  selected: string;
  onSelect: (hex: string) => void;
  /**
   * When true, horizontal strip between joy (left) and puff (right) at the
   * bottom edge — same row as TouchControls `variant="kids"`.
   */
  betweenControls?: boolean;
}

/** Between stick/puff: a bit smaller so the mid strip fits. Full bottom: slightly larger. */
const CHIP_BETWEEN = 42;
const CHIP_NARROW = 48;
const CHIP_WIDE = 52;

export default function KidsColorRail({
  selected,
  onSelect,
  betweenControls = false,
}: Props) {
  const isNarrow = useIsNarrow();
  const chipPx = betweenControls
    ? CHIP_BETWEEN
    : isNarrow
      ? CHIP_NARROW
      : CHIP_WIDE;

  // Match TouchControls kids layout: joy ~120 left / puff ~96 right, bottom ~10–16.
  // Leave gutters so chips never sit under the stick or puff hit zones.
  const layout: React.CSSProperties = betweenControls
    ? {
        left: 'calc(148px + var(--safe-area-left, 0px))',
        right: 'calc(128px + var(--safe-area-right, 0px))',
        // Align vertically with joy center (joy bottom 10, h 120 → mid ~70).
        bottom: 'calc(28px + var(--safe-area-bottom, 0px))',
        flexWrap: 'nowrap',
        overflowX: 'auto',
        overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch',
        maxHeight: 64,
      }
    : {
        left: 'calc(8px + var(--safe-area-left, 0px))',
        right: 'calc(8px + var(--safe-area-right, 0px))',
        bottom: 'calc(8px + var(--safe-area-bottom, 0px))',
        flexWrap: 'wrap',
      };

  return (
    <div
      style={{
        ...rail,
        ...layout,
        gap: betweenControls ? 8 : isNarrow ? 10 : 12,
        padding: betweenControls
          ? '6px 8px 5px'
          : isNarrow
            ? '8px 8px 6px'
            : '9px 10px 7px',
      }}
      role="listbox"
      aria-label="Pick your color"
      data-kids-color-rail
    >
      <span style={{ ...tape(COLORS.yellow), width: '22%', height: 11, top: -7 }} />

      {COLOR_PALETTE.map((hex) => {
        const isOn = selected.toLowerCase() === hex.toLowerCase();
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
              onSelect(hex);
            }}
            onClick={(e) => {
              if (e.detail === 0) {
                onSelect(hex);
                return;
              }
              e.preventDefault();
            }}
            style={{
              ...chip,
              background: hex,
              width: chipPx,
              height: chipPx,
              minWidth: chipPx,
              minHeight: chipPx,
              boxShadow: isOn
                ? `0 0 0 3px ${COLORS.paper}, 0 0 0 6px ${COLORS.lavender}, 0 4px 10px rgba(0,0,0,0.32)`
                : '0 3px 8px rgba(0,0,0,0.25)',
              transform: isOn ? 'scale(1.08)' : 'scale(1)',
            }}
          />
        );
      })}
    </div>
  );
}

const rail: React.CSSProperties = {
  position: 'absolute',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  background: COLORS.paper,
  border: '3px solid #0a0612',
  borderRadius: RADII.card,
  boxShadow: PAPER_SHADOW,
  zIndex: 35, // above pad overlay (40 is overlay; zones 40; rail tappable mid-band)
  pointerEvents: 'auto',
  touchAction: 'manipulation',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  transform: 'rotate(-0.2deg)',
};

const chip: React.CSSProperties = {
  borderRadius: '50%',
  border: '3px solid #0a0612',
  cursor: 'pointer',
  padding: 0,
  flex: '0 0 auto',
  transition: 'transform 0.12s ease, box-shadow 0.12s ease',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
  userSelect: 'none',
  WebkitUserSelect: 'none',
};
