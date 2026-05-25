// Tiny SFX engine on top of the Web Audio API.
//
// • Lazy AudioContext (created on the first user gesture; honors browser
//   autoplay policies just like music.ts).
// • Per-name AudioBuffer registry, lazy-fetched on first request and cached.
// • Random variant picker: playSfx('land-squelch') resolves to one of
//   land-squelch.mp3 / land-squelch-1.mp3 / -2.mp3 / -3.mp3 if those exist
//   in the registry.
// • Master gain wired to audioSettings.getSfxVolume() with a live listener.
// • Per-name throttle so simultaneous events (e.g. four blobs landing on the
//   same frame) don't machine-gun the same buffer.

import { getSfxVolume, onAudioSettingsChange } from './audioSettings'

export interface PlaySfxOptions {
  /** Per-call multiplier on top of the master SFX volume. Default 1. */
  volume?: number
  /** Playback rate (1 = normal pitch). 0.85..1.15 jitter is fine. Default 1. */
  pitch?: number
  /** Stereo pan, -1..1. Default 0. */
  pan?: number
  /** Override the per-name throttle window in ms. Default 30. */
  throttleMs?: number
}

const DEFAULT_THROTTLE_MS = 30

let ctx: AudioContext | null = null
let masterGain: GainNode | null = null
const buffers = new Map<string, AudioBuffer | Promise<AudioBuffer | null> | null>()
const lastPlayedAt = new Map<string, number>()

/** Return the shared AudioContext, creating it on first call. Safe to invoke
 * before any user gesture — browsers will leave it suspended until then.
 * playSfx() does not auto-resume; the first user-gesture handler in the app
 * (the same one that starts music) should call resumeAudio(). */
function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor() as AudioContext
  masterGain = ctx.createGain()
  masterGain.gain.value = getSfxVolume()
  masterGain.connect(ctx.destination)
  // Live-update master gain when the user moves the SFX slider in Settings.
  onAudioSettingsChange(() => {
    if (masterGain) masterGain.gain.value = getSfxVolume()
  })
  return ctx
}

/** Resume the AudioContext after a user gesture. Idempotent. */
export function resumeAudio(): void {
  const c = getCtx()
  if (c && c.state === 'suspended') c.resume().catch(() => {})
}

async function fetchBuffer(name: string): Promise<AudioBuffer | null> {
  const c = getCtx()
  if (!c) return null
  try {
    const res = await fetch(`/sfx/${name}.mp3`)
    if (!res.ok) return null
    const arr = await res.arrayBuffer()
    return await c.decodeAudioData(arr)
  } catch {
    return null
  }
}

/** Eagerly load a sfx buffer. Optional — playSfx() will lazy-load on demand. */
export function preloadSfx(name: string): void {
  if (buffers.has(name)) return
  const p = fetchBuffer(name).then(b => {
    buffers.set(name, b)
    return b
  })
  buffers.set(name, p)
}

/** Preload an entire bank in one call. */
export function preloadAll(names: readonly string[]): void {
  for (const n of names) preloadSfx(n)
}

/** Resolve a base name like 'land-squelch' to one of its variants if any
 * are loaded, otherwise the bare name. Variants are suffixed -1, -2, -3. */
function resolveVariant(name: string): string {
  // Probe up to 4 variants. Only consider keys that are actual buffers (the
  // bare promise placeholder counts too — variant existence is determined at
  // preload time).
  const variants: string[] = []
  const isLoadable = (key: string) => buffers.has(key) && buffers.get(key) !== null
  for (let i = 1; i <= 4; i++) {
    const v = `${name}-${i}`
    if (isLoadable(v)) variants.push(v)
  }
  if (isLoadable(name)) variants.push(name)
  if (variants.length === 0) return name
  return variants[Math.floor(Math.random() * variants.length)]
}

/** Play a short sound effect. Lazy-loads the buffer if not yet preloaded.
 * Safe to call from physics callbacks — never throws. */
export function playSfx(name: string, opts: PlaySfxOptions = {}): void {
  const c = getCtx()
  if (!c || !masterGain) return

  const resolved = resolveVariant(name)

  // Per-name throttle
  const throttle = opts.throttleMs ?? DEFAULT_THROTTLE_MS
  const now = c.currentTime * 1000
  const last = lastPlayedAt.get(resolved) ?? -Infinity
  if (now - last < throttle) return
  lastPlayedAt.set(resolved, now)

  const cached = buffers.get(resolved)
  if (cached === undefined) {
    // Not preloaded — kick off a fetch and play once it lands (single-shot;
    // dropped if the call site is gone by then).
    preloadSfx(resolved)
    Promise.resolve(buffers.get(resolved)).then(buf => {
      if (buf) playBuffer(buf, opts)
    })
    return
  }
  if (cached === null) return // known-missing
  if (cached instanceof Promise) {
    cached.then(buf => { if (buf) playBuffer(buf, opts) })
    return
  }
  playBuffer(cached, opts)
}

function playBuffer(buf: AudioBuffer, opts: PlaySfxOptions): void {
  const c = ctx
  if (!c || !masterGain) return
  const src = c.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = opts.pitch ?? 1

  const gain = c.createGain()
  gain.gain.value = opts.volume ?? 1

  let head: AudioNode = gain
  if (opts.pan !== undefined && typeof c.createStereoPanner === 'function') {
    const panner = c.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, opts.pan))
    gain.connect(panner)
    head = panner
  }

  src.connect(gain)
  head.connect(masterGain)
  src.start()
}

/** Names of every SFX file in public/sfx/ (kept here so preloadAll can be
 * called once at game-start without enumerating the directory). Keep in sync
 * with bouncy-blobs/scripts/generate-all-sfx.sh. */
export const SFX_NAMES = [
  'land-squelch-1', 'land-squelch-2', 'land-squelch-3',
  'puff-up',
  'wall-stick', 'wall-jump',
  'spring-boing',
  'spike-splat',
  'powerup-sparkle',
  'countdown-tick', 'countdown-go', 'round-win',
  'ui-hover', 'ui-click', 'ui-confirm',
  'ui-modal-open', 'ui-modal-close',
] as const
