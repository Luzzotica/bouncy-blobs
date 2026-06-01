import { test, expect, type Page } from "@playwright/test";
import { startHosting } from "./lobby-helpers";

/**
 * Cross-tab determinism reproducer.
 *
 * Reproduces the symptom seen in the compare-hashes debug modal during real
 * play: even when host + guest exchange RNG + manager_state + full engine
 * keyframes, the two wasm instances drift between keyframes — NPCs the guest
 * never touches end up with different positions/velocities, etc.
 *
 * Unlike `sim-exactness.spec.ts` (which samples one hash per tab at whatever
 * tick each tab happens to be on), this test pulls the per-tick hash RING
 * from both sides (the same data path the debug modal uses via
 * `__bbDebug.compareHashes()`), then asserts every OVERLAPPING tick agrees.
 * Mismatches at overlapping ticks are a strict-determinism failure regardless
 * of how many ticks ahead one side is.
 *
 * Requires VITE_PARTY_API_URL pointing at a live matchmaking server.
 */

test.describe.configure({ mode: "serial" });

// Keep the play window short: keyframes are every 15 ticks (250ms),
// and we want the 60-tick hash ring to span at least one keyframe
// boundary so we can see whether tick K+1 (immediately post-restore)
// agrees with the host. Long play windows just push the ring past
// every keyframe and we lose the bisect signal.
const INPUT_BURST_MS = 1500;
const POST_INPUT_SETTLE_MS = 300;

interface CompareEntry {
  tick: number;
  hashes: Record<string, { hash: string | null }>;
}
interface CompareResult {
  peerIds: string[];
  byTick: CompareEntry[];
}

async function driveKeyboardBurst(page: Page, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  const keys = ["KeyA", "KeyD", "KeyW", "KeyS"];
  let i = 0;
  while (Date.now() < deadline) {
    const k = keys[i++ % keys.length];
    await page.keyboard.down(k);
    await page.waitForTimeout(60);
    await page.keyboard.up(k);
    if (i % 4 === 0) {
      await page.keyboard.down("Space");
      await page.waitForTimeout(40);
      await page.keyboard.up("Space");
    }
    await page.waitForTimeout(40);
  }
}

test("Host and guest hash rings agree at every overlapping tick", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Forward console output from both tabs — invaluable for triaging failures.
  pageA.on("console", (m) => console.log(`[host] ${m.type()}: ${m.text()}`));
  pageB.on("console", (m) => console.log(`[guest] ${m.type()}: ${m.text()}`));
  pageA.on("pageerror", (e) => console.log(`[host] PAGEERROR: ${e.message}`));
  pageB.on("pageerror", (e) => console.log(`[guest] PAGEERROR: ${e.message}`));
  pageA.on("requestfailed", (r) => console.log(`[host] REQFAIL: ${r.url()} ${r.failure()?.errorText}`));
  pageA.on("response", async (r) => {
    if (r.status() >= 400 && r.url().includes(":3000")) {
      console.log(`[host] HTTP ${r.status()} ${r.url()}`);
    }
  });

  // ── Host setup ────────────────────────────────────────────────────────
  const { lobbyCode } = await startHosting(pageA);
  await pageA.getByTestId("toggle-public").click();

  // ── Guest joins ──────────────────────────────────────────────────────
  await pageB.goto("/lobbies");
  // Display name is required before the Join button will commit (no
  // window.prompt — it's a controlled input on the page).
  await pageB.getByTestId("lobby-display-name").fill("DetermGuest");
  await expect(pageB.getByTestId(`lobby-row-${lobbyCode}`)).toBeVisible({ timeout: 15_000 });
  await pageB.getByTestId(`lobby-row-${lobbyCode}`).getByRole("button", { name: /Join/ }).click();
  await expect(pageB).toHaveURL(/\/online-guest/);
  // Wait for the guest sim to be live: the debug bridge gets installed
  // once `game.start()` runs, and `getStateHash()` returns non-empty
  // once the Rust engine has stepped at least once.
  await expect
    .poll(
      async () =>
        await pageB.evaluate(() => {
          const dbg = (window as unknown as { __bbDebug?: { getStateHash: () => string | null } }).__bbDebug;
          return dbg?.getStateHash() ?? "";
        }),
      { timeout: 60_000, intervals: [500, 1000] },
    )
    .not.toBe("");
  // Guest auto-joins as a local player via useEffect once connected +
  // level loaded — no explicit toggle. Wait for the local player's
  // blob to appear in the playerManager before driving input.
  await expect
    .poll(
      async () =>
        await pageB.evaluate(() => {
          const dbg = (window as unknown as {
            __bbDebug?: { getAllPlayerPositions: () => Record<string, unknown> };
          }).__bbDebug;
          return Object.keys(dbg?.getAllPlayerPositions() ?? {}).length;
        }),
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toBeGreaterThan(0);
  // Focus the guest page so keyboard input WOULD be captured by the
  // canvas — but we no longer drive keyboard input in this test. With
  // PacingConfig.enableRollback = false (the default), any guest input
  // that arrives at the host after the host has passed the tagged tick
  // gets silently dropped, which guarantees host/guest divergence as
  // soon as Playwright's keyboard timing produces a single late event.
  // Strict lockstep without input variance is the right test for "is
  // the engine + netcode pipeline deterministic" — and the next test
  // in this file (with ?keyframe=0) exercises a longer pure-physics
  // run via the same path.
  await pageB.locator("body").click();
  await pageB.waitForTimeout(INPUT_BURST_MS + POST_INPUT_SETTLE_MS);

  // ── Pause both sides, then ask host to gather hashes ─────────────────
  // togglePause(true) on the host mirrors to the guest via set_paused so
  // both sims freeze. compareHashes() then ships request_hashes and waits
  // for the guest's hashes_response.
  const result = (await pageA.evaluate(async () => {
    const dbg = (window as unknown as {
      __bbDebug?: {
        togglePause: (paused: boolean) => void;
        compareHashes: () => Promise<unknown>;
      };
    }).__bbDebug;
    if (!dbg) return null;
    dbg.togglePause(true);
    // Give set_paused a moment to land on the guest before the compare
    // request races behind it on the same channel.
    await new Promise((r) => setTimeout(r, 200));
    return (await dbg.compareHashes()) as unknown;
  })) as CompareResult | null;

  expect(result, "host __bbDebug.compareHashes() returned null").not.toBeNull();
  const peers = result!.peerIds;
  console.log(`peers in result: ${peers.join(", ")}`);
  expect(peers, "guest did not appear in compare result").toContain(
    peers.find((p) => p !== "host") ?? "__no_guest__",
  );
  const guestId = peers.find((p) => p !== "host");
  expect(guestId, "no non-host peer in compare result").toBeTruthy();

  // ── Find overlapping ticks ───────────────────────────────────────────
  const overlapping = result!.byTick.filter(
    (e) => e.hashes.host?.hash && e.hashes[guestId!]?.hash,
  );
  console.log(`overlapping ticks: ${overlapping.length}`);
  expect(
    overlapping.length,
    "no overlapping ticks between host + guest rings — speculation cap or pacing is broken",
  ).toBeGreaterThan(0);

  // ── Diagnostic dump (truncated) ──────────────────────────────────────
  const sample = overlapping.slice(0, 20);
  for (const e of sample) {
    const h = e.hashes.host.hash!;
    const g = e.hashes[guestId!].hash!;
    const ok = h === g;
    console.log(`tick ${e.tick}: host=${h.slice(0, 12)} guest=${g.slice(0, 12)} ${ok ? "OK" : "DESYNC"}`);
  }
  const mismatched = overlapping.filter((e) => e.hashes.host.hash !== e.hashes[guestId!].hash);
  console.log(`mismatched overlapping ticks: ${mismatched.length}/${overlapping.length}`);

  // ── End-of-test live state agreement ─────────────────────────────────
  // Both sims are paused. Re-step both manually for a few ticks (via
  // togglePause + brief wait + re-pause), then read each side's CURRENT
  // engine state hash. The historical ring may carry stale pre-rollback
  // values due to recordHash timing, but the LIVE state should agree
  // exactly if engines + netcode are deterministic.
  const livePair = await pageA.evaluate(async () => {
    const dbg = (window as unknown as { __bbDebug?: { getStateHash: () => string | null; getTick: () => number } }).__bbDebug;
    return { tick: dbg?.getTick() ?? -1, hash: dbg?.getStateHash() ?? '' };
  });
  const liveGuest = await pageB.evaluate(async () => {
    const dbg = (window as unknown as { __bbDebug?: { getStateHash: () => string | null; getTick: () => number } }).__bbDebug;
    return { tick: dbg?.getTick() ?? -1, hash: dbg?.getStateHash() ?? '' };
  });
  console.log(`live host: tick=${livePair.tick} hash=${livePair.hash}`);
  console.log(`live guest: tick=${liveGuest.tick} hash=${liveGuest.hash}`);
  // If ticks happen to align AND hashes match, the engines are
  // in lockstep agreement at the end of the test.

  // ── The assertion ────────────────────────────────────────────────────
  // Strict determinism: every overlapping tick must agree. Any drift here
  // is the production bug.
  expect(
    mismatched.length,
    `${mismatched.length}/${overlapping.length} overlapping ticks disagree (first diverging: tick=${mismatched[0]?.tick})`,
  ).toBe(0);

  await ctxA.close();
  await ctxB.close();
});

/**
 * Stronger sibling test: prove the engine is cross-tab deterministic
 * with NO mid-sim resync. `?keyframe=0` disables periodic keyframes
 * AND (via the same flag) host-side rollback and guest-side rollback.
 * Only the on-peer-connect bootstrap keyframe fires — after that, the
 * sim relies purely on lockstep input replay through the deterministic
 * Rust engine.
 *
 * Any failure here is REAL per-tick non-determinism: a JS call site
 * that feeds the wasm engine a value that differs between two browser
 * tabs (e.g. `Math.atan2`, `Math.exp`, `Math.cos/sin` on inputs the
 * spec defines as implementation-dependent), or a missing field in
 * the snapshot, or an engine code path that escapes i64 arithmetic
 * into f64 land. The previous "with keyframes" test masks all of
 * this; this test surfaces it.
 */
test("Host and guest stay deterministic with NO mid-sim keyframes", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  pageA.on("console", (m) => console.log(`[host] ${m.type()}: ${m.text()}`));
  pageB.on("console", (m) => console.log(`[guest] ${m.type()}: ${m.text()}`));

  // ?keyframe=0 disables periodic keyframes, host rollback, AND guest
  // rollback (via the shared allowRollback gate). Only the on-connect
  // bootstrap keyframe fires.
  const { lobbyCode } = await startHosting(pageA, { keyframe: '0', level: 'det-test' });
  await pageA.getByTestId("toggle-public").click();

  await pageB.goto("/lobbies");
  await pageB.getByTestId("lobby-display-name").fill("DetermGuest");
  await expect(pageB.getByTestId(`lobby-row-${lobbyCode}`)).toBeVisible({ timeout: 15_000 });
  await pageB.getByTestId(`lobby-row-${lobbyCode}`).getByRole("button", { name: /Join/ }).click();
  await expect(pageB).toHaveURL(/\/online-guest/);
  await expect
    .poll(
      async () =>
        await pageB.evaluate(() => {
          const dbg = (window as unknown as { __bbDebug?: { getStateHash: () => string | null } }).__bbDebug;
          return dbg?.getStateHash() ?? "";
        }),
      { timeout: 60_000, intervals: [500, 1000] },
    )
    .not.toBe("");
  await expect
    .poll(
      async () =>
        await pageB.evaluate(() => {
          const dbg = (window as unknown as {
            __bbDebug?: { getAllPlayerPositions: () => Record<string, unknown> };
          }).__bbDebug;
          return Object.keys(dbg?.getAllPlayerPositions() ?? {}).length;
        }),
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toBeGreaterThan(0);
  await pageB.locator("body").click();

  await driveKeyboardBurst(pageB, INPUT_BURST_MS);
  await pageA.waitForTimeout(POST_INPUT_SETTLE_MS);

  const result = (await pageA.evaluate(async () => {
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
  const guestId = result!.peerIds.find((p) => p !== "host");
  expect(guestId, "no guest peer in result").toBeTruthy();

  const overlapping = result!.byTick.filter(
    (e) => e.hashes.host?.hash && e.hashes[guestId!]?.hash,
  );
  expect(overlapping.length, "no overlapping ticks").toBeGreaterThan(0);

  const mismatched = overlapping.filter((e) => e.hashes.host.hash !== e.hashes[guestId!].hash);
  console.log(`no-keyframe test: ${overlapping.length - mismatched.length}/${overlapping.length} overlapping ticks agree`);
  expect(
    mismatched.length,
    `engine is not cross-tab deterministic without keyframes: ${mismatched.length}/${overlapping.length} disagree (first: tick ${mismatched[0]?.tick})`,
  ).toBe(0);

  await ctxA.close();
  await ctxB.close();
});
