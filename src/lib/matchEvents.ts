// ─────────────────────────────────────────────────────────────────────────────
// Match event log — a flat, timestamped record of "things worth clipping"
// (phase changes, KOs, big hits, lead changes, the win). Consumed by the
// match-shorts pipeline: the recorder Playwright spec dumps this via the
// __bbDebug bridge and the highlight picker scores time windows from it.
//
// Timestamps are performance.now() seconds. The recorder converts them to
// video time by reading performance.now() just before page.close() and
// subtracting from the ffprobe'd video duration (the video runs until close).
//
// Pure observation — nothing in the sim reads from this, so logging cannot
// affect determinism.
// ─────────────────────────────────────────────────────────────────────────────

export type MatchEventType =
  | 'phase'        // { phase }
  | 'win'          // { winnerId, winnerName }
  | 'ko'           // { playerId, name, x, y }
  | 'big_hit'      // { strength, x, y }
  | 'lead_change'  // { playerId, name, score }
  | 'near_target'  // { playerId, name, score, target }
  | 'score_sample';// { scores: Record<playerId, number> }

export interface MatchEvent {
  type: MatchEventType;
  /** performance.now() seconds at the moment of the event. */
  t: number;
  [key: string]: unknown;
}

const MAX_EVENTS = 5000;
const events: MatchEvent[] = [];

export function logMatchEvent(type: MatchEventType, data: Record<string, unknown> = {}): void {
  if (typeof performance === 'undefined') return;
  if (events.length >= MAX_EVENTS) return;
  events.push({ type, t: performance.now() / 1000, ...data });
}

export function getMatchEvents(): MatchEvent[] {
  return events;
}

export function clearMatchEvents(): void {
  events.length = 0;
}
