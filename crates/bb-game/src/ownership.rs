//! Owning the game vs. the free demo: the partii model every partii game
//! follows (GUIDE §4).
//!
//! - **Join is always free.** Anyone can join a friend's room, as a phone or
//!   a guest screen. Only the host's copy matters.
//! - **Host is paid.** Hosting a room, Party with local pads, and Sandbox
//!   need the full game.
//! - **The free part** (the listing's `demo`): Kids Mode, and the first
//!   `story_chapters` of the story (chapters 1 and 2; each chapter is
//!   one level, `chNN`). Locks apply at menus and
//!   chapter boundaries, never mid-level.
//!
//! [`Ownership`] is the one answer the rest of the game reads. It comes from
//! `partii-account`'s `owns("full")`, which is the signed offline cache
//! before sign-in, so someone with a valid cached entitlement is never
//! locked out. With no answer at all (a fresh install offline) it's
//! [`Owned::Unknown`], which plays as the demo.
//!
//! Dev overrides: `BB_DEMO=1` forces the demo, `BB_OWNED=1` (debug builds)
//! the full game. Headless runs (screenshots, captures, scene renders) act
//! as owned unless `BB_DEMO=1` (or a test player's `BB_PARTII_PLAYER_TOKEN`
//! is set), so dev tooling can reach every chapter.
//!
//! Buying: [`BuyRequest`]. On desktop that's the buy screen
//! ([`crate::buy_screen`]: partii's Stripe Checkout as a QR code for the
//! phone, or in the browser, polled until the copy is recorded; Steam
//! builds under Steam open Steam's store page instead; docs/BuyFlow.md); on
//! iOS, StoreKit 2 through [`crate::store`], with the receipt sent to
//! partii and the transaction finished only once partii accepted it.
//!
//! Wishlisting: [`WishlistRequest`] ("Wishlist Now" on the demo's title and
//! end card) opens the game's Steam store page: in the Steam overlay when
//! running under Steam, else in the browser (Android hands the URL to the
//! system).
//!
//! iOS ([`Storefront::AppStore`]): App Store rules allow no link or button
//! out to Steam or to any other way to buy. There's no "Wishlist Now"; the
//! demo offers the in-app purchase itself ("Get the Full Game", with the
//! App Store's localized price when StoreKit has it), plus "Restore
//! Purchases" (in Settings and on the unlock page). `wishlist` and
//! [`open_url`] refuse to open anything there, whatever asks.

use bevy::prelude::*;

/// The partii SKU for the whole game.
pub const FULL: &str = "full";

/// Does this player own the game?
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Owned {
    /// No answer yet (fresh install, offline, before sign-in). Plays as the demo.
    #[default]
    Unknown,
    Demo,
    Full,
}

/// What the demo includes (the listing's `demo`; these defaults when it
/// can't be read).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DemoScope {
    /// Story chapters 1..=n are free.
    pub story_chapters: u8,
    pub kids_mode: bool,
}

impl Default for DemoScope {
    fn default() -> Self {
        DemoScope { story_chapters: 2, kids_mode: true }
    }
}

impl DemoScope {
    /// Read a store listing (`GET /v1/store/games/{game}` → `game.demo`).
    /// `None` when the listing has no demo object (keep the defaults).
    pub fn from_listing(v: &serde_json::Value) -> Option<DemoScope> {
        let demo = v.get("game").map_or(v, |g| g).get("demo")?.as_object()?;
        let d = DemoScope::default();
        let chapters = demo.get("story_chapters").and_then(|c| c.as_u64()).map_or(d.story_chapters, |c| c.clamp(1, crate::story::CHAPTERS as u64) as u8);
        let kids = demo.get("kids_mode").and_then(|k| k.as_bool()).unwrap_or(d.kids_mode);
        Some(DemoScope { story_chapters: chapters, kids_mode: kids })
    }
}

/// Something the player wants to do that might need the full game.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feature {
    /// Open a room for phones / guest screens, or play Party on this screen.
    Host,
    /// Join a friend's room (always free).
    Join,
    Sandbox,
    Kids,
    /// Start this story chapter (1-based).
    Chapter(u8),
}

/// The gate: is `f` allowed for this player?
pub fn allows(owned: Owned, scope: DemoScope, f: Feature) -> bool {
    if owned == Owned::Full {
        return true;
    }
    match f {
        Feature::Join => true,
        Feature::Kids => scope.kids_mode,
        Feature::Chapter(c) => c <= scope.story_chapters.max(1),
        Feature::Host | Feature::Sandbox => false,
    }
}

/// Combine a dev override with what the account says.
pub fn resolve(dev: Option<bool>, owns: Option<bool>) -> Owned {
    match dev.or(owns) {
        Some(true) => Owned::Full,
        Some(false) => Owned::Demo,
        None => Owned::Unknown,
    }
}

/// The dev override: `BB_DEMO` wins; `BB_OWNED` counts only in debug
/// builds; headless dev runs act as owned.
pub fn dev_override(owned_env: bool, demo_env: bool, debug_build: bool, headless: bool) -> Option<bool> {
    if demo_env {
        Some(false)
    } else if (owned_env && debug_build) || headless {
        Some(true)
    } else {
        None
    }
}

fn env_on(k: &str) -> bool {
    std::env::var(k).is_ok_and(|v| !v.is_empty() && v != "0")
}

/// Where a purchase is.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum BuyStatus {
    #[default]
    Idle,
    /// The App Store sheet is up (iOS).
    InStore,
    /// Sending a store receipt to partii.
    Verifying,
    /// Asking the App Store what this Apple ID already owns.
    Restoring,
    Failed(String),
}

impl BuyStatus {
    /// A short friendly line for the unlock page.
    pub fn line(&self, owned: Owned) -> String {
        if owned == Owned::Full {
            return "Unlocked! Thanks for buying Bouncy Blobs.".into();
        }
        match self {
            BuyStatus::Idle => String::new(),
            BuyStatus::InStore => "Talking to the App Store...".into(),
            BuyStatus::Verifying => "Unlocking...".into(),
            BuyStatus::Restoring => "Looking for your purchase...".into(),
            BuyStatus::Failed(m) => m.clone(),
        }
    }

    pub fn busy(&self) -> bool {
        matches!(self, BuyStatus::InStore | BuyStatus::Verifying | BuyStatus::Restoring)
    }
}

/// The player's ownership, refreshed every frame from the account.
#[derive(Resource, Clone, Debug, Default, PartialEq)]
pub struct Ownership {
    pub owned: Owned,
    pub scope: DemoScope,
    pub buy: BuyStatus,
    /// The App Store's localized price for the full game ("$4.99"), once
    /// StoreKit fetched it (iOS only; `None` elsewhere).
    pub price: Option<String>,
}

impl Ownership {
    pub fn allows(&self, f: Feature) -> bool {
        allows(self.owned, self.scope, f)
    }
    pub fn full(&self) -> bool {
        self.owned == Owned::Full
    }
}

/// Is `f` allowed? Without the resource (unit tests running bare plugins),
/// everything is.
pub fn allowed(own: Option<&Ownership>, f: Feature) -> bool {
    own.is_none_or(|o| o.allows(f))
}

/// Start buying the full game.
#[derive(Message, Clone, Copy, Debug)]
pub struct BuyRequest;

/// Open the game's Steam store page (the demo's "Wishlist Now").
#[derive(Message, Clone, Copy, Debug)]
pub struct WishlistRequest;

/// The game's Steam app (achievements use it too).
pub const STEAM_APP: u32 = 4485010;
/// Its store page, where wishlisting happens.
pub const STEAM_STORE_URL: &str = "https://store.steampowered.com/app/4485010/";

/// iOS: find this Apple ID's purchase again ("Restore Purchases").
#[derive(Message, Clone, Copy, Debug)]
pub struct RestoreRequest;

/// True where purchases go through the platform's own store (StoreKit).
pub const NATIVE_STORE: bool = cfg!(target_os = "ios");

/// Which store rules the menus follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Storefront {
    /// iOS / iPadOS: buy only through StoreKit. No wishlist, no Steam, no
    /// web checkout, no link out to any of them; Restore Purchases offered.
    AppStore,
    /// Desktop (Steam, partii checkout), Android and the web: "Wishlist Now"
    /// opens the Steam page.
    Open,
}

impl Storefront {
    /// The platform this build runs on.
    pub const PLATFORM: Storefront = if NATIVE_STORE { Storefront::AppStore } else { Storefront::Open };

    /// Show "Wishlist Now" (the Steam page)?
    pub fn wishlist(self) -> bool {
        self == Storefront::Open
    }
    /// Offer "Restore Purchases" (Apple requires it for non-consumables)?
    pub fn restore(self) -> bool {
        self == Storefront::AppStore
    }
    /// May the game open `url` (a store page, a checkout) outside the app?
    /// Never on the App Store build.
    pub fn may_open(self, _url: &str) -> bool {
        self == Storefront::Open
    }
}

/// The storefront the game follows: the platform's. Debug desktop builds
/// can preview the iOS menus with `BB_PLATFORM=ios` (layout only: buying
/// still goes through the desktop path). Nothing turns an iOS build into
/// [`Storefront::Open`].
pub fn storefront() -> Storefront {
    static S: std::sync::OnceLock<Storefront> = std::sync::OnceLock::new();
    *S.get_or_init(|| {
        let preview = cfg!(debug_assertions) && std::env::var("BB_PLATFORM").is_ok_and(|v| v.eq_ignore_ascii_case("ios"));
        if preview && Storefront::PLATFORM == Storefront::Open {
            info!("storefront: previewing the App Store menus (BB_PLATFORM=ios)");
            Storefront::AppStore
        } else {
            Storefront::PLATFORM
        }
    })
}

/// The buy button: "Get the Full Game", with the App Store's price when
/// known ("Get the Full Game  ·  $4.99"), and every character of it drawable
/// (a currency sign the font lacks drops the price, not the button).
pub fn buy_label(price: Option<&str>) -> String {
    const BUY: &str = "Get the Full Game";
    match price.map(str::trim) {
        Some(p) if !p.is_empty() && crate::softtext::missing_glyphs(p).is_empty() => format!("{BUY}  ·  {p}"),
        _ => BUY.into(),
    }
}

pub struct OwnershipPlugin;

impl Plugin for OwnershipPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Ownership>()
            .add_message::<BuyRequest>()
            .add_message::<RestoreRequest>()
            .add_message::<WishlistRequest>()
            .add_systems(Startup, crate::store::start)
            .add_systems(PreUpdate, track)
            .add_systems(Update, (buy, wishlist));
        #[cfg(not(target_arch = "wasm32"))]
        app.add_systems(Update, checkout.after(buy));
    }
}

/// The dev override for this run (read once).
fn dev() -> Option<bool> {
    static DEV: std::sync::OnceLock<Option<bool>> = std::sync::OnceLock::new();
    *DEV.get_or_init(|| {
        // A test player token (`BB_PARTII_PLAYER_TOKEN`) means "test the real
        // entitlement", so headless runs with one don't assume owned.
        let tooling = crate::platform::headless() && !env_on("BB_PARTII_PLAYER_TOKEN");
        let d = dev_override(env_on("BB_OWNED"), env_on("BB_DEMO"), cfg!(debug_assertions), tooling);
        if let Some(d) = d {
            info!("ownership: dev override, {}", if d { "owned" } else { "demo" });
        }
        d
    })
}

/// The demo scope from the listing, once fetched (native, signed in).
static LISTING: std::sync::Mutex<Option<DemoScope>> = std::sync::Mutex::new(None);
/// The listing's price ("$4.99"), for desktop's buy buttons and screen.
static LISTING_PRICE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// Bought during this run (the buy screen saw the payment land). Wins over
/// everything, `BB_DEMO` included, so a purchase unlocks at once.
static BOUGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The purchase landed: unlock now, with no restart.
pub fn mark_bought() {
    BOUGHT.store(true, std::sync::atomic::Ordering::Relaxed);
}

fn bought() -> bool {
    BOUGHT.load(std::sync::atomic::Ordering::Relaxed)
}

/// Follow the account: owned / demo / unknown, and the listing's demo scope.
fn track(mut own: ResMut<Ownership>, mut asked: Local<bool>) {
    #[cfg(not(target_arch = "wasm32"))]
    let owns = crate::account::get().and_then(|a| {
        // Once signed in, read the listing's demo scope (once, off-frame).
        if !*asked && a.ready() {
            *asked = true;
            if let Some(c) = a.client() {
                std::thread::spawn(move || {
                    let Ok(v) = c.json("storeGame", &[("game", crate::account::GAME)], None) else { return };
                    if let Some(s) = DemoScope::from_listing(&v) {
                        *LISTING.lock().unwrap_or_else(|p| p.into_inner()) = Some(s);
                    }
                    *LISTING_PRICE.lock().unwrap_or_else(|p| p.into_inner()) = crate::buy_flow::listing_price(&v);
                });
            }
        }
        a.owns(FULL)
    });
    #[cfg(target_arch = "wasm32")]
    let owns: Option<bool> = {
        let _ = &mut asked;
        None
    };
    let owned = if bought() { Owned::Full } else { resolve(dev(), owns) };
    if own.price.is_none() && NATIVE_STORE {
        if let Some(p) = crate::store::price() {
            info!("store: full game is {p}");
            own.price = Some(p);
        }
    }
    // Desktop: the store listing's price.
    if own.price.is_none() && !NATIVE_STORE {
        if let Some(p) = LISTING_PRICE.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            info!("store: full game is {p}");
            own.price = Some(p);
        }
    }
    let scope = LISTING.lock().unwrap_or_else(|p| p.into_inner()).unwrap_or_default();
    if own.owned != owned {
        info!("ownership: {:?} -> {:?}", own.owned, owned);
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(a) = crate::account::get() {
            a.set_owned(owned == Owned::Full);
        }
        own.owned = owned;
        if owned == Owned::Full {
            own.buy = BuyStatus::Idle;
        }
    }
    if own.scope != scope {
        own.scope = scope;
    }
}

/// Buy and Restore buttons.
fn buy(mut own: ResMut<Ownership>, mut buys: MessageReader<BuyRequest>, mut restores: MessageReader<RestoreRequest>) {
    let wants_buy = buys.read().count() > 0;
    let wants_restore = restores.read().count() > 0;
    if own.full() || own.buy.busy() {
        return;
    }
    if wants_restore {
        own.buy = if crate::store::restore() { BuyStatus::Restoring } else { BuyStatus::Failed("Restoring isn't available here.".into()) };
        return;
    }
    if !wants_buy {
        return;
    }
    if NATIVE_STORE {
        own.buy = if crate::store::purchase() { BuyStatus::InStore } else { BuyStatus::Failed("The App Store isn't available in this build yet.".into()) };
        return;
    }
    // Desktop: the buy screen takes it from here.
    if crate::buy_screen::DESKTOP {
        return;
    }
    own.buy = BuyStatus::Failed(if cfg!(target_os = "android") { "Get the full game at partii.games".into() } else { "Can't reach the store right now. Try again in a bit.".into() });
}

/// "Wishlist Now": the Steam overlay's store page for this app when Steam is
/// running the game, else the store page in the browser.
fn wishlist(mut wishes: MessageReader<WishlistRequest>, ach: Option<Res<crate::achievements::Achievements>>) {
    if wishes.read().count() == 0 {
        return;
    }
    // App Store rules: no way out to Steam (the menus never offer it there).
    if !storefront().wishlist() {
        warn!("wishlist: not offered on the App Store build");
        return;
    }
    if crate::platform::headless() {
        info!("wishlist: {STEAM_STORE_URL} (headless: not opened)");
        return;
    }
    if ach.is_some_and(|a| a.open_store_overlay(STEAM_APP)) {
        return;
    }
    open_url(STEAM_STORE_URL);
}

/// StoreKit events and their receipts (iOS). Desktop purchases are the buy
/// screen's ([`crate::buy_screen`]).
#[cfg(not(target_arch = "wasm32"))]
fn checkout(mut own: ResMut<Ownership>, mut receipts: Local<std::collections::VecDeque<String>>, mut submitted: Local<Option<String>>) {
    let Some(a) = crate::account::get() else { return };
    {
        // StoreKit: purchases and restores, each verified by partii before
        // the transaction is finished.
        while let Some(ev) = crate::store::poll() {
            match ev {
                crate::store::StoreEvent::Purchased(id) => {
                    if !receipts.contains(&id) && submitted.as_ref() != Some(&id) {
                        receipts.push_back(id);
                    }
                }
                crate::store::StoreEvent::Restored(ids) => {
                    if ids.is_empty() && submitted.is_none() && receipts.is_empty() {
                        own.buy = BuyStatus::Failed("No purchase found for this Apple ID.".into());
                    }
                    for id in ids {
                        if !receipts.contains(&id) && submitted.as_ref() != Some(&id) {
                            receipts.push_back(id);
                        }
                    }
                }
                crate::store::StoreEvent::Cancelled => own.buy = BuyStatus::Idle,
                crate::store::StoreEvent::Pending => own.buy = BuyStatus::Failed("Waiting for approval (Ask to Buy).".into()),
                crate::store::StoreEvent::Failed(m) => own.buy = BuyStatus::Failed(m),
            }
        }
        if let Some(id) = submitted.clone() {
            if let Some(out) = a.take_receipt() {
                *submitted = None;
                match out {
                    Ok(()) => {
                        // partii has it: now the App Store can let go.
                        crate::store::finish(&id);
                        if receipts.is_empty() && !own.full() {
                            own.buy = BuyStatus::Verifying;
                        }
                    }
                    Err((code, msg)) => {
                        // Not finished: StoreKit hands it back next launch.
                        warn!("receipt {id}: {code}: {msg}");
                        own.buy = BuyStatus::Failed(if code == "claimed_by_another_account" {
                            "This purchase belongs to another partii account. Sign in to that one.".into()
                        } else {
                            "Couldn't unlock yet. We'll try again next time.".into()
                        });
                    }
                }
            }
        } else if let Some(id) = receipts.pop_front() {
            a.submit_receipt("appstore", serde_json::json!({ "transaction": id }));
            *submitted = Some(id);
            own.buy = BuyStatus::Verifying;
        }
    }
}

/// Open a web page (a checkout, the Steam store page) in the default
/// browser; iOS and Android hand it to the system, the web build opens a new
/// tab. Headless runs only log it (they never open anything on screen).
/// The App Store build opens nothing: no link out to another store or a
/// checkout.
pub fn open_url(url: &str) {
    if !Storefront::PLATFORM.may_open(url) || !storefront().may_open(url) {
        warn!("open: {url} refused (App Store build: purchases stay in StoreKit)");
        return;
    }
    if crate::platform::headless() {
        info!("open: {url} (headless: not opened)");
        return;
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn().map(drop);
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn().map(drop);
    #[cfg(all(unix, not(any(target_os = "macos", target_os = "ios", target_os = "android"))))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn().map(drop);
    #[cfg(target_os = "ios")]
    let r = crate::platform::open_url_ios(url);
    #[cfg(target_os = "android")]
    let r = crate::platform::open_url_android(url);
    #[cfg(target_arch = "wasm32")]
    let r = web_sys::window()
        .ok_or_else(|| std::io::Error::other("no window"))
        .and_then(|w| w.open_with_url_and_target(url, "_blank").map(drop).map_err(|e| std::io::Error::other(format!("{e:?}"))));
    if let Err(e) = r {
        warn!("open: couldn't open {url}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ALL: [Feature; 6] = [Feature::Host, Feature::Join, Feature::Sandbox, Feature::Kids, Feature::Chapter(1), Feature::Chapter(10)];

    #[test]
    fn owners_can_do_everything() {
        for f in ALL {
            assert!(allows(Owned::Full, DemoScope::default(), f), "{f:?}");
        }
    }

    #[test]
    fn the_demo_is_join_kids_and_two_chapters() {
        for owned in [Owned::Demo, Owned::Unknown] {
            let s = DemoScope::default();
            assert!(allows(owned, s, Feature::Join));
            assert!(allows(owned, s, Feature::Kids));
            assert!(allows(owned, s, Feature::Chapter(1)));
            assert!(allows(owned, s, Feature::Chapter(2)));
            assert!(!allows(owned, s, Feature::Chapter(3)));
            assert!(!allows(owned, s, Feature::Chapter(10)));
            assert!(!allows(owned, s, Feature::Host));
            assert!(!allows(owned, s, Feature::Sandbox));
        }
    }

    #[test]
    fn the_scope_follows_the_listing() {
        let three = DemoScope { story_chapters: 3, kids_mode: false };
        assert!(allows(Owned::Demo, three, Feature::Chapter(3)));
        assert!(!allows(Owned::Demo, three, Feature::Chapter(4)));
        assert!(!allows(Owned::Demo, three, Feature::Kids));
        // Chapter 1 is always the free taste, whatever the listing says.
        assert!(allows(Owned::Demo, DemoScope { story_chapters: 0, kids_mode: true }, Feature::Chapter(1)));
        assert!(allows(Owned::Demo, three, Feature::Join));
    }

    #[test]
    fn listing_demo_parses_with_defaults() {
        let v = json!({"ok": true, "game": {"demo": {"join_free": true, "free": ["Kids Mode", "Story chapters 1-2"], "kids_mode": true, "story_chapters": 2}}});
        assert_eq!(DemoScope::from_listing(&v), Some(DemoScope { story_chapters: 2, kids_mode: true }));
        // An older listing that still says 1 is followed (the listing wins).
        let v = json!({"game": {"demo": {"story_chapters": 1}}});
        assert_eq!(DemoScope::from_listing(&v), Some(DemoScope { story_chapters: 1, kids_mode: true }));
        let v = json!({"game": {"demo": {"story_chapters": 99}}});
        assert_eq!(DemoScope::from_listing(&v), Some(DemoScope { story_chapters: crate::story::CHAPTERS, kids_mode: true }));
        assert_eq!(DemoScope::from_listing(&json!({"game": {"demo": null}})), None);
        assert_eq!(DemoScope::from_listing(&json!({"demo": {"kids_mode": false}})), Some(DemoScope { story_chapters: 2, kids_mode: false }));
    }

    #[test]
    fn unknown_is_not_owned_but_a_cached_yes_is() {
        assert_eq!(resolve(None, None), Owned::Unknown);
        // Before ready(), `owns` is the signed offline cache: a cached yes unlocks.
        assert_eq!(resolve(None, Some(true)), Owned::Full);
        assert_eq!(resolve(None, Some(false)), Owned::Demo);
        assert_eq!(resolve(Some(false), Some(true)), Owned::Demo);
        assert_eq!(resolve(Some(true), None), Owned::Full);
    }

    #[test]
    fn dev_overrides() {
        assert_eq!(dev_override(false, false, true, false), None);
        assert_eq!(dev_override(true, false, true, false), Some(true));
        // BB_OWNED never unlocks a release build.
        assert_eq!(dev_override(true, false, false, false), None);
        assert_eq!(dev_override(true, true, true, false), Some(false));
        // Headless tooling sees everything, unless asked for the demo.
        assert_eq!(dev_override(false, false, false, true), Some(true));
        assert_eq!(dev_override(false, true, false, true), Some(false));
    }

    #[test]
    fn app_store_has_no_way_out_to_another_store() {
        let s = Storefront::AppStore;
        assert!(!s.wishlist());
        assert!(s.restore());
        for url in [STEAM_STORE_URL, "https://partii.games/checkout/abc", "https://bouncy-blobs.partii.games", "steam://store/4485010"] {
            assert!(!s.may_open(url), "{url}");
        }
        // Desktop, Android, web: the Steam page as before; no Restore.
        let o = Storefront::Open;
        assert!(o.wishlist() && !o.restore() && o.may_open(STEAM_STORE_URL));
        // This build's platform: iOS is the App Store, everything else is open.
        assert_eq!(Storefront::PLATFORM == Storefront::AppStore, cfg!(target_os = "ios"));
    }

    #[test]
    fn buy_label_shows_a_drawable_price() {
        assert_eq!(buy_label(None), "Get the Full Game");
        assert_eq!(buy_label(Some("$4.99")), "Get the Full Game  ·  $4.99");
        assert_eq!(buy_label(Some("  ")), "Get the Full Game");
        // A currency sign the font can't draw keeps the plain label.
        let odd = "\u{20b9}\u{1F600}499";
        if !crate::softtext::missing_glyphs(odd).is_empty() {
            assert_eq!(buy_label(Some(odd)), "Get the Full Game");
        }
        assert!(crate::softtext::missing_glyphs(&buy_label(Some("$4.99"))).is_empty());
    }

    #[test]
    fn no_resource_means_no_gate() {
        assert!(allowed(None, Feature::Host));
        let demo = Ownership { owned: Owned::Demo, ..default() };
        assert!(!allowed(Some(&demo), Feature::Host));
        assert!(allowed(Some(&demo), Feature::Join));
    }
}
