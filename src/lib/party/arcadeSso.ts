// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Arcade single sign-on — auto-sign-in when a game is embedded in the Arcade.
//
// The host page (an iframe on the arcade website, or a mobile webview wrapper)
// passes down the signed-in Arcade user's session token; the game trades it for
// a Lobbii player (via the email provider — Arcade accounts share the auth
// pool, so it resolves to the same player as an in-game email sign-in). A
// standalone game (itch, direct link) simply gets no token and falls back to
// anonymous / in-game sign-in.
//
// Three delivery channels, tried in order:
//   1. iframe: window.postMessage({ type:'arcadii:auth', token }) from parent
//   2. mobile webview: a `window.__ARCADE_TOKEN__` string injected before load
//   3. URL param: ?arcade_token=<token> (last resort / deep links)
// ─────────────────────────────────────────────────────────────────────────────

import type { CloudContent, PlayerProfile } from "./cloudContent";

export interface ArcadeSsoOptions {
  /** Origins allowed to send the auth message (the arcade site). Required for
   *  the iframe channel — messages from any other origin are ignored. */
  allowedOrigins: string[];
  onSignedIn?: (profile: PlayerProfile) => void;
  onError?: (err: Error) => void;
}

const MSG_AUTH = "arcadii:auth";
const MSG_READY = "arcadii:ready";
const MSG_SIGNOUT = "arcadii:signout";

/**
 * Wire up Arcade SSO. Returns a cleanup function. Safe to call always: if the
 * game isn't embedded, nothing happens.
 */
export function initArcadeSso(cloud: CloudContent, opts: ArcadeSsoOptions): () => void {
  const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
  let done = false;

  const signIn = async (token: string) => {
    if (done || !token) return;
    done = true;
    try {
      const profile = await cloud.signInWithArcadeToken(token);
      opts.onSignedIn?.(profile);
    } catch (err) {
      done = false;
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // Channel 2: mobile webview injects a global before the bundle loads.
  const injected = (window as unknown as { __ARCADE_TOKEN__?: string }).__ARCADE_TOKEN__;
  if (injected) void signIn(injected);

  // Channel 3: URL param (deep links). Stripped from history after use.
  try {
    const url = new URL(window.location.href);
    const t = url.searchParams.get("arcade_token");
    if (t) {
      void signIn(t);
      url.searchParams.delete("arcade_token");
      window.history.replaceState({}, "", url.toString());
    }
  } catch { /* ignore */ }

  // Channel 1: iframe postMessage handshake.
  const onMessage = (e: MessageEvent) => {
    if (!opts.allowedOrigins.includes(e.origin)) return;
    const data = e.data as { type?: string; token?: string } | null;
    if (!data || typeof data !== "object") return;
    if (data.type === MSG_AUTH && data.token) void signIn(data.token);
    else if (data.type === MSG_SIGNOUT) { cloud.signOut(); done = false; }
  };
  window.addEventListener("message", onMessage);

  // Tell the parent we're ready to receive the token (it may be waiting).
  if (inIframe) {
    for (const origin of opts.allowedOrigins) {
      try { window.parent.postMessage({ type: MSG_READY }, origin); } catch { /* ignore */ }
    }
  }

  return () => window.removeEventListener("message", onMessage);
}
