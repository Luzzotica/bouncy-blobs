//! The end of the demo: after the last free chapter (by default chapter 2,
//! The Drip; see [`crate::ownership::DemoScope`]), the story stops on a
//! friendly card instead of the next chapter: "Get the Full Game" (Buy),
//! "Wishlist Now" (the Steam page) or "Back to Title". If the purchase lands
//! while the card is up, the first button turns into "Play Chapter 3" and the
//! story carries on.
//!
//! iOS ([`Storefront::AppStore`]): no "Wishlist Now" (no link out to Steam);
//! "Get the Full Game" is the StoreKit purchase (with the App Store's price
//! once known), and "Back to Title".
//!
//! It only ever appears at a chapter boundary, never mid-level.
//!
//! The card fits any screen ([`card_layout`]): text, buttons and spacing
//! scale together inside the safe area (phones' notch and home indicator),
//! and the buttons stack in a column on portrait or narrow screens.

use bevy::prelude::*;

use super::{Cues, EndCardUi, PendingStart, Phase, StoryFlow};
use crate::assets::GameAssets;
use crate::flow::AppState;
use crate::ownership::{BuyRequest, Ownership, Storefront, WishlistRequest, buy_label, storefront};
use crate::sim::Inputs;

/// The demo's end card is up. `chapter` is the locked chapter it stopped before.
#[derive(Resource)]
pub struct DemoEnd {
    pub chapter: u8,
    pub age: f32,
    /// No scene behind it (the story was entered at a locked chapter).
    pub opaque: bool,
    focus: usize,
    spawned: bool,
    owned: Option<bool>,
}

impl DemoEnd {
    pub fn new(chapter: u8, opaque: bool) -> DemoEnd {
        DemoEnd { chapter, age: 0.0, opaque, focus: 0, spawned: false, owned: None }
    }
}

#[derive(Component)]
struct DemoTitle;
#[derive(Component)]
struct DemoBody;
#[derive(Component)]
struct DemoStatus;
#[derive(Component)]
struct DemoButton(usize);
#[derive(Component)]
struct DemoButtonLabel(usize);
/// The card's full-screen root (its size is the screen's).
#[derive(Component)]
struct DemoRoot;
/// The gap between the body text and the buttons.
#[derive(Component)]
struct DemoSpacer;
/// The buttons' row (or column).
#[derive(Component)]
struct DemoRow;

/// The card's buttons, left to right: Buy (or "Play Chapter n" once owned),
/// Wishlist (the Steam page; demo only) and Back to Title.
const PRIMARY: usize = 0;
const WISHLIST: usize = 1;
const BACK: usize = 2;

/// The buttons on show (owners don't get the wishlist nudge; the App Store
/// build never shows it).
fn shown(owned: bool, store: Storefront) -> &'static [usize] {
    if owned || !store.wishlist() { &[PRIMARY, BACK] } else { &[PRIMARY, WISHLIST, BACK] }
}

/// The card's words for owned / not owned (also checked for glyphs).
/// `price` is the App Store's, for the buy button.
pub fn lines(chapter: u8, owned: bool, price: Option<&str>) -> (String, String, [String; 3]) {
    if owned {
        (
            "Unlocked!".into(),
            format!("Thanks! Chapter {chapter} is waiting for Pip."),
            [format!("Play Chapter {chapter}"), "Wishlist Now".into(), "Back to Title".into()],
        )
    } else {
        let more = super::CHAPTERS.saturating_sub(chapter) + 1;
        (
            "That's the demo!".into(),
            format!("Pip's story keeps going: {more} more chapters, Party with phones, and Sandbox. Friends can always join you."),
            [buy_label(price), "Wishlist Now".into(), "Back to Title".into()],
        )
    }
}

/// Seconds before the card takes a press (a held jump doesn't skip it).
const ARM: f32 = 1.2;

/// Register the card's system (runs in Story while there's a flow).
pub(super) fn add(app: &mut App) {
    app.add_systems(Update, (demo_end, fit_card).chain().run_if(in_state(AppState::Story).and_then(resource_exists::<StoryFlow>)));
}

// --- Fitting the card to the screen -------------------------------------

/// The card as designed at 1920×1080 (scale 1), in logical px.
const TITLE_FONT: f32 = 96.0;
const BODY_FONT: f32 = 32.0;
const BODY_WRAP: f32 = 900.0;
const BUTTON_FONT: f32 = 34.0;
const STATUS_FONT: f32 = 26.0;
const GAP: f32 = 14.0;
const SPACER: f32 = 26.0;
const BUTTON_PAD: Vec2 = Vec2::new(34.0, 16.0);
const BUTTON_BORDER: f32 = 5.0;
const BUTTON_RADIUS: f32 = 30.0;
const ROW_GAP: f32 = 28.0;
const COLUMN_GAP: f32 = 18.0;
/// Room kept for the status line: the longest one, wrapped.
const STATUS_SAMPLE: &str = "This purchase belongs to another partii account. Sign in to that one.";
/// Text measured with softtext's metrics (the same Fredoka) can come out a
/// little narrower than Bevy's own layout: leave this much slack.
const TEXT_SLACK: f32 = 1.08;
/// Never smaller than this (a phone in portrait lands around 0.45).
const MIN_SCALE: f32 = 0.3;

/// Space kept clear at each edge (logical px).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Insets {
    pub left: f32,
    pub right: f32,
    pub top: f32,
    pub bottom: f32,
}

/// A margin all round, plus a phone's safe area: the notch on the sides in
/// landscape (on top in portrait) and the home indicator along the bottom.
pub fn insets(view: Vec2, phone: bool) -> Insets {
    let m = (view.min_element() * 0.04).clamp(16.0, 48.0);
    let mut i = Insets { left: m, right: m, top: m, bottom: m };
    if phone {
        use crate::platform::{PHONE_HOME, PHONE_NOTCH};
        if view.x >= view.y {
            i.left += PHONE_NOTCH;
            i.right += PHONE_NOTCH;
            i.bottom += PHONE_HOME;
        } else {
            i.top += PHONE_NOTCH;
            i.bottom += PHONE_HOME + 14.0;
        }
    }
    i
}

/// How the card is laid out on one screen.
#[derive(Clone, Debug, PartialEq)]
pub struct CardLayout {
    /// Everything (fonts, padding, gaps) at this times the 1920×1080 design.
    pub scale: f32,
    /// Buttons stacked (portrait / narrow) instead of side by side.
    pub column: bool,
    pub insets: Insets,
    /// The safe area inside the insets.
    pub avail: Vec2,
    /// Each shown button's size, in order.
    pub buttons: Vec<Vec2>,
    /// The whole block (title to status line).
    pub content: Vec2,
}

impl CardLayout {
    /// Where each button sits (top-left corner and size), with the block
    /// centred in the safe area as the UI lays it out.
    pub fn button_rects(&self) -> Vec<Rect> {
        let s = self.scale;
        let top = self.insets.top + (self.avail.y - self.content.y) * 0.5;
        let cx = self.insets.left + self.avail.x * 0.5;
        let row_top = top + self.content.y - self.status_h() - GAP * s - self.buttons_size().y;
        let mut out = Vec::new();
        if self.column {
            let mut y = row_top;
            for b in &self.buttons {
                out.push(Rect::from_corners(Vec2::new(cx - b.x * 0.5, y), Vec2::new(cx + b.x * 0.5, y + b.y)));
                y += b.y + COLUMN_GAP * s;
            }
        } else {
            let mut x = cx - self.buttons_size().x * 0.5;
            for b in &self.buttons {
                out.push(Rect::from_corners(Vec2::new(x, row_top), Vec2::new(x + b.x, row_top + b.y)));
                x += b.x + ROW_GAP * s;
            }
        }
        out
    }

    fn status_h(&self) -> f32 {
        crate::softtext::layout(STATUS_SAMPLE, STATUS_FONT * self.scale, 500, Some(self.avail.x / TEXT_SLACK)).size.y
    }

    fn buttons_size(&self) -> Vec2 {
        buttons_size(&self.buttons, self.column, self.scale)
    }
}

fn buttons_size(b: &[Vec2], column: bool, s: f32) -> Vec2 {
    let n = b.len().max(1) as f32;
    if column {
        Vec2::new(b.iter().map(|v| v.x).fold(0.0, f32::max), b.iter().map(|v| v.y).sum::<f32>() + COLUMN_GAP * s * (n - 1.0))
    } else {
        Vec2::new(b.iter().map(|v| v.x).sum::<f32>() + ROW_GAP * s * (n - 1.0), b.iter().map(|v| v.y).fold(0.0, f32::max))
    }
}

/// Lay out at scale `s`: the block's size and the buttons' sizes. Column
/// buttons all take the widest one's width.
fn measure(title: &str, body: &str, labels: &[&str], s: f32, avail_w: f32, column: bool) -> (Vec2, Vec<Vec2>) {
    use crate::softtext::layout;
    let wrap = avail_w / TEXT_SLACK;
    let t = layout(title, TITLE_FONT * s, 700, Some(wrap)).size * Vec2::new(TEXT_SLACK, 1.0);
    let b = layout(body, BODY_FONT * s, 500, Some((BODY_WRAP * s).min(wrap))).size * Vec2::new(TEXT_SLACK, 1.0);
    let st = layout(STATUS_SAMPLE, STATUS_FONT * s, 500, Some(wrap)).size;
    let edge = 2.0 * (BUTTON_PAD + Vec2::splat(BUTTON_BORDER)) * s;
    let mut buttons: Vec<Vec2> = labels.iter().map(|l| layout(l, BUTTON_FONT * s, 700, None).size * Vec2::new(TEXT_SLACK, 1.0) + edge).collect();
    if column {
        let w = buttons.iter().map(|v| v.x).fold(0.0, f32::max);
        for v in buttons.iter_mut() {
            v.x = w;
        }
    }
    let row = buttons_size(&buttons, column, s);
    let h = t.y + b.y + SPACER * s + row.y + st.y + 4.0 * GAP * s;
    let w = t.x.max(b.x).max(row.x).max(st.x);
    (Vec2::new(w, h), buttons)
}

/// Fit the card to a `view` (logical px): the largest scale (up to the
/// 1920×1080 design) at which everything fits the safe area, side by side
/// where there's room (never in portrait), else stacked.
pub fn card_layout(view: Vec2, phone: bool, title: &str, body: &str, labels: &[&str]) -> CardLayout {
    let insets = insets(view, phone);
    let avail = Vec2::new(view.x - insets.left - insets.right, view.y - insets.top - insets.bottom).max(Vec2::ONE);
    let portrait = view.y > view.x;
    let fits = |c: Vec2| c.x <= avail.x + 0.5 && c.y <= avail.y + 0.5;
    let mut s = 1.0f32;
    loop {
        let row = (!portrait).then(|| measure(title, body, labels, s, avail.x, false)).filter(|(c, _)| fits(*c));
        let pick = row.map(|r| (false, r)).or_else(|| {
            let col = measure(title, body, labels, s, avail.x, true);
            fits(col.0).then_some((true, col))
        });
        if let Some((column, (content, buttons))) = pick {
            return CardLayout { scale: s, column, insets, avail, buttons, content };
        }
        if s <= MIN_SCALE {
            let (content, buttons) = measure(title, body, labels, s, avail.x, true);
            return CardLayout { scale: s, column: true, insets, avail, buttons, content };
        }
        s = (s - 0.02).max(MIN_SCALE);
    }
}

/// Size the card to the screen (on its first frame, and whenever the
/// screen, the words or the buttons change). Hidden until it's been sized.
#[allow(clippy::type_complexity)]
fn fit_card(
    card: Option<Res<DemoEnd>>,
    own: Res<Ownership>,
    mut last: Local<Option<(Vec2, bool, Option<String>)>>,
    mut root: Query<(&ComputedNode, &mut Visibility), With<DemoRoot>>,
    mut nodes: ParamSet<(
        Query<&mut Node, With<DemoRoot>>,
        Query<&mut Node, With<DemoTitle>>,
        Query<&mut Node, With<DemoBody>>,
        Query<&mut Node, With<DemoStatus>>,
        Query<&mut Node, With<DemoSpacer>>,
        Query<&mut Node, With<DemoRow>>,
        Query<(&mut Node, &DemoButton)>,
    )>,
    mut fonts: Query<(&mut TextFont, Option<&DemoTitle>, Option<&DemoBody>, Option<&DemoStatus>, Option<&DemoButtonLabel>)>,
) {
    let Some(card) = card else {
        *last = None;
        return;
    };
    let Ok((computed, mut vis)) = root.single_mut() else { return };
    let view = computed.size() * computed.inverse_scale_factor();
    if view.x < 1.0 || view.y < 1.0 {
        return;
    }
    let owned = own.full();
    let key = (view, owned, own.price.clone());
    if last.as_ref() == Some(&key) {
        return;
    }
    *last = Some(key);
    let store = storefront();
    let phone = crate::platform::IS_MOBILE || store == Storefront::AppStore;
    let (title, body, labels) = lines(card.chapter, owned, own.price.as_deref());
    let order = shown(owned, store);
    let shown_labels: Vec<&str> = order.iter().map(|i| labels[*i].as_str()).collect();
    let l = card_layout(view, phone, &title, &body, &shown_labels);
    let s = l.scale;

    *vis = Visibility::Inherited;
    for mut n in nodes.p0().iter_mut() {
        n.padding = UiRect { left: px(l.insets.left), right: px(l.insets.right), top: px(l.insets.top), bottom: px(l.insets.bottom) };
        n.row_gap = px(GAP * s);
    }
    for mut n in nodes.p1().iter_mut() {
        n.max_width = px(l.avail.x);
    }
    for mut n in nodes.p2().iter_mut() {
        n.max_width = px((BODY_WRAP * s).min(l.avail.x));
    }
    for mut n in nodes.p3().iter_mut() {
        n.max_width = px(l.avail.x);
    }
    for mut n in nodes.p4().iter_mut() {
        n.height = px(SPACER * s);
    }
    for mut n in nodes.p5().iter_mut() {
        n.flex_direction = if l.column { FlexDirection::Column } else { FlexDirection::Row };
        n.flex_wrap = FlexWrap::NoWrap;
        n.align_items = if l.column { AlignItems::Stretch } else { AlignItems::Center };
        n.column_gap = px(ROW_GAP * s);
        n.row_gap = px(COLUMN_GAP * s);
    }
    let width = l.buttons.first().map_or(0.0, |b| b.x);
    for (mut n, _) in nodes.p6().iter_mut() {
        n.padding = UiRect::axes(px(BUTTON_PAD.x * s), px(BUTTON_PAD.y * s));
        n.border = UiRect::all(px(BUTTON_BORDER * s));
        n.border_radius = BorderRadius::all(px(BUTTON_RADIUS * s));
        n.justify_content = JustifyContent::Center;
        n.width = if l.column { px(width) } else { Val::Auto };
    }
    for (mut f, t, b, st, bl) in fonts.iter_mut() {
        let size = if t.is_some() {
            TITLE_FONT
        } else if b.is_some() {
            BODY_FONT
        } else if st.is_some() {
            STATUS_FONT
        } else if bl.is_some() {
            BUTTON_FONT
        } else {
            continue;
        };
        f.font_size = (size * s).into();
    }
}

#[allow(clippy::too_many_arguments)]
fn demo_end(
    mut commands: Commands,
    card: Option<ResMut<DemoEnd>>,
    own: Res<Ownership>,
    time: Res<Time>,
    assets: Res<GameAssets>,
    keys: Res<ButtonInput<KeyCode>>,
    inputs: Res<Inputs>,
    mut ui: ParamSet<(
        Query<&mut Text, With<DemoTitle>>,
        Query<&mut Text, With<DemoBody>>,
        Query<&mut Text, With<DemoStatus>>,
        Query<(&mut Text, &DemoButtonLabel)>,
    )>,
    mut buttons: Query<(&Interaction, &DemoButton, &mut BackgroundColor, &mut BorderColor, &mut Node)>,
    mut bg: Query<&mut BackgroundColor, (With<EndCardUi>, Without<DemoButton>)>,
    cards: Query<Entity, With<EndCardUi>>,
    (mut prev, mut buys, mut wishes, mut flow, mut next, mut cues): (
        Local<(bool, f32)>,
        MessageWriter<BuyRequest>,
        MessageWriter<WishlistRequest>,
        ResMut<StoryFlow>,
        ResMut<NextState<AppState>>,
        ResMut<Cues>,
    ),
) {
    let Some(mut card) = card else { return };
    card.age += time.delta_secs();
    let owned = own.full();
    if !card.spawned {
        card.spawned = true;
        let font = |size: f32, bold: bool| TextFont {
            font: if bold { assets.font.clone() } else { assets.font_medium.clone() }.into(),
            font_size: size.into(),
            weight: if bold { FontWeight::BOLD } else { FontWeight::MEDIUM },
            ..default()
        };
        let shadow = TextShadow { offset: Vec2::new(4.0, 5.0), color: Color::srgba(0.0, 0.0, 0.0, 0.6) };
        let (title, body, labels) = lines(card.chapter, owned, own.price.as_deref());
        commands
            .spawn((
                Node {
                    position_type: PositionType::Absolute,
                    width: percent(100.0),
                    height: percent(100.0),
                    flex_direction: FlexDirection::Column,
                    justify_content: JustifyContent::Center,
                    align_items: AlignItems::Center,
                    row_gap: px(GAP),
                    ..default()
                },
                BackgroundColor(Color::srgba(0.05, 0.02, 0.08, if card.opaque { 1.0 } else { 0.0 })),
                GlobalZIndex(80),
                // Shown once `fit_card` has sized it to the screen.
                Visibility::Hidden,
                EndCardUi,
                DemoRoot,
            ))
            .with_children(|p| {
                p.spawn((Text::new(title), font(TITLE_FONT, true), TextColor(Color::WHITE), TextLayout::justify(Justify::Center), Node::default(), shadow, DemoTitle));
                p.spawn((
                    Text::new(body),
                    font(BODY_FONT, false),
                    TextColor(Color::srgb(1.0, 0.85, 0.5)),
                    TextLayout::justify(Justify::Center),
                    Node { max_width: px(BODY_WRAP), ..default() },
                    shadow,
                    DemoBody,
                ));
                p.spawn((Node { height: px(SPACER), ..default() }, DemoSpacer));
                // Side by side, or stacked on portrait / narrow screens
                // (`fit_card` decides).
                p.spawn((
                    Node {
                        flex_direction: FlexDirection::Row,
                        justify_content: JustifyContent::Center,
                        column_gap: px(ROW_GAP),
                        row_gap: px(COLUMN_GAP),
                        ..default()
                    },
                    DemoRow,
                ))
                .with_children(|row| {
                    for (i, text) in labels.into_iter().enumerate() {
                        row.spawn((
                            Button,
                            Node {
                                padding: UiRect::axes(px(BUTTON_PAD.x), px(BUTTON_PAD.y)),
                                border: UiRect::all(px(BUTTON_BORDER)),
                                border_radius: BorderRadius::all(px(BUTTON_RADIUS)),
                                justify_content: JustifyContent::Center,
                                ..default()
                            },
                            BackgroundColor(Color::NONE),
                            BorderColor::all(Color::NONE),
                            DemoButton(i),
                        ))
                        .with_children(|b| {
                            b.spawn((Text::new(text), font(BUTTON_FONT, true), TextColor(Color::WHITE), DemoButtonLabel(i)));
                        });
                    }
                });
                p.spawn((
                    Text::new(""),
                    font(STATUS_FONT, false),
                    TextColor(Color::WHITE),
                    TextLayout::justify(Justify::Center),
                    Node::default(),
                    shadow,
                    DemoStatus,
                ));
            });
        return;
    }
    if !card.opaque {
        for mut b in bg.iter_mut() {
            b.0.set_alpha((card.age / 1.2).min(1.0) * 0.7);
        }
    }

    // Bought while the card is up: offer the next chapter. (The App Store's
    // price arriving relabels the buy button too.)
    if card.owned != Some(owned) || (own.is_changed() && !owned) {
        card.owned = Some(owned);
        let (title, body, labels) = lines(card.chapter, owned, own.price.as_deref());
        for mut t in ui.p0().iter_mut() {
            t.0 = title.clone();
        }
        for mut t in ui.p1().iter_mut() {
            t.0 = body.clone();
        }
        for (mut t, l) in ui.p3().iter_mut() {
            t.0 = labels[l.0].clone();
        }
    }
    let status = own.buy.line(own.owned);
    for mut t in ui.p2().iter_mut() {
        if t.0 != status {
            t.0 = status.clone();
        }
    }

    // Focus: arrows / stick / phone; activate: Enter, Space, pad A, phone
    // button, or a click/tap on a button.
    let order = shown(owned, storefront());
    if !order.contains(&card.focus) {
        card.focus = PRIMARY;
    }
    let at = order.iter().position(|b| *b == card.focus).unwrap_or(0);
    let stick = inputs.slots.iter().fold(0.0, |a, i| a + i.stick.x);
    prev.1 = (prev.1 - time.delta_secs()).max(0.0);
    let back = keys.any_just_pressed([KeyCode::ArrowLeft, KeyCode::ArrowUp]) || (keys.just_pressed(KeyCode::Tab) && keys.pressed(KeyCode::ShiftLeft));
    let fwd = keys.any_just_pressed([KeyCode::ArrowRight, KeyCode::ArrowDown]) || (keys.just_pressed(KeyCode::Tab) && !keys.pressed(KeyCode::ShiftLeft));
    let step = if back || (stick < -0.5 && prev.1 <= 0.0) {
        order.len() - 1
    } else if fwd || (stick > 0.5 && prev.1 <= 0.0) {
        1
    } else {
        0
    };
    if step != 0 {
        card.focus = order[(at + step) % order.len()];
        prev.1 = 0.25;
    }
    let mut chosen = None;
    for (i, b, mut fill, mut rim, mut node) in buttons.iter_mut() {
        let display = if order.contains(&b.0) { Display::Flex } else { Display::None };
        if node.display != display {
            node.display = display;
        }
        if matches!(i, Interaction::Hovered | Interaction::Pressed) {
            card.focus = b.0;
        }
        if *i == Interaction::Pressed && card.age >= ARM {
            chosen = Some(b.0);
        }
        let c = match b.0 {
            PRIMARY => Color::srgb(1.0, 0.78, 0.37),
            // Steam's blue, like the title screen's tile.
            WISHLIST => Color::srgb(0.40, 0.75, 0.96),
            _ => Color::srgb(0.82, 0.77, 0.91),
        };
        let focused = card.focus == b.0;
        fill.0 = if focused { c.lighter(0.08) } else { c.darker(0.12) };
        *rim = BorderColor::all(if focused { Color::WHITE } else { c.darker(0.4) });
    }
    let button = inputs.slots.iter().any(|i| i.button);
    let tapped = button && !prev.0;
    prev.0 = button;
    if card.age >= ARM && chosen.is_none() && (keys.any_just_pressed([KeyCode::Enter, KeyCode::Space]) || tapped) {
        chosen = Some(card.focus);
    }
    if card.age >= ARM && keys.just_pressed(KeyCode::Escape) {
        chosen = Some(BACK);
    }
    match chosen {
        Some(PRIMARY) if owned => {
            // Carry on into the chapter, as if the demo had never stopped.
            let ch = card.chapter;
            commands.remove_resource::<DemoEnd>();
            for e in cards.iter() {
                commands.entity(e).despawn();
            }
            *cues = Cues::default();
            flow.chapter = ch;
            flow.phase = Phase::Intro;
            commands.insert_resource(PendingStart);
        }
        Some(PRIMARY) => {
            buys.write(BuyRequest);
        }
        // (Never shown on the App Store build; `ownership` refuses it there too.)
        Some(WISHLIST) if storefront().wishlist() => {
            wishes.write(WishlistRequest);
        }
        Some(WISHLIST) => {}
        Some(_) => next.set(AppState::Title),
        None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_words_have_glyphs() {
        for owned in [false, true] {
            let (t, b, l) = lines(3, owned, Some("$4.99"));
            for s in [t, b].into_iter().chain(l) {
                assert!(crate::softtext::missing_glyphs(&s).is_empty(), "{s:?}");
            }
        }
        // The default demo stops before chapter 3.
        assert!(lines(3, false, None).1.contains("8 more chapters"));
        assert_eq!(lines(3, true, None).2[PRIMARY], "Play Chapter 3");
        assert_eq!(lines(3, false, None).2[PRIMARY], "Get the Full Game");
        assert_eq!(lines(3, false, Some("$4.99")).2[PRIMARY], "Get the Full Game  ·  $4.99");
        assert_eq!(lines(3, false, None).2[WISHLIST], "Wishlist Now");
    }

    #[test]
    fn wishlist_is_offered_in_the_demo_only() {
        assert_eq!(shown(false, Storefront::Open), &[PRIMARY, WISHLIST, BACK]);
        assert_eq!(shown(true, Storefront::Open), &[PRIMARY, BACK]);
    }

    /// Screens the card has to fit (logical px), and whether they're phones.
    const SCREENS: [(&str, Vec2, bool); 9] = [
        ("iPhone portrait", Vec2::new(402.0, 874.0), true),
        ("iPhone landscape", Vec2::new(874.0, 402.0), true),
        ("iPhone SE landscape", Vec2::new(667.0, 375.0), true),
        ("iPad landscape window", Vec2::new(1032.0, 774.0), true),
        ("iPad Pro landscape", Vec2::new(1366.0, 1024.0), true),
        ("iPad portrait", Vec2::new(820.0, 1180.0), true),
        ("desktop 16:9", Vec2::new(1920.0, 1080.0), false),
        ("desktop 720p", Vec2::new(1280.0, 720.0), false),
        ("desktop 4:3", Vec2::new(1440.0, 1080.0), false),
    ];

    /// Every button stays inside the safe area on every screen, for every
    /// button set (desktop / iOS, demo / owned, with a price or without),
    /// and nothing overlaps.
    #[test]
    fn the_card_fits_every_screen() {
        for (name, view, phone) in SCREENS {
            for store in [Storefront::Open, Storefront::AppStore] {
                for owned in [false, true] {
                    for price in [None, Some("$4.99")] {
                        let (title, body, labels) = lines(3, owned, price);
                        let shown: Vec<&str> = shown(owned, store).iter().map(|i| labels[*i].as_str()).collect();
                        let l = card_layout(view, phone, &title, &body, &shown);
                        let what = format!("{name} {store:?} owned={owned} {price:?}: {l:?}");
                        assert!(l.content.x <= l.avail.x + 0.5 && l.content.y <= l.avail.y + 0.5, "card overflows: {what}");
                        assert!(l.scale > MIN_SCALE, "had to squash to the minimum: {what}");
                        let safe = Rect::from_corners(Vec2::new(l.insets.left, l.insets.top), view - Vec2::new(l.insets.right, l.insets.bottom));
                        let rects = l.button_rects();
                        assert_eq!(rects.len(), shown.len());
                        for (i, r) in rects.iter().enumerate() {
                            assert!(safe.contains(r.min) && safe.contains(r.max), "button {i} off the safe area: {r:?} in {safe:?}: {what}");
                            for r2 in &rects[i + 1..] {
                                assert!(r.intersect(*r2).is_empty(), "buttons overlap: {what}");
                            }
                        }
                        if view.y > view.x {
                            assert!(l.column, "portrait stacks the buttons: {what}");
                        }
                    }
                }
            }
        }
        // Desktop 16:9 is the card as designed: full size, side by side.
        let (t, b, labels) = lines(3, false, None);
        let all: Vec<&str> = labels.iter().map(String::as_str).collect();
        let l = card_layout(Vec2::new(1920.0, 1080.0), false, &t, &b, &all);
        assert_eq!((l.scale, l.column), (1.0, false));
    }

    #[test]
    fn phones_keep_clear_of_the_notch_and_home_bar() {
        let land = insets(Vec2::new(874.0, 402.0), true);
        assert!(land.left >= crate::platform::PHONE_NOTCH && land.right >= crate::platform::PHONE_NOTCH);
        assert!(land.bottom >= crate::platform::PHONE_HOME);
        let port = insets(Vec2::new(402.0, 874.0), true);
        assert!(port.top >= crate::platform::PHONE_NOTCH && port.bottom >= crate::platform::PHONE_HOME);
        let desk = insets(Vec2::new(1920.0, 1080.0), false);
        assert!(desk.left < crate::platform::PHONE_NOTCH);
    }

    /// iOS: buy (StoreKit) and Back to Title; never the Steam wishlist.
    #[test]
    fn app_store_card_buys_and_never_wishlists() {
        for owned in [false, true] {
            assert_eq!(shown(owned, Storefront::AppStore), &[PRIMARY, BACK]);
        }
    }
}
