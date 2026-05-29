// Document-level click/hover SFX delegation. Mounted once from App.tsx so
// every <button> in the app gets hover + click feedback without per-file
// wiring. Modal open/close SFX are still emitted explicitly by the
// components that own the animation.

import { playSfx, resumeAudio } from './audio'

/** Treat <button> and explicit role="button" elements as interactive. */
function findButton(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const el = target.closest('button, [role="button"]') as HTMLElement | null
  if (!el) return null
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return null
  if (el.dataset.noSfx === 'true') return null
  return el
}

let installed = false
let lastHoverEl: HTMLElement | null = null

export function installUiSounds(): void {
  if (installed) return
  installed = true

  const onPointerOver = (e: PointerEvent) => {
    const btn = findButton(e.target)
    if (!btn) return
    if (btn === lastHoverEl) return
    lastHoverEl = btn
    playSfx('ui-hover', { volume: 0.20 })
  }

  const onPointerOut = (e: PointerEvent) => {
    const btn = findButton(e.target)
    if (btn && btn === lastHoverEl) lastHoverEl = null
  }

  const onClick = (e: MouseEvent) => {
    const btn = findButton(e.target)
    if (!btn) return
    // Any click counts as a user gesture — flip the AudioContext on if the
    // first hover happened before the user clicked anywhere.
    resumeAudio()
    // 'confirm' for primary-style buttons (data-sfx="confirm"), otherwise
    // the standard click pop. Lets a Start/Confirm button feel rewarding.
    const variant = btn.dataset.sfx === 'confirm' ? 'ui-confirm' : 'ui-click'
    playSfx(variant, { volume: 0.7 })
  }

  document.addEventListener('pointerover', onPointerOver, { capture: true })
  document.addEventListener('pointerout', onPointerOut, { capture: true })
  document.addEventListener('click', onClick, { capture: true })
}
