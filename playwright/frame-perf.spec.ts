// Frame-rate diagnostic harness.
//
// Boots the game with AI bots (so there's actual physics + rendering load),
// drives synthetic keyboard input on the host player to add input churn,
// and samples `__bbDebug.getFrameProfile()` every second for 60 seconds.
// At the end the full window is dumped to `test-results/frame-perf.json`
// so Claude / the dev can analyze and identify the bottleneck.

import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_DIR = resolve(__dirname, '../test-results');
const OUTPUT_FILE = resolve(OUTPUT_DIR, 'frame-perf.json');

interface FrameSample {
  ts: number;
  frameMs: number;
  logicMs: number;
  renderMs: number;
  logicSteps: number;
}

interface Window_bbDebug {
  __bbDebug?: {
    getFrameProfile: () => FrameSample[];
    resetFrameProfile: () => void;
    getTick: () => number;
  };
}

test.setTimeout(120_000);

test('60-second framerate diagnostic with AI bots', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // Boot the game offline with AI bots so we have realistic physics +
  // rendering load without needing the multiplayer infrastructure.
  await page.goto('/game?engine=rust&offline=1&ai=chaser,fleer,wanderer,bouncer&seed=1337');
  await expect(page.getByTestId('add-bot')).toBeVisible({ timeout: 30_000 });

  // Give the game a couple seconds to settle into the run state.
  await page.waitForTimeout(2_000);

  // Reset the frame profile ring at session start so our samples cover
  // only the period of interest.
  await page.evaluate(() => {
    const w = window as unknown as Window_bbDebug;
    w.__bbDebug?.resetFrameProfile();
  });

  // Drive synthetic keyboard input on the host player periodically so the
  // sim sees real input load (not just AI-only steady-state). Press W/A/S/D
  // in a 4-direction loop with occasional spacebar (expand) presses.
  const keySequence = ['KeyD', 'KeyS', 'KeyA', 'KeyW'];
  let keyIdx = 0;
  const keyInterval = setInterval(async () => {
    try {
      const code = keySequence[keyIdx % keySequence.length];
      keyIdx++;
      await page.keyboard.down(code);
      await page.waitForTimeout(150);
      await page.keyboard.up(code);
      if (keyIdx % 6 === 0) {
        await page.keyboard.down('Space');
        await page.waitForTimeout(80);
        await page.keyboard.up('Space');
      }
    } catch { /* page might be closing */ }
  }, 350);

  // Sample-collection loop — every second, snapshot frame stats and log
  // a summary so we can watch progress in test output.
  const perSecondSummaries: Array<{
    second: number;
    avgFrameMs: number;
    avgLogicMs: number;
    avgRenderMs: number;
    fps: number;
    sampleCount: number;
    p95FrameMs: number;
  }> = [];

  const TOTAL_SECONDS = 60;
  for (let s = 1; s <= TOTAL_SECONDS; s++) {
    await page.waitForTimeout(1_000);
    const snapshot = await page.evaluate(() => {
      const w = window as unknown as Window_bbDebug;
      const profile = w.__bbDebug?.getFrameProfile() ?? [];
      // Take only frames from the past second (timestamp window).
      const now = performance.now();
      const recent = profile.filter(f => f.ts >= now - 1100);
      return { recent };
    });
    const recent = snapshot.recent;
    if (recent.length === 0) {
      perSecondSummaries.push({ second: s, avgFrameMs: 0, avgLogicMs: 0, avgRenderMs: 0, fps: 0, sampleCount: 0, p95FrameMs: 0 });
      continue;
    }
    const avgFrameMs = recent.reduce((a, f) => a + f.frameMs, 0) / recent.length;
    const avgLogicMs = recent.reduce((a, f) => a + f.logicMs, 0) / recent.length;
    const avgRenderMs = recent.reduce((a, f) => a + f.renderMs, 0) / recent.length;
    const sorted = recent.map(f => f.frameMs).sort((a, b) => a - b);
    const p95FrameMs = sorted[Math.floor(sorted.length * 0.95)] ?? avgFrameMs;
    const fps = recent.length;
    perSecondSummaries.push({ second: s, avgFrameMs, avgLogicMs, avgRenderMs, fps, sampleCount: recent.length, p95FrameMs });
    console.log(
      `[s=${String(s).padStart(2, '0')}] fps=${fps.toString().padStart(3)} ` +
      `frame=${avgFrameMs.toFixed(1).padStart(5)}ms ` +
      `logic=${avgLogicMs.toFixed(2).padStart(5)}ms ` +
      `render=${avgRenderMs.toFixed(2).padStart(5)}ms ` +
      `p95=${p95FrameMs.toFixed(1).padStart(5)}ms`,
    );
  }

  clearInterval(keyInterval);

  // Pull the full frame profile one more time for the dump.
  const fullProfile = await page.evaluate(() => {
    const w = window as unknown as Window_bbDebug;
    return w.__bbDebug?.getFrameProfile() ?? [];
  });

  const report = {
    capturedAt: new Date().toISOString(),
    totalSeconds: TOTAL_SECONDS,
    perSecondSummaries,
    fullFrameSampleCount: fullProfile.length,
    fullProfile: fullProfile.slice(-600), // last ~10s at 60fps
    consoleErrors: consoleErrors.slice(0, 20),
  };
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`\nfull report written to ${OUTPUT_FILE}`);

  // Soft assertion — we don't fail the test on a low fps (that's what we're
  // diagnosing!) but we do flag console errors.
  const meaningful = consoleErrors.filter(m =>
    !m.includes('Failed to load resource') &&
    !m.includes('Failed to poll session') &&
    !m.toLowerCase().includes('cors'),
  );
  expect(meaningful, `Unexpected console errors:\n${meaningful.join('\n')}`).toHaveLength(0);
});
