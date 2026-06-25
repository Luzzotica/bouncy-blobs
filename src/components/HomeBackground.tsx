import { useRef, type ReactNode } from 'react'
import { assetUrl } from '../utils/assetUrl'

// Shared menu backdrop: the cream-paper/purple parallax hero used by the
// home page. Extracted so the Multiplayer page (and any future menu screen)
// renders the EXACT same background instead of a drifting copy.
//
// Children render on top of the bg + overlay. Position them however you like
// (Home lays its title/buttons out absolutely; Multiplayer uses a flex
// content wrapper).

// How much (in %) the background drifts at the extreme edges of the
// viewport. The full -0.5..+0.5 normalized mouse range moves the bg by
// ±BG_PARALLAX_AMP%.
const BG_PARALLAX_AMP = 1.5
// Baseline vertical shift of the bg layer (in %). Parallax drifts around it.
const BG_BIAS_Y = 0

export default function HomeBackground({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  const bgRef = useRef<HTMLDivElement>(null)

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const { innerWidth, innerHeight } = window
    const nx = e.clientX / innerWidth - 0.5
    const ny = e.clientY / innerHeight - 0.5
    if (bgRef.current) {
      // Inverted on both axes: bg drifts opposite the cursor for a
      // "looking around" feel, on top of the BG_BIAS_Y baseline.
      bgRef.current.style.transform =
        `translate(${-nx * BG_PARALLAX_AMP}%, ${BG_BIAS_Y - ny * BG_PARALLAX_AMP}%)`
    }
  }

  return (
    <div style={shell} onMouseMove={handleMouseMove} className={`home-shell ${className}`}>
      <div ref={bgRef} style={bgLayer} className="menu-bg" />
      <div style={overlay} />
      {children}

      <style>{`
        .home-shell { animation: homeFadeIn 0.7s ease-out both; }
        @keyframes homeFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .home-shell { animation: none; }
        }
        .paper-btn {
          transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1),
                      box-shadow 0.2s ease-out;
        }
        .paper-btn:hover {
          transform: rotate(0deg) scale(1.06) translateY(-4px) !important;
          box-shadow: 0 14px 28px rgba(0,0,0,0.4) !important;
        }
        .paper-btn:active {
          transform: scale(0.98) !important;
        }
        /* Background eases toward the mouse-driven target each frame.
           handleMouseMove sets the transform imperatively; the
           transition smooths jitter. */
        .menu-bg {
          transition: transform 0.4s ease-out;
          will-change: transform;
        }
        @media (prefers-reduced-motion: reduce) {
          .menu-bg { transition: none; }
        }
      `}</style>
    </div>
  )
}

const shell: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: '#0a0612',
  overflow: 'hidden',
}

// Sits behind everything else. Slightly oversized so the BG_BIAS_Y baseline
// + ±BG_PARALLAX_AMP mouse drift don't reveal the page bg.
const bgLayer: React.CSSProperties = {
  position: 'absolute',
  inset: '-2%',
  backgroundImage: `url('${assetUrl('/menu/menu_hero.png')}')`,
  backgroundSize: 'cover',
  backgroundPosition: 'center center',
  backgroundRepeat: 'no-repeat',
  transform: `translate(0%, ${BG_BIAS_Y}%)`,
}

const overlay: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'linear-gradient(180deg, rgba(10,6,18,0.35) 0%, rgba(10,6,18,0) 30%, rgba(10,6,18,0) 60%, rgba(10,6,18,0.55) 100%)',
  pointerEvents: 'none',
}

// Shared paper-card + tape motif so menu screens stay visually identical.
// Canonical definitions now live in the in-game UI theme module; re-exported
// here for the existing import sites (Home, GameMenu).
export { paperBtn, tapeStrip } from '../theme/uiTheme'
