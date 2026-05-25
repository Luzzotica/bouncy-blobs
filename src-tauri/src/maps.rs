use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error, Serialize)]
pub enum MapsError {
    #[error("io: {0}")]
    Io(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid map id")]
    InvalidId,
}

impl From<std::io::Error> for MapsError {
    fn from(e: std::io::Error) -> Self {
        MapsError::Io(e.to_string())
    }
}

#[derive(Debug, Serialize)]
pub struct LocalMap {
    pub id: String,
    pub path: String,
    pub name: String,
    pub workshop_id: Option<String>,
    pub updated_at_ms: i64,
}

/// On-disk format. The `level` field is the existing `LevelData` JSON from the editor.
#[derive(Debug, Serialize, Deserialize)]
pub struct MapFile {
    pub workshop_id: Option<String>,
    pub updated_at_ms: i64,
    pub level: serde_json::Value,
}

fn maps_dir(app: &AppHandle) -> Result<PathBuf, MapsError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| MapsError::Io(e.to_string()))?;
    let dir = base.join("maps");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn map_path(app: &AppHandle, id: &str) -> Result<PathBuf, MapsError> {
    if !valid_id(id) {
        return Err(MapsError::InvalidId);
    }
    Ok(maps_dir(app)?.join(format!("{}.json", id)))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn level_name(level: &serde_json::Value) -> String {
    level
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string()
}

#[tauri::command]
pub fn maps_list(app: AppHandle) -> Result<Vec<LocalMap>, MapsError> {
    let dir = maps_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let mf: MapFile = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(LocalMap {
            id,
            path: path.to_string_lossy().into_owned(),
            name: level_name(&mf.level),
            workshop_id: mf.workshop_id,
            updated_at_ms: mf.updated_at_ms,
        });
    }
    out.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    Ok(out)
}

#[tauri::command]
pub fn maps_read(app: AppHandle, id: String) -> Result<MapFile, MapsError> {
    let path = map_path(&app, &id)?;
    let bytes = fs::read(&path).map_err(|_| MapsError::NotFound(id.clone()))?;
    let mf: MapFile = serde_json::from_slice(&bytes).map_err(|e| MapsError::Io(e.to_string()))?;
    Ok(mf)
}

#[derive(Debug, Deserialize)]
pub struct WriteArgs {
    pub id: Option<String>,
    pub workshop_id: Option<String>,
    pub level: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct WriteResult {
    pub id: String,
    pub path: String,
    pub updated_at_ms: i64,
}

#[tauri::command]
pub fn maps_write(app: AppHandle, args: WriteArgs) -> Result<WriteResult, MapsError> {
    let id = args.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let path = map_path(&app, &id)?;
    let mf = MapFile {
        workshop_id: args.workshop_id,
        updated_at_ms: now_ms(),
        level: args.level,
    };
    let json = serde_json::to_vec_pretty(&mf).map_err(|e| MapsError::Io(e.to_string()))?;
    fs::write(&path, json)?;
    Ok(WriteResult {
        id,
        path: path.to_string_lossy().into_owned(),
        updated_at_ms: mf.updated_at_ms,
    })
}

#[tauri::command]
pub fn maps_delete(app: AppHandle, id: String) -> Result<(), MapsError> {
    let path = map_path(&app, &id)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

#[tauri::command]
pub fn maps_export(app: AppHandle, id: String, dest: String) -> Result<(), MapsError> {
    let src = map_path(&app, &id)?;
    let mf = maps_read(app, id)?;
    // Exported file is just the LevelData JSON (no header) so it's portable.
    let json = serde_json::to_vec_pretty(&mf.level).map_err(|e| MapsError::Io(e.to_string()))?;
    fs::write(Path::new(&dest), json)?;
    let _ = src; // silence unused; src exists implicitly via maps_read
    Ok(())
}

#[tauri::command]
pub fn maps_import(app: AppHandle, src: String) -> Result<WriteResult, MapsError> {
    let bytes = fs::read(Path::new(&src))?;
    let level: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| MapsError::Io(e.to_string()))?;
    maps_write(
        app,
        WriteArgs {
            id: None,
            workshop_id: None,
            level,
        },
    )
}

/// Open the OS file manager so the user can see the map file. On macOS this
/// uses `open -R` to reveal-and-select the file in Finder; on Windows we use
/// `explorer /select,`; on Linux we just open the parent directory.
#[tauri::command]
pub fn maps_reveal(app: AppHandle, id: String) -> Result<(), MapsError> {
    let path = map_path(&app, &id)?;
    if !path.exists() {
        return Err(MapsError::NotFound(id));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| MapsError::Io(e.to_string()))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .spawn()
            .map_err(|e| MapsError::Io(e.to_string()))?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = path.parent().unwrap_or(&path);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| MapsError::Io(e.to_string()))?;
    }
    Ok(())
}

/// Returns the directory path where a map is stored, suitable for passing to
/// `ISteamUGC::SetItemContent`. The Workshop upload uses an entire directory,
/// so we synthesize a per-map staging dir under app_data/workshop_staging/<id>/.
#[tauri::command]
pub fn maps_staging_dir(app: AppHandle, id: String) -> Result<String, MapsError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| MapsError::Io(e.to_string()))?;
    let staging = base.join("workshop_staging").join(&id);
    fs::create_dir_all(&staging)?;
    // Copy the level JSON in as level.json so Workshop content always has a stable name.
    let mf = maps_read(app, id)?;
    let level_json =
        serde_json::to_vec_pretty(&mf.level).map_err(|e| MapsError::Io(e.to_string()))?;
    fs::write(staging.join("level.json"), level_json)?;
    Ok(staging.to_string_lossy().into_owned())
}
