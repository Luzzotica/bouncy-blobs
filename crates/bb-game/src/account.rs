//! The player's partii account (native builds), on the shared
//! `partii-account` crate: a guest sign-in per device, the "owns Bouncy
//! Blobs" entitlement, and roaming saves in two slots:
//!
//! * `progress`: `save.txt`'s keys (story progress, prefs). Numbers merge
//!   by maximum so progress never goes backwards across devices.
//! * `maps`: the player's own maps, `{id: {updated_ms, level} | {updated_ms,
//!   deleted: true}}`. The newer entry wins; deletions are kept as
//!   tombstones so a map deleted on one device doesn't return from another.
//!
//! Without a key (`BB_PARTII_KEY`) or a data folder, there's no account
//! and everything stays local.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use bevy::prelude::*;
use partii_account::{Account, AccountConfig};
use serde_json::{json, Map, Value};

pub const GAME: &str = bb_net::GAME_ID;
pub const FULL: &str = "full";

static ACCOUNT: OnceLock<Account> = OnceLock::new();
/// Tombstones for maps deleted on this device (id → when).
static DELETED: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

/// The account, once started.
pub fn get() -> Option<&'static Account> {
    ACCOUNT.get()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn merge(slot: &str, mine: &str, theirs: &str) -> Option<String> {
    let (Ok(Value::Object(m)), Ok(Value::Object(t))) = (serde_json::from_str::<Value>(mine), serde_json::from_str::<Value>(theirs)) else {
        return None;
    };
    let out = match slot {
        "progress" => merge_progress(m, t),
        "maps" => merge_maps(m, t),
        _ => return None,
    };
    serde_json::to_string(&Value::Object(out)).ok()
}

/// Union; where both have a key, numbers take the larger, else mine wins.
pub fn merge_progress(mine: Map<String, Value>, mut theirs: Map<String, Value>) -> Map<String, Value> {
    for (k, v) in mine {
        let num = |x: &Value| x.as_str().and_then(|s| s.parse::<f64>().ok());
        let keep_theirs = matches!((theirs.get(&k).and_then(num), num(&v)), (Some(a), Some(b)) if a > b);
        if !keep_theirs {
            theirs.insert(k, v);
        }
    }
    theirs
}

/// Union by map id; the entry with the newer `updated_ms` wins (ties: mine).
pub fn merge_maps(mine: Map<String, Value>, mut theirs: Map<String, Value>) -> Map<String, Value> {
    let at = |v: &Value| v["updated_ms"].as_u64().unwrap_or(0);
    for (k, v) in mine {
        if theirs.get(&k).is_none_or(|t| at(&v) >= at(t)) {
            theirs.insert(k, v);
        }
    }
    theirs
}

/// This device's `progress` slot.
fn local_progress() -> Value {
    Value::Object(crate::save::all().into_iter().map(|(k, v)| (k, Value::String(v))).collect())
}

/// This device's `maps` slot.
fn local_maps() -> Value {
    let mut out = Map::new();
    for m in crate::editor::storage::list() {
        if let Ok(text) = crate::editor::storage::read(&m.id) {
            if let Ok(level) = serde_json::from_str::<Value>(&text) {
                out.insert(m.id, json!({ "updated_ms": m.updated_ms, "level": level }));
            }
        }
    }
    for (id, at) in DELETED.lock().unwrap_or_else(|p| p.into_inner()).iter() {
        if !out.contains_key(id) {
            out.insert(id.clone(), json!({ "updated_ms": at, "deleted": true }));
        }
    }
    Value::Object(out)
}

pub fn push_progress() {
    if let Some(a) = get().filter(|a| a.ready()) {
        a.write_save("progress", &local_progress().to_string());
    }
}

/// A map was saved or deleted here.
pub fn map_changed(id: &str, deleted: bool) {
    {
        let mut d = DELETED.lock().unwrap_or_else(|p| p.into_inner());
        if deleted {
            d.insert(id.to_string(), now_ms());
        } else {
            d.remove(id);
        }
    }
    if let Some(a) = get().filter(|a| a.ready()) {
        a.write_save("maps", &local_maps().to_string());
    }
}

/// Bring the cloud copy in (signed in, first fetch done), then send ours.
fn pull_and_push(a: &Account) {
    if let Some(Value::Object(cloud)) = a.read_save("progress").and_then(|t| serde_json::from_str(&t).ok()) {
        let Value::Object(local) = local_progress() else { return };
        for (k, v) in merge_progress(local.clone(), cloud) {
            if let Some(v) = v.as_str() {
                if local.get(&k).and_then(|x| x.as_str()) != Some(v) {
                    crate::save::set_local(&k, v);
                }
            }
        }
    }
    if let Some(Value::Object(cloud)) = a.read_save("maps").and_then(|t| serde_json::from_str(&t).ok()) {
        let Value::Object(local) = local_maps() else { return };
        for (id, entry) in merge_maps(local.clone(), cloud) {
            if local.get(&id) == Some(&entry) {
                continue;
            }
            if entry["deleted"] == true {
                if crate::editor::storage::read(&id).is_ok() {
                    let _ = std::fs::remove_file(crate::editor::storage::maps_dir().map(|d| d.join(format!("{id}.json"))).unwrap_or_default());
                }
                DELETED.lock().unwrap_or_else(|p| p.into_inner()).insert(id, entry["updated_ms"].as_u64().unwrap_or(0));
            } else if crate::editor::storage::valid_id(&id) {
                let _ = crate::editor::storage::write_local(&id, &entry["level"].to_string());
            }
        }
    }
    a.write_save("progress", &local_progress().to_string());
    a.write_save("maps", &local_maps().to_string());
}

pub struct AccountPlugin;

impl Plugin for AccountPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, start).add_systems(Update, sync_once);
    }
}

fn start() {
    let cfg = bb_net::NetConfig::from_env();
    let Some(data_dir) = crate::save::data_dir() else { return };
    if cfg.key.is_empty() || std::env::var_os("BB_NO_ACCOUNT").is_some() {
        return;
    }
    let _ = ACCOUNT.set(Account::start(AccountConfig {
        edge: cfg.edge,
        key: Some(cfg.key),
        player_token: cfg.player_token,
        game: GAME.into(),
        data_dir,
        display_name: "Player".into(),
        slots: vec!["progress".into(), "maps".into()],
        merge: Some(merge),
    }));
}

/// Once signed in: merge the cloud saves in and log what the player owns.
fn sync_once(mut done: Local<bool>) {
    if *done {
        return;
    }
    let Some(a) = get() else { return };
    if !a.ready() {
        return;
    }
    *done = true;
    pull_and_push(a);
    info!("account: player {:?}, owns the full game: {:?}", a.player_id(), a.owns(FULL));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn progress_numbers_take_the_max_and_strings_take_mine() {
        let m = merge_progress(obj(json!({"story.ch":"3","name":"Ann","solo":"1"})), obj(json!({"story.ch":"5","name":"Bo","other":"x"})));
        assert_eq!(Value::Object(m), json!({"story.ch":"5","name":"Ann","solo":"1","other":"x"}));
    }

    #[test]
    fn maps_take_the_newer_entry_and_keep_tombstones() {
        let mine = obj(json!({"a":{"updated_ms":5,"level":{"n":1}},"b":{"updated_ms":9,"deleted":true}}));
        let theirs = obj(json!({"a":{"updated_ms":7,"level":{"n":2}},"b":{"updated_ms":3,"level":{"n":3}},"c":{"updated_ms":1,"level":{}}}));
        let m = merge_maps(mine, theirs);
        assert_eq!(m["a"]["level"]["n"], 2, "theirs is newer");
        assert_eq!(m["b"]["deleted"], true, "the later delete wins");
        assert!(m.contains_key("c"));
    }

    #[test]
    fn merge_routes_by_slot() {
        assert!(merge("progress", r#"{"x":"1"}"#, r#"{"x":"2"}"#).unwrap().contains("\"2\""));
        assert_eq!(merge("other", "{}", "{}"), None);
    }
}
