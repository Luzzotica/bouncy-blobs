use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use steamworks::{
    AppId, Client, FileType, PublishedFileId, PublishedFileVisibility, SResult, SingleClient,
};
use tauri::{AppHandle, Manager, State};
use thiserror::Error;
use tokio::sync::oneshot;

pub const APP_ID: u32 = 4485010;

#[derive(Debug, Error, Serialize)]
pub enum SteamCmdError {
    #[error("Steam is not running or initialization failed")]
    NotInitialized,
    #[error("Steamworks error: {0}")]
    Sdk(String),
    #[error("io error: {0}")]
    Io(String),
}

impl From<steamworks::SteamError> for SteamCmdError {
    fn from(e: steamworks::SteamError) -> Self {
        SteamCmdError::Sdk(e.to_string())
    }
}

pub struct SteamState {
    inner: Mutex<Option<Arc<Client>>>,
}

impl SteamState {
    pub fn empty() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub fn set(&self, client: Arc<Client>) {
        *self.inner.lock() = Some(client);
    }

    pub fn client(&self) -> Result<Arc<Client>, SteamCmdError> {
        self.inner
            .lock()
            .as_ref()
            .cloned()
            .ok_or(SteamCmdError::NotInitialized)
    }
}

/// Initialize Steam on app startup. Spawns the callback pump on a dedicated thread.
/// Failure is non-fatal — the app should still run for local-only map editing.
pub fn init(app: &AppHandle) {
    match Client::init_app(AppId(APP_ID)) {
        Ok((client, single)) => {
            log::info!("Steam initialized for app {}", APP_ID);
            let state = app.state::<SteamState>();
            state.set(Arc::new(client));
            spawn_callback_pump(single);
        }
        Err(e) => {
            log::warn!(
                "Steam init failed ({}). App will run without Steam features.",
                e
            );
        }
    }
}

fn spawn_callback_pump(single: SingleClient) {
    // SingleClient is !Send + !Sync — it must live on its own thread.
    std::thread::Builder::new()
        .name("steam-callbacks".into())
        .spawn(move || loop {
            single.run_callbacks();
            std::thread::sleep(Duration::from_millis(50));
        })
        .expect("spawn steam callback thread");
}

#[derive(Debug, Deserialize)]
pub struct PublishMeta {
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub visibility: String, // "public" | "friends" | "private"
    /// Absolute path to a directory whose contents become the workshop item payload.
    pub content_dir: String,
    /// Absolute path to a PNG/JPG used as the preview/thumbnail.
    pub preview_path: Option<String>,
    pub change_note: Option<String>,
}

fn parse_visibility(s: &str) -> PublishedFileVisibility {
    match s.to_ascii_lowercase().as_str() {
        "public" => PublishedFileVisibility::Public,
        "friends" => PublishedFileVisibility::FriendsOnly,
        _ => PublishedFileVisibility::Private,
    }
}

#[derive(Debug, Serialize)]
pub struct PublishResult {
    pub workshop_id: u64,
    pub needs_legal_agreement: bool,
}

#[tauri::command]
pub async fn workshop_publish(
    state: State<'_, SteamState>,
    meta: PublishMeta,
) -> Result<PublishResult, SteamCmdError> {
    let client = state.client()?;

    // Scope the UGC handle (which is !Send) so it doesn't cross the await below.
    let rx = {
        let (tx, rx) = oneshot::channel::<SResult<(PublishedFileId, bool)>>();
        client.ugc().create_item(
            AppId(APP_ID),
            FileType::Community,
            move |result| {
                let _ = tx.send(result);
            },
        );
        rx
    };
    let create = rx
        .await
        .map_err(|_| SteamCmdError::Sdk("create_item callback dropped".into()))??;

    submit_update(&client, create.0, &meta).await?;

    Ok(PublishResult {
        workshop_id: create.0.0,
        needs_legal_agreement: create.1,
    })
}

#[tauri::command]
pub async fn workshop_update(
    state: State<'_, SteamState>,
    workshop_id: u64,
    meta: PublishMeta,
) -> Result<PublishResult, SteamCmdError> {
    let client = state.client()?;
    let id = PublishedFileId(workshop_id);
    submit_update(&client, id, &meta).await?;
    Ok(PublishResult {
        workshop_id,
        needs_legal_agreement: false,
    })
}

async fn submit_update(
    client: &Client,
    id: PublishedFileId,
    meta: &PublishMeta,
) -> Result<(), SteamCmdError> {
    // Scope the UpdateHandle (!Send) so it doesn't cross the await.
    let rx = {
        let mut handle = client
            .ugc()
            .start_item_update(AppId(APP_ID), id)
            .title(&meta.title)
            .description(&meta.description)
            .visibility(parse_visibility(&meta.visibility))
            .content_path(std::path::Path::new(&meta.content_dir))
            .tags(meta.tags.clone(), false);

        if let Some(preview) = &meta.preview_path {
            handle = handle.preview_path(std::path::Path::new(preview));
        }

        let note = meta.change_note.clone().unwrap_or_default();
        let (tx, rx) = oneshot::channel::<SResult<(PublishedFileId, bool)>>();
        handle.submit(Some(&note), move |result| {
            let _ = tx.send(result);
        });
        rx
    };

    let submit = rx
        .await
        .map_err(|_| SteamCmdError::Sdk("submit callback dropped".into()))??;
    log::info!(
        "Workshop submit complete for {}: legal_agreement_needed={}",
        submit.0 .0,
        submit.1
    );
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct SubscribedItem {
    pub workshop_id: u64,
    pub install_dir: Option<String>,
    pub size_bytes: u64,
    pub installed: bool,
}

#[tauri::command]
pub fn workshop_list_subscribed(
    state: State<'_, SteamState>,
) -> Result<Vec<SubscribedItem>, SteamCmdError> {
    let client = state.client()?;
    let ugc = client.ugc();
    let ids = ugc.subscribed_items();

    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let info = ugc.item_install_info(id);
        let state_flags = ugc.item_state(id);
        out.push(SubscribedItem {
            workshop_id: id.0,
            install_dir: info.as_ref().map(|i| i.folder.clone()),
            size_bytes: info.as_ref().map(|i| i.size_on_disk).unwrap_or(0),
            installed: state_flags.contains(steamworks::ItemState::INSTALLED),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn workshop_open_in_overlay(
    state: State<'_, SteamState>,
    workshop_id: u64,
) -> Result<(), SteamCmdError> {
    let client = state.client()?;
    client
        .friends()
        .activate_game_overlay_to_web_page(&format!(
            "https://steamcommunity.com/sharedfiles/filedetails/?id={}",
            workshop_id
        ));
    Ok(())
}

#[tauri::command]
pub fn steam_available(state: State<'_, SteamState>) -> bool {
    state.client().is_ok()
}

// ── Workshop browse / subscribe ──────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct WorkshopItemDetail {
    pub workshop_id: u64,
    pub title: String,
    pub description: String,
    pub owner_steam_id: u64,
    pub preview_url: Option<String>,
    pub tags: Vec<String>,
    pub time_updated: u32,
    pub num_upvotes: u32,
    pub num_downvotes: u32,
    pub file_size: u32,
    pub installed: bool,
    pub install_dir: Option<String>,
}

#[tauri::command]
pub async fn workshop_subscribe(
    state: State<'_, SteamState>,
    workshop_id: u64,
) -> Result<(), SteamCmdError> {
    let client = state.client()?;
    let rx = {
        let (tx, rx) = oneshot::channel::<Result<(), steamworks::SteamError>>();
        client
            .ugc()
            .subscribe_item(PublishedFileId(workshop_id), move |r| {
                let _ = tx.send(r);
            });
        rx
    };
    rx.await
        .map_err(|_| SteamCmdError::Sdk("subscribe callback dropped".into()))??;
    // Kick off a download immediately. Returns false if download couldn't start
    // (item not subscribed, etc.) — we ignore the bool since subscribe just
    // succeeded; Steam will retry on its own if needed.
    let _ = client
        .ugc()
        .download_item(PublishedFileId(workshop_id), true);
    Ok(())
}

#[tauri::command]
pub async fn workshop_unsubscribe(
    state: State<'_, SteamState>,
    workshop_id: u64,
) -> Result<(), SteamCmdError> {
    let client = state.client()?;
    let rx = {
        let (tx, rx) = oneshot::channel::<Result<(), steamworks::SteamError>>();
        client
            .ugc()
            .unsubscribe_item(PublishedFileId(workshop_id), move |r| {
                let _ = tx.send(r);
            });
        rx
    };
    rx.await
        .map_err(|_| SteamCmdError::Sdk("unsubscribe callback dropped".into()))??;
    Ok(())
}

#[tauri::command]
pub async fn workshop_item_details(
    state: State<'_, SteamState>,
    workshop_ids: Vec<u64>,
) -> Result<Vec<WorkshopItemDetail>, SteamCmdError> {
    if workshop_ids.is_empty() {
        return Ok(Vec::new());
    }
    let client = state.client()?;

    // Capture install state synchronously up-front (item_state/item_install_info
    // are immediate calls and don't need a query roundtrip).
    let install_info: Vec<(bool, Option<String>)> = workshop_ids
        .iter()
        .map(|id| {
            let pid = PublishedFileId(*id);
            let installed = client
                .ugc()
                .item_state(pid)
                .contains(steamworks::ItemState::INSTALLED);
            let dir = client.ugc().item_install_info(pid).map(|i| i.folder);
            (installed, dir)
        })
        .collect();

    let ids: Vec<PublishedFileId> = workshop_ids.iter().copied().map(PublishedFileId).collect();
    let query = client
        .ugc()
        .query_items(ids)
        .map_err(|_| SteamCmdError::Sdk("query_items failed to create".into()))?;

    type DetailRow = (u64, String, String, u64, Option<String>, Vec<String>, u32, u32, u32, u32);
    let rx = {
        let (tx, rx) = oneshot::channel::<Result<Vec<DetailRow>, steamworks::SteamError>>();
        query.fetch(move |res| {
            let mapped = res.map(|qr| {
                let mut out: Vec<DetailRow> = Vec::with_capacity(qr.returned_results() as usize);
                for i in 0..qr.returned_results() {
                    let preview = qr.preview_url(i);
                    if let Some(item) = qr.get(i) {
                        out.push((
                            item.published_file_id.0,
                            item.title,
                            item.description,
                            item.owner.raw(),
                            preview,
                            item.tags,
                            item.time_updated,
                            item.num_upvotes,
                            item.num_downvotes,
                            item.file_size,
                        ));
                    }
                }
                out
            });
            let _ = tx.send(mapped);
        });
        rx
    };

    let rows = rx
        .await
        .map_err(|_| SteamCmdError::Sdk("query callback dropped".into()))??;

    let mut details = Vec::with_capacity(rows.len());
    for row in rows {
        // Find the install-info entry for this row (by workshop_id, since
        // Steam may return results in a different order than requested).
        let (installed, install_dir) = workshop_ids
            .iter()
            .position(|id| *id == row.0)
            .and_then(|idx| install_info.get(idx).cloned())
            .unwrap_or((false, None));

        details.push(WorkshopItemDetail {
            workshop_id: row.0,
            title: row.1,
            description: row.2,
            owner_steam_id: row.3,
            preview_url: row.4,
            tags: row.5,
            time_updated: row.6,
            num_upvotes: row.7,
            num_downvotes: row.8,
            file_size: row.9,
            installed,
            install_dir,
        });
    }
    Ok(details)
}

/// Read the level.json from a subscribed Workshop item's install dir. The
/// publish flow stages each map as `<staging>/level.json`, so subscribed
/// items always have a `level.json` at the root of their install dir.
#[tauri::command]
pub fn workshop_read_level(
    state: State<'_, SteamState>,
    workshop_id: u64,
) -> Result<String, SteamCmdError> {
    let client = state.client()?;
    let info = client
        .ugc()
        .item_install_info(PublishedFileId(workshop_id))
        .ok_or_else(|| SteamCmdError::Sdk("item not installed".into()))?;
    let level_path = std::path::Path::new(&info.folder).join("level.json");
    std::fs::read_to_string(&level_path).map_err(|e| SteamCmdError::Io(e.to_string()))
}

/// Open the game's Workshop browse page in the Steam overlay (no specific item).
#[tauri::command]
pub fn workshop_browse_overlay(state: State<'_, SteamState>) -> Result<(), SteamCmdError> {
    let client = state.client()?;
    client
        .friends()
        .activate_game_overlay_to_web_page(&format!(
            "https://steamcommunity.com/app/{}/workshop/",
            APP_ID
        ));
    Ok(())
}
