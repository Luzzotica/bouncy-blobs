const KEY = 'bouncy_blobs_intro_seen'

export function hasSeenIntro(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true'
  } catch {
    return true
  }
}

export function markIntroSeen(): void {
  try {
    localStorage.setItem(KEY, 'true')
  } catch {}
}

export function resetIntroSeen(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {}
}
