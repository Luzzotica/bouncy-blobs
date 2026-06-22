// Hand-off for the classic WebRTC room-code join flow: the lobby UI stashes
// the chosen room + display name + password here, then navigates to
// /online-guest, which reads it on mount. Kept in its own module so both the
// lobby list (writer) and OnlineGuest (reader) can share it without coupling
// to a page component.

const PENDING_JOIN_KEY = "pendingLobbyJoin";

export interface PendingJoin {
  room_id: string;
  display_name: string;
  password: string;
}

export function setPendingJoin(join: PendingJoin): void {
  sessionStorage.setItem(PENDING_JOIN_KEY, JSON.stringify(join));
}

export function getPendingJoin(): PendingJoin | null {
  try {
    const raw = sessionStorage.getItem(PENDING_JOIN_KEY);
    return raw ? (JSON.parse(raw) as PendingJoin) : null;
  } catch {
    return null;
  }
}

export function clearPendingJoin(): void {
  sessionStorage.removeItem(PENDING_JOIN_KEY);
}
