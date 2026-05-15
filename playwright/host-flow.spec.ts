import { test, expect } from "@playwright/test";
import { startHosting, trackErrors } from "./lobby-helpers";

/**
 * Exercises the unified Host flow end-to-end against a real local hexii.
 * Catches the original "hangs at Creating session..." regression: if the
 * party_session POST or the mp_lobby POST fails or hangs, the join-code
 * testid never appears within the timeout and the test fails fast.
 */

test("Host: party session + mp_lobby both come up", async ({ page }) => {
  const { errors } = trackErrors(page);
  const { joinCode, lobbyCode } = await startHosting(page);
  expect(joinCode).not.toBe(lobbyCode); // Distinct ids — different layers.
  // QR code is rendered (the SVG element from qrcode.react).
  await expect(page.locator("svg").first()).toBeVisible();
  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("Host: visibility toggle flips Private ⇄ Public", async ({ page }) => {
  const { errors } = trackErrors(page);
  await startHosting(page);

  const toggle = page.getByTestId("toggle-public");
  await expect(toggle).toContainText("Private");

  await toggle.click();
  await expect(toggle).toContainText("Public", { timeout: 5_000 });

  await toggle.click();
  await expect(toggle).toContainText("Private", { timeout: 5_000 });

  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("Host: never gets stuck on 'Creating session...' (8s timeout)", async ({ page }) => {
  // If hexii is unreachable, SignalingService.fetchWithTimeout aborts after 8s
  // and the UI flips to phase='error' with a visible error-message testid —
  // not an indefinite spinner. We assert that we never see "Creating
  // session..." for longer than 30s.
  await page.goto("/game");
  const creating = page.getByTestId("creating-session");
  // Either we land in the lobby UI...
  const reachedLobby = page
    .getByTestId("join-code")
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => "lobby" as const);
  // ...or we surface an error...
  const reachedError = page
    .getByTestId("error-message")
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => "error" as const);
  const outcome = await Promise.race([reachedLobby, reachedError]);
  await expect(creating).toHaveCount(0); // Spinner is gone.
  expect(["lobby", "error"]).toContain(outcome);
});
