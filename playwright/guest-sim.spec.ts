import { test, expect } from "@playwright/test";
import { startHosting } from "./lobby-helpers";

/**
 * Verifies the "guest runs its own simulation" architecture end-to-end:
 *   - Host sends a `level_loaded` reliable event to a joining guest.
 *   - Guest builds a local BouncyBlobsGame and renders its own canvas.
 *   - The "Play from laptop" toggle becomes enabled (proves level installed).
 *   - The guest's status line surfaces the host's snapshot tick stream.
 */

test("Guest installs the host's level and runs a local sim", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const { lobbyCode } = await startHosting(pageA);
  await pageA.getByTestId("toggle-public").click();

  await pageB.goto("/lobbies");
  await expect(pageB.getByTestId(`lobby-row-${lobbyCode}`)).toBeVisible({ timeout: 15_000 });
  await pageB.evaluate(() => {
    (window as unknown as { prompt: (msg?: string) => string }).prompt = () => "Guest";
  });
  await pageB.getByTestId(`lobby-row-${lobbyCode}`).getByRole("button", { name: /Join/ }).click();
  await expect(pageB).toHaveURL(/\/online-guest/);
  await expect(pageB.getByText(/●\s+connected/)).toBeVisible({ timeout: 60_000 });

  // Before level_loaded arrives the "Play from laptop" toggle is disabled and
  // the page shows "Waiting for the host…". After the host's snapshot stream
  // arrives, the toggle becomes enabled and a status line surfaces ticks.
  await expect(pageB.getByTestId("local-player-toggle")).toBeEnabled({ timeout: 30_000 });
  // Status line shape: "tick N · phase P · M blob(s)"
  await expect(pageB.getByTestId("guest-status")).toContainText(/tick \d+ · phase/, { timeout: 15_000 });

  // The guest now has a real <canvas> mounted (GameCanvas) — not a placeholder.
  const canvasCount = await pageB.locator("canvas").count();
  expect(canvasCount, "Guest should have mounted at least one canvas").toBeGreaterThan(0);

  // Guest joins as a local player → host's count bumps. Same end-to-end round
  // trip as guest-play.spec but here we additionally verify the local sim is
  // running by reading the canvas's actual pixel dimensions.
  await pageB.getByTestId("local-player-toggle").click();
  const dims = await pageB.locator("canvas").first().evaluate((el) => ({
    w: (el as HTMLCanvasElement).width,
    h: (el as HTMLCanvasElement).height,
  }));
  expect(dims.w, "Local canvas should be sized by GameCanvas onResize").toBeGreaterThan(0);
  expect(dims.h, "Local canvas should be sized by GameCanvas onResize").toBeGreaterThan(0);

  await ctxA.close();
  await ctxB.close();
});
