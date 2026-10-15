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
        app.add_systems(OnExit(AppState::Playing), leave_on_exit);
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
