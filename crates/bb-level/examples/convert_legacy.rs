//! Convert the legacy levels in `crates/bb-level/assets/legacy/` into v3
//! party levels in `crates/bb-game/assets/levels/party/` plus a manifest.
//!
//! `cargo run -p bb-level --example convert_legacy`

use std::path::PathBuf;

use bb_level::legacy::{ImportOptions, import_legacy_with};
use serde_json::{Value, json};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let src = root.join("assets/legacy");
    let dst = root.join("../bb-game/assets/levels/party");
    std::fs::create_dir_all(&dst).unwrap();
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(src.join("manifest.json")).unwrap()).unwrap();
    let mut entries: Vec<(String, bool)> = manifest["levels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["id"].as_str().unwrap().to_string(), e["hidden"].as_bool().unwrap_or(false)))
        .collect();
    // Files not in the legacy manifest (party.json) go last, hidden.
    let mut files: Vec<String> = std::fs::read_dir(&src)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|f| f.ends_with(".json") && f != "manifest.json")
        .map(|f| f.trim_end_matches(".json").to_string())
        .collect();
    files.sort();
    for f in files {
        if !entries.iter().any(|(id, _)| *id == f) {
            entries.push((f, true));
        }
    }
    let mut out = Vec::new();
    for (id, hidden) in entries {
        let json = std::fs::read_to_string(src.join(format!("{id}.json"))).unwrap();
        let imp = import_legacy_with(&json, &ImportOptions { id: Some(id.clone()), ..Default::default() }).unwrap();
        std::fs::write(dst.join(format!("{id}.json")), imp.level.to_json()).unwrap();
        println!("{id}: {} notes", imp.notes.len());
        out.push(json!({
            "id": id,
            "name": imp.level.name,
            "file": format!("{id}.json"),
            "modes": imp.level.modes,
            "hidden": hidden,
            "import_notes": imp.notes,
        }));
    }
    let m = json!({ "source": "legacy public/levels via bb_level::legacy (scale 2/3, y-up)", "levels": out });
    std::fs::write(dst.join("manifest.json"), serde_json::to_string_pretty(&m).unwrap()).unwrap();
}
