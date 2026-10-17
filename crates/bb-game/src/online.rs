//! "Join a Friend": type a room code, join as a guest screen. The host
//! streams its level and players; we own and stream our own blob.

use bevy::prelude::*;
use bevy_egui::{EguiContexts, EguiPlugin, EguiPrimaryContextPass, egui};

use crate::flow::AppState;
use crate::net::NetCommand;
use crate::story::StoryProgress;

#[derive(Resource, Default)]
pub struct JoinDialog {
    pub code: String,
}

pub struct OnlinePlugin;

impl Plugin for OnlinePlugin {
    fn build(&self, app: &mut App) {
        // egui needs the render app; skip it in headless (MinimalPlugins) runs.
        if app.is_plugin_added::<bevy::render::RenderPlugin>() {
            if !app.is_plugin_added::<EguiPlugin>() {
                app.add_plugins(EguiPlugin::default());
            }
            app.add_systems(EguiPrimaryContextPass, dialog.run_if(resource_exists::<JoinDialog>));
        }
        app.add_systems(OnExit(AppState::Playing), (leave_on_exit, clear_wait))
            .add_systems(Update, waiting.run_if(in_state(AppState::Playing)));
    }
}

/// The screen while a join is connecting (free play with no level yet):
/// says what's happening and always has a way back to the title. Without
/// it a join that never connects was a blank screen with no way out (the
/// pause menu needs a level).
#[derive(Component)]
struct WaitUi;

#[derive(Component)]
struct WaitText;

#[allow(clippy::too_many_arguments)]
fn waiting(
    mut commands: Commands,
    game: Option<Res<crate::sim::Game>>,
    session: Option<Res<crate::net::NetSession>>,
    time: Res<Time>,
    mut since: Local<f32>,
    ui: Query<Entity, With<WaitUi>>,
    mut text: Query<&mut Text, With<WaitText>>,
    (keys, pads, mouse, touches, device, assets): (Res<ButtonInput<KeyCode>>, Query<&Gamepad>, Res<ButtonInput<MouseButton>>, Res<Touches>, Res<crate::input::LastDevice>, Res<crate::assets::GameAssets>),
    (mut next, mut unload): (ResMut<NextState<AppState>>, MessageWriter<crate::sim::UnloadLevel>),
) {
    if game.is_some() {
        *since = 0.0;
        for e in ui.iter() {
            commands.entity(e).despawn();
        }
        return;
    }
    // A level load takes a frame or two: only a real wait gets the screen.
    *since += time.delta_secs();
    if *since < 0.5 {
        return;
    }
    use crate::input::LastDevice::*;
    let how = match *device {
        Keyboard => "Press Esc to go back",
        Touch => "Tap to go back",
        Gamepad => "Press B to go back",
        Phone => "Press B to go back",
    };
    let what = match session.as_deref().map(|s| &s.status) {
        Some(crate::net::NetStatus::Error(e)) => format!("Couldn't join:\n{e}"),
        Some(crate::net::NetStatus::Ended) => "The game ended".to_string(),
        Some(_) => "Joining your friend's game...".to_string(),
        None => "Nothing to play here".to_string(),
    };
    let line = format!("{what}\n\n{how}");
    match text.iter_mut().next() {
        Some(mut t) => {
            if t.0 != line {
                t.0 = line;
            }
        }
        None => {
            commands
                .spawn((
                    WaitUi,
                    Node {
                        position_type: PositionType::Absolute,
                        width: percent(100.0),
                        height: percent(100.0),
                        justify_content: JustifyContent::Center,
                        align_items: AlignItems::Center,
                        padding: UiRect::all(px(32.0)),
                        ..default()
                    },
                ))
                .with_children(|p| {
                    p.spawn((
                        Text::new(line),
                        TextFont { font: assets.font_medium.clone().into(), font_size: 34.0.into(), ..default() },
                        TextColor(Color::WHITE),
                        TextLayout::justify(Justify::Center),
                        TextShadow { offset: Vec2::new(3.0, 4.0), color: Color::srgba(0.0, 0.0, 0.0, 0.6) },
                        WaitText,
                    ));
                });
        }
    }
    let tapped = mouse.just_pressed(MouseButton::Left) || touches.iter_just_pressed().next().is_some();
    if crate::input::back_pressed(&keys, pads.iter()) || tapped {
        unload.write(crate::sim::UnloadLevel);
        next.set(AppState::Title);
    }
}

fn clear_wait(mut commands: Commands, ui: Query<Entity, With<WaitUi>>) {
    for e in ui.iter() {
        commands.entity(e).despawn();
    }
}

fn dialog(
    mut commands: Commands,
    mut contexts: EguiContexts,
    mut d: ResMut<JoinDialog>,
    progress: Res<StoryProgress>,
    mut net: MessageWriter<NetCommand>,
    mut next: ResMut<NextState<AppState>>,
) -> Result {
    let ctx = contexts.ctx_mut()?;
    let mut close = false;
    egui::Window::new("Join a Friend")
        .collapsible(false)
        .resizable(false)
        .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
        .show(ctx, |ui| {
            ui.label("Enter the code on your friend's screen:");
            let r = ui.add(egui::TextEdit::singleline(&mut d.code).hint_text("ABCDEF").char_limit(8).desired_width(220.0));
            r.request_focus();
            d.code = d.code.to_uppercase();
            ui.horizontal(|ui| {
                let go = ui.button("Join!").clicked() || (r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)));
                if go && d.code.trim().len() >= 4 {
                    net.write(NetCommand::Join { room: d.code.trim().to_string(), name: "Pip".into(), color: progress.pip_color });
                    next.set(AppState::Playing);
                    close = true;
                }
                if ui.button("Cancel").clicked() {
                    close = true;
                }
            });
        });
    if close {
        commands.remove_resource::<JoinDialog>();
    }
    Ok(())
}

/// Leaving free play (pause → Title) also leaves any room we joined.
fn leave_on_exit(session: Option<Res<crate::net::NetSession>>, mut net: MessageWriter<NetCommand>) {
    if session.is_some() {
        net.write(NetCommand::Leave);
    }
}
