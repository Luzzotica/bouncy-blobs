import { isDesktopTauri, isMobile } from "../lib/runtime";

const demoEnv = (import.meta.env?.VITE_DEMO ?? "") as string;

export const isDemoBuild = demoEnv === "true" || demoEnv === "1";
// `isDesktop` gates Steam-only surfaces (Workshop publish/browse, Steam
// overlay, Steam Networking). The mobile Tauri build is NOT desktop even
// though it runs inside Tauri — it has no steamworks.
export const isDesktop = isDesktopTauri();
export const isMobileBuild = isMobile();

export const features = {
  lobbyBrowser: !isDemoBuild,
  levelEditor: !isDemoBuild,
  sandbox: !isDemoBuild,
  chainedClimb: !isDemoBuild,
  timeTrial: true,
  partyArena: true,
  kingOfTheHill: true,
} as const;
