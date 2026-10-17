//! The desktop buy screen: an overlay over wherever "Get the Full Game" was
//! pressed (the demo title, a locked tile's unlock page, the demo's end
//! card). It shows what the full game brings, the price, a big QR code of
//! partii's Stripe Checkout ("Scan to pay on your phone"), "Pay in browser
//! instead", a status line and Back. When the payment lands: confetti, a
//! jelly pop, "Thanks! The full game is unlocked", and back to where you
//! were with everything unlocked, live.
//!
//! The flow itself (polling, expiry, errors) is [`crate::buy_flow`]; this is
//! its face and its driver. iOS buys through StoreKit and Steam builds
//! running under Steam through the Steam overlay: neither opens this.
//!
//! Streamer mode (Settings) hides the QR behind "Show QR code"; "Pay in
//! browser" stays.
//!
//! Navigation: mouse / touch on the buttons; arrows, Tab, Enter / Space;
//! a pad's stick or d-pad and A; Escape, Backspace or B goes back.

use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::buy_flow::{BuyFlow, BuyStore, Effect, FakeStore, Phase};
use crate::ownership::{BuyRequest, Ownership};
use crate::softtext::JiggleText;

/// This build buys through the buy screen (desktop: not iOS, Android or
/// the web).
pub const DESKTOP: bool = cfg!(not(any(target_os = "ios", target_os = "android", target_arch = "wasm32")));

/// Seconds after opening before a press counts (the press that opened it).
const ARM: f32 = 0.35;

/// The buy screen's state. Always present; [`BuyScreen::blocking`] tells
/// the screens underneath to leave input alone.
#[derive(Resource, Default)]
pub struct BuyScreen {
    pub flow: BuyFlow,
    /// Effects from input, applied by the driver this frame.
    queue: Vec<Effect>,
    /// Frames to keep swallowing input after closing (the Escape that
    /// closed it mustn't also leave the page underneath).
    shield: u8,
    /// Seconds since it opened.
    age: f32,
    /// Streamer mode: the player chose to show the QR anyway.
    pub revealed: bool,
    focus: usize,
    view: Option<View>,
    root: Option<Entity>,
    qr: Option<(String, Handle<Image>)>,
}

impl BuyScreen {
    /// Up, or just closed: other screens take no input.
    pub fn blocking(&self) -> bool {
        self.flow.open() || self.shield > 0
    }
    /// Is the QR hidden (streamer mode, not revealed)?
    pub fn qr_hidden(&self) -> bool {
        crate::net::ui::streamer() && !self.revealed
    }
}

/// True while the buy screen is up or just closed.
pub fn blocking(screen: Option<&BuyScreen>) -> bool {
    screen.is_some_and(|s| s.blocking())
}

/// The screen's buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuyAction {
    PayInBrowser,
    /// Streamer mode: show the QR.
    Reveal,
    Retry,
    NewCode,
    Back,
}

impl BuyAction {
    pub fn label(self) -> &'static str {
        match self {
            BuyAction::PayInBrowser => "Pay in browser instead",
            BuyAction::Reveal => "Show QR code",
            BuyAction::Retry => "Retry",
            BuyAction::NewCode => "Get a new code",
            BuyAction::Back => "Back",
        }
    }
    fn color(self) -> u32 {
        match self {
            BuyAction::PayInBrowser | BuyAction::Retry | BuyAction::NewCode => crate::menu::BUY_COLOR,
            BuyAction::Reveal => crate::menu::RESTORE_COLOR,
            BuyAction::Back => 0xd0c4e8,
        }
    }
}

/// The buttons for a phase.
pub fn actions(phase: &Phase, qr_hidden: bool) -> Vec<BuyAction> {
    match phase {
        Phase::Idle | Phase::Paid { .. } => vec![],
        Phase::Showing { .. } if qr_hidden => vec![BuyAction::PayInBrowser, BuyAction::Reveal, BuyAction::Back],
        Phase::Showing { .. } => vec![BuyAction::PayInBrowser, BuyAction::Back],
        Phase::Expired => vec![BuyAction::NewCode, BuyAction::Back],
        Phase::Offline | Phase::Failed => vec![BuyAction::Retry, BuyAction::Back],
        Phase::Creating | Phase::Confirming { .. } => vec![BuyAction::Back],
    }
}

/// What the full game brings (the card's list).
pub const PERKS: [&str; 4] = ["All 10 chapters of Pip's story", "Host a Party with phones", "Sandbox", "Friends always join free"];

/// The title line.
pub const TITLE: &str = "Get the Full Game";
pub const THANKS: &str = "Thanks!";
pub const UNLOCKED: &str = "The full game is unlocked";
pub const SCAN: &str = "Scan to pay on your phone";
pub const WALLETS: &str = "(Apple Pay / Google Pay)";
pub const HIDDEN: &str = "QR hidden for Streamer Mode";

/// The price line ("$4.99 · yours to keep").
pub fn price_line(price: Option<&str>) -> String {
    match price.map(str::trim).filter(|p| !p.is_empty() && crate::softtext::missing_glyphs(p).is_empty()) {
        Some(p) => format!("{p}  ·  one-time, yours to keep"),
        None => "One-time purchase, yours to keep".into(),
    }
}

/// A button on the screen.
#[derive(Component, Clone, Copy, Debug)]
pub struct BuyButton(pub BuyAction);

/// The QR image (present only while the QR shows).
#[derive(Component)]
pub struct BuyQr;

/// The status line.
#[derive(Component)]
pub struct BuyStatusLine;

#[derive(Component)]
struct BuyRoot;

/// The card: pops like jelly when it opens and when the payment lands.
#[derive(Component)]
struct Pop {
    s: f32,
    v: f32,
}

#[derive(Component)]
struct Confetti {
    pos: Vec2,
    vel: Vec2,
    rot: f32,
    spin: f32,
    life: f32,
}

/// What the overlay shows; it's rebuilt when this changes.
#[derive(Clone, Debug, PartialEq)]
struct View {
    phase: u8,
    hidden: bool,
    session: Option<String>,
    price: Option<String>,
    actions: Vec<BuyAction>,
}

fn phase_kind(p: &Phase) -> u8 {
    match p {
        Phase::Idle => 0,
        Phase::Creating => 1,
        Phase::Showing { .. } => 2,
        Phase::Confirming { .. } => 3,
        Phase::Expired => 4,
        Phase::Offline => 5,
        Phase::Failed => 6,
        Phase::Paid { .. } => 7,
    }
}

pub struct BuyScreenPlugin;

impl Plugin for BuyScreenPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BuyScreen>();
        // Tests (and other tools) put their own store in first.
        if !app.world().contains_resource::<BuyStore>() {
            app.insert_resource(default_store());
        }
        app.add_systems(Update, (input, drive, view, pop, confetti).chain());
    }
}

/// partii in the game. Debug builds take `BB_FAKE_STORE=1` (a store that
/// hands out a test code and is never paid) or `BB_FAKE_STORE=paid` (paid
/// at the first check, 2.5 s in), for screenshots.
fn default_store() -> BuyStore {
    let fake = if cfg!(debug_assertions) { std::env::var("BB_FAKE_STORE").ok().filter(|v| !v.is_empty() && v != "0") } else { None };
    if let Some(mode) = fake {
        info!("buy: fake store (BB_FAKE_STORE={mode})");
        let f = FakeStore::new();
        if mode == "paid" {
            f.pay();
        }
        return BuyStore(std::sync::Arc::new(f));
    }
    #[cfg(not(target_arch = "wasm32"))]
    return BuyStore(std::sync::Arc::new(crate::buy_flow::PartiiStore::default()));
    #[cfg(target_arch = "wasm32")]
    BuyStore(std::sync::Arc::new(FakeStore::answering(crate::buy_flow::CheckoutReply::Offline)))
}

/// Carry out the flow's effects.
fn apply(effects: Vec<Effect>, screen: &mut BuyScreen, store: &BuyStore) {
    for e in effects {
        match e {
            Effect::CreateCheckout => {
                let site = bb_net::NetConfig::from_env().controller_url;
                let (ok, cancel) = crate::buy_flow::return_urls(&site);
                store.0.create_checkout(&ok, &cancel);
            }
            Effect::CheckOwned => store.0.check_owned(),
            Effect::OpenBrowser(url) => crate::ownership::open_url(&url),
            Effect::Unlocked => {
                info!("buy: paid, unlocking the full game");
                crate::ownership::mark_bought();
            }
            Effect::Close => {
                screen.shield = 3;
                screen.revealed = false;
            }
        }
    }
}

/// Requests, store answers, ownership news, time.
#[allow(clippy::too_many_arguments)]
fn drive(
    mut screen: ResMut<BuyScreen>,
    store: Res<BuyStore>,
    time: Res<Time>,
    own: Res<Ownership>,
    mut requests: MessageReader<BuyRequest>,
    mut focus: MessageReader<bevy::window::WindowFocused>,
    ach: Option<Res<crate::achievements::Achievements>>,
) {
    let s = &mut *screen;
    s.shield = s.shield.saturating_sub(1);
    let mut fx = std::mem::take(&mut s.queue);
    if requests.read().count() > 0 && DESKTOP && !own.full() {
        // Steam builds under Steam sell through Steam's own store.
        if ach.is_some_and(|a| a.open_store_overlay(crate::ownership::STEAM_APP)) {
            info!("buy: Steam overlay store page");
        } else if !s.flow.open() {
            s.age = 0.0;
            s.revealed = false;
            fx.extend(s.flow.start());
        }
    }
    if let Some(r) = store.0.take_checkout() {
        fx.extend(s.flow.on_reply(r));
    }
    // Ownership news: what the last check (or a push) heard.
    if s.flow.open() && store.0.owned() {
        fx.extend(s.flow.on_owned());
    }
    if focus.read().any(|f| f.focused) {
        fx.extend(s.flow.refocused());
    }
    if s.flow.open() {
        s.age += time.delta_secs();
    }
    fx.extend(s.flow.tick(time.delta_secs()));
    apply(fx, s, &store);
}

/// Buttons (mouse, touch), keys, pads.
#[allow(clippy::too_many_arguments)]
fn input(
    mut screen: ResMut<BuyScreen>,
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    pads: Query<&Gamepad>,
    inputs: Res<crate::sim::Inputs>,
    (mouse, touches, windows): (Res<ButtonInput<MouseButton>>, Res<Touches>, Query<&Window, With<bevy::window::PrimaryWindow>>),
    mut buttons: Query<(&BuyButton, &UiGlobalTransform, &ComputedNode, &mut BackgroundColor, &mut BorderColor)>,
    (mut cool, mut pressed_on, mut hovered): (Local<(f32, bool)>, Local<Option<BuyAction>>, Local<Option<BuyAction>>),
) {
    let s = &mut *screen;
    if !s.flow.open() || s.view.is_none() {
        cool.1 = true;
        *pressed_on = None;
        *hovered = None;
        return;
    }
    let list = actions(&s.flow.phase, s.qr_hidden());
    if s.focus >= list.len() {
        s.focus = 0;
    }
    // Focus: arrows / Tab / d-pad / stick (any slot, so phones too).
    cool.0 = (cool.0 - time.delta_secs()).max(0.0);
    let stick = inputs.slots.iter().fold(Vec2::ZERO, |a, i| a + Vec2::new(i.stick.x, i.stick.y));
    let shift = keys.pressed(KeyCode::ShiftLeft) || keys.pressed(KeyCode::ShiftRight);
    let up = keys.any_just_pressed([KeyCode::ArrowUp, KeyCode::ArrowLeft])
        || (keys.just_pressed(KeyCode::Tab) && shift)
        || pads.iter().any(|p| p.any_just_pressed([GamepadButton::DPadUp, GamepadButton::DPadLeft]))
        || (cool.0 <= 0.0 && (stick.y > 0.5 || stick.x < -0.5));
    let down = keys.any_just_pressed([KeyCode::ArrowDown, KeyCode::ArrowRight])
        || (keys.just_pressed(KeyCode::Tab) && !shift)
        || pads.iter().any(|p| p.any_just_pressed([GamepadButton::DPadDown, GamepadButton::DPadRight]))
        || (cool.0 <= 0.0 && (stick.y < -0.5 || stick.x > 0.5));
    if !list.is_empty() && (up || down) {
        let n = list.len();
        s.focus = if up { (s.focus + n - 1) % n } else { (s.focus + 1) % n };
        cool.0 = 0.22;
    }
    // The pointer: hover focuses; a click (press and release on the same
    // button) or a tap presses. Hit-tested here, not through bevy_ui's
    // Interaction, so it works whatever the camera renders to.
    let cursor = windows.iter().next().and_then(|w| w.cursor_position());
    let hit = |at: Vec2, buttons: &Query<(&BuyButton, &UiGlobalTransform, &ComputedNode, &mut BackgroundColor, &mut BorderColor)>| {
        buttons.iter().find_map(|(b, tf, node, _, _)| {
            let k = node.inverse_scale_factor();
            let (c, half) = (tf.translation * k, node.size() * k * 0.5);
            (list.contains(&b.0) && (at - c).abs().cmple(half).all()).then_some(b.0)
        })
    };
    let over = cursor.and_then(|at| hit(at, &buttons));
    let mut chosen = None;
    if mouse.just_pressed(MouseButton::Left) {
        *pressed_on = over;
    }
    if mouse.just_released(MouseButton::Left) {
        if over.is_some() && over == *pressed_on {
            chosen = over;
        }
        *pressed_on = None;
    }
    for t in touches.iter_just_released() {
        if let Some(a) = hit(t.position(), &buttons) {
            chosen = Some(a);
        }
    }
    // Moving onto a button focuses it (keys and pads keep theirs until the
    // pointer moves to another one).
    if over != *hovered {
        *hovered = over;
        if let Some(k) = over.and_then(|a| list.iter().position(|x| *x == a)) {
            s.focus = k;
        }
    }
    for (b, _, _, mut fill, mut rim) in buttons.iter_mut() {
        let Some(k) = list.iter().position(|a| *a == b.0) else { continue };
        let c = crate::palette::hex(b.0.color());
        let focused = s.focus == k;
        fill.0 = if focused { c.lighter(0.08) } else { c.darker(0.12) };
        *rim = BorderColor::all(if focused { Color::WHITE } else { c.darker(0.4) });
    }
    // A phone's button (slots past the keyboard's) presses too.
    let phone = inputs.slots.iter().skip(1).any(|i| i.button);
    let tapped = phone && !cool.1;
    cool.1 = phone;
    if chosen.is_none()
        && (keys.any_just_pressed([KeyCode::Enter, KeyCode::Space, KeyCode::NumpadEnter]) || pads.iter().any(|p| p.just_pressed(GamepadButton::South)) || tapped)
    {
        chosen = list.get(s.focus).copied();
    }
    if crate::input::back_pressed(&keys, pads.iter()) {
        chosen = Some(BuyAction::Back);
    }
    if s.age < ARM && chosen != Some(BuyAction::Back) {
        return;
    }
    let fx = match chosen {
        Some(BuyAction::PayInBrowser) => s.flow.pay_in_browser(),
        Some(BuyAction::Reveal) => {
            s.revealed = true;
            vec![]
        }
        Some(BuyAction::Retry | BuyAction::NewCode) => s.flow.retry(),
        Some(BuyAction::Back) => s.flow.close(),
        None => vec![],
    };
    s.queue.extend(fx);
}

/// Build (and rebuild) the overlay to match the flow.
#[allow(clippy::too_many_arguments)]
fn view(
    mut commands: Commands,
    mut screen: ResMut<BuyScreen>,
    assets: Res<GameAssets>,
    own: Res<Ownership>,
    mut images: ResMut<Assets<Image>>,
    mut status: Query<&mut Text, With<BuyStatusLine>>,
) {
    let s = &mut *screen;
    if !s.flow.open() {
        if let Some(e) = s.root.take() {
            commands.entity(e).despawn();
        }
        s.view = None;
        s.qr = None;
        return;
    }
    let hidden = s.qr_hidden();
    let want = View {
        phase: phase_kind(&s.flow.phase),
        hidden,
        session: s.flow.checkout().map(|c| c.session.clone()),
        price: own.price.clone(),
        actions: actions(&s.flow.phase, hidden),
    };
    if s.view.as_ref() == Some(&want) {
        let line = s.flow.status();
        for mut t in status.iter_mut() {
            if t.0 != line {
                t.0 = line.clone();
            }
        }
        return;
    }
    let first = s.view.is_none();
    let paid = matches!(s.flow.phase, Phase::Paid { .. });
    if let Some(e) = s.root.take() {
        commands.entity(e).despawn();
    }
    // The QR image, made once per checkout.
    let qr = match s.flow.checkout() {
        Some(c) if !hidden => {
            if s.qr.as_ref().is_none_or(|(u, _)| *u != c.url) {
                s.qr = crate::net::ui::qr_image_ec(&c.url, qrcode::EcLevel::L).map(|img| (c.url.clone(), images.add(img)));
            }
            s.qr.as_ref().map(|q| q.1.clone())
        }
        _ => None,
    };
    let fonts = (assets.font.clone(), assets.font_medium.clone());
    let (root, card) = spawn_overlay(&mut commands, fonts, s, &want, qr);
    s.root = Some(root);
    s.focus = 0;
    s.view = Some(want);
    // Jelly: a big pop on opening and on paying, a wobble on any other change.
    let start = if first { 0.55 } else if paid { 1.25 } else { 0.94 };
    commands.entity(card).insert(Pop { s: start, v: if paid { 4.0 } else { 0.0 } });
    if paid {
        spawn_confetti(&mut commands, root);
    }
}

fn font(f: &Handle<Font>, vmin: f32, bold: bool) -> TextFont {
    TextFont { font: f.clone().into(), font_size: bevy::text::FontSize::VMin(vmin), weight: if bold { FontWeight::BOLD } else { FontWeight::MEDIUM }, ..default() }
}

const SHADOW: TextShadow = TextShadow { offset: Vec2::new(3.0, 4.0), color: Color::srgba(0.0, 0.0, 0.0, 0.55) };
const CREAM: Color = Color::srgb(1.0, 0.93, 0.75);
const GOLD: Color = Color::srgb(1.0, 0.78, 0.37);

/// Spawn the overlay; returns (root, card).
fn spawn_overlay(commands: &mut Commands, (bold, medium): (Handle<Font>, Handle<Font>), s: &BuyScreen, v: &View, qr: Option<Handle<Image>>) -> (Entity, Entity) {
    let paid = matches!(s.flow.phase, Phase::Paid { .. });
    let card = (
        Node {
            flex_direction: FlexDirection::Row,
            flex_wrap: FlexWrap::Wrap,
            justify_content: JustifyContent::Center,
            align_items: AlignItems::Center,
            column_gap: vmin(5.0),
            row_gap: vmin(3.0),
            padding: UiRect::all(vmin(4.0)),
            max_width: percent(96.0),
            max_height: percent(96.0),
            border: UiRect::all(vmin(0.7)),
            border_radius: BorderRadius::all(vmin(5.0)),
            ..default()
        },
        BackgroundColor(Color::srgb(0.16, 0.09, 0.25)),
        BorderColor::all(GOLD),
        UiTransform::IDENTITY,
    );
    let root = commands
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                width: percent(100.0),
                height: percent(100.0),
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                ..default()
            },
            BackgroundColor(Color::srgba(0.05, 0.02, 0.08, 0.86)),
            GlobalZIndex(95),
            BuyRoot,
        ))
        .id();
    let card = commands.spawn((card, ChildOf(root))).id();
    if paid {
        commands.entity(card).with_children(|c| {
            c.spawn((
                Node { flex_direction: FlexDirection::Column, align_items: AlignItems::Center, row_gap: vmin(2.5), padding: UiRect::axes(vmin(6.0), vmin(3.0)), ..default() },
            ))
            .with_children(|col| {
                col.spawn((Node::default(), JiggleText::new(THANKS, font(&bold, 12.0, true), Color::WHITE).shadow(SHADOW)));
                col.spawn((Text::new(UNLOCKED), font(&bold, 5.0, true), TextColor(GOLD), SHADOW));
                col.spawn((Text::new(s.flow.status()), font(&medium, 3.4, false), TextColor(CREAM), SHADOW, BuyStatusLine));
            });
        });
        return (root, card);
    }
    commands.entity(card).with_children(|c| {
        // Left: what you get, the price, the buttons, the status.
        c.spawn(Node { flex_direction: FlexDirection::Column, width: vmin(70.0), row_gap: vmin(1.6), ..default() }).with_children(|col| {
            col.spawn((Node::default(), JiggleText::new(TITLE, font(&bold, 7.2, true), Color::WHITE).shadow(SHADOW)));
            col.spawn((Text::new(price_line(v.price.as_deref())), font(&bold, 3.6, true), TextColor(GOLD), SHADOW));
            col.spawn(Node { flex_direction: FlexDirection::Column, row_gap: vmin(1.0), margin: UiRect::vertical(vmin(1.2)), ..default() }).with_children(|list| {
                for (i, perk) in PERKS.iter().enumerate() {
                    list.spawn(Node { flex_direction: FlexDirection::Row, align_items: AlignItems::Center, column_gap: vmin(1.6), ..default() }).with_children(|row| {
                        // A little jelly dot per line.
                        row.spawn((
                            Node { width: vmin(2.2), height: vmin(2.2), border_radius: BorderRadius::all(percent(50.0)), border: UiRect::all(vmin(0.35)), ..default() },
                            BackgroundColor(crate::palette::hex(crate::palette_cycle(i * 2 + 1))),
                            BorderColor::all(Color::srgba(0.0, 0.0, 0.0, 0.35)),
                        ));
                        row.spawn((Text::new(*perk), font(&medium, 3.4, false), TextColor(CREAM), SHADOW));
                    });
                }
            });
            col.spawn(Node { flex_direction: FlexDirection::Column, align_items: AlignItems::Stretch, row_gap: vmin(1.4), width: vmin(52.0), ..default() }).with_children(|btns| {
                for a in &v.actions {
                    let c = crate::palette::hex(a.color());
                    btns.spawn((
                        Button,
                        Node {
                            padding: UiRect::axes(vmin(2.6), vmin(1.3)),
                            border: UiRect::all(vmin(0.5)),
                            border_radius: BorderRadius::all(vmin(3.0)),
                            justify_content: JustifyContent::Center,
                            ..default()
                        },
                        BackgroundColor(c.darker(0.12)),
                        BorderColor::all(c.darker(0.4)),
                        BuyButton(*a),
                    ))
                    .with_children(|b| {
                        b.spawn((Text::new(a.label()), font(&bold, 3.4, true), TextColor(Color::WHITE), SHADOW));
                    });
                }
            });
            col.spawn((
                Text::new(s.flow.status()),
                font(&medium, 3.0, false),
                TextColor(Color::WHITE),
                SHADOW,
                Node { max_width: vmin(70.0), margin: UiRect::top(vmin(0.6)), ..default() },
                BuyStatusLine,
            ));
        });
        // Right: the QR (or why there isn't one) and how to use it.
        c.spawn(Node { flex_direction: FlexDirection::Column, align_items: AlignItems::Center, row_gap: vmin(1.2), ..default() }).with_children(|col| {
            let side = 46.0;
            let boxed = Node {
                width: vmin(side),
                height: vmin(side),
                padding: UiRect::all(vmin(1.2)),
                border: UiRect::all(vmin(0.6)),
                border_radius: BorderRadius::all(vmin(3.0)),
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                ..default()
            };
            match qr {
                Some(img) => {
                    col.spawn((boxed, BackgroundColor(Color::WHITE), BorderColor::all(GOLD))).with_children(|b| {
                        b.spawn((Node { width: percent(100.0), height: percent(100.0), ..default() }, ImageNode::new(img), BuyQr));
                    });
                }
                None => {
                    let msg = match &s.flow.phase {
                        Phase::Showing { .. } => HIDDEN,
                        Phase::Creating => "...",
                        Phase::Confirming { .. } => "Unlocking...",
                        Phase::Expired => "Code expired",
                        Phase::Offline => "Offline",
                        _ => "No code",
                    };
                    col.spawn((boxed, BackgroundColor(Color::srgb(0.10, 0.06, 0.16)), BorderColor::all(Color::srgb(0.55, 0.47, 0.70)))).with_children(|b| {
                        b.spawn((Text::new(msg), font(&bold, 3.6, true), TextColor(CREAM), TextLayout::justify(Justify::Center)));
                    });
                }
            }
            col.spawn((Text::new(SCAN), font(&bold, 3.4, true), TextColor(Color::WHITE), SHADOW));
            col.spawn((Text::new(WALLETS), font(&medium, 2.8, false), TextColor(CREAM), SHADOW));
        });
    });
    (root, card)
}

/// The card's jelly pop: a springy scale, a little wider than tall.
fn pop(time: Res<Time>, mut q: Query<(&mut Pop, &mut UiTransform)>) {
    let dt = time.delta_secs().min(1.0 / 20.0);
    for (mut p, mut t) in q.iter_mut() {
        for _ in 0..3 {
            let h = dt / 3.0;
            p.v += (-(p.s - 1.0) * 260.0 - p.v * 11.0) * h;
            p.s += p.v * h;
        }
        t.scale = Vec2::new(1.0 + (p.s - 1.0) * 1.15, 1.0 + (p.s - 1.0) * 0.85);
    }
}

fn spawn_confetti(commands: &mut Commands, root: Entity) {
    let mut seed = 0x9e37_79b9u32;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed % 10_000) as f32 / 10_000.0
    };
    for i in 0..90 {
        let pos = Vec2::new(10.0 + rnd() * 80.0, 38.0 + rnd() * 20.0);
        let vel = Vec2::new((rnd() - 0.5) * 70.0, -(60.0 + rnd() * 70.0));
        let (w, h) = (0.9 + rnd() * 0.9, 0.5 + rnd() * 0.6);
        commands.spawn((
            Node { position_type: PositionType::Absolute, left: percent(pos.x), top: percent(pos.y), width: vmin(w * 1.6), height: vmin(h * 1.6), border_radius: BorderRadius::all(vmin(0.3)), ..default() },
            BackgroundColor(crate::palette::hex(crate::palette_cycle(i))),
            UiTransform::IDENTITY,
            Confetti { pos, vel, rot: rnd() * 6.0, spin: (rnd() - 0.5) * 16.0, life: 2.6 + rnd() * 1.2 },
            ChildOf(root),
        ));
    }
}

/// Confetti falls (percent of the screen per second) and fades away.
fn confetti(mut commands: Commands, time: Res<Time>, mut q: Query<(Entity, &mut Confetti, &mut Node, &mut UiTransform, &mut BackgroundColor)>) {
    let dt = time.delta_secs().min(1.0 / 20.0);
    for (e, mut c, mut node, mut tf, mut bg) in q.iter_mut() {
        c.life -= dt;
        if c.life <= 0.0 {
            commands.entity(e).despawn();
            continue;
        }
        c.vel.y += 140.0 * dt;
        c.vel.x *= 1.0 - 0.8 * dt;
        let v = c.vel;
        c.pos += v * dt;
        c.rot += c.spin * dt;
        node.left = percent(c.pos.x);
        node.top = percent(c.pos.y);
        tf.rotation = Rot2::radians(c.rot);
        tf.scale = Vec2::new(c.rot.cos().abs().max(0.2), 1.0);
        bg.0.set_alpha(c.life.min(0.6) / 0.6);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buy_flow::{Checkout, CheckoutReply};

    #[test]
    fn words_have_glyphs() {
        let all = [TITLE, THANKS, UNLOCKED, SCAN, WALLETS, HIDDEN].into_iter().map(str::to_string).chain(PERKS.iter().map(|p| p.to_string())).chain(
            [BuyAction::PayInBrowser, BuyAction::Reveal, BuyAction::Retry, BuyAction::NewCode, BuyAction::Back].iter().map(|a| a.label().to_string()),
        );
        for s in all.chain([price_line(Some("$4.99")), price_line(None)]) {
            assert!(crate::softtext::missing_glyphs(&s).is_empty(), "{s:?}");
        }
    }

    #[test]
    fn every_phase_has_a_way_back() {
        let showing = Phase::Showing { checkout: Checkout { url: "u".into(), session: "s".into() }, age: 0.0, since_check: 0.0 };
        for p in [Phase::Creating, showing.clone(), Phase::Confirming { age: 0.0, since_check: 0.0 }, Phase::Expired, Phase::Offline, Phase::Failed] {
            for hidden in [false, true] {
                assert!(actions(&p, hidden).contains(&BuyAction::Back), "{p:?}");
            }
        }
        // Streamer mode keeps "Pay in browser" and adds a reveal.
        assert_eq!(actions(&showing, true), vec![BuyAction::PayInBrowser, BuyAction::Reveal, BuyAction::Back]);
        assert_eq!(actions(&showing, false), vec![BuyAction::PayInBrowser, BuyAction::Back]);
        assert_eq!(actions(&Phase::Offline, false)[0], BuyAction::Retry);
        assert_eq!(actions(&Phase::Expired, false)[0], BuyAction::NewCode);
        // The celebration closes by itself.
        assert!(actions(&Phase::Paid { age: 0.0 }, false).is_empty());
    }

    #[test]
    fn price_line_falls_back_without_a_price() {
        assert_eq!(price_line(Some("$4.99")), "$4.99  ·  one-time, yours to keep");
        assert_eq!(price_line(Some(" ")), "One-time purchase, yours to keep");
        assert_eq!(price_line(None), "One-time purchase, yours to keep");
        let _ = CheckoutReply::Offline;
    }

    /// A real Stripe checkout URL (~400 chars with its fragment) still makes
    /// a QR, and low error correction keeps its modules bigger.
    #[test]
    fn a_long_checkout_url_makes_a_scannable_qr() {
        let url = format!("https://checkout.stripe.com/c/pay/cs_test_{}#{}", "b1krJ7qIZmFMNCmxK1Ue3XQhwZKosajkTETr3vjYZve7MJq1RJm5wEB9GL", "f".repeat(300));
        let l = crate::net::ui::qr_image_ec(&url, qrcode::EcLevel::L).expect("fits");
        let m = crate::net::ui::qr_image(&url).expect("fits");
        assert!(l.width() < m.width(), "{} vs {}", l.width(), m.width());
    }

    #[test]
    fn only_desktop_uses_it() {
        assert_eq!(DESKTOP, cfg!(not(any(target_os = "ios", target_os = "android", target_arch = "wasm32"))));
    }
}
