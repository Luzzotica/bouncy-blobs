import { test, expect } from "@playwright/test";

const PROGRESS_KEY = "bb.play.progress.v1";

test.beforeEach(async ({ page }) => {
  // Start each test with a clean campaign progress slate.
  await page.addInitScript((key) => {
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  }, PROGRESS_KEY);
});

test("Home has a Play button that opens the hub", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("play-button")).toBeVisible();
  await page.getByTestId("play-button").click();
  await expect(page).toHaveURL(/\/play(\?|$)/);
  await expect(page.getByRole("heading", { name: "Play" })).toBeVisible();
});

test("hub locks later levels until the prior one is cleared", async ({ page }) => {
  await page.goto("/play");
  // Level 1 (springy) is always playable; the rest start locked.
  await expect(page.getByTestId("play-level-springy")).toBeEnabled();
  await expect(page.getByTestId("play-level-swervy")).toBeDisabled();
  await expect(page.getByTestId("play-level-wall-climb")).toBeDisabled();
  await expect(page.getByTestId("play-level-ceiling-crawl")).toBeDisabled();
});

test("completing a level (persisted progress) unlocks the next and shows best time", async ({ page }) => {
  // Simulate a finished springy run written by recordCompletion().
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, JSON.stringify({
      springy: { completed: true, bestTimeMs: 12345, deaths: 2 },
    }));
  }, PROGRESS_KEY);

  await page.goto("/play");
  await expect(page.getByTestId("play-level-springy")).toContainText("Cleared");
  await expect(page.getByTestId("play-level-springy")).toContainText("0:12.345");
  // Next level is now unlocked; the one after stays locked.
  await expect(page.getByTestId("play-level-swervy")).toBeEnabled();
  await expect(page.getByTestId("play-level-wall-climb")).toBeDisabled();
});

test("clicking a level launches the runner with a live canvas", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/play");
  await page.getByTestId("play-level-springy").click();
  await expect(page).toHaveURL(/\/play\/level\?level=springy/);
  // The game canvas mounts and the Levels back-link is present.
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: "← Levels" })).toBeVisible();
  // Give the loop a moment to run, then assert no uncaught errors.
  await page.waitForTimeout(800);
  expect(errors, errors.join("\n")).toHaveLength(0);
});
