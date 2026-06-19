import { test, expect, type Page } from "@playwright/test";
import { startHosting, trackErrors } from "./lobby-helpers";

/**
 * Phone-controller end-to-end regression test.
 *
 * Reproduces and guards the "phone connects but the blob doesn't move" bug
 * (June 2026). Root cause: phone controllers were switched to send their
 * 30 Hz joystick stream (`player_input_batch` / `cursor_move`) over the
 * unreliable "input" WebRTC channel, but the host routed ANYTHING on the
 * "input" channel into the guest-laptop lockstep handler, which dropped
 * every message that wasn't `{type:'input', frames:[...]}`. Phones connected
 * fine (their `player_join` rides the reliable "data" channel) but every
 * joystick sample was silently swallowed → no motion.
 *
 * This test drives the REAL phone path:
 *   A: hosts a game.
 *   B: opens /controller/<code>, enters a name, joins, customizes, and lands
 *      on the live controller UI ("connected").
 *   B: holds the controller's RIGHT key (the keyboard fallback writes the
 *      same `inputRef` the joystick does, so it exercises the identical
 *      30 Hz send loop and "input" channel).
 *   A: the host's view of that phone's blob must actually move RIGHT — then
 *      LEFT — proving controller input reaches the simulation.
 *
 * Without the channel-routing fix the held-key motion never arrives and the
 * `expect.poll` for dx times out — exactly the user-reported symptom.
 */

interface DebugBridge {
  getAllPlayerPositions: () => Record<string, { x: number; y: number }>;
  getPlayerPos: (id: string) => { x: number; y: number } | null;
}

async function readAllPositions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(
    () => (window as unknown as { __bbDebug?: DebugBridge }).__bbDebug?.getAllPlayerPositions() ?? {},
  );
}

async function readPos(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    (pid) => (window as unknown as { __bbDebug?: DebugBridge }).__bbDebug?.getPlayerPos(pid) ?? null,
    id,
  );
}

/** Walk a freshly-opened controller page from /controller/<code> through to
 * the live ("connected") controller UI. */
async function joinAsPhone(page: Page, code: string, name: string): Promise<void> {
  await page.goto(`/controller/${code}`);

  // Join screen.
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Join" }).click();

  // WebRTC handshake over polled signaling is the long pole (~30s on
  // headless Chromium loopback). The "Customize" screen renders once the
  // data channel opens and onPeerConnected fires.
  await expect(page.getByRole("button", { name: "Let's Go!" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Let's Go!" }).click();

  // Live controller UI — the keyboard fallback only arms in this phase.
  await expect(page.getByRole("button", { name: "Let's Go!" })).toBeHidden();
}

test("Phone controller input moves the host's blob", async ({ browser }) => {
  test.setTimeout(180_000);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const aErr = trackErrors(pageA);

  // 1. Host on A.
  const { joinCode } = await startHosting(pageA);

  // Whatever blobs the host already owns before the phone joins (host may
  // have a local player). The phone's blob is whatever id appears next.
  const beforeIds = new Set(Object.keys(await readAllPositions(pageA)));

  // 2. Phone joins on B and reaches the live controller.
  await joinAsPhone(pageB, joinCode, "Phoney");

  // 3. Wait for the phone's blob to spawn on the host, then identify its id.
  const newPhoneId = async (): Promise<string | null> => {
    const ids = Object.keys(await readAllPositions(pageA)).filter((id) => !beforeIds.has(id));
    return ids[0] ?? null;
  };
  await expect
    .poll(newPhoneId, { timeout: 30_000, message: "host should spawn a blob for the joined phone" })
    .not.toBeNull();
  const phoneId = await newPhoneId();
  expect(phoneId).not.toBeNull();
  if (!phoneId) return;

  const start = await readPos(pageA, phoneId);
  expect(start, "phone blob should have a position on the host").not.toBeNull();
  if (!start) return;

  // Focus the controller page so its window keydown listener receives keys.
  await pageB.locator("body").click({ position: { x: 5, y: 5 } });

  // 4. Hold RIGHT. The host's view of the phone blob must move right. Poll
  //    while the key is held so we tolerate the blob's movement speed
  //    without guessing a fixed duration. >25px is well clear of idle
  //    settle/jitter and far below any teleport.
  await pageB.keyboard.down("KeyD");
  await expect
    .poll(async () => (await readPos(pageA, phoneId))?.x ?? start.x, {
      timeout: 15_000,
      message: "host blob should move RIGHT in response to phone input",
    })
    .toBeGreaterThan(start.x + 25);
  await pageB.keyboard.up("KeyD");

  const afterRight = await readPos(pageA, phoneId);
  expect(afterRight).not.toBeNull();
  if (!afterRight) return;
  // Sanity: it steered, it didn't teleport off-world.
  expect(Math.abs(afterRight.x), `afterRight.x=${afterRight.x}`).toBeLessThan(50_000);

  // 5. Hold LEFT. The blob must reverse direction — proves input is actually
  //    steering, not one-time drift.
  await pageB.keyboard.down("KeyA");
  await expect
    .poll(async () => (await readPos(pageA, phoneId))?.x ?? afterRight.x, {
      timeout: 15_000,
      message: "host blob should move LEFT when phone steers back",
    })
    .toBeLessThan(afterRight.x - 25);
  await pageB.keyboard.up("KeyA");

  // Host should not have logged meaningful errors during the exchange.
  expect(aErr.errors, aErr.errors.join("\n")).toHaveLength(0);

  await ctxA.close();
  await ctxB.close();
});
