import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { startHosting } from "./lobby-helpers";

/**
 * NetPeer cross-tab determinism — real browsers, real WebRTC, ?netpeer=1.
 *
 * Validates the symmetric tick-tagged rollback netcode (NetPeer / BbNetSession)
 * end-to-end over actual WebRTC: host + guest both drive keyboard input (so
 * inputs flow both ways and the rollback path actually fires), then we pause
 * both sims and pull the per-tick hash RING from each via __bbDebug. With
 * correct tick-tagged input every input applies at the same absolute tick on
 * every peer, so EVERY overlapping tick must agree — any mismatch is a real
 * desync.
 *
 * The in-process gold-standard guard is src/lib/netcode/netcodeConvergence.test.ts
 * (deterministic, no browser). This is its real-WebRTC counterpart.
 *
 * Requires VITE_PARTY_API_URL pointing at a live matchmaking server + the dev
 * server running (same infra as cross-tab-determinism.spec.ts).
 */

test.describe.configure({ mode: "serial" });

const INPUT_BURST_MS = 2000;
const POST_INPUT_SETTLE_MS = 500;

interface CompareEntry { tick: number; hashes: Record<string, { hash: string | null }> }
interface CompareResult { peerIds: string[]; byTick: CompareEntry[] }

/** Enable the NetPeer path for every page in this context, before app scripts
 *  run — the guest reaches /online-guest via the Join button (no query string
 *  of our own), so the localStorage override is how both sides opt in. */
async function enableNetPeer(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    try { localStorage.setItem("netpeer", "1"); } catch { /* ignore */ }
  });
}

async function driveKeyboardBurst(page: Page, durationMs: number, seed: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  const keys = ["KeyA", "KeyD", "KeyW", "KeyS"];
  let i = seed;
  while (Date.now() < deadline) {
    const k = keys[i++ % keys.length];
    await page.keyboard.down(k);
    await page.waitForTimeout(50 + (i % 3) * 20);
    await page.keyboard.up(k);
    if (i % 5 === 0) {
      await page.keyboard.down("Space");
      await page.waitForTimeout(40);
      await page.keyboard.up("Space");
    }
    await page.waitForTimeout(30);
  }
}

test("NetPeer: host + guest hash rings agree at every overlapping tick", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await enableNetPeer(ctxA);
  await enableNetPeer(ctxB);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  pageA.on("console", (m) => console.log(`[host] ${m.type()}: ${m.text()}`));
  pageB.on("console", (m) => console.log(`[guest] ${m.type()}: ${m.text()}`));
  pageA.on("pageerror", (e) => console.log(`[host] PAGEERROR: ${e.message}`));
  pageB.on("pageerror", (e) => console.log(`[guest] PAGEERROR: ${e.message}`));

  // ── Host setup (also pass ?netpeer=1 on the URL for good measure) ──────
  const { lobbyCode } = await startHosting(pageA, { netpeer: "1" });
  await pageA.getByTestId("toggle-public").click();

  // ── Guest joins ───────────────────────────────────────────────────────
  await pageB.goto("/lobbies");
  await pageB.getByTestId("lobby-display-name").fill("NetPeerGuest");
  await expect(pageB.getByTestId(`lobby-row-${lobbyCode}`)).toBeVisible({ timeout: 15_000 });
  await pageB.getByTestId(`lobby-row-${lobbyCode}`).getByRole("button", { name: /Join/ }).click();
  await expect(pageB).toHaveURL(/\/online-guest/);

  // Wait for the guest sim to be live + its local blob to exist.
  await expect.poll(async () => pageB.evaluate(() => {
    const dbg = (window as unknown as { __bbDebug?: { getStateHash: () => string | null } }).__bbDebug;
    return dbg?.getStateHash() ?? "";
  }), { timeout: 60_000, intervals: [500, 1000] }).not.toBe("");
  await expect.poll(async () => pageB.evaluate(() => {
    const dbg = (window as unknown as { __bbDebug?: { getAllPlayerPositions: () => Record<string, unknown> } }).__bbDebug;
    return Object.keys(dbg?.getAllPlayerPositions() ?? {}).length;
  }), { timeout: 30_000, intervals: [500, 1000] }).toBeGreaterThan(0);

  // ── Drive input on BOTH sides so rollback fires both ways ──────────────
  await pageA.locator("body").click();
  await pageB.locator("body").click();
  await Promise.all([
    driveKeyboardBurst(pageA, INPUT_BURST_MS, 0),
    driveKeyboardBurst(pageB, INPUT_BURST_MS, 2),
  ]);
  await pageA.waitForTimeout(POST_INPUT_SETTLE_MS);

  // ── Pause both, gather hashes ─────────────────────────────────────────
  const result = (await pageA.evaluate(async () => {
    const dbg = (window as unknown as {
      __bbDebug?: { togglePause: (p: boolean) => void; compareHashes: () => Promise<unknown> };
    }).__bbDebug;
    if (!dbg) return null;
    dbg.togglePause(true);
    await new Promise((r) => setTimeout(r, 300)); // let set_paused + late inputs land
    return (await dbg.compareHashes()) as unknown;
  })) as CompareResult | null;

  expect(result, "host __bbDebug.compareHashes() returned null").not.toBeNull();
  const guestId = result!.peerIds.find((p) => p !== "host");
  expect(guestId, "no guest peer in compare result").toBeTruthy();

  const overlapping = result!.byTick.filter((e) => e.hashes.host?.hash && e.hashes[guestId!]?.hash);
  console.log(`overlapping ticks: ${overlapping.length}`);
  expect(overlapping.length, "no overlapping ticks — pacing/speculation broken").toBeGreaterThan(0);

  for (const e of overlapping.slice(0, 24)) {
    const h = e.hashes.host.hash!, g = e.hashes[guestId!].hash!;
    console.log(`tick ${e.tick}: host=${h.slice(0, 12)} guest=${g.slice(0, 12)} ${h === g ? "OK" : "DESYNC"}`);
  }
  const mismatched = overlapping.filter((e) => e.hashes.host.hash !== e.hashes[guestId!].hash);
  console.log(`mismatched: ${mismatched.length}/${overlapping.length}`);

  expect(
    mismatched.length,
    `${mismatched.length}/${overlapping.length} overlapping ticks disagree (first: tick=${mismatched[0]?.tick})`,
  ).toBe(0);

  await ctxA.close();
  await ctxB.close();
});
