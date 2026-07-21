/**
 * Kids Mode speech helper — offline on-device TTS via the Web Speech API
 * (works in Safari / iOS WKWebView without a network call).
 *
 * iOS / WKWebView quirks handled here:
 *  - Voices load asynchronously (`voiceschanged`); we cache once ready.
 *  - First speak must follow a user gesture or Safari silently drops it —
 *    call `unlockSpeech()` from pointer handlers.
 *  - `cancel()` then immediate `speak()` often drops the new utterance —
 *    we schedule speak on the next frame after cancel.
 *  - Synth can stick in `paused` after backgrounding; we resume before speak.
 *  - Rapid taps cancel prior utterance so speech stays clear, not queued.
 */

let supported: boolean | null = null;
let voicesReady = false;
let preferredVoice: SpeechSynthesisVoice | null = null;
let unlocked = false;
let speakToken = 0;

function ensureVoicesListener(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  if (voicesReady) return;
  const synth = window.speechSynthesis;
  const refresh = () => {
    const voices = synth.getVoices();
    if (!voices.length) return;
    voicesReady = true;
    // Prefer a clear English voice. iOS: Samantha; macOS: often Samantha / Karen.
    preferredVoice =
      voices.find((v) => /^en(-|_)/i.test(v.lang) && /samantha/i.test(v.name)) ??
      voices.find((v) => /^en(-|_)/i.test(v.lang) && /karen|female|child|siri/i.test(v.name)) ??
      voices.find((v) => /^en-US/i.test(v.lang)) ??
      voices.find((v) => /^en(-|_)/i.test(v.lang)) ??
      null;
  };
  refresh();
  if (!voicesReady) {
    synth.addEventListener('voiceschanged', refresh, { once: false });
    // Some WebKits never fire voiceschanged if voices were already cached.
    window.setTimeout(refresh, 250);
  }
}

export function canSpeak(): boolean {
  if (supported == null) {
    supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  }
  return supported;
}

/**
 * Call from the first user gesture (color tap, blob grab, pad press) so
 * subsequent automatic speech (ABC on land) is allowed on iOS.
 * Speaks a near-silent utterance to prime the synthesis session.
 */
export function unlockSpeech(): void {
  if (!canSpeak() || unlocked) return;
  unlocked = true;
  ensureVoicesListener();
  try {
    const synth = window.speechSynthesis;
    if (synth.paused) synth.resume();
    // Zero-volume, very short utterance — primes iOS without an audible word.
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0.01;
    u.rate = 2;
    synth.speak(u);
    // Cancel immediately so we don't leave a ghost utterance hanging.
    window.setTimeout(() => {
      try { synth.cancel(); } catch { /* ignore */ }
    }, 40);
  } catch {
    /* best-effort */
  }
}

function pickVoice(): SpeechSynthesisVoice | null {
  ensureVoicesListener();
  if (preferredVoice) return preferredVoice;
  try {
    const voices = window.speechSynthesis.getVoices();
    return (
      voices.find((v) => /^en(-|_)/i.test(v.lang) && /samantha/i.test(v.name)) ??
      voices.find((v) => /^en(-|_)/i.test(v.lang)) ??
      null
    );
  } catch {
    return null;
  }
}

function doSpeak(text: string, token: number): void {
  if (token !== speakToken) return;
  if (!canSpeak() || !text) return;
  try {
    const synth = window.speechSynthesis;
    // iOS: resume if the engine stuck itself paused after backgrounding.
    if (synth.paused) synth.resume();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92;
    u.pitch = 1.08;
    u.volume = 1;
    const voice = pickVoice();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang || 'en-US';
    } else {
      u.lang = 'en-US';
    }
    synth.speak(u);
  } catch {
    // Speech is best-effort — never break gameplay for TTS failures.
  }
}

/** Speak `text` out loud. No-ops when speech is unavailable. */
export function speak(text: string): void {
  if (!text || !canSpeak()) return;
  ensureVoicesListener();
  const token = ++speakToken;
  try {
    const synth = window.speechSynthesis;
    if (synth.paused) synth.resume();
    // cancel() + immediate speak() drops the new utterance on iOS — defer.
    synth.cancel();
    // Double-rAF is more reliable than a single timeout on WKWebView.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => doSpeak(text, token));
    });
  } catch {
    /* ignore */
  }
}

/** Stop any current utterance (e.g. when leaving Kids Mode). */
export function stopSpeaking(): void {
  speakToken++;
  if (!canSpeak()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

/** Test/debug helper — true after unlockSpeech() has run. */
export function isSpeechUnlocked(): boolean {
  return unlocked;
}
