/**
 * Kids Mode Music learn-mode — Twinkle Twinkle Little Star on expand.
 *
 * Each player expand plays the next note of the melody as a soft Web Audio
 * tone (offline, no network). Sequence loops forever.
 *
 * Color pick still uses voice clips (colors teach); only expand → music.
 */

import { resumeAudio } from './audio';

/** Twinkle Twinkle Little Star (one verse + "how I wonder"), MIDI-ish Hz. */
const TWINKLE_HZ: readonly number[] = [
  // Twin-kle twin-kle lit-tle star
  261.63, 261.63, 392.00, 392.00, 440.00, 440.00, 392.00,
  // How I won-der what you are
  349.23, 349.23, 329.63, 329.63, 293.66, 293.66, 261.63,
  // Up a-bove the world so high
  392.00, 392.00, 349.23, 349.23, 329.63, 329.63, 293.66,
  // Like a dia-mond in the sky
  392.00, 392.00, 349.23, 349.23, 329.63, 329.63, 293.66,
  // Twin-kle twin-kle lit-tle star
  261.63, 261.63, 392.00, 392.00, 440.00, 440.00, 392.00,
  // How I won-der what you are
  349.23, 349.23, 329.63, 329.63, 293.66, 293.66, 261.63,
];

const MIN_MS_BETWEEN_NOTES = 180;
const NOTE_SEC = 0.38;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  // Louder for Dia (was 0.35 — kids couldn't hear over SFX/room noise).
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  return ctx;
}

export class KidsTwinkleProgress {
  private index = 0;
  private lastAt = 0;

  /**
   * Play the next Twinkle note on expand rising edge.
   * Returns the 1-based note index in the phrase (for HUD), or null if debounced.
   */
  onExpand(nowMs: number = performance.now()): number | null {
    if (nowMs - this.lastAt < MIN_MS_BETWEEN_NOTES) return null;
    this.lastAt = nowMs;
    const i = this.index % TWINKLE_HZ.length;
    this.index = (this.index + 1) % TWINKLE_HZ.length;
    playTone(TWINKLE_HZ[i]);
    return i + 1;
  }

  reset(): void {
    this.index = 0;
    this.lastAt = 0;
  }

  peekIndex(): number {
    return (this.index % TWINKLE_HZ.length) + 1;
  }

  noteCount(): number {
    return TWINKLE_HZ.length;
  }
}

function playTone(hz: number): void {
  resumeAudio();
  const c = getCtx();
  if (!c || !master) return;
  if (c.state === 'suspended') void c.resume();
  // Restore level if we muted for background stop.
  if (master.gain.value < 0.01) master.gain.value = 0.9;

  const t0 = c.currentTime;
  // Layer a soft sine under a brighter triangle so notes cut through.
  const osc = c.createOscillator();
  const osc2 = c.createOscillator();
  const g = c.createGain();
  osc.type = 'triangle';
  osc2.type = 'sine';
  osc.frequency.value = hz;
  osc2.frequency.value = hz * 2; // light octave shimmer
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.95, t0 + 0.018);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + NOTE_SEC);
  osc.connect(g);
  osc2.connect(g);
  g.connect(master);
  osc.start(t0);
  osc2.start(t0);
  osc.stop(t0 + NOTE_SEC + 0.03);
  osc2.stop(t0 + NOTE_SEC + 0.03);
}

/** Silence Twinkle tones (background / leave Kids Mode). */
export function stopKidsMusic(): void {
  if (master) {
    try {
      const t = ctx?.currentTime ?? 0;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(0.0001, t);
    } catch { /* ignore */ }
  }
  if (ctx && ctx.state === 'running') {
    void ctx.suspend().catch(() => {});
  }
}
