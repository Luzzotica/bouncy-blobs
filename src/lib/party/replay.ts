// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Replay format + recorder — deterministic input-log match replays.
//
// All three games have deterministic sims (seeded PRNG, fixed 60Hz step), so a
// replay is just {seed, level, mode, rules, roster, per-tick authoritative
// inputs}. Bots regenerate from the seed. A 3-min match is <100KB → stored as
// JSON via CloudContent.publish({contentType:'replay'}).
//
// The `header` and `inputs` shapes are game-specific (the sims differ); this
// module owns the envelope, the build-version guard, and the append-only
// recorder. Playback = feed `inputs` back through each game's no-network sim.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayFile<H = unknown, I = unknown> {
  version: 1;
  gameId: string;
  /** Game build/version at record time. Playback refuses a mismatch — a
   *  diverged sim can't be replayed faithfully (no graceful degrade). */
  buildVersion: string;
  recordedAt: string;
  durationTicks: number;
  /** Game-specific: seed(s), level/map, mode, rules, roster. */
  header: H;
  /** Append-only authoritative input log. */
  inputs: I[];
  /** Optional match events keyed to tick (highlights / death moments). */
  events?: Array<{ tick: number; type: string; [k: string]: unknown }>;
}

export function encodeReplay(r: ReplayFile): string {
  return JSON.stringify(r);
}

export function decodeReplay(json: string): ReplayFile {
  const r = JSON.parse(json) as ReplayFile;
  if (r.version !== 1) throw new Error(`Unsupported replay version: ${r.version}`);
  return r;
}

/** True if a replay can be played on the current build (else the sim would
 *  diverge). Callers show "Replay unavailable — game updated" on false. */
export function replayIsCompatible(r: ReplayFile, currentBuild: string): boolean {
  return r.buildVersion === currentBuild;
}

/** ~size ceiling: keep replays under the inline-publish cap (512KB) with margin. */
const MAX_REPLAY_BYTES = 400 * 1024;

/**
 * Append-only replay recorder. One per match, owned by the host / offline sim.
 * Pushes are cheap (array append, no clone) so recording never perturbs the
 * live sim. Stops recording (and marks the replay unsaveable) if a match runs
 * long enough to approach the inline-publish cap.
 */
export class ReplayRecorder<H = unknown, I = unknown> {
  private header: H | null = null;
  private inputs: I[] = [];
  private events: Array<{ tick: number; type: string; [k: string]: unknown }> = [];
  private overflowed = false;
  private approxBytes = 0;

  constructor(
    private readonly gameId: string,
    private readonly buildVersion: string,
  ) {}

  start(header: H): void {
    this.header = header;
    this.inputs = [];
    this.events = [];
    this.overflowed = false;
    this.approxBytes = JSON.stringify(header).length;
  }

  /** Record one authoritative input entry. Cheap; safe to call every tick. */
  push(entry: I): void {
    if (this.overflowed || this.header === null) return;
    this.inputs.push(entry);
    // Cheap running estimate — avoid re-serializing the whole log.
    this.approxBytes += 24; // typical compact input entry
    if (this.approxBytes > MAX_REPLAY_BYTES) this.overflowed = true;
  }

  event(tick: number, type: string, extra?: Record<string, unknown>): void {
    if (this.overflowed || this.header === null) return;
    this.events.push({ tick, type, ...extra });
  }

  /** True once the recording exceeded the saveable size ("match too long"). */
  get tooLong(): boolean {
    return this.overflowed;
  }

  get recording(): boolean {
    return this.header !== null;
  }

  /** Finalize into a ReplayFile, or null if nothing/too-long to save. */
  finalize(durationTicks: number): ReplayFile<H, I> | null {
    if (this.header === null || this.overflowed) return null;
    return {
      version: 1,
      gameId: this.gameId,
      buildVersion: this.buildVersion,
      recordedAt: new Date().toISOString(),
      durationTicks,
      header: this.header,
      inputs: this.inputs,
      events: this.events.length > 0 ? this.events : undefined,
    };
  }

  discard(): void {
    this.header = null;
    this.inputs = [];
    this.events = [];
    this.overflowed = false;
    this.approxBytes = 0;
  }
}
