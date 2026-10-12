//! Where the platform lives and who we are to it.

/// partii game id (rooms, telemetry, store).
pub const GAME_ID: &str = "bouncy-blobs";
/// The partii staging edge until production exists.
pub const DEFAULT_EDGE: &str = "https://partii-edge-staging.partii-games.workers.dev";
/// Where phones open the controller page (`web-controller/`, on Vercel
/// staging); the room code is appended. Override with
/// `BB_CONTROLLER_URL` (anything ending in `/controller/`).
pub const DEFAULT_CONTROLLER_URL: &str = "https://bouncy-blobs-controller-staging.vercel.app/controller/";

#[derive(Clone, Debug)]
pub struct NetConfig {
    /// partii edge base URL.
    pub edge: String,
    /// The game's publishable key (`pk_…`).
    pub key: String,
    pub game_id: String,
    /// Prefix the room code is appended to for the phone QR code.
    pub controller_url: String,
    /// The signed-in player's token, when there is one.
    pub player_token: Option<String>,
}

impl Default for NetConfig {
    fn default() -> Self {
        NetConfig { edge: DEFAULT_EDGE.into(), key: String::new(), game_id: GAME_ID.into(), controller_url: DEFAULT_CONTROLLER_URL.into(), player_token: None }
    }
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
    /// `BB_PARTII_API`, `BB_PARTII_KEY`, `BB_CONTROLLER_URL` at runtime,
    /// falling back to the same names at compile time.
    pub fn from_env() -> NetConfig {
        let d = NetConfig::default();
        let mut controller_url = env("BB_CONTROLLER_URL", option_env!("BB_CONTROLLER_URL")).unwrap_or(d.controller_url);
        if !controller_url.ends_with('/') {
            controller_url.push('/');
        }
        NetConfig {
            edge: env("BB_PARTII_API", option_env!("BB_PARTII_API")).unwrap_or(d.edge).trim_end_matches('/').to_string(),
            key: env("BB_PARTII_KEY", option_env!("BB_PARTII_KEY")).unwrap_or_default(),
            controller_url,
            player_token: env("BB_PARTII_PLAYER_TOKEN", None),
            ..d
        }
    }

    /// The URL phones scan: `<controller_url><CODE>`, plus the platform when
    /// it isn't the default the page was built with.
    pub fn controller_link(&self, code: &str) -> String {
        let mut url = format!("{}{}", self.controller_url, code);
        if self.edge != DEFAULT_EDGE {
            url.push_str(&format!("?k={}&e={}", self.key, encode(&self.edge)));
        }
        url
    }
}

/// Percent-encode a URL for a query value.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_link_appends_code() {
        let c = NetConfig::default();
        assert_eq!(c.controller_link("KXQPT"), format!("{DEFAULT_CONTROLLER_URL}KXQPT"));
    }

    #[test]
    fn controller_link_names_a_non_default_platform() {
        let c = NetConfig { edge: "http://192.168.1.5:8787".into(), key: "pk_demo_k1_x".into(), ..NetConfig::default() };
        assert_eq!(c.controller_link("KXQPT"), format!("{DEFAULT_CONTROLLER_URL}KXQPT?k=pk_demo_k1_x&e=http%3A%2F%2F192.168.1.5%3A8787"));
    }
}
