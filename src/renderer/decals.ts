// Persistent slime splat decals. Round-scoped: cleared whenever the game
// phase leaves 'playing' so every round starts clean. Capped at MAX so a
// long round can't accumulate forever; oldest is dropped when full.

import { Vec2 } from '../physics/vec2'

const MAX_DECALS = 64
const MAX_TRAIL = 80
const TRAIL_LIFE_SEC = 1.4

type SplatKind = 'impact' | 'trail'

interface Splat {
  kind: SplatKind
  x: number
  y: number
  rotation: number
  size: number      // base radius in px
  color: string     // 'r,g,b'
  /** Per-splat random seed used to vary the dripping outline. */
  seed: number
  /** World-space polygon to clip the splat against, so no goop floats past a
   * corner of the surface it landed on. Snapshotted at spawn time. */
  clipPoly: Vec2[] | null
  /** Remaining life in seconds. Trail splats fade out; impact splats keep
   * their visual until the round ends (life = Infinity). */
  life: number
  maxLife: number
}

const decals: Splat[] = []

function hexToRgbCsv(hex: string): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex
  if (h.length < 6) return '255,255,255'
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `${r},${g},${b}`
}

/** Add a slime splat at the contact point. `normal` is the surface normal
 * (points away from the surface) — used to orient the splat. */
export function addSplat(
  pos: Vec2,
  color: string,
  size: number,
  normal: Vec2 = { x: 0, y: -1 },
  clipPoly: Vec2[] | null = null,
): void {
  if (decals.length >= MAX_DECALS) decals.shift() // drop oldest
  // Lay the splat tangent to the surface; the +X local axis points along the
  // surface, +Y away from it (along the normal).
  const rotation = Math.atan2(-normal.x, normal.y)
  // Snapshot the clip polygon so a later in-place mutation by physics can't
  // shift it under us.
  const polySnap = clipPoly ? clipPoly.map(p => ({ x: p.x, y: p.y })) : null
  decals.push({
    kind: 'impact',
    x: pos.x,
    y: pos.y,
    rotation,
    size,
    color: hexToRgbCsv(color),
    seed: Math.random() * 1000,
    clipPoly: polySnap,
    life: Infinity,
    maxLife: Infinity,
  })
}

/** Add a fast-fading trail splat at the blob-ground contact point. Visually
 * smaller and lower-alpha than an impact splat, fades out over ~1.4s. */
export function addTrailSplat(
  pos: Vec2,
  color: string,
  size: number,
  normal: Vec2 = { x: 0, y: -1 },
  clipPoly: Vec2[] | null = null,
): void {
  // Separate cap so a long slide can't evict permanent impact splats.
  let trailCount = 0
  for (let i = 0; i < decals.length; i++) if (decals[i].kind === 'trail') trailCount++
  if (trailCount >= MAX_TRAIL) {
    // Drop the oldest trail splat
    for (let i = 0; i < decals.length; i++) {
      if (decals[i].kind === 'trail') { decals.splice(i, 1); break }
    }
  }
  const rotation = Math.atan2(-normal.x, normal.y)
  const polySnap = clipPoly ? clipPoly.map(p => ({ x: p.x, y: p.y })) : null
  decals.push({
    kind: 'trail',
    x: pos.x,
    y: pos.y,
    rotation,
    size,
    color: hexToRgbCsv(color),
    seed: Math.random() * 1000,
    clipPoly: polySnap,
    life: TRAIL_LIFE_SEC,
    maxLife: TRAIL_LIFE_SEC,
  })
}

/** Age trail splats. Call once per game-loop tick before render. */
export function tickDecals(dt: number): void {
  for (let i = decals.length - 1; i >= 0; i--) {
    const d = decals[i]
    if (d.kind !== 'trail') continue
    d.life -= dt
    if (d.life <= 0) decals.splice(i, 1)
  }
}

/** Render every splat. Call inside the camera transform, BEFORE blobs so
 * blobs sit on top of their own drippings. */
export function renderDecals(ctx: CanvasRenderingContext2D): void {
  for (const d of decals) {
    ctx.save()
    // Clip to the static surface polygon the splat landed on, so goop can
    // never extend past a corner into open air. Set up the clip in world
    // coords BEFORE the splat-local translate/rotate.
    if (d.clipPoly && d.clipPoly.length >= 3) {
      ctx.beginPath()
      ctx.moveTo(d.clipPoly[0].x, d.clipPoly[0].y)
      for (let i = 1; i < d.clipPoly.length; i++) {
        ctx.lineTo(d.clipPoly[i].x, d.clipPoly[i].y)
      }
      ctx.closePath()
      ctx.clip()
    }
    ctx.translate(d.x, d.y)
    ctx.rotate(d.rotation)
    // Main blot — heavily squashed along the surface normal so it reads as
    // flat paint rather than a 3D blob lying on the floor. Trail splats are
    // simpler shapes with a lifetime fade so a sliding blob's wake reads as
    // motion rather than permanent paint.
    const isTrail = d.kind === 'trail'
    const baseAlpha = isTrail ? 0.32 : 0.55
    const lifeFade = isTrail ? Math.max(0, Math.min(1, d.life / d.maxLife)) : 1
    ctx.fillStyle = `rgba(${d.color},${(baseAlpha * lifeFade).toFixed(3)})`
    ctx.beginPath()
    const lobes = isTrail ? 5 : 7
    for (let i = 0; i <= lobes; i++) {
      const t = (i / lobes) * Math.PI * 2
      // Pseudo-random radius per lobe — stable across frames thanks to seed.
      const noise = Math.sin(d.seed + i * 1.7) * 0.35 + Math.cos(d.seed * 0.7 + i * 2.3) * 0.2
      const r = d.size * (0.7 + noise * 0.9)
      const x = Math.cos(t) * r
      // Squash along the surface normal so the splat hugs the surface, but
      // give it real depth so the half clipped inside the platform reads as
      // thick paint, not a sliver.
      const y = Math.sin(t) * r * 0.45
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()

    // Drip satellites — small blots offset along the surface tangent. Seeded
    // so they stay put across frames; one on each side of the main blot.
    // Trail splats skip satellites — they should read as a quick smear, not
    // a permanent splatter.
    const satelliteCount = isTrail ? 0 : 2
    for (let k = 0; k < satelliteCount; k++) {
      const sign = k === 0 ? -1 : 1
      const jitter = Math.sin(d.seed * 0.31 + k * 7.3)
      const tx = sign * d.size * (1.1 + 0.5 * Math.abs(jitter))
      const ty = d.size * 0.05 * Math.sin(d.seed * 0.91 + k * 2.7)
      const dr = d.size * (0.18 + 0.14 * Math.abs(Math.cos(d.seed * 0.47 + k * 3.1)))
      ctx.beginPath()
      ctx.ellipse(tx, ty, dr, dr * 1.35, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }
}

/** Drop every splat. Call between rounds. */
export function clearDecals(): void {
  decals.length = 0
}

export function decalCount(): number {
  return decals.length
}
