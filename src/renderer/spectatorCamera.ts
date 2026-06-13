import { Vec2 } from '../physics/vec2';

// ─────────────────────────────────────────────────────────────────────────────
// Spectator director — a virtual broadcast camera for content capture.
//
// Instead of the full-arena wide shot (where blobs are tiny), this picks ONE
// blob to follow, frames it tight, and "cuts" to a new blob when its target
// dies or the action clearly moves elsewhere. The followed blob — plus any
// opponents close enough to be fighting it — is always kept in frame.
//
// Two directing modes:
//   • Race (raceGoal set): always follow first place — the blob closest to the
//     goal — so the camera rides the leader to the finish.
//   • Brawl (raceGoal null, e.g. KOTH): follow the action — whoever has the
//     most opponents nearby — and never linger on an idle blob.
//
// Render-only: it reads positions/scores and produces camera framing. Nothing
// here touches the simulation, and selection is deterministic (no RNG), so two
// clients watching the same match would direct identically.
// ─────────────────────────────────────────────────────────────────────────────

export interface SpectatorBlob {
  id: string;
  pos: Vec2;
  dead: boolean;
  /** Mode score if any (KOTH points); 0 for modes without continuous scoring. */
  score: number;
}

export interface SpectatorFraming {
  /** World points the camera should keep in view (focus blob + its scrum). */
  targets: Vec2[];
  padding: number;
  minZoom: number;
  maxZoom: number;
  /** The blob currently being followed, or null if nobody is alive. */
  focusId: string | null;
  /** True on the frame a new focus was chosen — caller may hard-cut. */
  cut: boolean;
}

// How close another blob must be (world units) to count as "in the fight" with
// the focus blob, and thus get framed alongside it. ~5 blob diameters.
const FIGHT_RADIUS = 520;
// Minimum seconds to hold a target before action-based switching is allowed.
// Death-driven switches ignore this so we never linger on a corpse.
const MIN_DWELL_SEC = 4;
// A challenger must be this much more "interesting" than the current focus to
// steal the camera — hysteresis so the camera doesn't dither between blobs.
const SWITCH_MARGIN = 1.4;
// Below this speed (world units/sec) a blob counts as idle / doing nothing.
const IDLE_SPEED = 60;
// Bail off an idle focus after this long — never sit on a blob doing nothing
// for more than a few seconds (overrides MIN_DWELL).
const IDLE_MAX_SEC = 2.5;
// Race lead must change by more than this (world units closer to the goal)
// before the camera switches to a new leader — avoids jitter near ties.
const LEAD_MARGIN = 70;

// Framing knobs, tuned for a 1080×1920 portrait frame. Pulled back ~50% from
// the original tight values so fast blobs don't outrun the (lerped) camera and
// leave frame — a lone focus blob now fills ~half the width, with margin for
// chaos. The view widens further (down to minZoom) when a scrum forms.
const PADDING = 320;
const MIN_ZOOM = 0.28;
const MAX_ZOOM = 1.1;

export class SpectatorDirector {
  private focusId: string | null = null;
  private dwell = 0;
  /** Seconds the current focus has been continuously idle. */
  private focusIdle = 0;
  /** Last-seen positions, for per-tick velocity estimation. */
  private prevPos = new Map<string, Vec2>();

  /**
   * Pick/keep a focus blob and return how to frame it. Call once per tick.
   * @param raceGoal When set, direct as a race (follow first place toward this
   *   point); when null, direct the brawl (follow the action, dodge idlers).
   */
  update(dt: number, blobs: SpectatorBlob[], raceGoal: Vec2 | null = null): SpectatorFraming {
    // Estimate speeds from last tick, then refresh the position cache.
    const speed = new Map<string, number>();
    for (const b of blobs) {
      const prev = this.prevPos.get(b.id);
      speed.set(b.id, prev && dt > 0 ? dist(b.pos, prev) / dt : 0);
      this.prevPos.set(b.id, b.pos);
    }

    const living = blobs.filter((b) => !b.dead);

    // Nobody alive (e.g. all KO'd mid-round) — frame everyone loosely so the
    // shot isn't empty, and keep the last focus id for continuity.
    if (living.length === 0) {
      return {
        targets: blobs.map((b) => b.pos),
        padding: 500,
        minZoom: 0,
        maxZoom: 0.7,
        focusId: this.focusId,
        cut: false,
      };
    }

    this.dwell += dt;
    const current = living.find((b) => b.id === this.focusId) ?? null;

    // Track how long the current focus has been idle.
    if (current && (speed.get(current.id) ?? 0) < IDLE_SPEED) {
      this.focusIdle += dt;
    } else {
      this.focusIdle = 0;
    }

    const chosen = raceGoal
      ? this.directRace(living, raceGoal, current)
      : this.directBrawl(living, speed, current);

    const focus = chosen.focus;
    if (chosen.cut) {
      this.focusId = focus.id;
      this.dwell = 0;
      this.focusIdle = 0;
    }

    // Frame the focus plus anyone brawling with it; lone focus → just itself.
    const targets: Vec2[] = [];
    for (const b of living) {
      if (b.id === focus.id || dist(b.pos, focus.pos) < FIGHT_RADIUS) {
        targets.push(b.pos);
      }
    }

    return {
      targets,
      padding: PADDING,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      focusId: focus.id,
      cut: chosen.cut,
    };
  }

  /** Race: follow first place — the living blob closest to the goal. */
  private directRace(
    living: SpectatorBlob[],
    goal: Vec2,
    current: SpectatorBlob | null,
  ): { focus: SpectatorBlob; cut: boolean } {
    const leader = living.reduce((a, b) =>
      dist(b.pos, goal) < dist(a.pos, goal) ? b : a,
    );
    if (!current) return { focus: leader, cut: true };
    // Switch only when a clearly-closer leader emerges (hysteresis).
    if (leader.id !== current.id && dist(current.pos, goal) - dist(leader.pos, goal) > LEAD_MARGIN) {
      return { focus: leader, cut: true };
    }
    return { focus: current, cut: false };
  }

  /** Brawl: follow the action, and bail off idlers after a few seconds. */
  private directBrawl(
    living: SpectatorBlob[],
    speed: Map<string, number>,
    current: SpectatorBlob | null,
  ): { focus: SpectatorBlob; cut: boolean } {
    const interest = (b: SpectatorBlob): number => {
      let entourage = 0;
      for (const o of living) {
        if (o.id === b.id) continue;
        if (dist(b.pos, o.pos) < FIGHT_RADIUS) entourage++;
      }
      // Idle blobs are heavily penalised so the camera never picks a blob
      // standing still; action (nearby opponents) dominates, score breaks ties.
      const idlePenalty = (speed.get(b.id) ?? 0) < IDLE_SPEED ? -8 : 0;
      return entourage * 10 + Math.min(b.score, 50) * 0.1 + idlePenalty;
    };

    const best = living.reduce((a, b) => {
      const ia = interest(a);
      const ib = interest(b);
      if (ib > ia) return b;
      if (ib < ia) return a;
      if (b.score !== a.score) return b.score > a.score ? b : a;
      return a.id < b.id ? a : b;
    });

    if (!current) return { focus: best, cut: true };
    // Force off an idle focus regardless of dwell — never sit on a do-nothing
    // blob for more than IDLE_MAX_SEC.
    if (this.focusIdle >= IDLE_MAX_SEC && best.id !== current.id) {
      return { focus: best, cut: true };
    }
    if (
      this.dwell >= MIN_DWELL_SEC &&
      best.id !== current.id &&
      interest(best) > interest(current) * SWITCH_MARGIN
    ) {
      return { focus: best, cut: true };
    }
    return { focus: current, cut: false };
  }
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
