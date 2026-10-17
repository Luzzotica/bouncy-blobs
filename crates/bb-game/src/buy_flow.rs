//! Buying the full game on desktop (macOS, Windows, Linux; not iOS, which
//! uses StoreKit, nor Steam builds under Steam, which use Steam's store):
//! a phone-scannable Stripe Checkout.
//!
//! 1. The game asks partii for a checkout as its own player
//!    (`storeCheckout`, `POST /v1/store/games/bouncy-blobs/checkout` with
//!    `success_url` / `cancel_url`) and gets `{url, session}`. The session
//!    belongs to this player, so whoever pays on the phone pays for this
//!    player's copy. Nobody signs in to partii on the phone.
//! 2. The buy screen ([`crate::buy_screen`]) shows `url` as a QR code, and
//!    a "Pay in browser instead" button that opens the same page here.
//! 3. Stripe's webhook records the copy within seconds. While the screen is
//!    open the game asks `playersEntitlements` every [`POLL_EVERY`] seconds
//!    and unlocks once `owns` includes `full`. It stops after
//!    [`SESSION_FOR`] (the code expires: offer a new one), when the screen
//!    closes, or once paid.
//!
//! [`BuyFlow`] is the state machine, pure and frame-free: it takes events
//! (opened, a checkout reply, owned, a tick) and returns [`Effect`]s for the
//! driver to carry out. [`StoreBackend`] is the store behind a trait:
//! [`PartiiStore`] in the game, [`FakeStore`] in tests.
//!
//! Polling vs push: ownership news reaches the flow only through
//! [`BuyFlow::on_owned`]. Polling is [`Watch::Poll`] (the driver asks the
//! store on each [`Effect::CheckOwned`] and calls `on_owned` when it says
//! yes). When partii's push event lands, a push listener calls `on_owned`
//! directly and the flow runs with [`Watch::Push`], which keeps a slow poll
//! only as a safety net. Nothing else changes.

use std::sync::{Arc, Mutex};

use bevy::prelude::*;

/// Seconds between entitlement checks while the QR is up (partii's rate
/// limits allow 2–3 s).
pub const POLL_EVERY: f32 = 2.5;
/// A checkout code is offered this long (s), then the screen offers a new
/// one. Stripe's own session lives longer; this caps the polling.
pub const SESSION_FOR: f32 = 15.0 * 60.0;
/// After a 409 `owned` or a store that completed at once: how long to wait
/// for the entitlement to show before calling it a failure.
pub const CONFIRM_FOR: f32 = 60.0;
/// How long the "Thanks!" celebration plays before the screen closes.
pub const CELEBRATE_FOR: f32 = 3.2;

/// A checkout page for this player.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkout {
    /// Stripe-hosted Checkout (works on any phone, no partii sign-in).
    pub url: String,
    /// Stripe's session id (`cs_…`), for logs.
    pub session: String,
}

/// What the store said to "make me a checkout".
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckoutReply {
    Ready(Checkout),
    /// 409 `owned`: this player already owns the game (bought on another
    /// device, or the last code was paid a moment ago).
    AlreadyOwned,
    /// The store completed at once (partii's dev fake store, or a 100%-off
    /// promotion applied server-side).
    Completed,
    /// No network, or not signed in to partii yet.
    Offline,
    /// Anything else, with a message for the log.
    Failed(String),
}

/// Parse a `storeCheckout` reply body (`{ok, url, session, completed}` or
/// `{ok: false, error: {code, message}}`).
pub fn parse_checkout(v: &serde_json::Value) -> CheckoutReply {
    if v["ok"] == true {
        if v["completed"] == true {
            return CheckoutReply::Completed;
        }
        return match v["url"].as_str().filter(|u| !u.is_empty()) {
            Some(url) => CheckoutReply::Ready(Checkout { url: url.into(), session: v["session"].as_str().unwrap_or_default().into() }),
            None => CheckoutReply::Failed("checkout had no url".into()),
        };
    }
    match v["error"]["code"].as_str() {
        Some("owned") => CheckoutReply::AlreadyOwned,
        Some("unauthorized") => CheckoutReply::Offline,
        _ => CheckoutReply::Failed(v["error"]["message"].as_str().unwrap_or("checkout failed").into()),
    }
}

/// Where the purchase is.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Phase {
    /// Screen closed.
    #[default]
    Idle,
    /// Asking partii for a checkout.
    Creating,
    /// The QR is up; checking for the payment every [`POLL_EVERY`].
    Showing { checkout: Checkout, age: f32, since_check: f32 },
    /// Already owned (409) or completed at once: waiting for the
    /// entitlement to show up.
    Confirming { age: f32, since_check: f32 },
    /// The code timed out: offer a new one.
    Expired,
    /// No network: say so, offer Retry.
    Offline,
    /// Something else went wrong: say so, offer Retry.
    Failed,
    /// Paid! Celebrating, then the screen closes.
    Paid { age: f32 },
}

/// What the driver should do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Ask the store for a checkout (answer through [`BuyFlow::on_reply`]).
    CreateCheckout,
    /// Ask the store whether the player owns the game now.
    CheckOwned,
    /// Open this checkout in the browser.
    OpenBrowser(String),
    /// The game is owned: unlock everything now.
    Unlocked,
    /// Close the screen (back to wherever it was opened from).
    Close,
}

/// How ownership news reaches the flow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Watch {
    /// Ask every `every` seconds.
    Poll { every: f32 },
    /// A push event calls [`BuyFlow::on_owned`]; poll every `fallback`
    /// seconds in case a push is missed.
    Push { fallback: f32 },
}

impl Watch {
    fn every(self) -> f32 {
        match self {
            Watch::Poll { every } => every,
            Watch::Push { fallback } => fallback,
        }
    }
}

impl Default for Watch {
    fn default() -> Self {
        Watch::Poll { every: POLL_EVERY }
    }
}

/// The buy screen's state machine.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BuyFlow {
    pub phase: Phase,
    pub watch: Watch,
}

impl BuyFlow {
    pub fn new(watch: Watch) -> BuyFlow {
        BuyFlow { phase: Phase::Idle, watch }
    }

    /// Is the screen up?
    pub fn open(&self) -> bool {
        self.phase != Phase::Idle
    }

    /// Is it asking about the payment (the polling cadence runs)?
    pub fn watching(&self) -> bool {
        matches!(self.phase, Phase::Showing { .. } | Phase::Confirming { .. })
    }

    /// The checkout on screen, if any.
    pub fn checkout(&self) -> Option<&Checkout> {
        match &self.phase {
            Phase::Showing { checkout, .. } => Some(checkout),
            _ => None,
        }
    }

    /// "Get the Full Game" pressed: open the screen and ask for a checkout.
    /// Pressing it again while it's up changes nothing.
    pub fn start(&mut self) -> Vec<Effect> {
        if self.open() {
            return vec![];
        }
        self.phase = Phase::Creating;
        vec![Effect::CreateCheckout]
    }

    /// Retry (offline, failed) or "New code" (expired).
    pub fn retry(&mut self) -> Vec<Effect> {
        match self.phase {
            Phase::Offline | Phase::Failed | Phase::Expired => {
                self.phase = Phase::Creating;
                vec![Effect::CreateCheckout]
            }
            _ => vec![],
        }
    }

    /// The store answered the checkout request.
    pub fn on_reply(&mut self, reply: CheckoutReply) -> Vec<Effect> {
        if self.phase != Phase::Creating {
            // Closed (or already paid) while it was on its way: drop it.
            return vec![];
        }
        match reply {
            CheckoutReply::Ready(checkout) => {
                self.phase = Phase::Showing { checkout, age: 0.0, since_check: 0.0 };
                vec![]
            }
            CheckoutReply::AlreadyOwned | CheckoutReply::Completed => {
                self.phase = Phase::Confirming { age: 0.0, since_check: 0.0 };
                vec![Effect::CheckOwned]
            }
            CheckoutReply::Offline => {
                self.phase = Phase::Offline;
                vec![]
            }
            CheckoutReply::Failed(_) => {
                self.phase = Phase::Failed;
                vec![]
            }
        }
    }

    /// The player owns the game (a poll said so, or a push). Celebrate.
    pub fn on_owned(&mut self) -> Vec<Effect> {
        match self.phase {
            Phase::Idle | Phase::Paid { .. } => vec![],
            _ => {
                self.phase = Phase::Paid { age: 0.0 };
                vec![Effect::Unlocked]
            }
        }
    }

    /// "Pay in browser instead".
    pub fn pay_in_browser(&self) -> Vec<Effect> {
        self.checkout().map(|c| vec![Effect::OpenBrowser(c.url.clone())]).unwrap_or_default()
    }

    /// The window got focus back (from the browser): check at once.
    pub fn refocused(&mut self) -> Vec<Effect> {
        match &mut self.phase {
            Phase::Showing { since_check, .. } | Phase::Confirming { since_check, .. } => {
                *since_check = 0.0;
                vec![Effect::CheckOwned]
            }
            _ => vec![],
        }
    }

    /// Back / Escape. Closing stops the polling. (Paid closes by itself.)
    pub fn close(&mut self) -> Vec<Effect> {
        match self.phase {
            Phase::Idle => vec![],
            Phase::Paid { .. } => vec![],
            _ => {
                self.phase = Phase::Idle;
                vec![Effect::Close]
            }
        }
    }

    /// Time passes: poll, expire, finish celebrating.
    pub fn tick(&mut self, dt: f32) -> Vec<Effect> {
        let every = self.watch.every();
        match &mut self.phase {
            Phase::Showing { age, since_check, .. } => {
                *age += dt;
                *since_check += dt;
                if *age >= SESSION_FOR {
                    self.phase = Phase::Expired;
                    return vec![];
                }
                if *since_check >= every {
                    *since_check -= every;
                    return vec![Effect::CheckOwned];
                }
                vec![]
            }
            Phase::Confirming { age, since_check } => {
                *age += dt;
                *since_check += dt;
                if *age >= CONFIRM_FOR {
                    self.phase = Phase::Failed;
                    return vec![];
                }
                // The entitlement is already there: ask often.
                if *since_check >= every.min(POLL_EVERY) {
                    *since_check = 0.0;
                    return vec![Effect::CheckOwned];
                }
                vec![]
            }
            Phase::Paid { age } => {
                *age += dt;
                if *age >= CELEBRATE_FOR {
                    self.phase = Phase::Idle;
                    return vec![Effect::Close];
                }
                vec![]
            }
            _ => vec![],
        }
    }

    /// The status line under the QR.
    pub fn status(&self) -> String {
        match &self.phase {
            Phase::Idle => String::new(),
            Phase::Creating => "Making your checkout code...".into(),
            Phase::Showing { .. } => "Waiting for payment...".into(),
            Phase::Confirming { .. } => "You already own it! Unlocking...".into(),
            Phase::Expired => "That code expired. Get a new one?".into(),
            Phase::Offline => "Can't reach the store. Check your internet, then Retry.".into(),
            Phase::Failed => "The store didn't answer. Try again in a bit.".into(),
            Phase::Paid { .. } => "Payment received!".into(),
        }
    }
}

/// The store, behind a trait so tests (and other partii games) can swap it.
/// Calls never block: answers arrive later through `take_checkout` and
/// `owned`.
pub trait StoreBackend: Send + Sync + 'static {
    /// Ask for a checkout for this player, returning to these pages.
    fn create_checkout(&self, success_url: &str, cancel_url: &str);
    /// The answer to `create_checkout`, once (None while waiting).
    fn take_checkout(&self) -> Option<CheckoutReply>;
    /// Ask whether the player owns the game now (answer through `owned`).
    fn check_owned(&self);
    /// Does the player own the full game, as last heard?
    fn owned(&self) -> bool;
}

/// The store the buy screen uses.
#[derive(Resource, Clone)]
pub struct BuyStore(pub Arc<dyn StoreBackend>);

/// Where Stripe sends the phone afterwards: static pages on the game's
/// partii site (`web-controller/`, `/paid` and `/cancelled`), made for a
/// phone with nobody signed in.
pub fn return_urls(controller_site: &str) -> (String, String) {
    let site = controller_site.trim_end_matches('/');
    (format!("{site}/paid"), format!("{site}/cancelled"))
}

/// A price for the buy screen ("$4.99") from the store listing's
/// `price_now_cents` + `currency`. None when there's no price or it's free.
pub fn listing_price(v: &serde_json::Value) -> Option<String> {
    let g = v.get("game").unwrap_or(v);
    let cents = g.get("price_now_cents").or_else(|| g.get("price_cents"))?.as_u64().filter(|c| *c > 0)?;
    let cur = g.get("currency").and_then(|c| c.as_str()).unwrap_or("usd").to_ascii_lowercase();
    let amount = format!("{}.{:02}", cents / 100, cents % 100);
    Some(match cur.as_str() {
        "usd" | "cad" | "aud" | "nzd" => format!("${amount}"),
        "eur" => format!("€{amount}"),
        "gbp" => format!("£{amount}"),
        other => format!("{amount} {}", other.to_ascii_uppercase()),
    })
}

// ---------------------------------------------------------------- partii

/// The real store: partii, as the game's own player (`partii-account`).
#[cfg(not(target_arch = "wasm32"))]
#[derive(Default)]
pub struct PartiiStore {
    reply: Arc<Mutex<Option<CheckoutReply>>>,
}

#[cfg(not(target_arch = "wasm32"))]
impl StoreBackend for PartiiStore {
    fn create_checkout(&self, success_url: &str, cancel_url: &str) {
        let slot = self.reply.clone();
        // Not signed in yet (offline since launch): nothing to ask with.
        let Some(c) = crate::account::get().and_then(|a| a.client()) else {
            *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(CheckoutReply::Offline);
            return;
        };
        let body = serde_json::json!({ "success_url": success_url, "cancel_url": cancel_url });
        std::thread::spawn(move || {
            let out = match c.json("storeCheckout", &[("game", crate::account::GAME)], Some(body)) {
                Ok(v) => parse_checkout(&v),
                Err(e) if e.code == "network" => CheckoutReply::Offline,
                Err(e) => CheckoutReply::Failed(e.message),
            };
            match &out {
                CheckoutReply::Ready(c) => info!("buy: checkout {} ready", c.session),
                other => info!("buy: checkout {other:?}"),
            }
            *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(out);
        });
    }
    fn take_checkout(&self) -> Option<CheckoutReply> {
        self.reply.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
    fn check_owned(&self) {
        // `playersEntitlements`, which also refreshes the signed offline cache.
        if let Some(a) = crate::account::get() {
            a.refresh();
        }
    }
    fn owned(&self) -> bool {
        crate::account::get().and_then(|a| a.owns(crate::ownership::FULL)) == Some(true)
    }
}

// ------------------------------------------------------------------ fake

/// A store for tests and screenshots: answers with `reply`, owns once
/// `paid` is set, counts the checks.
#[derive(Clone, Debug)]
pub struct FakeStore {
    pub st: Arc<Mutex<FakeState>>,
}

#[derive(Clone, Debug)]
pub struct FakeState {
    /// What the next `create_checkout` answers.
    pub reply: CheckoutReply,
    /// Has the player paid?
    pub paid: bool,
    /// Entitlement checks asked for.
    pub checks: u32,
    /// Checkouts asked for, with their return pages.
    pub created: Vec<(String, String)>,
    pending: Option<CheckoutReply>,
    heard: bool,
}

impl FakeStore {
    /// A store that hands out a test checkout url.
    pub fn new() -> FakeStore {
        FakeStore::answering(CheckoutReply::Ready(Checkout { url: "https://checkout.stripe.com/c/pay/cs_test_fake#bouncy-blobs".into(), session: "cs_test_fake".into() }))
    }
    pub fn answering(reply: CheckoutReply) -> FakeStore {
        FakeStore { st: Arc::new(Mutex::new(FakeState { reply, paid: false, checks: 0, created: vec![], pending: None, heard: false })) }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }
    /// The phone paid (the webhook ran): the next check sees it.
    pub fn pay(&self) {
        self.lock().paid = true;
    }
    pub fn set_reply(&self, r: CheckoutReply) {
        self.lock().reply = r;
    }
    pub fn checks(&self) -> u32 {
        self.lock().checks
    }
    pub fn created(&self) -> Vec<(String, String)> {
        self.lock().created.clone()
    }
}

impl Default for FakeStore {
    fn default() -> Self {
        FakeStore::new()
    }
}

impl StoreBackend for FakeStore {
    fn create_checkout(&self, success_url: &str, cancel_url: &str) {
        let mut s = self.lock();
        s.created.push((success_url.into(), cancel_url.into()));
        s.pending = Some(s.reply.clone());
    }
    fn take_checkout(&self) -> Option<CheckoutReply> {
        self.lock().pending.take()
    }
    fn check_owned(&self) {
        let mut s = self.lock();
        s.checks += 1;
        // Like the real one, ownership is only heard about through a check.
        if s.paid {
            s.heard = true;
        }
    }
    fn owned(&self) -> bool {
        let s = self.lock();
        s.heard || (matches!(s.reply, CheckoutReply::AlreadyOwned | CheckoutReply::Completed) && s.checks > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ready() -> CheckoutReply {
        CheckoutReply::Ready(Checkout { url: "https://checkout.stripe.com/c/pay/cs_test_1".into(), session: "cs_test_1".into() })
    }

    fn showing() -> BuyFlow {
        let mut f = BuyFlow::default();
        assert_eq!(f.start(), vec![Effect::CreateCheckout]);
        assert_eq!(f.on_reply(ready()), vec![]);
        f
    }

    /// Run `secs` in steps of `dt`, collecting the effects.
    fn run(f: &mut BuyFlow, secs: f32, dt: f32) -> Vec<Effect> {
        let mut out = vec![];
        let mut t = 0.0;
        while t < secs - 1e-4 {
            out.extend(f.tick(dt));
            t += dt;
        }
        out
    }

    fn checks(e: &[Effect]) -> usize {
        e.iter().filter(|e| **e == Effect::CheckOwned).count()
    }

    #[test]
    fn idle_to_qr_to_paid_to_unlocked() {
        let mut f = BuyFlow::default();
        assert!(!f.open());
        assert_eq!(f.start(), vec![Effect::CreateCheckout]);
        assert_eq!(f.phase, Phase::Creating);
        assert!(f.open() && !f.watching());
        // A second press while it's up does nothing.
        assert_eq!(f.start(), vec![]);
        f.on_reply(ready());
        assert!(f.watching());
        assert_eq!(f.checkout().unwrap().session, "cs_test_1");
        assert_eq!(f.status(), "Waiting for payment...");
        assert_eq!(f.pay_in_browser(), vec![Effect::OpenBrowser("https://checkout.stripe.com/c/pay/cs_test_1".into())]);
        assert_eq!(f.on_owned(), vec![Effect::Unlocked]);
        assert!(matches!(f.phase, Phase::Paid { .. }));
        assert_eq!(f.status(), "Payment received!");
        // Owned twice: one unlock. Back does nothing mid-celebration.
        assert_eq!(f.on_owned(), vec![]);
        assert_eq!(f.close(), vec![]);
        let e = run(&mut f, CELEBRATE_FOR + 0.1, 1.0 / 60.0);
        assert_eq!(e, vec![Effect::Close]);
        assert_eq!(f.phase, Phase::Idle);
    }

    #[test]
    fn polls_every_two_and_a_half_seconds_while_showing() {
        let mut f = showing();
        assert_eq!(checks(&run(&mut f, 1.0, 0.25)), 0);
        assert_eq!(checks(&run(&mut f, 9.0, 0.25)), 4, "10 s: checks at 2.5, 5, 7.5, 10");
        // A long frame never bursts: still at most one check per tick.
        let mut g = showing();
        assert_eq!(checks(&g.tick(7.0)), 1);
        // Inside the 2-3 s window partii allows.
        assert!((2.0..=3.0).contains(&POLL_EVERY));
    }

    #[test]
    fn polling_stops_when_the_screen_closes() {
        let mut f = showing();
        run(&mut f, 3.0, 0.1);
        assert_eq!(f.close(), vec![Effect::Close]);
        assert!(!f.open());
        assert_eq!(checks(&run(&mut f, 60.0, 0.1)), 0);
        // A late checkout reply after closing is dropped.
        assert_eq!(f.on_reply(ready()), vec![]);
        assert_eq!(f.phase, Phase::Idle);
        // And a late "owned" doesn't reopen anything.
        assert_eq!(f.on_owned(), vec![]);
    }

    #[test]
    fn polling_stops_once_paid() {
        let mut f = showing();
        f.on_owned();
        assert_eq!(checks(&run(&mut f, 3.0, 0.1)), 0);
    }

    #[test]
    fn the_code_expires_after_fifteen_minutes_and_a_new_one_is_offered() {
        let mut f = showing();
        let e = run(&mut f, SESSION_FOR + 1.0, 0.5);
        assert_eq!(f.phase, Phase::Expired);
        let n = checks(&e);
        assert!((355..=361).contains(&n), "about 15 min / 2.5 s checks: {n}");
        assert_eq!(checks(&run(&mut f, 30.0, 0.5)), 0, "no polling once expired");
        assert!(f.checkout().is_none(), "the old QR comes down");
        assert_eq!(f.status(), "That code expired. Get a new one?");
        assert_eq!(f.retry(), vec![Effect::CreateCheckout]);
        f.on_reply(ready());
        assert!(f.watching());
        assert_eq!(SESSION_FOR, 900.0);
    }

    #[test]
    fn offline_says_so_and_retries() {
        let mut f = BuyFlow::default();
        f.start();
        f.on_reply(CheckoutReply::Offline);
        assert_eq!(f.phase, Phase::Offline);
        assert!(f.status().contains("Retry"));
        assert_eq!(checks(&run(&mut f, 10.0, 0.1)), 0);
        assert_eq!(f.pay_in_browser(), vec![]);
        assert_eq!(f.retry(), vec![Effect::CreateCheckout]);
        assert_eq!(f.phase, Phase::Creating);
        // Retry does nothing while it's working.
        assert_eq!(f.retry(), vec![]);
        f.on_reply(CheckoutReply::Failed("stripe_error".into()));
        assert_eq!(f.phase, Phase::Failed);
        assert_eq!(f.retry(), vec![Effect::CreateCheckout]);
        // Back from an error closes.
        f.on_reply(CheckoutReply::Offline);
        assert_eq!(f.close(), vec![Effect::Close]);
    }

    #[test]
    fn already_owned_refreshes_and_unlocks() {
        for reply in [CheckoutReply::AlreadyOwned, CheckoutReply::Completed] {
            let mut f = BuyFlow::default();
            f.start();
            assert_eq!(f.on_reply(reply), vec![Effect::CheckOwned], "refresh at once");
            assert!(f.watching() && f.checkout().is_none());
            assert_eq!(checks(&run(&mut f, 5.0, 0.25)), 2);
            assert_eq!(f.on_owned(), vec![Effect::Unlocked]);
        }
        // The entitlement never shows: a failure with Retry, not a hang.
        let mut f = BuyFlow::default();
        f.start();
        f.on_reply(CheckoutReply::AlreadyOwned);
        run(&mut f, CONFIRM_FOR + 1.0, 0.5);
        assert_eq!(f.phase, Phase::Failed);
    }

    #[test]
    fn coming_back_from_the_browser_checks_at_once() {
        let mut f = showing();
        run(&mut f, 1.0, 0.25);
        assert_eq!(f.refocused(), vec![Effect::CheckOwned]);
        // The cadence restarts from there.
        assert_eq!(checks(&run(&mut f, 2.25, 0.25)), 0);
        assert_eq!(checks(&run(&mut f, 0.25, 0.25)), 1);
        assert_eq!(BuyFlow::default().refocused(), vec![]);
    }

    #[test]
    fn push_keeps_only_a_slow_safety_poll() {
        let mut f = BuyFlow::new(Watch::Push { fallback: 30.0 });
        f.start();
        f.on_reply(ready());
        assert_eq!(checks(&run(&mut f, 60.0, 0.5)), 2);
        // The push event is just `on_owned`.
        assert_eq!(f.on_owned(), vec![Effect::Unlocked]);
    }

    #[test]
    fn owned_while_making_the_code_still_unlocks() {
        let mut f = BuyFlow::default();
        f.start();
        assert_eq!(f.on_owned(), vec![Effect::Unlocked]);
        // The checkout that arrives afterwards is ignored.
        assert_eq!(f.on_reply(ready()), vec![]);
    }

    #[test]
    fn checkout_replies_parse() {
        let ok = json!({"ok": true, "url": "https://checkout.stripe.com/c/pay/cs_live_9", "session": "cs_live_9", "completed": false});
        assert_eq!(parse_checkout(&ok), CheckoutReply::Ready(Checkout { url: "https://checkout.stripe.com/c/pay/cs_live_9".into(), session: "cs_live_9".into() }));
        assert_eq!(parse_checkout(&json!({"ok": true, "url": null, "session": "fake:x", "completed": true})), CheckoutReply::Completed);
        assert_eq!(parse_checkout(&json!({"ok": false, "error": {"code": "owned", "message": "you already own this game"}})), CheckoutReply::AlreadyOwned);
        assert_eq!(parse_checkout(&json!({"ok": false, "error": {"code": "unauthorized", "message": "x"}})), CheckoutReply::Offline);
        assert_eq!(parse_checkout(&json!({"ok": false, "error": {"code": "stripe_error", "message": "boom"}})), CheckoutReply::Failed("boom".into()));
        assert!(matches!(parse_checkout(&json!({"ok": true})), CheckoutReply::Failed(_)));
    }

    #[test]
    fn return_pages_live_on_the_games_site() {
        assert_eq!(return_urls("https://bouncy-blobs.partii.games/"), ("https://bouncy-blobs.partii.games/paid".into(), "https://bouncy-blobs.partii.games/cancelled".into()));
    }

    #[test]
    fn listing_prices_read_nicely() {
        assert_eq!(listing_price(&json!({"game": {"price_cents": 999, "price_now_cents": 499, "currency": "usd"}})), Some("$4.99".into()));
        assert_eq!(listing_price(&json!({"game": {"price_cents": 1000, "currency": "eur"}})), Some("€10.00".into()));
        assert_eq!(listing_price(&json!({"game": {"price_cents": 500, "currency": "jpy"}})), Some("5.00 JPY".into()));
        assert_eq!(listing_price(&json!({"game": {"price_cents": 0, "currency": "usd"}})), None);
        assert_eq!(listing_price(&json!({"game": {}})), None);
    }

    #[test]
    fn the_fake_store_is_heard_only_through_a_check() {
        let s = FakeStore::new();
        s.create_checkout("a", "b");
        assert!(matches!(s.take_checkout(), Some(CheckoutReply::Ready(_))));
        assert_eq!(s.take_checkout(), None);
        s.pay();
        assert!(!s.owned());
        s.check_owned();
        assert!(s.owned());
        assert_eq!(s.checks(), 1);
        assert_eq!(s.created(), vec![("a".to_string(), "b".to_string())]);
    }

    #[test]
    fn status_lines_have_glyphs() {
        let mut f = BuyFlow::default();
        let mut lines = vec![];
        for r in [None, Some(ready()), Some(CheckoutReply::AlreadyOwned), Some(CheckoutReply::Offline), Some(CheckoutReply::Failed("x".into()))] {
            f = BuyFlow::default();
            f.start();
            lines.push(f.status());
            if let Some(r) = r {
                f.on_reply(r);
                lines.push(f.status());
            }
        }
        f.on_owned();
        lines.push(f.status());
        lines.push("That code expired. Get a new one?".into());
        for l in lines {
            assert!(crate::softtext::missing_glyphs(&l).is_empty(), "{l:?}");
        }
    }
}
