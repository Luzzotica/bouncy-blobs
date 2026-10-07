//! Tiny persistent key/value store (story progress, kids prefs, settings).
//!
//! Native: `key=value` lines in `save.txt` in the platform data dir.
//! Web: `localStorage` (`bb.<key>`). Best-effort: failures are silent.

#[cfg(not(target_arch = "wasm32"))]
fn path() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    #[allow(unused_variables)] // unused on Android
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    #[cfg(target_os = "android")]
    let dir = bevy::android::ANDROID_APP.get().and_then(|a| a.internal_data_path());
    #[cfg(target_os = "windows")]
    let dir = env("APPDATA").map(|d| d.join("BouncyBlobs"));
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let dir = env("HOME").map(|h| h.join("Library/Application Support/BouncyBlobs"));
    #[cfg(not(any(target_os = "android", target_os = "windows", target_os = "macos", target_os = "ios")))]
    let dir = env("XDG_DATA_HOME").or_else(|| env("HOME").map(|h| h.join(".local/share"))).map(|d| d.join("bouncy-blobs"));
    dir.map(|d| d.join("save.txt"))
}

#[cfg(not(target_arch = "wasm32"))]
fn read_all() -> Vec<(String, String)> {
    let Some(s) = path().and_then(|p| std::fs::read_to_string(p).ok()) else { return Vec::new() };
    s.lines().filter_map(|l| l.split_once('=')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect()
}

pub fn get(key: &str) -> Option<String> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        read_all().into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::window()?.local_storage().ok()??.get_item(&format!("bb.{key}")).ok()?
    }
}

pub fn set(key: &str, value: &str) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let Some(p) = path() else { return };
        let mut all = read_all();
        match all.iter_mut().find(|(k, _)| k == key) {
            Some(e) => e.1 = value.to_string(),
            None => all.push((key.to_string(), value.to_string())),
        }
        let body: String = all.iter().map(|(k, v)| format!("{k}={v}\n")).collect();
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(p, body);
    }
    #[cfg(target_arch = "wasm32")]
    if let Some(s) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) {
        let _ = s.set_item(&format!("bb.{key}"), value);
    }
}
