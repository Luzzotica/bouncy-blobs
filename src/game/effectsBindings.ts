// Per-frame state-transition detection for SFX + VFX. Owned by
// BouncyBlobsGame and ticked from its game loop. Reads sim state, emits
// sounds and particles. Effects are local-only: every client runs the same
// sim and detects the same transitions, so no networking is needed.

import { Vec2 } from '../physics/vec2'
import { PlayerManager, ManagedPlayer } from './playerManager'
import { playSfx } from '../utils/audio'
import { emitBurst, emitPuff, emitSparkle } from '../renderer/particles'
import { addSplat, addTrailSplat, tickDecals } from '../renderer/decals'
import { addBlobImpact, tickBlobImpacts } from '../renderer/blobImpacts'
import { GamePhase } from './gameModes/types'

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
}

const LAND_MIN_SPEED = 220       // px/s — below this, landing is silent
const LAND_LOUD_SPEED = 1400     // px/s — speed above which volume saturates
const LAND_DECAL_SPEED = 380     // splats only when impact is meaningful
const LAND_DEDUPE_SEC = 0.18
const WALL_SPLAT_DEDUPE_SEC = 0.15
const TRAIL_MIN_SPEED = 140      // px/s — slower than this, no trail
const TRAIL_INTERVAL_SEC = 0.05  // emit a small trail splat at this cadence

export class EffectsBindings {
  private tracks = new Map<string, BlobTrack>()
  private elapsed = 0
  /** Countdown integer last announced, so we play one tick per second. */
  private lastCountdownAnnounced = -1

  /** Per-frame: detect rising-edge events on every player blob. Call after
   * physics has stepped this frame. */
  update(dt: number, playerManager: PlayerManager): void {
    this.elapsed += dt
    tickDecals(dt)
    tickBlobImpacts(dt)

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
        }
        this.tracks.set(player.playerId, track)
        continue
      }

      // Velocity from centroid delta. dt can be tiny; clamp to avoid spikes.
      const safeDt = Math.max(dt, 1 / 240)
      const vx = (c.x - track.prevCentroid.x) / safeDt
      const vy = (c.y - track.prevCentroid.y) / safeDt
      const prevSpeed = Math.hypot(track.prevVelocity.x, track.prevVelocity.y)

      // ── Land (rising edge of grounded) ──────────────────────────────
      if (grounded && !track.wasGrounded && this.elapsed - track.lastLandAt > LAND_DEDUPE_SEC) {
        // Impact speed = the speed we had just before becoming grounded.
        const speed = prevSpeed
        if (speed >= LAND_MIN_SPEED) {
          const t = Math.min(1, (speed - LAND_MIN_SPEED) / (LAND_LOUD_SPEED - LAND_MIN_SPEED))
          const volume = 0.4 + 0.6 * t
          const pitch = 0.92 + Math.random() * 0.16
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
            addSplat(origin, player.color, size, normal, contact?.poly ?? null)
          }
          // Ring ripples through the blob from the contact point. Strength
          // maps from the same impact-speed envelope as the splat sound so
          // soft landings get a gentle ripple, hard hits get loud rings.
          addBlobImpact(origin, t)
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
          addSplat(impact.point, player.color, size, impact.normal, impact.poly)
          addBlobImpact(impact.point, t)
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
          addTrailSplat(contact.point, player.color, size, contact.normal, contact.poly ?? null)
          track.lastTrailAt = this.elapsed
        }
      }

      // ── Puff (rising edge of expanding) ─────────────────────────────
      if (expanding && !track.wasExpanding) {
        playSfx('puff-up', { volume: 0.7, pitch: 0.95 + Math.random() * 0.12 })
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
  }

  /** Forwarded from spikeManager.onKill. */
  onSpikeKill(player: ManagedPlayer, deathPosition: Vec2): void {
    playSfx('spike-splat', { volume: 0.85, pitch: 0.9 + Math.random() * 0.2 })
    emitBurst(deathPosition, player.color, 24, 380, { x: 0, y: -1 }, 360)
    addSplat(deathPosition, player.color, 28, { x: 0, y: -1 })
    addBlobImpact(deathPosition, 1)
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
    playSfx('spring-boing', { volume: 0.7, pitch: 0.95 + Math.random() * 0.12 })
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
  }
}
