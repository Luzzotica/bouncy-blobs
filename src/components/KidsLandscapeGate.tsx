/**
 * Kids Mode landscape gate — full-screen “turn device” overlay when portrait.
 *
 * On iPad native builds, Info.plist already locks landscape; this covers web,
 * phone, and any residual portrait frames so /kids never plays sideways-wrong.
 */

import React, { useEffect, useState } from 'react';
import { COLORS, PAPER_SHADOW, RADII, tape } from '../theme/uiTheme';

function isPortrait(): boolean {
  if (typeof window === 'undefined') return false;
  // Prefer matchMedia (accounts for browser chrome); fall back to size.
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(orientation: portrait)').matches) return true;
    if (window.matchMedia('(orientation: landscape)').matches) return false;
  }
  return window.innerHeight > window.innerWidth;
}

export default function KidsLandscapeGate() {
  const [portrait, setPortrait] = useState(isPortrait);

  useEffect(() => {
    const update = () => setPortrait(isPortrait());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    const mql = typeof window.matchMedia === 'function'
      ? window.matchMedia('(orientation: portrait)')
      : null;
    mql?.addEventListener?.('change', update);
    // Safari < 14
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mql as any)?.addListener?.(update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      mql?.removeEventListener?.('change', update);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mql as any)?.removeListener?.(update);
    };
  }, []);

  if (!portrait) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Turn your device to landscape"
      data-kids-landscape-gate
      data-kids-chrome
      style={shell}
    >
      <div style={card}>
        <span style={{ ...tape(COLORS.yellow), width: '42%', height: 16, top: -10 }} />
        <div style={glyph} aria-hidden>
          ⟳
        </div>
        <p style={title}>Turn your iPad</p>
        <p style={body}>
          Kids Mode plays in <strong>landscape</strong> — rotate sideways to bounce!
        </p>
      </div>
    </div>
  );
}

const shell: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  background: 'rgba(15, 22, 41, 0.92)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  pointerEvents: 'auto',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
};

const card: React.CSSProperties = {
  position: 'relative',
  maxWidth: 360,
  width: '100%',
  padding: '28px 24px 22px',
  background: COLORS.paper,
  border: '4px solid #0a0612',
  borderRadius: RADII.card,
  boxShadow: PAPER_SHADOW,
  textAlign: 'center',
  color: COLORS.ink,
  transform: 'rotate(-1.2deg)',
};

const glyph: React.CSSProperties = {
  fontSize: 56,
  lineHeight: 1,
  marginBottom: 8,
  fontWeight: 900,
};

const title: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: 26,
  fontWeight: 900,
  letterSpacing: 0.3,
};

const body: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 700,
  lineHeight: 1.35,
  opacity: 0.92,
};
