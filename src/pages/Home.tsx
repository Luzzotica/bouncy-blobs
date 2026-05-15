import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { hasSeenIntro, resetIntroSeen } from '../utils/introSeen'

export default function Home() {
  const navigate = useNavigate()

  useEffect(() => {
    if (!hasSeenIntro()) {
      navigate('/intro', { replace: true })
    }
  }, [navigate])

  function replayIntro() {
    resetIntroSeen()
    navigate('/intro')
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: 24,
    }}>
      <h1 style={{ fontSize: 48, fontWeight: 700 }}>Bouncy Blobs</h1>
      <p style={{ color: '#888', fontSize: 18 }}>A soft-body physics party game</p>
      <div style={{ display: 'flex', gap: 16, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link to="/game">
          <button data-testid="host-button" style={{ fontSize: 20, padding: '14px 32px', background: '#c77dff' }}>
            Host
          </button>
        </Link>
        <Link to="/lobbies">
          <button data-testid="browse-button" style={{ fontSize: 20, padding: '14px 32px', background: '#5a189a' }}>
            Browse Lobbies
          </button>
        </Link>
        <Link to="/sandbox">
          <button style={{ fontSize: 20, padding: '14px 32px' }}>Sandbox</button>
        </Link>
        <Link to="/editor">
          <button style={{ fontSize: 20, padding: '14px 32px', background: '#2d6a4f' }}>
            Level Editor
          </button>
        </Link>
      </div>
      <button
        onClick={replayIntro}
        style={{
          marginTop: 12,
          fontSize: 14,
          padding: '6px 14px',
          background: 'transparent',
          color: '#888',
          border: '1px solid #444',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Replay intro
      </button>
    </div>
  )
}
