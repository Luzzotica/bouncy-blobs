import React, { useEffect, useRef, useState } from 'react';
import { playSfx } from '../utils/audio';

interface GameMenuProps {
  /** Leave the match entirely and return to the home menu. */
  onExit: () => void;
  /** Return to the lobby (host ends the round; guest goes back to the list). */
  onBackToLobby: () => void;
  /** Label for the "back to lobby" action — host & guest word it differently. */
  backToLobbyLabel?: string;
}

/**
 * In-game "Menu" button + popup for multiplayer. Mirrors the single-player
 * PauseMenu's cream-paper slam/rip presentation (drops in from the sky, tape
 * strip, matching buttons + open/close SFX) so both feel like the same game.
 * Offers the two ways out of a match: drop back to the lobby, or fully exit.
 */
export default function GameMenu({ onExit, onBackToLobby, backToLobbyLabel = 'Back to lobby' }: GameMenuProps) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      setVisible(true);
      setClosing(false);
      if (!wasOpenRef.current) playSfx('ui-modal-open', { volume: 0.6 });
    } else if (visible) {
      setClosing(true);
      if (wasOpenRef.current) playSfx('ui-modal-close', { volume: 0.5 });
    }
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleAnimEnd() {
    if (closing) {
      setVisible(false);
      setClosing(false);
    }
  }

  return (
    <>
      <button
        className="bb-hover-btn"
        data-testid="game-menu-button"
        onClick={() => setOpen(true)}
        title="Game menu"
        style={menuButton}
      >
        Menu
      </button>

      {visible && (
        <div
          data-testid="game-menu-overlay"
          style={{ ...backdrop, opacity: closing ? 0 : 1, transition: 'opacity 0.25s ease-out' }}
          onClick={() => setOpen(false)}
        >
          <div
            className={closing ? 'modal-paper rip' : 'modal-paper slam'}
            style={modal}
            onClick={(e) => e.stopPropagation()}
            onAnimationEnd={handleAnimEnd}
          >
            <div style={tape} />
            <h2 style={heading}>Menu</h2>

            <button className="bb-hover-btn" data-testid="menu-resume" onClick={() => setOpen(false)} style={primaryBtn}>Resume</button>
            <button
              className="bb-hover-btn"
              data-testid="menu-back-to-lobby"
              onClick={() => { setOpen(false); onBackToLobby(); }}
              style={secondaryBtn}
            >
              {backToLobbyLabel}
            </button>
            <button
              className="bb-hover-btn"
              data-testid="menu-exit-game"
              onClick={() => { setOpen(false); onExit(); }}
              style={quitBtn}
            >
              Exit game
            </button>
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
      )}
    </>
  );
}

const menuButton: React.CSSProperties = {
  position: 'absolute',
  top: 14,
  left: 14,
  zIndex: 20,
  fontSize: 15,
  fontWeight: 800,
  padding: '9px 20px 8px',
  background: '#fffae6',
  color: '#1a0f2e',
  border: '3px solid #0a0612',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
  letterSpacing: 0.5,
  boxShadow: '0 6px 14px rgba(0,0,0,0.35)',
  transform: 'rotate(-2deg)',
};

const backdrop: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(10, 6, 18, 0.7)',
};

const modal: React.CSSProperties = {
  position: 'relative',
  background: '#fffae6',
  color: '#1a0f2e',
  border: '4px solid #0a0612',
  borderRadius: 6,
  padding: '32px 40px 26px',
  minWidth: 300,
  maxWidth: '90vw',
  boxShadow: '0 12px 50px rgba(0,0,0,0.5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

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
};

const heading: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: 28,
  fontWeight: 900,
  textAlign: 'center',
  textShadow: '2px 2px 0 #c77dff',
};

const btnBase: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '13px 20px',
  border: '3px solid #0a0612',
  borderRadius: 4,
  fontSize: 16,
  fontWeight: 800,
  letterSpacing: 0.3,
  cursor: 'pointer',
  fontFamily: 'inherit',
  boxShadow: '0 4px 0 #0a0612, 0 6px 14px rgba(0,0,0,0.3)',
};

const primaryBtn: React.CSSProperties = { ...btnBase, background: '#5a189a', color: '#fffae6' };
const secondaryBtn: React.CSSProperties = { ...btnBase, background: '#fffae6', color: '#1a0f2e' };
const quitBtn: React.CSSProperties = { ...btnBase, background: '#fffae6', color: '#7a1020', fontWeight: 700 };
