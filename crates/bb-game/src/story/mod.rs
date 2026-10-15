//! Story mode: chapter flow, cutscenes, speech bubbles, mid-level lines.

pub mod bubble;
pub mod cutscene;
pub mod lulu;
pub mod scripts;

use bb_level::Level;
use bb_sim::SimEvent;
use bevy::prelude::*;

use bevy::input::touch::Touches;

use crate::assets::GameAssets;
use crate::camera::CameraDirector;
use crate::flow::AppState;
use crate::sim::{Game, Inputs, LoadLevel, SimMsg, UnloadLevel};
use bubble::{SayRequest, Speaker};
use cutscene::{Cues, Runner};

/// Gibberish voice request; the audio plugin turns it into blubs.
#[derive(Message, Clone, Debug)]
pub struct Blub {
    pub voice: Voice,
    pub syllables: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Voice {
    Pip,
    Granny,
    Glimmer,
    Reg,
    Huddle,
    Lulu,
}

/// Floating onomatopoeia requested by scripts.
#[derive(Message, Clone, Debug)]
pub struct WordRequest {
    pub text: String,
    pub at: Vec2,
}

pub const CHAPTERS: u8 = 10;

/// Saved story progress.
#[derive(Resource, Clone, Debug)]
pub struct StoryProgress {
    /// Highest chapter unlocked (1-based).
    pub unlocked: u8,
    /// Chapter to start when entering Story.
    pub current: u8,
    pub pip_color: u32,
}

impl Default for StoryProgress {
    fn default() -> Self {
        let num = |k: &str| crate::save::get(k).and_then(|v| v.parse::<u8>().ok());
        StoryProgress {
            unlocked: num("story.unlocked").unwrap_or(1).clamp(1, CHAPTERS),
            current: num("story.current").unwrap_or(1).clamp(1, CHAPTERS),
            pip_color: crate::save::get("pip.color").and_then(|c| bb_sim::parse_color(&c)).unwrap_or(0xff5d73),
        }
    }
}

impl StoryProgress {
    pub fn persist(&self) {
        crate::save::set("story.unlocked", &self.unlocked.to_string());
        crate::save::set("story.current", &self.current.to_string());
        crate::save::set("pip.color", &format!("#{:06x}", self.pip_color));
    }
}

/// Save progress whenever it changes.
fn persist_progress(progress: Res<StoryProgress>) {
    if progress.is_changed() && !progress.is_added() {
        progress.persist();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Intro,
    Level,
    Outro,
    /// The story is over: the end card, waiting for a press to go home.
    End,
}

#[derive(Resource)]
pub struct StoryFlow {
    pub chapter: u8,
    pub phase: Phase,
    /// Seconds to wait after reaching the goal before the outro.
    pub goal_timer: Option<f32>,
}

/// The campaign chapter (crates/bb-level/src/campaign).
pub fn chapter_level(n: u8) -> Level {
    bb_level::campaign::chapter(n)
}

pub struct StoryPlugin;

impl Plugin for StoryPlugin {
    fn build(&self, app: &mut App) {
        app.add_message::<Blub>()
            .add_message::<WordRequest>()
            .add_message::<SayRequest>()
            .init_resource::<StoryProgress>()
            .init_resource::<Cues>()
            .init_resource::<LineQueue>()
            .init_resource::<lulu::LuluHead>()
            .add_systems(PostUpdate, (lulu::sync, lulu::draw).chain())
            .add_systems(OnEnter(AppState::Story), enter)
            .add_systems(OnExit(AppState::Story), exit)
            .add_systems(
                Update,
                (
                    cutscene::run.run_if(resource_exists::<Runner>.and_then(resource_exists::<Game>)),
                    advance.run_if(resource_exists::<StoryFlow>),
                    // Capture mode: no tips or mid-level lines on screen.
                    level_lines.run_if(resource_exists::<Game>.and_then(crate::capture::off)),
                    drop_in.run_if(in_state(AppState::Playing)),
                )
                    .chain(),
            )
            .add_systems(Update, end_card.run_if(in_state(AppState::Story)))
            .add_systems(Update, (bubble::spawn_bubbles, bubble::update_bubbles, words, cues_ui).chain())
            .add_systems(PreUpdate, merge_inputs_into_pip.after(crate::input::GatherInput).run_if(in_state(AppState::Story)))
            .add_systems(Startup, setup_cues_ui)
            .add_systems(Last, persist_progress);
    }
}

fn enter(mut commands: Commands, progress: Res<StoryProgress>) {
    // Dev: `BB_CHAPTER=n` starts a specific chapter without touching saves.
    let chapter = std::env::var("BB_CHAPTER").ok().and_then(|c| c.parse::<u8>().ok()).unwrap_or(progress.current).clamp(1, CHAPTERS);
    commands.insert_resource(StoryFlow { chapter, phase: Phase::Intro, goal_timer: None });
    commands.insert_resource(PendingStart);
}

/// Defer the first load one frame so Game removal from a previous state lands.
#[derive(Resource)]
struct PendingStart;

fn exit(mut commands: Commands, cards: Query<Entity, With<EndCardUi>>, mut cues: ResMut<Cues>, mut cam: ResMut<CameraDirector>, mut unload: MessageWriter<UnloadLevel>) {
    commands.remove_resource::<StoryFlow>();
    commands.remove_resource::<Runner>();
    commands.remove_resource::<EndCard>();
    for e in cards.iter() {
        commands.entity(e).despawn();
    }
    *cues = Cues::default();
    *cam = CameraDirector::default();
    unload.write(UnloadLevel);
}

fn start_cutscene(id: &str, progress: &StoryProgress, commands: &mut Commands, load: &mut MessageWriter<LoadLevel>) -> bool {
    let Some(cs) = scripts::cutscene(id, progress.pip_color) else { return false };
    commands.insert_resource(crate::render::FaceCues::default());
    commands.insert_resource(Runner::new(&cs));
    load.write(LoadLevel { level: cs.stage, players: Vec::new() });
    true
}

/// The campaign is single-player: just Pip. (Multiplayer lives in Party.)
fn local_players(_inputs: &Inputs, progress: &StoryProgress) -> Vec<(u8, String, u32)> {
    vec![(0u8, "Pip".to_string(), progress.pip_color)]
}

/// Single-player: every local device (keyboard, touch, any gamepad) drives Pip.
fn merge_inputs_into_pip(mut inputs: ResMut<Inputs>) {
    let mut stick = inputs.slots[0].stick;
    let mut button = inputs.slots[0].button;
    for s in 1..16 {
        if inputs.active[s] {
            stick += inputs.slots[s].stick;
            button |= inputs.slots[s].button;
        }
    }
    inputs.slots[0].stick = stick.clamp_length_max(1.0);
    inputs.slots[0].button = button;
}

#[allow(clippy::too_many_arguments)]
fn advance(
    mut commands: Commands,
    mut flow: ResMut<StoryFlow>,
    mut progress: ResMut<StoryProgress>,
    runner: Option<Res<Runner>>,
    pending: Option<Res<PendingStart>>,
    inputs: Res<Inputs>,
    time: Res<Time>,
    mut events: MessageReader<SimMsg>,
    mut load: MessageWriter<LoadLevel>,
    mut cues: ResMut<Cues>,
    mut cam: ResMut<CameraDirector>,
) {
    if pending.is_some() {
        commands.remove_resource::<PendingStart>();
        // Dev: `BB_SCENE=ch10_outro` plays one cutscene (then carries on as
        // if its chapter had got there).
        if let Ok(id) = std::env::var("BB_SCENE") {
            if let Some(n) = id.get(2..4).and_then(|n| n.parse::<u8>().ok()) {
                flow.chapter = n.clamp(1, CHAPTERS);
            }
            flow.phase = if id.ends_with("_outro") { Phase::Outro } else { Phase::Intro };
            if start_cutscene(&id, &progress, &mut commands, &mut load) {
                return;
            }
        }
        let id = format!("ch{:02}_intro", flow.chapter);
        if !start_cutscene(&id, &progress, &mut commands, &mut load) {
            flow.phase = Phase::Level;
            load.write(LoadLevel { level: chapter_level(flow.chapter), players: local_players(&inputs, &progress) });
        }
        return;
    }
    let cutscene_done = runner.as_ref().is_some_and(|r| r.done);
    match flow.phase {
        Phase::Intro if cutscene_done => {
            commands.remove_resource::<Runner>();
            *cues = Cues { fade: 1.0, fade_target: 0.0, fade_speed: 2.0, ..default() };
            *cam = CameraDirector::default();
            flow.phase = Phase::Level;
            load.write(LoadLevel { level: chapter_level(flow.chapter), players: local_players(&inputs, &progress) });
        }
        Phase::Level => {
            if events.read().any(|SimMsg(e)| matches!(e, SimEvent::Goal { .. })) {
                flow.goal_timer = Some(1.8);
            }
            if let Some(t) = flow.goal_timer.as_mut() {
                *t -= time.delta_secs();
                if *t <= 0.0 {
                    flow.goal_timer = None;
                    flow.phase = Phase::Outro;
                    let id = format!("ch{:02}_outro", flow.chapter);
                    if !start_cutscene(&id, &progress, &mut commands, &mut load) {
                        flow.phase = Phase::Outro;
                        commands.insert_resource(Runner { done: true, ..Runner::new(&cutscene::Cutscene { id, stage: Level::new("x", "x"), beats: vec![] }) });
                    }
                }
            }
        }
        Phase::Outro if cutscene_done => {
            commands.remove_resource::<Runner>();
            let finished = flow.chapter;
            progress.unlocked = progress.unlocked.max((finished + 1).min(CHAPTERS));
            if finished >= CHAPTERS {
                // The last scene stays on screen under the end card, which
                // waits for a press to go back to the title.
                *cues = Cues::default();
                progress.current = 1;
                flow.phase = Phase::End;
                commands.insert_resource(EndCard::default());
                return;
            }
            *cam = CameraDirector::default();
            flow.chapter = finished + 1;
            progress.current = flow.chapter;
            flow.phase = Phase::Intro;
            *cues = Cues::default();
            let id = format!("ch{:02}_intro", flow.chapter);
            if !start_cutscene(&id, &progress, &mut commands, &mut load) {
                flow.phase = Phase::Level;
                load.write(LoadLevel { level: chapter_level(flow.chapter), players: local_players(&inputs, &progress) });
            }
        }
        _ => {}
    }
}

/// Queue of mid-level lines, spoken one after another.
#[derive(Resource, Default)]
pub struct LineQueue {
    pending: std::collections::VecDeque<(Speaker, Voice, String)>,
    wait: f32,
}

/// Mid-level story triggers → queued speech bubbles.
fn level_lines(
    mut events: MessageReader<SimMsg>,
    game: Res<Game>,
    runner: Option<Res<Runner>>,
    mut queue: ResMut<LineQueue>,
    time: Res<Time>,
    mut say: MessageWriter<SayRequest>,
    device: Res<crate::input::LastDevice>,
) {
    for SimMsg(e) in events.read() {
        let SimEvent::Story { script, slot } = e else { continue };
        // Speakers resolve to the nearest suitable NPC to the player who
        // triggered the line (levels can have several of a kind).
        let here = game.sim.player(*slot).and_then(|p| game.sim.world.body(p.ctl.body)).map(|b| b.centroid()).unwrap_or_default();
        let nearest = |ok: &dyn Fn(&bb_sim::npc::Npc) -> bool| {
            game.sim
                .npcs
                .iter()
                .filter(|n| n.dead.is_none() && ok(n))
                .min_by(|a, b| {
                    let d = |n: &bb_sim::npc::Npc| game.sim.world.body(n.ctl.body).map_or(f32::MAX, |b| b.centroid().distance(here));
                    d(a).total_cmp(&d(b))
                })
                .map(|n| (Speaker::Actor(n.id.clone()), n.role.clone()))
        };
        let role_voice = |role: bb_level::NpcRole| match role {
            bb_level::NpcRole::Granny => Voice::Granny,
            bb_level::NpcRole::Reg => Voice::Reg,
            bb_level::NpcRole::Glimmer => Voice::Glimmer,
            _ => Voice::Huddle,
        };
        for (who, text) in scripts::level_lines(script) {
            let role_npc = |role: bb_level::NpcRole| nearest(&|n| n.role == role).map(|s| s.0);
            let (speaker, voice) = match who {
                "pip" => (Speaker::Player(*slot), Voice::Pip),
                "lulu" => (Speaker::Offscreen, Voice::Lulu),
                "tip" => (Speaker::Tip, Voice::Glimmer),
                "glimmer" => (role_npc(bb_level::NpcRole::Glimmer).unwrap_or(Speaker::Offscreen), Voice::Glimmer),
                "granny" => (role_npc(bb_level::NpcRole::Granny).unwrap_or(Speaker::Offscreen), Voice::Granny),
                "reg" => (role_npc(bb_level::NpcRole::Reg).unwrap_or(Speaker::Offscreen), Voice::Reg),
                // A named NPC (e.g. "clonk", "cap1").
                id if game.sim.npcs.iter().any(|n| n.id == id && n.dead.is_none()) => {
                    let role = game.sim.npcs.iter().find(|n| n.id == id).map(|n| n.role.clone()).unwrap_or_default();
                    (Speaker::Actor(id.to_string()), role_voice(role))
                }
                _ => match nearest(&|n| n.role != bb_level::NpcRole::Glimmer) {
                    Some((s, role)) => (s, role_voice(role)),
                    None => (Speaker::Player(*slot), Voice::Huddle),
                },
            };
            queue.pending.push_back((speaker, voice, text.to_string()));
        }
    }
    if runner.is_some() {
        return;
    }
    queue.wait -= time.delta_secs();
    if queue.wait > 0.0 {
        return;
    }
    if let Some((speaker, voice, text)) = queue.pending.pop_front() {
        // Next line once this one has typed and had time to be read.
        // Pace by the words actually shown (tips fill in control names).
        let shown = crate::input::control_text(&text, *device);
        let read = bubble::linger_secs(&shown);
        queue.wait = bubble::type_secs(&shown) + read * 0.75 + 0.3;
        // The bubble plays the voice when it appears (bubble::spawn_bubbles).
        say.write(SayRequest { speaker, text, voice, linger: read });
    }
}

/// Co-op drop-in: any local/phone slot that presses something joins.
fn drop_in(mut game: Option<ResMut<Game>>, inputs: Res<Inputs>, runner: Option<Res<Runner>>) {
    let Some(game) = game.as_mut() else { return };
    if runner.is_some() || game.sim.players.is_empty() {
        return;
    }
    for s in 1..8u8 {
        if inputs.active[s as usize] && inputs.slots[s as usize].button && game.sim.player(s).is_none() {
            game.sim.add_player(s, &format!("Buddy {s}"), bb_sim::PALETTE[s as usize % 12]);
        }
    }
}

fn words(mut commands: Commands, mut reqs: MessageReader<WordRequest>, assets: Res<GameAssets>) {
    for r in reqs.read() {
        crate::fx::word(&mut commands, &assets, &r.text, r.at, Color::WHITE, 58.0);
    }
}

#[derive(Component)]
struct LetterboxBar(#[allow(dead_code)] bool);
#[derive(Component)]
struct TitleCard;
#[derive(Component)]
struct TitleText(bool);
#[derive(Component)]
struct FadeOverlay;
#[derive(Component)]
struct SkipHint;
/// Fills up while the skip button is held (drawn, not a glyph: the font has
/// no dots or symbols to spare).
#[derive(Component)]
struct SkipBar;

fn setup_cues_ui(mut commands: Commands, assets: Res<GameAssets>) {
    let ink = Color::srgb(0.08, 0.05, 0.1);
    for top in [true, false] {
        commands.spawn((
            Node {
                position_type: PositionType::Absolute,
                left: px(0.0),
                right: px(0.0),
                height: percent(0.0),
                top: if top { px(0.0) } else { auto() },
                bottom: if top { auto() } else { px(0.0) },
                ..default()
            },
            BackgroundColor(ink),
            GlobalZIndex(50),
            LetterboxBar(top),
        ));
    }
    commands
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                width: percent(100.0),
                height: percent(100.0),
                flex_direction: FlexDirection::Column,
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                ..default()
            },
            GlobalZIndex(60),
            Visibility::Hidden,
            TitleCard,
        ))
        .with_children(|p| {
            for (big, size) in [(false, 30.0), (true, 92.0)] {
                p.spawn((
                    Text::new(""),
                    TextFont { font: assets.font.clone().into(), font_size: size.into(), weight: if big { FontWeight::BOLD } else { FontWeight::MEDIUM }, ..default() },
                    TextColor(if big { Color::WHITE } else { Color::srgb(1.0, 0.85, 0.5) }),
                    TextShadow { offset: Vec2::new(4.0, 5.0), color: Color::srgba(0.0, 0.0, 0.0, 0.6) },
                    TitleText(big),
                ));
            }
        });
    commands.spawn((
        Node { position_type: PositionType::Absolute, width: percent(100.0), height: percent(100.0), ..default() },
        BackgroundColor(Color::srgba(0.05, 0.02, 0.08, 0.0)),
        GlobalZIndex(70),
        FadeOverlay,
    ));
    commands.spawn((
        Text::new(""),
        TextFont { font: assets.font.clone().into(), font_size: 22.0.into(), ..default() },
        TextColor(Color::srgba(1.0, 1.0, 1.0, 0.7)),
        Node { position_type: PositionType::Absolute, right: px(28.0 + crate::platform::SAFE_SIDE), bottom: px(18.0), ..default() },
        GlobalZIndex(65),
        SkipHint,
    ));
    commands
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                right: px(28.0 + crate::platform::SAFE_SIDE),
                bottom: px(8.0),
                width: px(120.0),
                height: px(6.0),
                border_radius: BorderRadius::all(px(3.0)),
                ..default()
            },
            BackgroundColor(Color::srgba(1.0, 1.0, 1.0, 0.0)),
            GlobalZIndex(65),
        ))
        .with_children(|p| {
            p.spawn((
                Node { width: percent(0.0), height: percent(100.0), border_radius: BorderRadius::all(px(3.0)), ..default() },
                BackgroundColor(Color::srgba(1.0, 1.0, 1.0, 0.85)),
                SkipBar,
            ));
        });
}

#[allow(clippy::type_complexity)]
fn cues_ui(
    time: Res<Time>,
    mut cues: ResMut<Cues>,
    runner: Option<Res<Runner>>,
    mut bars: Query<(&LetterboxBar, &mut Node)>,
    mut card: Query<&mut Visibility, With<TitleCard>>,
    mut texts: Query<(&TitleText, &mut Text), Without<SkipHint>>,
    mut fade: Query<&mut BackgroundColor, With<FadeOverlay>>,
    mut hint: Query<&mut Text, (With<SkipHint>, Without<TitleText>)>,
    mut bar: Query<(&mut Node, &ChildOf), (With<SkipBar>, Without<LetterboxBar>)>,
    mut track: Query<&mut BackgroundColor, (Without<FadeOverlay>, Without<SkipBar>, Without<LetterboxBar>)>,
) {
    let dt = time.delta_secs();
    let active = runner.is_some();
    let target = if active && cues.letterbox { 9.0 } else { 0.0 };
    for (_, mut n) in bars.iter_mut() {
        let cur = if let Val::Percent(p) = n.height { p } else { 0.0 };
        n.height = percent(cur + (target - cur) * (1.0 - (-dt * 6.0).exp()));
    }
    if cues.fade != cues.fade_target {
        let step = cues.fade_speed.max(0.5) * dt;
        cues.fade = if cues.fade < cues.fade_target { (cues.fade + step).min(cues.fade_target) } else { (cues.fade - step).max(cues.fade_target) };
    }
    for mut bg in fade.iter_mut() {
        bg.0.set_alpha(cues.fade);
    }
    let show = cues.title.is_some();
    for mut v in card.iter_mut() {
        *v = if show { Visibility::Visible } else { Visibility::Hidden };
    }
    if let Some((title, sub, _)) = &cues.title {
        for (TitleText(big), mut t) in texts.iter_mut() {
            t.0 = if *big { title.clone() } else { sub.clone() };
        }
    }
    let skipping = active && cues.skip_progress > 0.05;
    for mut t in hint.iter_mut() {
        let want = if !active {
            ""
        } else if skipping {
            "skipping..."
        } else {
            "hold to skip"
        };
        if t.0 != want {
            t.0 = want.into();
        }
    }
    for (mut n, parent) in bar.iter_mut() {
        n.width = percent(if skipping { cues.skip_progress * 100.0 } else { 0.0 });
        if let Ok(mut bg) = track.get_mut(parent.parent()) {
            bg.0 = Color::srgba(1.0, 1.0, 1.0, if skipping { 0.25 } else { 0.0 });
        }
    }
}

/// "The End": shown over the final scene once the last outro finishes. After
/// a moment it invites any press (key, click, tap, pad or phone button) and
/// goes back to the title.
#[derive(Resource, Default)]
pub struct EndCard {
    pub age: f32,
    spawned: bool,
}

#[derive(Component)]
struct EndCardUi;
#[derive(Component)]
struct EndPrompt;

/// Seconds before the end card accepts a press (so a held jump from the
/// last scene doesn't skip it).
pub const END_CARD_ARM: f32 = 1.6;

/// What the end card asks for, for the device in hand.
pub fn end_prompt(device: crate::input::LastDevice) -> &'static str {
    use crate::input::LastDevice::*;
    match device {
        Keyboard => "Press any key to go back to the title",
        Touch => "Tap anywhere to go back to the title",
        Gamepad => "Press A to go back to the title",
        Phone => "Press your phone's button to go back to the title",
    }
}

#[allow(clippy::too_many_arguments)]
fn end_card(
    mut commands: Commands,
    card: Option<ResMut<EndCard>>,
    time: Res<Time>,
    assets: Res<GameAssets>,
    keys: Res<ButtonInput<KeyCode>>,
    mouse: Res<ButtonInput<MouseButton>>,
    touches: Res<Touches>,
    pads: Query<&Gamepad>,
    inputs: Res<Inputs>,
    device: Res<crate::input::LastDevice>,
    mut prompt: Query<(&mut Text, &mut TextColor), With<EndPrompt>>,
    mut bg: Query<&mut BackgroundColor, With<EndCardUi>>,
    mut prev_button: Local<bool>,
    mut next: ResMut<NextState<AppState>>,
) {
    let Some(mut card) = card else { return };
    let button = inputs.slots.iter().any(|i| i.button);
    let tapped = button && !*prev_button;
    *prev_button = button;
    card.age += time.delta_secs();
    if !card.spawned {
        card.spawned = true;
        let font = |size: f32, w: FontWeight| TextFont { font: assets.font.clone().into(), font_size: size.into(), weight: w, ..default() };
        let shadow = TextShadow { offset: Vec2::new(4.0, 5.0), color: Color::srgba(0.0, 0.0, 0.0, 0.6) };
        commands
            .spawn((
                Node {
                    position_type: PositionType::Absolute,
                    width: percent(100.0),
                    height: percent(100.0),
                    flex_direction: FlexDirection::Column,
                    justify_content: JustifyContent::Center,
                    align_items: AlignItems::Center,
                    row_gap: px(10.0),
                    ..default()
                },
                BackgroundColor(Color::srgba(0.05, 0.02, 0.08, 0.0)),
                GlobalZIndex(80),
                EndCardUi,
            ))
            .with_children(|p| {
                p.spawn((Text::new("The End"), font(110.0, FontWeight::BOLD), TextColor(Color::WHITE), shadow));
                p.spawn((Text::new("...of the beginning"), font(38.0, FontWeight::MEDIUM), TextColor(Color::srgb(1.0, 0.85, 0.5)), shadow));
                p.spawn((Node { height: px(36.0), ..default() },));
                p.spawn((Text::new("Thanks for playing!"), font(30.0, FontWeight::MEDIUM), TextColor(Color::WHITE), shadow));
                p.spawn((Node { height: px(28.0), ..default() },));
                p.spawn((Text::new(""), font(26.0, FontWeight::MEDIUM), TextColor(Color::srgba(1.0, 1.0, 1.0, 0.0)), shadow, EndPrompt));
            });
        return;
    }
    for mut b in bg.iter_mut() {
        b.0.set_alpha((card.age / 1.2).min(1.0) * 0.6);
    }
    let armed = card.age >= END_CARD_ARM;
    for (mut t, mut c) in prompt.iter_mut() {
        let want = end_prompt(*device);
        if t.0 != want {
            t.0 = want.into();
        }
        // Fades in, then breathes so it reads as "waiting for you".
        let a = if armed { 0.55 + 0.4 * (card.age * 2.6).sin().abs() } else { 0.0 };
        c.0 = Color::srgba(1.0, 1.0, 1.0, a);
    }
    if !armed {
        return;
    }
    let pressed = keys.get_just_pressed().next().is_some()
        || mouse.get_just_pressed().next().is_some()
        || touches.iter_just_pressed().next().is_some()
        || pads.iter().any(|p| p.get_just_pressed().next().is_some())
        || tapped;
    if pressed {
        next.set(AppState::Title);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{LastDevice, control_text};
    use crate::softtext::missing_glyphs;
    use cutscene::Beat;

    const DEVICES: [LastDevice; 4] = [LastDevice::Keyboard, LastDevice::Touch, LastDevice::Gamepad, LastDevice::Phone];

    /// Every word the story puts on screen is drawable in the game font (no
    /// tofu boxes), with every control placeholder filled in.
    #[test]
    fn every_story_string_has_glyphs() {
        let mut bad = Vec::new();
        let mut check = |what: &str, text: &str| {
            for d in DEVICES {
                let t = control_text(text, d);
                assert!(!t.contains('{'), "unfilled placeholder in {what}: {t}");
                let m = missing_glyphs(&t);
                if !m.is_empty() {
                    bad.push(format!("{what}: {t:?} lacks {m:?}"));
                }
            }
        };
        for level in bb_level::campaign::campaign() {
            for t in &level.story {
                for (who, text) in scripts::level_lines(&t.script) {
                    check(&format!("{} {who}", t.script), text);
                }
            }
        }
        for n in 1..=CHAPTERS {
            for part in ["intro", "outro"] {
                let id = format!("ch{n:02}_{part}");
                let Some(cs) = scripts::cutscene(&id, 0xff5d73) else { continue };
                for b in &cs.beats {
                    match b {
                        Beat::Say { text, .. } | Beat::Aside { text, .. } | Beat::Word { text, .. } => check(&id, text),
                        Beat::Title { title, sub } => {
                            check(&id, title);
                            check(&id, sub);
                        }
                        _ => {}
                    }
                }
            }
        }
        for d in DEVICES {
            check("end card", end_prompt(d));
        }
        for t in ["The End", "...of the beginning", "Thanks for playing!", "hold to skip", "skipping..."] {
            check("ui", t);
        }
        assert!(bad.is_empty(), "{bad:#?}");
    }

    #[test]
    fn the_finale_has_lulu_at_the_cave_mouth() {
        let cs = scripts::cutscene("ch10_outro", 0xff5d73).unwrap();
        let decor: Vec<&str> = cs.stage.decor.iter().map(|d| d.kind.as_str()).collect();
        assert!(decor.contains(&lulu::DECOR) && decor.contains(&lulu::DAYLIGHT), "{decor:?}");
        // Nothing left from the old playroom set: no free props to fall over.
        assert!(cs.stage.props.is_empty());
        // Speech is bubbles only; the title card moved to the end card.
        assert!(!cs.beats.iter().any(|b| matches!(b, Beat::Title { .. })));
    }
}
