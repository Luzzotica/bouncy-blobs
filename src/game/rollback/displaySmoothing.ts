// Visual correction smoothing for rollback netcode.
//
// On a misprediction rollback (or a state-sync correction) a blob's hull jumps
// from "predicted" to "corrected" between two render frames. That's a snap to the
// player — and because it's PER-NODE (not just a translation), it shows up as the
// blob instantly expanding/retracting/reshaping, not only sliding.
//
// We smooth it with a PER-NODE display offset applied at render time:
//
//   displayed_node[i] = actual_node[i] + offset[i]
//
// On a correction we set offset[i] = old_node[i] − new_node[i] so the displayed
// hull is *unchanged* on the first post-correction frame, then decay every render
// frame toward zero — the shape converges to the authoritative one over ~5 frames.
//
// Decay 0.7 ≈ 16% left after 5 frames. Corrections whose largest node move is
// under DEAD_ZONE_PX snap immediately (not worth interpolating).

import type { BouncyBlobsGame } from '../bouncyBlobsGame';

const DECAY = 0.7;
const DEAD_ZONE_PX = 1.5;

type Pt = { x: number; y: number };

export class DisplaySmoother {
  /** Per-blob, per-hull-node smoothing offset (display space). */
  private offsets = new Map<number, Pt[]>();

  /** Snapshot every player blob's hull nodes. Call BEFORE a rollback. */
  capturePreRollback(game: BouncyBlobsGame): Map<number, Pt[]> {
    const pre = new Map<number, Pt[]>();
    const pm = game.getPlayerManager();
    if (!pm) return pre;
    for (const p of pm.getAllPlayers()) {
      pre.set(p.blob.blobId, p.blob.getHullPolygon().map((v) => ({ x: v.x, y: v.y })));
    }
    return pre;
  }

  /** After a rollback+replay, set offset[i] = (old − new) per node so the hull
   *  shows its pre-correction shape, then eases to the authoritative one. */
  applyPostRollback(game: BouncyBlobsGame, pre: Map<number, Pt[]>): void {
    const pm = game.getPlayerManager();
    if (!pm) return;
    for (const p of pm.getAllPlayers()) {
      const old = pre.get(p.blob.blobId);
      if (!old) continue;
      const cur = p.blob.getHullPolygon();
      if (cur.length !== old.length) { this.offsets.delete(p.blob.blobId); continue; } // topology changed (respawn) → don't smooth
      const existing = this.offsets.get(p.blob.blobId);
      let maxMag = 0;
      const off: Pt[] = cur.map((c, i) => {
        const x = old[i].x - c.x + (existing?.[i]?.x ?? 0);
        const y = old[i].y - c.y + (existing?.[i]?.y ?? 0);
        const m = Math.hypot(x, y); if (m > maxMag) maxMag = m;
        return { x, y };
      });
      if (maxMag < DEAD_ZONE_PX) this.offsets.delete(p.blob.blobId);
      else this.offsets.set(p.blob.blobId, off);
    }
  }

  /** Decay offsets toward zero. Call once per render frame. */
  tick(): void {
    for (const [id, off] of this.offsets) {
      let maxMag = 0;
      for (const o of off) { o.x *= DECAY; o.y *= DECAY; const m = Math.hypot(o.x, o.y); if (m > maxMag) maxMag = m; }
      if (maxMag < 0.05) this.offsets.delete(id);
    }
  }

  /** Per-node display offsets for a blob, or null if none active. */
  getNodeOffsets(blobId: number): Pt[] | null { return this.offsets.get(blobId) ?? null; }

  activeCount(): number { return this.offsets.size; }
}
