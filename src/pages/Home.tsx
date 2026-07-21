import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { hasSeenIntro, resetIntroSeen } from '../utils/introSeen'
import { startMusic, isMusicStarted } from '../utils/music'
import SettingsModal from '../components/SettingsModal'
import HomeBackground, { paperBtn, tapeStrip } from '../components/HomeBackground'
import { COLORS } from '../theme/uiTheme'
import { useIsNarrow } from '../lib/useIsNarrow'

interface MenuButtonConfig {
  label: string
  to: string
  testId?: string
  tape: string
  /** Hero entry — larger sticky note for the primary kids path. */
  hero?: boolean
}

const MENU: MenuButtonConfig[] = [
  { label: 'Kids Mode',    to: '/kids',        testId: 'kids-mode-button',    tape: COLORS.yellow, hero: true },
  { label: 'Play',         to: '/play',        testId: 'play-button',        tape: COLORS.lavender },
  { label: 'Multiplayer',  to: '/multiplayer', testId: 'multiplayer-button',  tape: COLORS.purple },
  { label: 'Level Editor', to: '/editor',      tape: COLORS.pink },
  { label: 'My Replays',   to: '/replays',     tape: COLORS.green },
]

export default function Home() {
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Phone: tighten the sticky-note column so title + 4 notes + settings all
  // fit without scrolling, and respect the notch/home-indicator insets.
  const isNarrow = useIsNarrow()

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

      <div style={{ ...buttonRow, ...(isNarrow ? buttonRowNarrow : {}) }}>
        {MENU.map((item, i) => (
          <Link key={item.to} to={item.to} style={{ textDecoration: 'none' }}>
            <button
              data-testid={item.testId}
              className="paper-btn"
              style={{
                ...paperBtn,
                ...(item.hero ? kidsHeroBtn : null),
                ...(isNarrow && !item.hero ? menuBtnNarrow : null),
                transform: `rotate(${tilts[i]}deg)`,
              }}
            >
              <span
                style={{
                  ...tapeStrip,
                  background: item.tape,
                  // Wider / taller tape on the Kids hero sticky note.
                  ...(item.hero
                    ? { width: '68%', height: 18, top: -12 }
                    : null),
                }}
              />
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
        <span style={{ ...tapeStrip, background: COLORS.yellow }} />
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
  top: 'calc(4vh + var(--safe-area-top, 0px))',
  left: 'calc(32px + var(--safe-area-left, 0px))',
  transform: 'rotate(-2deg)',
  transformOrigin: 'left top',
  margin: 0,
  fontSize: 'clamp(43px, 7.2vw, 86px)',
  fontWeight: 900,
  color: COLORS.titleInk,
  textShadow: `5px 5px 0 ${COLORS.lavender}, -2px -2px 0 #0a0612, 2px -2px 0 #0a0612, -2px 2px 0 #0a0612, 2px 2px 0 #0a0612`,
  letterSpacing: 1,
  whiteSpace: 'nowrap',
  userSelect: 'none',
}

const buttonRow: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: 'calc(32px + var(--safe-area-left, 0px))',
  transform: 'translateY(-50%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 40,
  // Keep the stack clear of the home indicator on tall phones / iPad split.
  maxHeight: 'calc(100vh - 120px - var(--safe-area-top, 0px) - var(--safe-area-bottom, 0px))',
}

const buttonRowNarrow: React.CSSProperties = {
  left: 'calc(20px + var(--safe-area-left, 0px))',
  gap: 18,
  // Nudge up a touch so five notes + settings fit on short phones.
  top: '48%',
}

/** Kids Mode hero sticky — bigger than Play, obvious first tap for parents. */
const kidsHeroBtn: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 900,
  padding: '24px 48px 22px',
  minHeight: 64,
  letterSpacing: 0.6,
  // Slightly stronger lavender text-shadow so it pops on cream paper.
  textShadow: '1px 1px 0 rgba(199,125,255,0.55)',
}

/** Compact non-hero menu notes on narrow viewports so the column still fits. */
const menuBtnNarrow: React.CSSProperties = {
  fontSize: 18,
  padding: '14px 28px 12px',
  minHeight: 48,
}

const versionLabel: React.CSSProperties = {
  position: 'absolute',
  bottom: 'calc(12px + var(--safe-area-bottom, 0px))',
  right: 'calc(16px + var(--safe-area-right, 0px))',
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
  bottom: 'calc(24px + var(--safe-area-bottom, 0px))',
  left: 'calc(32px + var(--safe-area-left, 0px))',
  fontSize: 16,
  padding: '12px 22px 10px',
  minHeight: 48,
}
