// Per-frame state-transition detection for SFX + VFX. Owned by
// BouncyBlobsGame and ticked from its game loop. Reads sim state, emits
// sounds and particles. Effects are local-only: every client runs the same
// sim and detects the same transitions, so no networking is needed.

import { Vec2 } from '../physics/vec2'
import { PlayerManager, ManagedPlayer } from './playerManager'
import { playSfx } from '../utils/audio'
import { emitBurst, emitPuff, emitSparkle } from '../renderer/particles'
import { addSplat, addTrailSplat, tickDecals, SplatAnchor } from '../renderer/decals'
import { addBlobImpact, tickBlobImpacts } from '../renderer/blobImpacts'
import { GamePhase } from './gameModes/types'
import { SlimeBlob, BLOB_RADIUS } from '../physics/slimeBlob'

interface BlobTrack {
  prevCentroid: Vec2
  prevVelocity: Vec2
  wasGrounded: boolean
  wasExpanding: boolean
  wasStuck: boolean
  /** Last impact-speed gated SFX time (sec from EffectsBindings start) so we
   * don't double-trigger if grounded toggles for a frame. */
  lastLandAt: number
  /** Last wall/ceiling splat time (sec), used to debounce continuous contact. */
  lastWallSplatAt: number
  /** Last ground-slide trail splat time (sec). */
  lastTrailAt: number
  /** Last impulse-ripple time (sec). */
  lastImpulseAt: number
}

const LAND_MIN_SPEED = 220       // px/s — below this, landing is silent
const LAND_LOUD_SPEED = 1400     // px/s — speed above which volume saturates
const LAND_DECAL_SPEED = 380     // splats only when impact is meaningful
const LAND_DEDUPE_SEC = 0.18
const WALL_SPLAT_DEDUPE_SEC = 0.15
const TRAIL_MIN_SPEED = 140      // px/s — slower than this, no trail
const TRAIL_INTERVAL_SEC = 0.05  // emit a small trail splat at this cadence
// Per-frame velocity-delta threshold for firing an impulse ripple. Tuned to
// fire on jumps, dashes, wall jumps and getting kicked — NOT to fire from
// gravity alone (per-frame gravity Δv at substeps=4 / scale=4 ≈ tens of px/s).
const IMPULSE_DV = 240
const IMPULSE_DEDUPE_SEC = 0.08
// Blob-vs-blob ripple heuristic — fire when hull AABBs touch + closing speed
// > threshold. Pure heuristic (no engine contacts); good enough until the
// shine path needs sub-frame accuracy.
const BLOB_VS_BLOB_MIN_RELSPEED = 110
const BLOB_VS_BLOB_DEDUPE_SEC = 0.16

/** Lightweight per-blob velocity snapshot used by the blob-vs-blob ripple
 * heuristic. Keyed by SlimeBlob.blobId (numeric). */
interface BlobVel { x: number; y: number; vx: number; vy: number }

/** Duck-typed adapter for PlatformMover so EffectsBindings can attach
 * splats to a moving platform without importing the mover directly. */
export interface PlatformLookup {
  findPlatformIdAtPoint(point: { x: number; y: number }, maxDist?: number): string | null
  getLivePosition(platformId: string): { x: number; y: number } | null
}

/** Build a splat anchor for a contact at `point` with surface `normal`.
 * If `platformLookup` knows of a platform under the contact, returns a
 * platform-anchored splat (which will follow the platform as it moves);
 * otherwise falls back to a world-pinned anchor. */
function pickSurfaceAnchor(
  point: { x: number; y: number },
  normal: { x: number; y: number },
  platformLookup: PlatformLookup | undefined,
): SplatAnchor {
  if (!platformLookup) return { kind: 'world' }
  // Use the lookup's default slack (currently 28 px). Contact points sit
  // outside the surface by the engine's collision margin, so a tight slack
  // misses real-but-margin-offset contacts.
  const id = platformLookup.findPlatformIdAtPoint(point)
  if (!id) return { kind: 'world' }
  const pos = platformLookup.getLivePosition(id)
  if (!pos) return { kind: 'world' }
  // Splat rotation in local frame matches the static-surface convention.
  const rot = Math.atan2(-normal.x, normal.y)
  return {
    kind: 'platform',
    platformId: id,
    lx: point.x - pos.x,
    ly: point.y - pos.y,
    rot,
  }
}

/** Distance from a point to the nearest edge of a polygon (closed). Returns
 * Infinity for degenerate polygons. */
function distanceToPolygonEdge(point: Vec2, poly: Vec2[]): number {
  if (poly.length < 2) return Infinity
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    let t = 0
    if (len2 > 0) {
      t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2
      if (t < 0) t = 0; else if (t > 1) t = 1
    }
    const cx = a.x + dx * t
    const cy = a.y + dy * t
    const ddx = point.x - cx
    const ddy = point.y - cy
    const d = Math.hypot(ddx, ddy)
    if (d < best) best = d
  }
  return best
}

/** Find the static polygon whose edge is closest to `point`, within `maxDist`.
 * Contact points sit on a polygon boundary, so this picks the surface the
 * splat actually landed on — used as a fallback when the engine didn't
 * return a polygon snapshot with the contact (e.g., Rust path). */
function findNearestStaticPoly(
  point: Vec2,
  surfaces: readonly { poly: Vec2[] }[],
  maxDist: number,
): Vec2[] | null {
  let bestPoly: Vec2[] | null = null
  let bestDist = maxDist
  for (const s of surfaces) {
    if (s.poly.length < 3) continue
    const d = distanceToPolygonEdge(point, s.poly)
    if (d < bestDist) {
      bestDist = d
      bestPoly = s.poly
    }
  }
  return bestPoly
}

export class EffectsBindings {
  private tracks = new Map<string, BlobTrack>()
  private elapsed = 0
  /** Countdown integer last announced, so we play one tick per second. */
  private lastCountdownAnnounced = -1
  /** Per-blob centroid + smoothed velocity for blob-vs-blob detection. */
  private blobVel = new Map<number, BlobVel>()
  /** Last blob-vs-blob ripple time, keyed by sorted-id pair. */
  private lastBlobBlobAt = new Map<string, number>()
  /** Most recent static-surface list, captured each update tick. Used to
   * resolve a fallback clip polygon for splats when the contact didn't
   * include one (Rust engine doesn't surface poly through the wasm API). */
  private worldSurfaces: readonly { poly: Vec2[] }[] = []

  private resolveClipPoly(provided: Vec2[] | null | undefined, point: Vec2): Vec2[] | null {
    if (provided && provided.length >= 3) return provided
    // 6 px slop: contact points sit on the edge; allow a little wiggle for
    // floating-point and sub-step interpolation.
    return findNearestStaticPoly(point, this.worldSurfaces, 6)
  }

  /** Per-frame: detect rising-edge events on every player blob. Call after
   * physics has stepped this frame.
   *
   * `npcs` is optional — when supplied, NPC blobs are included in the
   * blob-vs-blob ripple detection so player↔NPC bumps also flash rings. */
  update(
    dt: number,
    playerManager: PlayerManager,
    npcs: readonly SlimeBlob[] = [],
    world?: { staticSurfaces: readonly { poly: Vec2[] }[]; pos: readonly Vec2[] },
    softPlatforms: readonly { blobId: number; hullIndices: readonly number[] }[] = [],
    platformLookup?: PlatformLookup,
  ): void {
    this.elapsed += dt
    tickDecals(dt)
    tickBlobImpacts(dt)
    if (world) this.worldSurfaces = world.staticSurfaces

    for (const player of playerManager.getAllPlayers()) {
      const c = player.blob.getCentroid()
      const grounded = player.blob.isGrounded()
      const expanding = player.blob.isExpanding()
      const stuck = player.blob.getStickAim() !== null

      let track = this.tracks.get(player.playerId)
      if (!track) {
        track = {
          prevCentroid: c,
          prevVelocity: { x: 0, y: 0 },
          wasGrounded: grounded,
          wasExpanding: expanding,
          wasStuck: stuck,
          lastLandAt: -Infinity,
          lastWallSplatAt: -Infinity,
          lastTrailAt: -Infinity,
          lastImpulseAt: -Infinity,
        }
        this.tracks.set(player.playerId, track)
        continue
      }

      // Velocity from centroid delta. dt can be tiny; clamp to avoid spikes.
      const safeDt = Math.max(dt, 1 / 240)
      const vx = (c.x - track.prevCentroid.x) / safeDt
      const vy = (c.y - track.prevCentroid.y) / safeDt
      const prevSpeed = Math.hypot(track.prevVelocity.x, track.prevVelocity.y)
      // Flag set by any code path below that already added a blob-impact
      // ripple this tick. Used to suppress the impulse-ripple path so a
      // single jump-into-wall doesn't double-fire visually.
      let firedRingThisTick = false

      // ── Land (rising edge of grounded) ──────────────────────────────
      if (grounded && !track.wasGrounded && this.elapsed - track.lastLandAt > LAND_DEDUPE_SEC) {
        // Impact speed = the speed we had just before becoming grounded.
        const speed = prevSpeed
        if (speed >= LAND_MIN_SPEED) {
          const t = Math.min(1, (speed - LAND_MIN_SPEED) / (LAND_LOUD_SPEED - LAND_MIN_SPEED))
          // -50% off the prior 0.12–0.30 envelope → 0.06–0.15.
          const volume = 0.06 + 0.09 * t
          // Range biased well below 1.0 to keep the impact deep/wet rather
          // than letting it turn into a high-pitched slap.
          const pitch = 0.7 + Math.random() * 0.28
          playSfx('land-squelch', { volume, pitch })

          // Use the real contact point + surface normal from the physics
          // step so splats sit ON the surface and burst direction matches
          // the wall/floor/ceiling we actually hit. Fall back to centroid
          // + velocity-derived direction if no contact was recorded (rare;
          // can happen if grounded flips via a different code path).
          const contact = player.blob.getGroundContact()
          const origin: Vec2 = contact ? contact.point : c
          let normal: Vec2
          if (contact) {
            normal = contact.normal
          } else {
            const speedMag = Math.max(speed, 1)
            normal = { x: -track.prevVelocity.x / speedMag, y: -track.prevVelocity.y / speedMag }
          }
          const count = 6 + Math.floor(t * 10)
          emitBurst(origin, player.color, count, 220 + t * 280, normal, 110)

          if (speed >= LAND_DECAL_SPEED) {
            const size = 12 + t * 22
            const anchor = pickSurfaceAnchor(origin, normal, platformLookup)
            addSplat(origin, player.color, size, normal, this.resolveClipPoly(contact?.poly, origin), anchor)
          }
          // Ring ripples through the blob from the contact point. Strength
          // maps from the same impact-speed envelope as the splat sound so
          // soft landings get a gentle ripple, hard hits get loud rings.
          // Stored in blob-local coords (offset from current centroid) so
          // the ripple rides with the blob.
          addBlobImpact(player.blob.blobId, { x: origin.x - c.x, y: origin.y - c.y }, t)
          firedRingThisTick = true
          track.lastLandAt = this.elapsed
        }
      }

      // ── Wall / ceiling splat ────────────────────────────────────────
      // The landing path handles floor-facing contacts (normal.y < -0.3).
      // Here we splat hard impacts on any other surface using the same
      // 380 px/s threshold, debounced so continuous contact doesn't spam.
      if (
        prevSpeed >= LAND_DECAL_SPEED &&
        this.elapsed - track.lastWallSplatAt > WALL_SPLAT_DEDUPE_SEC
      ) {
        const impact = player.blob.getImpactContact()
        if (impact && impact.normal.y >= -0.3) {
          const t = Math.min(1, (prevSpeed - LAND_MIN_SPEED) / (LAND_LOUD_SPEED - LAND_MIN_SPEED))
          const size = 12 + t * 22
          const count = 6 + Math.floor(t * 10)
          emitBurst(impact.point, player.color, count, 220 + t * 280, impact.normal, 110)
          const wallAnchor = pickSurfaceAnchor(impact.point, impact.normal, platformLookup)
          addSplat(impact.point, player.color, size, impact.normal, this.resolveClipPoly(impact.poly, impact.point), wallAnchor)
          addBlobImpact(player.blob.blobId, { x: impact.point.x - c.x, y: impact.point.y - c.y }, t)
          firedRingThisTick = true
          track.lastWallSplatAt = this.elapsed
        }
      }

      // ── Slime trail (while grounded + sliding) ──────────────────────
      // Continuous emitter: when the blob is on the ground and moving along
      // the surface, drop a small fast-fading splat at the contact point.
      // Distinct from the impact splat path above (which only fires on the
      // grounded rising edge above LAND_DECAL_SPEED).
      if (grounded && prevSpeed >= TRAIL_MIN_SPEED && this.elapsed - track.lastTrailAt >= TRAIL_INTERVAL_SEC) {
        const contact = player.blob.getGroundContact()
        if (contact) {
          const speedT = Math.min(1, (prevSpeed - TRAIL_MIN_SPEED) / 600)
          const size = 3 + speedT * 5
          const trailAnchor = pickSurfaceAnchor(contact.point, contact.normal, platformLookup)
          addTrailSplat(contact.point, player.color, size, contact.normal, this.resolveClipPoly(contact.poly, contact.point), trailAnchor)
          track.lastTrailAt = this.elapsed
        }
      }

      // ── Impulse ripple ──────────────────────────────────────────────
      // Any sharp velocity-delta — jump, dash, wall jump, getting kicked —
      // fires a ripple from the TRAILING face (opposite the direction the
      // blob was pushed). Suppressed if a wall/landing path already fired
      // a ring this tick. The trailing offset is in blob-local coords so it
      // rides along with the blob.
      const dvx = vx - track.prevVelocity.x
      const dvy = vy - track.prevVelocity.y
      const dvMag = Math.hypot(dvx, dvy)
      if (
        !firedRingThisTick &&
        dvMag > IMPULSE_DV &&
        this.elapsed - track.lastImpulseAt > IMPULSE_DEDUPE_SEC
      ) {
        const ux = dvx / dvMag
        const uy = dvy / dvMag
        const local: Vec2 = { x: -ux * BLOB_RADIUS * 0.7, y: -uy * BLOB_RADIUS * 0.7 }
        const strength = Math.min(1, (dvMag - IMPULSE_DV) / 700 + 0.3)
        addBlobImpact(player.blob.blobId, local, strength)
        track.lastImpulseAt = this.elapsed
      }

      // ── Puff (rising edge of expanding) ─────────────────────────────
      // playSfx pitch IS the Web Audio playbackRate — so this also controls
      // playback SPEED. Range biased above 1.0 so every play is faster than
      // the source (~30–80% faster), while still varying both pitch and
      // duration between hits.
      if (expanding && !track.wasExpanding) {
        const pitch = 1.3 + Math.random() * 0.5
        // 2× the previous 0.108–0.144 envelope → 0.216–0.288.
        const volume = 0.216 + Math.random() * 0.072
        playSfx('puff-up', { volume, pitch })
        emitPuff(c, player.color, 8)
      }

      // ── Wall stick / wall jump ──────────────────────────────────────
      if (stuck && !track.wasStuck) {
        playSfx('wall-stick', { volume: 0.6 })
      } else if (!stuck && track.wasStuck) {
        // Released from a sticky wall — usually via jumpPressed, which
        // applies a strong impulse the same frame.
        playSfx('wall-jump', { volume: 0.7 })
      }

      track.prevCentroid = c
      track.prevVelocity = { x: vx, y: vy }
      track.wasGrounded = grounded
      track.wasExpanding = expanding
      track.wasStuck = stuck
    }

    // ── Blob-vs-blob ripples ──────────────────────────────────────────
    // Heuristic: maintain a per-blob centroid + smoothed velocity, then
    // for each pair test whether their bounding circles overlap (cheap
    // proxy for contact) AND whether the closing speed along the contact
    // line exceeds threshold. If so, fire a ripple on BOTH blobs at the
    // contact midpoint, in each blob's local frame.
    this.detectBlobBlobImpacts(dt, playerManager, npcs, world?.pos, softPlatforms)
    void platformLookup // (consumed by surface anchors above; nothing for the detector itself)
  }

  private detectBlobBlobImpacts(
    dt: number,
    playerManager: PlayerManager,
    npcs: readonly SlimeBlob[],
    worldPos?: readonly Vec2[],
    softPlatforms: readonly { blobId: number; hullIndices: readonly number[] }[] = [],
  ): void {
    // Gather all blobs (players first, then NPCs).
    const players = playerManager.getAllPlayers()
    const all: SlimeBlob[] = []
    for (const p of players) all.push(p.blob)
    for (const npc of npcs) all.push(npc)
    if (all.length < 2 && softPlatforms.length === 0) return

    const safeDt = Math.max(dt, 1 / 240)
    // Track which entries are players (vs NPCs / soft platforms) so we only
    // play the squelch SFX when an actual player is involved.
    const isPlayer: boolean[] = []
    // Two categories of virtual body:
    //   - "blob": SlimeBlobs — well-approximated by a bounding circle of
    //     radius BLOB_RADIUS, so circle-overlap is fine.
    //   - "hull": soft platforms / point shapes — can be long and skinny, so
    //     a bounding circle balloons way past the silhouette. For these we
    //     keep the live hull-point positions and test the nearest hull
    //     point against a blob's centroid for actual proximity.
    type Body =
      | { kind: 'blob'; x: number; y: number; vx: number; vy: number; id: number }
      | { kind: 'hull'; cx: number; cy: number; vx: number; vy: number; id: number; hullPts: Vec2[]; particleIdxs: readonly number[] }
    const bodies: Body[] = []

    for (let i = 0; i < all.length; i++) {
      const b = all[i]
      const c = b.getCentroid()
      const prev = this.blobVel.get(b.blobId)
      let vx = 0, vy = 0
      if (prev) {
        vx = (c.x - prev.x) / safeDt
        vy = (c.y - prev.y) / safeDt
        const a = 0.5
        vx = prev.vx * (1 - a) + vx * a
        vy = prev.vy * (1 - a) + vy * a
      }
      this.blobVel.set(b.blobId, { x: c.x, y: c.y, vx, vy })
      bodies.push({ kind: 'blob', x: c.x, y: c.y, vx, vy, id: b.blobId })
      isPlayer.push(i < players.length)
    }

    // Soft platforms / point shapes: snapshot the live hull-point positions
    // and compute the centroid for velocity tracking. Distance checks use
    // the hull points directly so an elongated platform doesn't trigger
    // proximity from across the room.
    if (worldPos) {
      for (const sp of softPlatforms) {
        if (sp.hullIndices.length < 2) continue
        const hullPts: Vec2[] = []
        const particleIdxs: number[] = []
        let sx = 0, sy = 0
        for (const idx of sp.hullIndices) {
          const p = worldPos[idx]; if (!p) continue
          hullPts.push({ x: p.x, y: p.y })
          particleIdxs.push(idx)
          sx += p.x; sy += p.y
        }
        if (hullPts.length === 0) continue
        const cx = sx / hullPts.length, cy = sy / hullPts.length
        const prev = this.blobVel.get(sp.blobId)
        let vx = 0, vy = 0
        if (prev) {
          vx = (cx - prev.x) / safeDt
          vy = (cy - prev.y) / safeDt
          const a = 0.5
          vx = prev.vx * (1 - a) + vx * a
          vy = prev.vy * (1 - a) + vy * a
        }
        this.blobVel.set(sp.blobId, { x: cx, y: cy, vx, vy })
        bodies.push({ kind: 'hull', cx, cy, vx, vy, id: sp.blobId, hullPts, particleIdxs })
        isPlayer.push(false)
      }
    }

    // Drop stale velocity entries for bodies that aren't around any more.
    const live = new Set<number>()
    for (const e of bodies) live.add(e.kind === 'blob' ? e.id : e.id)
    for (const k of this.blobVel.keys()) if (!live.has(k)) this.blobVel.delete(k)

    // Hull-vs-hull (soft-platform vs soft-platform) is rare and expensive;
    // skip for now. Only blob-vs-blob and blob-vs-hull register.
    //
    // PROXIMITY_SLACK: how close the blob silhouette can be to the other
    // body's nearest point before we count it as a hit. Small positive so
    // we don't fire while the blob is still visibly in the air.
    const PROXIMITY_SLACK = 4
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i]
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j]

        // Compute (contact point, gap distance, contact normal from a→b)
        // depending on what the two bodies are. Track the nearest hull edge
        // for blob-vs-hull so we can anchor a splat to it after the fact.
        let cpx: number, cpy: number, gap: number, ndx: number, ndy: number
        let ax: number, ay: number, bx: number, by: number
        // Hull-anchor scratch, only populated when this pair is blob-vs-hull:
        let hullAnchorPair: {
          hull: Extract<Body, { kind: 'hull' }>
          nearestK: number
          nearestT: number
        } | null = null
        if (a.kind === 'blob' && b.kind === 'blob') {
          ax = a.x; ay = a.y; bx = b.x; by = b.y
          const dx = bx - ax, dy = by - ay
          const d = Math.hypot(dx, dy)
          gap = d - 2 * BLOB_RADIUS
          ndx = d > 0.001 ? dx / d : 1
          ndy = d > 0.001 ? dy / d : 0
          cpx = (ax + bx) * 0.5
          cpy = (ay + by) * 0.5
        } else if (a.kind === 'hull' && b.kind === 'hull') {
          continue
        } else {
          const blob = (a.kind === 'blob' ? a : b) as Extract<Body, { kind: 'blob' }>
          const hull = (a.kind === 'hull' ? a : b) as Extract<Body, { kind: 'hull' }>
          let nearestX = hull.hullPts[0].x, nearestY = hull.hullPts[0].y
          let nearestD = Infinity
          let nearestK = 0, nearestT = 0
          for (let k = 0; k < hull.hullPts.length; k++) {
            const p1 = hull.hullPts[k]
            const p2 = hull.hullPts[(k + 1) % hull.hullPts.length]
            const ex = p2.x - p1.x, ey = p2.y - p1.y
            const len2 = ex * ex + ey * ey
            let t = 0
            if (len2 > 0) {
              t = ((blob.x - p1.x) * ex + (blob.y - p1.y) * ey) / len2
              if (t < 0) t = 0; else if (t > 1) t = 1
            }
            const qx = p1.x + ex * t
            const qy = p1.y + ey * t
            const d = Math.hypot(blob.x - qx, blob.y - qy)
            if (d < nearestD) { nearestD = d; nearestX = qx; nearestY = qy; nearestK = k; nearestT = t }
          }
          gap = nearestD - BLOB_RADIUS
          const dx = nearestX - blob.x, dy = nearestY - blob.y
          const d = Math.hypot(dx, dy)
          ndx = d > 0.001 ? dx / d : 1
          ndy = d > 0.001 ? dy / d : 0
          cpx = nearestX
          cpy = nearestY
          ax = blob.x; ay = blob.y; bx = hull.cx; by = hull.cy
          hullAnchorPair = { hull, nearestK, nearestT }
        }

        if (gap > PROXIMITY_SLACK) continue

        const relVx = a.vx - b.vx
        const relVy = a.vy - b.vy
        const closing = relVx * ndx + relVy * ndy
        if (closing < BLOB_VS_BLOB_MIN_RELSPEED) continue

        const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`
        const last = this.lastBlobBlobAt.get(key) ?? -Infinity
        if (this.elapsed - last < BLOB_VS_BLOB_DEDUPE_SEC) continue
        this.lastBlobBlobAt.set(key, this.elapsed)

        const strength = Math.min(1, (closing - BLOB_VS_BLOB_MIN_RELSPEED) / 600 + 0.3)
        addBlobImpact(a.id, { x: cpx - ax, y: cpy - ay }, strength)
        addBlobImpact(b.id, { x: cpx - bx, y: cpy - by }, strength)

        // SFX + splat only when a player is involved (avoid background NPCs
        // bumping each other).
        if (isPlayer[i] || isPlayer[j]) {
          const volume = 0.0525 + 0.0825 * strength
          const pitch = 0.7 + Math.random() * 0.28
          playSfx('land-squelch', { volume, pitch })

          // Hull-anchored splat: when a player hit a soft body, emit a
          // permanent splat that follows the hull's deformation. Skipped
          // for pure blob-vs-blob (no surface to splat on) and for hull
          // collisions involving only NPCs (no player paint).
          if (hullAnchorPair) {
            const { hull, nearestK, nearestT } = hullAnchorPair
            const idxA = hull.particleIdxs[nearestK]
            const idxB = hull.particleIdxs[(nearestK + 1) % hull.particleIdxs.length]
            // The player's index in `players` matches its index in `bodies`
            // (players were pushed first), and we know one of i/j is a
            // player blob with the other being this hull.
            const playerIdx = isPlayer[i] ? i : j
            const playerColor = players[playerIdx]?.color ?? '#ffffff'
            // Slightly smaller than a landing splat — hull splats can't be
            // clipped to the deforming silhouette, so a tighter footprint
            // limits overflow as the soft body jiggles.
            const splatSize = 9 + strength * 14
            // Surface normal at the contact = pointing from edge outward
            // toward the blob (opposite of edge → blob direction we used
            // above), so the splat lies flat against the hull edge.
            const splatNormal = { x: -ndx, y: -ndy }
            const anchor: SplatAnchor = { kind: 'hull', idxA, idxB, t: nearestT, perpOffset: 0 }
            addSplat({ x: cpx, y: cpy }, playerColor, splatSize, splatNormal, null, anchor)
          }
        }
      }
    }
  }

  /** Forwarded from spikeManager.onKill. */
  onSpikeKill(player: ManagedPlayer, deathPosition: Vec2): void {
    playSfx('spike-splat', { volume: 0.10625, pitch: 0.9 + Math.random() * 0.2 })
    emitBurst(deathPosition, player.color, 24, 380, { x: 0, y: -1 }, 360)
    addSplat(deathPosition, player.color, 28, { x: 0, y: -1 })
    const c = player.blob.getCentroid()
    addBlobImpact(player.blob.blobId, { x: deathPosition.x - c.x, y: deathPosition.y - c.y }, 1)
    // Drop the track so the corpse-respawn doesn't trip a phantom landing.
    this.tracks.delete(player.playerId)
  }

  /** Forwarded from powerupManager.onCollect. */
  onPowerupCollect(player: ManagedPlayer, powerupColor: string, position: Vec2): void {
    playSfx('powerup-sparkle', { volume: 0.7 })
    emitSparkle(position, powerupColor, 18)
    void player
  }

  /** Forwarded from springPadManager.onFire. */
  onSpringFire(position: Vec2, launchDir: Vec2): void {
    playSfx('spring-boing', { volume: 0.02625, pitch: 0.95 + Math.random() * 0.12 })
    emitBurst(position, '#ffd166', 14, 360, launchDir, 70)
  }

  onPhaseChange(phase: GamePhase): void {
    if (phase === 'countdown') {
      this.lastCountdownAnnounced = -1
    } else if (phase === 'playing') {
      // Final beat of the countdown — the modeManager flips here when timer
      // hits zero, which lines up with the on-screen "GO!" frame.
      playSfx('countdown-go', { volume: 0.8 })
    } else if (phase === 'lobby' || phase === 'results') {
      this.tracks.clear()
    }
  }

  /** Optional: drive countdown tick SFX from the modeManager.update() loop. */
  onCountdownTimer(phaseTimer: number): void {
    const intSec = Math.ceil(phaseTimer)
    if (intSec > 0 && intSec !== this.lastCountdownAnnounced) {
      this.lastCountdownAnnounced = intSec
      playSfx('countdown-tick', { volume: 0.55, pitch: 0.95 + (3 - Math.min(3, intSec)) * 0.05 })
    }
  }

  onGameOver(): void {
    playSfx('round-win', { volume: 0.85 })
  }

  reset(): void {
    this.tracks.clear()
    this.lastCountdownAnnounced = -1
    this.elapsed = 0
    this.blobVel.clear()
    this.lastBlobBlobAt.clear()
  }
}
