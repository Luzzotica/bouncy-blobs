import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { TriggerDef } from '../levels/types';
import { hashStringId } from './idHash';

/**
 * A Trigger is an area that detects blobs. The charge→pressed state machine now
 * lives in the Rust engine (Phase 6 of the JS→Rust migration); this manager is
 * a thin loader (registers each trigger via `addGameTrigger` at init) + renderer
 * (reads `triggerPressed` / `triggerChargeProgress` from the engine). Actions
 * poll `isPressed()` which forwards to the engine.
 */
export class TriggerManager {
  private world: SoftBodyEngine | null = null;
  /** def by string id (for rendering geometry). */
  private defs = new Map<string, TriggerDef>();
  /** string id → engine registration index (for state queries). */
  private idToIdx = new Map<string, number>();

  initialize(
    world: SoftBodyEngine,
    defs: TriggerDef[],
    shapeIdxToTriggerId: Map<number, string>,
    _isNpcBlob?: (blobId: number) => boolean,
    _isPlayerBlob?: (blobId: number) => boolean,
  ): void {
    this.world = world;
    this.defs.clear();
    this.idToIdx.clear();
    // Invert shapeIdx→triggerId so we can find each trigger's polygon shape.
    const triggerIdToShapeIdx = new Map<string, number>();
    for (const [shapeIdx, triggerId] of shapeIdxToTriggerId) triggerIdToShapeIdx.set(triggerId, shapeIdx);

    for (const def of defs) {
      const shapeIdx = triggerIdToShapeIdx.get(def.id);
      if (shapeIdx === undefined) continue; // no registered polygon (defensive)
      const idx = world.addGameTrigger(hashStringId(def.id), shapeIdx, def.chargeSeconds ?? 0, def.ignoreNpcs ?? false);
      this.defs.set(def.id, def);
      this.idToIdx.set(def.id, idx);
    }
  }

  /** No-op: the engine advances the charge machine inside `world.step()`. */
  update(_dt: number): void {}

  /** Polled by actions (and any TS consumer) — forwards to the engine. */
  isPressed(triggerId: string): boolean {
    return this.world?.triggerPressedById(hashStringId(triggerId)) ?? false;
  }

  /** Charge progress in [0,1] for the renderer's fill meter. */
  chargeProgress(triggerId: string): number {
    const idx = this.idToIdx.get(triggerId);
    if (idx === undefined || !this.world) return 0;
    return this.world.triggerChargeProgress(idx);
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.world) return;
    for (const [id, def] of this.defs) {
      const idx = this.idToIdx.get(id);
      if (idx === undefined) continue;
      const pressed = this.world.triggerPressed(idx);
      const progress = this.world.triggerChargeProgress(idx);
      const charging = !pressed && progress > 0 && progress < 1;

      ctx.save();
      ctx.translate(def.x, def.y);
      ctx.rotate(def.rotation);
      const hw = def.width / 2;
      const hh = def.height / 2;

      let fillColor: string;
      let strokeColor: string;
      if (pressed) {
        fillColor = 'rgba(120, 240, 120, 0.16)';
        strokeColor = 'rgba(150, 255, 150, 0.95)';
      } else if (charging) {
        fillColor = 'rgba(255, 255, 255, 0.04)';
        strokeColor = 'rgba(255, 215, 90, 0.85)';
      } else {
        fillColor = 'rgba(255, 255, 255, 0.06)';
        strokeColor = 'rgba(230, 230, 240, 0.7)';
      }

      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.roundRect(-hw, -hh, def.width, def.height, 4);
      ctx.fill();

      if (charging) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(-hw, -hh, def.width, def.height, 4);
        ctx.clip();
        ctx.fillStyle = 'rgba(255, 216, 74, 0.28)';
        ctx.fillRect(-hw, -hh, def.width * progress, def.height);
        ctx.restore();
      }

      const dashLen = Math.max(6, Math.min(14, def.width * 0.05));
      const gapLen = Math.max(4, dashLen * 0.6);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([dashLen, gapLen]);
      ctx.beginPath();
      ctx.roundRect(-hw, -hh, def.width, def.height, 4);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  cleanup(): void {
    this.defs.clear();
    this.idToIdx.clear();
    this.world = null;
  }
}
