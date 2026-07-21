/**
 * @deprecated Prefer KidsBottomBar (stick | colors | puff).
 * Colors-only — no face UI (Sterling §13).
 */

import React from 'react';
import KidsColorRail from './KidsColorRail';

interface Props {
  color: string;
  onColor: (hex: string) => void;
}

export default function KidsCustomizeDock({ color, onColor }: Props) {
  return (
    <div data-kids-customize-dock data-kids-chrome style={{ pointerEvents: 'none' }}>
      <KidsColorRail selected={color} onSelect={onColor} />
    </div>
  );
}
