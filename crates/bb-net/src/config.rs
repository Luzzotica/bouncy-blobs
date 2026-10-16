//! Where the platform lives and who we are to it.

/// partii game id (rooms, telemetry, store).
pub const GAME_ID: &str = "bouncy-blobs";
/// The partii production edge (its stable domain).
pub const DEFAULT_EDGE: &str = "https://api.partii.games";
/// The same production worker under its workers.dev name (older builds and
/// env files): still gets the production key.
pub const PROD_EDGE_WORKERS: &str = "https://partii-edge.partii-games.workers.dev";
/// bouncy-blobs' production publishable key (public by design), used when
/// the edge is the default one and no key was given.
pub const DEFAULT_KEY: &str = "pk_bouncyblobs_game_ChoZroQWd5sqZiwXtLpY-k";
/// The partii staging edge.
pub const STAGING_EDGE: &str = "https://partii-edge-staging.partii-games.workers.dev";
/// Staging under its stable domain.
pub const STAGING_EDGE_API: &str = "https://api-staging.partii.games";
/// Where phones open the controller page (`web-controller/`, hosted on
/// partii): `<this>/c/<CODE>?k=…&e=…&g=bouncy-blobs`. Override with
/// `BB_CONTROLLER_URL` (the site, e.g. `http://192.168.1.5:5171`).
pub const DEFAULT_CONTROLLER_URL: &str = "https://bouncy-blobs.partii.games";
/// The staging controller site, used when the edge is staging's.
pub const STAGING_CONTROLLER_URL: &str = "https://bouncy-blobs-staging.partii.games";

#[derive(Clone, Debug)]
pub struct NetConfig {
    /// partii edge base URL.
    pub edge: String,
    /// The game's publishable key (`pk_…`).
    pub key: String,
    pub game_id: String,
    /// The controller site the phone QR code points at.
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
        let edge = env("BB_PARTII_API", option_env!("BB_PARTII_API")).unwrap_or(d.edge).trim_end_matches('/').to_string();
        let site = if edge == STAGING_EDGE || edge == STAGING_EDGE_API { STAGING_CONTROLLER_URL.to_string() } else { d.controller_url };
        let controller_url = env("BB_CONTROLLER_URL", option_env!("BB_CONTROLLER_URL")).unwrap_or(site);
        let key = env("BB_PARTII_KEY", option_env!("BB_PARTII_KEY")).unwrap_or_else(|| if edge == DEFAULT_EDGE || edge == PROD_EDGE_WORKERS { DEFAULT_KEY.into() } else { String::new() });
        NetConfig {
            edge,
            key,
            controller_url,
            player_token: env("BB_PARTII_PLAYER_TOKEN", None),
            ..d
        }
    }

    /// The URL phones scan: `<site>/c/<CODE>?k=<key>&e=<edge>&g=<game>`
    /// (partii `docs/CONTROLLER.md`).
    pub fn controller_link(&self, code: &str) -> String {
        crate::play::controller_url(&self.controller_url, code, &self.key, &self.edge, &self.game_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_link_is_the_partii_hosted_page() {
        let c = NetConfig { key: DEFAULT_KEY.into(), ..NetConfig::default() };
        assert_eq!(
            c.controller_link("KXQPT"),
            format!("https://bouncy-blobs.partii.games/c/KXQPT?k={DEFAULT_KEY}&e=https%3A%2F%2Fapi.partii.games&g=bouncy-blobs")
        );
    }

    #[test]
    fn controller_link_names_a_non_default_platform() {
        let c = NetConfig { edge: "http://192.168.1.5:8787".into(), key: "pk_demo_k1_x".into(), controller_url: "http://192.168.1.5:5171/".into(), ..NetConfig::default() };
        assert_eq!(c.controller_link("KXQPT"), "http://192.168.1.5:5171/c/KXQPT?k=pk_demo_k1_x&e=http%3A%2F%2F192.168.1.5%3A8787&g=bouncy-blobs");
    }
}
