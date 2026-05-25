import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { trackErrors } from "./lobby-helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Snap-diagnostic harness. Drives a two-browser session, has the guest
 * jump around for ~60 s, and dumps the guest's `window.__bbDebug.lastSnaps()`
 * to `playwright/output/snap-log.json` for the agent to read back.
 *
 * Not a pass/fail test in the traditional sense — its job is to capture
 * raw drift data so we can decide whether residual snaps are sub-pixel
 * noise (harmless) or large state-divergence (a real bug to chase).
 */

interface DebugBridge {
  getPlayerPos: (id: string) => { x: number; y: number } | null;
  getAllPlayerPositions: () => Record<string, { x: number; y: number }>;
  getTick: () => number;
  getNetDiag: () => { bufferSize: number; latestHostTick: number; gap: number } | null;
  lastSnaps: () => Array<{ tick: number; playerId: string; dist: number; dx: number; dy: number; at: number }>;
}

async function startHostingLite(page: Page): Promise<{ joinCode: string }> {
  await page.goto("/game");
  await expect(page.getByTestId("join-code")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("toggle-public")).toBeVisible();
  const joinCode = (await page.getByTestId("join-code").textContent()) ?? "";
  expect(joinCode).toMatch(/^[A-Z0-9]{4,}$/);
  return { joinCode };
}

async function readSnaps(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { __bbDebug?: DebugBridge }).__bbDebug?.lastSnaps() ?? [],
  );
}

async function readAllPositions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(() =>
    (window as unknown as { __bbDebug?: DebugBridge }).__bbDebug?.getAllPlayerPositions() ?? {},
  );
}

async function readTick(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { __bbDebug?: DebugBridge }).__bbDebug?.getTick() ?? 0,
  );
}

test("Capture snap diagnostic during ~60 s of jumping", async ({ browser }) => {
  test.setTimeout(180_000);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  trackErrors(pageA);
  trackErrors(pageB);

  // Host on A, flip public so B can find it.
  const { joinCode } = await startHostingLite(pageA);
  await pageA.getByTestId("toggle-public").click();
  await expect(pageA.getByTestId("toggle-public")).toContainText("Public");

  // Browse + join on B.
  await pageB.goto("/lobbies");
  await expect(pageB.getByTestId(`lobby-row-${joinCode}`)).toBeVisible({ timeout: 15_000 });
  await pageB.evaluate(() => {
    (window as unknown as { prompt: (msg?: string) => string }).prompt = () => "Guest";
  });
  await pageB
    .getByTestId(`lobby-row-${joinCode}`)
    .getByRole("button", { name: /Join/ })
    .click();
  await expect(pageB).toHaveURL(/\/online-guest/);

  // Host: click "Join" to spawn the host's own blob too (so we have two players).
  // The lobby panel exposes a join button as data-testid "join-local-player".
  const hostJoin = pageA.getByRole("button", { name: /Join the lobby!/ }).first();
  if (await hostJoin.isVisible().catch(() => false)) {
    await hostJoin.click();
  }

  // Wait for the debug bridge + both players visible on both sides.
  await expect.poll(
    async () => Object.keys(await readAllPositions(pageA)).length,
    { timeout: 90_000, message: "host should see at least one player blob" },
  ).toBeGreaterThanOrEqual(1);
  await expect.poll(
    async () => Object.keys(await readAllPositions(pageB)).length,
    { timeout: 90_000, message: "guest should see at least one player blob" },
  ).toBeGreaterThanOrEqual(1);

  // Focus the guest's canvas so keyboard input is captured.
  await pageB.locator("body").click();

  console.log("[snap-diag] Both clients ready. Starting jump loop...");

  // Jump-around loop. Holds a horizontal direction, taps space every ~250 ms.
  // Alternates left/right every 5 s.
  const totalSec = 60;
  const startMs = Date.now();
  let direction: "KeyA" | "KeyD" = "KeyD";
  await pageB.keyboard.down(direction);
  let lastDirSwap = startMs;

  while ((Date.now() - startMs) / 1000 < totalSec) {
    await pageB.keyboard.down("Space");
    await pageB.waitForTimeout(80);
    await pageB.keyboard.up("Space");
    await pageB.waitForTimeout(180);

    if (Date.now() - lastDirSwap > 5_000) {
      await pageB.keyboard.up(direction);
      direction = direction === "KeyD" ? "KeyA" : "KeyD";
      await pageB.keyboard.down(direction);
      lastDirSwap = Date.now();
    }
  }
  await pageB.keyboard.up(direction);
  await pageB.waitForTimeout(500);

  // Pull the diagnostic data off the guest.
  const snaps = await readSnaps(pageB);
  const hostTick = await readTick(pageA);
  const guestTick = await readTick(pageB);
  const aPos = await readAllPositions(pageA);
  const bPos = await readAllPositions(pageB);

  // Per-player snap stats.
  const byPlayer = new Map<string, { dist: number[]; dx: number[]; dy: number[]; ticks: number[] }>();
  for (const s of snaps) {
    let acc = byPlayer.get(s.playerId);
    if (!acc) {
      acc = { dist: [], dx: [], dy: [], ticks: [] };
      byPlayer.set(s.playerId, acc);
    }
    acc.dist.push(s.dist);
    acc.dx.push(s.dx);
    acc.dy.push(s.dy);
    acc.ticks.push(s.tick);
  }
  const summary: Record<string, unknown> = {};
  for (const [pid, acc] of byPlayer) {
    const sorted = [...acc.dist].sort((a, b) => a - b);
    summary[pid] = {
      count: acc.dist.length,
      avg_dist: acc.dist.reduce((a, b) => a + b, 0) / acc.dist.length,
      max_dist: Math.max(...acc.dist),
      median_dist: sorted[Math.floor(sorted.length / 2)],
      p90_dist: sorted[Math.floor(sorted.length * 0.9)],
      p99_dist: sorted[Math.floor(sorted.length * 0.99)],
      first_tick: acc.ticks[0],
      last_tick: acc.ticks[acc.ticks.length - 1],
      first_5: acc.dist.slice(0, 5),
      last_5: acc.dist.slice(-5),
      biggest_5: sorted.slice(-5),
    };
  }

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const out = {
    runAt: new Date().toISOString(),
    totalDurationSec: totalSec,
    hostTick,
    guestTick,
    tickGap: hostTick - guestTick,
    hostPositions: aPos,
    guestPositions: bPos,
    summary,
    rawSnaps: snaps,
  };
  fs.writeFileSync(path.join(outDir, "snap-log.json"), JSON.stringify(out, null, 2));
  console.log(`[snap-diag] Wrote ${snaps.length} snap entries to playwright/output/snap-log.json`);
  console.log(`[snap-diag] Summary: ${JSON.stringify(summary, null, 2)}`);

  await ctxA.close();
  await ctxB.close();
});
