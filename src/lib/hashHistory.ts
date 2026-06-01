// Per-tick stateHash recorder for the "compare hashes" diagnostic.
//
// Both host and guests append (tick, stateHash) every successful sim
// tick into a rolling window (last RING_SIZE entries, ~4s at 60Hz).
// On the compare button:
//   - Host broadcasts a request_hashes reliable event.
//   - Every guest replies with its history.
//   - Host overlays the table side-by-side and colors cells by
//     match/mismatch per tick.
//
// The ring is intentionally small — desyncs that propagate further than
// ~4s of history have already cascaded past the point where comparing
// the next tick's hashes tells us anything useful. The first divergent
// tick is the one we care about.

/** Per-blob structured fields captured at the same instant as the
 *  stateHash. When sims diverge, drilling into these tells you WHICH
 *  blob's position / velocity / expand-state differs between peers,
 *  isolating the bug to a specific subsystem. */
export interface BlobSummary {
  blobId: number;
  /** Human label if available (playerId or "npc-N"). */
  label: string;
  cx: number;
  cy: number;
  vx: number;
  vy: number;
  /** SlimeBlob.expandShapeScale (JS-side integrator). */
  expandScale: number;
}

export interface TickSummary {
  rng: number;
  modePhase: string;
  modePhaseTimer: number;
  blobs: BlobSummary[];
}

export interface HashHistoryEntry {
  tick: number;
  hash: string;
  /** Detailed per-tick state breakdown — captured alongside the hash
   *  and shipped on the compare-hashes wire so the overlay can show
   *  a row-by-row diff when a hash mismatches. Optional so older
   *  recorders without summaries still serialize. */
  summary?: TickSummary;
}

const RING_SIZE = 240;

const ring: HashHistoryEntry[] = [];

/** Record one (tick, hash, summary) entry. Called from bouncyBlobsGame's
 *  onLogic after world.step. Idempotent for same tick (replaces
 *  existing entry — useful when rollback rewrites history for past
 *  ticks). */
export function recordHash(tick: number, hash: string, summary?: TickSummary): void {
  // If the same tick is already in the ring (rare — only if we rewound
  // and re-recorded), overwrite instead of appending so the ring
  // stays monotonic and dedupe-free.
  const last = ring[ring.length - 1];
  if (last && last.tick === tick) {
    last.hash = hash;
    last.summary = summary;
    return;
  }
  ring.push({ tick, hash, summary });
  if (ring.length > RING_SIZE) ring.shift();
}

/** Snapshot copy of the current ring. Returned to callers as a flat
 *  array (oldest tick first). */
export function getHashHistory(): HashHistoryEntry[] {
  return ring.slice();
}

/** Clear the ring — used when a game is fully restarted or the user
 *  wants a fresh window after fixing the desync source. */
export function resetHashHistory(): void {
  ring.length = 0;
}
