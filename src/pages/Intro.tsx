import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { markIntroSeen } from '../utils/introSeen'
import { startMusic, pauseMusic, resumeMusic } from '../utils/music'
import { getSfxVolume } from '../utils/audioSettings'

interface Panel {
  image: string
  gridArea: string
}

// Per-image crop bias for object-fit: cover. Generation is the Python
// script's job; how an image happens to be framed in its grid cell is a
// presentation concern and lives here. Default is "center".
const PANEL_OBJECT_POSITION: Record<string, string> = {
  'p1a.png': 'center 30%',
  'p1b.png': 'center 30%',
  'p1c.png': 'center top',
  'ponder_a.png': 'center 10%',
  'p4a.png': 'center 60%',
  'p4b.png': 'center top',
  'p4c.png': 'center top',
}

interface Page {
  index: number
  title: string
  sfx: string
  gridTemplate: string
  panels: Panel[]
}

interface Manifest {
  music: string
  pages: Page[]
}

const BASE = '/intro/'
const PAGE_DURATION_MS = 24000
const PANEL_STAGGER_MS = 250
const CONTROLS_HIDE_MS = 4000
// Toggle filename overlays in each panel for debugging / iteration.
const SHOW_PANEL_LABELS = false

export default function Intro() {
  const navigate = useNavigate()
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [started, setStarted] = useState(false)
  const [pageIdx, setPageIdx] = useState(0)
  const [controlsVisible, setControlsVisible] = useState(false)
  const [paused, setPaused] = useState(false)
  const sfxRef = useRef<HTMLAudioElement | null>(null)
  const advanceRef = useRef<number | null>(null)
  const hideControlsRef = useRef<number | null>(null)
  // Track how much of the current page's auto-advance has elapsed so we
  // can pause and resume without losing time.
  const pageStartRef = useRef<number>(0)
  const remainingMsRef = useRef<number>(PAGE_DURATION_MS)

  useEffect(() => {
    let cancelled = false
    fetch(`${BASE}manifest.json`)
      .then(r => r.json())
      .then(async (m: Manifest) => {
        if (cancelled) return
        const urls = Array.from(
          new Set(m.pages.flatMap(p => p.panels.map(panel => `${BASE}${panel.image}`))),
        )
        await Promise.all(
          urls.map(
            url =>
              new Promise<void>(resolve => {
                const img = new Image()
                img.onload = () => resolve()
                img.onerror = () => resolve()
                img.src = url
              }),
          ),
        )
        if (cancelled) return
        setManifest(m)
        startMusic()
        setStarted(true)
      })
      .catch(err => {
        console.error('Failed to load intro manifest', err)
        finish()
      })
    return () => {
      cancelled = true
      if (advanceRef.current) window.clearTimeout(advanceRef.current)
      if (hideControlsRef.current) window.clearTimeout(hideControlsRef.current)
      sfxRef.current?.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!manifest || !started) return
    const page = manifest.pages[pageIdx]
    if (!page) {
      finish()
      return
    }

    sfxRef.current?.pause()
    const sfx = new Audio(`${BASE}${page.sfx}`)
    sfx.volume = getSfxVolume()
    sfxRef.current = sfx
    sfx.play().catch(() => {})

    pageStartRef.current = Date.now()
    remainingMsRef.current = PAGE_DURATION_MS
    scheduleAdvance(PAGE_DURATION_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, started, pageIdx])

  function scheduleAdvance(ms: number) {
    if (advanceRef.current) window.clearTimeout(advanceRef.current)
    advanceRef.current = window.setTimeout(() => {
      if (!manifest) return
      if (pageIdx < manifest.pages.length - 1) {
        setPageIdx(i => i + 1)
      } else {
        finish()
      }
    }, ms)
  }

  function showControls() {
    setControlsVisible(true)
    if (hideControlsRef.current) window.clearTimeout(hideControlsRef.current)
    if (!paused) {
      hideControlsRef.current = window.setTimeout(() => {
        setControlsVisible(false)
      }, CONTROLS_HIDE_MS)
    }
  }

  function handleStageClick() {
    if (!started) return
    showControls()
  }

  function handlePauseToggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (paused) {
      // resume
      setPaused(false)
      resumeMusic()
      sfxRef.current?.play().catch(() => {})
      pageStartRef.current = Date.now()
      scheduleAdvance(remainingMsRef.current)
      if (hideControlsRef.current) window.clearTimeout(hideControlsRef.current)
      hideControlsRef.current = window.setTimeout(() => {
        setControlsVisible(false)
      }, CONTROLS_HIDE_MS)
    } else {
      // pause
      setPaused(true)
      pauseMusic()
      sfxRef.current?.pause()
      if (advanceRef.current) window.clearTimeout(advanceRef.current)
      const elapsed = Date.now() - pageStartRef.current
      remainingMsRef.current = Math.max(0, remainingMsRef.current - elapsed)
      if (hideControlsRef.current) window.clearTimeout(hideControlsRef.current)
    }
  }

  function handleSkip(e: React.MouseEvent) {
    e.stopPropagation()
    finish()
  }

  function finish() {
    if (advanceRef.current) window.clearTimeout(advanceRef.current)
    if (hideControlsRef.current) window.clearTimeout(hideControlsRef.current)
    sfxRef.current?.pause()
    markIntroSeen()
    navigate('/')
  }

  if (!manifest || !started) {
    return <div style={shell} />
  }

  const page = manifest.pages[pageIdx]

  return (
    <div style={shell} onClick={handleStageClick}>
      <ComicPage page={page} key={page.index} />

      <div
        style={{
          ...controlsBar,
          opacity: controlsVisible ? 1 : 0,
          pointerEvents: controlsVisible ? 'auto' : 'none',
        }}
      >
        <button onClick={handlePauseToggle} style={ctrlBtn}>
          {paused ? '▶  Resume' : '❚❚  Pause'}
        </button>
        <button onClick={handleSkip} style={{ ...ctrlBtn, ...skipStyle }}>
          Skip  ▶▶
        </button>
      </div>

      <style>{globalCss}</style>
    </div>
  )
}

function ComicPage({ page }: { page: Page }) {
  const { gridTemplateAreas, gridTemplateRows, gridTemplateColumns } = useMemo(
    () => parseGridTemplate(page.gridTemplate),
    [page.gridTemplate],
  )

  return (
    <div
      className="comic-page"
      style={{
        display: 'grid',
        gridTemplateAreas,
        gridTemplateRows,
        gridTemplateColumns,
        gap: 12,
        width: 'min(98vw, 1800px, calc((100vh - 32px) * 16 / 9))',
        height: 'min(55.125vw, 1012px, calc(100vh - 32px))',
        padding: 12,
        boxSizing: 'border-box',
        background: '#1a0f2e',
        border: '4px solid #0a0612',
        borderRadius: 4,
        boxShadow: '0 12px 60px rgba(199,125,255,0.25)',
      }}
    >
      {page.panels.map((panel, i) => (
        <div
          key={panel.image}
          className="comic-panel"
          style={{
            gridArea: panel.gridArea,
            background: '#000',
            border: '3px solid #0a0612',
            borderRadius: 2,
            overflow: 'hidden',
            animation: `panelIn 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) both`,
            animationDelay: `${i * PANEL_STAGGER_MS}ms`,
            boxShadow: 'inset 0 0 0 1px #2a1a4a',
          }}
        >
          <img
            src={`${BASE}${panel.image}`}
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: PANEL_OBJECT_POSITION[panel.image] ?? 'center',
              display: 'block',
            }}
          />
          {SHOW_PANEL_LABELS && (
            <div style={{
              position: 'absolute',
              bottom: 6,
              left: 6,
              background: 'rgba(0, 0, 0, 0.75)',
              color: '#0f0',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: 3,
              pointerEvents: 'none',
              letterSpacing: 0.3,
            }}>{panel.image}</div>
          )}
        </div>
      ))}
    </div>
  )
}

function parseGridTemplate(template: string): {
  gridTemplateAreas: string
  gridTemplateRows: string
  gridTemplateColumns: string
} {
  const [rowsPart, colsPart] = template.split('/').map(s => s.trim())
  const tokens = rowsPart.match(/"[^"]+"|\S+/g) ?? []
  const areas: string[] = []
  const rows: string[] = []
  for (const t of tokens) {
    if (t.startsWith('"')) areas.push(t)
    else rows.push(t)
  }
  return {
    gridTemplateAreas: areas.join(' '),
    gridTemplateRows: rows.join(' '),
    gridTemplateColumns: colsPart,
  }
}

const shell: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'radial-gradient(ellipse at center, #1a0f2e 0%, #0a0612 70%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
  gap: 12,
  overflow: 'hidden',
  padding: 0,
  boxSizing: 'border-box',
  cursor: 'pointer',
}

const controlsBar: React.CSSProperties = {
  position: 'absolute',
  bottom: 28,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  gap: 12,
  transition: 'opacity 0.25s ease-out',
}

const ctrlBtn: React.CSSProperties = {
  background: 'rgba(10, 6, 18, 0.9)',
  color: '#fffae6',
  border: '2px solid #c77dff',
  borderRadius: 999,
  padding: '12px 28px',
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: 0.5,
  cursor: 'pointer',
  boxShadow: '0 4px 24px rgba(199,125,255,0.4)',
}

const skipStyle: React.CSSProperties = {
  borderColor: '#5a189a',
  color: '#cdb4f0',
}

const globalCss = `
  @keyframes panelIn {
    from { opacity: 0; transform: scale(0.94) translateY(8px); filter: blur(4px); }
    to { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
  }
  .comic-page { animation: pageIn 0.5s ease-out both; }
  @keyframes pageIn { from { opacity: 0; } to { opacity: 1; } }
`
