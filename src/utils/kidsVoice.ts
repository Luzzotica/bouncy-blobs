/**
 * Kids Mode voice — offline bundled ElevenLabs clips (no Web Speech happy path).
 *
 * Clips: public/sfx/kids/ (scripts/generate-kids-voice.py).
 * HTMLAudioElement only so we can cancel mid-utterance cleanly.
 */

import { assetUrl } from './assetUrl';
import { resumeAudio } from './audio';
import { colorName } from './colorNames';
import { stopKidsMusic } from './kidsMusic';

let activeEl: HTMLAudioElement | null = null;
let activeKey: string | null = null;

function stopHtml(): void {
  if (!activeEl) return;
  try {
    activeEl.pause();
    activeEl.currentTime = 0;
  } catch { /* ignore */ }
  activeEl = null;
  activeKey = null;
}

/** Stop any currently playing kids voice clip. */
export function stopKidsVoice(): void {
  stopHtml();
}

/** Stop all kids Mode audio (voice + Twinkle). Safe on leave / background. */
export function stopAllKidsAudio(): void {
  stopHtml();
  stopKidsMusic();
}

/**
 * Play a kids clip by stem (e.g. "letter-a", "color-red").
 * Cancels the previous kids clip first. Silent miss if file missing.
 *
 * Letters use a slightly lower playbackRate so short TTS tails aren't
 * clipped by browser decode/start latency; colors play at full speed.
 */
export function playKidsClip(stem: string, opts?: { slow?: boolean }): void {
  if (!stem) return;
  resumeAudio();
  stopHtml();

  const url = assetUrl(`/sfx/kids/${stem}.mp3`);
  const el = new Audio(url);
  el.preload = 'auto';
  // ~0.88 slows short letter clips so the consonant/vowel fully lands.
  if (opts?.slow || stem.startsWith('letter-')) {
    el.playbackRate = 0.9;
    el.preservesPitch = true;
  }
  activeEl = el;
  activeKey = stem;
  void el.play().catch(() => {
    if (activeKey === stem) {
      activeEl = null;
      activeKey = null;
    }
  });
  el.onended = () => {
    if (activeKey === stem) {
      activeEl = null;
      activeKey = null;
    }
  };
}

/** Play the bundled color name for a hex (nearest palette name). */
export function playKidsColor(hex: string): void {
  const name = colorName(hex);
  playKidsClip(`color-${name.toLowerCase()}`);
}

/** Play a letter clip: "A" → letter-a.mp3 */
export function playKidsLetter(letter: string): void {
  const L = letter.trim().toUpperCase();
  if (!/^[A-Z]$/.test(L)) return;
  playKidsClip(`letter-${L.toLowerCase()}`, { slow: true });
}

/** Shape name for Shape learn-mode (star / square / triangle). */
export function playKidsShape(shape: string): void {
  const s = shape.trim().toLowerCase();
  if (!s) return;
  playKidsClip(`shape-${s}`);
}

/** Stems to preload (unique colors + letters + shapes). Welcome removed. */
export const KIDS_VOICE_STEMS: readonly string[] = [
  ...Array.from({ length: 26 }, (_, i) => `letter-${String.fromCharCode(97 + i)}`),
  'color-red', 'color-orange', 'color-yellow', 'color-green', 'color-teal',
  'color-blue', 'color-purple', 'color-pink', 'color-white',
  'shape-star', 'shape-square', 'shape-triangle',
];

/** Kick off background preloads into the browser cache. */
export function preloadKidsVoice(): void {
  for (const stem of KIDS_VOICE_STEMS) {
    const a = new Audio();
    a.preload = 'auto';
    a.src = assetUrl(`/sfx/kids/${stem}.mp3`);
  }
}
