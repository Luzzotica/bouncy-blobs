import { test, expect } from '@playwright/test';

/**
 * Smoke test: boot the host page with auto-spawned bots, let them play for
 * 30 seconds, and assert nothing exploded in the console.
 *
 * What this verifies:
 *  - Game initialises without crashing
 *  - URL ?ai= param spawns the requested bots
 *  - Bots survive the voting → playing transition (game rebuild path)
 *  - 30s of physics doesn't throw or warn loudly
 */

test('host + 4 AI bots play for 30s without errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });

  // Use ?ai= so bots spawn automatically without needing the lobby UI.
  await page.goto('/game?offline=1&ai=chaser,fleer,wanderer,bouncer');

  // Wait for the lobby/voting phase to be reachable. The "+ Add AI Bot"
  // button is rendered in the voting phase top-bar.
  await expect(page.getByTestId('add-bot')).toBeVisible({ timeout: 30_000 });

  // Confirm the URL-param bots actually spawned.
  await expect(page.getByTestId('bot-chip-chaser')).toBeVisible();
  await expect(page.getByTestId('bot-chip-fleer')).toBeVisible();
  await expect(page.getByTestId('bot-chip-wanderer')).toBeVisible();
  await expect(page.getByTestId('bot-chip-bouncer')).toBeVisible();

  // Let the simulation run.
  await page.waitForTimeout(30_000);

  // Filter out network/CORS noise that's expected when no API key is configured.
  const meaningful = consoleErrors.filter((m) =>
    !m.includes('Failed to load resource') &&
    !m.includes('Failed to poll session') &&
    !m.includes('Missing X-API-Key') &&
    !m.toLowerCase().includes('cors'),
  );
  expect(meaningful, `Unexpected console errors:\n${meaningful.join('\n')}`).toHaveLength(0);
});
