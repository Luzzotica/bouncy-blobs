// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
// Cloudflare Turnstile attestation for the rooms token exchange (web platform).
//
// Returns a fresh Turnstile token the backend verifies via siteverify, proving
// the request comes from a real browser session on our site rather than a
// script replaying a stolen API key. Fully defensive: with no site key, or if
// the widget script can't load, it resolves null — the backend waves through
// 'dev'/localhost, and during the rollout still accepts the raw API key.
//
// Docs: https://developers.cloudflare.com/turnstile/
//
// Important: do NOT call turnstile.ready() after loading api.js with async/defer
// (Cloudflare throws: "Remove async/defer … before using turnstile.ready()").
// We wait for script onload, then render immediately.

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      size?: "invisible" | "normal" | "compact";
      callback: (token: string) => void;
      "error-callback"?: (code?: string | number) => void;
    },
  ) => string;
  execute: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi | null> | null = null;

function loadScript(): Promise<TurnstileApi | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve(window.turnstile ?? null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/** Solve an invisible Turnstile challenge and return the token, or null. */
export async function getTurnstileAttestation(): Promise<string | null> {
  if (!SITE_KEY) return null;
  const api = await loadScript();
  if (!api) return null;

  return new Promise<string | null>((resolve) => {
    // Keep the host element in the layout tree. display:none can prevent the
    // challenge iframe from running on some browsers.
    const container = document.createElement("div");
    container.setAttribute("aria-hidden", "true");
    container.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
    document.body.appendChild(container);

    let settled = false;
    let widgetId: string | undefined;
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (widgetId !== undefined) api.remove(widgetId);
      } catch {
        /* ignore */
      }
      container.remove();
      resolve(token);
    };

    // Safety timeout so a stuck challenge never blocks room creation forever.
    const timer = setTimeout(() => finish(null), 8000);

    try {
      // Default execution is "render" (challenge starts on render). Do not call
      // execute() after that — Turnstile warns "already executing" and can fail.
      widgetId = api.render(container, {
        sitekey: SITE_KEY,
        size: "invisible",
        callback: (token: string) => finish(token),
        "error-callback": (code) => {
          console.warn("[turnstile] challenge error:", code ?? "(no code)");
          finish(null);
        },
      });
    } catch (err) {
      console.warn("[turnstile] render failed:", err);
      finish(null);
    }
  });
}
