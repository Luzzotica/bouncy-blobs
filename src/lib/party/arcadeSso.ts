// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Partii arcade single sign-on — auto-sign-in when a game is embedded.
//
// The host page (an iframe on the Partii arcade, or a mobile webview wrapper)
// passes down the signed-in user's session token; the game trades it for a
// Partii player (via the email provider — arcade accounts share the auth pool,
// so it resolves to the same player as an in-game email sign-in). A standalone
// game (itch, direct link) simply gets no token and falls back to anonymous /
// in-game sign-in.
//
// Three delivery channels, tried in order:
//   1. iframe: window.postMessage({ type:'partii:auth'|'arcadii:auth', token })
//   2. mobile webview: a `window.__ARCADE_TOKEN__` string injected before load
//   3. URL param: ?arcade_token=<token> (last resort / deep links)
//
// Wire type aliases: both `partii:*` (current) and `arcadii:*` (legacy) are
// accepted. Hosts should prefer `partii:*`; games accept either forever.
// ─────────────────────────────────────────────────────────────────────────────

import type { CloudContent, PlayerProfile } from "./cloudContent";

export interface ArcadeSsoOptions {
  /** Origins allowed to send the auth message (the arcade site). Required for
   *  the iframe channel — messages from any other origin are ignored. */
  allowedOrigins: string[];
  onSignedIn?: (profile: PlayerProfile) => void;
  onError?: (err: Error) => void;
}

/** Current + legacy postMessage type names (accept either). */
const AUTH_TYPES = new Set(["partii:auth", "arcadii:auth"]);
const SIGNOUT_TYPES = new Set(["partii:signout", "arcadii:signout"]);
/** Ready ping: send both so hosts listening for either wake up. */
const READY_TYPES = ["partii:ready", "arcadii:ready"] as const;

/**
 * Wire up Partii arcade SSO. Returns a cleanup function. Safe to call always:
 * if the game isn't embedded, nothing happens.
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
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;
    if (AUTH_TYPES.has(data.type) && data.token) void signIn(data.token);
    else if (SIGNOUT_TYPES.has(data.type)) { cloud.signOut(); done = false; }
  };
  window.addEventListener("message", onMessage);

  // Tell the parent we're ready to receive the token (it may be waiting).
  // Emit both current and legacy ready types for host compatibility.
  if (inIframe) {
    for (const origin of opts.allowedOrigins) {
      for (const type of READY_TYPES) {
        try { window.parent.postMessage({ type }, origin); } catch { /* ignore */ }
      }
    }
  }

  return () => window.removeEventListener("message", onMessage);
}
