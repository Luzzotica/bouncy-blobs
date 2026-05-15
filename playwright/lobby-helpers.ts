import { type Page, expect } from "@playwright/test";

export const PARTY_API_URL =
  process.env.VITE_PARTY_API_URL ?? "http://192.168.86.118:3000";
export const MP_API_KEY =
  process.env.VITE_MP_API_KEY ?? "mpk_live_OIXff-qF_jHThMV9pDGvwh0PsHe2xP0o";

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

/** Drive Home → Host and wait for the lobby UI to be live. */
export async function startHosting(page: Page): Promise<{ joinCode: string; lobbyCode: string }> {
  await page.goto("/game");
  // The signaling baseline — phone-controller QR/code shows up.
  await expect(page.getByTestId("join-code")).toBeVisible({ timeout: 30_000 });
  // The mp_lobby created on top — proves the screen-layer is live.
  await expect(page.getByTestId("lobby-code")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("toggle-public")).toBeVisible();

  const joinCode = (await page.getByTestId("join-code").textContent()) ?? "";
  const lobbyText = (await page.getByTestId("lobby-code").textContent()) ?? "";
  // "ONLINE LOBBY · ABC123"
  const lobbyCode = lobbyText.split("·").pop()?.trim() ?? "";
  expect(joinCode).toMatch(/^[A-Z0-9]{4,}$/);
  expect(lobbyCode).toMatch(/^[A-Z0-9]{4,}$/);
  return { joinCode, lobbyCode };
}
