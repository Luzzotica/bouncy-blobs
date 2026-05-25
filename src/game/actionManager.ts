import { SoftBodyWorld } from '../physics/softBodyWorld';
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import { vec2 } from '../physics/vec2';
import { ActionDef, ActionEasing, ActionTarget } from '../levels/types';
import type { TriggerManager } from './triggerManager';
import type { PlatformMover } from './platformMover';

/** Per-target animated state. Lets us tween-restart from the current animated
 *  position whenever direction flips mid-flight. */
interface TargetState {
  /** Current animated position, written every frame. */
  curX: number;
  curY: number;
  /** Closed (initial) position. Snapshot at initialize(). */
  closedX: number;
  closedY: number;
}

interface PendingTween {
  /** Direction the tween is heading. */
  direction: 'open' | 'close';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
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
  /** High-level state for the action as a whole. */
  state: ActionRunState;
  /** Result of the source-triggers combine on the previous frame. */
  prevActivated: boolean;
  /** Time (seconds, manager-local clock) when the pending fire should kick off. */
  pendingFireAt: number | null;
  pendingDirection: 'open' | 'close' | null;
  /** OneShot: once true, the action ignores all subsequent activations. */
  consumed: boolean;
}

function ease(t: number, kind: ActionEasing): number {
  switch (kind) {
    case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case 'easeOut': return 1 - Math.pow(1 - t, 2);
    case 'linear':
    default: return t;
  }
}

export class ActionManager {
  private world: SoftBodyEngine | null = null;
  private actions = new Map<string, ActionRuntime>();
  private shapeParticles = new Map<string, number[]>();
  private platformMover: PlatformMover | null = null;
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
  ): void {
    this.world = world;
    this.platformMover = platformMover;
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
      for (const t of def.targets) {
        const closed = this.resolveClosedPosition(t);
        targetStates.push({ curX: closed.x, curY: closed.y, closedX: closed.x, closedY: closed.y });
        tweens.push(null);
      }
      this.actions.set(def.id, {
        def,
        targetStates,
        tweens,
        state: 'closed',
        prevActivated: false,
        pendingFireAt: null,
        pendingDirection: null,
        consumed: false,
      });
    }
  }

  private resolveClosedPosition(target: ActionTarget): { x: number; y: number } {
    if (target.kind === 'shapePoint') {
      const particles = this.shapeParticles.get(target.shapeId);
      const pid = particles?.[target.pointIndex];
      if (pid !== undefined && this.world) {
        const p = this.world.pos[pid];
        return { x: p.x, y: p.y };
      }
      return { x: 0, y: 0 };
    }
    // platform
    const closed = this.platformMover?.getBasePosition(target.platformId);
    return closed ?? { x: 0, y: 0 };
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
      const endX = direction === 'open' ? target.endX : ts.closedX;
      const endY = direction === 'open' ? target.endY : ts.closedY;
      action.tweens[i] = {
        direction,
        startX: ts.curX,
        startY: ts.curY,
        endX,
        endY,
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
        if (t >= 1) action.tweens[i] = null;
        else stillTweening = true;
      }
      this.applyTarget(action.def.targets[i], ts.curX, ts.curY, dt);
    }

    if (!stillTweening && action.tweens.every(t => t === null)) {
      if (action.state === 'opening') action.state = 'open';
      else if (action.state === 'closing') action.state = 'closed';
    }
  }

  private applyTarget(target: ActionTarget, x: number, y: number, dt: number): void {
    if (target.kind === 'shapePoint') {
      const particles = this.shapeParticles.get(target.shapeId);
      const pid = particles?.[target.pointIndex];
      if (pid === undefined || !this.world) return;
      this.world.setParticlePos(pid, x, y);
      // Zero velocity on anchored points so the solver doesn't drag them.
      if (this.world.invMass[pid] === 0) {
        this.world.setParticleVel(pid, 0, 0);
      }
      return;
    }
    // platform
    this.platformMover?.setPlatformPos(target.platformId, x, y, dt);
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
      targetCurs: { x: number; y: number }[];
      tweens: (PendingTween | null)[];
    }>;
  } {
    const actions: Record<string, {
      state: ActionRunState;
      prevActivated: boolean;
      pendingFireAt: number | null;
      pendingDirection: 'open' | 'close' | null;
      consumed: boolean;
      targetCurs: { x: number; y: number }[];
      tweens: (PendingTween | null)[];
    }> = {};
    for (const [id, a] of this.actions) {
      actions[id] = {
        state: a.state,
        prevActivated: a.prevActivated,
        pendingFireAt: a.pendingFireAt,
        pendingDirection: a.pendingDirection,
        consumed: a.consumed,
        targetCurs: a.targetStates.map(ts => ({ x: ts.curX, y: ts.curY })),
        // Shallow clone each tween (or null). PendingTween fields are all
        // primitives so a spread copy is sufficient.
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
