//! Local map storage. Native: `<data dir>/me.sterlinglong.bouncyblobs/maps-v3/<id>.json`
//! (override with `BB_MAPS_DIR`). Web: localStorage `bb3:maps:index` +
//! `bb3:map:<id>`. Files are bare v3 level JSON so they double as exports.

use bb_level::Level;

#[derive(Clone, Debug)]
pub struct MapEntry {
    pub id: String,
    pub name: String,
    pub updated_ms: u64,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() < 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn now_ms() -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }
    #[cfg(target_arch = "wasm32")]
    {
        0
    }
}

/// A new unused id derived from `base`.
pub fn unique_id(base: &str) -> String {
    let base = bb_level::legacy::slugify(base);
    let taken: Vec<String> = list().into_iter().map(|m| m.id).collect();
    if !taken.contains(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}-{n}")).find(|s| !taken.contains(s)).unwrap()
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use super::*;
    use std::path::PathBuf;

    pub fn maps_dir() -> Option<PathBuf> {
        if let Ok(d) = std::env::var("BB_MAPS_DIR") {
            return Some(PathBuf::from(d));
        }
        dirs::data_dir().map(|d| d.join("me.sterlinglong.bouncyblobs").join("maps-v3"))
    }

    pub fn list() -> Vec<MapEntry> {
        let Some(dir) = maps_dir() else { return Vec::new() };
        let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
        let mut v: Vec<MapEntry> = rd
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                if p.extension()? != "json" {
                    return None;
                }
                let id = p.file_stem()?.to_string_lossy().to_string();
                let text = std::fs::read_to_string(&p).ok()?;
                let name = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
                    .unwrap_or_else(|| "Untitled".into());
                let updated_ms = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Some(MapEntry { id, name, updated_ms })
            })
            .collect();
        v.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
        v
    }

    pub fn read(id: &str) -> Result<String, String> {
        if !valid_id(id) {
            return Err(format!("bad map id '{id}'"));
        }
        let dir = maps_dir().ok_or("no data directory")?;
        std::fs::read_to_string(dir.join(format!("{id}.json"))).map_err(|e| e.to_string())
    }

    pub fn write(id: &str, json: &str) -> Result<String, String> {
        if !valid_id(id) {
            return Err(format!("bad map id '{id}'"));
        }
        let dir = maps_dir().ok_or("no data directory")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{id}.json"));
        std::fs::write(&path, json).map_err(|e| e.to_string())?;
        Ok(path.display().to_string())
    }

    pub fn delete(id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err(format!("bad map id '{id}'"));
        }
        let dir = maps_dir().ok_or("no data directory")?;
        std::fs::remove_file(dir.join(format!("{id}.json"))).map_err(|e| e.to_string())
    }

    /// Export a copy for sharing: `<maps dir>/../exports/<id>.json`.
    pub fn export(id: &str, json: &str) -> Result<String, String> {
        let dir = maps_dir().ok_or("no data directory")?.with_file_name("exports");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{}.json", bb_level::legacy::slugify(id)));
        std::fs::write(&path, json).map_err(|e| e.to_string())?;
        Ok(path.display().to_string())
    }

    pub fn read_path(path: &str) -> Result<String, String> {
        let p = path.trim().trim_matches('"').trim_matches('\'');
        let p = if let Some(rest) = p.strip_prefix("~/") {
            dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(p))
        } else {
            PathBuf::from(p)
        };
        std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))
    }

    pub fn location() -> String {
        maps_dir().map(|d| d.display().to_string()).unwrap_or_else(|| "(no data dir)".into())
    }
}

#[cfg(target_arch = "wasm32")]
mod imp {
    use super::*;

    const INDEX: &str = "bb3:maps:index";

    fn storage() -> Option<web_sys::Storage> {
        web_sys::window()?.local_storage().ok().flatten()
    }

    fn index() -> Vec<(String, String)> {
        storage()
            .and_then(|s| s.get_item(INDEX).ok().flatten())
            .and_then(|t| serde_json::from_str::<Vec<(String, String)>>(&t).ok())
            .unwrap_or_default()
    }

    fn set_index(v: &[(String, String)]) {
        if let Some(s) = storage() {
            let _ = s.set_item(INDEX, &serde_json::to_string(v).unwrap_or_default());
        }
    }

    pub fn list() -> Vec<MapEntry> {
        index().into_iter().map(|(id, name)| MapEntry { id, name, updated_ms: 0 }).collect()
    }

    pub fn read(id: &str) -> Result<String, String> {
        storage()
            .and_then(|s| s.get_item(&format!("bb3:map:{id}")).ok().flatten())
            .ok_or_else(|| format!("map '{id}' not found"))
    }

    pub fn write(id: &str, json: &str) -> Result<String, String> {
        if !valid_id(id) {
            return Err(format!("bad map id '{id}'"));
        }
        let s = storage().ok_or("localStorage unavailable")?;
        s.set_item(&format!("bb3:map:{id}"), json).map_err(|_| "localStorage write failed".to_string())?;
        let name = serde_json::from_str::<serde_json::Value>(json)
            .ok()
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
            .unwrap_or_default();
        let mut idx = index();
        idx.retain(|(i, _)| i != id);
        idx.insert(0, (id.to_string(), name));
        set_index(&idx);
        Ok(format!("localStorage bb3:map:{id}"))
    }

    pub fn delete(id: &str) -> Result<(), String> {
        let s = storage().ok_or("localStorage unavailable")?;
        let _ = s.remove_item(&format!("bb3:map:{id}"));
        let mut idx = index();
        idx.retain(|(i, _)| i != id);
        set_index(&idx);
        Ok(())
    }

    pub fn export(_id: &str, _json: &str) -> Result<String, String> {
        Err("use Copy JSON on the web".into())
    }

    pub fn read_path(_path: &str) -> Result<String, String> {
        Err("paste the JSON instead (no file system on the web)".into())
    }

    pub fn location() -> String {
        "browser localStorage".into()
    }
}

pub use imp::{export, list, location, read, read_path};
#[cfg(not(target_arch = "wasm32"))]
pub(crate) use imp::maps_dir;

/// Write a map file (and roam it on native).
pub fn write(id: &str, json: &str) -> Result<String, String> {
    let r = imp::write(id, json);
    #[cfg(not(target_arch = "wasm32"))]
    if r.is_ok() {
        crate::account::map_changed(id, false);
    }
    r
}

/// Delete a map file (and roam the deletion on native).
pub fn delete(id: &str) -> Result<(), String> {
    let r = imp::delete(id);
    #[cfg(not(target_arch = "wasm32"))]
    if r.is_ok() {
        crate::account::map_changed(id, true);
    }
    r
}

/// Write a map file without roaming it (applying the cloud copy).
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn write_local(id: &str, json: &str) -> Result<String, String> {
    imp::write(id, json)
}

/// Save a level under `id`, returning where it went.
pub fn save(id: &str, level: &Level) -> Result<String, String> {
    let _ = now_ms();
    write(id, &level.to_json())
}

/// Load a map id (either format).
pub fn load(id: &str) -> Result<Level, String> {
    let text = read(id)?;
    bb_level::load_any(&text).map_err(|e| e.to_string())
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_in_temp_dir() {
        let dir = std::env::temp_dir().join(format!("bb-maps-test-{}", std::process::id()));
        // SAFETY: single-threaded within this test; other tests don't read BB_MAPS_DIR.
        unsafe { std::env::set_var("BB_MAPS_DIR", &dir) };
        let level = super::super::tools::starter_level();
        save("my-map", &level).unwrap();
        assert!(list().iter().any(|m| m.id == "my-map" && m.name == "Untitled"));
        assert_eq!(load("my-map").unwrap().terrain.len(), level.terrain.len());
        assert_eq!(unique_id("my map"), "my-map-2");
        delete("my-map").unwrap();
        assert!(save("../evil", &level).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
