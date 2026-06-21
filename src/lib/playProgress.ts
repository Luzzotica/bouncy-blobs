/**
 * Local (per-browser) progress through the single-player "Play" campaign.
 * Mirrors the localStorage pattern in `userProfile.ts`: one JSON blob under a
 * single key, with defensive try/catch so a private-mode / disabled
 * localStorage never breaks the game.
 *
 * Unlock state is NEVER stored — it's derived from completion order, so
 * reordering the campaign needs no migration.
 */

const KEY_PLAY_PROGRESS = "bb.play.progress.v1";

export interface LevelProgress {
  completed: boolean;
  /** Fastest completion in ms, or null until first finished. */
  bestTimeMs: number | null;
  /** Cumulative deaths across every attempt of this level. */
  deaths: number;
}

export type PlayProgress = Record<string, LevelProgress>;

const EMPTY: LevelProgress = { completed: false, bestTimeMs: null, deaths: 0 };

export function getPlayProgress(): PlayProgress {
  try {
    const raw = localStorage.getItem(KEY_PLAY_PROGRESS);
    return raw ? (JSON.parse(raw) as PlayProgress) : {};
  } catch {
    return {};
  }
}

export function getLevelProgress(id: string): LevelProgress {
  return getPlayProgress()[id] ?? { ...EMPTY };
}

function write(all: PlayProgress): void {
  try {
    localStorage.setItem(KEY_PLAY_PROGRESS, JSON.stringify(all));
  } catch {
    /* localStorage unavailable — progress just won't persist this session */
  }
}

/** Record a finished run: mark complete, keep the best time, add the run's deaths. */
export function recordCompletion(id: string, timeMs: number, runDeaths: number): void {
  const all = getPlayProgress();
  const prev = all[id] ?? { ...EMPTY };
  all[id] = {
    completed: true,
    bestTimeMs: prev.bestTimeMs == null ? timeMs : Math.min(prev.bestTimeMs, timeMs),
    deaths: prev.deaths + runDeaths,
  };
  write(all);
}

/** Persist deaths from an abandoned run (player quit before finishing). */
export function recordDeaths(id: string, runDeaths: number): void {
  if (runDeaths <= 0) return;
  const all = getPlayProgress();
  const prev = all[id] ?? { ...EMPTY };
  all[id] = { ...prev, deaths: prev.deaths + runDeaths };
  write(all);
}

/** Level `index` is unlocked iff it's the first level or the prior one is done. */
export function isUnlocked(orderedIds: string[], index: number): boolean {
  if (index <= 0) return true;
  return !!getPlayProgress()[orderedIds[index - 1]]?.completed;
}

/** Index of the furthest reachable (unlocked) level in campaign order. */
export function furthestUnlockedIndex(orderedIds: string[]): number {
  const all = getPlayProgress();
  let i = 0;
  while (i < orderedIds.length - 1 && all[orderedIds[i]]?.completed) i++;
  return i;
}
