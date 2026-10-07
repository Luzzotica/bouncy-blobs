//! Story mode: chapter flow, cutscenes, speech bubbles, mid-level lines.

pub mod bubble;
pub mod cutscene;
pub mod scripts;

use bb_level::Level;
use bb_sim::SimEvent;
use bevy::prelude::*;

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
            .add_systems(OnEnter(AppState::Story), enter)
            .add_systems(OnExit(AppState::Story), exit)
            .add_systems(
                Update,
                (
                    cutscene::run.run_if(resource_exists::<Runner>.and_then(resource_exists::<Game>)),
                    advance.run_if(resource_exists::<StoryFlow>),
                    level_lines.run_if(resource_exists::<Game>),
                    drop_in.run_if(in_state(AppState::Story).or_else(in_state(AppState::Playing))),
                )
                    .chain(),
            )
            .add_systems(Update, (bubble::spawn_bubbles, bubble::update_bubbles, words, cues_ui).chain())
            .add_systems(Startup, setup_cues_ui)
            .add_systems(Last, persist_progress);
    }
}

fn enter(mut commands: Commands, progress: Res<StoryProgress>) {
    let chapter = progress.current.clamp(1, CHAPTERS);
    commands.insert_resource(StoryFlow { chapter, phase: Phase::Intro, goal_timer: None });
    commands.insert_resource(PendingStart);
}

/// Defer the first load one frame so Game removal from a previous state lands.
#[derive(Resource)]
struct PendingStart;

fn exit(mut commands: Commands, mut cues: ResMut<Cues>, mut cam: ResMut<CameraDirector>, mut unload: MessageWriter<UnloadLevel>) {
    commands.remove_resource::<StoryFlow>();
    commands.remove_resource::<Runner>();
    *cues = Cues::default();
    *cam = CameraDirector::default();
    unload.write(UnloadLevel);
}

fn start_cutscene(id: &str, progress: &StoryProgress, commands: &mut Commands, load: &mut MessageWriter<LoadLevel>) -> bool {
    let Some(cs) = scripts::cutscene(id, progress.pip_color) else { return false };
    commands.insert_resource(Runner::new(&cs));
    load.write(LoadLevel { level: cs.stage, players: Vec::new() });
    true
}

fn local_players(inputs: &Inputs, progress: &StoryProgress) -> Vec<(u8, String, u32)> {
    let mut v = vec![(0u8, "Pip".to_string(), progress.pip_color)];
    for s in 1..8u8 {
        if inputs.active[s as usize] {
            v.push((s, format!("Buddy {s}"), bb_sim::PALETTE[s as usize % 12]));
        }
    }
    v
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
    mut next: ResMut<NextState<AppState>>,
) {
    if pending.is_some() {
        commands.remove_resource::<PendingStart>();
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
            *cam = CameraDirector::default();
            let finished = flow.chapter;
            progress.unlocked = progress.unlocked.max((finished + 1).min(CHAPTERS));
            if finished >= CHAPTERS {
                *cues = Cues::default();
                progress.current = 1;
                next.set(AppState::Title);
                return;
            }
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
    mut blub: MessageWriter<Blub>,
) {
    for SimMsg(e) in events.read() {
        let SimEvent::Story { script, slot } = e else { continue };
        for (who, text) in scripts::level_lines(script) {
            let role_npc = |role: bb_level::NpcRole| game.sim.npcs.iter().find(|n| n.role == role && n.dead.is_none()).map(|n| Speaker::Actor(n.id.clone()));
            let (speaker, voice) = match who {
                "pip" => (Speaker::Player(*slot), Voice::Pip),
                "lulu" => (Speaker::Offscreen, Voice::Lulu),
                "tip" => (Speaker::Tip, Voice::Glimmer),
                "glimmer" => (role_npc(bb_level::NpcRole::Glimmer).unwrap_or(Speaker::Tip), Voice::Glimmer),
                "granny" => (role_npc(bb_level::NpcRole::Granny).unwrap_or(Speaker::Offscreen), Voice::Granny),
                "reg" => (role_npc(bb_level::NpcRole::Reg).unwrap_or(Speaker::Offscreen), Voice::Reg),
                _ => (
                    game.sim
                        .npcs
                        .iter()
                        .find(|n| matches!(n.role, bb_level::NpcRole::Trapped | bb_level::NpcRole::Huddle | bb_level::NpcRole::Follower) && n.dead.is_none())
                        .map(|n| Speaker::Actor(n.id.clone()))
                        .unwrap_or(Speaker::Player(*slot)),
                    Voice::Huddle,
                ),
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
        let read = 0.9 + text.len() as f32 * 0.05;
        queue.wait = read + 0.3;
        if voice != Voice::Glimmer || speaker != Speaker::Tip {
            blub.write(Blub { voice, syllables: (text.len() / 3).clamp(2, 14) as u8 });
        }
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
    for mut t in hint.iter_mut() {
        t.0 = if !active {
            String::new()
        } else if cues.skip_progress > 0.05 {
            format!("skipping {}", "●".repeat((cues.skip_progress * 5.0).ceil() as usize))
        } else {
            "hold to skip".into()
        };
    }
}
