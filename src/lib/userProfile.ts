// Lightweight localStorage-backed profile used by both the host (display
// name, last room settings) and the guest (display name). Centralized
// here so the keys aren't scattered across pages.

import { getSelfSteamPersonaName } from "./party";

const KEY_DISPLAY_NAME = "bb.profile.displayName";
const KEY_ROOM_NAME = "bb.profile.roomName";
const KEY_ROOM_IS_PUBLIC = "bb.profile.roomIsPublic";
const KEY_ROOM_MAX_PLAYERS = "bb.profile.roomMaxPlayers";

export function getStoredDisplayName(): string {
  try {
    return localStorage.getItem(KEY_DISPLAY_NAME) ?? "";
  } catch {
    return "";
  }
}

export function setStoredDisplayName(name: string): void {
  try {
    if (name && name.length > 0) localStorage.setItem(KEY_DISPLAY_NAME, name);
  } catch { /* localStorage may be unavailable */ }
}

/** Resolve the user's display name with this priority:
 *  1. localStorage (whatever they typed last time)
 *  2. Steam persona (when running under Steam)
 *  3. empty string (caller can decide on a UI default)
 */
export async function resolveDefaultDisplayName(): Promise<string> {
  const stored = getStoredDisplayName();
  if (stored) return stored;
  const persona = await getSelfSteamPersonaName();
  return persona ?? "";
}

export interface StoredRoomPrefs {
  roomName: string;
  isPublic: boolean;
  maxPlayers: number;
}

export function getStoredRoomPrefs(): StoredRoomPrefs {
  let roomName = "";
  let isPublic = false;
  let maxPlayers = 8;
  try {
    roomName = localStorage.getItem(KEY_ROOM_NAME) ?? "";
    isPublic = localStorage.getItem(KEY_ROOM_IS_PUBLIC) === "1";
    const mp = parseInt(localStorage.getItem(KEY_ROOM_MAX_PLAYERS) ?? "", 10);
    if (Number.isFinite(mp) && mp >= 1 && mp <= 16) maxPlayers = mp;
  } catch { /* ignore */ }
  return { roomName, isPublic, maxPlayers };
}

export function setStoredRoomPrefs(prefs: StoredRoomPrefs): void {
  try {
    if (prefs.roomName) localStorage.setItem(KEY_ROOM_NAME, prefs.roomName);
    localStorage.setItem(KEY_ROOM_IS_PUBLIC, prefs.isPublic ? "1" : "0");
    localStorage.setItem(KEY_ROOM_MAX_PLAYERS, String(prefs.maxPlayers));
  } catch { /* ignore */ }
}
