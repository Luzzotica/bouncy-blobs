// End Game button regression: host can end a running game and return
// to the lobby state. Tests the offline-mode path since it doesn't need
// the party API server.

import { test, expect } from '@playwright/test';

test('host: End Game returns to lobby, preserves bots', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/game?offline=1&ai=chaser,fleer');

  // Wait for playing-phase UI: the End Game button + bot chips render
  // here (chips only exist in the playing-phase top-left button column).
  const endGameBtn = page.getByTestId('end-game-button');
  await expect(endGameBtn).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('bot-chip-chaser')).toBeVisible();
  await expect(page.getByTestId('bot-chip-fleer')).toBeVisible();

  // Let the game tick a bit so we exercise the active gameplay path
  // before tearing it down.
  await page.waitForTimeout(1_200);

  // Click End Game. We should transition into the lobby phase — visible
  // signal is the LobbyPanel's join-code testid (only rendered in lobby).
  await endGameBtn.click();
  await expect(page.getByTestId('join-code')).toBeVisible({ timeout: 10_000 });

  // Bots survive the transition — `spawnExistingPlayers` + the canvasKey-
  // bump re-attach effect re-adds them to the playground game. They now
  // render as player rows inside the LobbyPanel (no longer as bot chips,
  // which are a playing-phase-only widget). Two bots in → two rows out.
  // Give the canvasKey-change re-attach effect a tick to fire.
  await expect.poll(
    async () => page.locator('[data-testid^="player-row-"]').count(),
    { timeout: 8_000 },
  ).toBe(2);

  const meaningful = errors.filter((m) =>
    !m.includes('Failed to load resource') &&
    !m.includes('Failed to poll session') &&
    !m.includes('Missing X-API-Key') &&
    !m.toLowerCase().includes('cors'),
  );
  expect(meaningful, `Unexpected console errors:\n${meaningful.join('\n')}`).toHaveLength(0);
});
