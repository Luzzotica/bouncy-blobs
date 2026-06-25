import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { vec2 } from '../physics/vec2';
import { ActionDef, ActionEasing, ActionTarget } from '../levels/types';
import type { TriggerManager } from './triggerManager';
import type { PlatformMover } from './platformMover';

/** Rest data captured at init for a rotateShape target. The rotation is
 *  applied each tick by rotating these offsets around the centroid and
 *  writing the result back to the live particle positions. */
interface RotateShapeRest {
  centroidX: number;
  centroidY: number;
  offsets: { x: number; y: number }[];
  anchored: boolean[];
  particleIds: number[];
}

/** Per-target animated state. Lets us tween-restart from the current animated
 *  position whenever direction flips mid-flight. */
interface TargetState {
  /** Current animated position, written every frame. Unused for rotateShape. */
  curX: number;
  curY: number;
  /** Closed (initial) position. Snapshot at initialize(). */
  closedX: number;
  closedY: number;
  /** Current animated rotation (radians). Used by 'platform' targets that
   *  opt into rotation, and by 'rotateShape' targets (whose curX/curY are
   *  ignored). Closed-pose rotation: platforms = def.rotation; rotateShape = 0. */
  curRot: number;
  closedRot: number;
}

interface PendingTween {
  direction: 'open' | 'close';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  startRot: number;
  endRot: number;
  duration: number;
  elapsed: number;
  easing: ActionEasing;
}

type ActionRunState = 'closed' | 'opening' | 'open' | 'closing';

interface ActionRuntime {
  def: ActionDef;
  /** State per target, parallel array with `def.targets`. */
  targetStates: TargetState[];
  /** Per-target active tween (null when at rest). Parallel array. */
  tweens: (PendingTween | null)[];
  /** Rest data for `rotateShape` targets (parallel array; null for others). */
  rotateRest: (RotateShapeRest | null)[];
  state: ActionRunState;
  prevActivated: boolean;
  pendingFireAt: number | null;
  pendingDirection: 'open' | 'close' | null;
  consumed: boolean;
  /** Timer-mode bootstrap latch: schedule the first fire exactly once,
   *  then let the open→close→wait cycle perpetuate itself. */
  timerBootstrapped: boolean;
}

function ease(t: number, kind: ActionEasing): number {
  switch (kind) {
    case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case 'easeOut': return 1 - Math.pow(1 - t, 2);
    case 'linear':
    default: return t;
  }
}

/** Narrow interface the action system needs to drive a moving spike. Backed
 *  by SpikeManager — kept minimal so ActionManager stays decoupled. */
export interface SpikePoser {
  getSpikeBasePose(spikeId: string): { x: number; y: number; rotation: number } | null;
  setSpikePose(spikeId: string, x: number, y: number, rotation: number): void;
}

export class ActionManager {
  private world: SoftBodyEngine | null = null;
  private actions = new Map<string, ActionRuntime>();
  private shapeParticles = new Map<string, number[]>();
  private platformMover: PlatformMover | null = null;
  private spikePoser: SpikePoser | null = null;
  private triggerMgr: TriggerManager | null = null;
  /** Manager-local clock in seconds. Advances each update(dt). */
  private clock = 0;

  initialize(
    world: SoftBodyEngine,
    actions: ActionDef[],
    pointShapeParticles: Map<string, number[]>,
    softPlatformStaticParticles: Map<string, number[]> | undefined,
    platformMover: PlatformMover | null,
    triggerMgr: TriggerManager | null,
    spikePoser: SpikePoser | null = null,
  ): void {
    this.world = world;
    this.platformMover = platformMover;
    this.spikePoser = spikePoser;
    this.triggerMgr = triggerMgr;
    this.clock = 0;

    // Merge pointShape + softPlatform anchor id-spaces.
    this.shapeParticles = new Map(pointShapeParticles);
    if (softPlatformStaticParticles) {
      for (const [id, ids] of softPlatformStaticParticles) {
        this.shapeParticles.set(id, ids);
      }
    }

    this.actions.clear();
    for (const def of actions) {
      const targetStates: TargetState[] = [];
      const tweens: (PendingTween | null)[] = [];
      const rotateRest: (RotateShapeRest | null)[] = [];
      for (const t of def.targets) {
        const closed = this.resolveClosedPose(t);
        targetStates.push({
          curX: closed.x, curY: closed.y,
          closedX: closed.x, closedY: closed.y,
          curRot: closed.rot, closedRot: closed.rot,
        });
        tweens.push(null);
        // Both rotateShape and moveShape need the rest snapshot (centroid +
        // per-particle offsets); moveShape translates it, rotateShape rotates it.
        rotateRest.push(
          t.kind === 'rotateShape' || t.kind === 'moveShape' ? this.snapshotRotateRest(t.shapeId) : null,
        );
      }
      this.actions.set(def.id, {
        def,
        targetStates,
        tweens,
        rotateRest,
        state: 'closed',
        prevActivated: false,
        pendingFireAt: null,
        pendingDirection: null,
        consumed: false,
        timerBootstrapped: false,
      });
    }
  }

  /** Closed-pose (x, y, rotation) for a target. Rotation is meaningful only
   *  for platforms (= def.rotation) and rotateShape (= 0); other kinds use 0. */
  private resolveClosedPose(target: ActionTarget): { x: number; y: number; rot: number } {
    if (target.kind === 'shapePoint') {
      const particles = this.shapeParticles.get(target.shapeId);
      const pid = particles?.[target.pointIndex];
      if (pid !== undefined && this.world) {
        const p = this.world.pos[pid];
        return { x: p.x, y: p.y, rot: 0 };
      }
      return { x: 0, y: 0, rot: 0 };
    }
    if (target.kind === 'rotateShape') {
      // Position is irrelevant; closed rotation is always 0.
      return { x: 0, y: 0, rot: 0 };
    }
    if (target.kind === 'spike') {
      const base = this.spikePoser?.getSpikeBasePose(target.spikeId);
      return { x: base?.x ?? 0, y: base?.y ?? 0, rot: base?.rotation ?? 0 };
    }
    if (target.kind === 'moveShape') {
      // Closed pose = rest centroid of the shape's particles.
      const particleIds = this.shapeParticles.get(target.shapeId);
      if (particleIds && particleIds.length > 0 && this.world) {
        let sx = 0, sy = 0, count = 0;
        for (const id of particleIds) {
          const p = this.world.pos[id];
          if (!p) continue;
          sx += p.x; sy += p.y; count++;
        }
        if (count > 0) return { x: sx / count, y: sy / count, rot: 0 };
      }
      return { x: 0, y: 0, rot: 0 };
    }
    // platform
    const closed = this.platformMover?.getBasePosition(target.platformId);
    const rot = this.platformMover?.getBaseRotation(target.platformId) ?? 0;
    return { x: closed?.x ?? 0, y: closed?.y ?? 0, rot };
  }

  /** Snapshot rest centroid + per-particle offsets for a rotateShape target,
   *  read from the current world positions. Anchored particles are flagged
   *  so the runtime skips them — they stay pinned in space. */
  private snapshotRotateRest(shapeId: string): RotateShapeRest | null {
    const particleIds = this.shapeParticles.get(shapeId);
    if (!particleIds || particleIds.length === 0 || !this.world) return null;
    let sx = 0, sy = 0, count = 0;
    for (const id of particleIds) {
      const p = this.world.pos[id];
      if (!p) continue;
      sx += p.x; sy += p.y; count++;
    }
    if (count === 0) return null;
    const cx = sx / count, cy = sy / count;
    const offsets: { x: number; y: number }[] = [];
    const anchored: boolean[] = [];
    for (const id of particleIds) {
      const p = this.world.pos[id];
      if (!p) { offsets.push({ x: 0, y: 0 }); anchored.push(true); continue; }
      offsets.push({ x: p.x - cx, y: p.y - cy });
      // Anchored = pinned (invMass === 0). Skip in apply step.
      anchored.push(this.world.invMass[id] === 0);
    }
    return { centroidX: cx, centroidY: cy, offsets, anchored, particleIds: [...particleIds] };
  }

  update(dt: number): void {
    if (!this.world) return;
    this.clock += dt;

    for (const action of this.actions.values()) {
      this.tickSources(action);
      this.tickPending(action);
      this.tickTweens(action, dt);
    }
  }

  /** Read source triggers, detect rising/falling edges, queue tweens per mode. */
  private tickSources(action: ActionRuntime): void {
    const { def } = action;
    const sources = def.sourceTriggerIds;
    let nowActivated: boolean;
    if (sources.length === 0) {
      nowActivated = false;
    } else if (def.requireMode === 'all') {
      nowActivated = sources.every(id => this.triggerMgr?.isPressed(id) ?? false);
    } else {
      nowActivated = sources.some(id => this.triggerMgr?.isPressed(id) ?? false);
    }

    const rising = !action.prevActivated && nowActivated;
    const falling = action.prevActivated && !nowActivated;
    const delay = Math.max(0, def.delaySeconds ?? 0);

    switch (def.mode) {
      case 'continuous':
        if (rising) this.scheduleFire(action, 'open', delay);
        if (falling) {
          if (action.pendingDirection === 'open') {
            // Cancel pending open: user released before the delay elapsed.
            action.pendingFireAt = null;
            action.pendingDirection = null;
          } else {
            // Close immediately on release (no delay for the close half).
            this.scheduleFire(action, 'close', 0);
          }
        }
        break;
      case 'switch':
        if (rising && !action.pendingDirection) {
          // Pick the direction we'd flip to based on the current state.
          const wantsOpen = action.state === 'closed' || action.state === 'closing';
          this.scheduleFire(action, wantsOpen ? 'open' : 'close', delay);
        }
        break;
      case 'oneShot':
        if (rising && !action.consumed) {
          this.scheduleFire(action, 'open', delay);
          action.consumed = true;
        }
        break;
      case 'timer':
        // Triggers are IGNORED in timer mode — the cycle runs autonomously.
        // Bootstrap the first open exactly once; the rest of the cycle is
        // perpetuated by the tween-complete handler in tickTweens.
        if (!action.timerBootstrapped) {
          this.scheduleFire(action, 'open', delay);
          action.timerBootstrapped = true;
        }
        break;
    }

    action.prevActivated = nowActivated;
  }

  private scheduleFire(action: ActionRuntime, direction: 'open' | 'close', delay: number): void {
    action.pendingFireAt = this.clock + delay;
    action.pendingDirection = direction;
  }

  /** When clock reaches a pending fire's deadline, start the per-target tween. */
  private tickPending(action: ActionRuntime): void {
    if (action.pendingFireAt === null || action.pendingDirection === null) return;
    if (this.clock < action.pendingFireAt) return;

    const direction = action.pendingDirection;
    action.pendingFireAt = null;
    action.pendingDirection = null;
    action.state = direction === 'open' ? 'opening' : 'closing';

    const duration = Math.max(0.001, action.def.duration);
    const easing = action.def.easing ?? 'easeInOut';
    for (let i = 0; i < action.def.targets.length; i++) {
      const target = action.def.targets[i];
      const ts = action.targetStates[i];
      // Compute the open-pose endX/endY/endRot for whatever target kind
      // this is. rotateShape has no position, only rotation; platforms
      // can opt into rotation with their optional endRotation field.
      let openX = ts.closedX, openY = ts.closedY, openRot = ts.closedRot;
      if (target.kind === 'shapePoint' || target.kind === 'moveShape') {
        openX = target.endX; openY = target.endY;
      } else if (target.kind === 'platform' || target.kind === 'spike') {
        openX = target.endX; openY = target.endY;
        openRot = target.endRotation ?? ts.closedRot;
      } else if (target.kind === 'rotateShape') {
        openRot = target.endRotation;
      }
      const endX = direction === 'open' ? openX : ts.closedX;
      const endY = direction === 'open' ? openY : ts.closedY;
      const rawEndRot = direction === 'open' ? openRot : ts.closedRot;
      // Take the SHORTEST-arc path from current rotation to the target.
      // Without this, accumulated rotation outside (-π, π] makes the lerp
      // swing the LONG way around — e.g. "rotate 135°" ends up doing a
      // full rotation + 135° because startRot drifted past π.
      const TWO_PI = Math.PI * 2;
      let delta = (rawEndRot - ts.curRot) % TWO_PI;
      if (delta > Math.PI) delta -= TWO_PI;
      else if (delta <= -Math.PI) delta += TWO_PI;
      const endRot = ts.curRot + delta;
      action.tweens[i] = {
        direction,
        startX: ts.curX,
        startY: ts.curY,
        endX,
        endY,
        startRot: ts.curRot,
        endRot,
        duration,
        elapsed: 0,
        easing,
      };
    }
  }

  /** Advance per-target tweens and write to the world / platform mover. */
  private tickTweens(action: ActionRuntime, dt: number): void {
    let stillTweening = false;
    for (let i = 0; i < action.def.targets.length; i++) {
      const tween = action.tweens[i];
      const ts = action.targetStates[i];
      if (tween) {
        tween.elapsed += dt;
        const t = Math.min(1, tween.elapsed / tween.duration);
        const k = ease(t, tween.easing);
        ts.curX = tween.startX + (tween.endX - tween.startX) * k;
        ts.curY = tween.startY + (tween.endY - tween.startY) * k;
        ts.curRot = tween.startRot + (tween.endRot - tween.startRot) * k;
        if (t >= 1) action.tweens[i] = null;
        else stillTweening = true;
      }
      this.applyTarget(action.def.targets[i], ts, action.rotateRest[i], dt);
    }

    if (!stillTweening && action.tweens.every(t => t === null)) {
      if (action.state === 'opening') {
        action.state = 'open';
        // Timer mode: immediately schedule the close half of the cycle.
        if (action.def.mode === 'timer') {
          this.scheduleFire(action, 'close', 0);
        }
      } else if (action.state === 'closing') {
        action.state = 'closed';
        // Timer mode: wait the remainder of intervalSeconds before next
        // open. `intervalSeconds` is the TOTAL cycle period, so the
        // hold-closed time is the leftover after both open+close animations.
        if (action.def.mode === 'timer') {
          const interval = Math.max(0.1, action.def.intervalSeconds ?? 4);
          const cycleWork = 2 * Math.max(0.001, action.def.duration);
          const holdClosed = Math.max(0, interval - cycleWork);
          this.scheduleFire(action, 'open', holdClosed);
        }
      }
    }
  }

  private applyTarget(target: ActionTarget, ts: TargetState, rest: RotateShapeRest | null, dt: number): void {
    if (target.kind === 'shapePoint') {
      const particles = this.shapeParticles.get(target.shapeId);
      const pid = particles?.[target.pointIndex];
      if (pid === undefined || !this.world) return;
      // Compute kinematic velocity from THIS tick's position delta. This is
      // what collision resolution uses to push contacting blobs along with
      // the moving anchor — without it (or with vel=0), a blob in contact
      // with a moving anchor stays put while the anchor teleports through
      // it, producing the "I clip through the platform edge" bug.
      this.applyParticleKinematic(pid, ts.curX, ts.curY, dt);
      return;
    }
    if (target.kind === 'platform') {
      // Use setPose so rotation animates too. When target has no endRotation
      // the tween's start/end rot are both the closed-pose rotation, so the
      // platform translates only — identical to the old setPlatformPos path.
      this.platformMover?.setPose(target.platformId, ts.curX, ts.curY, ts.curRot, dt);
      return;
    }
    if (target.kind === 'spike') {
      // Spikes have no physics body — just drive the live pose SpikeManager
      // reads for collision + render. No kinematic velocity needed (a spike
      // kills on contact; there's no "carry the blob along" force).
      this.spikePoser?.setSpikePose(target.spikeId, ts.curX, ts.curY, ts.curRot);
      return;
    }
    if (target.kind === 'rotateShape') {
      if (!rest || !this.world) return;
      const cos = Math.cos(ts.curRot);
      const sin = Math.sin(ts.curRot);
      for (let i = 0; i < rest.particleIds.length; i++) {
        if (rest.anchored[i]) continue;
        const off = rest.offsets[i];
        const tx = rest.centroidX + off.x * cos - off.y * sin;
        const ty = rest.centroidY + off.x * sin + off.y * cos;
        const pid = rest.particleIds[i];
        this.applyParticleKinematic(pid, tx, ty, dt);
      }
      return;
    }
    if (target.kind === 'moveShape') {
      // Rigid translation: every particle = its rest offset + the animated
      // centroid (ts.curX/curY). Anchored particles stay pinned.
      if (!rest || !this.world) return;
      for (let i = 0; i < rest.particleIds.length; i++) {
        if (rest.anchored[i]) continue;
        const off = rest.offsets[i];
        this.applyParticleKinematic(rest.particleIds[i], ts.curX + off.x, ts.curY + off.y, dt);
      }
      return;
    }
  }

  /** Move a particle to (x, y) AND set its velocity to the implied
   *  kinematic velocity (newPos - oldPos) / dt. Used by every action path
   *  that teleports particles, so blobs in contact with the moving
   *  particle get a correct push during collision resolution instead of
   *  passing through. */
  private applyParticleKinematic(pid: number, x: number, y: number, dt: number): void {
    if (!this.world) return;
    const old = this.world.pos[pid];
    const safeDt = Math.max(dt, 1e-4);
    const vx = old ? (x - old.x) / safeDt : 0;
    const vy = old ? (y - old.y) / safeDt : 0;
    this.world.setParticlePos(pid, x, y);
    this.world.setParticleVel(pid, vx, vy);
  }

  /** Serializable mutable state for network sync. Captures the global
   * action clock (which drives pending-fire timing), each action's
   * state-machine slot, per-target tween progress, and consumed/pending
   * latches. NOT serialized: `def` (immutable level data) and
   * `targetStates[i].closed{X,Y}` (snapshot at init, identical on every
   * client because the level data is identical). */
  dumpState(): {
    clock: number;
    actions: Record<string, {
      state: ActionRunState;
      prevActivated: boolean;
      pendingFireAt: number | null;
      pendingDirection: 'open' | 'close' | null;
      consumed: boolean;
      targetCurs: { x: number; y: number; rot: number }[];
      tweens: (PendingTween | null)[];
    }>;
  } {
    const actions: Record<string, {
      state: ActionRunState;
      prevActivated: boolean;
      pendingFireAt: number | null;
      pendingDirection: 'open' | 'close' | null;
      consumed: boolean;
      targetCurs: { x: number; y: number; rot: number }[];
      tweens: (PendingTween | null)[];
    }> = {};
    for (const [id, a] of this.actions) {
      actions[id] = {
        state: a.state,
        prevActivated: a.prevActivated,
        pendingFireAt: a.pendingFireAt,
        pendingDirection: a.pendingDirection,
        consumed: a.consumed,
        targetCurs: a.targetStates.map(ts => ({ x: ts.curX, y: ts.curY, rot: ts.curRot })),
        tweens: a.tweens.map(t => (t ? { ...t } : null)),
      };
    }
    return { clock: this.clock, actions };
  }

  restoreState(snapshot: ReturnType<ActionManager['dumpState']>): void {
    this.clock = snapshot.clock;
    for (const [id, v] of Object.entries(snapshot.actions)) {
      const a = this.actions.get(id);
      if (!a) continue;
      a.state = v.state;
      a.prevActivated = v.prevActivated;
      a.pendingFireAt = v.pendingFireAt;
      a.pendingDirection = v.pendingDirection;
      a.consumed = v.consumed;
      for (let i = 0; i < a.targetStates.length; i++) {
        const tc = v.targetCurs[i];
        if (tc) {
          a.targetStates[i].curX = tc.x;
          a.targetStates[i].curY = tc.y;
          if (typeof tc.rot === 'number') a.targetStates[i].curRot = tc.rot;
        }
        a.tweens[i] = v.tweens[i] ? { ...v.tweens[i]! } : null;
      }
    }
  }

  cleanup(): void {
    this.world = null;
    this.actions.clear();
    this.shapeParticles = new Map();
    this.platformMover = null;
    this.triggerMgr = null;
  }
}
