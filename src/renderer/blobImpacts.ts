// World-space impact event log used by the blob renderer to draw ripples
// propagating from the contact point. Each impact has an age, a strength,
// and a fixed lifetime; ripples expand outward and fade as age → maxAge.
//
// Ticked once per game-loop frame from EffectsBindings.update (next to
// tickDecals), and sampled per-blob during render to find impacts whose
// origin is close enough to the blob hull to contribute visible rings.

import { Vec2 } from '../physics/vec2'

export interface BlobImpact {
  x: number
  y: number
  /** 0..1: governs initial ring radius, ring count, and brightness. */
  strength: number
  age: number
  maxAge: number
}

const MAX_IMPACTS = 96
const impacts: BlobImpact[] = []

/** Record a new impact. `strength` ~ normalised landing/wall hit intensity. */
export function addBlobImpact(pos: Vec2, strength: number): void {
  if (impacts.length >= MAX_IMPACTS) impacts.shift()
  impacts.push({
    x: pos.x,
    y: pos.y,
    strength: Math.max(0.1, Math.min(1, strength)),
    age: 0,
    maxAge: 0.5 + strength * 0.45,
  })
}

/** Age every impact; drop expired ones. */
export function tickBlobImpacts(dt: number): void {
  for (let i = impacts.length - 1; i >= 0; i--) {
    impacts[i].age += dt
    if (impacts[i].age >= impacts[i].maxAge) impacts.splice(i, 1)
  }
}

/** Impacts whose origin is within `searchRadius` world-units of `near`.
 * Allocates a small array — fine, we have at most a handful of blobs. */
export function impactsNear(near: Vec2, searchRadius: number): BlobImpact[] {
  const r2 = searchRadius * searchRadius
  const out: BlobImpact[] = []
  for (const im of impacts) {
    const dx = im.x - near.x
    const dy = im.y - near.y
    if (dx * dx + dy * dy <= r2) out.push(im)
  }
  return out
}

export function clearBlobImpacts(): void {
  impacts.length = 0
}
