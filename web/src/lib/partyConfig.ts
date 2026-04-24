import type { PartyClientConfig } from "./party";

export const partyConfig: PartyClientConfig = {
  baseUrl: import.meta.env.VITE_PARTY_API_URL ?? "http://localhost:3000",
  pollIntervalMs: 500,
};
