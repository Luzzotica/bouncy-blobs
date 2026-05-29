// "Enter room code" button regression on the LobbyBrowser page.
//
// The button must always render (even when no public lobbies are
// listed) so users with a friend's private code can join without
// needing the friend to make the lobby discoverable. We also verify
// clicking it triggers a prompt (the actual room lookup needs the
// party API server, which isn't available in this test environment —
// the prompt acceptance is enough to prove the wiring).

import { test, expect } from '@playwright/test';

test('lobbies: Enter Code button is always visible and prompts for a code', async ({ page }) => {
  // Listen for the window.prompt invocation. Playwright auto-dismisses
  // prompts by default, but we override to capture the message + decline
  // to avoid hanging on the lookup.
  let promptMessage: string | null = null;
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') {
      promptMessage = dialog.message();
    }
    await dialog.dismiss();
  });

  await page.goto('/lobbies');
  const btn = page.getByTestId('enter-room-code-button');
  await expect(btn).toBeVisible();
  await btn.click();

  // Give the prompt a tick to fire.
  await page.waitForTimeout(300);
  expect(promptMessage, 'window.prompt should have been called when clicking Enter Code')
    .not.toBeNull();
  expect(promptMessage!.toLowerCase()).toContain('code');
});
