import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStoredRoomPrefs } from "./userProfile";

const KEY_ROOM_MAX_PLAYERS = "bb.profile.roomMaxPlayers";

// The test env is `node`, which has no localStorage — install a minimal stub.
function installLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
  return store;
}

describe("getStoredRoomPrefs — max player count", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorage();
  });

  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  });

  it("defaults to 8 players when nothing is stored", () => {
    expect(getStoredRoomPrefs().maxPlayers).toBe(8);
  });

  it("accepts valid stored counts within the 1–8 range", () => {
    for (const n of [1, 2, 4, 7, 8]) {
      store.set(KEY_ROOM_MAX_PLAYERS, String(n));
      expect(getStoredRoomPrefs().maxPlayers).toBe(n);
    }
  });

  it("rejects counts above the 8-player cap and falls back to the default", () => {
    for (const n of [9, 12, 16, 32]) {
      store.set(KEY_ROOM_MAX_PLAYERS, String(n));
      expect(getStoredRoomPrefs().maxPlayers).toBe(8);
    }
  });

  it("rejects counts below 1 and falls back to the default", () => {
    for (const n of [0, -3]) {
      store.set(KEY_ROOM_MAX_PLAYERS, String(n));
      expect(getStoredRoomPrefs().maxPlayers).toBe(8);
    }
  });
});
