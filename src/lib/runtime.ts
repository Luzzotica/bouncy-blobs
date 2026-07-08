export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * True for the iOS/Android build. Set at build time via `VITE_MOBILE=1`
 * (see the `build:mobile` npm script / the mobile Tauri config). Mobile runs
 * inside Tauri but has NO steamworks — so it must NOT take the desktop "steam"
 * code paths (Workshop, Steam Networking, Steam auth ticket). Treat it like the
 * web platform for identity/sharing, with WebRTC for multiplayer.
 */
export function isMobile(): boolean {
  const flag = (import.meta.env?.VITE_MOBILE ?? "") as string;
  return flag === "true" || flag === "1";
}

/** Desktop = Tauri, but not the mobile Tauri build. This is the "has Steam" gate. */
export function isDesktopTauri(): boolean {
  return isTauri() && !isMobile();
}
