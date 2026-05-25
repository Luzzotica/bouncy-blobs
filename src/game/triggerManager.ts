import { SoftBodyWorld } from '../physics/softBodyWorld';
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import { TriggerDef } from '../levels/types';

interface RegisteredTrigger {
  def: TriggerDef;
  /** True once chargeSeconds of continuous occupancy has elapsed. */
  pressed: boolean;
  /** Seconds of continuous occupancy accumulated so far. Reset to 0 when occupancy empties. */
  chargeElapsed: number;
  /** Brief visual flash after a state change. */
  flashTimer: number;
}

/**
 * A Trigger is an area that detects blobs. Actions subscribe to triggers
 * (via `ActionDef.sourceTriggerIds`) and poll `isPressed()` each frame.
 *
 * Triggers support a `chargeSeconds` hold-up: they only flip to pressed
 * after a blob has occupied continuously for that long. The charge resets
 * the moment occupancy drops to zero.
 */
export class TriggerManager {
  private triggers = new Map<string, RegisteredTrigger>();
  /** physics-world trigger shape index → trigger id */
  private shapeIdxToTriggerId = new Map<number, string>();
  /** Active blob occupants per trigger. */
  private occupants = new Map<string, Set<number>>();
  private world: SoftBodyEngine | null = null;

  initialize(
    world: SoftBodyEngine,
    defs: TriggerDef[],
    shapeIdxToTriggerId: Map<number, string>,
  ): void {
    this.world = world;
    this.shapeIdxToTriggerId = shapeIdxToTriggerId;
    this.triggers.clear();
    this.occupants.clear();
    for (const def of defs) {
      this.triggers.set(def.id, {
        def,
        pressed: (def.chargeSeconds ?? 0) <= 0 ? false : false, // starts unpressed
        chargeElapsed: 0,
        flashTimer: 0,
      });
      this.occupants.set(def.id, new Set());
    }

    const priorEntered = world.onTriggerEntered;
    const priorExited = world.onTriggerExited;
    world.onTriggerEntered = (shapeIdx, blobId) => {
      this.handleEnter(shapeIdx, blobId);
      priorEntered?.(shapeIdx, blobId);
    };
    world.onTriggerExited = (shapeIdx, blobId) => {
      this.handleExit(shapeIdx, blobId);
      priorExited?.(shapeIdx, blobId);
    };
  }

  private handleEnter(shapeIdx: number, blobId: number): void {
    const triggerId = this.shapeIdxToTriggerId.get(shapeIdx);
    if (!triggerId) return;
    const trig = this.triggers.get(triggerId);
    if (!trig) return;
    const occupants = this.occupants.get(triggerId);
    if (!occupants) return;
    const wasEmpty = occupants.size === 0;
    occupants.add(blobId);
    if (wasEmpty) {
      // First blob to step on. If no charge required, flip pressed immediately.
      const charge = trig.def.chargeSeconds ?? 0;
      if (charge <= 0) {
        trig.pressed = true;
        trig.flashTimer = 0.4;
      }
      // Otherwise charging begins in update(dt).
    }
  }

  private handleExit(shapeIdx: number, blobId: number): void {
    const triggerId = this.shapeIdxToTriggerId.get(shapeIdx);
    if (!triggerId) return;
    const occupants = this.occupants.get(triggerId);
    const trig = this.triggers.get(triggerId);
    if (!occupants || !trig) return;
    occupants.delete(blobId);
    if (occupants.size === 0) {
      // Hard reset: charge progress is lost the moment the area is empty.
      trig.chargeElapsed = 0;
      if (trig.pressed) {
        trig.pressed = false;
        trig.flashTimer = 0.2;
      }
    }
  }

  update(dt: number): void {
    for (const trig of this.triggers.values()) {
      if (trig.flashTimer > 0) trig.flashTimer = Math.max(0, trig.flashTimer - dt);
      const occupants = this.occupants.get(trig.def.id);
      if (!occupants || occupants.size === 0) continue;
      const charge = trig.def.chargeSeconds ?? 0;
      if (charge <= 0 || trig.pressed) continue;
      trig.chargeElapsed = Math.min(charge, trig.chargeElapsed + dt);
      if (trig.chargeElapsed >= charge) {
        trig.pressed = true;
        trig.flashTimer = 0.4;
      }
    }
  }

  /** Polled by `ActionManager` each frame. */
  isPressed(triggerId: string): boolean {
    return this.triggers.get(triggerId)?.pressed ?? false;
  }

  /** Charge progress in [0, 1]. Used by the renderer to draw a fill meter. */
  chargeProgress(triggerId: string): number {
    const trig = this.triggers.get(triggerId);
    if (!trig) return 0;
    const charge = trig.def.chargeSeconds ?? 0;
    if (charge <= 0) return trig.pressed ? 1 : 0;
    return Math.min(1, trig.chargeElapsed / charge);
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const trig of this.triggers.values()) {
      const { def } = trig;
      ctx.save();
      ctx.translate(def.x, def.y);
      ctx.rotate(def.rotation);
      const hw = def.width / 2;
      const hh = def.height / 2;

      const pressed = trig.pressed;
      const flash = trig.flashTimer;

      // Base plate
      ctx.fillStyle = pressed ? '#3a6e3a' : '#444';
      ctx.strokeStyle = pressed ? '#7fdc7f' : '#888';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-hw, -hh, def.width, def.height, 4);
      ctx.fill();
      ctx.stroke();

      // Top trigger surface
      const inset = 4;
      const lift = pressed ? 1 : 3;
      ctx.fillStyle = pressed ? '#5ec85e' : '#aaa';
      ctx.beginPath();
      ctx.roundRect(-hw + inset, -hh + inset - lift, def.width - 2 * inset, def.height - 2 * inset, 3);
      ctx.fill();

      // Charge meter (only when charging is in progress and not yet pressed)
      const progress = this.chargeProgress(def.id);
      if (!pressed && progress > 0 && progress < 1) {
        ctx.fillStyle = '#ffd84a';
        ctx.beginPath();
        ctx.roundRect(-hw + inset, -hh + inset - lift, (def.width - 2 * inset) * progress, def.height - 2 * inset, 3);
        ctx.fill();
      }

      if (flash > 0) {
        ctx.globalAlpha = flash;
        ctx.strokeStyle = pressed ? '#a0ffa0' : '#ff9090';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(-hw - 2, -hh - 2, def.width + 4, def.height + 4, 5);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  /** Serializable trigger state for network sync (keyframe replication).
   * Captures the latch/charge/flash plus the blob-id occupant set. Occupant
   * ids are deterministic across clients because blob ids are assigned by
   * `addBlob` in spawn order — and PlayerManager spawns players in
   * deterministic-id order on every client. */
  dumpState(): Record<string, { pressed: boolean; chargeElapsed: number; flashTimer: number; occupants: number[] }> {
    const out: Record<string, { pressed: boolean; chargeElapsed: number; flashTimer: number; occupants: number[] }> = {};
    for (const [id, trig] of this.triggers) {
      const occ = this.occupants.get(id);
      // Occupant ids sorted so iteration order is deterministic regardless
      // of insertion order on the local sim — a guest that observed enter
      // events in a different order than the host would otherwise produce
      // a different `occupants` array even after restoring.
      const occupants = occ ? [...occ].sort((a, b) => a - b) : [];
      out[id] = {
        pressed: trig.pressed,
        chargeElapsed: trig.chargeElapsed,
        flashTimer: trig.flashTimer,
        occupants,
      };
    }
    return out;
  }

  restoreState(state: Record<string, { pressed: boolean; chargeElapsed: number; flashTimer: number; occupants: number[] }>): void {
    for (const [id, v] of Object.entries(state)) {
      const trig = this.triggers.get(id);
      if (!trig) continue;
      trig.pressed = v.pressed;
      trig.chargeElapsed = v.chargeElapsed;
      trig.flashTimer = v.flashTimer;
      const occ = this.occupants.get(id);
      if (occ) {
        occ.clear();
        for (const blobId of v.occupants) occ.add(blobId);
      }
    }
  }

  cleanup(): void {
    this.triggers.clear();
    this.occupants.clear();
    this.shapeIdxToTriggerId = new Map();
    this.world = null;
  }
}
