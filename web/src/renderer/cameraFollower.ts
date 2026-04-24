import { Vec2 } from '../physics/vec2';

interface DotState {
  position: Vec2;
  /** If set, this dot is for a dead player drifting toward a destination. */
  driftTarget?: Vec2;
}

/**
 * Maintains smoothly-lerped "ghost dots" that track player positions.
 * The camera follows these dots instead of raw centroids, giving smooth
 * camera motion without the rendering artifacts of lerping the camera itself.
 *
 * When a player dies, their dot lingers at the death position and slowly
 * drifts toward a destination (e.g. spawn point) before being removed.
 */
export class CameraFollower {
  private dots: Map<string, DotState> = new Map();
  private smoothSpeed = 8;      // alive dot follow speed
  private driftSpeed = 1.5;     // dead dot drift speed (slower)
  private driftRemoveThreshold = 30; // remove drift dot when this close to target

  /**
   * Update all ghost dots.
   * @param aliveTargets - players that are alive and should be followed
   * @param deadTargets  - players that just died or are dead; dot drifts to driftTo
   */
  update(
    dt: number,
    aliveTargets: { id: string; position: Vec2 }[],
    deadTargets?: { id: string; deathPosition: Vec2; driftTo: Vec2 }[],
  ): void {
    const aliveIds = new Set(aliveTargets.map(t => t.id));
    const deadIds = new Set(deadTargets?.map(t => t.id) ?? []);

    // Remove dots that are neither alive nor dead (disconnected players)
    for (const id of this.dots.keys()) {
      if (!aliveIds.has(id) && !deadIds.has(id)) {
        this.dots.delete(id);
      }
    }

    // Update alive dots — lerp toward current centroid
    const aliveAlpha = 1 - Math.exp(-this.smoothSpeed * dt);
    for (const t of aliveTargets) {
      const existing = this.dots.get(t.id);
      if (!existing) {
        this.dots.set(t.id, { position: { ...t.position } });
      } else {
        // Player is alive again (respawned) — clear any drift
        existing.driftTarget = undefined;
        existing.position.x += (t.position.x - existing.position.x) * aliveAlpha;
        existing.position.y += (t.position.y - existing.position.y) * aliveAlpha;
      }
    }

    // Update dead dots — linger at death position, slowly drift to spawn
    if (deadTargets) {
      const driftAlpha = 1 - Math.exp(-this.driftSpeed * dt);
      for (const t of deadTargets) {
        if (aliveIds.has(t.id)) continue; // already handled as alive
        const existing = this.dots.get(t.id);
        if (!existing) {
          // Player just died — place dot at death position
          this.dots.set(t.id, {
            position: { ...t.deathPosition },
            driftTarget: { ...t.driftTo },
          });
        } else {
          // Set drift target if not already set
          if (!existing.driftTarget) {
            existing.driftTarget = { ...t.driftTo };
          }
          // Slowly drift toward spawn
          const target = existing.driftTarget;
          existing.position.x += (target.x - existing.position.x) * driftAlpha;
          existing.position.y += (target.y - existing.position.y) * driftAlpha;

          // Remove if close enough to target
          const dx = target.x - existing.position.x;
          const dy = target.y - existing.position.y;
          if (dx * dx + dy * dy < this.driftRemoveThreshold * this.driftRemoveThreshold) {
            this.dots.delete(t.id);
          }
        }
      }
    }
  }

  /** Get the smoothed positions for the camera to follow. */
  getPositions(): Vec2[] {
    return Array.from(this.dots.values()).map(d => d.position);
  }

  /** Clear all tracked dots (e.g. on level change). */
  clear(): void {
    this.dots.clear();
  }
}
