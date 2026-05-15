import { SoftBodyWorld } from '../physics/softBodyWorld';
import { vec2 } from '../physics/vec2';
import { TriggerDef, TriggerEasing } from '../levels/types';

interface ActiveTween {
  particleId: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  duration: number;
  elapsed: number;
  easing: TriggerEasing;
  reverse: boolean;
}

function ease(t: number, kind: TriggerEasing): number {
  switch (kind) {
    case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case 'easeOut': return 1 - Math.pow(1 - t, 2);
    case 'linear':
    default: return t;
  }
}

export class TriggerManager {
  private world: SoftBodyWorld | null = null;
  private triggers = new Map<string, TriggerDef>();
  private shapeParticles: Map<string, number[]> = new Map();
  private active: ActiveTween[] = [];
  /** Track which triggers have run, to support oneShot semantics in a follow-up. */
  private fired = new Set<string>();

  initialize(
    world: SoftBodyWorld,
    triggers: TriggerDef[],
    pointShapeParticles: Map<string, number[]>,
    softPlatformStaticParticles?: Map<string, number[]>,
  ): void {
    this.world = world;
    // Merge pointShape and softPlatform addressable particles into a single
    // id → particle-ids lookup. softPlatforms map their static anchor list
    // in order: index 0 = first static anchor (TL for 'corners' pattern), etc.
    this.shapeParticles = new Map(pointShapeParticles);
    if (softPlatformStaticParticles) {
      for (const [id, ids] of softPlatformStaticParticles) {
        this.shapeParticles.set(id, ids);
      }
    }
    this.triggers.clear();
    this.active = [];
    this.fired.clear();
    for (const t of triggers) this.triggers.set(t.id, t);
  }

  fire(triggerId: string): void {
    if (!this.world) return;
    const def = this.triggers.get(triggerId);
    if (!def || def.kind !== 'movePoints') return;
    // Toggle: if any tween for this trigger is still running, ignore; otherwise start a new one.
    // We move in the configured direction; subsequent fires reverse.
    const reverse = this.fired.has(triggerId);
    for (const target of def.targets) {
      const particles = this.shapeParticles.get(target.shapeId);
      if (!particles) continue;
      const pid = particles[target.pointIndex];
      if (pid === undefined) continue;
      const cur = this.world.pos[pid];
      this.active.push({
        particleId: pid,
        startX: cur.x,
        startY: cur.y,
        endX: reverse ? target.endX : target.endX, // placeholder: same end either way for v1
        endY: reverse ? target.endY : target.endY,
        duration: Math.max(0.001, def.duration),
        elapsed: 0,
        easing: def.easing ?? 'easeInOut',
        reverse,
      });
    }
    this.fired.add(triggerId);
  }

  update(dt: number): void {
    if (!this.world) return;
    if (this.active.length === 0) return;
    const surviving: ActiveTween[] = [];
    for (const tween of this.active) {
      tween.elapsed += dt;
      const t = Math.min(1, tween.elapsed / tween.duration);
      const k = ease(t, tween.easing);
      const x = tween.startX + (tween.endX - tween.startX) * k;
      const y = tween.startY + (tween.endY - tween.startY) * k;
      this.world.pos[tween.particleId] = vec2(x, y);
      // Zero velocity on anchored points so the constraint solver doesn't drag them around.
      if (this.world.invMass[tween.particleId] === 0) {
        this.world.vel[tween.particleId] = vec2(0, 0);
      }
      if (t < 1) surviving.push(tween);
    }
    this.active = surviving;
  }

  cleanup(): void {
    this.world = null;
    this.triggers.clear();
    this.shapeParticles = new Map();
    this.active = [];
    this.fired.clear();
  }
}
