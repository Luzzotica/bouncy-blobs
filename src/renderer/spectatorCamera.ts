import { Vec2 } from '../physics/vec2';

// ─────────────────────────────────────────────────────────────────────────────
// Spectator director — a virtual broadcast camera for content capture.
//
// Instead of the full-arena wide shot (where blobs are tiny), this picks ONE
// blob to follow, frames it tight, and "cuts" to a new blob when its target
// dies or the action clearly moves elsewhere. The followed blob — plus any
// opponents close enough to be fighting it — is always kept in frame.
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

// Framing knobs, tuned for a 1080×1920 portrait frame. A lone focus blob ends
// up ~20% of frame width; the view widens (down to minZoom) when a scrum forms.
const PADDING = 230;
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 2.2;

export class SpectatorDirector {
  private focusId: string | null = null;
  private dwell = 0;

  /**
   * Pick/keep a focus blob and return how to frame it. Call once per tick with
   * the current blob snapshot.
   */
  update(dt: number, blobs: SpectatorBlob[]): SpectatorFraming {
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

    const interest = (b: SpectatorBlob): number => {
      let entourage = 0;
      for (const o of living) {
        if (o.id === b.id) continue;
        if (dist(b.pos, o.pos) < FIGHT_RADIUS) entourage++;
      }
      // Action (nearby opponents) dominates; score breaks near-ties so the
      // camera leans toward whoever's actually winning.
      return entourage * 10 + Math.min(b.score, 50) * 0.1;
    };

    // Best challenger — highest interest, tie-broken by score then id so the
    // choice is stable and deterministic.
    const best = living.reduce((a, b) => {
      const ia = interest(a);
      const ib = interest(b);
      if (ib > ia) return b;
      if (ib < ia) return a;
      if (b.score !== a.score) return b.score > a.score ? b : a;
      return a.id < b.id ? a : b;
    });

    let current = living.find((b) => b.id === this.focusId) ?? null;
    let cut = false;

    if (!current) {
      // Focus died or we have no focus yet — cut immediately.
      this.focusId = best.id;
      this.dwell = 0;
      current = best;
      cut = true;
    } else if (
      this.dwell >= MIN_DWELL_SEC &&
      best.id !== current.id &&
      interest(best) > interest(current) * SWITCH_MARGIN
    ) {
      this.focusId = best.id;
      this.dwell = 0;
      current = best;
      cut = true;
    }

    // Frame the focus plus anyone brawling with it; lone focus → just itself.
    const focus = current;
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
      cut,
    };
  }
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
