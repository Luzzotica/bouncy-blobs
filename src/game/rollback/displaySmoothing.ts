// Visual correction smoothing for rollback netcode.
//
// On a misprediction rollback, blob positions jump from "predicted" to
// "corrected" between two render frames. That looks like a snap to the
// player. Smoothing fixes it by introducing a per-blob `displayOffset`
// vector applied at render time:
//
//   displayed_position = actual_position + displayOffset
//
// When a rollback corrects a blob, we set `displayOffset = old_pos -
// new_pos` so the displayed position is *unchanged* on the first
// post-rollback frame. Each subsequent render frame the offset decays
// toward zero, so the displayed position smoothly converges to the
// authoritative position over ~5 frames.
//
// Decay factor 0.7 gives ~16% remaining after 5 frames (0.7^5 ≈ 0.168).
// Snaps under DEAD_ZONE_PX are applied immediately — smoothing overhead
// isn't worth it for sub-pixel corrections.

import type { BouncyBlobsGame } from '../bouncyBlobsGame';

const DECAY = 0.7;
const DEAD_ZONE_PX = 1.5;

export class DisplaySmoother {
  /** Per-blob smoothing offset (display space). */
  private offsets = new Map<number, { x: number; y: number }>();

  /** Snapshot every player blob's centroid. Call BEFORE a rollback. */
  capturePreRollback(game: BouncyBlobsGame): Map<number, { x: number; y: number }> {
    const pre = new Map<number, { x: number; y: number }>();
    const pm = game.getPlayerManager();
    if (!pm) return pre;
    for (const p of pm.getAllPlayers()) {
      const c = p.blob.getCentroid();
      pre.set(p.blob.blobId, { x: c.x, y: c.y });
    }
    return pre;
  }

  /** After a rollback+replay completes, compute (old - new) per blob and
   *  stash as the per-blob render offset. The renderer reads
   *  `getOffset(blobId)` and adds it to the rendered position. */
  applyPostRollback(game: BouncyBlobsGame, pre: Map<number, { x: number; y: number }>): void {
    const pm = game.getPlayerManager();
    if (!pm) return;
    for (const p of pm.getAllPlayers()) {
      const oldPos = pre.get(p.blob.blobId);
      if (!oldPos) continue;
      const newPos = p.blob.getCentroid();
      const dx = oldPos.x - newPos.x;
      const dy = oldPos.y - newPos.y;
      // Compose with any existing residual offset so multiple rapid
      // corrections don't add up to a visible jump.
      const existing = this.offsets.get(p.blob.blobId);
      const total = {
        x: dx + (existing?.x ?? 0),
        y: dy + (existing?.y ?? 0),
      };
      // Skip tiny corrections — not worth a render-frame interpolation.
      if (Math.hypot(total.x, total.y) < DEAD_ZONE_PX) {
        this.offsets.delete(p.blob.blobId);
      } else {
        this.offsets.set(p.blob.blobId, total);
      }
    }
  }

  /** Decay offsets toward zero. Call once per RAF in the renderer. */
  tick(): void {
    for (const [id, off] of this.offsets) {
      off.x *= DECAY;
      off.y *= DECAY;
      if (Math.hypot(off.x, off.y) < 0.05) {
        this.offsets.delete(id);
      }
    }
  }

  /** Current display offset for a blob (defaults to {0,0}). */
  getOffset(blobId: number): { x: number; y: number } {
    return this.offsets.get(blobId) ?? { x: 0, y: 0 };
  }

  /** Debug: number of blobs with active smoothing. */
  activeCount(): number { return this.offsets.size; }
}
