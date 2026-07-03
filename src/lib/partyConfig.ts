import type { Attestation, RoomClientConfig } from "./party";
import { getTurnstileAttestation } from "./party/turnstileAttest";
import { getSelfSteamId } from "./party/steamTransport";

const apiKey = import.meta.env.VITE_MP_API_KEY ?? "";
if (!apiKey) {
  console.warn("VITE_MP_API_KEY is not set — rooms API requests will fail with 401.");
}

// Steam/desktop builds run inside Tauri; everything else is the web platform.
// On Steam we'd attest with a Steam auth-session ticket (see src-tauri's
// steamworks integration) instead of Turnstile — wired as a follow-up.
//
// Dev builds (vite dev / Playwright) attest as `dev`: the backend accepts it
// from a local origin (isLocalOrigin) without a Turnstile token, so local runs
// mint a REAL session token and exercise the hardened auth path end-to-end.
// Production web builds stay `web` (Cloudflare Turnstile) — once
// VITE_TURNSTILE_SITE_KEY + the backend TURNSTILE_SECRET are configured, this
// is what gates real users; until then the backend's API-key fallback (while
// ENFORCE_SESSION_TOKENS is off) keeps everything working.
const isTauri = typeof window !== "undefined" && "__TAURI__" in window;
const platform = isTauri ? "steam" : import.meta.env.DEV ? "dev" : "web";

async function attest(): Promise<Attestation | string | null> {
  if (platform === "web") return getTurnstileAttestation();
  if (platform === "steam") {
    // Steam auth session ticket: proves a genuine Steam account owning the game
    // AND carries identity (the backend mints a steam:<id64> player identity).
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const [ticket, steamId] = await Promise.all([
        invoke<string>("steam_auth_ticket"),
        getSelfSteamId(),
      ]);
      return ticket ? { token: ticket, steamId: String(steamId) } : null;
    } catch (err) {
      console.warn("[partyConfig] steam ticket unavailable, exchange will fall back:", err);
      return null;
    }
  }
  return null; // dev → no proof needed (local origin)
}

/** Shared client config for the rooms SDK. */
export const roomConfig: RoomClientConfig = {
  gameId: "bouncy-blobs",
  baseUrl: import.meta.env.VITE_PARTY_API_URL ?? "http://localhost:3000",
  apiKey,
  pollIntervalMs: 500,
  platform,
  getAttestation: attest,
};

export const GAME_ID = "bouncy-blobs";

// Legacy aliases — kept as deprecated re-exports so older callsites don't break
// at import time during the migration. Prefer `roomConfig` + `GAME_ID`.
export const partyConfig = roomConfig;
export const MP_GAME_ID = GAME_ID;
