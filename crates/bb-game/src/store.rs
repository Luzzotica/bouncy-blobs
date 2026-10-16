//! The platform's own store, for platforms that require it: StoreKit 2 on
//! iOS (Apple requires it for unlocking inside an iPhone app).
//!
//! The Swift side is `ios/StoreKitBridge/StoreKitBridge.swift`, compiled and
//! linked by `crates/bb-mobile/build.rs` when bb-mobile's `storekit` feature
//! is on (it turns on bb-game's). Without it (every other platform, and iOS
//! builds without the feature) these are stubs: `purchase()` and
//! `restore()` return false and nothing ever arrives.
//!
//! The flow ([`crate::ownership`] drives it):
//! 1. `purchase()` shows Apple's sheet for [`APPSTORE_PRODUCT`].
//! 2. A [`StoreEvent::Purchased`] carries the `Transaction.id`; the game
//!    sends it with `acct.submit_receipt("appstore", {"transaction": id})`.
//! 3. Only after partii answers Ok does the game call `finish(id)`. An
//!    unfinished transaction comes back through `Transaction.updates` on the
//!    next launch, so a purchase is never lost to a network failure.
//! 4. `restore()` runs `AppStore.sync()` and reports every current
//!    entitlement as [`StoreEvent::Restored`]; each is submitted the same way.

/// The App Store product for the full game (non-consumable). It has to be
/// created in App Store Connect with exactly this id.
pub const APPSTORE_PRODUCT: &str = "me.sterlinglong.bouncyblobs.full";

#[derive(Clone, Debug, PartialEq)]
pub enum StoreEvent {
    /// A verified transaction to send to partii (`Transaction.id`).
    Purchased(String),
    /// Restore finished: the current entitlements' transaction ids.
    Restored(Vec<String>),
    Cancelled,
    /// Ask to Buy / SCA: approval comes later through `Transaction.updates`.
    Pending,
    Failed(String),
}

/// Parse one event from the bridge (`{"kind": ..., ...}`).
pub fn parse_event(text: &str) -> Option<StoreEvent> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Some(match v.get("kind")?.as_str()? {
        "purchased" => StoreEvent::Purchased(s("transaction")?),
        "restored" => StoreEvent::Restored(v.get("transactions")?.as_array()?.iter().filter_map(|t| t.as_str().map(str::to_string)).collect()),
        "cancelled" => StoreEvent::Cancelled,
        "pending" => StoreEvent::Pending,
        "failed" => StoreEvent::Failed(s("message").unwrap_or_else(|| "The purchase didn't go through.".into())),
        _ => return None,
    })
}

#[cfg(all(target_os = "ios", feature = "storekit"))]
mod imp {
    use std::ffi::{CString, c_char};

    unsafe extern "C" {
        fn bb_sk_start(product: *const c_char);
        fn bb_sk_purchase() -> bool;
        fn bb_sk_restore() -> bool;
        fn bb_sk_finish(transaction: *const c_char);
        /// Copies the next event (JSON) into `buf`; returns its length, 0
        /// when there's none, or minus the size needed when `buf` is short.
        fn bb_sk_poll(buf: *mut u8, cap: usize) -> isize;
    }

    pub fn start() {
        let p = CString::new(super::APPSTORE_PRODUCT).unwrap_or_default();
        unsafe { bb_sk_start(p.as_ptr()) }
    }
    pub fn purchase() -> bool {
        unsafe { bb_sk_purchase() }
    }
    pub fn restore() -> bool {
        unsafe { bb_sk_restore() }
    }
    pub fn finish(id: &str) {
        if let Ok(c) = CString::new(id) {
            unsafe { bb_sk_finish(c.as_ptr()) }
        }
    }
    pub fn poll() -> Option<super::StoreEvent> {
        let mut buf = vec![0u8; 4096];
        let mut n = unsafe { bb_sk_poll(buf.as_mut_ptr(), buf.len()) };
        if n < 0 {
            buf.resize((-n) as usize, 0);
            n = unsafe { bb_sk_poll(buf.as_mut_ptr(), buf.len()) };
        }
        if n <= 0 {
            return None;
        }
        super::parse_event(std::str::from_utf8(&buf[..n as usize]).ok()?)
    }
}

#[cfg(not(all(target_os = "ios", feature = "storekit")))]
mod imp {
    pub fn start() {}
    pub fn purchase() -> bool {
        false
    }
    pub fn restore() -> bool {
        false
    }
    pub fn finish(_id: &str) {}
    pub fn poll() -> Option<super::StoreEvent> {
        None
    }
}

/// Startup: listen for transactions (unfinished ones from earlier launches,
/// Ask to Buy approvals, purchases made elsewhere).
pub fn start() {
    imp::start();
}
/// Show the App Store purchase sheet. False when there's no store here.
pub fn purchase() -> bool {
    imp::purchase()
}
/// Restore Purchases. False when there's no store here.
pub fn restore() -> bool {
    imp::restore()
}
/// Finish a transaction (only after partii accepted its receipt).
pub fn finish(id: &str) {
    imp::finish(id)
}
pub fn poll() -> Option<StoreEvent> {
    imp::poll()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_events_parse() {
        assert_eq!(parse_event(r#"{"kind":"purchased","transaction":"2000000123"}"#), Some(StoreEvent::Purchased("2000000123".into())));
        assert_eq!(parse_event(r#"{"kind":"restored","transactions":["1","2"]}"#), Some(StoreEvent::Restored(vec!["1".into(), "2".into()])));
        assert_eq!(parse_event(r#"{"kind":"cancelled"}"#), Some(StoreEvent::Cancelled));
        assert_eq!(parse_event(r#"{"kind":"pending"}"#), Some(StoreEvent::Pending));
        assert_eq!(parse_event(r#"{"kind":"failed","message":"nope"}"#), Some(StoreEvent::Failed("nope".into())));
        assert_eq!(parse_event(r#"{"kind":"purchased"}"#), None);
        assert_eq!(parse_event("junk"), None);
        // Stubs off iOS: no store, nothing arrives.
        assert!(!purchase() && !restore() && poll().is_none());
    }
}
