// Anonymous user ID generation and management
const ANONYMOUS_USER_ID_KEY = 'partii_anonymous_user_id';
const SESSION_PLAYER_ID_KEY = 'partii_session_player_id';

/**
 * Get or create an anonymous user ID for the device
 * Generates a unique UUID per browser/device
 * Each device gets its own persistent anonymous ID
 */
export function getAnonymousUserId(): string {
  let anonymousId = localStorage.getItem(ANONYMOUS_USER_ID_KEY);

  if (!anonymousId) {
    // Generate a new UUID v4
    anonymousId = generateUUID();
    localStorage.setItem(ANONYMOUS_USER_ID_KEY, anonymousId);
    console.log('[AnonymousUser] Generated new device ID:', anonymousId);
  }
  // Removed log for existing ID - it's called too frequently

  return anonymousId;
}

/**
 * Generate a unique player ID for a specific session
 * This creates a TRULY UNIQUE ID per player join by combining:
 * - Session ID
 * - Timestamp
 * - Random component
 * This ensures different browser tabs and devices all get unique IDs
 */
export function getAnonymousIdForSession(sessionId: string | number): string {
  // Create a unique player ID for this session join
  // Each call generates a new ID (stored in sessionStorage for the tab)
  const storageKey = `${SESSION_PLAYER_ID_KEY}_${sessionId}`;
  
  // Check if we already have a player ID for this session in this tab
  let playerId = sessionStorage.getItem(storageKey);
  
  if (!playerId) {
    // Generate a completely unique ID for this player
    // Combines timestamp + random UUID to ensure uniqueness
    const timestamp = Date.now().toString(36);
    const randomPart = generateUUID().substring(0, 8);
    playerId = `player_${timestamp}_${randomPart}_${sessionId}`;
    sessionStorage.setItem(storageKey, playerId);
    console.log('[AnonymousUser] Generated new player ID for session:', playerId);
  }
  // Removed log for existing player ID - reduces noise

  return playerId;
}

/**
 * Clear the session player ID (for when player leaves or disconnects)
 */
export function clearSessionPlayerId(sessionId: string | number): void {
  const storageKey = `${SESSION_PLAYER_ID_KEY}_${sessionId}`;
  sessionStorage.removeItem(storageKey);
  console.log('[AnonymousUser] Cleared player ID for session:', sessionId);
}

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Clear the anonymous user ID (useful for testing or reset)
 */
export function clearAnonymousUserId(): void {
  localStorage.removeItem(ANONYMOUS_USER_ID_KEY);
}

