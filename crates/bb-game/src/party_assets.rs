//! Seams the party screen uses that other modules fill in: imported 2.x
//! maps (bb-level legacy importer → assets/levels/party) and the phone
//! join panel (bb-net).

use bb_level::Level;
use bevy::prelude::*;

use crate::assets::GameAssets;

/// One of the 27 legacy 2.x levels converted to v3 (built into the binary).
pub struct Builtin {
    pub id: &'static str,
    /// Name shown in the lobby (overrides the converted JSON's name, which
    /// still says "Race" for some maps).
    pub name: &'static str,
    /// Offered in the party lobby's map rotation. The rest are 2.x test
    /// arenas, kept because `bb-sim`'s legacy tests check every conversion.
    pub lobby: bool,
    pub json: &'static str,
}

macro_rules! map {
    ($id:literal, $name:literal, $lobby:literal) => {
        Builtin { id: $id, name: $name, lobby: $lobby, json: include_str!(concat!("../assets/levels/party/", $id, ".json")) }
    };
}

/// Embedded so they exist on every platform: reading `CARGO_MANIFEST_DIR`
/// at runtime only works on the dev machine, not in a shipped
/// .app/.ipa/.apk/web build.
pub const PARTY_LEVELS: &[Builtin] = &[
    map!("classic", "Classic", true),
    map!("koth", "King of the Hill Arena", true),
    map!("koth-moving-test", "KOTH Moving Hill (test)", false),
    map!("simple-koth", "Simple King of the Hill", true),
    map!("blob-hill", "Blob Hill", true),
    map!("default", "Default Arena", false),
    map!("showcase", "Showcase Arena", false),
    map!("playground", "Physics Playground", false),
    map!("det-test", "Determinism Test Arena", false),
    map!("simple-race", "Simple Dash", true),
    map!("chained-climb", "The Long Climb", true),
    map!("swervy", "Swervy", true),
    map!("wall-climb", "Wall Climb", true),
    map!("ceiling-crawl", "Ceiling Crawl", true),
    map!("moving-platforms", "Moving Platforms", true),
    map!("gravity-drive", "Gravity Drive", true),
    map!("springy", "Springy", true),
    map!("simple-king-of-the-hill", "Simple King of the Hill 2", true),
    map!("jump", "Jump", true),
    map!("cannon", "Cannon", true),
    map!("platforms-be-movin", "Platforms Be MOVIN", true),
    map!("squeeze-up", "Squeeze Up", true),
    map!("squeeze-in", "Squeeze In", true),
    map!("getting-crushed", "Getting Crushed", true),
    map!("crush-test", "Crush Test", false),
    map!("kids-playground", "Kids Playground", false),
    map!("party", "Party Arena", false),
];

impl Builtin {
    pub fn level(&self) -> Option<Level> {
        let mut l = Level::from_json(self.json).ok()?;
        l.name = self.name.into();
        Some(l)
    }
}

pub fn party_level(id: &str) -> Option<Level> {
    PARTY_LEVELS.iter().find(|b| b.id == id).and_then(Builtin::level)
}

/// The imported 2.x maps in the lobby rotation, sorted by name.
pub fn imported_maps() -> Vec<Level> {
    let mut v: Vec<Level> = PARTY_LEVELS.iter().filter(|b| b.lobby).filter_map(Builtin::level).collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

/// "Grab a phone" hint shown in the lobby until the net join panel lands.
pub fn spawn_join_hint<M: Component>(commands: &mut Commands, assets: &GameAssets, marker: M) {
    commands.spawn((
        Text::new("Pads: press A to join  ·  Phones: scan the code!"),
        TextFont { font: assets.font.clone().into(), font_size: 22.0.into(), ..default() },
        TextColor(Color::srgba(1.0, 1.0, 1.0, 0.75)),
        Node { position_type: PositionType::Absolute, left: px(24.0), bottom: px(18.0), ..default() },
        marker,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_parse() {
        for b in PARTY_LEVELS {
            assert!(party_level(b.id).is_some(), "{}", b.id);
        }
        assert_eq!(PARTY_LEVELS.len(), 27);
    }

    /// Every embedded map is one of the converted assets on disk.
    #[test]
    fn matches_manifest() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!("../assets/levels/party/manifest.json")).unwrap();
        let ids: Vec<&str> = manifest["levels"].as_array().unwrap().iter().map(|l| l["id"].as_str().unwrap()).collect();
        for b in PARTY_LEVELS {
            assert!(ids.contains(&b.id), "{} not in manifest", b.id);
        }
    }
}
