import { test } from '@playwright/test';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = join(HERE, 'output');

/**
 * Records a clip of two chained blobs drifting around the team-racing level
 * so we can see the rope: drape over geometry, slack catenary, pull-back at
 * full extension.
 *
 *   npm exec -- playwright test chain-demo
 *
 * Env overrides:
 *   AI_LINEUP=chaser,chaser   (default — two chaser bots, predictable motion)
 *   MATCH_SECONDS=45          (default 45 — long enough to see slack + taut)
 *   LEVEL=chained             (default — the chain mode level)
 */
const LINEUP = (process.env.AI_LINEUP ?? 'chaser,chaser')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MATCH_SECONDS = Number(process.env.MATCH_SECONDS ?? 45);
const LEVEL = process.env.LEVEL ?? 'chained';

test('record chained-mode rope behavior', async ({ page }) => {
  test.setTimeout((MATCH_SECONDS + 60) * 1000);

  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[chain]')) console.log(t);
  });

  const params = new URLSearchParams({
    offline: '1',
    ai: LINEUP.join(','),
    level: LEVEL,
    mode: 'team_racing',
  });
  await page.goto(`/game?${params.toString()}`);

  // Wait for lobby to populate so the recording opens on the spawned bots.
  await page.waitForSelector('[data-testid="add-bot"]', { timeout: 30_000 });
  for (const personality of LINEUP) {
    await page.waitForSelector(`[data-testid="bot-chip-${personality}"]`, { timeout: 10_000 });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(OUTPUT_ROOT, `chain-demo-${stamp}-${LEVEL}-${LINEUP.join('_')}`);
  await mkdir(outDir, { recursive: true });

  // Snap one frame every 3s while the match runs so we end up with a
  // contact sheet of different chain states (slack, drape, taut, snap-back).
  const snapEverySec = 3;
  const snapCount = Math.floor(MATCH_SECONDS / snapEverySec);
  for (let i = 1; i <= snapCount; i++) {
    await page.waitForTimeout(snapEverySec * 1000);
    const elapsed = String(i * snapEverySec).padStart(3, '0');
    await page.screenshot({ path: join(outDir, `frame-${elapsed}s.png`), fullPage: false });
  }
  await page.screenshot({ path: join(outDir, 'final.png'), fullPage: false });

  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify(
      { lineup: LINEUP, level: LEVEL, mode: 'team_racing', durationSeconds: MATCH_SECONDS, recordedAt: stamp },
      null,
      2,
    ),
  );

  const videoSrc = await page.video()?.path();
  await page.close();
  if (videoSrc) {
    await copyFile(videoSrc, join(outDir, 'chain-demo.webm'));
  }

  console.log(`\n📼 Recorded chain demo → ${outDir}\n`);
});
