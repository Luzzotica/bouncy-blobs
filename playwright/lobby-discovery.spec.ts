import { test, expect } from "@playwright/test";
import { startHosting, trackErrors } from "./lobby-helpers";

/**
 * Two-context ("two laptops") test of the public discovery flow:
 *   A: Host → flip Public → lobby code visible
 *   B: /lobbies → sees A's lobby → click Join → lands on /online-guest
 *   A: flip back to Private → B's /lobbies no longer lists it
 */

test("Public lobby is discoverable across browser contexts", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const aErr = trackErrors(pageA);
  const bErr = trackErrors(pageB);

  // Laptop A hosts.
  const { lobbyCode } = await startHosting(pageA);

  // Laptop B opens /lobbies — should NOT yet see A's lobby (still private).
  await pageB.goto("/lobbies");
  await expect(pageB.getByTestId(`lobby-row-${lobbyCode}`)).toHaveCount(0);

  // A flips public.
  await pageA.getByTestId("toggle-public").click();
  await expect(pageA.getByTestId("toggle-public")).toContainText("Public");

  // B refreshes — the page already polls every 3s, but a goto is faster.
  await pageB.goto("/lobbies");
  await expect(pageB.getByTestId(`lobby-row-${lobbyCode}`)).toBeVisible({ timeout: 10_000 });

  // B clicks Join. LobbyBrowser uses window.prompt for display name — stub it.
  await pageB.evaluate(() => {
    (window as unknown as { prompt: (msg?: string) => string }).prompt = () => "Guest";
  });
  await pageB
    .getByTestId(`lobby-row-${lobbyCode}`)
    .getByRole("button", { name: /Join/ })
    .click();
  await expect(pageB).toHaveURL(/\/online-guest/);

  // OnlineGuest renders without crashing — the header / leave button is enough proof.
  await expect(pageB.getByText(/Online match/)).toBeVisible({ timeout: 15_000 });

  // A flips private again — B's list should empty out within a poll cycle.
  await pageA.getByTestId("toggle-public").click();
  await expect(pageA.getByTestId("toggle-public")).toContainText("Private");
  await pageB.goto("/lobbies");
  await expect(pageB.getByTestId(`lobby-row-${lobbyCode}`)).toHaveCount(0, { timeout: 5_000 });

  expect(aErr.errors, aErr.errors.join("\n")).toHaveLength(0);
  // B is allowed network noise from the canceled MatchClient when navigating away.
  const bMeaningful = bErr.errors.filter((m) => !m.includes("aborted") && !m.includes("WebRTC"));
  expect(bMeaningful, bMeaningful.join("\n")).toHaveLength(0);

  await ctxA.close();
  await ctxB.close();
});
