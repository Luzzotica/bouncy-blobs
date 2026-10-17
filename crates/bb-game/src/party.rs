//! Party mode: a jelly lobby where phones and pads drop in, then King of
//! the Hill rounds on party maps.
//!
//! Rounds are picked by [`PartyRule`]. Only King of the Hill exists today;
//! a build-then-run round (Ultimate Chicken Horse style: everyone places a
//! trap, then everyone runs the course) is meant to slot in as another
//! variant, with its own phases driven from [`tick_match`] and its own map
//! prep in [`prepare_map`].

use bb_level::{Level, LevelBuilder, NpcRole, Shape, Theme, v};
use bb_physics::{BodyId, Vec2 as PVec2};
use bb_sim::{BodyTag, SimEvent};
use bb_sim::modes::{KOTH_TARGET, Match, MatchPhase, ModeKind};
use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::camera::{CameraDirector, MainCamera};
use crate::flow::AppState;
use crate::dropin::{DropIn, DropStyle};
use crate::menu::{BodyLabel, button_style, jelly_tile, kick_label, label_with};
use crate::softtext::{JiggleText, SoftText};
use crate::palette::{hex, lin};
use crate::render::{MeshBuf, Shared, StyleOverrides, la, z};
use crate::sim::{Game, Inputs, LoadLevel, UnloadLevel};
use crate::story::StoryProgress;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PartyPhase {
    Lobby,
    Match,
}

/// What a party round plays. Rounds are King of the Hill for now; new
/// round types (e.g. build-then-run) add a variant here.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PartyRule {
    #[default]
    Koth,
}

impl PartyRule {
    pub fn name(self) -> &'static str {
        match self {
            PartyRule::Koth => "King of the Hill",
        }
    }

    /// The sim-side match rules this round runs on.
    fn match_kind(self) -> ModeKind {
        match self {
            PartyRule::Koth => ModeKind::Koth,
        }
    }
}

#[derive(Resource)]
pub struct Party {
    phase: PartyPhase,
    pub maps: Vec<Level>,
    pub map: usize,
    pub rule: PartyRule,
    /// Players carried between lobby and rounds: (slot, name, colour).
    pub roster: Vec<(u8, String, u32)>,
    pub current: Option<Match>,
    buttons: Vec<(BodyId, PartyButton, u32)>,
    pending_start: bool,
    /// The round's winner has been cheered (one `SimEvent::Goal`).
    cheered: bool,
    built: bool,
    /// Re-open the room for joins once back in the lobby.
    reopen: bool,
    /// Lobby buttons fall in like the title menu.
    drop: DropIn,
}

impl Party {
    /// In the lobby (a menu) rather than a round.
    pub fn in_lobby(&self) -> bool {
        self.phase == PartyPhase::Lobby
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PartyButton {
    Map,
    Start,
    Back,
}

/// Lives for the whole party screen (the phone join panel).
#[derive(Component)]
struct PartyEntity;

/// Lobby button labels and hints, rebuilt with the lobby world.
#[derive(Component)]
struct LobbyItem;

#[derive(Component)]
struct MatchHud;

/// The active hill's glowing zone (rebuilt every frame).
#[derive(Component)]
struct HillMark;

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
            .add_systems(Update, (lobby_ui, lobby_input, hud, draw_hill, join_panel_visibility).run_if(in_state(AppState::Party).and_then(resource_exists::<Game>)))
            .add_systems(FixedPostUpdate, tick_match.run_if(in_state(AppState::Party).and_then(resource_exists::<Game>)));
    }
}

/// Party maps: two built here plus the imported 2.x maps. Every one plays
/// as King of the Hill (see [`prepare_map`]).
pub fn builtin_maps() -> Vec<Level> {
    let mut maps = Vec::new();

    let mut b = LevelBuilder::new("party_wobble_hill", "Wobble Hill", Theme::Party);
    // Spawn above the raised middle (ground is at y = 220 there).
    b.spawn(v(0.0, 300.0))
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
    // The old finish line is the hill: dash there, then shove for it.
    let mut l = b.build();
    l.modes = vec![bb_level::Mode::Koth];
    maps.push(l);

    maps.extend(crate::party_assets::imported_maps());
    maps
}

/// Smallest hill made from a map's old finish zone.
const MIN_HILL: PVec2 = PVec2::new(320.0, 260.0);

/// Ready a map for a round of `rule`.
///
/// King of the Hill: maps without hills (the 2.x race maps) get their
/// finish zone as the hill, grown to at least [`MIN_HILL`] and resting on
/// the zone's floor; maps with neither get one over the spawn. The goal is
/// dropped so no flag is drawn and touching it doesn't end anything.
pub fn prepare_map(mut level: Level, rule: PartyRule) -> Level {
    match rule {
        PartyRule::Koth => {
            if level.hills.is_empty() {
                let hill = match level.goal.as_ref().map(Shape::bounds) {
                    Some((lo, hi)) => {
                        let c = (lo.x + hi.x) * 0.5;
                        let size = (hi - lo).max(MIN_HILL);
                        Shape::rect(PVec2::new(c - size.x * 0.5, lo.y), PVec2::new(c + size.x * 0.5, lo.y + size.y))
                    }
                    None => {
                        let s = level.spawn;
                        Shape::rect(PVec2::new(s.x - MIN_HILL.x * 0.5, s.y - 80.0), PVec2::new(s.x + MIN_HILL.x * 0.5, s.y - 80.0 + MIN_HILL.y))
                    }
                };
                level.hills.push(hill);
            }
            level.goal = None;
            level.modes = vec![bb_level::Mode::Koth];
        }
    }
    level
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
    (own, mut next): (Option<Res<crate::ownership::Ownership>>, ResMut<NextState<crate::flow::AppState>>),
) {
    // Party (hosting, local multiplayer) needs the full game; the menu
    // shows it locked, so this only catches dev shortcuts.
    if !crate::ownership::allowed(own.as_deref(), crate::ownership::Feature::Host) {
        warn!("party: needs the full game");
        next.set(crate::flow::AppState::Title);
        return;
    }
    // Party = phones welcome: host (in the home room when there is one, so
    // phones already in it get seated) unless we're already hosting.
    if session.as_deref().is_none_or(|s| s.home && !s.seating) {
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
        rule: PartyRule::Koth,
        roster,
        current: None,
        buttons: Vec::new(),
        pending_start: false,
        cheered: false,
        built: false,
        reopen: false,
        drop: DropIn::new(DropStyle::MENU),
    });
}

fn exit(
    mut commands: Commands,
    q: Query<Entity, Or<(With<PartyEntity>, With<LobbyItem>, With<MatchHud>, With<HillMark>)>>,
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
    labels: Query<Entity, With<LobbyItem>>,
    mut texts: Query<(&BodyLabel, &mut SoftText)>,
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
        party.drop.clear();
        let items = [(PartyButton::Map, 0x5dd6ff), (PartyButton::Start, 0x6bcb77), (PartyButton::Back, 0xd0c4e8)];
        for (i, (b, color)) in items.iter().enumerate() {
            // A column under the title, so the phone join panel (top right)
            // stays clear on 4:3 iPads and 19.5:9 phones alike.
            let center = PVec2::new(-480.0, 500.0 - i as f32 * 96.0);
            let id = jelly_tile(&mut game, center, PVec2::new(440.0, 78.0), BodyTag::Ui, crate::menu::BUTTON_SPRING);
            overrides.0.insert(id, button_style(*color, false));
            let text = button_label(*b, &party);
            label_with(&mut commands, &assets, id, &text, 34.0, Color::WHITE, LobbyItem);
            party.buttons.push((id, *b, *color));
            party.drop.add(&mut game.sim.world, id, 0.12 + (items.len() - 1 - i) as f32 * 0.07);
        }
        // Title tile.
        let id = jelly_tile(&mut game, PVec2::new(-480.0, 640.0), PVec2::new(420.0, 110.0), BodyTag::Ui, crate::menu::LETTER_SPRING);
        overrides.0.insert(id, button_style(0xff8fab, false));
        label_with(&mut commands, &assets, id, "PARTY!", 72.0, Color::WHITE, LobbyItem);
        party.drop.add(&mut game.sim.world, id, 0.0);
        crate::party_assets::spawn_join_hint(&mut commands, &assets, LobbyItem);
    }
    // Keep labels current.
    for (bl, mut t) in texts.iter_mut() {
        if let Some((_, b, _)) = party.buttons.iter().find(|(id, _, _)| *id == bl.body) {
            let want = button_label(*b, &party);
            if t.text != want {
                t.text = want;
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
    (time, mut labels, mut pointer, pads): (Res<Time>, Query<&mut SoftText>, ResMut<crate::menu_feel::MenuPointer>, Query<&Gamepad>),
) {
    if party.phase == PartyPhase::Lobby {
        let dt = time.delta_secs().min(1.0 / 20.0);
        let p = &mut *party;
        p.drop.update(&mut game.sim.world, dt);
    }
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
        // Leave the round: Escape / Backspace / Android back, or a pad's
        // Select (B is a jump button in a round).
        let leave = keys.any_just_pressed([KeyCode::Escape, KeyCode::Backspace, KeyCode::BrowserBack]) || pads.iter().any(|p| p.just_pressed(GamepadButton::Select));
        if leave {
            if let Some(mut m) = party.current.take() {
                m.cleanup(&mut game.sim);
            }
            back_to_lobby(&mut party, &mut load, &mut cam_dir);
        }
        return;
    }
    if crate::input::back_pressed(&keys, pads.iter()) {
        next.set(AppState::Title);
        return;
    }
    // A click is a press + release that didn't drag the tile (menu_feel).
    let _ = (&mouse, &touches, &windows, &cam);
    let press: Option<Vec2> = pointer.take_click();
    let hit = press.and_then(|p| game.sim.world.pick(PVec2::new(p.x, p.y), crate::load_layer::UI));
    let mut chosen = hit.and_then(|h| party.buttons.iter().find(|b| b.0 == h).map(|b| (b.0, b.1)));
    // Keys and pads: Enter / Start plays, Tab / the left bumper picks
    // the next map (the arrows and stick roll your blob around the lobby).
    let pick = |want: PartyButton| party.buttons.iter().find(|b| b.1 == want).map(|b| (b.0, b.1));
    if keys.just_pressed(KeyCode::Enter) || pads.iter().any(|p| p.just_pressed(GamepadButton::Start)) {
        chosen = pick(PartyButton::Start);
    }
    if keys.just_pressed(KeyCode::Tab) || pads.iter().any(|p| p.just_pressed(GamepadButton::LeftTrigger)) {
        chosen = chosen.or(pick(PartyButton::Map));
    }
    let Some((body, which)) = chosen else { return };
    if let Some(b) = game.sim.world.body_mut(body) {
        b.add_velocity(PVec2::new(0.0, -380.0));
    }
    kick_label(&mut labels, body, 1.2);
    match which {
        PartyButton::Map => party.map = (party.map + 1) % party.maps.len().max(1),
        PartyButton::Back => next.set(AppState::Title),
        PartyButton::Start => {
            let Some(level) = party.maps.get(party.map).cloned() else { return };
            let level = prepare_map(level, party.rule);
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
        let mut m = Match::new(party.rule.match_kind());
        m.start(&mut game.sim);
        party.current = Some(m);
        party.cheered = false;
    }
    let Some(m) = party.current.as_mut() else { return };
    m.update(&mut game.sim, bb_sim::DT);
    let (phase, winner) = (m.phase, m.winner);
    if let (MatchPhase::Results(_), Some(slot)) = (phase, winner) {
        if !std::mem::replace(&mut party.cheered, true) {
            // The round-win sting and the Party Winner achievement.
            game.sim.events.push(SimEvent::Goal { slot });
        }
    }
    if phase == MatchPhase::Over {
        let mut m = party.current.take().unwrap();
        m.cleanup(&mut game.sim);
        back_to_lobby(&mut party, &mut load, &mut cam);
    }
}

/// The phone join panel and lobby hints show in the lobby only (rounds are
/// closed to joins and the panel would cover the scores).
fn join_panel_visibility(party: Res<Party>, mut q: Query<&mut Visibility, Or<(With<PartyEntity>, With<LobbyItem>)>>) {
    let want = if party.phase == PartyPhase::Lobby { Visibility::Inherited } else { Visibility::Hidden };
    for mut v in q.iter_mut() {
        v.set_if_neq(want);
    }
}

/// Glow the active hill: gold while empty or contested, the king's colour
/// while one blob holds it.
fn draw_hill(
    mut commands: Commands,
    party: Res<Party>,
    game: Res<Game>,
    time: Res<Time>,
    shared: Res<Shared>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mark: Query<(Entity, &Mesh2d), With<HillMark>>,
) {
    let hill = party.current.as_ref().and_then(|m| m.active_hill(&game.sim).map(|h| (m, h.outline())));
    let Some((m, pts)) = hill else {
        for (e, _) in mark.iter() {
            commands.entity(e).despawn();
        }
        return;
    };
    let color = m.king.and_then(|s| game.sim.player(s)).map_or(hex(0xffd93d), |p| hex(p.color));
    let pulse = 0.5 + 0.5 * (time.elapsed_secs() * 4.0).sin();
    let mut buf = MeshBuf::default();
    let c = pts.iter().copied().sum::<PVec2>() / pts.len().max(1) as f32;
    buf.fan(&pts, c, 0.0, la(color, 0.04 + 0.04 * pulse), la(color, 0.14 + 0.06 * pulse));
    buf.ring(&pts, 4.0, 4.0, 0.0, lin(color));
    match mark.iter_mut().next() {
        Some((_, h)) => {
            if let Some(mut mesh) = meshes.get_mut(&h.0) {
                buf.write(&mut mesh);
            }
        }
        None => {
            commands.spawn((Mesh2d(meshes.add(buf.into_mesh())), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::ZONES + 0.5), HillMark));
        }
    }
}

fn hud(
    mut commands: Commands,
    party: Res<Party>,
    game: Res<Game>,
    assets: Res<GameAssets>,
    existing: Query<Entity, With<MatchHud>>,
    mut texts: Query<(&HudText, &mut Text, &mut TextColor)>,
    mut jiggles: Query<(&HudText, &mut JiggleText)>,
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
                // Timer and the big countdown are per-glyph: digits bounce as they change.
                p.spawn((JiggleText::new("", font(30.0), Color::WHITE).shadow(TextShadow::default()), Node { margin: UiRect::top(px(14.0)), ..default() }, HudText::Timer));
                p.spawn((
                    JiggleText::new("", font(140.0), Color::WHITE).shadow(TextShadow { offset: Vec2::new(5.0, 6.0), color: Color::srgba(0.0, 0.0, 0.0, 0.5) }),
                    Node { margin: UiRect::top(px(140.0)), ..default() },
                    HudText::Big,
                ));
            });
        commands.spawn((
            Text::new(""),
            font(24.0),
            TextColor(Color::WHITE),
            TextShadow::default(),
            Node { position_type: PositionType::Absolute, right: px(24.0 + crate::platform::SAFE_SIDE), top: px(18.0), ..default() },
            MatchHud,
            HudText::Scores,
        ));
        return;
    }
    let name_of = |slot: u8| game.sim.player(slot).map_or(format!("P{}", slot + 1), |p| p.name.clone());
    for (which, mut jt) in jiggles.iter_mut() {
        let (want, color) = match which {
            HudText::Timer => {
                let t = m.time_remaining().ceil() as u32;
                (format!("{}:{:02}", t / 60, t % 60), if t <= 10 { hex(0xff5c5c) } else { Color::WHITE })
            }
            HudText::Big => {
                let text = match m.phase {
                    MatchPhase::Countdown(t) => format!("{}", t.ceil() as u32),
                    MatchPhase::Playing if m.time < 0.8 => "GO!".into(),
                    MatchPhase::Results(_) | MatchPhase::Over => match m.winner {
                        Some(w) => format!("{} wins!", name_of(w)),
                        None => "Time's up!".into(),
                    },
                    _ => String::new(),
                };
                (text, if matches!(m.phase, MatchPhase::Playing) { hex(0x4eff4e) } else { Color::WHITE })
            }
            HudText::Scores => continue,
        };
        if jt.text != want {
            jt.text = want;
        }
        jt.color = color;
    }
    for (which, mut text, _) in texts.iter_mut() {
        if let HudText::Scores = which {
            let mut rows = m.scores.clone();
            rows.sort_by(|a, b| b.1.total_cmp(&a.1));
            text.0 = rows.iter().map(|(s, sc)| format!("{}  {:>2} / {}", name_of(*s), sc.floor() as u32, KOTH_TARGET as u32)).collect::<Vec<_>>().join("\n");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every lobby map plays as King of the Hill: at least one hill, no goal.
    #[test]
    fn every_map_is_koth_ready() {
        let maps = builtin_maps();
        assert!(maps.len() >= 20, "{} maps", maps.len());
        for l in maps {
            let id = l.id.clone();
            let had_goal = l.goal.clone().filter(|_| l.hills.is_empty());
            let p = prepare_map(l, PartyRule::Koth);
            assert!(!p.hills.is_empty(), "{id}: no hill");
            assert!(p.goal.is_none(), "{id}: goal left in");
            if let Some(g) = had_goal {
                // Converted hills cover the old finish zone.
                let (glo, ghi) = g.bounds();
                let (hlo, hhi) = p.hills[0].bounds();
                assert!(hlo.x <= glo.x + 0.01 && hhi.x >= ghi.x - 0.01 && hhi.y >= ghi.y - 0.01, "{id}: hill misses the old goal");
            }
        }
    }

    /// A KOTH round on a converted race map scores whoever stands on the hill.
    #[test]
    fn converted_hill_scores() {
        let level = crate::party_assets::party_level("simple-race").unwrap();
        let level = prepare_map(level, PartyRule::Koth);
        let hill = level.hills[0].clone();
        let mut sim = bb_sim::Sim::new(level);
        sim.add_player(0, "P1", 0xff5d73);
        let mut m = Match::new(PartyRule::Koth.match_kind());
        m.start(&mut sim);
        let body = sim.players[0].ctl.body;
        let c = hill.center();
        for _ in 0..(5.0 / bb_sim::DT) as usize {
            sim.world.respawn(body, c);
            sim.step();
            m.update(&mut sim, bb_sim::DT);
        }
        assert!(m.scores[0].1 > 0.5, "score {:?}", m.scores);
    }
}
