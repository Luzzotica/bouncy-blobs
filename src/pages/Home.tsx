import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { hasSeenIntro, resetIntroSeen } from '../utils/introSeen'
import { startMusic, isMusicStarted } from '../utils/music'
import SettingsModal from '../components/SettingsModal'
import HomeBackground, { paperBtn, tapeStrip } from '../components/HomeBackground'

interface MenuButtonConfig {
  label: string
  to: string
  testId?: string
  tape: string
}

const MENU: MenuButtonConfig[] = [
  { label: 'Play',         to: '/play',        testId: 'play-button',        tape: '#c77dff' },
  { label: 'Multiplayer',  to: '/multiplayer', testId: 'multiplayer-button',  tape: '#5a189a' },
  { label: 'Level Editor', to: '/editor',      tape: '#e85d75' },
]

export default function Home() {
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Pick small random tilts once per mount so each paper button feels
  // hand-placed but doesn't twitch on rerender. One extra tilt for the
  // settings sticky note in the corner.
  const tilts = useMemo(
    () => [...MENU, null].map(() => (Math.random() * 6 - 3).toFixed(2)),
    [],
  )
  const settingsTilt = tilts[tilts.length - 1]

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
    <HomeBackground>
      <h1 style={title} aria-label="Bouncy Blobs">
        {Array.from('Bouncy Blobs').map((ch, i) => (
          <span
            key={i}
            className="jelly-letter"
            aria-hidden="true"
            style={ch === ' ' ? { display: 'inline-block', width: '0.35em' } : undefined}
          >
            {ch === ' ' ? ' ' : ch}
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

      <div style={versionLabel} aria-hidden="true">v{__APP_VERSION__}</div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onReplayIntro={replayIntro}
      />

      <style>{`
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
    </HomeBackground>
  )
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

const versionLabel: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  right: 16,
  fontSize: 12,
  fontWeight: 700,
  color: 'rgba(255, 250, 230, 0.55)',
  letterSpacing: 1,
  textShadow: '1px 1px 0 rgba(10, 6, 18, 0.7)',
  userSelect: 'none',
  pointerEvents: 'none',
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
