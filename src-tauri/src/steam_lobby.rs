// ─────────────────────────────────────────────────────────────────────────────
// Steam Lobbies — discovery + friend invites for Bouncy Blobs.
//
// A Steam Lobby is a small Valve-hosted room that holds a set of members and
// a key→value metadata map. We use it as the rendezvous for Steam Networking:
//
//   - Host calls `steam_lobby_create` → gets a LobbyId, sets `host_steam_id`
//     lobby metadata to its own SteamID.
//   - Host calls `steam_lobby_invite_overlay` → Steam shows the friend picker.
//   - Friend clicks "Join Game" or accepts an invite → either game launches
//     with `+connect_lobby <id>` (handled in lib.rs) or the running game
//     receives a `GameLobbyJoinRequested` callback (emitted as the
//     `steam_lobby://join_requested` Tauri event).
//   - Friend's game calls `steam_lobby_join(id)` → on success, reads the
//     host's SteamID from lobby data and emits `steam_lobby://joined`.
//   - Frontend then plugs that SteamID into the SteamTransport client path
//     (see steam_net.rs) to open P2P.
//
// Lobby member-list changes emit `steam_lobby://member_changed`. The frontend
// re-queries `steam_lobby_members` on receipt.
// ─────────────────────────────────────────────────────────────────────────────

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde::Serialize;
use steamworks::{
    CallbackHandle, ClientManager, GameLobbyJoinRequested, LobbyId, LobbyType,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::steam::{SteamCmdError, SteamState};

const LOBBY_KEY_HOST_STEAM_ID: &str = "host_steam_id";
const LOBBY_KEY_GAME: &str = "game";
const LOBBY_GAME_TAG: &str = "bouncy_blobs";

pub struct SteamLobbyState {
    inner: Mutex<Inner>,
    callbacks_registered: AtomicBool,
}

struct Inner {
    current: Option<LobbyId>,
    /// Held to keep the callback registrations alive for the process lifetime.
    _callback_handles: Vec<CallbackHandle<ClientManager>>,
}

impl SteamLobbyState {
    pub fn empty() -> Self {
        Self {
            inner: Mutex::new(Inner {
                current: None,
                _callback_handles: Vec::new(),
            }),
            callbacks_registered: AtomicBool::new(false),
        }
    }
}

// ── Callback registration (call once after Steam init) ──────────────────────

pub fn register_callbacks(app: AppHandle, state: Arc<SteamLobbyState>) {
    if state.callbacks_registered.swap(true, Ordering::SeqCst) {
        return;
    }
    let steam_state: State<'_, SteamState> = match app.try_state::<SteamState>() {
        Some(s) => s,
        None => return,
    };
    let Ok(client) = steam_state.client() else { return };

    let app_for_cb = app.clone();
    let handle = client.register_callback::<GameLobbyJoinRequested, _>(move |evt| {
        let _ = app_for_cb.emit(
            "steam_lobby://join_requested",
            JoinRequestedPayload {
                lobby_id: evt.lobby_steam_id.raw().to_string(),
                friend_steam_id: evt.friend_steam_id.raw().to_string(),
            },
        );
    });

    let app_for_chat = app.clone();
    let chat_handle = client.register_callback::<steamworks::LobbyChatUpdate, _>(move |evt| {
        use steamworks::ChatMemberStateChange::*;
        let state = match evt.member_state_change {
            Entered => "entered",
            Left => "left",
            Disconnected => "disconnected",
            Kicked => "kicked",
            _ => "other",
        };
        let _ = app_for_chat.emit(
            "steam_lobby://member_changed",
            MemberChangedPayload {
                lobby_id: evt.lobby.raw().to_string(),
                user_changed: evt.user_changed.raw().to_string(),
                state: state.into(),
            },
        );
    });

    let mut inner = state.inner.lock();
    inner._callback_handles.push(handle);
    inner._callback_handles.push(chat_handle);
}

/// If Steam launched us with `+connect_lobby <id>`, emit an event so the
/// frontend can auto-join. Call once from lib.rs setup.
pub fn forward_launch_connect_lobby(app: AppHandle) {
    let mut args = std::env::args().peekable();
    while let Some(a) = args.next() {
        if a == "+connect_lobby" {
            if let Some(id) = args.next() {
                let _ = app.emit(
                    "steam_lobby://launch_join",
                    LaunchJoinPayload { lobby_id: id },
                );
            }
            return;
        }
    }
}

// ── Event payloads ───────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct JoinRequestedPayload {
    lobby_id: String,
    friend_steam_id: String,
}

#[derive(Serialize, Clone)]
struct MemberChangedPayload {
    lobby_id: String,
    user_changed: String,
    state: String,
}

#[derive(Serialize, Clone)]
struct LaunchJoinPayload {
    lobby_id: String,
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct LobbyCreated {
    pub lobby_id: String,
}

#[derive(Serialize)]
pub struct LobbyJoined {
    pub lobby_id: String,
    pub host_steam_id: String,
    pub members: Vec<String>,
}

#[tauri::command]
pub async fn steam_lobby_create(
    steam_state: State<'_, SteamState>,
    lobby_state: State<'_, Arc<SteamLobbyState>>,
    max_members: u32,
    visibility: String, // "public" | "friends" | "private"
) -> Result<LobbyCreated, SteamCmdError> {
    let client = steam_state.client()?;
    let lobby_state = (*lobby_state).clone();

    let ty = match visibility.as_str() {
        "public" => LobbyType::Public,
        "private" => LobbyType::Private,
        _ => LobbyType::FriendsOnly,
    };

    let (tx, rx) = oneshot::channel();
    client.matchmaking().create_lobby(ty, max_members, move |result| {
        let _ = tx.send(result);
    });
    let lobby = rx
        .await
        .map_err(|_| SteamCmdError::Sdk("create_lobby callback dropped".into()))?
        .map_err(|e| SteamCmdError::Sdk(format!("create_lobby: {:?}", e)))?;

    // Stash the host's SteamID + a game tag in lobby data so joiners can find them.
    let mm = client.matchmaking();
    let self_id = client.user().steam_id().raw().to_string();
    mm.set_lobby_data(lobby, LOBBY_KEY_HOST_STEAM_ID, &self_id);
    mm.set_lobby_data(lobby, LOBBY_KEY_GAME, LOBBY_GAME_TAG);

    {
        let mut inner = lobby_state.inner.lock();
        inner.current = Some(lobby);
    }

    Ok(LobbyCreated {
        lobby_id: lobby.raw().to_string(),
    })
}

#[tauri::command]
pub async fn steam_lobby_join(
    steam_state: State<'_, SteamState>,
    lobby_state: State<'_, Arc<SteamLobbyState>>,
    lobby_id: String,
) -> Result<LobbyJoined, SteamCmdError> {
    let client = steam_state.client()?;
    let lobby_state = (*lobby_state).clone();
    let id: u64 = lobby_id
        .parse()
        .map_err(|_| SteamCmdError::Sdk("invalid lobby_id".into()))?;
    let lobby = LobbyId::from_raw(id);

    let (tx, rx) = oneshot::channel();
    client.matchmaking().join_lobby(lobby, move |r| {
        let _ = tx.send(r);
    });
    let joined_lobby = rx
        .await
        .map_err(|_| SteamCmdError::Sdk("join_lobby callback dropped".into()))?
        .map_err(|_| SteamCmdError::Sdk("join_lobby failed".into()))?;

    let mm = client.matchmaking();
    let host_steam_id = mm
        .lobby_data(joined_lobby, LOBBY_KEY_HOST_STEAM_ID)
        .unwrap_or("")
        .to_string();
    let members: Vec<String> = mm
        .lobby_members(joined_lobby)
        .into_iter()
        .map(|s| s.raw().to_string())
        .collect();

    {
        let mut inner = lobby_state.inner.lock();
        inner.current = Some(joined_lobby);
    }

    Ok(LobbyJoined {
        lobby_id: joined_lobby.raw().to_string(),
        host_steam_id,
        members,
    })
}

#[tauri::command]
pub fn steam_lobby_leave(
    steam_state: State<'_, SteamState>,
    lobby_state: State<'_, Arc<SteamLobbyState>>,
) -> Result<(), SteamCmdError> {
    let client = steam_state.client()?;
    let mut inner = lobby_state.inner.lock();
    if let Some(lobby) = inner.current.take() {
        client.matchmaking().leave_lobby(lobby);
    }
    Ok(())
}

#[tauri::command]
pub fn steam_lobby_invite_overlay(
    steam_state: State<'_, SteamState>,
    lobby_state: State<'_, Arc<SteamLobbyState>>,
) -> Result<(), SteamCmdError> {
    let client = steam_state.client()?;
    let inner = lobby_state.inner.lock();
    let lobby = inner
        .current
        .ok_or_else(|| SteamCmdError::Sdk("not in a lobby".into()))?;
    client.friends().activate_invite_dialog(lobby);
    Ok(())
}

#[tauri::command]
pub fn steam_lobby_members(
    steam_state: State<'_, SteamState>,
    lobby_state: State<'_, Arc<SteamLobbyState>>,
) -> Result<Vec<String>, SteamCmdError> {
    let client = steam_state.client()?;
    let inner = lobby_state.inner.lock();
    let Some(lobby) = inner.current else {
        return Ok(Vec::new());
    };
    Ok(client
        .matchmaking()
        .lobby_members(lobby)
        .into_iter()
        .map(|s| s.raw().to_string())
        .collect())
}

#[tauri::command]
pub fn steam_lobby_set_data(
    steam_state: State<'_, SteamState>,
    lobby_state: State<'_, Arc<SteamLobbyState>>,
    key: String,
    value: String,
) -> Result<(), SteamCmdError> {
    let client = steam_state.client()?;
    let inner = lobby_state.inner.lock();
    let lobby = inner
        .current
        .ok_or_else(|| SteamCmdError::Sdk("not in a lobby".into()))?;
    client.matchmaking().set_lobby_data(lobby, &key, &value);
    Ok(())
}
