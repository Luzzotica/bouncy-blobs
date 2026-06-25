// Tracks whether the player has gone through the first-time "pick your blob"
// (colour + eyes) flow. Separate from the intro-seen flag so the two onboarding
// steps are independent.
const KEY = 'bb_identity_chosen'

export function hasChosenIdentity(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true'
  } catch {
    return true // safe default if localStorage is unavailable
  }
}

export function markIdentityChosen(): void {
  try {
    localStorage.setItem(KEY, 'true')
  } catch {}
}

export function resetIdentityChosen(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {}
}
