import { useRef, useEffect, type ReactNode } from 'react'
import { assetUrl } from '../utils/assetUrl'
import { isCave, CAVE_BG_BOTTOM } from '../renderer/colors'
import { drawGameBackground } from '../renderer/backgroundRenderer'
import { createMenuBlobSim, type MenuBlobSim } from '../renderer/menuBlobs'

// Shared menu backdrop: the cream-paper/purple parallax hero used by the
// home page. Extracted so the Multiplayer page (and any future menu screen)
// renders the EXACT same background instead of a drifting copy.
//
// Cave theme swaps the candy hero for the SAME procedural cavern the game
// draws in-match — a live canvas of parallax stalactites + columns, gently
// drifting on its own with a little mouse parallax, so the menu feels like
// you're standing in the cave.
//
// Children render on top of the bg + overlay. Position them however you like
// (Home lays its title/buttons out absolutely; Multiplayer uses a flex
// content wrapper).

// How much (in %) the background drifts at the extreme edges of the
// viewport. The full -0.5..+0.5 normalized mouse range moves the bg by
// ±BG_PARALLAX_AMP%.
const BG_PARALLAX_AMP = 1.5
// Baseline vertical shift of the bg layer (in %). Parallax drifts around it.
const BG_BIAS_Y = 0

export default function HomeBackground({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  const bgRef = useRef<HTMLDivElement>(null)
  const bgCanvasRef = useRef<HTMLCanvasElement>(null)
  const fgCanvasRef = useRef<HTMLCanvasElement>(null)
  const mouse = useRef({ x: 0, y: 0 })
  const simRef = useRef<MenuBlobSim | null>(null)

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const { innerWidth, innerHeight } = window
    const nx = e.clientX / innerWidth - 0.5
    const ny = e.clientY / innerHeight - 0.5
    mouse.current = { x: nx, y: ny }
    if (!isCave && bgRef.current) {
      // Inverted on both axes: bg drifts opposite the cursor for a
      // "looking around" feel, on top of the BG_BIAS_Y baseline.
      bgRef.current.style.transform =
        `translate(${-nx * BG_PARALLAX_AMP}%, ${BG_BIAS_Y - ny * BG_PARALLAX_AMP}%)`
    }
  }

  // Cave theme: animate the procedural cavern + blob playground.
  // Two layers: the cavern backdrop (cheap-ish, slow drift → redrawn at ~30fps)
  // and the blobs on their own canvas, cleared and redrawn EVERY frame with the
  // real delta-time so their motion is buttery smooth regardless of bg cost.
  useEffect(() => {
    if (!isCave) return
    const bg = bgCanvasRef.current
    const fg = fgCanvasRef.current
    const bgCtx = bg?.getContext('2d')
    const fgCtx = fg?.getContext('2d')
    if (!bg || !fg || !bgCtx || !fgCtx) return

    let raf = 0
    let t = 0
    let last = performance.now()
    let bgAcc = 1 // >BG_STEP → draw the backdrop on the first frame
    let disposed = false

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const W = Math.floor(window.innerWidth * dpr)
      const H = Math.floor(window.innerHeight * dpr)
      bg.width = W; bg.height = H; bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      fg.width = W; fg.height = H; fgCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      bgAcc = 1 // force a backdrop redraw after the resize cleared it
      simRef.current?.resize(window.innerWidth, window.innerHeight)
    }
    resize()
    window.addEventListener('resize', resize)

    // Spin up the real softbody engine (wasm) once it's ready.
    createMenuBlobSim(window.innerWidth, window.innerHeight)
      .then((sim) => { if (disposed) sim.destroy(); else simRef.current = sim })
      .catch(() => { /* wasm unavailable — backdrop still animates */ })

    const BG_STEP = 1 / 30
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      let dt = (now - last) / 1000
      last = now
      if (dt > 0.05) dt = 0.05 // clamp after a tab-away so nothing teleports
      t += dt
      const w = window.innerWidth
      const h = window.innerHeight

      // Backdrop — slow drift, ~30fps is plenty and keeps CPU down.
      bgAcc += dt
      if (bgAcc >= BG_STEP) {
        bgAcc = 0
        const camX = t * 12 + mouse.current.x * 180
        const camY = mouse.current.y * 80
        drawGameBackground(bgCtx, { position: { x: camX, y: camY } }, w, h, CAVE_BG_BOTTOM)
      }

      // Blobs — real softbody, stepped + drawn at full framerate.
      fgCtx.clearRect(0, 0, w, h)
      const sim = simRef.current
      if (sim) { sim.update(dt, w, h); sim.draw(fgCtx) }
    }
    raf = requestAnimationFrame(frame)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      const s = simRef.current
      simRef.current = null
      s?.destroy()
    }
  }, [])

  // Grab-and-throw: catch a blob on press, drag it, fling it on release.
  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const sim = simRef.current
    if (sim?.grab(e.clientX, e.clientY)) {
      e.currentTarget.setPointerCapture?.(e.pointerId)
      e.currentTarget.style.cursor = 'grabbing'
    }
  }
  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    mouse.current = { x: e.clientX / window.innerWidth - 0.5, y: e.clientY / window.innerHeight - 0.5 }
    const sim = simRef.current
    if (!sim) return
    if (sim.holding()) sim.moveTo(e.clientX, e.clientY)
    e.currentTarget.style.cursor = sim.holding()
      ? 'grabbing'
      : sim.hitTest(e.clientX, e.clientY) ? 'grab' : 'default'
  }
  function handlePointerUp() {
    simRef.current?.release()
    if (fgCanvasRef.current) fgCanvasRef.current.style.cursor = 'default'
  }

  return (
    <div style={shell} onMouseMove={handleMouseMove} className={`home-shell ${className}`}>
      {isCave ? (
        <>
          <canvas ref={bgCanvasRef} style={caveBgCanvas} />
          <canvas
            ref={fgCanvasRef}
            style={caveCanvas}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={handlePointerUp}
          />
        </>
      ) : (
        <div ref={bgRef} style={bgLayer} className="menu-bg" />
      )}
      <div style={overlay} />
      {children}

      <style>{`
        .home-shell { animation: homeFadeIn 0.7s ease-out both; }
        @keyframes homeFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .home-shell { animation: none; }
        }
        .paper-btn {
          transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1),
                      box-shadow 0.2s ease-out;
        }
        .paper-btn:hover {
          transform: rotate(0deg) scale(1.06) translateY(-4px) !important;
          box-shadow: 0 14px 28px rgba(0,0,0,0.4) !important;
        }
        .paper-btn:active {
          transform: scale(0.98) !important;
        }
        /* Background eases toward the mouse-driven target each frame.
           handleMouseMove sets the transform imperatively; the
           transition smooths jitter. */
        .menu-bg {
          transition: transform 0.4s ease-out;
          will-change: transform;
        }
        @media (prefers-reduced-motion: reduce) {
          .menu-bg { transition: none; }
        }
      `}</style>
    </div>
  )
}

const shell: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: isCave ? CAVE_BG_BOTTOM : '#0a0612',
  overflow: 'hidden',
}

// Cave: full-viewport canvases. Backdrop behind (no pointer events), the blob
// layer on top (receives grab/throw).
const caveBgCanvas: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
}
const caveCanvas: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
}

// Sits behind everything else. Slightly oversized so the BG_BIAS_Y baseline
// + ±BG_PARALLAX_AMP mouse drift don't reveal the page bg.
const bgLayer: React.CSSProperties = {
  position: 'absolute',
  inset: '-2%',
  backgroundImage: `url('${assetUrl('/menu/menu_hero.png')}')`,
  backgroundSize: 'cover',
  backgroundPosition: 'center center',
  backgroundRepeat: 'no-repeat',
  transform: `translate(0%, ${BG_BIAS_Y}%)`,
}

const overlay: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: isCave
    ? 'linear-gradient(180deg, rgba(4,8,20,0.35) 0%, rgba(4,8,20,0) 34%, rgba(4,8,20,0) 60%, rgba(4,8,20,0.7) 100%)'
    : 'linear-gradient(180deg, rgba(10,6,18,0.35) 0%, rgba(10,6,18,0) 30%, rgba(10,6,18,0) 60%, rgba(10,6,18,0.55) 100%)',
  pointerEvents: 'none',
}

// Shared paper-card + tape motif so menu screens stay visually identical.
// Canonical definitions now live in the in-game UI theme module; re-exported
// here for the existing import sites (Home, GameMenu).
export { paperBtn, tapeStrip } from '../theme/uiTheme'
