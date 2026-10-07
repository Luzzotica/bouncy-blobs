import type { Attestation, RoomClientConfig } from "./party";
import { getTurnstileAttestation } from "./party/turnstileAttest";

// The phone controller is a plain web page: vite dev attests as `dev`
// (local origin, no proof); production attests with Cloudflare Turnstile and
// falls back to the API key while the backend doesn't enforce session tokens.
const apiKey = import.meta.env.VITE_MP_API_KEY ?? "";
if (!apiKey) {
  console.warn("VITE_MP_API_KEY is not set — rooms API requests will fail with 401.");
}

const platform = import.meta.env.DEV ? "dev" : "web";

async function attest(): Promise<Attestation | string | null> {
  return platform === "web" ? getTurnstileAttestation() : null;
}

export const GAME_ID = "bouncy-blobs";

/** Shared client config for the rooms SDK. */
export const roomConfig: RoomClientConfig = {
  gameId: GAME_ID,
  baseUrl: import.meta.env.VITE_PARTY_API_URL ?? "https://www.sterlinglong.me",
  apiKey,
  pollIntervalMs: 500,
  platform,
  getAttestation: attest,
};
