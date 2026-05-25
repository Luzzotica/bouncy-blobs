// Smoke test for src/physics/rope-test.html.
//
// Loads the page, waits a bit for wasm + setup + a few RAFs, asserts the
// page produced no console errors and that all four scene legends show a
// non-zero tick (i.e. each world's RAF loop is actually running).

import { test, expect } from '@playwright/test';

test('rope-test page boots all 4 scenes without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto('/src/physics/rope-test.html');

  // Give wasm + RAF a couple of seconds to advance the sim.
  await page.waitForTimeout(2_500);

  // Every legend should report a non-zero tick (`tick N · particles M`).
  for (const id of ['l1', 'l2', 'l3', 'l4']) {
    const txt = (await page.locator('#' + id).textContent()) ?? '';
    expect(txt, `scene ${id} legend`).toMatch(/^tick \d+ · particles \d+$/);
    const tick = Number(txt.match(/^tick (\d+)/)?.[1] ?? '0');
    expect(tick, `scene ${id} did not advance`).toBeGreaterThan(10);
  }

  const meaningful = errors.filter((m) =>
    !m.includes('Failed to load resource') &&
    !m.includes('Failed to poll session') &&
    !m.toLowerCase().includes('cors'),
  );
  expect(meaningful, `Unexpected console errors:\n${meaningful.join('\n')}`).toHaveLength(0);
});
