import { test, expect } from "@playwright/test";
import { startHosting, trackErrors } from "./lobby-helpers";

/**
 * "Play from this laptop" — the host can claim one local keyboard slot.
 * Asserts:
 *   - The button is visible in the lobby
 *   - Clicking it bumps the player count by exactly one
 *   - Clicking it twice does NOT add a second player (still +1 vs baseline)
 *   - Leave brings the count back down
 *   - Re-joining works
 *   - WASD / Space keys don't throw
 */

async function getPlayerCount(page: import("@playwright/test").Page): Promise<number> {
  const text = (await page.getByText(/^Players:\s+\d+$/).textContent()) ?? "";
  const m = text.match(/(\d+)/);
  return m ? Number(m[1]) : NaN;
}

test("Local player: button toggles join/leave and is single-slot only", async ({ page }) => {
  const { errors } = trackErrors(page);
  await startHosting(page);

  const toggle = page.getByTestId("local-player-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText("Play from laptop");

  const baseline = await getPlayerCount(page);

  // Join.
  await toggle.click();
  await expect(toggle).toContainText("Leave (You)");
  await expect.poll(() => getPlayerCount(page)).toBe(baseline + 1);

  // Clicking again should LEAVE (not add a second), since the button flips.
  await toggle.click();
  await expect(toggle).toContainText("Play from laptop");
  await expect.poll(() => getPlayerCount(page)).toBe(baseline);

  // Re-join works.
  await toggle.click();
  await expect(toggle).toContainText("Leave (You)");
  await expect.poll(() => getPlayerCount(page)).toBe(baseline + 1);

  // Hammering keyboard keys should be safely consumed by the InputManager.
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(50);
  await page.keyboard.down("Space");
  await page.waitForTimeout(50);
  await page.keyboard.up("Space");
  await page.keyboard.up("KeyD");

  expect(errors, errors.join("\n")).toHaveLength(0);
});
