//! The "join on your phone" panel: QR code + room code + status.
//!
//! Menu code calls [`spawn_join_panel`] once; the panel fills itself in when
//! the room is ready and follows status changes. The panel also shows on the
//! title's Multiplayer page while the home room is open, so phones can join
//! from the menu.
//!
//! Join-UI rules (copied from Tankii, partii playbook §3):
//! * **Streamer mode** (Settings, saved, off by default) hides every code
//!   and QR: the code shows dots and the QR shows HIDDEN. Copy still copies
//!   the real code.
//! * **Copy**: click the code chip (or press C) and the chip itself flips
//!   to COPIED for [`COPIED_SECS`]; its width is reserved so nothing jumps.
//! * **Layout**: the panel keeps clear of the screen edge ([`EDGE_MARGIN`])
//!   and the phone notch ([`crate::platform::SAFE_SIDE`]), and the QR sizes
//!   itself from the screen's short side.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use bevy::asset::RenderAssetUsages;
use bevy::image::ImageSampler;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};

use super::{NetSession, NetStatus};

/// How long the code chip says COPIED.
pub const COPIED_SECS: f64 = 1.5;
/// Gap between the panel and the screen edge (logical px).
pub const EDGE_MARGIN: f32 = 16.0;
/// What the QR shows in streamer mode.
pub const HIDDEN: &str = "HIDDEN";
const COPIED: &str = "COPIED";
/// Save key for streamer mode.
const STREAMER_KEY: &str = "streamer_mode";

fn streamer_flag() -> &'static AtomicBool {
    static FLAG: OnceLock<AtomicBool> = OnceLock::new();
    FLAG.get_or_init(|| {
        // `BB_STREAMER=1` forces it on (headless screenshots).
        #[cfg(not(target_arch = "wasm32"))]
        if let Ok(v) = std::env::var("BB_STREAMER") {
            return AtomicBool::new(v != "0");
        }
        AtomicBool::new(!cfg!(test) && crate::save::get(STREAMER_KEY).as_deref() == Some("1"))
    })
}

/// Streamer mode: hide room codes and QR codes everywhere.
pub fn streamer() -> bool {
    streamer_flag().load(Ordering::Relaxed)
}

/// Turn streamer mode on or off (saved).
pub fn set_streamer(on: bool) {
    streamer_flag().store(on, Ordering::Relaxed);
    crate::save::set(STREAMER_KEY, if on { "1" } else { "0" });
}

/// The code as it may be shown right now.
pub fn display_code(code: &str) -> String {
    if streamer() { bb_net::play::masked_code(code) } else { code.to_string() }
}

#[derive(Component)]
pub struct JoinPanel {
    qr: Entity,
    hidden: Entity,
    chip: Entity,
    code: Entity,
    copy: Entity,
    hint: Entity,
    /// (room id, streamer) the QR currently shows.
    shown: Option<(String, bool)>,
    /// Real time (s) of the last copy.
    copied_at: Option<f64>,
    styled: bool,
}

/// The code chip: clicking it copies the room code.
#[derive(Component)]
pub struct CopyChip;

/// The panel spawned for the title's Multiplayer page.
#[derive(Component)]
pub struct MenuJoinPanel;

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

/// QR side (logical px) for a screen whose short side is `short`.
pub fn qr_side(short: f32) -> f32 {
    (short * 0.26).clamp(120.0, 220.0)
}

/// Spawn the panel (top-right overlay). Returns the root entity; despawn it
/// to hide.
pub fn spawn_join_panel(commands: &mut Commands) -> Entity {
    let side = qr_side(720.0);
    let qr = commands
        .spawn((
            Node { width: Val::Px(side), height: Val::Px(side), ..default() },
            BackgroundColor(Color::WHITE),
            ImageNode::default(),
            Visibility::Hidden,
        ))
        .id();
    // Streamer mode: the same box, with no code in it.
    let hidden = commands
        .spawn((
            Node {
                width: Val::Px(side),
                height: Val::Px(side),
                align_items: AlignItems::Center,
                justify_content: JustifyContent::Center,
                border: UiRect::all(Val::Px(3.0)),
                border_radius: BorderRadius::all(Val::Px(10.0)),
                display: Display::None,
                ..default()
            },
            BackgroundColor(Color::srgb(0.2, 0.15, 0.28)),
            BorderColor::all(Color::srgba(1.0, 1.0, 1.0, 0.35)),
        ))
        .with_child((Text::new(HIDDEN), TextFont::from_font_size(30.0), TextColor(Color::srgba(1.0, 1.0, 1.0, 0.8))))
        .id();
    let code = commands
        .spawn((Text::new(""), TextFont::from_font_size(34.0), TextColor(Color::srgb(1.0, 0.85, 0.35))))
        .id();
    let copy = commands
        .spawn((Text::new("COPY"), TextFont::from_font_size(13.0), TextColor(Color::srgba(1.0, 1.0, 1.0, 0.6))))
        .id();
    let chip = commands
        .spawn((
            Button,
            Node {
                // Wide enough for the code and for COPIED: nothing jumps.
                min_width: Val::Px(190.0),
                height: Val::Px(50.0),
                padding: UiRect::horizontal(Val::Px(14.0)),
                column_gap: Val::Px(10.0),
                align_items: AlignItems::Center,
                justify_content: JustifyContent::Center,
                border: UiRect::all(Val::Px(2.0)),
                border_radius: BorderRadius::all(Val::Px(12.0)),
                ..default()
            },
            BackgroundColor(Color::srgba(1.0, 1.0, 1.0, 0.06)),
            BorderColor::all(Color::srgba(1.0, 0.85, 0.35, 0.45)),
            Visibility::Hidden,
            CopyChip,
        ))
        .id();
    commands.entity(chip).add_children(&[code, copy]);
    let hint = commands
        .spawn((Text::new("Creating room…"), TextFont::from_font_size(15.0), TextColor(Color::srgb(0.9, 0.88, 0.95)), TextLayout::justify(Justify::Center)))
        .id();
    let root = commands
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                top: Val::Px(EDGE_MARGIN),
                right: Val::Px(EDGE_MARGIN + crate::platform::SAFE_SIDE),
                flex_direction: FlexDirection::Column,
                align_items: AlignItems::Center,
                row_gap: Val::Px(8.0),
                padding: UiRect::all(Val::Px(14.0)),
                border_radius: BorderRadius::all(Val::Px(18.0)),
                ..default()
            },
            BackgroundColor(Color::srgba(0.12, 0.08, 0.18, 0.88)),
            JoinPanel { qr, hidden, chip, code, copy, hint, shown: None, copied_at: None, styled: false },
        ))
        .id();
    commands.entity(root).add_children(&[qr, hidden, chip, hint]);
    root
}

/// The room code a session shows (hosting: ours; a guest has none).
fn room_code(s: &NetSession) -> Option<&str> {
    s.room.as_ref().map(|r| r.join_code.as_str()).filter(|c| !c.is_empty())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn update_join_panels(
    session: Option<Res<NetSession>>,
    mut panels: Query<&mut JoinPanel>,
    images: Option<ResMut<Assets<Image>>>,
    mut nodes: Query<(&mut ImageNode, &mut Visibility), Without<CopyChip>>,
    mut boxes: Query<&mut Node>,
    mut chips: Query<&mut Visibility, With<CopyChip>>,
    mut texts: Query<&mut Text>,
    mut fonts: Query<&mut TextFont>,
    (assets, windows, time): (Option<Res<crate::assets::GameAssets>>, Query<&Window>, Res<Time<Real>>),
) {
    let Some(mut images) = images else { return };
    let now = time.elapsed_secs_f64();
    let streamer = streamer();
    let side = windows.iter().next().map_or(qr_side(720.0), |w| qr_side(w.width().min(w.height())));
    for mut panel in &mut panels {
        // The game's rounded font (it has the masking dots).
        if !panel.styled {
            if let Some(a) = &assets {
                for e in [panel.code, panel.copy] {
                    if let Ok(mut f) = fonts.get_mut(e) {
                        f.font = a.font.clone().into();
                    }
                }
                panel.styled = true;
            }
        }
        for e in [panel.qr, panel.hidden] {
            if let Ok(mut n) = boxes.get_mut(e) {
                if n.width != Val::Px(side) {
                    n.width = Val::Px(side);
                    n.height = Val::Px(side);
                }
            }
        }
        let (room, status) = match session.as_deref() {
            Some(s) => (s.room.as_ref(), Some(&s.status)),
            None => (None, None),
        };
        let hint = match (status, room) {
            (None, _) => "Not hosting".to_string(),
            (Some(NetStatus::Connecting), _) => session.as_deref().and_then(|s| s.notice.clone()).unwrap_or_else(|| "Creating room…".into()),
            (Some(NetStatus::Ready), Some(r)) => {
                let s = session.as_deref();
                let (n, what) = match s {
                    Some(s) if !s.seating => (s.phones(), "phone"),
                    Some(s) => (s.roster.len(), "player"),
                    None => (0, "player"),
                };
                let who = if n == 1 { format!("1 {what}") } else { format!("{n} {what}s") };
                let verb = if what == "phone" { "connected" } else { "joined" };
                format!("Scan to play on your phone\nor enter the code at {}\n{who} {verb}", join_page(&r.controller_url))
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
        // The chip: the code (or dots), COPIED for a moment after a copy.
        let code = session.as_deref().and_then(room_code).map(str::to_string);
        let copied = panel.copied_at.is_some_and(|t| now - t < COPIED_SECS);
        let (shown_code, label) = match &code {
            _ if copied => (COPIED.to_string(), ""),
            Some(c) => (display_code(c), "COPY"),
            None => (String::new(), ""),
        };
        for (e, want) in [(panel.code, shown_code.as_str()), (panel.copy, label)] {
            if let Ok(mut t) = texts.get_mut(e) {
                if t.0 != want {
                    t.0 = want.to_string();
                }
            }
        }
        if let Ok(mut v) = chips.get_mut(panel.chip) {
            let want = if code.is_some() { Visibility::Inherited } else { Visibility::Hidden };
            if *v != want {
                *v = want;
            }
        }
        // The QR, or HIDDEN in streamer mode.
        let key = room.map(|r| (r.room_id.clone(), streamer));
        if panel.shown == key {
            continue;
        }
        panel.shown = key;
        let qr = room.filter(|_| !streamer).and_then(|r| qr_image(&r.controller_url));
        if let Ok((mut node, mut vis)) = nodes.get_mut(panel.qr) {
            match qr {
                Some(img) => {
                    node.image = images.add(img);
                    *vis = Visibility::Inherited;
                }
                None => *vis = Visibility::Hidden,
            }
        }
        let show_qr = room.is_some() && !streamer;
        if let Ok(mut n) = boxes.get_mut(panel.qr) {
            n.display = if show_qr || room.is_none() { Display::Flex } else { Display::None };
        }
        if let Ok(mut n) = boxes.get_mut(panel.hidden) {
            n.display = if room.is_some() && streamer { Display::Flex } else { Display::None };
        }
    }
}

/// Copy the real room code (even in streamer mode) and flip the chip to
/// COPIED: a click on the chip, or C while a panel is up (one panel shows
/// at a time, so every panel flips).
#[allow(clippy::too_many_arguments)]
pub(crate) fn copy_clicks(
    chips: Query<&Interaction, (Changed<Interaction>, With<CopyChip>)>,
    mut panels: Query<&mut JoinPanel>,
    session: Option<Res<NetSession>>,
    keys: Option<Res<ButtonInput<KeyCode>>>,
    typing: Option<Res<crate::online::JoinDialog>>,
    time: Res<Time<Real>>,
    #[cfg(not(target_os = "android"))] mut clipboard: Option<ResMut<bevy_egui::EguiClipboard>>,
) {
    let Some(code) = session.as_deref().and_then(room_code).map(str::to_string) else { return };
    let clicked = chips.iter().any(|i| *i == Interaction::Pressed);
    let key = typing.is_none() && keys.is_some_and(|k| k.just_pressed(KeyCode::KeyC));
    if !(clicked || key) || panels.is_empty() {
        return;
    }
    #[cfg(not(target_os = "android"))]
    if let Some(c) = clipboard.as_deref_mut() {
        c.set_text(&code);
    }
    let now = time.elapsed_secs_f64();
    for mut p in &mut panels {
        p.copied_at = Some(now);
    }
    info!("net: copied the room code");
}

/// Show the join panel on the title's Multiplayer page while the home room
/// is open, so phones can join from the menu.
pub(crate) fn menu_join_panel(
    mut commands: Commands,
    state: Option<Res<State<crate::flow::AppState>>>,
    menu: Option<Res<crate::menu::Menu>>,
    session: Option<Res<NetSession>>,
    panels: Query<Entity, With<MenuJoinPanel>>,
) {
    let want = state.is_some_and(|s| *s.get() == crate::flow::AppState::Title)
        && menu.is_some_and(|m| m.page == crate::menu::Page::Party)
        && session.is_some_and(|s| s.home);
    match (want, panels.iter().next()) {
        (true, None) => {
            let e = spawn_join_panel(&mut commands);
            commands.entity(e).insert(MenuJoinPanel);
        }
        (false, Some(_)) => {
            for e in panels.iter() {
                commands.entity(e).despawn();
            }
        }
        _ => {}
    }
}

/// `https://host/c/CODE?…` → `host/join` (where codes are typed).
fn join_page(controller_url: &str) -> String {
    let path = controller_url.split('?').next().unwrap_or(controller_url);
    let base = ["/c/", "/controller/"].iter().find_map(|seg| path.rsplit_once(seg).map(|(b, _)| b)).unwrap_or(path);
    format!("{}/join", base.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_encodes_the_controller_url() {
        let url = "https://bouncy-blobs.partii.games/c/KXQPT?k=pk_bouncyblobs_game_x&e=https%3A%2F%2Fpartii-edge.partii-games.workers.dev&g=bouncy-blobs";
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
        assert_eq!(join_page(url), "bouncy-blobs.partii.games/join");
        assert_eq!(join_page("https://old.vercel.app/controller/ABCDE"), "old.vercel.app/join");
    }

    #[test]
    fn streamer_mode_masks_but_copy_keeps_the_code() {
        assert!(!streamer(), "off by default");
        assert_eq!(display_code("KXQPT"), "KXQPT");
        streamer_flag().store(true, Ordering::Relaxed);
        assert_eq!(display_code("KXQPT"), "•••••");
        streamer_flag().store(false, Ordering::Relaxed);
        // The game font draws everything the panel can show.
        assert!(crate::softtext::missing_glyphs("•COPIED HIDDEN").is_empty());
    }

    #[test]
    fn qr_fits_phones_and_tvs() {
        assert_eq!(qr_side(390.0), 120.0);
        assert_eq!(qr_side(2160.0), 220.0);
        assert!((qr_side(720.0) - 187.2).abs() < 0.01);
    }
}
