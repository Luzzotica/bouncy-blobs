//! Seams the party screen uses that other modules fill in: imported 2.x
//! maps (bb-level legacy importer → assets/levels/party) and the phone
//! join panel (bb-net).

use bb_level::Level;
use bevy::prelude::*;

use crate::assets::GameAssets;

/// Party maps converted from 2.x, if the assets exist.
pub fn imported_maps() -> Vec<Level> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/levels/party");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut v: Vec<Level> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json") && e.file_name() != "manifest.json")
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|s| Level::from_json(&s).ok())
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

/// "Grab a phone" hint shown in the lobby until the net join panel lands.
pub fn spawn_join_hint<M: Component>(commands: &mut Commands, assets: &GameAssets, marker: M) {
    commands.spawn((
        Text::new("Pads: press A to join  ·  Phones: host online from the Party lobby"),
        TextFont { font: assets.font.clone().into(), font_size: 22.0.into(), ..default() },
        TextColor(Color::srgba(1.0, 1.0, 1.0, 0.75)),
        Node { position_type: PositionType::Absolute, left: px(24.0), bottom: px(18.0), ..default() },
        marker,
    ));
}
