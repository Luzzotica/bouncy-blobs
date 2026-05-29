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
  /** Predicate identifying NPC blobs; used to honor TriggerDef.ignoreNpcs.
   *  Defaults to "no blob is an NPC" so callers that don't supply one keep
   *  the previous behavior (everything can press). */
  private isNpcBlob: (blobId: number) => boolean = () => false;

  initialize(
    world: SoftBodyEngine,
    defs: TriggerDef[],
    shapeIdxToTriggerId: Map<number, string>,
    isNpcBlob?: (blobId: number) => boolean,
  ): void {
    this.world = world;
    this.shapeIdxToTriggerId = shapeIdxToTriggerId;
    this.isNpcBlob = isNpcBlob ?? (() => false);
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
    if (trig.def.ignoreNpcs && this.isNpcBlob(blobId)) return;
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
      const progress = this.chargeProgress(def.id);
      const charging = !pressed && progress > 0 && progress < 1;

      // Empty zone — a faint translucent fill so the rectangle reads as a
      // "stand here" area without competing with platforms. Slightly green
      // tint when pressed; default ghostly white otherwise.
      let fillColor: string;
      let strokeColor: string;
      if (pressed) {
        fillColor   = 'rgba(120, 240, 120, 0.16)';
        strokeColor = 'rgba(150, 255, 150, 0.95)';
      } else if (charging) {
        // No background tint while charging — the progress fill below
        // grows across the whole zone and IS the charging cue.
        fillColor   = 'rgba(255, 255, 255, 0.04)';
        strokeColor = 'rgba(255, 215, 90, 0.85)';
      } else {
        fillColor   = 'rgba(255, 255, 255, 0.06)';
        strokeColor = 'rgba(230, 230, 240, 0.7)';
      }

      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.roundRect(-hw, -hh, def.width, def.height, 4);
      ctx.fill();

      // Charge progress — see-through yellow rect that grows across the
      // whole zone (left → right) as charging completes. Clipped to the
      // rounded-rect silhouette so the corners stay clean.
      if (charging) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(-hw, -hh, def.width, def.height, 4);
        ctx.clip();
        ctx.fillStyle = 'rgba(255, 216, 74, 0.28)';
        ctx.fillRect(-hw, -hh, def.width * progress, def.height);
        ctx.restore();
      }

      // Dashed outline — the visual cue that this is a zone, not a solid
      // platform. Pattern scales with platform size so tiny triggers don't
      // look like a single solid line.
      const dashLen = Math.max(6, Math.min(14, def.width * 0.05));
      const gapLen  = Math.max(4, dashLen * 0.6);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([dashLen, gapLen]);
      ctx.beginPath();
      ctx.roundRect(-hw, -hh, def.width, def.height, 4);
      ctx.stroke();
      ctx.setLineDash([]);

      // Flash on press — bright dashed ring outside the trigger.
      if (flash > 0) {
        ctx.globalAlpha = flash;
        ctx.strokeStyle = pressed ? '#a0ffa0' : '#ff9090';
        ctx.lineWidth = 3;
        ctx.setLineDash([dashLen, gapLen]);
        ctx.beginPath();
        ctx.roundRect(-hw - 3, -hh - 3, def.width + 6, def.height + 6, 6);
        ctx.stroke();
        ctx.setLineDash([]);
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
