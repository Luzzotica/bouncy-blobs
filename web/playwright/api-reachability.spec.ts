import { test, expect, request } from "@playwright/test";
import { PARTY_API_URL, MP_API_KEY } from "./lobby-helpers";

/**
 * Sanity check the developer's setup before the UI tests bother trying.
 * If this fails, every other lobby test will hang at "Creating session..."
 * which is exactly the bug the user just hit.
 */

test("hexii API is reachable on VITE_PARTY_API_URL", async () => {
  const ctx = await request.newContext();
  const res = await ctx.get(`${PARTY_API_URL}/api/rooms`, {
    timeout: 5000,
  });
  expect(
    res.status(),
    `Expected 401 from ${PARTY_API_URL} without auth — got ${res.status()}. Is hexii running?`,
  ).toBe(401);
  await ctx.dispose();
});

test("MP API key is valid", async () => {
  const ctx = await request.newContext({
    extraHTTPHeaders: { "X-API-Key": MP_API_KEY },
  });
  const res = await ctx.get(`${PARTY_API_URL}/api/rooms?game_id=bouncy-blobs`, {
    timeout: 5000,
  });
  expect(res.status(), `API key rejected by hexii: HTTP ${res.status()}`).toBe(200);
  const body = (await res.json()) as { rooms: unknown[] };
  expect(Array.isArray(body.rooms)).toBe(true);
  await ctx.dispose();
});
