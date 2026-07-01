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
import { makeScratchCanvas, ScratchCanvas } from './scratchCanvas'

// Impact-splat budget. Was a flat 64, which a crowded match burned through in
// seconds — the oldest splat was then spliced out instantly, so paint visibly
// popped out of existence. Now a much larger, player-count-adaptive budget
// (see `setDecalBudget`) keeps paint around for the whole round, and when the
// budget IS reached the oldest splats fade out gracefully instead of popping.
const DEFAULT_IMPACT_BUDGET = 2048
const MIN_IMPACT_BUDGET = 256
const PER_PLAYER_IMPACT = 256
let impactBudget = DEFAULT_IMPACT_BUDGET
// Hard ceiling on total live splats (active + still-fading) so a burst can't
// grow the array without bound while evicted splats fade.
function hardCeiling(): number { return impactBudget + 512 }

const MAX_TRAIL = 256
const TRAIL_LIFE_SEC = 1.4
/** Seconds an evicted impact splat takes to fade out once it's over budget. */
const EVICT_FADE_SEC = 1.0

/** Set the impact-splat budget from the active player count. More players →
 *  more simultaneous paint sources → a larger budget, clamped to a sane range.
 *  Called by the game when a match starts. */
export function setDecalBudget(playerCount: number): void {
  const want = Math.max(MIN_IMPACT_BUDGET, Math.round(playerCount) * PER_PLAYER_IMPACT)
  impactBudget = Math.min(DEFAULT_IMPACT_BUDGET, want)
}

type SplatKind = 'impact' | 'trail'

export type SplatAnchor =
  | { kind: 'world' }
  /** Local-frame offset against a moving platform's live position. */
  | { kind: 'platform'; platformId: string; lx: number; ly: number; rot: number }
  /** Local-frame offset against a spring pad's live plate position — the plate
   *  translates as it compresses/fires, so the splat rides it. Same shape as
   *  'platform'; separate kind so it resolves via the spring resolver. */
  | { kind: 'spring'; springId: string; lx: number; ly: number; rot: number }
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
  /** Memoized baked sprite for this splat's appearance (resolved once on first
   *  render). `undefined` = not yet resolved; `null` = no offscreen canvas
   *  available, draw procedurally. Appearance is immutable, so this is safe. */
  sprite?: ScratchCanvas | null
}

const decals: Splat[] = []
/** Count of impact splats still at full life (life === Infinity). Excludes
 *  impacts that are mid-fade after eviction. Kept incrementally so the hot
 *  add path doesn't rescan the whole array. */
let activeImpacts = 0

/** Begin fading the oldest still-active impact splat (graceful eviction). The
 *  splat keeps rendering, fading over EVICT_FADE_SEC, then tickDecals drops it. */
function evictOldestImpact(): void {
  for (let i = 0; i < decals.length; i++) {
    const d = decals[i]
    if (d.kind === 'impact' && d.life === Infinity) {
      d.life = EVICT_FADE_SEC
      d.maxLife = EVICT_FADE_SEC
      activeImpacts--
      return
    }
  }
}

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
  /** Live world position of a spring pad's plate by id (moves as it fires). */
  getSpringLivePos?: (id: string) => { x: number; y: number } | null
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
  // Over budget → start fading the oldest splat (it lingers and fades rather
  // than popping). Spawns can briefly outpace fades, so also enforce a hard
  // ceiling that drops the very oldest splat outright to bound memory.
  if (activeImpacts >= impactBudget) evictOldestImpact()
  while (decals.length >= hardCeiling()) {
    const dropped = decals.shift()
    if (dropped && dropped.kind === 'impact' && dropped.life === Infinity) activeImpacts--
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
  activeImpacts++
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

/** Age every finite-life splat — trail splats and impact splats that are
 *  fading out after eviction — and drop them when spent. Permanent impacts
 *  (life === Infinity) are untouched. Call once per game-loop tick before
 *  render. */
export function tickDecals(dt: number): void {
  for (let i = decals.length - 1; i >= 0; i--) {
    const d = decals[i]
    if (d.life === Infinity) continue
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
  if (a.kind === 'spring') {
    // Ride the plate's live position (translation only — springs don't rotate).
    // No clip poly: the plate is small and moves every frame, so an unclipped
    // splat that tracks it reads better than a stale clip.
    const pose = resolvers.getSpringLivePos?.(a.springId)
    if (!pose) return { x: d.x, y: d.y, rot: d.rotation, clipPoly: null }
    return { x: pose.x + a.lx, y: pose.y + a.ly, rot: a.rot, clipPoly: null }
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

// ── Splat shape ────────────────────────────────────────────────────────────
// One drawing routine, used both to bake a sprite once and (fallback) to draw
// procedurally when no offscreen canvas is available. Draws centred on the
// current origin; caller owns translate/rotate/scale and globalAlpha.

type RenderClass = 'impact' | 'hull' | 'trail'

function renderClassOf(d: Splat): RenderClass {
  if (d.kind === 'trail') return 'trail'
  return d.anchor.kind === 'hull' ? 'hull' : 'impact'
}

/** Stamp the slime-splat shape (main blot + drip satellites) at `size`, in the
 *  given color, at the current origin. `alpha` multiplies the whole shape. */
function drawSplatShape(
  ctx: CanvasRenderingContext2D,
  rc: RenderClass,
  size: number,
  colorCsv: string,
  seed: number,
  alpha: number,
): void {
  // Main blot — heavily squashed along the surface normal so it reads as flat
  // paint rather than a 3D blob. Hull splats are tighter/flatter (they can't be
  // clipped to the deforming silhouette); trails are simpler + drip-free.
  ctx.fillStyle = `rgba(${colorCsv},${alpha.toFixed(3)})`
  ctx.beginPath()
  const lobes = rc === 'trail' ? 5 : (rc === 'hull' ? 6 : 7)
  const radiusBias = 0.7
  const radiusVar = rc === 'hull' ? 0.55 : 0.9
  const ySquash = rc === 'hull' ? 0.36 : 0.45
  for (let i = 0; i <= lobes; i++) {
    const th = (i / lobes) * Math.PI * 2
    const noise = Math.sin(seed + i * 1.7) * 0.35 + Math.cos(seed * 0.7 + i * 2.3) * 0.2
    const r = size * (radiusBias + noise * radiusVar)
    const x = Math.cos(th) * r
    const y = Math.sin(th) * r * ySquash
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fill()

  // Drip satellites — small blots offset along the surface tangent. Trail +
  // hull splats skip them (trails are too brief, hull splats jiggle).
  const satelliteCount = rc === 'impact' ? 2 : 0
  for (let k = 0; k < satelliteCount; k++) {
    const sign = k === 0 ? -1 : 1
    const jitter = Math.sin(seed * 0.31 + k * 7.3)
    const tx = sign * size * (1.1 + 0.5 * Math.abs(jitter))
    const ty = size * 0.05 * Math.sin(seed * 0.91 + k * 2.7)
    const dr = size * (0.18 + 0.14 * Math.abs(Math.cos(seed * 0.47 + k * 3.1)))
    ctx.beginPath()
    ctx.ellipse(tx, ty, dr, dr * 1.35, 0, 0, Math.PI * 2)
    ctx.fill()
  }
}

// ── Sprite cache ───────────────────────────────────────────────────────────
// The bottleneck for thousands of splats is per-frame path tessellation. So we
// bake each distinct splat appearance to a small offscreen canvas ONCE and just
// drawImage it every frame — render cost is then a cheap blit independent of
// the splat count. Per-splat color/size/fade still vary: color is part of the
// key, size is applied via draw-time scale, and fade via globalAlpha. The
// continuous `seed` is bucketed into a handful of shape variants to keep the
// cache bounded while preserving visible variety. Player colors come from a
// fixed palette, so total entries stay small (≈ classes × colors × variants).

const CANON_SIZE = 40            // bake size; splats scale down to their real size
const SPRITE_HALF = Math.ceil(CANON_SIZE * 2.1) // padding for blot + satellites
const SPRITE_DIM = SPRITE_HALF * 2
const SEED_VARIANTS = 5

const spriteCache = new Map<string, ScratchCanvas | null>()

/** Cached sprite for a splat's (class, color, seed-variant). `null` means the
 *  environment has no offscreen canvas — caller falls back to procedural draw. */
function getSplatSprite(rc: RenderClass, colorCsv: string, variant: number): ScratchCanvas | null {
  const key = `${rc}|${colorCsv}|${variant}`
  let sprite = spriteCache.get(key)
  if (sprite === undefined) {
    sprite = makeScratchCanvas(SPRITE_DIM, SPRITE_DIM)
    if (sprite) {
      sprite.ctx.translate(SPRITE_HALF, SPRITE_HALF)
      // Representative seed for this bucket; baked at full alpha (fade applied
      // per-draw via globalAlpha).
      const repSeed = ((variant + 0.5) / SEED_VARIANTS) * 1000
      drawSplatShape(sprite.ctx, rc, CANON_SIZE, colorCsv, repSeed, 1)
    }
    spriteCache.set(key, sprite)
  }
  return sprite
}

/** Render every splat. Call inside the camera transform, BEFORE blobs so
 * blobs sit on top of their own drippings. Each splat is clipped to the
 * surface it hit (so paint stays on the ground) and drawn from a baked sprite
 * (so the cost is a cheap blit, not a per-frame path tessellation). */
export function renderDecals(ctx: CanvasRenderingContext2D): void {
  for (const d of decals) {
    const t = resolveSplatTransform(d)
    if (!t) continue  // anchor entity is gone

    const rc = renderClassOf(d)
    const baseAlpha = rc === 'trail' ? 0.32 : 0.55
    const lifeFade = d.life === Infinity ? 1 : Math.max(0, Math.min(1, d.life / d.maxLife))
    const alpha = baseAlpha * lifeFade
    if (alpha <= 0) continue

    // Resolve the baked sprite once per splat (appearance is immutable), so the
    // hot path doesn't rebuild a cache key string for every splat every frame.
    if (d.sprite === undefined) {
      const variant = ((d.seed * SEED_VARIANTS / 1000) | 0) % SEED_VARIANTS
      d.sprite = getSplatSprite(rc, d.color, variant)
    }
    const sprite = d.sprite

    ctx.save()
    // Clip to the surface polygon (in WORLD space, BEFORE the splat-local
    // transform) so paint stays ON the floor/wall it hit instead of floating
    // off the edge. Cheaper than the old path because the splat shape itself is
    // now a baked sprite blit rather than a per-frame tessellation.
    const clip = t.clipPoly
    if (clip && clip.length >= 3) {
      ctx.beginPath()
      ctx.moveTo(clip[0].x, clip[0].y)
      for (let i = 1; i < clip.length; i++) ctx.lineTo(clip[i].x, clip[i].y)
      ctx.closePath()
      ctx.clip()
    }
    ctx.translate(t.x, t.y)
    ctx.rotate(t.rot)
    if (sprite) {
      const s = d.size / CANON_SIZE
      ctx.scale(s, s)
      ctx.globalAlpha = alpha
      ctx.drawImage(sprite.image, -SPRITE_HALF, -SPRITE_HALF)
    } else {
      // No offscreen canvas (rare) — draw procedurally.
      drawSplatShape(ctx, rc, d.size, d.color, d.seed, alpha)
    }
    ctx.restore()
  }
}

/** Drop every splat. Call between rounds. (The sprite cache is keyed by
 *  appearance, not by splat, so it persists across rounds.) */
export function clearDecals(): void {
  decals.length = 0
  activeImpacts = 0
}

export function decalCount(): number {
  return decals.length
}
