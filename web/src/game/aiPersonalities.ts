import { Vec2 } from '../physics/vec2';

// ─────────────────────────────────────────────────────────────────────────────
// AI personalities
//
// Each personality is a pure function mapping (self, world) → desired input.
// Personalities run on the host every game tick — no networking, just local
// physics-aware decision-making. They're intentionally simple: ~30 lines each.
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalityName =
  | 'goal_seeker'
  | 'chaser'
  | 'fleer'
  | 'wanderer'
  | 'hill_camper'
  | 'bouncer';

export interface AIInput {
  moveX: number;        // -1..1
  moveY: number;        // -1..1 (most modes only use moveX)
  expanding: boolean;
}

export interface AISelfView {
  playerId: string;
  centroid: Vec2;
  /** True if the blob is currently touching the ground or a platform. */
  grounded: boolean;
}

export interface AIWorldView {
  /** Other players (not self), with their current centroids. */
  opponents: AISelfView[];
  /** The active goal centre this bot should be moving toward, if any. */
  goal: Vec2 | null;
  /** Width of the goal AABB (use with `goal` for an exact in-zone check). */
  goalWidth: number | null;
  /** Height of the goal AABB. */
  goalHeight: number | null;
  /** Centre of the active king-of-the-hill zone, if the mode has one. */
  hillCenter: Vec2 | null;
  /** dt for this tick in seconds. */
  dt: number;
  /** Wall-clock seconds since match start (cheap stand-in for tick counter). */
  elapsed: number;
}

export interface PersonalityState {
  /** Free-form scratch space. Personality functions own its shape. */
  scratch: Record<string, unknown>;
}

export type PersonalityFn = (
  self: AISelfView,
  world: AIWorldView,
  state: PersonalityState,
) => AIInput;

const NEUTRAL: AIInput = { moveX: 0, moveY: 0, expanding: false };

/**
 * goal_seeker — the default brain.
 *
 * Behaviour:
 *  - Move horizontally toward the active goal (hill, finish line, etc.).
 *  - To bounce, the AI must hold "expand" pressed for long enough that the
 *    blob's spring fully inflates and pushes off the ground. A single-frame
 *    tap does almost nothing. We start a hold on ground contact and keep it
 *    pressed for BOUNCE_HOLD_SEC, regardless of whether we leave the ground
 *    mid-hold.
 *  - If the goal is above us, push the joystick up for vertical assist.
 *  - If we're far below the goal (i.e. probably in a pit), ease off horizontal
 *    pressure while airborne so we don't pile-drive into the pit wall and stall.
 *  - If there's no goal (e.g. PartyMode), fall back to wandering so the bot
 *    isn't a sitting duck.
 */
const BOUNCE_HOLD_SEC = 0.6;        // how long to keep expand pressed each travel jump
const BOUNCE_REST_SEC = 0.08;       // brief release between holds so the spring resets
const SLAM_RANGE = 180;             // when in goal, slam if an opponent is within this
const SLAM_HOLD_SEC = 0.15;         // short tap so 4-way slam-fest doesn't compound forever
const SLAM_COOLDOWN_SEC = 1.0;      // long gap between slams keeps physics stable

const goal_seeker: PersonalityFn = (self, world, state) => {
  if (!world.goal) return wanderer(self, world, state);

  const dx = world.goal.x - self.centroid.x;
  const dy = world.goal.y - self.centroid.y;
  const verticalGap = -dy; // positive when goal is above us

  // AABB containment — same check the mode uses to decide who's scoring,
  // so the AI's notion of "I'm on the hill" lines up with the game's.
  const inGoal =
    world.goalWidth !== null &&
    world.goalHeight !== null &&
    Math.abs(dx) <= world.goalWidth / 2 &&
    Math.abs(dy) <= world.goalHeight / 2;

  let moveX = sign(dx);
  let moveY = 0;

  // Hold-to-jump: while inside the hold window we keep `expanding` true even
  // if we've already left the ground — releasing too early kills the launch.
  const bounceStart = (state.scratch.bounceStart as number) ?? -10;
  const sinceStart = world.elapsed - bounceStart;
  const stillHolding = sinceStart < BOUNCE_HOLD_SEC;
  const readyForNext = sinceStart >= BOUNCE_HOLD_SEC + BOUNCE_REST_SEC;

  let expanding = false;
  if (stillHolding) {
    expanding = true;
  } else if (readyForNext && self.grounded) {
    state.scratch.bounceStart = world.elapsed;
    expanding = true;
  }

  if (inGoal) {
    // We're on the hill. Slams are short, rare, grounded-only "taps" — NOT
    // the long hold-jump used for travel. Without this, four bots all on the
    // hill would all hold-expand simultaneously and the spring/collision
    // solver compounds into a kaleidoscope blowup.
    let nearestOppDist = Infinity;
    let nearestOppX = self.centroid.x;
    for (const o of world.opponents) {
      const ox = o.centroid.x - self.centroid.x;
      const oy = o.centroid.y - self.centroid.y;
      const d = Math.hypot(ox, oy);
      if (d < nearestOppDist) {
        nearestOppDist = d;
        nearestOppX = o.centroid.x;
      }
    }

    // Cancel any travel-jump hold so we don't bleed into the slam window.
    state.scratch.bounceStart = -10;

    if (nearestOppDist <= SLAM_RANGE) {
      // Brief tap, with cooldown. Only fire while grounded so the slam pushes
      // off the platform instead of being a useless mid-air puff.
      const lastSlam = (state.scratch.lastSlam as number) ?? -10;
      const sinceSlam = world.elapsed - lastSlam;
      const stillSlamming = sinceSlam < SLAM_HOLD_SEC;
      const readyToSlam = sinceSlam >= SLAM_COOLDOWN_SEC && self.grounded;

      let slamExpand = false;
      if (stillSlamming) {
        slamExpand = true;
      } else if (readyToSlam) {
        state.scratch.lastSlam = world.elapsed;
        slamExpand = true;
      }
      // Lean into the threat for body contact.
      return {
        moveX: sign(nearestOppX - self.centroid.x),
        moveY: 0,
        expanding: slamExpand,
      };
    }

    // Solo on the hill — sit still and rack up points.
    return { moveX: 0, moveY: 0, expanding: false };
  }

  // Joystick Y = -1 means "pull up" (against gravity). Apply when the goal is
  // meaningfully above us so we get vertical assist on top of the bounce.
  if (verticalGap > 40) {
    moveY = -1;
  }

  // Recovery: deep below the goal AND airborne almost certainly means we're
  // bouncing inside a pit. Slamming horizontally just wedges us against the
  // wall — soften the lateral push so the up-force can do its job.
  if (verticalGap > 200 && !self.grounded) {
    moveX *= 0.35;
  }

  return { moveX, moveY, expanding };
};

function nearestOpponent(self: AISelfView, opponents: AISelfView[]): AISelfView | null {
  let best: AISelfView | null = null;
  let bestD2 = Infinity;
  for (const o of opponents) {
    const dx = o.centroid.x - self.centroid.x;
    const dy = o.centroid.y - self.centroid.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = o; }
  }
  return best;
}

function sign(n: number): number {
  return n > 0.5 ? 1 : n < -0.5 ? -1 : n === 0 ? 0 : Math.sign(n);
}

const chaser: PersonalityFn = (self, world, state) => {
  const target = nearestOpponent(self, world.opponents);
  if (!target) return { ...NEUTRAL };
  const dx = target.centroid.x - self.centroid.x;
  const dy = target.centroid.y - self.centroid.y;
  const dist = Math.hypot(dx, dy);
  // Expand on cooldown when within range (about to collide).
  const lastExpand = (state.scratch.lastExpand as number) ?? -10;
  const wantExpand = dist < 90 && world.elapsed - lastExpand > 1.2;
  if (wantExpand) state.scratch.lastExpand = world.elapsed;
  return { moveX: sign(dx), moveY: sign(dy), expanding: wantExpand };
};

const fleer: PersonalityFn = (self, world, state) => {
  const threat = nearestOpponent(self, world.opponents);
  if (!threat) {
    // Wander if no threat in sight.
    return wanderer(self, world, state);
  }
  const dx = self.centroid.x - threat.centroid.x;
  const dy = self.centroid.y - threat.centroid.y;
  const dist = Math.hypot(dx, dy);
  // Panic-expand when too close.
  const lastExpand = (state.scratch.lastExpand as number) ?? -10;
  const wantExpand = dist < 60 && world.elapsed - lastExpand > 0.8;
  if (wantExpand) state.scratch.lastExpand = world.elapsed;
  return { moveX: sign(dx), moveY: sign(dy), expanding: wantExpand };
};

const wanderer: PersonalityFn = (_self, world, state) => {
  // Smooth random walk: hold a direction for ~1.5s then re-roll.
  const nextRoll = (state.scratch.nextRoll as number) ?? 0;
  let dirX = (state.scratch.dirX as number) ?? 0;
  let dirY = 0;
  let expanding = (state.scratch.expanding as boolean) ?? false;
  if (world.elapsed >= nextRoll) {
    dirX = Math.random() < 0.5 ? -1 : 1;
    expanding = Math.random() < 0.2;
    state.scratch.dirX = dirX;
    state.scratch.expanding = expanding;
    state.scratch.nextRoll = world.elapsed + 1.0 + Math.random() * 1.5;
  }
  return { moveX: dirX, moveY: dirY, expanding };
};

const hill_camper: PersonalityFn = (self, world, state) => {
  if (!world.hillCenter) return chaser(self, world, state);
  const dx = world.hillCenter.x - self.centroid.x;
  const dy = world.hillCenter.y - self.centroid.y;
  const dist = Math.hypot(dx, dy);
  // On the hill — stand and bounce; off the hill — run for it.
  if (dist < 80) {
    const lastExpand = (state.scratch.lastExpand as number) ?? -10;
    const wantExpand = world.elapsed - lastExpand > 0.6;
    if (wantExpand) state.scratch.lastExpand = world.elapsed;
    return { moveX: 0, moveY: 0, expanding: wantExpand };
  }
  return { moveX: sign(dx), moveY: sign(dy), expanding: false };
};

const bouncer: PersonalityFn = (_self, world, state) => {
  // Mash expand on a tight cooldown; drift left/right based on a slow oscillator.
  const lastExpand = (state.scratch.lastExpand as number) ?? -10;
  const wantExpand = world.elapsed - lastExpand > 0.35;
  if (wantExpand) state.scratch.lastExpand = world.elapsed;
  const moveX = Math.sin(world.elapsed * 1.5) > 0 ? 1 : -1;
  return { moveX, moveY: 0, expanding: wantExpand };
};

export const PERSONALITIES: Record<PersonalityName, PersonalityFn> = {
  goal_seeker,
  chaser,
  fleer,
  wanderer,
  hill_camper,
  bouncer,
};

export const PERSONALITY_LABELS: Record<PersonalityName, string> = {
  goal_seeker: '🎯 Seeker',
  chaser: '🤖 Chaser',
  fleer: '🤖 Fleer',
  wanderer: '🤖 Wanderer',
  hill_camper: '🤖 Hill Camper',
  bouncer: '🤖 Bouncer',
};

/** Default suggested colors per personality (so they're visually distinct in clips). */
export const PERSONALITY_COLORS: Record<PersonalityName, string> = {
  goal_seeker: '#4cc9f0',  // cyan — default bot
  chaser: '#e63946',       // red
  fleer: '#06d6a0',        // green
  wanderer: '#f4a261',     // orange
  hill_camper: '#9d4edd',  // purple
  bouncer: '#ffd60a',      // yellow
};

/** What you get when you click "+ Add AI Bot" without specifying a personality. */
export const DEFAULT_PERSONALITY: PersonalityName = 'goal_seeker';

/**
 * Visually distinct palette for goal_seeker bots — every new bot pulls the
 * next swatch so a 4-bot match has 4 obviously different blobs on screen.
 */
export const GOAL_SEEKER_PALETTE: string[] = [
  '#4cc9f0', // cyan
  '#ff5d8f', // pink
  '#ffd60a', // yellow
  '#06d6a0', // green
  '#c77dff', // purple
  '#ff8c42', // orange
  '#a8dadc', // pale blue
  '#ef476f', // red
];

export const ALL_PERSONALITIES: PersonalityName[] = [
  'goal_seeker',
  'chaser',
  'fleer',
  'wanderer',
  'hill_camper',
  'bouncer',
];

export function isPersonalityName(s: string): s is PersonalityName {
  return (ALL_PERSONALITIES as readonly string[]).includes(s);
}
