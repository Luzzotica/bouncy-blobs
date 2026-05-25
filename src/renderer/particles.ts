// Pooled 2D particle system. One module-level singleton; no per-game-instance
// state. Particles are short-lived gravity-affected dots used for landing
// bursts, puff breaths, sparkles, etc.

import { Vec2 } from '../physics/vec2'

const MAX_PARTICLES = 512
const GRAVITY = 1400 // px/s² — matches the world's downward feel

interface Particle {
  alive: boolean
  x: number
  y: number
  vx: number
  vy: number
  life: number      // seconds remaining
  maxLife: number   // seconds initial
  size: number
  color: string     // 'rgb(r,g,b)' — alpha is computed from life ratio
  gravity: boolean
}

const pool: Particle[] = []
for (let i = 0; i < MAX_PARTICLES; i++) {
  pool.push({
    alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1, color: '#fff', gravity: false,
  })
}
let nextSlot = 0

function spawn(): Particle | null {
  // Round-robin search for an inactive slot. With 512 slots and short
  // lifetimes this is effectively O(1).
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const p = pool[(nextSlot + i) % MAX_PARTICLES]
    if (!p.alive) {
      nextSlot = (nextSlot + i + 1) % MAX_PARTICLES
      return p
    }
  }
  return null // pool exhausted; drop the spawn
}

/** Convert '#rrggbb' or '#rrggbbaa' to 'r,g,b' for use in `rgba(r,g,b,a)`. */
function hexToRgbCsv(hex: string): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex
  if (h.length < 6) return '255,255,255'
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `${r},${g},${b}`
}

/** A burst of N particles emitted from `pos` in a cone aligned with `dir`
 * (unit vector; defaults to upward). Used for landing impacts. */
export function emitBurst(
  pos: Vec2,
  color: string,
  count: number,
  speed: number,
  dir: Vec2 = { x: 0, y: -1 },
  spreadDeg = 100,
): void {
  const rgb = hexToRgbCsv(color)
  const baseAngle = Math.atan2(dir.y, dir.x)
  const spread = (spreadDeg * Math.PI) / 180
  for (let i = 0; i < count; i++) {
    const p = spawn()
    if (!p) return
    const a = baseAngle + (Math.random() - 0.5) * spread
    const s = speed * (0.5 + Math.random() * 0.7)
    p.alive = true
    p.x = pos.x
    p.y = pos.y
    p.vx = Math.cos(a) * s
    p.vy = Math.sin(a) * s
    p.life = 0.45 + Math.random() * 0.35
    p.maxLife = p.life
    p.size = 2 + Math.random() * 3
    p.color = rgb
    p.gravity = true
  }
}

/** A radial puff used when a blob inflates. No gravity, slower, fluffier. */
export function emitPuff(pos: Vec2, color: string, count = 10): void {
  const rgb = hexToRgbCsv(color)
  for (let i = 0; i < count; i++) {
    const p = spawn()
    if (!p) return
    const a = Math.random() * Math.PI * 2
    const s = 70 + Math.random() * 90
    p.alive = true
    p.x = pos.x
    p.y = pos.y
    p.vx = Math.cos(a) * s
    p.vy = Math.sin(a) * s - 30
    p.life = 0.35 + Math.random() * 0.25
    p.maxLife = p.life
    p.size = 3 + Math.random() * 4
    p.color = rgb
    p.gravity = false
  }
}

/** Sparkle ring used for powerup pickup. Fast, small, brief. */
export function emitSparkle(pos: Vec2, color: string, count = 14): void {
  const rgb = hexToRgbCsv(color)
  for (let i = 0; i < count; i++) {
    const p = spawn()
    if (!p) return
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.4
    const s = 220 + Math.random() * 120
    p.alive = true
    p.x = pos.x
    p.y = pos.y
    p.vx = Math.cos(a) * s
    p.vy = Math.sin(a) * s
    p.life = 0.4 + Math.random() * 0.2
    p.maxLife = p.life
    p.size = 2 + Math.random() * 2
    p.color = rgb
    p.gravity = false
  }
}

export function updateParticles(dt: number): void {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const p = pool[i]
    if (!p.alive) continue
    p.life -= dt
    if (p.life <= 0) { p.alive = false; continue }
    if (p.gravity) p.vy += GRAVITY * dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    // Air drag — lighter for non-gravity particles
    const drag = p.gravity ? 0.6 : 1.8
    const k = Math.exp(-drag * dt)
    p.vx *= k
    p.vy *= k
  }
}

/** Render every live particle. Call inside the camera transform. */
export function renderParticles(ctx: CanvasRenderingContext2D): void {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const p = pool[i]
    if (!p.alive) continue
    const a = p.life / p.maxLife
    ctx.fillStyle = `rgba(${p.color},${a.toFixed(3)})`
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Clear every live particle. Call at phase transitions / level reset. */
export function clearParticles(): void {
  for (let i = 0; i < MAX_PARTICLES; i++) pool[i].alive = false
}
