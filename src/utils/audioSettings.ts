// Single source of truth for player audio preferences, persisted in
// localStorage. Music utility subscribes for live updates; SFX players
// (Intro) read at play time since each clip is short.

const MUSIC_KEY = 'bb_music_volume'
const SFX_KEY = 'bb_sfx_volume'
const COLOR_KEY = 'bb_player_color'
const FACE_KEY = 'bb_player_face'
const DEFAULT_MUSIC = 0.34
const DEFAULT_SFX = 0.85
const DEFAULT_COLOR = '#4ea1ff'
const DEFAULT_FACE = 'default'

type Listener = () => void
const listeners = new Set<Listener>()

function read(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    const n = parseFloat(raw)
    return Number.isFinite(n) ? clamp(n) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(clamp(v)))
  } catch {}
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v))
}

export function getMusicVolume(): number {
  return read(MUSIC_KEY, DEFAULT_MUSIC)
}

export function setMusicVolumeSetting(v: number): void {
  write(MUSIC_KEY, v)
  for (const l of listeners) l()
}

export function getSfxVolume(): number {
  return read(SFX_KEY, DEFAULT_SFX)
}

export function setSfxVolumeSetting(v: number): void {
  write(SFX_KEY, v)
  for (const l of listeners) l()
}

export function onAudioSettingsChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Player blob colour preference, used by Sandbox and as the default when
 * joining a lobby. Stored as a CSS hex string like '#rrggbb'. */
export function getPlayerColor(): string {
  try {
    const raw = localStorage.getItem(COLOR_KEY)
    if (raw && /^#[0-9a-fA-F]{6}$/.test(raw)) return raw
  } catch {}
  return DEFAULT_COLOR
}

export function setPlayerColorSetting(hex: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return
  try { localStorage.setItem(COLOR_KEY, hex.toLowerCase()) } catch {}
  for (const l of listeners) l()
}

/** Player blob face/eyes preference (a faceId from faceRenderer's presets).
 * Mirrors the colour preference: single source of truth, subscribable. */
export function getPlayerFaceId(): string {
  try {
    const raw = localStorage.getItem(FACE_KEY)
    if (raw) return raw
  } catch {}
  return DEFAULT_FACE
}

export function setPlayerFaceIdSetting(faceId: string): void {
  try { localStorage.setItem(FACE_KEY, faceId) } catch {}
  for (const l of listeners) l()
}
