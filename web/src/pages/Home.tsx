import { Link } from 'react-router-dom'

export default function Home() {
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
          <button style={{ fontSize: 20, padding: '14px 32px', background: '#c77dff' }}>
            Host Game
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
    </div>
  )
}
