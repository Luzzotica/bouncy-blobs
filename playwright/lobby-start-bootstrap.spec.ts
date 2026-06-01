import { test, expect } from "@playwright/test";
import { startHosting } from "./lobby-helpers";

/**
 * Bootstrap-race regression test.
 *
 * Reproduces the symptom where a guest, already connected to the host in the
 * lobby playground, ends up with NO player blobs after the host transitions
 * lobby → playing via the START GAME button. Root cause: at game start the
 * host broadcasts `level_loaded` (which triggers `installLevel` on the guest,
 * wiping any in-flight keyframe stash) and relies on the next periodic
 * keyframe to deliver the player roster. With `?keyframe=0` no periodic
 * keyframe ever arrives — guest sits empty forever. Fix: every player-set
 * change (createPlaygroundGame, startGameWithLevel, onPeerConnected,
 * handlePlayerJoin, screen-peer player_join handler) sets
 * `forceKeyframeRef.current = true` so the next broadcastOnce within ~17ms
 * fires a fresh keyframe with the new roster.
 *
 * The companion `?keyframe=0` variant is the strict test — with periodic
 * keyframes disabled, the bootstrap can NOT be masked by a 1s rescue
 * keyframe, so the test fails immediately if the per-event keyframe trigger
 * is missing or racy.
 */

test.describe.configure({ mode: "serial" });

async function joinAsGuest(
  ctxBrowser: import("@playwright/test").Browser,
  lobbyCode: string,
): Promise<import("@playwright/test").Page> {
  const ctxB = await ctxBrowser.newContext();
  const pageB = await ctxB.newPage();
  pageB.on("console", (m) => console.log(`[guest] ${m.type()}: ${m.text()}`));
  await pageB.goto("/lobbies");
  await pageB.getByTestId("lobby-display-name").fill("BootstrapGuest");
  await expect(pageB.getByTestId(`lobby-row-${lobbyCode}`)).toBeVisible({ timeout: 15_000 });
  await pageB.getByTestId(`lobby-row-${lobbyCode}`).getByRole("button", { name: /Join/ }).click();
  await expect(pageB).toHaveURL(/\/online-guest/);
  return pageB;
}

async function pollGuestPlayerCount(
  pageB: import("@playwright/test").Page,
  expected: number,
  timeoutMs: number,
): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        last = await pageB.evaluate(() => {
          const dbg = (window as unknown as {
            __bbDebug?: { getAllPlayerPositions?: () => Record<string, unknown> };
          }).__bbDebug;
          return Object.keys(dbg?.getAllPlayerPositions?.() ?? {}).length;
        });
        return last;
      },
      { timeout: timeoutMs, intervals: [50, 100, 200, 500] },
    )
    .toBeGreaterThanOrEqual(expected);
  return last;
}

for (const keyframeMode of ["default", "off"] as const) {
  test(`Guest sees both host and guest blobs immediately at game start (keyframe=${keyframeMode})`, async ({ browser }) => {
    test.setTimeout(120_000);
    const urlParams: Record<string, string> = { level: "det-test" };
    if (keyframeMode === "off") urlParams.keyframe = "0";

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    pageA.on("console", (m) => console.log(`[host] ${m.type()}: ${m.text()}`));

    // 1. Host enters lobby playground.
    const { lobbyCode } = await startHosting(pageA, urlParams);
    await pageA.getByTestId("toggle-public").click();

    // 2. Host joins their own keyboard player ("Play from laptop"). This
    //    is critical for catching the "host loads in late" symptom: the
    //    keyboard player gets added by a separate 150ms-deferred
    //    canvasKey useEffect, so the bootstrap keyframe at game-start
    //    fires BEFORE the host blob exists in playerManager unless
    //    spawnExistingPlayers includes it.
    await pageA.getByTestId("local-player-toggle").click();

    // 3. Guest joins lobby BEFORE the host starts the game. This is the
    //    path that broke after the Phase A netcode work.
    const pageB = await joinAsGuest(browser, lobbyCode);

    // 4. Confirm guest's playerManager populates in the playground with
    //    BOTH players (host + guest). createPlaygroundGame's bootstrap
    //    keyframe + the screen-peer player_join keyframe trigger must
    //    each cover their share of the roster.
    await pollGuestPlayerCount(pageB, 2, 15_000);

    // 5. Host clicks START GAME — triggers startGameWithLevel which
    //    rebuilds the entire game world. Without the bootstrap fix the
    //    guest sees ONLY the guest's own blob (the host blob arrives
    //    150ms later via the canvasKey useEffect, but without
    //    forceKeyframeRef the new roster never reaches the guest until
    //    the next periodic keyframe — or never at all with keyframe=0).
    await pageA.getByTestId("start-game").click();

    // 6. Within ~2 seconds the guest's NEW game must contain BOTH
    //    blobs (host + guest). Tight timeout: at 17ms broadcast one
    //    keyframe with the full roster should land in well under 100ms.
    const count = await pollGuestPlayerCount(pageB, 2, 2_000);
    expect(count, `guest player count after start (keyframe=${keyframeMode})`).toBeGreaterThanOrEqual(2);

    await ctxA.close();
    await pageB.context().close();
  });
}
