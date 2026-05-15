const ANONYMOUS_USER_ID_KEY = 'bouncy_blobs_anonymous_id';
const SESSION_PLAYER_ID_KEY = 'bouncy_blobs_session_player_id';

export function getAnonymousUserId(): string {
  let id = localStorage.getItem(ANONYMOUS_USER_ID_KEY);
  if (!id) {
    id = generateUUID();
    localStorage.setItem(ANONYMOUS_USER_ID_KEY, id);
  }
  return id;
}

export function getAnonymousIdForSession(sessionId: string | number): string {
  const storageKey = `${SESSION_PLAYER_ID_KEY}_${sessionId}`;
  let playerId = sessionStorage.getItem(storageKey);
  if (!playerId) {
    const timestamp = Date.now().toString(36);
    const randomPart = generateUUID().substring(0, 8);
    playerId = `player_${timestamp}_${randomPart}_${sessionId}`;
    sessionStorage.setItem(storageKey, playerId);
  }
  return playerId;
}

export function clearSessionPlayerId(sessionId: string | number): void {
  sessionStorage.removeItem(`${SESSION_PLAYER_ID_KEY}_${sessionId}`);
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
