import { test, expect } from "@playwright/test";
import { startHosting, trackErrors } from "./lobby-helpers";

/**
 * Two-context test of the full host ↔ guest round trip:
 *   A: hosts → makes lobby public
 *   B: joins from /lobbies → reaches /online-guest → WebRTC connects
 *   B: clicks "Play from laptop" → host's player count goes UP by 1
 *      (proves the reliable channel + player_join event was received)
 *   B: hits a few WASD keys (proves the unreliable input pipe doesn't crash)
 *   B: clicks "Leave (You)" → host's player count goes back down
 */

async function getPlayerCount(page: import("@playwright/test").Page): Promise<number> {
  const text = (await page.getByText(/^Players:\s+\d+$/).textContent()) ?? "";
  const m = text.match(/(\d+)/);
  return m ? Number(m[1]) : NaN;
}

test("Guest can join the host's game from /online-guest", async ({ browser }) => {
  // WebRTC handshake over the polled signaling channel is the long pole — in
  // headless Chromium loopback it takes ~30s end-to-end before both data
  // channels open. Real cross-laptop is similar.
  test.setTimeout(120_000);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const aErr = trackErrors(pageA);

  // 1. Host on A, flip public.
  const { lobbyCode } = await startHosting(pageA);
  await pageA.getByTestId("toggle-public").click();
  await expect(pageA.getByTestId("toggle-public")).toContainText("Public");
  const baseline = await getPlayerCount(pageA);

  // 2. Browse + join on B.
  await pageB.goto("/lobbies");
  await expect(pageB.getByTestId(`lobby-row-${lobbyCode}`)).toBeVisible({ timeout: 15_000 });
  await pageB.evaluate(() => {
    (window as unknown as { prompt: (msg?: string) => string }).prompt = () => "Guest";
  });
  await pageB
    .getByTestId(`lobby-row-${lobbyCode}`)
    .getByRole("button", { name: /Join/ })
    .click();
  await expect(pageB).toHaveURL(/\/online-guest/);

  // 3. Wait for the WebRTC data channel to open.
  await expect(pageB.getByText(/●\s+connected/)).toBeVisible({ timeout: 60_000 });

  // 4. Guest joins as a player. Host count should bump by exactly 1.
  await pageB.getByTestId("local-player-toggle").click();
  await expect(pageB.getByTestId("local-player-toggle")).toContainText("Leave (You)");
  await expect.poll(() => getPlayerCount(pageA), { timeout: 10_000 }).toBe(baseline + 1);

  // 5. WASD/Space don't blow up either side.
  await pageB.locator("body").click();
  await pageB.keyboard.down("KeyD");
  await pageB.waitForTimeout(150);
  await pageB.keyboard.down("Space");
  await pageB.waitForTimeout(150);
  await pageB.keyboard.up("Space");
  await pageB.keyboard.up("KeyD");

  // 6. Guest leaves. Host count returns to baseline.
  await pageB.getByTestId("local-player-toggle").click();
  await expect(pageB.getByTestId("local-player-toggle")).toContainText("Play from laptop");
  await expect.poll(() => getPlayerCount(pageA), { timeout: 10_000 }).toBe(baseline);

  // The host should not have logged any meaningful errors during this dance.
  expect(aErr.errors, aErr.errors.join("\n")).toHaveLength(0);

  await ctxA.close();
  await ctxB.close();
});
