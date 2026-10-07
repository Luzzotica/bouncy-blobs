//! Where the backend lives and who we are to it.

/// Lobbii game id shared with the TS app (rooms, telemetry, cloud content).
pub const GAME_ID: &str = "bouncy-blobs";
/// Production Lobbii backend (the TS app's `VITE_PARTY_API_URL`).
pub const DEFAULT_API: &str = "https://www.sterlinglong.me";
/// Where phones open the controller page. The legacy app builds
/// `${window.location.origin}/controller/<room_id>`; a native host has no
/// origin of its own, so this points at the deployed web app and can be
/// overridden with `BB_CONTROLLER_URL` (anything ending in `/controller/`).
pub const DEFAULT_CONTROLLER_URL: &str = "https://www.sterlinglong.me/bouncy-blobs/controller/";

#[derive(Clone, Debug)]
pub struct NetConfig {
    pub api_base: String,
    /// Project API key (`X-API-Key`), exchanged for a short-lived session token.
    pub api_key: String,
    pub game_id: String,
    /// Prefix the room id is appended to for the phone QR code.
    pub controller_url: String,
    /// Platform claimed at token exchange (`web` | `steam` | `player` | `dev`).
    pub platform: String,
    /// Signal poll interval while the push socket is down (TS: 500 ms for BB).
    pub signal_poll_ms: u32,
    /// Room roster poll interval (TS host: 2000 ms).
    pub room_poll_ms: u32,
}

impl Default for NetConfig {
    fn default() -> Self {
        NetConfig {
            api_base: DEFAULT_API.into(),
            api_key: String::new(),
            game_id: GAME_ID.into(),
            controller_url: DEFAULT_CONTROLLER_URL.into(),
            platform: default_platform().into(),
            signal_poll_ms: 500,
            room_poll_ms: 2000,
        }
    }
}

fn default_platform() -> &'static str {
    // Native has no Steam ticket (yet) or Turnstile, but can always attest
    // as an anonymous Lobbii player. The browser build is the `web` platform.
    if cfg!(target_arch = "wasm32") { "web" } else { "player" }
}

/// Runtime env var (native only; the browser has no env), then the value
/// baked in at compile time.
fn env(name: &str, baked: Option<&'static str>) -> Option<String> {
    #[cfg(not(target_arch = "wasm32"))]
    if let Ok(v) = std::env::var(name) {
        if !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    let _ = name;
    baked.map(str::to_string).filter(|s| !s.is_empty())
}

impl NetConfig {
    /// `BB_PARTY_API`, `BB_MP_API_KEY`, `BB_CONTROLLER_URL`, `BB_PARTY_PLATFORM`
    /// at runtime, falling back to the same names at compile time.
    pub fn from_env() -> NetConfig {
        let d = NetConfig::default();
        let mut controller_url = env("BB_CONTROLLER_URL", option_env!("BB_CONTROLLER_URL")).unwrap_or(d.controller_url);
        if !controller_url.ends_with('/') {
            controller_url.push('/');
        }
        NetConfig {
            api_base: env("BB_PARTY_API", option_env!("BB_PARTY_API"))
                .unwrap_or(d.api_base)
                .trim_end_matches('/')
                .to_string(),
            api_key: env("BB_MP_API_KEY", option_env!("BB_MP_API_KEY")).unwrap_or_default(),
            controller_url,
            platform: env("BB_PARTY_PLATFORM", option_env!("BB_PARTY_PLATFORM")).unwrap_or(d.platform),
            ..d
        }
    }

    /// The URL phones scan: `<controller_url><room_id>`.
    pub fn controller_link(&self, room_id: &str) -> String {
        format!("{}{}", self.controller_url, room_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_link_appends_room() {
        let c = NetConfig::default();
        assert_eq!(c.controller_link("abc"), "https://www.sterlinglong.me/bouncy-blobs/controller/abc");
    }
}
