import { test, expect } from "@playwright/test";
import { trackErrors } from "./lobby-helpers";

test("Home renders the unified Host + Browse buttons", async ({ page }) => {
  const { errors } = trackErrors(page);
  await page.goto("/");
  await expect(page.getByTestId("host-button")).toBeVisible();
  await expect(page.getByTestId("browse-button")).toBeVisible();
  // Old separate "Host Online Match" button must be gone.
  await expect(page.getByText("Host Online Match")).toHaveCount(0);
  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("Host button navigates to /game", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("host-button").click();
  await expect(page).toHaveURL(/\/game(\?|$)/);
});

test("Browse Lobbies button navigates to /lobbies", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("browse-button").click();
  await expect(page).toHaveURL(/\/lobbies/);
  await expect(page.getByText("Online Lobbies")).toBeVisible();
});

test("/host-online route was removed (renders blank, not the old form)", async ({ page }) => {
  await page.goto("/host-online");
  // No matching route → react-router renders nothing inside <Routes>.
  await expect(page.getByText("Host Online Match")).toHaveCount(0);
  await expect(page.getByText("Lobby name")).toHaveCount(0);
});

test("Lobby list is scrollable when it overflows the viewport", async ({ page }) => {
  await page.goto("/lobbies");
  const list = page.getByTestId("lobby-list");
  await expect(list).toBeVisible();
  // CSS check: the list container itself owns the scroll, and its parent
  // chain doesn't grow past the viewport (html/body/#root are overflow:hidden).
  const overflowY = await list.evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflowY).toBe("auto");
  // Inject enough fake rows so the list is taller than the viewport, then
  // assert scrollHeight > clientHeight (the only useful test of "scrollable").
  await list.evaluate((el) => {
    for (let i = 0; i < 30; i++) {
      const row = document.createElement("div");
      row.style.padding = "16px";
      row.style.borderTop = "1px solid #222";
      row.textContent = `synthetic-row-${i}`;
      el.appendChild(row);
    }
  });
  const { scroll, client } = await list.evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
  }));
  expect(scroll, `list scrollHeight ${scroll} should exceed clientHeight ${client}`).toBeGreaterThan(client);
});
