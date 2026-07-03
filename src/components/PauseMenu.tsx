import React, { useEffect, useRef, useState } from 'react'
import { playSfx } from '../utils/audio'
import { COLORS, modalTape } from '../theme/uiTheme'

interface Props {
  open: boolean
  onResume: () => void
  onSettings: () => void
  onQuit: () => void
}

/** Single-player pause menu: Resume / Settings / Quit. Settings live in their
 * own SettingsModal so the two are separate modals. Mirrors SettingsModal's
 * cream-paper slam/rip presentation for a consistent feel. */
export default function PauseMenu({ open, onResume, onSettings, onQuit }: Props) {
  const [visible, setVisible] = useState(open)
  const [closing, setClosing] = useState(false)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (open) {
      setVisible(true)
      setClosing(false)
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

  return (
    <div
      style={{ ...backdrop, opacity: closing ? 0 : 1, transition: 'opacity 0.25s ease-out' }}
      onClick={onResume}
    >
      <div
        className={closing ? 'modal-paper rip' : 'modal-paper slam'}
        style={modal}
        onClick={e => e.stopPropagation()}
        onAnimationEnd={handleAnimEnd}
      >
        <div style={tape} />
        <h2 style={heading}>Paused</h2>

        <button className="bb-hover-btn" onClick={onResume} style={primaryBtn}>Resume</button>
        <button className="bb-hover-btn" onClick={onSettings} style={secondaryBtn}>Settings</button>
        <button className="bb-hover-btn" onClick={onQuit} style={quitBtn}>Quit</button>
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
        .modal-paper { transform-origin: 50% 0%; }
        .modal-paper.slam { animation: modal-slam-in 0.55s cubic-bezier(0.34, 1.56, 0.5, 1) both; }
        .modal-paper.rip  { animation: modal-rip-off 0.35s cubic-bezier(0.5, 0, 0.75, 0) both; }
        @media (prefers-reduced-motion: reduce) {
          .modal-paper.slam { animation: none; }
          .modal-paper.rip  { animation: none; opacity: 0; }
        }
      `}</style>
    </div>
  )
}

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(10, 6, 18, 0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
}

const modal: React.CSSProperties = {
  position: 'relative', background: COLORS.paper, color: COLORS.ink,
  border: '4px solid #0a0612', borderRadius: 6, padding: '32px 40px 26px',
  minWidth: 300, maxWidth: '90vw', boxShadow: '0 12px 50px rgba(0,0,0,0.5)',
  display: 'flex', flexDirection: 'column', gap: 12,
}

const tape: React.CSSProperties = modalTape

const heading: React.CSSProperties = {
  margin: '0 0 8px', fontSize: 28, fontWeight: 900, textAlign: 'center',
  textShadow: `2px 2px 0 ${COLORS.lavender}`,
}

const btnBase: React.CSSProperties = {
  display: 'block', width: '100%', padding: '13px 20px',
  border: '3px solid #0a0612', borderRadius: 4,
  fontSize: 16, fontWeight: 800, letterSpacing: 0.3, cursor: 'pointer',
  boxShadow: '0 4px 0 #0a0612, 0 6px 14px rgba(0,0,0,0.3)',
}

const primaryBtn: React.CSSProperties = { ...btnBase, background: COLORS.purple, color: COLORS.onAccent }
const secondaryBtn: React.CSSProperties = { ...btnBase, background: COLORS.paper, color: COLORS.ink }
const quitBtn: React.CSSProperties = { ...btnBase, background: COLORS.paper, color: COLORS.danger, fontWeight: 700 }
