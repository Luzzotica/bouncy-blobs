//! The player's partii account (native builds), on the shared
//! `partii-account` crate: a guest sign-in per device, the "owns Bouncy
//! Blobs" entitlement, and a roaming `progress` save slot: `save.txt`'s
//! keys (story progress, prefs). Numbers merge by maximum so progress never
//! goes backwards across devices.
//!
//! Without a key (`BB_PARTII_KEY`) or a data folder, there's no account
//! and everything stays local.

use std::sync::OnceLock;

use bevy::prelude::*;
use partii_account::{Account, AccountConfig};
use serde_json::{Map, Value};

pub const GAME: &str = bb_net::GAME_ID;
pub const FULL: &str = "full";

static ACCOUNT: OnceLock<Account> = OnceLock::new();

/// The account, once started.
pub fn get() -> Option<&'static Account> {
    ACCOUNT.get()
}

fn merge(slot: &str, mine: &str, theirs: &str) -> Option<String> {
    let (Ok(Value::Object(m)), Ok(Value::Object(t))) = (serde_json::from_str::<Value>(mine), serde_json::from_str::<Value>(theirs)) else {
        return None;
    };
    let out = match slot {
        "progress" => merge_progress(m, t),
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

/// This device's `progress` slot.
fn local_progress() -> Value {
    Value::Object(crate::save::all().into_iter().map(|(k, v)| (k, Value::String(v))).collect())
}

pub fn push_progress() {
    if let Some(a) = get().filter(|a| a.ready()) {
        a.write_save("progress", &local_progress().to_string());
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
    a.write_save("progress", &local_progress().to_string());
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
        slots: vec!["progress".into()],
        merge: Some(merge),
        version: env!("CARGO_PKG_VERSION").into(),
        ..AccountConfig::default()
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
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn progress_numbers_take_the_max_and_strings_take_mine() {
        let m = merge_progress(obj(json!({"story.ch":"3","name":"Ann","solo":"1"})), obj(json!({"story.ch":"5","name":"Bo","other":"x"})));
        assert_eq!(Value::Object(m), json!({"story.ch":"5","name":"Ann","solo":"1","other":"x"}));
    }

    #[test]
    fn merge_routes_by_slot() {
        assert!(merge("progress", r#"{"x":"1"}"#, r#"{"x":"2"}"#).unwrap().contains("\"2\""));
        assert_eq!(merge("other", "{}", "{}"), None);
    }
}
