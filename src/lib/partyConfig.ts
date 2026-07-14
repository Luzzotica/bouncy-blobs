import type { Attestation, RoomClientConfig } from "./party";
import { getTurnstileAttestation } from "./party/turnstileAttest";
import { CloudContent } from "./party";
import { isDesktopTauri, isMobile } from "./runtime";

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
// Platform selection:
//  - desktop Tauri (has steamworks) → "steam"   (Steam auth-session ticket)
//  - iOS/Android Tauri              → "player"  (arcadii player JWT — BYO attestation)
//  - vite dev / Playwright          → "dev"     (local origin, no proof)
//  - production web                 → "web"     (Cloudflare Turnstile)
// Mobile uses the backend's `player` platform: the attestation is a player
// JWT (silent anon device login, or the account the device linked via arcade
// SSO / email), which /api/auth/token verifies with verifyPlayerToken() and
// binds the session to `player:<id>`. That keeps mobile working when
// ENFORCE_SESSION_TOKENS flips on — no Turnstile origin, no Steam ticket
// needed. Device-integrity attestation (App Attest / Play Integrity) can
// later harden the players/login call itself; see docs/MobileAttestation.md.
const mobile = isMobile();
const platform = isDesktopTauri()
  ? "steam"
  : mobile
    ? "player"
    : import.meta.env.DEV
      ? "dev"
      : "web";

/** Lazy CloudContent bound to this game — the player-token source for mobile
 *  attestation. Shares the cached `lobbii_player_token_<game>` localStorage
 *  entry with every other CloudContent instance in the app (App.tsx SSO,
 *  level registry), so an arcade/email sign-in upgrades the attested identity
 *  here automatically. */
let attestCloud: CloudContent | null = null;
function cloudForAttest(): CloudContent {
  attestCloud ??= new CloudContent({
    baseUrl: import.meta.env.VITE_PARTY_API_URL ?? "http://localhost:3000",
    apiKey,
    gameId: "bouncy-blobs",
  });
  return attestCloud;
}

async function attest(): Promise<Attestation | string | null> {
  if (platform === "player") {
    // Mobile: BYO attestation — a fresh arcadii player JWT (24h TTL, renewed
    // by CloudContent when near expiry). null when offline/unreachable → the
    // exchange falls back to the API key while enforcement is off.
    return cloudForAttest().getPlayerToken();
  }
  if (platform === "web") return getTurnstileAttestation();
  if (platform === "steam") {
    // Steam auth session ticket: proves a genuine Steam account owning the game
    // AND carries identity (the backend mints a steam:<id64> player identity).
    // Loaded lazily so the web/mobile bundles never pull the Tauri steam layer.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { getSelfSteamId } = await import("./party/steamTransport");
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
