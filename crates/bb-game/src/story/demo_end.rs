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
    app.add_systems(Update, demo_end.run_if(in_state(AppState::Story).and_then(resource_exists::<StoryFlow>)));
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
                    row_gap: px(14.0),
                    padding: UiRect::horizontal(px(80.0)),
                    ..default()
                },
                BackgroundColor(Color::srgba(0.05, 0.02, 0.08, if card.opaque { 1.0 } else { 0.0 })),
                GlobalZIndex(80),
                EndCardUi,
            ))
            .with_children(|p| {
                p.spawn((Text::new(title), font(96.0, true), TextColor(Color::WHITE), shadow, DemoTitle));
                p.spawn((
                    Text::new(body),
                    font(32.0, false),
                    TextColor(Color::srgb(1.0, 0.85, 0.5)),
                    TextLayout::justify(Justify::Center),
                    Node { max_width: px(900.0), ..default() },
                    shadow,
                    DemoBody,
                ));
                p.spawn((Node { height: px(26.0), ..default() },));
                // Wraps on narrow (portrait) screens instead of running off.
                p.spawn((
                    Node {
                        flex_direction: FlexDirection::Row,
                        flex_wrap: FlexWrap::Wrap,
                        justify_content: JustifyContent::Center,
                        column_gap: px(28.0),
                        row_gap: px(18.0),
                        ..default()
                    },
                ))
                .with_children(|row| {
                    for (i, text) in labels.into_iter().enumerate() {
                        row.spawn((
                            Button,
                            Node {
                                padding: UiRect::axes(px(34.0), px(16.0)),
                                border: UiRect::all(px(5.0)),
                                border_radius: BorderRadius::all(px(30.0)),
                                ..default()
                            },
                            BackgroundColor(Color::NONE),
                            BorderColor::all(Color::NONE),
                            DemoButton(i),
                        ))
                        .with_children(|b| {
                            b.spawn((Text::new(text), font(34.0, true), TextColor(Color::WHITE), DemoButtonLabel(i)));
                        });
                    }
                });
                p.spawn((Text::new(""), font(26.0, false), TextColor(Color::WHITE), shadow, DemoStatus));
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

    /// iOS: buy (StoreKit) and Back to Title; never the Steam wishlist.
    #[test]
    fn app_store_card_buys_and_never_wishlists() {
        for owned in [false, true] {
            assert_eq!(shown(owned, Storefront::AppStore), &[PRIMARY, BACK]);
        }
    }
}
