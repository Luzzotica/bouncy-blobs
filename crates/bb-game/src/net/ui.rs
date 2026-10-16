//! The "join on your phone" panel: QR code + join code + status.
//!
//! Menu code calls [`spawn_join_panel`] once; the panel fills itself in when
//! the room is ready and follows status changes.

use bevy::asset::RenderAssetUsages;
use bevy::image::ImageSampler;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};

use super::{NetSession, NetStatus};

#[derive(Component)]
pub struct JoinPanel {
    qr: Entity,
    code: Entity,
    hint: Entity,
    /// Room id the QR currently shows.
    shown: Option<String>,
}

/// QR modules → a crisp RGBA image (1 px per module, 2-module quiet zone;
/// the nearest sampler keeps it sharp when the UI scales it up).
pub fn qr_image(data: &str) -> Option<Image> {
    let code = qrcode::QrCode::new(data.as_bytes()).ok()?;
    let w = code.width();
    let quiet = 2;
    let size = w + quiet * 2;
    let mut px = vec![255u8; size * size * 4];
    for (i, c) in code.to_colors().iter().enumerate() {
        if *c == qrcode::Color::Dark {
            let (x, y) = (i % w + quiet, i / w + quiet);
            let o = (y * size + x) * 4;
            px[o..o + 3].copy_from_slice(&[0x1a, 0x12, 0x24]);
        }
    }
    let mut img = Image::new(
        Extent3d { width: size as u32, height: size as u32, depth_or_array_layers: 1 },
        TextureDimension::D2,
        px,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::RENDER_WORLD | RenderAssetUsages::MAIN_WORLD,
    );
    img.sampler = ImageSampler::nearest();
    Some(img)
}

/// Spawn the panel (top-right overlay). Returns the root entity; despawn it
/// to hide.
pub fn spawn_join_panel(commands: &mut Commands) -> Entity {
    let qr = commands
        .spawn((
            Node { width: Val::Px(180.0), height: Val::Px(180.0), ..default() },
            BackgroundColor(Color::WHITE),
            ImageNode::default(),
            Visibility::Hidden,
        ))
        .id();
    let code = commands
        .spawn((Text::new(""), TextFont::from_font_size(34.0), TextColor(Color::srgb(1.0, 0.85, 0.35))))
        .id();
    let hint = commands
        .spawn((Text::new("Creating room…"), TextFont::from_font_size(15.0), TextColor(Color::srgb(0.9, 0.88, 0.95))))
        .id();
    let root = commands
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                top: Val::Px(16.0),
                right: Val::Px(16.0 + crate::platform::SAFE_SIDE),
                flex_direction: FlexDirection::Column,
                align_items: AlignItems::Center,
                row_gap: Val::Px(8.0),
                padding: UiRect::all(Val::Px(14.0)),
                border_radius: BorderRadius::all(Val::Px(18.0)),
                ..default()
            },
            BackgroundColor(Color::srgba(0.12, 0.08, 0.18, 0.88)),
            JoinPanel { qr, code, hint, shown: None },
        ))
        .id();
    commands.entity(root).add_children(&[qr, code, hint]);
    root
}

pub(crate) fn update_join_panels(
    session: Option<Res<NetSession>>,
    mut panels: Query<&mut JoinPanel>,
    images: Option<ResMut<Assets<Image>>>,
    mut nodes: Query<(&mut ImageNode, &mut Visibility)>,
    mut texts: Query<&mut Text>,
) {
    let Some(mut images) = images else { return };
    for mut panel in &mut panels {
        let (room, status) = match session.as_deref() {
            Some(s) => (s.room.as_ref(), Some(&s.status)),
            None => (None, None),
        };
        let hint = match (status, room) {
            (None, _) => "Not hosting".to_string(),
            (Some(NetStatus::Connecting), _) => "Creating room…".into(),
            (Some(NetStatus::Ready), Some(r)) => {
                let players = session.as_deref().map_or(0, |s| s.roster.len());
                let who = if players == 1 { "1 player".to_string() } else { format!("{players} players") };
                format!("Scan to play on your phone\nor enter the code at {}\n{who} joined", join_page(&r.controller_url))
            }
            (Some(NetStatus::Ready), None) => "Connected".into(),
            (Some(NetStatus::Error(e)), _) => format!("Online play unavailable:\n{e}"),
            (Some(NetStatus::Ended), _) => "Room closed".into(),
        };
        if let Ok(mut t) = texts.get_mut(panel.hint) {
            if t.0 != hint {
                t.0 = hint;
            }
        }
        let room_id = room.map(|r| r.room_id.clone());
        if panel.shown == room_id {
            continue;
        }
        panel.shown = room_id;
        if let Ok(mut t) = texts.get_mut(panel.code) {
            t.0 = room.map(|r| r.join_code.clone()).unwrap_or_default();
        }
        if let Ok((mut node, mut vis)) = nodes.get_mut(panel.qr) {
            match room.and_then(|r| qr_image(&r.controller_url)) {
                Some(img) => {
                    node.image = images.add(img);
                    *vis = Visibility::Inherited;
                }
                None => *vis = Visibility::Hidden,
            }
        }
    }
}

/// `https://host/a/controller/<id>` → `host/a/join` (where codes are typed).
fn join_page(controller_url: &str) -> String {
    let base = controller_url.split("/controller/").next().unwrap_or(controller_url);
    format!("{}/join", base.trim_start_matches("https://").trim_start_matches("http://"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_encodes_the_controller_url() {
        let url = "https://www.sterlinglong.me/bouncy-blobs/controller/8c1e7a2b-1234-4abc-8def-0123456789ab";
        let img = qr_image(url).unwrap();
        let w = img.texture_descriptor.size.width;
        assert_eq!(w, img.texture_descriptor.size.height);
        assert!(w >= 25 + 4, "QR too small: {w}");
        let data = img.data.as_ref().unwrap();
        assert_eq!(data.len(), (w * w * 4) as usize);
        // Quiet zone is white, the finder pattern corner is dark.
        assert_eq!(&data[0..3], &[255, 255, 255]);
        let o = ((2 * w + 2) * 4) as usize;
        assert_eq!(&data[o..o + 3], &[0x1a, 0x12, 0x24]);
        assert_eq!(join_page(url), "www.sterlinglong.me/bouncy-blobs/join");
    }
}
