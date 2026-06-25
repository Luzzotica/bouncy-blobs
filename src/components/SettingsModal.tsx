import { useEffect, useRef, useState } from 'react'
import {
  getMusicVolume,
  setMusicVolumeSetting,
  getSfxVolume,
  setSfxVolumeSetting,
} from '../utils/audioSettings'
import { playSfx } from '../utils/audio'
import { assetUrl } from '../utils/assetUrl'

interface Props {
  open: boolean
  onClose: () => void
  onReplayIntro?: () => void
}

export default function SettingsModal({ open, onClose, onReplayIntro }: Props) {
  const [musicV, setMusicV] = useState(() => getMusicVolume())
  const [sfxV, setSfxV] = useState(() => getSfxVolume())
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
  background: '#fffae6',
  color: '#1a0f2e',
  border: '4px solid #0a0612',
  borderRadius: 6,
  padding: '32px 40px 24px',
  minWidth: 380,
  maxWidth: '90vw',
  boxShadow: '0 12px 50px rgba(0,0,0,0.5)',
}

const tape: React.CSSProperties = {
  position: 'absolute',
  top: -14,
  left: '50%',
  transform: 'translateX(-50%) rotate(-2deg)',
  width: 160,
  height: 28,
  background: 'rgba(200, 180, 120, 0.78)',
  border: '1px solid rgba(120, 100, 60, 0.4)',
  boxShadow: '0 3px 6px rgba(0,0,0,0.2)',
}

const closeBtn: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 12,
  background: 'transparent',
  border: 'none',
  color: '#1a0f2e',
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
  textShadow: '2px 2px 0 #c77dff',
}

const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '90px 1fr 32px',
  alignItems: 'center',
  gap: 12,
  margin: '14px 0',
  fontSize: 16,
  fontWeight: 700,
}

const label: React.CSSProperties = {
  textAlign: 'right',
}

const slider: React.CSSProperties = {
  width: '100%',
  accentColor: '#c77dff',
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
  color: '#555',
  textAlign: 'center',
  fontStyle: 'italic',
}

const replayBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 8,
  padding: '12px 20px',
  background: '#5a189a',
  color: '#fffae6',
  border: '3px solid #0a0612',
  borderRadius: 4,
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: 0.3,
  cursor: 'pointer',
  boxShadow: '0 4px 0 #0a0612, 0 6px 14px rgba(0,0,0,0.3)',
}

