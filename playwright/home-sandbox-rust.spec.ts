// Smoke-test for the "Sandbox (Rust)" button on the Home screen.
//
// Walks: Home → click "Sandbox (Rust)" → Sandbox loads on `?engine=rust`,
// no console errors. Confirms the SPA-navigation path (no full reload)
// finds a ready wasm module thanks to the background preload in main.tsx.

import { test, expect } from '@playwright/test';

test('home: Sandbox (Rust) button opens sandbox on the wasm engine', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  // Mark intro as seen so Home renders directly (otherwise the app
  // redirects to /intro on first visit).
  await page.addInitScript(() => {
    localStorage.setItem('bouncy_blobs_intro_seen', 'true');
  });

  await page.goto('/');

  // The button is rendered as a Link wrapping a button — react-router
  // turns the link into client-side navigation.
  const rustButton = page.getByTestId('sandbox-rust-button');
  await expect(rustButton).toBeVisible({ timeout: 10_000 });
  await expect(rustButton).toContainText('Sandbox (Rust)');

  await rustButton.click();

  // The URL should reflect the engine flag.
  await expect(page).toHaveURL(/\/sandbox\?engine=rust/);

  // Give the sandbox a moment to mount the canvas and step the sim.
  await page.waitForTimeout(2_000);

  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();

  const meaningful = errors.filter((m) =>
    !m.includes('Failed to load resource') &&
    !m.includes('Failed to poll session') &&
    !m.includes('Missing X-API-Key') &&
    !m.toLowerCase().includes('cors'),
  );
  expect(meaningful, `Unexpected console errors:\n${meaningful.join('\n')}`).toHaveLength(0);
});
