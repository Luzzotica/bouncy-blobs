//! Seams the party screen uses that other modules fill in: imported 2.x
//! maps (bb-level legacy importer → assets/levels/party) and the phone
//! join panel (bb-net).

use bb_level::Level;
use bevy::prelude::*;

use crate::assets::GameAssets;

/// Party maps converted from 2.x. Embedded in the binary (via
/// `editor::library`) so they exist on every platform: reading
/// `CARGO_MANIFEST_DIR` at runtime only works on the dev machine, not in a
/// shipped .app/.ipa/.apk/web build.
pub fn imported_maps() -> Vec<Level> {
    let mut v: Vec<Level> = crate::editor::library::PARTY_LEVELS
        .iter()
        .filter_map(|b| Level::from_json(b.json).ok())
        .collect();
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
