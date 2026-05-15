import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { PARTY_API_URL, MP_API_KEY } from "./lobby-helpers";

/**
 * End-to-end API tests for the room-capacity behavior the user just hit:
 *
 *   1. The host's own peer row does NOT consume a player slot — a room with
 *      max_peers=2 must accept 2 joiners after the host is created.
 *   2. Joining past max_peers returns 409 "Room is full".
 *   3. PATCHing max_peers up lets the next join succeed.
 *
 * Goes through real HTTP to a real hexii backend (no mocks), so this is the
 * tightest possible regression net for the SQL `room_join` cap math + the
 * client's setMaxPeers wiring.
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function authCtx(): Promise<APIRequestContext> {
  return request.newContext({
    extraHTTPHeaders: { "X-API-Key": MP_API_KEY, "Content-Type": "application/json" },
  });
}

interface CreatedRoom {
  room_id: string;
  join_code: string;
  host_secret: string;
  host_peer_id: string;
  host_peer_secret: string;
}

async function createRoom(ctx: APIRequestContext, maxPeers: number, gameId = "bouncy-blobs"): Promise<CreatedRoom> {
  const res = await ctx.post(`${PARTY_API_URL}/api/rooms`, {
    data: {
      game_id: gameId,
      display_name: `cap-test-${Date.now()}`,
      max_peers: maxPeers,
      visibility: "private",
    },
  });
  expect(res.status(), `Create room → ${res.status()}: ${await res.text()}`).toBe(201);
  return res.json() as Promise<CreatedRoom>;
}

async function joinAsPhone(ctx: APIRequestContext, roomId: string, name: string) {
  return ctx.post(`${PARTY_API_URL}/api/rooms/${roomId}/peers`, {
    data: { kind: "phone", display_name: name },
  });
}

async function setMaxPeers(ctx: APIRequestContext, roomId: string, hostSecret: string, max: number) {
  return ctx.patch(`${PARTY_API_URL}/api/rooms/${roomId}`, {
    data: { host_secret: hostSecret, max_peers: max },
  });
}

async function endRoom(ctx: APIRequestContext, roomId: string, hostSecret: string): Promise<void> {
  await ctx.patch(`${PARTY_API_URL}/api/rooms/${roomId}`, {
    data: { host_secret: hostSecret, status: "ended" },
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe("room capacity", () => {
  let ctx: APIRequestContext;
  test.beforeAll(async () => { ctx = await authCtx(); });
  test.afterAll(async () => { await ctx.dispose(); });

  test("host peer does not count toward max_peers — N joiners fit a max=N room", async () => {
    const room = await createRoom(ctx, 2);

    // Confirm the host peer exists server-side (so we know we're really
    // testing "is_host=true is excluded", not "no host peer was created").
    const detail = await ctx.get(`${PARTY_API_URL}/api/rooms/${room.room_id}`).then(r => r.json());
    expect(detail.peers.some((p: any) => p.is_host === true)).toBe(true);

    const a = await joinAsPhone(ctx, room.room_id, "alice");
    expect(a.status(), `join 1/2 → ${a.status()}: ${await a.text()}`).toBe(201);

    const b = await joinAsPhone(ctx, room.room_id, "bob");
    expect(b.status(), `join 2/2 → ${b.status()}: ${await b.text()}`).toBe(201);

    // Sanity: peer count now matches the join count + host.
    const after = await ctx.get(`${PARTY_API_URL}/api/rooms/${room.room_id}`).then(r => r.json());
    const nonHostPeers = after.peers.filter((p: any) => !p.is_host && p.status !== "disconnected");
    expect(nonHostPeers).toHaveLength(2);

    await endRoom(ctx, room.room_id, room.host_secret);
  });

  test("joining past max_peers returns 409 room_full", async () => {
    const room = await createRoom(ctx, 1);
    const ok = await joinAsPhone(ctx, room.room_id, "first");
    expect(ok.status()).toBe(201);

    const denied = await joinAsPhone(ctx, room.room_id, "second");
    expect(denied.status(), `should be 409 room_full, got ${await denied.text()}`).toBe(409);

    await endRoom(ctx, room.room_id, room.host_secret);
  });

  test("PATCH max_peers up — previously-denied join now succeeds", async () => {
    const room = await createRoom(ctx, 1);
    await joinAsPhone(ctx, room.room_id, "first");

    // Without raising, second join should still fail.
    const blocked = await joinAsPhone(ctx, room.room_id, "second-blocked");
    expect(blocked.status()).toBe(409);

    // Host raises the cap.
    const patch = await setMaxPeers(ctx, room.room_id, room.host_secret, 4);
    expect(patch.status(), `PATCH max_peers → ${await patch.text()}`).toBe(200);

    // Sanity-check the server stored the new value.
    const detail = await ctx.get(`${PARTY_API_URL}/api/rooms/${room.room_id}`).then(r => r.json());
    expect(detail.max_peers).toBe(4);

    // Same join attempt now succeeds.
    const allowed = await joinAsPhone(ctx, room.room_id, "second-allowed");
    expect(allowed.status(), `should be 201 after raising cap, got ${await allowed.text()}`).toBe(201);

    // Fill to the new cap and confirm 5th still gets 409.
    const c = await joinAsPhone(ctx, room.room_id, "third");
    expect(c.status()).toBe(201);
    const d = await joinAsPhone(ctx, room.room_id, "fourth");
    expect(d.status()).toBe(201);
    const e = await joinAsPhone(ctx, room.room_id, "fifth");
    expect(e.status(), "fifth should be 409 at new cap").toBe(409);

    await endRoom(ctx, room.room_id, room.host_secret);
  });

  test("PATCH max_peers down below current count does NOT evict — but blocks new joins", async () => {
    // Documents the current server behavior: room_join only checks the cap at
    // JOIN time. Shrinking max_peers below the current count leaves existing
    // peers in place; new joins are rejected until enough leave. If we ever
    // change this to evict, flip this test.
    const room = await createRoom(ctx, 3);
    await joinAsPhone(ctx, room.room_id, "one");
    await joinAsPhone(ctx, room.room_id, "two");
    await joinAsPhone(ctx, room.room_id, "three");

    const patch = await setMaxPeers(ctx, room.room_id, room.host_secret, 1);
    expect(patch.status()).toBe(200);

    const detail = await ctx.get(`${PARTY_API_URL}/api/rooms/${room.room_id}`).then(r => r.json());
    const nonHost = detail.peers.filter((p: any) => !p.is_host && p.status !== "disconnected");
    expect(nonHost, "shrinking does not evict").toHaveLength(3);

    const denied = await joinAsPhone(ctx, room.room_id, "four");
    expect(denied.status(), "new joins blocked below shrunk cap").toBe(409);

    await endRoom(ctx, room.room_id, room.host_secret);
  });
});
