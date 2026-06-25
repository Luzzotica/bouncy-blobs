import { test, expect } from '@playwright/test';

/**
 * E2E: in King of the Hill, the active hill relocates between the level's
 * defined hill zones during a match.
 *
 * Drives the real game end-to-end — actual game loop, the Rust-owned RNG
 * stream, and KingOfTheHillMode.maybeRotateHill() — then reads the live
 * active hill via the dev-only `window.__bbGame` diagnostics hook.
 *
 * Uses the hidden `koth-moving-test` level (3 hills, 2–3s rotation) so a
 * single short match exercises several moves. A fixed `?seed=` makes the
 * RNG-driven schedule deterministic, so this isn't flaky.
 */

const VALID_HILL_IDS = ['hill-zone', 'hill-left', 'hill-right'];

/** Read the current active hill id from the live game, or null if unavailable. */
async function readActiveHillId(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => {
    const g = (window as unknown as { __bbGame?: any }).__bbGame;
    const mode = g?.getModeManager?.()?.getMode?.();
    const hill = mode?.getActiveHill?.();
    return hill?.id ?? null;
  });
}

test('KOTH: the hill moves between zones during a match', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  // Offline KOTH match on the fast-rotating test level, with bots so the
  // sim is fully populated. Fixed seed → deterministic rotation schedule.
  await page.goto('/game?offline=1&level=koth-moving-test&mode=koth&ai=chaser,fleer&seed=20260624');

  // End Game button only renders in the playing phase — wait for it so we
  // know the match has started and gameTime (which drives rotation) advances.
  await expect(page.getByTestId('end-game-button')).toBeVisible({ timeout: 30_000 });

  // The diagnostics hook must be present (dev build only).
  await expect.poll(() => readActiveHillId(page), { timeout: 10_000 }).not.toBeNull();

  // Match start always pins the hill to the first defined zone.
  expect(await readActiveHillId(page)).toBe('hill-zone');

  // Sample the active hill in-page for 12s, recording the sequence of
  // *distinct consecutive* hill ids (one entry per move).
  const sequence: string[] = await page.evaluate(async (durationMs) => {
    const g = (window as unknown as { __bbGame?: any }).__bbGame;
    const readId = (): string | null => {
      const hill = g?.getModeManager?.()?.getMode?.()?.getActiveHill?.();
      return hill?.id ?? null;
    };
    const seq: string[] = [];
    const start = performance.now();
    return await new Promise<string[]>((resolve) => {
      const tick = () => {
        const id = readId();
        if (id && seq[seq.length - 1] !== id) seq.push(id);
        if (performance.now() - start >= durationMs) resolve(seq);
        else setTimeout(tick, 100);
      };
      tick();
    });
  }, 12_000);

  // The hill moved at least once (started on hill-zone, then changed).
  expect(sequence.length, `hill never moved; sequence=${JSON.stringify(sequence)}`).toBeGreaterThan(1);

  // Every observed hill is one of the level's defined zones.
  for (const id of sequence) expect(VALID_HILL_IDS).toContain(id);

  // It cycled through at least two distinct zones.
  expect(new Set(sequence).size).toBeGreaterThanOrEqual(2);

  // No move ever lands on the zone it just left (no-repeat selection).
  for (let i = 1; i < sequence.length; i++) {
    expect(sequence[i], `repeated hill at move ${i}: ${JSON.stringify(sequence)}`).not.toBe(sequence[i - 1]);
  }

  const meaningful = errors.filter((m) =>
    !m.includes('Failed to load resource') &&
    !m.includes('Failed to poll session') &&
    !m.includes('Missing X-API-Key') &&
    !m.toLowerCase().includes('cors'),
  );
  expect(meaningful, `Unexpected console errors:\n${meaningful.join('\n')}`).toHaveLength(0);
});
