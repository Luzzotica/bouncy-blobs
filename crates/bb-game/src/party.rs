//! Party mode: a jelly lobby where phones drop in, then Race / KOTH /
//! Chained rounds on party maps.

use bb_level::{Level, LevelBuilder, NpcRole, Shape, Theme, v};
use bb_physics::{BodyId, Vec2 as PVec2};
use bb_sim::BodyTag;
use bb_sim::modes::{KOTH_TARGET, Match, MatchPhase, ModeKind};
use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::camera::{CameraDirector, MainCamera};
use crate::flow::AppState;
use crate::menu::{BodyLabel, button_style, jelly_tile, label_with};
use crate::palette::hex;
use crate::render::StyleOverrides;
use crate::sim::{Game, Inputs, LoadLevel, UnloadLevel};
use crate::story::StoryProgress;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PartyPhase {
    Lobby,
    Match,
}

#[derive(Resource)]
pub struct Party {
    phase: PartyPhase,
    pub maps: Vec<Level>,
    pub map: usize,
    pub mode: ModeKind,
    /// Players carried between lobby and rounds: (slot, name, colour).
    pub roster: Vec<(u8, String, u32)>,
    pub current: Option<Match>,
    buttons: Vec<(BodyId, PartyButton, u32)>,
    pending_start: bool,
    built: bool,
    /// Re-open the room for joins once back in the lobby.
    reopen: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PartyButton {
    Map,
    Mode,
    Start,
    Back,
}

#[derive(Component)]
struct PartyEntity;

#[derive(Component)]
struct MatchHud;

#[derive(Component)]
enum HudText {
    Big,
    Timer,
    Scores,
}

pub struct PartyPlugin;

impl Plugin for PartyPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::Party), enter)
            .add_systems(OnExit(AppState::Party), exit)
            .add_systems(Update, (lobby_ui, lobby_input, hud).run_if(in_state(AppState::Party).and_then(resource_exists::<Game>)))
            .add_systems(FixedPostUpdate, tick_match.run_if(in_state(AppState::Party).and_then(resource_exists::<Game>)));
    }
}

/// Built-in party maps; imported 2.x maps are appended from assets when present.
pub fn builtin_maps() -> Vec<Level> {
    let mut maps = Vec::new();

    let mut b = LevelBuilder::new("party_mushroom_dash", "Mushroom Dash", Theme::Fungus);
    b.spawn(v(-1400.0, 80.0))
        .ground(&[v(-1700.0, 0.0), v(-600.0, 0.0), v(-300.0, 140.0), v(300.0, 140.0)], 400.0)
        .mushroom(v(450.0, 0.0), 90.0, 200.0)
        .ground(&[v(300.0, 0.0), v(900.0, 0.0)], 400.0)
        .bridge(v(900.0, 0.0), v(1400.0, 0.0), 26.0, 0.3)
        .ground(&[v(1400.0, 0.0), v(2000.0, 220.0), v(2600.0, 220.0)], 600.0)
        .vine(v(2200.0, 760.0), 300.0)
        .block(v(-1800.0, -400.0), v(-1700.0, 1600.0))
        .block(v(2600.0, -400.0), v(2700.0, 1600.0))
        .goal(v(2400.0, 220.0), v(2580.0, 420.0))
        .kill_y(-900.0);
    let mut l = b.build();
    l.modes = vec![bb_level::Mode::Race];
    maps.push(l);

    let mut b = LevelBuilder::new("party_wobble_hill", "Wobble Hill", Theme::Party);
    b.spawn(v(0.0, 80.0))
        .ground(&[v(-1300.0, 0.0), v(-500.0, 0.0), v(-200.0, 220.0), v(200.0, 220.0), v(500.0, 0.0), v(1300.0, 0.0)], 400.0)
        .slab(v(-800.0, 420.0), v(260.0, 40.0), 0.3)
        .slab(v(800.0, 420.0), v(260.0, 40.0), 0.3)
        .spring(v(-1100.0, 0.0), 75.0, 1500.0)
        .spring(v(1100.0, 0.0), 105.0, 1500.0)
        .block(v(-1400.0, -400.0), v(-1300.0, 1600.0))
        .block(v(1300.0, -400.0), v(1400.0, 1600.0))
        .kill_y(-900.0);
    let mut l = b.build();
    l.hills = vec![Shape::rect(v(-200.0, 220.0), v(200.0, 500.0)), Shape::rect(v(-930.0, 440.0), v(-670.0, 700.0)), Shape::rect(v(670.0, 440.0), v(930.0, 700.0))];
    l.modes = vec![bb_level::Mode::Koth];
    maps.push(l);

    maps.extend(crate::party_assets::imported_maps());
    maps
}

fn lobby_level() -> Level {
    let mut b = LevelBuilder::new("party_lobby", "Party Lobby", Theme::Party);
    b.spawn(v(-500.0, 100.0))
        .ground(&[v(-1300.0, 0.0), v(1300.0, 0.0)], 400.0)
        .block(v(-1400.0, -400.0), v(-1300.0, 1800.0))
        .block(v(1300.0, -400.0), v(1400.0, 1800.0))
        .mushroom(v(-950.0, 0.0), 110.0, 200.0)
        .mushroom(v(950.0, 0.0), 110.0, 200.0)
        .npc("w0", v(800.0, 60.0), NpcRole::Wanderer, "", 24.0)
        .kill_y(-900.0);
    b.build()
}

fn enter(
    mut commands: Commands,
    mut load: MessageWriter<LoadLevel>,
    progress: Res<StoryProgress>,
    mut cam: ResMut<CameraDirector>,
    mut net: MessageWriter<crate::net::NetCommand>,
    session: Option<Res<crate::net::NetSession>>,
) {
    // Party = phones welcome: open a room (unless we're already in one).
    if session.is_none() {
        net.write(crate::net::NetCommand::Host(crate::net::HostOptions::default()));
    }
    let panel = crate::net::ui::spawn_join_panel(&mut commands);
    commands.entity(panel).insert(PartyEntity);
    let roster = vec![(0u8, "Pip".to_string(), progress.pip_color)];
    load.write(LoadLevel { level: lobby_level(), players: roster.clone() });
    cam.target = Some(Vec2::new(0.0, 380.0));
    cam.zoom = Some(1.0);
    commands.insert_resource(Party {
        phase: PartyPhase::Lobby,
        maps: builtin_maps(),
        map: 0,
        mode: ModeKind::Race,
        roster,
        current: None,
        buttons: Vec::new(),
        pending_start: false,
        built: false,
        reopen: false,
    });
}

fn exit(
    mut commands: Commands,
    q: Query<Entity, Or<(With<PartyEntity>, With<MatchHud>)>>,
    mut cam: ResMut<CameraDirector>,
    mut unload: MessageWriter<UnloadLevel>,
    mut overrides: ResMut<StyleOverrides>,
    mut net: MessageWriter<crate::net::NetCommand>,
) {
    net.write(crate::net::NetCommand::Leave);
    commands.remove_resource::<Party>();
    for e in q.iter() {
        commands.entity(e).despawn();
    }
    *cam = CameraDirector::default();
    overrides.0.clear();
    unload.write(UnloadLevel);
}

fn button_label(b: PartyButton, party: &Party) -> String {
    match b {
        PartyButton::Map => format!("Map: {}", party.maps.get(party.map).map_or("?", |m| m.name.as_str())),
        PartyButton::Mode => format!("Mode: {}", party.mode.name()),
        PartyButton::Start => "Start!".into(),
        PartyButton::Back => "Back".into(),
    }
}

/// (Re)build the lobby's jelly buttons when the lobby world is (re)loaded.
fn lobby_ui(
    mut commands: Commands,
    mut party: ResMut<Party>,
    mut game: ResMut<Game>,
    assets: Res<GameAssets>,
    mut overrides: ResMut<StyleOverrides>,
    labels: Query<Entity, With<PartyEntity>>,
    mut texts: Query<(&BodyLabel, &mut Text2d)>,
) {
    if party.phase != PartyPhase::Lobby {
        return;
    }
    if game.is_added() {
        party.built = false;
    }
    if !party.built {
        party.built = true;
        for e in labels.iter() {
            commands.entity(e).despawn();
        }
        party.buttons.clear();
        let items = [(PartyButton::Map, 0x5dd6ff), (PartyButton::Mode, 0xffc75f), (PartyButton::Start, 0x6bcb77), (PartyButton::Back, 0xd0c4e8)];
        for (i, (b, color)) in items.iter().enumerate() {
            let center = PVec2::new(260.0, 620.0 - i as f32 * 96.0);
            let id = jelly_tile(&mut game, center, PVec2::new(520.0, 78.0), BodyTag::Ui, 2e-4);
            overrides.0.insert(id, button_style(*color, false));
            let text = button_label(*b, &party);
            label_with(&mut commands, &assets, id, &text, 34.0, Color::WHITE, PartyEntity);
            party.buttons.push((id, *b, *color));
        }
        // Title tile.
        let id = jelly_tile(&mut game, PVec2::new(-420.0, 640.0), PVec2::new(420.0, 110.0), BodyTag::Ui, 6e-5);
        overrides.0.insert(id, button_style(0xff8fab, false));
        label_with(&mut commands, &assets, id, "PARTY!", 72.0, Color::WHITE, PartyEntity);
        crate::party_assets::spawn_join_hint(&mut commands, &assets, PartyEntity);
    }
    // Keep labels current.
    for (bl, mut t) in texts.iter_mut() {
        if let Some((_, b, _)) = party.buttons.iter().find(|(id, _, _)| *id == bl.body) {
            let want = button_label(*b, &party);
            if t.0 != want {
                t.0 = want;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn lobby_input(
    mut party: ResMut<Party>,
    mut game: ResMut<Game>,
    mouse: Res<ButtonInput<MouseButton>>,
    touches: Res<Touches>,
    keys: Res<ButtonInput<KeyCode>>,
    windows: Query<&Window>,
    cam: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut next: ResMut<NextState<AppState>>,
    mut load: MessageWriter<LoadLevel>,
    mut cam_dir: ResMut<CameraDirector>,
    inputs: Res<Inputs>,
    mut joinable: MessageWriter<crate::net::NetCommand>,
) {
    // Drop-in: any slot (pads, phones) pressing its button joins the roster.
    for s in 1..8u8 {
        if inputs.slots[s as usize].button && game.sim.player(s).is_none() && party.phase == PartyPhase::Lobby {
            let color = bb_sim::PALETTE[s as usize % 12];
            game.sim.add_player(s, &format!("P{}", s + 1), color);
            party.roster.push((s, format!("P{}", s + 1), color));
        }
    }
    if party.reopen && party.phase == PartyPhase::Lobby {
        party.reopen = false;
        joinable.write(crate::net::NetCommand::SetJoinable(true));
    }
    if party.phase != PartyPhase::Lobby {
        if keys.just_pressed(KeyCode::Escape) {
            if let Some(mut m) = party.current.take() {
                m.cleanup(&mut game.sim);
            }
            back_to_lobby(&mut party, &mut load, &mut cam_dir);
        }
        return;
    }
    if keys.just_pressed(KeyCode::Escape) {
        next.set(AppState::Title);
        return;
    }
    let mut press: Option<Vec2> = None;
    if let (Ok((camera, tf)), Some(w)) = (cam.single(), windows.iter().next()) {
        let mut s = None;
        if mouse.just_pressed(MouseButton::Left) {
            s = w.cursor_position();
        }
        for t in touches.iter_just_pressed() {
            s = Some(t.position());
        }
        if let Some(s) = s {
            press = camera.viewport_to_world_2d(tf, s).ok();
        }
    }
    let hit = press.and_then(|p| game.sim.world.pick(PVec2::new(p.x, p.y), crate::load_layer::UI));
    let mut chosen = hit.and_then(|h| party.buttons.iter().find(|b| b.0 == h).map(|b| (b.0, b.1)));
    if keys.just_pressed(KeyCode::Enter) {
        chosen = party.buttons.iter().find(|b| b.1 == PartyButton::Start).map(|b| (b.0, b.1));
    }
    let Some((body, which)) = chosen else { return };
    if let Some(b) = game.sim.world.body_mut(body) {
        b.add_velocity(PVec2::new(0.0, -380.0));
    }
    match which {
        PartyButton::Map => party.map = (party.map + 1) % party.maps.len().max(1),
        PartyButton::Mode => {
            party.mode = match party.mode {
                ModeKind::Race => ModeKind::Koth,
                ModeKind::Koth => ModeKind::Chained,
                ModeKind::Chained => ModeKind::Race,
            }
        }
        PartyButton::Back => next.set(AppState::Title),
        PartyButton::Start => {
            let Some(mut level) = party.maps.get(party.map).cloned() else { return };
            // KOTH needs a hill; races need a goal. Fall back sensibly.
            if party.mode == ModeKind::Koth && level.hills.is_empty() {
                let (min, max) = level.bounds();
                let c = (min + max) * 0.5;
                level.hills.push(Shape::rect(PVec2::new(c.x - 180.0, max.y - 600.0), PVec2::new(c.x + 180.0, max.y)));
            }
            if party.mode != ModeKind::Koth && level.goal.is_none() {
                party.mode = ModeKind::Koth;
            }
            party.roster = game.sim.players.iter().map(|p| (p.slot, p.name.clone(), p.color)).collect();
            party.phase = PartyPhase::Match;
            party.pending_start = true;
            joinable.write(crate::net::NetCommand::SetJoinable(false));
            *cam_dir = CameraDirector::default();
            load.write(LoadLevel { level, players: party.roster.clone() });
        }
    }
}

fn back_to_lobby(party: &mut Party, load: &mut MessageWriter<LoadLevel>, cam: &mut CameraDirector) {
    party.phase = PartyPhase::Lobby;
    party.reopen = true;
    party.built = false;
    party.current = None;
    load.write(LoadLevel { level: lobby_level(), players: party.roster.clone() });
    cam.target = Some(Vec2::new(0.0, 380.0));
    cam.zoom = Some(1.0);
}

fn tick_match(mut party: ResMut<Party>, mut game: ResMut<Game>, mut load: MessageWriter<LoadLevel>, mut cam: ResMut<CameraDirector>) {
    if party.phase != PartyPhase::Match {
        return;
    }
    if party.pending_start && game.sim.level.id != "party_lobby" {
        party.pending_start = false;
        let mut m = Match::new(party.mode);
        m.start(&mut game.sim);
        party.current = Some(m);
    }
    let Some(m) = party.current.as_mut() else { return };
    m.update(&mut game.sim, bb_sim::DT);
    if m.phase == MatchPhase::Over {
        let mut m = party.current.take().unwrap();
        m.cleanup(&mut game.sim);
        back_to_lobby(&mut party, &mut load, &mut cam);
    }
}

fn hud(
    mut commands: Commands,
    party: Res<Party>,
    game: Res<Game>,
    assets: Res<GameAssets>,
    existing: Query<Entity, With<MatchHud>>,
    mut texts: Query<(&HudText, &mut Text, &mut TextColor)>,
) {
    let Some(m) = party.current.as_ref() else {
        for e in existing.iter() {
            commands.entity(e).despawn();
        }
        return;
    };
    if existing.is_empty() {
        let font = |size: f32| TextFont { font: assets.font.clone().into(), font_size: size.into(), weight: FontWeight::BOLD, ..default() };
        commands
            .spawn((Node { position_type: PositionType::Absolute, width: percent(100.0), height: percent(100.0), flex_direction: FlexDirection::Column, align_items: AlignItems::Center, ..default() }, MatchHud))
            .with_children(|p| {
                p.spawn((Text::new(""), font(30.0), TextColor(Color::WHITE), TextShadow::default(), Node { margin: UiRect::top(px(14.0)), ..default() }, HudText::Timer));
                p.spawn((Text::new(""), font(140.0), TextColor(Color::WHITE), TextShadow { offset: Vec2::new(5.0, 6.0), color: Color::srgba(0.0, 0.0, 0.0, 0.5) }, Node { margin: UiRect::top(px(140.0)), ..default() }, HudText::Big));
            });
        commands.spawn((
            Text::new(""),
            font(24.0),
            TextColor(Color::WHITE),
            TextShadow::default(),
            Node { position_type: PositionType::Absolute, right: px(24.0), top: px(18.0), ..default() },
            MatchHud,
            HudText::Scores,
        ));
        return;
    }
    let name_of = |slot: u8| game.sim.player(slot).map_or(format!("P{}", slot + 1), |p| p.name.clone());
    for (which, mut text, mut color) in texts.iter_mut() {
        match which {
            HudText::Timer => {
                let t = m.time_remaining().ceil() as u32;
                text.0 = format!("{}:{:02}", t / 60, t % 60);
                color.0 = if t <= 10 { hex(0xff5c5c) } else { Color::WHITE };
            }
            HudText::Big => {
                text.0 = match m.phase {
                    MatchPhase::Countdown(t) => format!("{}", t.ceil() as u32),
                    MatchPhase::Playing if m.time < 0.8 => "GO!".into(),
                    MatchPhase::Results(_) | MatchPhase::Over => match (m.kind, m.team_won, m.winner) {
                        (ModeKind::Chained, Some(true), _) => "Everyone wins!".into(),
                        (ModeKind::Chained, _, _) => "So close!".into(),
                        (_, _, Some(w)) => format!("{} wins!", name_of(w)),
                        _ => "Time's up!".into(),
                    },
                    _ => String::new(),
                };
                color.0 = if matches!(m.phase, MatchPhase::Playing) { hex(0x4eff4e) } else { Color::WHITE };
            }
            HudText::Scores => {
                text.0 = if m.kind == ModeKind::Koth {
                    let mut rows = m.scores.clone();
                    rows.sort_by(|a, b| b.1.total_cmp(&a.1));
                    rows.iter().map(|(s, sc)| format!("{}  {:>2} / {}", name_of(*s), sc.floor() as u32, KOTH_TARGET as u32)).collect::<Vec<_>>().join("\n")
                } else {
                    String::new()
                };
            }
        }
    }
}
