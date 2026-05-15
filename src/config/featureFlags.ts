import { isTauri } from "../lib/runtime";

const demoEnv = (import.meta.env?.VITE_DEMO ?? "") as string;

export const isDemoBuild = demoEnv === "true" || demoEnv === "1";
export const isDesktop = isTauri();

export const features = {
  lobbyBrowser: !isDemoBuild,
  levelEditor: !isDemoBuild,
  sandbox: !isDemoBuild,
  chainedClimb: !isDemoBuild,
  timeTrial: true,
  partyArena: true,
  kingOfTheHill: true,
} as const;
