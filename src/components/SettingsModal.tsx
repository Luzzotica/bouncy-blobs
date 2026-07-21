import { useEffect, useRef, useState } from 'react'
import {
  getMusicVolume,
  setMusicVolumeSetting,
  getSfxVolume,
  setSfxVolumeSetting,
} from '../utils/audioSettings'
import {
  getColorMode,
  setColorModeSetting,
  getHighContrast,
  setHighContrastSetting,
  getGameTextScale,
  setGameTextScaleSetting,
  getUiTextScale,
  setUiTextScaleSetting,
  GAME_TEXT_MIN,
  GAME_TEXT_MAX,
  UI_TEXT_MIN,
  UI_TEXT_MAX,
} from '../utils/accessibilitySettings'
import { playSfx } from '../utils/audio'
import { assetUrl } from '../utils/assetUrl'
import { COLORS, modalTape } from '../theme/uiTheme'

interface Props {
  open: boolean
  onClose: () => void
  onReplayIntro?: () => void
}

export default function SettingsModal({ open, onClose, onReplayIntro }: Props) {
  const [musicV, setMusicV] = useState(() => getMusicVolume())
  const [sfxV, setSfxV] = useState(() => getSfxVolume())
  const [gameTextV, setGameTextV] = useState(() => getGameTextScale())
  const [uiTextV, setUiTextV] = useState(() => getUiTextScale())
  const [colorblindOn, setColorblindOn] = useState(() => getColorMode() === 'colorblind')
  const [contrastOn, setContrastOn] = useState(() => getHighContrast())
  // visible drives whether we render the DOM at all; closing flips the
  // animation to the rip-off keyframes before we unmount.
  const [visible, setVisible] = useState(open)
  const [closing, setClosing] = useState(false)
  const sfxPreviewRef = useRef<HTMLAudioElement | null>(null)

  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open) {
      setVisible(true)
      setClosing(false)
      setMusicV(getMusicVolume())
      setSfxV(getSfxVolume())
      setGameTextV(getGameTextScale())
      setUiTextV(getUiTextScale())
      setColorblindOn(getColorMode() === 'colorblind')
      setContrastOn(getHighContrast())
      if (!wasOpenRef.current) playSfx('ui-modal-open', { volume: 0.6 })
    } else if (visible) {
      setClosing(true)
      if (wasOpenRef.current) playSfx('ui-modal-close', { volume: 0.5 })
    }
    wasOpenRef.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function handleAnimEnd() {
    if (closing) {
      setVisible(false)
      setClosing(false)
    }
  }

  if (!visible) return null

  function handleMusicChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseInt(e.target.value, 10) / 100
    setMusicV(v)
    setMusicVolumeSetting(v)
  }

  function handleSfxChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseInt(e.target.value, 10) / 100
    setSfxV(v)
    setSfxVolumeSetting(v)
  }

  function handleSfxPreview() {
    sfxPreviewRef.current?.pause()
    const a = new Audio(assetUrl('/intro/page-1.mp3'))
    a.volume = sfxV
    sfxPreviewRef.current = a
    a.play().catch(() => {})
  }

  function handleGameTextChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseInt(e.target.value, 10) / 100
    setGameTextV(v)
    setGameTextScaleSetting(v)
  }

  function handleUiTextChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseInt(e.target.value, 10) / 100
    setUiTextV(v)
    setUiTextScaleSetting(v)
  }

  function handleColorblindToggle() {
    const next = !colorblindOn
    setColorblindOn(next)
    setColorModeSetting(next ? 'colorblind' : 'default')
  }

  function handleContrastToggle() {
    const next = !contrastOn
    setContrastOn(next)
    setHighContrastSetting(next)
  }

  function handleReplay() {
    onClose()
    // Let the rip-off play, then navigate.
    window.setTimeout(() => {
      onReplayIntro?.()
    }, 350)
  }

  return (
    <div
      style={{
        ...backdrop,
        opacity: closing ? 0 : 1,
        transition: 'opacity 0.25s ease-out',
      }}
      onClick={onClose}
    >
      <div
        className={closing ? 'modal-paper rip' : 'modal-paper slam'}
        style={modal}
        onClick={e => e.stopPropagation()}
        onAnimationEnd={handleAnimEnd}
      >
        <div style={tape} />
        <button style={closeBtn} onClick={onClose} aria-label="Close settings">
          ×
        </button>
        <h2 style={heading}>Settings</h2>

        <label style={row}>
          <span style={label}>Music</span>
          <input
            className="bb-range"
            type="range"
            min="0"
            max="100"
            value={Math.round(musicV * 100)}
            onChange={handleMusicChange}
            style={{ ...slider, '--range-fill': `${Math.round(musicV * 100)}%` } as React.CSSProperties}
          />
          <span style={valueText}>{Math.round(musicV * 100)}</span>
        </label>

        <label style={row}>
          <span style={label}>Sound FX</span>
          <input
            className="bb-range"
            type="range"
            min="0"
            max="100"
            value={Math.round(sfxV * 100)}
            onChange={handleSfxChange}
            onMouseUp={handleSfxPreview}
            onTouchEnd={handleSfxPreview}
            style={{ ...slider, '--range-fill': `${Math.round(sfxV * 100)}%` } as React.CSSProperties}
          />
          <span style={valueText}>{Math.round(sfxV * 100)}</span>
        </label>

        <p style={hint}>Release the SFX slider to hear a preview.</p>

        <div style={sectionTitle}>Accessibility</div>

        <label style={row}>
          <span style={label}>Game text</span>
          <input
            className="bb-range"
            type="range"
            min={Math.round(GAME_TEXT_MIN * 100)}
            max={Math.round(GAME_TEXT_MAX * 100)}
            value={Math.round(gameTextV * 100)}
            onChange={handleGameTextChange}
            style={{ ...slider, '--range-fill': rangeFill(gameTextV, GAME_TEXT_MIN, GAME_TEXT_MAX) } as React.CSSProperties}
          />
          <span style={valueText}>{Math.round(gameTextV * 100)}%</span>
        </label>

        <label style={row}>
          <span style={label}>UI text</span>
          <input
            className="bb-range"
            type="range"
            min={Math.round(UI_TEXT_MIN * 100)}
            max={Math.round(UI_TEXT_MAX * 100)}
            value={Math.round(uiTextV * 100)}
            onChange={handleUiTextChange}
            style={{ ...slider, '--range-fill': rangeFill(uiTextV, UI_TEXT_MIN, UI_TEXT_MAX) } as React.CSSProperties}
          />
          <span style={valueText}>{Math.round(uiTextV * 100)}%</span>
        </label>

        <label style={row}>
          <span style={label}>Colorblind</span>
          <button
            type="button"
            role="switch"
            aria-checked={colorblindOn}
            onClick={handleColorblindToggle}
            style={toggleBtn(colorblindOn)}
          >
            {colorblindOn ? 'On' : 'Off'}
          </button>
          <span />
        </label>

        <label style={row}>
          <span style={label}>Contrast</span>
          <button
            type="button"
            role="switch"
            aria-checked={contrastOn}
            onClick={handleContrastToggle}
            style={toggleBtn(contrastOn)}
          >
            {contrastOn ? 'High' : 'Normal'}
          </button>
          <span />
        </label>

        <p style={hint}>
          Colorblind swaps player colors for a colorblind-safe palette. High
          contrast boosts outlines and flattens the background.
        </p>

        {onReplayIntro && (
          <button onClick={handleReplay} style={replayBtn}>
            ↻  Replay intro
          </button>
        )}
      </div>

      <style>{`
        @keyframes modal-slam-in {
          0%   { transform: translateY(-160vh) rotate(-9deg); opacity: 0; }
          55%  { transform: translateY(24px) rotate(3deg);    opacity: 1; }
          72%  { transform: translateY(-10px) rotate(-1.8deg); }
          86%  { transform: translateY(5px) rotate(0.6deg);    }
          100% { transform: translateY(0) rotate(0deg);        }
        }
        @keyframes modal-rip-off {
          0%   { transform: translateY(0) rotate(0deg) skewX(0deg);    opacity: 1; }
          20%  { transform: translateY(-24px) rotate(5deg) skewX(-2deg); opacity: 1; }
          100% { transform: translateY(-160vh) rotate(14deg) skewX(-4deg); opacity: 0; }
        }
        .modal-paper {
          transform-origin: 50% 0%;
        }
        .modal-paper.slam {
          animation: modal-slam-in 0.55s cubic-bezier(0.34, 1.56, 0.5, 1) both;
        }
        .modal-paper.rip {
          animation: modal-rip-off 0.35s cubic-bezier(0.5, 0, 0.75, 0) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .modal-paper.slam { animation: none; }
          .modal-paper.rip  { animation: none; opacity: 0; }
        }
      `}</style>
    </div>
  )
}

const backdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(10, 6, 18, 0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 200,
}

const modal: React.CSSProperties = {
  position: 'relative',
  background: COLORS.paper,
  color: COLORS.ink,
  border: '4px solid #0a0612',
  borderRadius: 6,
  padding: '32px 40px 24px',
  minWidth: 380,
  maxWidth: '90vw',
  boxShadow: '0 12px 50px rgba(0,0,0,0.5)',
}

// Masking tape — theme-aware (hidden in the cave theme).
const tape: React.CSSProperties = modalTape

const closeBtn: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 12,
  background: 'transparent',
  border: 'none',
  color: COLORS.ink,
  fontSize: 28,
  fontWeight: 900,
  cursor: 'pointer',
  lineHeight: 1,
}

const heading: React.CSSProperties = {
  margin: '0 0 20px',
  fontSize: 28,
  fontWeight: 900,
  textAlign: 'center',
  textShadow: `2px 2px 0 ${COLORS.lavender}`,
}

/** Position of `v` within [min, max] as a CSS percentage — drives the
 * bb-range filled-track gradient for the non-0-based scale sliders. */
function rangeFill(v: number, min: number, max: number): string {
  return `${Math.round(((v - min) / (max - min)) * 100)}%`
}

const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '100px 1fr 44px',
  alignItems: 'center',
  gap: 12,
  margin: '14px 0',
  fontSize: 16,
  fontWeight: 700,
}

const sectionTitle: React.CSSProperties = {
  margin: '18px 0 2px',
  fontSize: 13,
  fontWeight: 900,
  letterSpacing: 1.2,
  textTransform: 'uppercase',
  color: COLORS.inkDim,
  textAlign: 'center',
}

const toggleBtn = (on: boolean): React.CSSProperties => ({
  justifySelf: 'start',
  minWidth: 88,
  padding: '7px 16px',
  background: on ? COLORS.purple : 'transparent',
  color: on ? COLORS.onAccent : COLORS.ink,
  border: '3px solid #0a0612',
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 800,
  letterSpacing: 0.3,
  cursor: 'pointer',
  boxShadow: on ? '0 3px 0 #0a0612' : 'none',
})

const label: React.CSSProperties = {
  textAlign: 'right',
}

const slider: React.CSSProperties = {
  width: '100%',
  accentColor: COLORS.lavender,
  cursor: 'pointer',
}

const valueText: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  textAlign: 'right',
}

const hint: React.CSSProperties = {
  margin: '12px 0 16px',
  fontSize: 12,
  color: COLORS.inkDim,
  textAlign: 'center',
  fontStyle: 'italic',
}

const replayBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 8,
  padding: '12px 20px',
  background: COLORS.purple,
  color: COLORS.onAccent,
  border: '3px solid #0a0612',
  borderRadius: 4,
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: 0.3,
  cursor: 'pointer',
  boxShadow: '0 4px 0 #0a0612, 0 6px 14px rgba(0,0,0,0.3)',
}

