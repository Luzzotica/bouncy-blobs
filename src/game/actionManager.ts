import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { ActionDef, ActionEasing, ActionMode } from '../levels/types';
import type { TriggerManager } from './triggerManager';
import type { PlatformMover } from './platformMover';
import { hashStringId } from './idHash';

/** Narrow interface for resolving a moving spike's authored base pose. Backed
 *  by SpikeManager. */
export interface SpikePoser {
  getSpikeBasePose(spikeId: string): { x: number; y: number; rotation: number } | null;
  setSpikePose(spikeId: string, x: number, y: number, rotation: number): void;
}

function modeNum(m: ActionMode): number {
  switch (m) { case 'switch': return 1; case 'oneShot': return 2; case 'timer': return 3; default: return 0; }
}
function easingNum(e: ActionEasing | undefined): number {
  switch (e ?? 'easeInOut') { case 'easeOut': return 1; case 'easeInOut': return 2; default: return 0; }
}

/**
 * Actions animate platforms / shape particles / spikes between a closed and an
 * open pose, driven by trigger state. The whole tween state machine now lives
 * in the Rust engine (Phase 7 of the JS→Rust migration); this manager is a thin
 * loader that registers each action + its targets at init via `addGameAction` /
 * `actionAddTarget*`. The engine drives the kinematic writes inside `world.step()`.
 */
export class ActionManager {
  private world: SoftBodyEngine | null = null;
  private shapeParticles = new Map<string, number[]>();

  initialize(
    world: SoftBodyEngine,
    actions: ActionDef[],
    pointShapeParticles: Map<string, number[]>,
    softPlatformStaticParticles: Map<string, number[]> | undefined,
    platformMover: PlatformMover | null,
    _triggerMgr: TriggerManager | null,
    spikePoser: SpikePoser | null = null,
  ): void {
    this.world = world;

    this.shapeParticles = new Map(pointShapeParticles);
    if (softPlatformStaticParticles) {
      for (const [id, ids] of softPlatformStaticParticles) this.shapeParticles.set(id, ids);
    }

    for (const def of actions) {
      const aidx = world.addGameAction(
        hashStringId(def.id),
        modeNum(def.mode),
        def.requireMode === 'all',
        easingNum(def.easing),
        Math.max(0, def.delaySeconds ?? 0),
        def.duration,
        def.intervalSeconds ?? 4,
        def.sourceTriggerIds.map(hashStringId),
      );

      for (const t of def.targets) {
        switch (t.kind) {
          case 'shapePoint': {
            const pid = this.shapeParticles.get(t.shapeId)?.[t.pointIndex];
            if (pid !== undefined) world.actionAddTargetShapePoint(aidx, pid, t.endX, t.endY);
            break;
          }
          case 'moveShape': {
            const ids = this.shapeParticles.get(t.shapeId);
            if (ids && ids.length) world.actionAddTargetMoveShape(aidx, ids, t.endX, t.endY);
            break;
          }
          case 'rotateShape': {
            const ids = this.shapeParticles.get(t.shapeId);
            if (ids && ids.length) world.actionAddTargetRotateShape(aidx, ids, t.endRotation);
            break;
          }
          case 'platform': {
            const data = platformMover?.getPlatformActionData(t.platformId);
            if (data) {
              world.actionAddTargetPlatform(
                aidx, data.staticIdx, data.baseX, data.baseY, data.baseRot, data.localPoly,
                t.endX, t.endY, t.endRotation ?? data.baseRot,
              );
            }
            break;
          }
          case 'spike': {
            const base = spikePoser?.getSpikeBasePose(t.spikeId);
            if (base) {
              world.actionAddTargetSpike(
                aidx, hashStringId(t.spikeId), base.x, base.y, base.rotation,
                t.endX, t.endY, t.endRotation ?? base.rotation,
              );
            }
            break;
          }
        }
      }
    }
  }

  /** No-op: the engine advances the action tweens inside `world.step()`. */
  update(_dt: number): void {}

  cleanup(): void {
    this.world = null;
    this.shapeParticles = new Map();
  }
}
