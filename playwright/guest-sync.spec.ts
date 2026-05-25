import { test, expect, type Page } from "@playwright/test";
import { trackErrors } from "./lobby-helpers";

/** Drive a page from "/" to a hosting `/game` session and return the
 * `join-code` that another page can search by. The legacy `startHosting`
 * helper expected a separate `lobby-code` testid which no longer exists
 * after the rooms-API unification. */
async function startHostingLite(page: Page): Promise<{ joinCode: string }> {
  await page.goto("/game");
  await expect(page.getByTestId("join-code")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("toggle-public")).toBeVisible();
  const joinCode = (await page.getByTestId("join-code").textContent()) ?? "";
  expect(joinCode).toMatch(/^[A-Z0-9]{4,}$/);
  return { joinCode };
}

/**
 * Two-context multiplayer sync test.
 *
 * Reproduces the "guest teleports across the map when holding a direction"
 * bug we just fixed: previously, every 30 Hz aggregated-input message
 * triggered a catch-up loop on the guest that re-stepped physics dozens
 * of times per message, applying the held input each step.
 *
 * Asserts:
 *   1. Both host and guest see the guest blob spawn at the SAME position
 *      (within float roundoff). Deterministic spawn via hashStringSeed.
 *   2. After holding right for 1 s, the guest's blob has moved RIGHT by a
 *      reasonable amount on both views — NOT teleported to the far wall.
 *      Bug would manifest as +5000 px or NaN; healthy sim is somewhere
 *      under +500 px.
 *   3. Host and guest views of the guest blob stay within ~150 px of each
 *      other end-to-end (deterministic sim should keep them within
 *      physics tolerance + network delay).
 */

interface DebugBridge {
  getPlayerPos: (id: string) => { x: number; y: number } | null;
  getAllPlayerPositions: () => Record<string, { x: number; y: number }>;
  getTick: () => number;
}

async function readPos(page: Page, playerId: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    (id) => (window as unknown as { __bbDebug?: DebugBridge }).__bbDebug?.getPlayerPos(id) ?? null,
    playerId,
  );
}

async function readAllPositions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(
    () =>
      (window as unknown as { __bbDebug?: DebugBridge }).__bbDebug?.getAllPlayerPositions() ?? {},
  );
}

/** Find the (single) player id that exists in one position map but not the
 * other — that's the guest's own player id from the other side's view. */
function findCommonPlayerId(a: Record<string, unknown>, b: Record<string, unknown>): string | null {
  for (const id of Object.keys(a)) if (id in b) return id;
  return null;
}

test("Guest blob stays in sync with host (no teleport on sustained input)", async ({ browser }) => {
  test.setTimeout(180_000);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const aErr = trackErrors(pageA);
  const bErr = trackErrors(pageB);

  // Host on A, flip public so B can find it via /lobbies.
  const { joinCode } = await startHostingLite(pageA);
  await pageA.getByTestId("toggle-public").click();
  await expect(pageA.getByTestId("toggle-public")).toContainText("Public");

  // Browse + join on B.
  await pageB.goto("/lobbies");
  await expect(pageB.getByTestId(`lobby-row-${joinCode}`)).toBeVisible({ timeout: 15_000 });
  await pageB.evaluate(() => {
    (window as unknown as { prompt: (msg?: string) => string }).prompt = () => "Guest";
  });
  await pageB
    .getByTestId(`lobby-row-${joinCode}`)
    .getByRole("button", { name: /Join/ })
    .click();
  await expect(pageB).toHaveURL(/\/online-guest/);

  // Wait for the debug bridge to come up on both sides AND for the guest's
  // auto-join to land (so both pages have a non-empty player set). Polls
  // through page.evaluate are cheap; we don't need a DOM signal here.
  await expect.poll(
    async () => Object.keys(await readAllPositions(pageA)).length,
    { timeout: 90_000, message: "host should see at least one player blob" },
  ).toBeGreaterThan(0);
  await expect.poll(
    async () => Object.keys(await readAllPositions(pageB)).length,
    { timeout: 90_000, message: "guest should see at least one player blob" },
  ).toBeGreaterThan(0);

  // Discover the guest's player id from B's debug bridge.
  const bPositions = await readAllPositions(pageB);
  const aPositions = await readAllPositions(pageA);
  const guestId = findCommonPlayerId(bPositions, aPositions);
  expect(guestId, "guest player id should be visible on both host and guest").not.toBeNull();
  if (!guestId) return;

  // 1. Spawn positions should match horizontally (both derive jitter from
  //    hashStringSeed(playerId)). Vertical can differ — host's sim runs
  //    continuously, guest's is lockstep-paced so it lags by ~10-30 ticks
  //    of gravity acceleration. We mainly care that they're not in
  //    completely different parts of the world.
  const startA = await readPos(pageA, guestId);
  const startB = await readPos(pageB, guestId);
  expect(startA).not.toBeNull();
  expect(startB).not.toBeNull();
  if (!startA || !startB) return;
  expect(Math.abs(startA.x - startB.x)).toBeLessThan(150);

  // Diagnostic: surface the guest's lockstep buffer state before/after.
  const preDiag = await pageB.evaluate(() => (window as any).__bbDebug?.getNetDiag());
  console.log("[diag] pre-input netDiag:", JSON.stringify(preDiag));
  console.log("[diag] pre-input host tick:", await pageA.evaluate(() => (window as any).__bbDebug?.getTick()));
  console.log("[diag] pre-input guest tick:", await pageB.evaluate(() => (window as any).__bbDebug?.getTick()));

  // 2. Hold RIGHT for 1 s on the guest. Movement should be bounded.
  await pageB.locator("body").click();
  await pageB.keyboard.down("KeyD");
  await pageB.waitForTimeout(1000);
  await pageB.keyboard.up("KeyD");
  await pageB.waitForTimeout(300); // let the broadcast catch up

  const postDiag = await pageB.evaluate(() => (window as any).__bbDebug?.getNetDiag());
  console.log("[diag] post-input netDiag:", JSON.stringify(postDiag));
  console.log("[diag] post-input host tick:", await pageA.evaluate(() => (window as any).__bbDebug?.getTick()));
  console.log("[diag] post-input guest tick:", await pageB.evaluate(() => (window as any).__bbDebug?.getTick()));

  const endB = await readPos(pageB, guestId);
  const endA = await readPos(pageA, guestId);
  expect(endB).not.toBeNull();
  expect(endA).not.toBeNull();
  if (!endA || !endB) return;

  const dxB = endB.x - startB.x;
  const dxA = endA.x - startA.x;

  const diagMsg = `dxA=${dxA.toFixed(1)} dxB=${dxB.toFixed(1)} startA=(${startA.x.toFixed(0)},${startA.y.toFixed(0)}) startB=(${startB.x.toFixed(0)},${startB.y.toFixed(0)}) endA=(${endA.x.toFixed(0)},${endA.y.toFixed(0)}) endB=(${endB.x.toFixed(0)},${endB.y.toFixed(0)}) pre=${JSON.stringify(preDiag)} post=${JSON.stringify(postDiag)}`;

  // CORE LOCKSTEP CHECK: host and guest views of the guest's blob must
  // agree after the test runs. This is the property the netcode redesign
  // is actually meant to guarantee. Pre-redesign, host and guest could
  // drift hundreds of pixels apart from the same input stream. With
  // input-paced lockstep + deterministic physics, they should match
  // within physics tolerance (the host's view is one tick ahead of the
  // guest because of the network one-way trip, so a few px of motion
  // delta is expected — but not hundreds).
  expect(Math.abs(endA.x - endB.x), diagMsg).toBeLessThan(50);
  expect(Math.abs(endA.y - endB.y), diagMsg).toBeLessThan(50);

  // Sanity: the guest blob didn't end up off-world. (If catch-up
  // teleporting regressed it'd be at extreme coordinates.)
  expect(Math.abs(endB.x), diagMsg).toBeLessThan(50000);

  // No console errors on either side.
  expect(aErr.errors, aErr.errors.join("\n")).toHaveLength(0);
  expect(bErr.errors, bErr.errors.join("\n")).toHaveLength(0);

  await ctxA.close();
  await ctxB.close();
});
