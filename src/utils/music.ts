// Singleton background-music player. Survives route changes so the intro
// music keeps looping on the main menu and anywhere else. Volume is
// driven by the persisted audioSettings — adjust the slider in the
// settings modal and the change applies live here.

import { getMusicVolume, onAudioSettingsChange } from './audioSettings'
import { assetUrl } from './assetUrl'
import { isCave } from '../renderer/colors'

// Theme-aware loop: the cave theme plays its own atmospheric-but-happy track;
// classic keeps the original cheerful theme.
const SRC = assetUrl(isCave ? '/intro/theme-cave.mp3' : '/intro/theme.mp3')

let audio: HTMLAudioElement | null = null
let started = false

function ensure(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(SRC)
    audio.loop = true
    audio.volume = getMusicVolume()
    audio.preload = 'auto'
    onAudioSettingsChange(() => {
      if (audio) audio.volume = getMusicVolume()
    })
  }
  return audio
}

export function startMusic(): void {
  const a = ensure()
  if (a.paused) {
    a.play().then(() => { started = true }).catch(() => {})
  } else {
    started = true
  }
}

export function pauseMusic(): void {
  audio?.pause()
}

export function resumeMusic(): void {
  audio?.play().catch(() => {})
}

export function isMusicStarted(): boolean {
  return started && !!audio && !audio.paused
}
