import { SoftBodyWorld } from '../physics/softBodyWorld';
import { PressurePlateDef } from '../levels/types';
import { TriggerManager } from './triggerManager';

interface RegisteredPlate {
  def: PressurePlateDef;
  pressed: boolean;
  flashTimer: number;
  consumed: boolean;
}

export class PressurePlateManager {
  private plates = new Map<string, RegisteredPlate>();
  /** physics-world trigger shape index → plate id */
  private shapeIdxToPlateId = new Map<number, string>();
  /** Active blob occupants per plate (so plate stays "pressed" while any blob is on it). */
  private occupants = new Map<string, Set<number>>();
  private world: SoftBodyWorld | null = null;
  private triggerManager: TriggerManager | null = null;

  initialize(
    world: SoftBodyWorld,
    defs: PressurePlateDef[],
    shapeIdxToPlateId: Map<number, string>,
    triggerManager: TriggerManager,
  ): void {
    this.world = world;
    this.triggerManager = triggerManager;
    this.shapeIdxToPlateId = shapeIdxToPlateId;
    this.plates.clear();
    this.occupants.clear();
    for (const def of defs) {
      this.plates.set(def.id, { def, pressed: false, flashTimer: 0, consumed: false });
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
    const plateId = this.shapeIdxToPlateId.get(shapeIdx);
    if (!plateId) return;
    const plate = this.plates.get(plateId);
    if (!plate) return;
    if (plate.consumed) return;
    const occupants = this.occupants.get(plateId);
    if (!occupants) return;
    const wasEmpty = occupants.size === 0;
    occupants.add(blobId);
    if (wasEmpty) {
      plate.pressed = true;
      plate.flashTimer = 0.4;
      for (const triggerId of plate.def.triggerIds) {
        this.triggerManager?.fire(triggerId);
      }
      if (plate.def.oneShot) plate.consumed = true;
    }
  }

  private handleExit(shapeIdx: number, blobId: number): void {
    const plateId = this.shapeIdxToPlateId.get(shapeIdx);
    if (!plateId) return;
    const occupants = this.occupants.get(plateId);
    const plate = this.plates.get(plateId);
    if (!occupants || !plate) return;
    occupants.delete(blobId);
    if (occupants.size === 0) plate.pressed = false;
  }

  update(dt: number): void {
    for (const plate of this.plates.values()) {
      if (plate.flashTimer > 0) plate.flashTimer = Math.max(0, plate.flashTimer - dt);
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const plate of this.plates.values()) {
      const { def } = plate;
      ctx.save();
      ctx.translate(def.x, def.y);
      ctx.rotate(def.rotation);
      const hw = def.width / 2;
      const hh = def.height / 2;

      const pressed = plate.pressed || plate.consumed;
      const flash = plate.flashTimer;

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

      if (flash > 0) {
        ctx.globalAlpha = flash;
        ctx.strokeStyle = '#a0ffa0';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(-hw - 2, -hh - 2, def.width + 4, def.height + 4, 5);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  cleanup(): void {
    this.plates.clear();
    this.occupants.clear();
    this.shapeIdxToPlateId = new Map();
    this.world = null;
    this.triggerManager = null;
  }
}
