//! Achievements: tracked locally on every platform (save store), mirrored
//! to Steam when built with `--features steam` (desktop only; app 4485010).

use bb_sim::{Action, SimEvent, Who};
use bevy::prelude::*;

use crate::flow::AppState;
use crate::sim::{Game, SimMsg};
use crate::story::{StoryFlow, StoryProgress};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ach {
    FirstPop,
    FirstSwing,
    Chapter(u8),
    AllDrops(u8),
    FreedTheHuddle,
    PartyWinner,
    Phew,
    TrueSoftness,
}

impl Ach {
    /// Steam API name (must match the Steamworks partner config).
    pub fn api_name(self) -> String {
        match self {
            Ach::FirstPop => "FIRST_POP".into(),
            Ach::FirstSwing => "FIRST_SWING".into(),
            Ach::Chapter(n) => format!("CHAPTER_{n:02}"),
            Ach::AllDrops(n) => format!("ALL_DROPS_{n:02}"),
            Ach::FreedTheHuddle => "FREED_THE_HUDDLE".into(),
            Ach::PartyWinner => "PARTY_WINNER".into(),
            Ach::Phew => "PHEW".into(),
            Ach::TrueSoftness => "TRUE_SOFTNESS".into(),
        }
    }

    pub fn title(self) -> String {
        match self {
            Ach::FirstPop => "Pops Aren't Forever".into(),
            Ach::FirstSwing => "Friends Are Ropes".into(),
            Ach::Chapter(n) => format!("Chapter {n} Complete"),
            Ach::AllDrops(n) => format!("Every Glow Drop · Ch {n}"),
            Ach::FreedTheHuddle => "Group Squish".into(),
            Ach::PartyWinner => "Party Blob".into(),
            Ach::Phew => "Phew!".into(),
            Ach::TrueSoftness => "True Softness".into(),
        }
    }
}

#[derive(Message, Clone, Copy, Debug)]
pub struct Unlocked(pub Ach);

#[derive(Resource, Default)]
pub struct Achievements {
    #[cfg(feature = "steam")]
    client: Option<steamworks::Client>,
}

impl Achievements {
    pub fn has(&self, a: Ach) -> bool {
        crate::save::get(&format!("ach.{}", a.api_name())).is_some()
    }

    /// Steam builds running under Steam: show `app`'s store page in the
    /// overlay. False when there's no Steam client or its overlay is off
    /// (the caller falls back to the browser).
    pub fn open_store_overlay(&self, app: u32) -> bool {
        #[cfg(feature = "steam")]
        if let Some(c) = self.client.as_ref().filter(|c| c.utils().is_overlay_enabled()) {
            c.friends().activate_game_overlay_to_store(steamworks::AppId(app), steamworks::OverlayToStoreFlag::None);
            return true;
        }
        let _ = app;
        false
    }

    /// Unlock once; returns true the first time.
    pub fn unlock(&mut self, a: Ach) -> bool {
        if self.has(a) {
            return false;
        }
        crate::save::set(&format!("ach.{}", a.api_name()), "1");
        #[cfg(feature = "steam")]
        if let Some(c) = &self.client {
            let stats = c.user_stats();
            let _ = stats.achievement(&a.api_name()).set();
            let _ = stats.store_stats();
        }
        true
    }
}

pub struct AchievementsPlugin;

impl Plugin for AchievementsPlugin {
    fn build(&self, app: &mut App) {
        app.add_message::<Unlocked>().add_systems(Startup, init).add_systems(Update, (watch.run_if(resource_exists::<Game>), toast));
        #[cfg(feature = "steam")]
        app.add_systems(Update, pump_steam);
    }
}

fn init(mut commands: Commands) {
    #[allow(unused_mut)]
    let mut a = Achievements::default();
    #[cfg(feature = "steam")]
    {
        // Non-fatal: the game runs fine outside Steam.
        a.client = steamworks::Client::init_app(crate::ownership::STEAM_APP).ok();
    }
    commands.insert_resource(a);
}

#[cfg(feature = "steam")]
fn pump_steam(a: Res<Achievements>) {
    if let Some(c) = &a.client {
        c.run_callbacks();
    }
}

fn watch(
    mut events: MessageReader<SimMsg>,
    game: Res<Game>,
    state: Res<State<AppState>>,
    flow: Option<Res<StoryFlow>>,
    progress: Res<StoryProgress>,
    mut ach: ResMut<Achievements>,
    mut out: MessageWriter<Unlocked>,
) {
    let mut unlock = |a: Ach, ach: &mut Achievements| {
        if ach.unlock(a) {
            out.write(Unlocked(a));
        }
    };
    let story = *state.get() == AppState::Story;
    for SimMsg(e) in events.read() {
        match e {
            SimEvent::Popped { who: Who::Player(_), .. } => unlock(Ach::FirstPop, &mut ach),
            SimEvent::Action { who: Who::Player(_), action: Action::Grab } => unlock(Ach::FirstSwing, &mut ach),
            SimEvent::Phew { body } if matches!(game.sim.tag(*body), Some(bb_sim::BodyTag::Player(_))) => unlock(Ach::Phew, &mut ach),
            SimEvent::Goal { .. } if story => {
                if let Some(f) = &flow {
                    unlock(Ach::Chapter(f.chapter), &mut ach);
                    if game.sim.collected.iter().all(|c| *c) && !game.sim.collected.is_empty() {
                        unlock(Ach::AllDrops(f.chapter), &mut ach);
                    }
                    if f.chapter == 9 {
                        unlock(Ach::FreedTheHuddle, &mut ach);
                    }
                    if f.chapter == 10 {
                        unlock(Ach::TrueSoftness, &mut ach);
                    }
                }
            }
            SimEvent::Goal { .. } if *state.get() == AppState::Party => unlock(Ach::PartyWinner, &mut ach),
            _ => {}
        }
    }
    let _ = progress;
}

#[derive(Component)]
struct Toast(f32);

fn toast(mut commands: Commands, mut unlocked: MessageReader<Unlocked>, assets: Res<crate::assets::GameAssets>, time: Res<Time>, mut q: Query<(Entity, &mut Toast, &mut Node)>) {
    for Unlocked(a) in unlocked.read() {
        commands
            .spawn((
                Node {
                    position_type: PositionType::Absolute,
                    right: px(24.0),
                    bottom: px(-90.0),
                    padding: UiRect::axes(px(22.0), px(12.0)),
                    border_radius: BorderRadius::all(px(26.0)),
                    border: UiRect::all(px(4.0)),
                    align_items: AlignItems::Center,
                    column_gap: px(12.0),
                    ..default()
                },
                BackgroundColor(Color::srgb(1.0, 0.97, 0.88)),
                BorderColor::all(Color::srgb(0.17, 0.13, 0.21)),
                GlobalZIndex(80),
                Toast(4.0),
            ))
            .with_children(|p| {
                // A drawn gold medal (the font has no star glyph).
                p.spawn((
                    Node { width: px(24.0), height: px(24.0), border_radius: BorderRadius::all(px(12.0)), border: UiRect::all(px(3.0)), ..default() },
                    BackgroundColor(Color::srgb(1.0, 0.82, 0.25)),
                    BorderColor::all(Color::srgb(0.85, 0.55, 0.1)),
                ));
                p.spawn((
                    Text::new(a.title()),
                    TextFont { font: assets.font.clone().into(), font_size: 26.0.into(), weight: FontWeight::BOLD, ..default() },
                    TextColor(Color::srgb(0.17, 0.13, 0.21)),
                ));
            });
    }
    let dt = time.delta_secs();
    for (e, mut t, mut n) in q.iter_mut() {
        t.0 -= dt;
        let shown = if t.0 > 3.6 { (4.0 - t.0) / 0.4 } else if t.0 < 0.4 { t.0 / 0.4 } else { 1.0 };
        n.bottom = px(-90.0 + 120.0 * shown.clamp(0.0, 1.0));
        if t.0 <= 0.0 {
            commands.entity(e).despawn();
        }
    }
}
