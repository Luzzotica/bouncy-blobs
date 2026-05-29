// Persistent slime splat decals. Round-scoped: cleared whenever the game
// phase leaves 'playing' so every round starts clean. Capped at MAX so a
// long round can't accumulate forever; oldest is dropped when full.
//
// Splats can be anchored to a surface so they follow it:
//   - 'platform' : translation-only follow of a kinematic static surface
//                  (current PlatformMover only translates platforms, never
//                  rotates them — change here if that ever stops being true)
//   - 'hull'     : lerp between two soft-body hull particles plus a
//                  perpendicular offset; rotation aligns with the edge so
//                  the splat re-orients as the hull deforms
//   - 'world'    : pinned to absolute world coords (default / legacy)
//
// The renderer resolves anchors at draw time via a module-level lookup
// registry (`setDecalResolvers`) so callers don't have to thread args
// through every render call.

import { Vec2 } from '../physics/vec2'

const MAX_DECALS = 64
const MAX_TRAIL = 80
const TRAIL_LIFE_SEC = 1.4

type SplatKind = 'impact' | 'trail'

export type SplatAnchor =
  | { kind: 'world' }
  /** Local-frame offset against a moving platform's live position. */
  | { kind: 'platform'; platformId: string; lx: number; ly: number; rot: number }
  /** Two adjacent hull particles + lerp factor (t∈[0,1]) + signed perpendicular
   *  offset. Splat sits at lerp(posA, posB, t) + perp * perpOffset, and
   *  rotates with the edge so a deforming hull carries the splat with it. */
  | { kind: 'hull'; idxA: number; idxB: number; t: number; perpOffset: number }

interface Splat {
  kind: SplatKind
  /** World coords if anchor.kind === 'world'; otherwise stale fallback. */
  x: number
  y: number
  rotation: number
  size: number      // base radius in px
  color: string     // 'r,g,b'
  /** Per-splat random seed used to vary the dripping outline. */
  seed: number
  /** World-space polygon to clip the splat against — captured for 'world'
   * anchors; resolved at render time for 'platform' anchors; absent for
   * 'hull' anchors (the splat is small enough that overflow is invisible). */
  clipPoly: Vec2[] | null
  anchor: SplatAnchor
  /** Remaining life in seconds. Trail splats fade out; impact splats keep
   * their visual until the round ends (life = Infinity). */
  life: number
  maxLife: number
}

const decals: Splat[] = []

// ── Resolver registry ─────────────────────────────────────────────────────
// Wired once by the game/sandbox initialiser. renderDecals reads from this
// to resolve `platform` / `hull` anchors to live world coordinates. Setting
// undefined leaves the resolver disabled (splats fall back to stale coords).

export interface DecalResolvers {
  /** Live world position of a platform by id (PlatformMover.getLivePosition). */
  getPlatformLivePos?: (id: string) => { x: number; y: number } | null
  /** Live world polygon of a platform by id (for clipping moving splats). */
  getPlatformLivePoly?: (id: string) => Vec2[] | null
  /** Live world position of a soft-body particle by global index. */
  getParticlePos?: (idx: number) => Vec2 | null
}

let resolvers: DecalResolvers = {}

export function setDecalResolvers(r: DecalResolvers): void {
  resolvers = r
}

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
  anchor: SplatAnchor = { kind: 'world' },
): void {
  if (decals.length >= MAX_DECALS) {
    // Drop oldest IMPACT splat (not a trail) so a long slide can't evict
    // permanent splatter.
    for (let i = 0; i < decals.length; i++) {
      if (decals[i].kind === 'impact') { decals.splice(i, 1); break }
    }
    if (decals.length >= MAX_DECALS) decals.shift()
  }
  // Lay the splat tangent to the surface; the +X local axis points along the
  // surface, +Y away from it (along the normal).
  const rotation = Math.atan2(-normal.x, normal.y)
  // Snapshot the clip polygon for world-anchored splats so a later in-place
  // mutation by physics can't shift it under us. For platform-anchored
  // splats the clip is resolved live at render time from the resolver.
  const polySnap = anchor.kind === 'world' && clipPoly ? clipPoly.map(p => ({ x: p.x, y: p.y })) : null
  decals.push({
    kind: 'impact',
    x: pos.x,
    y: pos.y,
    rotation,
    size,
    color: hexToRgbCsv(color),
    seed: Math.random() * 1000,
    clipPoly: polySnap,
    anchor,
    life: Infinity,
    maxLife: Infinity,
  })
}

/** Add a fast-fading trail splat. Smaller + lower-alpha than an impact;
 * fades over ~1.4s. Supports anchors the same way addSplat does. */
export function addTrailSplat(
  pos: Vec2,
  color: string,
  size: number,
  normal: Vec2 = { x: 0, y: -1 },
  clipPoly: Vec2[] | null = null,
  anchor: SplatAnchor = { kind: 'world' },
): void {
  // Separate cap so a long slide can't evict permanent impact splats.
  let trailCount = 0
  for (let i = 0; i < decals.length; i++) if (decals[i].kind === 'trail') trailCount++
  if (trailCount >= MAX_TRAIL) {
    for (let i = 0; i < decals.length; i++) {
      if (decals[i].kind === 'trail') { decals.splice(i, 1); break }
    }
  }
  const rotation = Math.atan2(-normal.x, normal.y)
  const polySnap = anchor.kind === 'world' && clipPoly ? clipPoly.map(p => ({ x: p.x, y: p.y })) : null
  decals.push({
    kind: 'trail',
    x: pos.x,
    y: pos.y,
    rotation,
    size,
    color: hexToRgbCsv(color),
    seed: Math.random() * 1000,
    clipPoly: polySnap,
    anchor,
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

/** Resolve a splat's live world transform + (optional) clip poly from its
 * anchor. Returns null if the anchored entity has gone away — the splat is
 * then skipped this frame (and will be dropped on the next anchor sweep
 * if you wire one; currently we just don't render). */
function resolveSplatTransform(d: Splat): {
  x: number; y: number; rot: number; clipPoly: Vec2[] | null
} | null {
  const a = d.anchor
  if (a.kind === 'world') {
    return { x: d.x, y: d.y, rot: d.rotation, clipPoly: d.clipPoly }
  }
  if (a.kind === 'platform') {
    const pose = resolvers.getPlatformLivePos?.(a.platformId)
    if (!pose) return { x: d.x, y: d.y, rot: d.rotation, clipPoly: d.clipPoly }
    return {
      x: pose.x + a.lx,
      y: pose.y + a.ly,
      rot: a.rot,
      clipPoly: resolvers.getPlatformLivePoly?.(a.platformId) ?? null,
    }
  }
  // hull
  const pa = resolvers.getParticlePos?.(a.idxA)
  const pb = resolvers.getParticlePos?.(a.idxB)
  if (!pa || !pb) return null
  const ex = pb.x - pa.x
  const ey = pb.y - pa.y
  const len = Math.hypot(ex, ey) || 1
  const ux = ex / len
  const uy = ey / len
  // perpendicular pointing OUTWARD by convention (consistent with how the
  // detector picks perpOffset): rotate edge tangent +90° → (-uy, ux)
  const px = -uy
  const py = ux
  const baseX = pa.x + ex * a.t
  const baseY = pa.y + ey * a.t
  return {
    x: baseX + px * a.perpOffset,
    y: baseY + py * a.perpOffset,
    // Splat's +X axis aligns with edge tangent, +Y along its outward normal
    // (matches the static-surface convention in atan2(-n.x, n.y)).
    rot: Math.atan2(-px, py),
    clipPoly: null,
  }
}

/** Render every splat. Call inside the camera transform, BEFORE blobs so
 * blobs sit on top of their own drippings. */
export function renderDecals(ctx: CanvasRenderingContext2D): void {
  for (const d of decals) {
    const t = resolveSplatTransform(d)
    if (!t) continue  // anchor entity is gone

    ctx.save()
    // Clip to the surface polygon (if any) BEFORE the splat-local transform.
    if (t.clipPoly && t.clipPoly.length >= 3) {
      ctx.beginPath()
      ctx.moveTo(t.clipPoly[0].x, t.clipPoly[0].y)
      for (let i = 1; i < t.clipPoly.length; i++) {
        ctx.lineTo(t.clipPoly[i].x, t.clipPoly[i].y)
      }
      ctx.closePath()
      ctx.clip()
    }
    ctx.translate(t.x, t.y)
    ctx.rotate(t.rot)
    // Main blot — heavily squashed along the surface normal so it reads as
    // flat paint rather than a 3D blob lying on the floor. Trail splats are
    // simpler shapes with a lifetime fade so a sliding blob's wake reads as
    // motion rather than permanent paint.
    const isTrail = d.kind === 'trail'
    // Hull-anchored splats lack a clip polygon (the soft body deforms every
    // frame), so they're drawn smaller + tighter + drip-free to avoid
    // visible overflow past the silhouette as the hull jiggles.
    const isHull = d.anchor.kind === 'hull'
    const baseAlpha = isTrail ? 0.32 : 0.55
    const lifeFade = isTrail ? Math.max(0, Math.min(1, d.life / d.maxLife)) : 1
    ctx.fillStyle = `rgba(${d.color},${(baseAlpha * lifeFade).toFixed(3)})`
    ctx.beginPath()
    const lobes = isTrail ? 5 : (isHull ? 6 : 7)
    // Hull splats are slightly tighter than landing splats — less ragged
    // outline and flatter Y profile so overflow past the deforming
    // silhouette stays minimal without being invisible.
    const radiusBias = isHull ? 0.7 : 0.7
    const radiusVar = isHull ? 0.55 : 0.9
    const ySquash = isHull ? 0.36 : 0.45
    for (let i = 0; i <= lobes; i++) {
      const th = (i / lobes) * Math.PI * 2
      const noise = Math.sin(d.seed + i * 1.7) * 0.35 + Math.cos(d.seed * 0.7 + i * 2.3) * 0.2
      const r = d.size * (radiusBias + noise * radiusVar)
      const x = Math.cos(th) * r
      const y = Math.sin(th) * r * ySquash
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()

    // Drip satellites — small blots offset along the surface tangent.
    // Trail + hull splats skip satellites (trails are too brief, hull splats
    // can't be clipped to the deforming silhouette).
    const satelliteCount = (isTrail || isHull) ? 0 : 2
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
