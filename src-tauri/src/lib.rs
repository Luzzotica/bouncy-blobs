mod maps;
mod steam;
mod steam_lobby;
mod steam_net;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(steam::SteamState::empty())
        .manage(Arc::new(steam_net::SteamNetState::empty()))
        .manage(Arc::new(steam_lobby::SteamLobbyState::empty()))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            steam::init(app.handle());
            let lobby_state = app.state::<Arc<steam_lobby::SteamLobbyState>>().inner().clone();
            steam_lobby::register_callbacks(app.handle().clone(), lobby_state);
            steam_lobby::forward_launch_connect_lobby(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            steam::workshop_publish,
            steam::workshop_update,
            steam::workshop_list_subscribed,
            steam::workshop_open_in_overlay,
            steam::workshop_subscribe,
            steam::workshop_unsubscribe,
            steam::workshop_item_details,
            steam::workshop_browse_overlay,
            steam::workshop_read_level,
            steam::steam_available,
            steam_net::steam_id_self,
            steam_net::steam_persona_name,
            steam_net::steam_net_listen,
            steam_net::steam_net_connect,
            steam_net::steam_net_send,
            steam_net::steam_net_send_bin,
            steam_net::steam_net_close,
            steam_net::steam_net_close_all,
            steam_lobby::steam_lobby_create,
            steam_lobby::steam_lobby_join,
            steam_lobby::steam_lobby_leave,
            steam_lobby::steam_lobby_invite_overlay,
            steam_lobby::steam_lobby_members,
            steam_lobby::steam_lobby_set_data,
            maps::maps_list,
            maps::maps_read,
            maps::maps_write,
            maps::maps_delete,
            maps::maps_export,
            maps::maps_import,
            maps::maps_staging_dir,
            maps::maps_reveal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
