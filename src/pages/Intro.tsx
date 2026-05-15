import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { markIntroSeen } from '../utils/introSeen'

interface Panel {
  image: string
  sfx: string
  caption: string
  durationMs: number
}

interface Manifest {
  music: string
  panels: Panel[]
}

const BASE = '/intro/'

export default function Intro() {
  const navigate = useNavigate()
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [started, setStarted] = useState(false)
  const [index, setIndex] = useState(0)
  const [captionVisible, setCaptionVisible] = useState(false)
  const musicRef = useRef<HTMLAudioElement | null>(null)
  const sfxRef = useRef<HTMLAudioElement | null>(null)
  const advanceTimerRef = useRef<number | null>(null)

  useEffect(() => {
    fetch(`${BASE}manifest.json`)
      .then(r => r.json())
      .then((m: Manifest) => setManifest(m))
      .catch(err => {
        console.error('Failed to load intro manifest', err)
        finish()
      })
    return () => {
      if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current)
      musicRef.current?.pause()
      sfxRef.current?.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!manifest || !started) return
    const panel = manifest.panels[index]
    if (!panel) {
      finish()
      return
    }

    setCaptionVisible(false)
    const captionTimer = window.setTimeout(() => setCaptionVisible(true), 200)

    sfxRef.current?.pause()
    const sfx = new Audio(`${BASE}${panel.sfx}`)
    sfx.volume = 0.8
    sfxRef.current = sfx
    sfx.play().catch(() => {})

    if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current)
    advanceTimerRef.current = window.setTimeout(() => {
      if (index < manifest.panels.length - 1) {
        setIndex(i => i + 1)
      } else {
        finish()
      }
    }, panel.durationMs)

    return () => {
      window.clearTimeout(captionTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, started, index])

  function start() {
    if (!manifest) return
    const music = new Audio(`${BASE}${manifest.music}`)
    music.loop = true
    music.volume = 0.5
    musicRef.current = music
    music.play().catch(() => {})
    setStarted(true)
  }

  function next() {
    if (!manifest) return
    if (index < manifest.panels.length - 1) {
      setIndex(i => i + 1)
    } else {
      finish()
    }
  }

  function finish() {
    if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current)
    musicRef.current?.pause()
    sfxRef.current?.pause()
    markIntroSeen()
    navigate('/')
  }

  if (!manifest) {
    return (
      <div style={fullscreen}>
        <p style={{ color: '#888' }}>Loading…</p>
      </div>
    )
  }

  if (!started) {
    return (
      <div style={fullscreen}>
        <h1 style={{ fontSize: 56, fontWeight: 800, marginBottom: 16 }}>Bouncy Blobs</h1>
        <p style={{ color: '#aaa', fontSize: 18, marginBottom: 32 }}>A story in six panels.</p>
        <button
          onClick={start}
          style={{
            fontSize: 22,
            padding: '16px 40px',
            background: '#c77dff',
            border: 'none',
            color: 'white',
            borderRadius: 8,
            cursor: 'pointer',
          }}
        >
          ▶ Start
        </button>
      </div>
    )
  }

  const panel = manifest.panels[index]

  return (
    <div style={fullscreen}>
      <button
        onClick={finish}
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          background: 'transparent',
          color: '#aaa',
          border: '1px solid #555',
          borderRadius: 6,
          padding: '8px 14px',
          cursor: 'pointer',
        }}
      >
        Skip ▶▶
      </button>

      <img
        key={panel.image}
        src={`${BASE}${panel.image}`}
        alt={panel.caption}
        style={{
          maxWidth: 'min(90vw, 720px)',
          maxHeight: '70vh',
          borderRadius: 12,
          boxShadow: '0 8px 40px rgba(199,125,255,0.25)',
          animation: 'introPanelIn 0.4s ease-out',
        }}
      />

      <p
        style={{
          marginTop: 24,
          fontSize: 28,
          fontWeight: 600,
          color: 'white',
          textAlign: 'center',
          maxWidth: '90vw',
          opacity: captionVisible ? 1 : 0,
          transition: 'opacity 0.5s ease-in',
          minHeight: 40,
        }}
      >
        {panel.caption}
      </p>

      <div style={{ marginTop: 24, display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ color: '#666', fontSize: 14 }}>
          {index + 1} / {manifest.panels.length}
        </span>
        <button
          onClick={next}
          style={{
            fontSize: 18,
            padding: '10px 24px',
            background: '#5a189a',
            border: 'none',
            color: 'white',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          {index < manifest.panels.length - 1 ? 'Next ▶' : 'Begin ▶'}
        </button>
      </div>

      <style>{`
        @keyframes introPanelIn {
          from { opacity: 0; transform: scale(0.96); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  )
}

const fullscreen: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: '#0a0612',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
}
