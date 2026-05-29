// Per-blob impact log used by the blob renderer to draw ripples emanating
// from the contact point. Offsets are stored in blob-LOCAL coords (relative
// to the centroid at impact time) so a ripple rides along with the blob
// instead of staying parked at the world-space point where the hit happened.
//
// Translation only — no rotation. Blobs don't visually spin so anchoring
// to a local frame fixed at impact time would slide rings around the
// silhouette weirdly. Local = centroid offset.

import { Vec2 } from '../physics/vec2'

export interface BlobImpact {
  /** Offset from the blob's centroid at impact time. */
  localX: number
  localY: number
  /** 0..1 — governs ring count, ring radius, brightness, and lifetime. */
  strength: number
  age: number
  maxAge: number
}

const MAX_PER_BLOB = 12
const EMPTY: readonly BlobImpact[] = Object.freeze([])

const impactsByBlob = new Map<number, BlobImpact[]>()

/** Record a ripple on `blobId`. `localOffset` is the contact point minus
 * the blob's current centroid. `strength` ∈ [0,1]. */
export function addBlobImpact(blobId: number, localOffset: Vec2, strength: number): void {
  let arr = impactsByBlob.get(blobId)
  if (!arr) {
    arr = []
    impactsByBlob.set(blobId, arr)
  }
  if (arr.length >= MAX_PER_BLOB) arr.shift()
  const s = Math.max(0.1, Math.min(1, strength))
  arr.push({
    localX: localOffset.x,
    localY: localOffset.y,
    strength: s,
    age: 0,
    maxAge: 0.5 + s * 0.45,
  })
}

export function tickBlobImpacts(dt: number): void {
  for (const [id, arr] of impactsByBlob) {
    for (let i = arr.length - 1; i >= 0; i--) {
      arr[i].age += dt
      if (arr[i].age >= arr[i].maxAge) arr.splice(i, 1)
    }
    if (arr.length === 0) impactsByBlob.delete(id)
  }
}

export function impactsFor(blobId: number): readonly BlobImpact[] {
  return impactsByBlob.get(blobId) ?? EMPTY
}

export function clearBlobImpacts(): void {
  impactsByBlob.clear()
}
