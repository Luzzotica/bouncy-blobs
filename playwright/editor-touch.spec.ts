// ─────────────────────────────────────────────────────────────────────────────
// Editor touch gestures, emulated on a phone-sized touch context:
//   - one-finger drag places a platform (tool tap → drag → finishPlacement)
//   - tapping the placed platform with the Select tool selects it and shows
//     the touch action bar (Delete)
//   - two-finger pinch zooms, anchored (multi-touch via CDP — Playwright's
//     page.touchscreen is tap-only)
// Assertions read the dev handle window.__bbEditor (see Editor.tsx).
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, devices } from "@playwright/test";

declare global {
  interface Window {
    __bbEditor?: {
      zoom: number;
      selectedElement: { type: string; id: string } | null;
      level: { platforms: { x: number; y: number }[] };
    } | null;
  }
}

test("editor touch: place a platform, select it, pinch-zoom", async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices["Pixel 7"] });
  const page = await ctx.newPage();
  // Skip the first-run intro redirect (same trick as home-sandbox-rust.spec).
  await page.addInitScript(() => localStorage.setItem("bouncy_blobs_intro_seen", "true"));
  await page.goto("/editor");

  // Create a fresh level (list → type picker → editing phase).
  await page.getByRole("button", { name: "+ New Level" }).tap();
  await page.getByPlaceholder("e.g. Lava Tower").fill("Touch Test");
  // Pick the first mode card (any mode works for this test).
  await page.getByRole("button", { name: /race|battle|king|goal|survival/i }).first().tap();
  await page.getByRole("button", { name: "Create Level" }).tap();

  const canvas = page.locator("canvas");
  await canvas.waitFor();
  await page.waitForFunction(() => !!window.__bbEditor);
  const box = (await canvas.boundingBox())!;
  const cdp = await ctx.newCDPSession(page);
  const pt = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });

  // ── One-finger drag: place a platform ──────────────────────────────────────
  const platformsBefore = await page.evaluate(() => window.__bbEditor!.level.platforms.length);
  await page.getByRole("button", { name: /^Platform/ }).tap();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt(120, 300)] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [pt(120 + i * 20, 300 + i * 8)],
    });
    await page.waitForTimeout(30);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect
    .poll(() => page.evaluate(() => window.__bbEditor!.level.platforms.length))
    .toBe(platformsBefore + 1);

  // ── Tap-select with the Select tool → touch action bar appears ────────────
  await page.getByRole("button", { name: /^Select/ }).tap();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt(180, 325)] });
  await page.waitForTimeout(120); // past the 80ms pinch-upgrade slop
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect
    .poll(() => page.evaluate(() => window.__bbEditor!.selectedElement?.type ?? null))
    .toBe("platform");
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();

  // ── Two-finger pinch: zoom in, anchored ────────────────────────────────────
  const zoomBefore = await page.evaluate(() => window.__bbEditor!.zoom);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [pt(160, 350), pt(240, 350)],
  });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [pt(160 - i * 12, 350), pt(240 + i * 12, 350)],
    });
    await page.waitForTimeout(30);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const zoomAfter = await page.evaluate(() => window.__bbEditor!.zoom);
  expect(zoomAfter).toBeGreaterThan(zoomBefore * 1.3);

  await ctx.close();
});
