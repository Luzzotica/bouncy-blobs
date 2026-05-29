import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { hasSeenIntro, resetIntroSeen } from '../utils/introSeen'
import { startMusic, isMusicStarted } from '../utils/music'
import SettingsModal from '../components/SettingsModal'

// How much (in %) the background drifts at the extreme edges of the
// viewport. The full -0.5..+0.5 normalized mouse range will move the bg
// by ±BG_PARALLAX_AMP%.
const BG_PARALLAX_AMP = 1.5
// Baseline vertical shift of the bg layer (in %). The parallax drift
// operates around this baseline.
const BG_BIAS_Y = 0

interface MenuButtonConfig {
  label: string
  to: string
  testId?: string
  tape: string
}

const MENU: MenuButtonConfig[] = [
  { label: 'Host',          to: '/game',    testId: 'host-button',   tape: '#c77dff' },
  { label: 'Browse Lobbies', to: '/lobbies', testId: 'browse-button', tape: '#5a189a' },
  { label: 'Sandbox',       to: '/sandbox', tape: '#2d6a4f' },
  { label: 'Level Editor',  to: '/editor',  tape: '#e85d75' },
]

export default function Home() {
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const bgRef = useRef<HTMLDivElement>(null)

  // Pick small random tilts once per mount so each paper button feels
  // hand-placed but doesn't twitch on rerender. One extra tilt for the
  // settings sticky note in the corner.
  const tilts = useMemo(
    () => [...MENU, null].map(() => (Math.random() * 6 - 3).toFixed(2)),
    [],
  )
  const settingsTilt = tilts[tilts.length - 1]

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const { innerWidth, innerHeight } = window
    // Normalize to -0.5..+0.5
    const nx = e.clientX / innerWidth - 0.5
    const ny = e.clientY / innerHeight - 0.5
    if (bgRef.current) {
      // Inverted on both axes: bg drifts opposite the cursor for a
      // "looking around" feel rather than tracking-with feel. The Y
      // component sits on top of BG_BIAS_Y so the image keeps its
      // raised baseline at all cursor positions.
      bgRef.current.style.transform =
        `translate(${-nx * BG_PARALLAX_AMP}%, ${BG_BIAS_Y - ny * BG_PARALLAX_AMP}%)`
    }
  }

  useEffect(() => {
    if (!hasSeenIntro()) {
      navigate('/intro', { replace: true })
      return
    }
    startMusic()
    if (!isMusicStarted()) {
      const onClick = () => {
        startMusic()
        if (isMusicStarted()) window.removeEventListener('click', onClick)
      }
      window.addEventListener('click', onClick)
      return () => window.removeEventListener('click', onClick)
    }
  }, [navigate])

  function replayIntro() {
    resetIntroSeen()
    navigate('/intro')
  }

  return (
    <div style={shell} onMouseMove={handleMouseMove} className="home-shell">
      <div ref={bgRef} style={bgLayer} className="menu-bg" />
      <div style={overlay} />

      <h1 style={title} aria-label="Bouncy Blobs">
        {Array.from('Bouncy Blobs').map((ch, i) => (
          <span
            key={i}
            className="jelly-letter"
            aria-hidden="true"
            style={ch === ' ' ? { display: 'inline-block', width: '0.35em' } : undefined}
          >
            {ch === ' ' ? ' ' : ch}
          </span>
        ))}
      </h1>

      <div style={buttonRow}>
        {MENU.map((item, i) => (
          <Link key={item.to} to={item.to} style={{ textDecoration: 'none' }}>
            <button
              data-testid={item.testId}
              className="paper-btn"
              style={{
                ...paperBtn,
                transform: `rotate(${tilts[i]}deg)`,
              }}
            >
              <span style={{ ...tapeStrip, background: item.tape }} />
              {item.label}
            </button>
          </Link>
        ))}
      </div>

      <button
        onClick={() => setSettingsOpen(true)}
        className="paper-btn"
        aria-label="Open settings"
        style={{
          ...paperBtn,
          ...settingsStickyBase,
          transform: `rotate(${settingsTilt}deg)`,
        }}
      >
        <span style={{ ...tapeStrip, background: '#fdd835' }} />
        ⚙  Settings
      </button>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onReplayIntro={replayIntro}
      />

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
        /* Per-letter jelly wobble on hover. Each letter is a block so
           transforms apply individually. */
        .jelly-letter {
          display: inline-block;
          transform-origin: center bottom;
          cursor: pointer;
        }
        @keyframes jelly-wobble {
          0%   { transform: scale(1, 1)       translateY(0);   }
          18%  { transform: scale(1.32, 0.74) translateY(3px); }
          38%  { transform: scale(0.78, 1.22) translateY(-12px); }
          55%  { transform: scale(1.12, 0.92) translateY(-2px); }
          72%  { transform: scale(0.95, 1.05) translateY(-5px); }
          88%  { transform: scale(1.03, 0.98) translateY(0);   }
          100% { transform: scale(1, 1)       translateY(0);   }
        }
        .jelly-letter:hover {
          animation: jelly-wobble 0.65s cubic-bezier(0.34, 1.56, 0.5, 1);
        }
        @media (prefers-reduced-motion: reduce) {
          .jelly-letter:hover { animation: none; }
        }
      `}</style>
    </div>
  )
}

const shell: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: '#0a0612',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 0,
  paddingBottom: '8vh',
  overflow: 'hidden',
}

// Sits behind everything else. Slightly oversized so the BG_BIAS_Y
// baseline + ±BG_PARALLAX_AMP mouse drift don't reveal the page bg.
const bgLayer: React.CSSProperties = {
  position: 'absolute',
  inset: '-2%',
  backgroundImage: "url('/menu/menu_hero.png')",
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

const title: React.CSSProperties = {
  position: 'absolute',
  top: '4vh',
  left: 32,
  transform: 'rotate(-2deg)',
  transformOrigin: 'left top',
  margin: 0,
  fontSize: 'clamp(43px, 7.2vw, 86px)',
  fontWeight: 900,
  color: '#fffae6',
  textShadow: '5px 5px 0 #c77dff, -2px -2px 0 #0a0612, 2px -2px 0 #0a0612, -2px 2px 0 #0a0612, 2px 2px 0 #0a0612',
  letterSpacing: 1,
  whiteSpace: 'nowrap',
  userSelect: 'none',
}

const buttonRow: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: 32,
  transform: 'translateY(-50%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 44,
}

const paperBtn: React.CSSProperties = {
  position: 'relative',
  fontSize: 22,
  fontWeight: 800,
  padding: '20px 40px 18px',
  background: '#fffae6',
  color: '#1a0f2e',
  border: '4px solid #0a0612',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
  letterSpacing: 0.5,
  boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
  textShadow: '1px 1px 0 rgba(199,125,255,0.4)',
}

const tapeStrip: React.CSSProperties = {
  position: 'absolute',
  top: -10,
  left: '50%',
  transform: 'translateX(-50%) rotate(-3deg)',
  width: '60%',
  height: 16,
  border: '1px solid rgba(0,0,0,0.25)',
  opacity: 0.85,
  pointerEvents: 'none',
  boxShadow: '0 2px 3px rgba(0,0,0,0.2)',
}

// Sticky-note settings button: same paper+tape style as the main column,
// just smaller and parked in the bottom-left corner under the menu.
const settingsStickyBase: React.CSSProperties = {
  position: 'absolute',
  bottom: 24,
  left: 32,
  fontSize: 16,
  padding: '12px 22px 10px',
}
