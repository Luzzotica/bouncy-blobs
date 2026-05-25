// Playwright validation of the wasm-backed Rust engine.
//
// Doesn't need the party API server — uses `/game?offline=1&ai=...` so
// the lobby + matchmaking is bypassed entirely. Two checks:
//
//  1. The game boots end-to-end on `?engine=rust` without console errors
//     and runs 30s of physics with AI bots.
//
//  2. Two SEPARATE browser contexts running the same scenario produce
//     identical `world.stateHash()` after the run — this is the netplay
//     determinism guarantee in synthetic form (no real network, but
//     two independent JS contexts + two independent wasm instances).
//     If TS engine were used, this would fail because of f64 non-
//     determinism — the whole motivation for the Rust port.

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const AI_SCENARIO = '/game?engine=rust&offline=1&ai=chaser,fleer,wanderer,bouncer&seed=1337';

// No-AI scenario for the cross-context determinism test. AI spawn paths
// currently use `Math.random()` for bot IDs + spawn jitter (see
// aiController.ts:105,112), which would make any two contexts diverge
// regardless of whether the physics engine is deterministic. Without
// any AI input, both contexts just sit at the spawn — engine
// determinism is the only thing that can make the hashes match.
const STATIC_SCENARIO = '/game?engine=rust&offline=1&seed=1337';

/** Read `world.stateHash()` from the page via the debug bridge.
 *  Returns null until the game is mid-match. */
async function readStateHash(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __bbDebug?: { getStateHash?: () => string | null };
    };
    return w.__bbDebug?.getStateHash?.() ?? null;
  });
}

async function bootScenario(ctx: BrowserContext, url: string): Promise<{ page: Page; errors: string[] }> {
  const errors: string[] = [];
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  await page.goto(url);
  await expect(page.getByTestId('add-bot')).toBeVisible({ timeout: 30_000 });
  return { page, errors };
}

test('rust engine: game boots + runs 30s with AI bots, no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto(AI_SCENARIO);

  await expect(page.getByTestId('add-bot')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('bot-chip-chaser')).toBeVisible();
  await expect(page.getByTestId('bot-chip-fleer')).toBeVisible();
  await expect(page.getByTestId('bot-chip-wanderer')).toBeVisible();
  await expect(page.getByTestId('bot-chip-bouncer')).toBeVisible();

  await page.waitForTimeout(30_000);

  const meaningful = errors.filter((m) =>
    !m.includes('Failed to load resource') &&
    !m.includes('Failed to poll session') &&
    !m.includes('Missing X-API-Key') &&
    !m.toLowerCase().includes('cors'),
  );
  expect(meaningful, `Unexpected console errors:\n${meaningful.join('\n')}`).toHaveLength(0);
});

test('rust engine: two independent contexts on the same seed produce identical state hashes', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const [a, b] = await Promise.all([
      bootScenario(ctxA, STATIC_SCENARIO),
      bootScenario(ctxB, STATIC_SCENARIO),
    ]);

    // Let both worlds advance the same amount.
    await Promise.all([a.page.waitForTimeout(15_000), b.page.waitForTimeout(15_000)]);

    const [hA, hB] = await Promise.all([readStateHash(a.page), readStateHash(b.page)]);

    // If the debug bridge isn't wired up yet, skip with a clear note —
    // the game's runtime hasn't exposed __bbDebug.getStateHash. The
    // smoke test above still validates that the engine runs.
    test.skip(
      hA === null || hB === null,
      'window.__bbDebug.getStateHash() not exposed — wire the debug bridge to enable cross-context determinism check',
    );

    expect(hA).toBe(hB);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
