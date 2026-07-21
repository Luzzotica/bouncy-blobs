// Single source of truth for accessibility preferences, persisted in
// localStorage. Mirrors audioSettings: getters/setters plus a subscription
// bus. Values are cached in module locals because the canvas renderers read
// them every frame.

const COLOR_MODE_KEY = 'bb_color_mode'
const HIGH_CONTRAST_KEY = 'bb_high_contrast'
const GAME_TEXT_KEY = 'bb_game_text_scale'
const UI_TEXT_KEY = 'bb_ui_text_scale'

export type ColorMode = 'default' | 'colorblind'

export const GAME_TEXT_MIN = 0.75
export const GAME_TEXT_MAX = 1.75
export const UI_TEXT_MIN = 0.85
export const UI_TEXT_MAX = 1.5

type Listener = () => void
const listeners = new Set<Listener>()

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeString(key: string, v: string): void {
  try {
    localStorage.setItem(key, v)
  } catch {}
}

function readScale(key: string, min: number, max: number): number {
  const raw = readString(key)
  if (raw == null) return 1
  const n = parseFloat(raw)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 1
}

let colorMode: ColorMode = readString(COLOR_MODE_KEY) === 'colorblind' ? 'colorblind' : 'default'
let highContrast = readString(HIGH_CONTRAST_KEY) === '1'
let gameTextScale = readScale(GAME_TEXT_KEY, GAME_TEXT_MIN, GAME_TEXT_MAX)
let uiTextScale = readScale(UI_TEXT_KEY, UI_TEXT_MIN, UI_TEXT_MAX)

function notify(): void {
  for (const l of listeners) l()
}

export function getColorMode(): ColorMode {
  return colorMode
}

export function setColorModeSetting(mode: ColorMode): void {
  colorMode = mode
  writeString(COLOR_MODE_KEY, mode)
  notify()
}

export function getHighContrast(): boolean {
  return highContrast
}

export function setHighContrastSetting(on: boolean): void {
  highContrast = on
  writeString(HIGH_CONTRAST_KEY, on ? '1' : '0')
  notify()
}

/** Multiplier for canvas-drawn game text (name tags, timers, zone labels). */
export function getGameTextScale(): number {
  return gameTextScale
}

export function setGameTextScaleSetting(v: number): void {
  gameTextScale = Math.max(GAME_TEXT_MIN, Math.min(GAME_TEXT_MAX, v))
  writeString(GAME_TEXT_KEY, String(gameTextScale))
  notify()
}

/** Multiplier for DOM UI surfaces (modals, HUD overlays) via --bb-ui-zoom. */
export function getUiTextScale(): number {
  return uiTextScale
}

export function setUiTextScaleSetting(v: number): void {
  uiTextScale = Math.max(UI_TEXT_MIN, Math.min(UI_TEXT_MAX, v))
  writeString(UI_TEXT_KEY, String(uiTextScale))
  applyUiTextScale()
  notify()
}

export function onAccessibilityChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Push the UI text scale into the --bb-ui-zoom CSS var; index.css applies it
 * as `zoom` on .modal-paper and .bb-ui-zoom surfaces. */
function applyUiTextScale(): void {
  try {
    document.documentElement.style.setProperty('--bb-ui-zoom', String(uiTextScale))
  } catch {}
}

applyUiTextScale()
