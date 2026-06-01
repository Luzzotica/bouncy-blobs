import { test, expect, type Page } from "@playwright/test";
import { startHosting } from "./lobby-helpers";

/**
 * Two-tab simulation exactness e2e: host + guest tab both run a local sim.
 * After driving keyboard input on the guest tab for several seconds, the
 * two sims should produce IDENTICAL state hashes (the Rust+wasm engine
 * exposes a deterministic FNV-1a hash over every particle position +
 * velocity via `__bbDebug.getStateHash()`).
 *
 * Why this test exists: it catches the entire class of "host and guest
 * apply inputs at different ticks" bugs that show up as immediate desync
 * in real play. If this test passes, the netcode is sim-correct under
 * loopback conditions. If it fails, the failing pair of state hashes
 * is the entire bug report we need.
 *
 * NOTE: this test requires a live matchmaking server (VITE_PARTY_API_URL).
 * Mark it as serial to avoid contention if other lobby tests run in
 * parallel.
 */

test.describe.configure({ mode: "serial" });

const COMPARE_SAMPLES = 8;       // hash both tabs this many times across the run
const SAMPLE_INTERVAL_MS = 500;  // wait between samples
const INPUT_BURST_MS = 4000;     // total duration of keyboard activity on the guest

interface SampleResult {
  ts: number;
  hostHash: string;
  guestHash: string;
  hostTick: number;
  guestTick: number;
  match: boolean;
}

async function readSimState(page: Page): Promise<{ hash: string; tick: number } | null> {
  return await page.evaluate(() => {
    const dbg = (window as unknown as { __bbDebug?: { getStateHash: () => string | null; getTick: () => number } }).__bbDebug;
    if (!dbg) return null;
    return { hash: dbg.getStateHash() ?? "", tick: dbg.getTick() };
  });
}

async function driveKeyboardBurst(page: Page, durationMs: number): Promise<void> {
  // Alternate WASD presses + space taps to exercise as many input
  // transitions as possible — the exact pattern is irrelevant; what
  // matters is that the host and guest sims see them at the same tick.
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

test("Host and guest sims agree on state hash after scripted keyboard input", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // ── Host setup ────────────────────────────────────────────────────────
  const { lobbyCode } = await startHosting(pageA);
  await pageA.getByTestId("toggle-public").click();

  // ── Guest joins ──────────────────────────────────────────────────────
  await pageB.goto("/lobbies");
  await expect(pageB.getByTestId(`lobby-row-${lobbyCode}`)).toBeVisible({ timeout: 15_000 });
  await pageB.evaluate(() => {
    (window as unknown as { prompt: (msg?: string) => string }).prompt = () => "ExactnessGuest";
  });
  await pageB.getByTestId(`lobby-row-${lobbyCode}`).getByRole("button", { name: /Join/ }).click();
  await expect(pageB).toHaveURL(/\/online-guest/);
  await expect(pageB.getByText(/●\s+connected/)).toBeVisible({ timeout: 60_000 });
  await expect(pageB.getByTestId("local-player-toggle")).toBeEnabled({ timeout: 30_000 });
  await pageB.getByTestId("local-player-toggle").click();

  // Give both sims a moment to settle into steady-state lockstep before
  // we start poking the keyboard.
  await pageB.waitForTimeout(2000);

  // ── Sanity: both pages expose the debug bridge with a non-empty hash ──
  const initialA = await readSimState(pageA);
  const initialB = await readSimState(pageB);
  expect(initialA, "host __bbDebug not installed").not.toBeNull();
  expect(initialB, "guest __bbDebug not installed").not.toBeNull();
  expect(initialA!.hash.length).toBeGreaterThan(0);
  expect(initialB!.hash.length).toBeGreaterThan(0);

  // ── Drive input on the guest while sampling both sims ────────────────
  const samples: SampleResult[] = [];

  // Background: keyboard activity on guest.
  const inputPromise = driveKeyboardBurst(pageB, INPUT_BURST_MS);

  for (let i = 0; i < COMPARE_SAMPLES; i++) {
    await Promise.race([
      new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS)),
      inputPromise.then(() => undefined),
    ]);
    const [a, b] = await Promise.all([readSimState(pageA), readSimState(pageB)]);
    if (!a || !b) continue;
    samples.push({
      ts: Date.now(),
      hostHash: a.hash,
      guestHash: b.hash,
      hostTick: a.tick,
      guestTick: b.tick,
      match: a.hash === b.hash,
    });
  }

  await inputPromise;

  // Let both sims drain remaining inputs + keyframes for a beat.
  await pageA.waitForTimeout(1500);
  const finalA = await readSimState(pageA);
  const finalB = await readSimState(pageB);
  if (finalA && finalB) {
    samples.push({
      ts: Date.now(),
      hostHash: finalA.hash,
      guestHash: finalB.hash,
      hostTick: finalA.tick,
      guestTick: finalB.tick,
      match: finalA.hash === finalB.hash,
    });
  }

  // ── Assertions ───────────────────────────────────────────────────────
  // Diagnostic dump to make any failure trivially actionable.
  console.log("=== sim-exactness samples ===");
  for (const s of samples) {
    console.log(
      `[${s.match ? "OK" : "DESYNC"}] host=${s.hostHash.slice(0, 12)}@${s.hostTick}  guest=${s.guestHash.slice(0, 12)}@${s.guestTick}`,
    );
  }

  // The terminal sample (after input stopped + 1.5s drain) is the
  // strongest signal: any reconciliation should have settled by then.
  const last = samples[samples.length - 1];
  expect(last, "no samples collected").toBeTruthy();
  // Allow a few-tick gap between host and guest tick counters (lockstep
  // lag); compare hashes at matching tick numbers if needed. For the
  // FAIL-FAST signal, just assert the terminal sample matched.
  expect(
    last.hostHash,
    `terminal-sample desync: host=${last.hostHash} guest=${last.guestHash} hostTick=${last.hostTick} guestTick=${last.guestTick}`,
  ).toBe(last.guestHash);

  // Stronger assertion: at least half the in-flight samples should match
  // too. Brief mismatches during heavy input are tolerable (one side a
  // tick ahead) but persistent mismatches are a real desync.
  const matchCount = samples.filter((s) => s.match).length;
  expect(
    matchCount,
    `only ${matchCount}/${samples.length} samples matched — netcode is desyncing during play`,
  ).toBeGreaterThanOrEqual(Math.floor(samples.length / 2));

  await ctxA.close();
  await ctxB.close();
});
