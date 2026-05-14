import { test } from '@playwright/test';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve relative to *this* file so the output dir doesn't depend on
// Playwright's rootDir guess (which is the playwright/ folder itself).
const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = join(HERE, 'output');

/**
 * Content recording: longer match with named bots, intended to be shared.
 *
 * Run with:
 *   npm run record:match
 *   # or, custom lineup:
 *   AI_LINEUP=chaser,bouncer,bouncer,fleer MATCH_SECONDS=120 npm run record:match
 *
 * Output:
 *   playwright/output/match-<timestamp>-<lineup>/
 *     ├── match.webm   (Playwright video)
 *     └── final.png    (last-frame screenshot)
 */

const LINEUP = (process.env.AI_LINEUP ?? 'chaser,fleer,wanderer,bouncer')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MATCH_SECONDS = Number(process.env.MATCH_SECONDS ?? 90);

test('record AI match for content', async ({ page }) => {
  test.setTimeout((MATCH_SECONDS + 60) * 1000);

  const lineupParam = encodeURIComponent(LINEUP.join(','));
  // Optional ?level= and ?mode= forwarded from env so you can pick the map.
  const level = process.env.LEVEL ?? 'koth';
  const mode = process.env.MODE ?? '';
  const params = new URLSearchParams({ offline: '1', ai: LINEUP.join(','), level });
  if (mode) params.set('mode', mode);
  void lineupParam; // (kept for clarity — params already encoded above)
  await page.goto(`/game?${params.toString()}`);

  // Wait until the bots are spawned so the visible video starts on a populated lobby.
  await page.waitForSelector('[data-testid="add-bot"]', { timeout: 30_000 });
  for (const personality of LINEUP) {
    await page.waitForSelector(`[data-testid="bot-chip-${personality}"]`, { timeout: 10_000 });
  }

  await page.waitForTimeout(MATCH_SECONDS * 1000);

  // Output dir per run.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(OUTPUT_ROOT, `match-${stamp}-${level}-${LINEUP.join('_')}`);
  await mkdir(outDir, { recursive: true });

  // Grab the final frame.
  await page.screenshot({ path: join(outDir, 'final.png'), fullPage: false });

  // Drop a tiny manifest so future-you can tell what each clip is.
  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify({ lineup: LINEUP, level, mode: mode || null, durationSeconds: MATCH_SECONDS, recordedAt: stamp }, null, 2),
  );

  // Playwright writes the video to test-results/<...>/video.webm after the test
  // finishes. The video path is only available after `page.close()`, so we
  // explicitly close and copy.
  const videoSrc = await page.video()?.path();
  await page.close();
  if (videoSrc) {
    await copyFile(videoSrc, join(outDir, 'match.webm'));
  }

  // Surface the path in test stdout so it's easy to find.
  console.log(`\n📼 Recorded match → ${outDir}\n`);
});
