import { test, expect, type Page, type Browser } from "@playwright/test";
import { startHosting } from "./lobby-helpers";

/**
 * Lobby → START GAME → bilateral-input determinism test.
 *
 * Companion to `cross-tab-determinism.spec.ts`, which only exercises the
 * playground phase (no game start, no input). This test specifically drives
 * the path the user is observing desync on:
 *
 *   1. Both host and guest join the lobby as players (host clicks "Play
 *      from laptop", guest joins via /lobbies).
 *   2. Host clicks the START GAME button → fires `startGameWithLevel` which
 *      tears down the playground game and stands up a fresh one.
 *   3. Both pages drive simultaneous WASD bursts (host AND guest moving).
 *   4. Pause both sims, compare host's hash ring against guest's at every
 *      overlapping tick.
 *
 * Any divergence here means the start-game bootstrap is NOT producing
 * bit-identical sims — likely either the keyframe is captured at a moment
 * when the two sides have different state, or the inputs from the two
 * players race in a way that produces different results on each side.
 */

const INPUT_BURST_MS = 1500;
const POST_INPUT_SETTLE_MS = 400;

interface CompareEntry {
  tick: number;
  hashes: Record<string, { hash: string | null }>;
}
interface CompareResult {
  peerIds: string[];
  byTick: CompareEntry[];
}

/** Drive a sustained key press on a page. Each page holds a SINGLE key
 * for the whole window so the resulting displacement is large and
 * unambiguous — if the test's `expect(moved > 10px)` fails, input
 * actually wasn't reaching the sim (vs. oscillating around the spawn
 * point and netting to ~0 displacement, which the prior alternating-key
 * pattern produced). Different keys per page so each side's blob moves
 * in a distinct direction. */
async function driveKeyboardBurst(page: Page, durationMs: number, seed = 0): Promise<void> {
  // Page 0 (host) holds D → moves right.
  // Page 1 (guest) holds A → moves left.
  // Both blobs end up far from their starting x and from each other.
  const key = seed % 2 === 0 ? "KeyD" : "KeyA";
  await page.keyboard.down(key);
  await page.waitForTimeout(durationMs);
  await page.keyboard.up(key);
}

async function setupHostInLobby(
  browser: Browser,
  urlParams?: Record<string, string>,
): Promise<{ ctx: import("@playwright/test").BrowserContext; page: Page; lobbyCode: string }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => console.log(`[host] ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[host] PAGEERROR: ${e.message}`));
  const { lobbyCode } = await startHosting(page, urlParams);
  await page.getByTestId("toggle-public").click();
  // Host joins as keyboard player so we can actually drive WASD on the
  // host page and have a blob to control.
  await page.getByTestId("local-player-toggle").click();
  return { ctx, page, lobbyCode };
}

async function joinGuest(
  browser: Browser,
  lobbyCode: string,
): Promise<{ ctx: import("@playwright/test").BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => console.log(`[guest] ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[guest] PAGEERROR: ${e.message}`));
  await page.goto("/lobbies");
  await page.getByTestId("lobby-display-name").fill("DetermGuest");
  await expect(page.getByTestId(`lobby-row-${lobbyCode}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`lobby-row-${lobbyCode}`).getByRole("button", { name: /Join/ }).click();
  await expect(page).toHaveURL(/\/online-guest/);
  return { ctx, page };
}

async function pollPlayerCount(page: Page, atLeast: number, timeoutMs: number): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        last = await page.evaluate(() => {
          const dbg = (window as unknown as {
            __bbDebug?: { getAllPlayerPositions?: () => Record<string, unknown> };
          }).__bbDebug;
          return Object.keys(dbg?.getAllPlayerPositions?.() ?? {}).length;
        });
        return last;
      },
      { timeout: timeoutMs, intervals: [50, 100, 200, 500] },
    )
    .toBeGreaterThanOrEqual(atLeast);
  return last;
}

async function compareRings(hostPage: Page, guestPage: Page): Promise<CompareResult> {
  const result = (await hostPage.evaluate(async () => {
    const dbg = (window as unknown as {
      __bbDebug?: {
        togglePause: (paused: boolean) => void;
        compareHashes: () => Promise<unknown>;
      };
    }).__bbDebug;
    if (!dbg) return null;
    dbg.togglePause(true);
    await new Promise((r) => setTimeout(r, 200));
    return (await dbg.compareHashes()) as unknown;
  })) as CompareResult | null;
  expect(result, "compareHashes returned null").not.toBeNull();
  // Touch the guest so the lint about unused params doesn't fire while
  // keeping the helper symmetric with future extensions.
  void guestPage;
  return result!;
}

for (const keyframeMode of ["default", "off"] as const) {
  test(`Host + guest stay deterministic across lobby → start → bilateral input (keyframe=${keyframeMode})`, async ({ browser }) => {
    test.setTimeout(180_000);
    const urlParams: Record<string, string> = { level: "det-test" };
    if (keyframeMode === "off") urlParams.keyframe = "0";

    // ── Setup ─────────────────────────────────────────────────────────
    const host = await setupHostInLobby(browser, urlParams);
    const guest = await joinGuest(browser, host.lobbyCode);

    // Both players should appear in the playground on the guest before
    // we kick off the real game.
    await pollPlayerCount(guest.page, 2, 20_000);

    // ── START GAME ───────────────────────────────────────────────────
    await host.page.getByTestId("start-game").click();
    // Wait for the new (playing-phase) sim to register both blobs on the guest.
    await pollPlayerCount(guest.page, 2, 5_000);

    // Wait for the countdown phase to finish on the HOST so subsequent
    // recordHash calls reflect post-step physics state, not the static
    // pre-physics countdown snapshot that `recordHash` overwrites tick=0
    // with on every onLogic call while the mode is in countdown. ClassicMode
    // countdown is 3s + 100ms setTimeout slack — wait for the host's tick
    // to advance past a handful of physics ticks before driving input.
    await expect
      .poll(
        async () =>
          await host.page.evaluate(() => {
            const dbg = (window as unknown as { __bbDebug?: { getTick: () => number } }).__bbDebug;
            return dbg?.getTick() ?? 0;
          }),
        { timeout: 15_000, intervals: [100, 250, 500] },
      )
      .toBeGreaterThan(30);

    // Focus both canvases so keyboard input is captured. Click body to
    // ensure document.activeElement isn't a stray button.
    await host.page.locator("body").click();
    await guest.page.locator("body").click();

    // ── Bilateral input + movement validation ────────────────────────
    // Capture starting positions, drive WASD on BOTH host and guest
    // concurrently, then verify each blob ACTUALLY MOVED on both pages.
    // Without this assertion, a regression that breaks input flow (gate
    // stalling, broadcasts not landing, etc.) wouldn't fail the test —
    // hashes would still match (both sims frozen identically) but the
    // user can't play.
    const captureStartingPositions = async (page: Page) =>
      await page.evaluate(() => {
        const dbg = (window as unknown as {
          __bbDebug?: { getAllPlayerPositions: () => Record<string, { x: number; y: number }> };
        }).__bbDebug;
        return dbg?.getAllPlayerPositions?.() ?? {};
      });

    const hostStartPositions = await captureStartingPositions(host.page);
    const guestStartPositions = await captureStartingPositions(guest.page);
    console.log(`hostStart: ${JSON.stringify(hostStartPositions)}`);
    console.log(`guestStart: ${JSON.stringify(guestStartPositions)}`);

    await Promise.all([
      driveKeyboardBurst(host.page, INPUT_BURST_MS, 0),
      driveKeyboardBurst(guest.page, INPUT_BURST_MS, 1),
    ]);
    await host.page.waitForTimeout(POST_INPUT_SETTLE_MS);

    // Read positions AFTER input + settle. Each player must have moved
    // a meaningful distance (>10 px) from its starting position. This
    // proves both the local-input apply path AND the lockstep
    // host-broadcast/guest-apply path actually work end-to-end.
    const hostEndPositions = await captureStartingPositions(host.page);
    const guestEndPositions = await captureStartingPositions(guest.page);
    const MOVED_THRESHOLD = 10;
    const dist = (a: { x: number; y: number } | undefined, b: { x: number; y: number } | undefined) =>
      a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    for (const pid of Object.keys(hostStartPositions)) {
      const d = dist(hostStartPositions[pid], hostEndPositions[pid]);
      console.log(`[${keyframeMode}] host  ${pid}: moved ${d.toFixed(1)} px`);
      expect(d, `host's view of ${pid} didn't move after input`).toBeGreaterThan(MOVED_THRESHOLD);
    }
    for (const pid of Object.keys(guestStartPositions)) {
      const d = dist(guestStartPositions[pid], guestEndPositions[pid]);
      console.log(`[${keyframeMode}] guest ${pid}: moved ${d.toFixed(1)} px`);
      expect(d, `guest's view of ${pid} didn't move after input`).toBeGreaterThan(MOVED_THRESHOLD);
    }

    // ── Compare hash rings ───────────────────────────────────────────
    const result = await compareRings(host.page, guest.page);
    const guestId = result.peerIds.find((p) => p !== "host");
    expect(guestId, "no non-host peer in compare result").toBeTruthy();

    const overlapping = result.byTick.filter(
      (e) => e.hashes.host?.hash && e.hashes[guestId!]?.hash,
    );
    console.log(
      `[keyframe=${keyframeMode}] overlapping ticks: ${overlapping.length}`,
    );
    expect(overlapping.length, "no overlapping ticks between host + guest rings").toBeGreaterThan(0);

    // Diagnostic dump of first divergence (truncated).
    const mismatched = overlapping.filter(
      (e) => e.hashes.host.hash !== e.hashes[guestId!].hash,
    );
    if (mismatched.length > 0) {
      console.log(`first divergence at tick=${mismatched[0].tick}`);
      const sample = overlapping.slice(0, 12);
      for (const e of sample) {
        const h = e.hashes.host.hash!;
        const g = e.hashes[guestId!].hash!;
        console.log(
          `tick ${e.tick}: host=${h.slice(0, 12)} guest=${g.slice(0, 12)} ${h === g ? "OK" : "DESYNC"}`,
        );
      }
    }

    // Also log the live state for an end-of-test sanity check.
    const liveHost = await host.page.evaluate(() => {
      const dbg = (window as unknown as {
        __bbDebug?: { getStateHash: () => string | null; getTick: () => number };
      }).__bbDebug;
      return { tick: dbg?.getTick() ?? -1, hash: dbg?.getStateHash() ?? "" };
    });
    const liveGuest = await guest.page.evaluate(() => {
      const dbg = (window as unknown as {
        __bbDebug?: { getStateHash: () => string | null; getTick: () => number };
      }).__bbDebug;
      return { tick: dbg?.getTick() ?? -1, hash: dbg?.getStateHash() ?? "" };
    });
    console.log(`live host: tick=${liveHost.tick} hash=${liveHost.hash}`);
    console.log(`live guest: tick=${liveGuest.tick} hash=${liveGuest.hash}`);

    expect(
      mismatched.length,
      `${mismatched.length}/${overlapping.length} overlapping ticks disagree (first: tick=${mismatched[0]?.tick})`,
    ).toBe(0);

    await host.ctx.close();
    await guest.ctx.close();
  });
}
