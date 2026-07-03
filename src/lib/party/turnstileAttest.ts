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

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      size?: "invisible" | "normal" | "compact";
      callback: (token: string) => void;
      "error-callback"?: () => void;
    },
  ) => string;
  execute: (widgetId: string) => void;
  remove: (widgetId: string) => void;
  ready: (cb: () => void) => void;
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
    s.defer = true;
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
    const container = document.createElement("div");
    container.style.display = "none";
    document.body.appendChild(container);

    let settled = false;
    const cleanup = (widgetId?: string) => {
      if (settled) return;
      settled = true;
      try {
        if (widgetId) api.remove(widgetId);
      } catch {
        /* ignore */
      }
      container.remove();
    };
    // Safety timeout so a stuck challenge never blocks room creation forever.
    const timer = setTimeout(() => {
      cleanup(widgetId);
      resolve(null);
    }, 8000);

    let widgetId: string | undefined;
    api.ready(() => {
      widgetId = api.render(container, {
        sitekey: SITE_KEY,
        size: "invisible",
        callback: (token: string) => {
          clearTimeout(timer);
          cleanup(widgetId);
          resolve(token);
        },
        "error-callback": () => {
          clearTimeout(timer);
          cleanup(widgetId);
          resolve(null);
        },
      });
      api.execute(widgetId);
    });
  });
}
