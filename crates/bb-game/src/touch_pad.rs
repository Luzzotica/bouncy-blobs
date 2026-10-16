//! On-screen touch controls: the phone controller's square + band pad on
//! the left and the expand button on the right, drawn as glowing UI.
//!
//! Input lives in [`crate::input`] (`shape_pad`, `pad_layout`, `TouchPad`);
//! this only draws it. Shown in levels when touch is the local device (always
//! on iOS/Android; on desktop after a touch, or with `BB_TOUCH_PAD=1` for
//! screenshots).

use bevy::prelude::*;

use crate::flow::AppState;
use crate::input::{LastDevice, LocalDevices, PAD_BAND_HALF, TouchPad, pad_layout};
use crate::sim::Game;

pub struct TouchPadPlugin;

impl Plugin for TouchPadPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, draw);
    }
}

/// Lavender of the phone pad (#a78bfa) and the jelly button pink (#e8788a).
const LAV: (f32, f32, f32) = (0.655, 0.545, 0.98);
const PINK: (f32, f32, f32) = (0.91, 0.47, 0.54);

fn lav(a: f32) -> Color {
    Color::srgba(LAV.0, LAV.1, LAV.2, a)
}

fn pink(a: f32) -> Color {
    Color::srgba(PINK.0, PINK.1, PINK.2, a)
}

fn glow(color: Color, blur: f32) -> BoxShadow {
    BoxShadow::new(color, Val::ZERO, Val::ZERO, px(2.0), px(blur))
}

#[derive(Component)]
struct PadRoot;

/// The parts that change every frame.
#[derive(Component, Clone, Copy)]
enum Part {
    Frame,
    Up,
    Band,
    Down,
    /// Chevron pointing (0 up, 1 right, 2 down, 3 left).
    Arrow(u8),
    Thumb,
    Button,
}

fn wanted(
    state: &State<AppState>,
    story: Option<&crate::story::StoryFlow>,
    party: Option<&crate::party::Party>,
    devices: &LocalDevices,
    last: LastDevice,
    has_game: bool,
) -> bool {
    let in_level = match state.get() {
        AppState::Playing => true,
        // The party lobby is a menu: only rounds get the pad.
        AppState::Party => party.is_some_and(|p| !p.in_lobby()),
        AppState::Story => story.is_some_and(|s| s.phase == crate::story::Phase::Level),
        _ => false,
    };
    let touch = crate::platform::IS_MOBILE || last == LastDevice::Touch || std::env::var_os("BB_TOUCH_PAD").is_some();
    in_level && has_game && devices.touch_slot.is_some() && touch && !crate::capture::on()
}

fn spawn(commands: &mut Commands, font: Option<Handle<Font>>) {
    let abs = |left: f32, top: f32, w: f32, h: f32| Node {
        position_type: PositionType::Absolute,
        left: percent(left),
        top: percent(top),
        width: percent(w),
        height: percent(h),
        ..default()
    };
    // Zone split in pad-percent: the band is ±PAD_BAND_HALF of the half-side.
    let band_top = 50.0 - PAD_BAND_HALF * 50.0;
    let band_h = PAD_BAND_HALF * 100.0;
    // A zero-size anchor at the top-left: the parts are placed in px from it,
    // so nothing covers the screen (menu buttons stay reachable).
    let anchor = Node { position_type: PositionType::Absolute, left: px(0.0), top: px(0.0), ..default() };
    commands
        .spawn((PadRoot, anchor, GlobalZIndex(5), Visibility::Hidden))
        .with_children(|root| {
            root.spawn((
                Part::Frame,
                Node {
                    position_type: PositionType::Absolute,
                    border: UiRect::all(px(2.0)),
                    border_radius: BorderRadius::all(px(18.0)),
                    overflow: Overflow::clip(),
                    ..default()
                },
                BackgroundColor(Color::srgba(0.1, 0.1, 0.2, 0.35)),
                BorderColor::all(lav(0.55)),
                glow(lav(0.35), 16.0),
            ))
            .with_children(|f| {
                f.spawn((Part::Up, abs(0.0, 0.0, 100.0, band_top), BackgroundColor(lav(0.0))));
                f.spawn((Part::Down, abs(0.0, band_top + band_h, 100.0, band_top), BackgroundColor(lav(0.0))));
                f.spawn((
                    Part::Band,
                    Node { border: UiRect::vertical(px(2.0)), ..abs(0.0, band_top, 100.0, band_h) },
                    BackgroundColor(lav(0.16)),
                    BorderColor::all(lav(0.5)),
                ));
                // Chevrons: a square with two borders, turned to point.
                for (dir, (x, y)) in [(0u8, (50.0, band_top * 0.5)), (1, (82.0, 50.0)), (2, (50.0, 100.0 - band_top * 0.5)), (3, (18.0, 50.0))] {
                    f.spawn((
                        Part::Arrow(dir),
                        Node {
                            position_type: PositionType::Absolute,
                            left: percent(x),
                            top: percent(y),
                            width: px(12.0),
                            height: px(12.0),
                            margin: UiRect { left: px(-6.0), top: px(-6.0), ..default() },
                            border: UiRect { top: px(3.0), left: px(3.0), ..default() },
                            ..default()
                        },
                        BorderColor::all(lav(0.6)),
                        UiTransform { rotation: Rot2::degrees(45.0 + 90.0 * dir as f32), ..default() },
                    ));
                }
            });
            root.spawn((
                Part::Thumb,
                Node { position_type: PositionType::Absolute, border_radius: BorderRadius::all(px(12.0)), ..default() },
                BackgroundColor(lav(0.85)),
                glow(lav(0.5), 14.0),
            ));
            let mut label = root.spawn((
                Part::Button,
                Node {
                    position_type: PositionType::Absolute,
                    border: UiRect::all(px(2.0)),
                    border_radius: BorderRadius::MAX,
                    justify_content: JustifyContent::Center,
                    align_items: AlignItems::Center,
                    ..default()
                },
                BackgroundColor(pink(0.18)),
                BorderColor::all(pink(0.6)),
                glow(pink(0.3), 18.0),
            ));
            label.with_children(|b| {
                let mut tf = TextFont::from_font_size(16.0);
                if let Some(font) = font {
                    tf.font = font.into();
                }
                b.spawn((Text::new("EXPAND"), tf, TextColor(Color::srgba(1.0, 1.0, 1.0, 0.75))));
            });
        });
}

#[allow(clippy::too_many_arguments)]
fn draw(
    mut commands: Commands,
    roots: Query<Entity, With<PadRoot>>,
    mut vis: Query<&mut Visibility, With<PadRoot>>,
    mut parts: Query<(&Part, &mut Node, Option<&mut BackgroundColor>, Option<&mut BorderColor>), Without<PadRoot>>,
    (state, story, party, devices, last, game): (Option<Res<State<AppState>>>, Option<Res<crate::story::StoryFlow>>, Option<Res<crate::party::Party>>, Res<LocalDevices>, Res<LastDevice>, Option<Res<Game>>),
    pad: Res<TouchPad>,
    windows: Query<&Window>,
    assets: Option<Res<crate::assets::GameAssets>>,
    time: Res<Time>,
) {
    let show = state.is_some_and(|state| wanted(&state, story.as_deref(), party.as_deref(), &devices, *last, game.is_some()));
    if roots.is_empty() {
        if show {
            spawn(&mut commands, assets.map(|a| a.font.clone()));
        }
        return;
    }
    for mut v in &mut vis {
        let want = if show { Visibility::Inherited } else { Visibility::Hidden };
        if *v != want {
            *v = want;
        }
    }
    if !show {
        return;
    }
    let Some(window) = windows.iter().next() else { return };
    let l = pad_layout(window.size());
    let touching = pad.pad_id.is_some();
    let pulse = 0.5 + 0.5 * (time.elapsed_secs() * 3.0).sin();
    let thumb = l.half * 0.58;
    let travel = l.half - thumb * 0.5 - 4.0;
    for (part, mut node, bg, border) in &mut parts {
        match part {
            Part::Frame => {
                node.left = px(l.center.x - l.half);
                node.top = px(l.center.y - l.half);
                node.width = px(l.half * 2.0);
                node.height = px(l.half * 2.0);
                if let Some(mut b) = border {
                    *b = BorderColor::all(lav(if touching { 0.85 } else { 0.5 }));
                }
            }
            Part::Up | Part::Down | Part::Band => {
                let lit = match part {
                    Part::Up => pad.out.y < 0.0,
                    Part::Down => pad.out.y > 0.0,
                    _ => pad.out.y == 0.0 && pad.out.x != 0.0,
                };
                let base = if matches!(part, Part::Band) { 0.16 } else { 0.0 };
                if let Some(mut c) = bg {
                    c.0 = lav(if lit { 0.38 } else { base });
                }
            }
            Part::Arrow(dir) => {
                let lit = match dir {
                    0 => pad.out.y < 0.0,
                    1 => pad.out.x > 0.0,
                    2 => pad.out.y > 0.0,
                    _ => pad.out.x < 0.0,
                };
                if let Some(mut b) = border {
                    let c = if lit { Color::srgba(1.0, 1.0, 1.0, 0.95) } else { lav(0.6) };
                    *b = BorderColor { top: c, left: c, right: Color::NONE, bottom: Color::NONE };
                }
            }
            Part::Thumb => {
                let at = l.center + pad.thumb * travel;
                node.left = px(at.x - thumb * 0.5);
                node.top = px(at.y - thumb * 0.5);
                node.width = px(thumb);
                node.height = px(thumb);
                if let Some(mut c) = bg {
                    c.0 = lav(if touching { 0.95 } else { 0.55 });
                }
            }
            Part::Button => {
                let r = l.button_radius * if pad.button { 1.12 } else { 1.0 };
                node.left = px(l.button_center.x - r);
                node.top = px(l.button_center.y - r);
                node.width = px(r * 2.0);
                node.height = px(r * 2.0);
                if let Some(mut c) = bg {
                    c.0 = pink(if pad.button { 0.55 } else { 0.14 + 0.06 * pulse });
                }
                if let Some(mut b) = border {
                    *b = BorderColor::all(pink(if pad.button { 0.95 } else { 0.55 }));
                }
            }
        }
    }
}
