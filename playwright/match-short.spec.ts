import { test } from '@playwright/test';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve relative to *this* file so the output dir doesn't depend on
// Playwright's rootDir guess (which is the playwright/ folder itself).
const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = join(HERE, 'output');

/**
 * Portrait match recording for the match-shorts pipeline.
 *
 * Like ai-content.spec.ts but:
 *  - runs under the `shorts` Playwright project (1080×1920 native 9:16),
 *  - dumps the in-game match event log (window.__bbDebug.getMatchEvents())
 *    to events.json so the highlight picker can score time windows,
 *  - records `closedAt` (performance.now() seconds just before page.close())
 *    so video time can be reconstructed: videoTime(e) = e.t + (D − closedAt)
 *    where D = ffprobe duration of match.webm,
 *  - ends a few seconds after the `win` event instead of always running the
 *    full MATCH_SECONDS.
 *
 * Run with:
 *   npm run record:short
 *   AI_LINEUP=goal_seeker,goal_seeker,chaser,bouncer LEVEL=classic MATCH_SECONDS=180 npm run record:short
 *
 * Output:
 *   playwright/output/short-<timestamp>-<level>-<lineup>/
 *     ├── match.webm    (1080×1920 Playwright video)
 *     ├── events.json   ({ closedAt, events: [...] })
 *     ├── final.png
 *     └── manifest.json
 */

// Default lineup needs goal_seekers: they're the only personalities that
// pursue the mode objective; without them races/hill fights never resolve
// and matches end as null-winner time-outs — dead content.
const LINEUP = (process.env.AI_LINEUP ?? 'goal_seeker,goal_seeker,chaser,bouncer')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Upper bound — the recording ends early once a winner is decided.
const MATCH_SECONDS = Number(process.env.MATCH_SECONDS ?? 180);
const WIN_LINGER_SECONDS = 4;

test('record portrait AI match for shorts', async ({ page }) => {
  test.setTimeout((MATCH_SECONDS + 90) * 1000);

  // classic (race) guarantees a NAMED winner: first to the goal zone, or
  // furthest-right at the 120 s time limit. KOTH bots currently struggle to
  // hold the hill, which yields null-winner "Time's up!" endings.
  const level = process.env.LEVEL ?? 'classic';
  const mode = process.env.MODE ?? '';
  // spectate=1 → single-blob spectator camera (tight follow + auto cuts);
  // shorts=1 kept as the fallback wide framing (see bouncyBlobsGame.ts).
  const params = new URLSearchParams({
    offline: '1',
    ai: LINEUP.join(','),
    level,
    shorts: '1',
    spectate: '1',
  });
  if (mode) params.set('mode', mode);
  await page.goto(`/game?${params.toString()}`);

  // Wait until the bots are spawned so the video starts on a populated lobby.
  await page.waitForSelector('[data-testid="add-bot"]', { timeout: 30_000 });
  for (const personality of LINEUP) {
    await page.waitForSelector(`[data-testid="bot-chip-${personality}"]`, { timeout: 10_000 });
  }

  // Hide all DOM chrome (lobby panel, buttons, chips) — the HUD the short
  // needs (timer, scoreboard) is drawn INSIDE the canvas, so blanket-hiding
  // DOM and re-showing the canvas leaves pure gameplay on screen.
  await page.addStyleTag({
    content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }',
  });

  // Poll for the win event; bail out at MATCH_SECONDS regardless.
  const deadline = Date.now() + MATCH_SECONDS * 1000;
  let won = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    won = await page.evaluate(() => {
      const dbg = (window as unknown as { __bbDebug?: { getMatchEvents: () => Array<{ type: string }> } }).__bbDebug;
      return dbg?.getMatchEvents().some((e) => e.type === 'win') ?? false;
    });
    if (won) break;
  }
  if (won) await page.waitForTimeout(WIN_LINGER_SECONDS * 1000);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(OUTPUT_ROOT, `short-${stamp}-${level}-${LINEUP.join('_')}`);
  await mkdir(outDir, { recursive: true });

  await page.screenshot({ path: join(outDir, 'final.png'), fullPage: false });

  // Pull the event log + the page clock in ONE evaluate so closedAt is read
  // on the same JS turn as the events — the gap to the actual page.close()
  // (and thus video end) is then just the teardown below, ~constant.
  const { events, closedAt } = await page.evaluate(() => {
    const dbg = (window as unknown as {
      __bbDebug?: { getMatchEvents: () => unknown[]; now: () => number };
    }).__bbDebug;
    return {
      events: dbg?.getMatchEvents() ?? [],
      closedAt: dbg?.now() ?? 0,
    };
  });
  await writeFile(join(outDir, 'events.json'), JSON.stringify({ closedAt, events }, null, 2));

  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify(
      {
        lineup: LINEUP,
        level,
        mode: mode || null,
        maxDurationSeconds: MATCH_SECONDS,
        endedOnWin: won,
        recordedAt: stamp,
        viewport: { width: 1080, height: 1920 },
      },
      null,
      2,
    ),
  );

  // The video path is only available after page.close().
  const videoSrc = await page.video()?.path();
  await page.close();
  if (videoSrc) {
    await copyFile(videoSrc, join(outDir, 'match.webm'));
  }

  console.log(`\n📼 Recorded short source → ${outDir}\n`);
});
