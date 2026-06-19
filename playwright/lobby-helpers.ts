import { type Page, expect } from "@playwright/test";

// Default to the live (prod) backend so e2e runs hit the same server the app
// does (.env / .env.local set VITE_PARTY_API_URL=https://www.sterlinglong.me).
// Override via the shell env to point at a local rooms server.
export const PARTY_API_URL =
  process.env.VITE_PARTY_API_URL ?? "https://www.sterlinglong.me";
export const MP_API_KEY =
  process.env.VITE_MP_API_KEY ?? "mpk_live_igwS_xp_ksHKhBN1pmLtYs8Rbu1P2Puz";

export const noisySafe = (m: string): boolean =>
  m.includes("Failed to load resource") ||
  m.includes("Failed to poll session") ||
  m.includes("Missing X-API-Key") ||
  m.toLowerCase().includes("cors") ||
  m.toLowerCase().includes("net::err_aborted");

/** Capture pageerrors and meaningful console.error()s into one bucket. */
export function trackErrors(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !noisySafe(msg.text())) errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return { errors };
}

/** Drive Home → Host and wait for the lobby UI to be live.
 *  `urlParams` lets a test tweak the host's pacing config without
 *  hand-building the URL each call (e.g. `{ keyframe: '0' }` to
 *  disable the periodic + post-rollback keyframe resyncs for
 *  determinism-only tests). */
export async function startHosting(
  page: Page,
  urlParams?: Record<string, string>,
): Promise<{ joinCode: string; lobbyCode: string }> {
  const qs = urlParams ? '?' + new URLSearchParams(urlParams).toString() : '';
  await page.goto(`/game${qs}`);
  // GameMaster gates the lobby behind a HostSetupModal — fill the minimum
  // required fields (display name + room name) and submit. Without this
  // the join-code testId never renders.
  const setupModal = page.getByTestId("host-setup-modal");
  if (await setupModal.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await page.getByTestId("host-setup-display-name").fill("TestHost");
    await page.getByTestId("host-setup-room-name").fill("TestRoom");
    const submit = page.getByTestId("host-setup-submit");
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await submit.click();
  }
  // The lobby panel's join code — used as the room ID for both
  // phone-controller scanning and screen-peer joining. The old separate
  // `lobby-code` testId has been merged into this one.
  await expect(page.getByTestId("join-code")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("toggle-public")).toBeVisible();

  // Wait for the code to actually populate (renders as "…" until the
  // backend createLobby resolves).
  await expect
    .poll(async () => (await page.getByTestId("join-code").textContent())?.trim() ?? "")
    .toMatch(/^[A-Z0-9]{4,}$/);
  const joinCode = ((await page.getByTestId("join-code").textContent()) ?? "").trim();
  return { joinCode, lobbyCode: joinCode };
}
