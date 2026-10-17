//! Navigation smoke test: drives the real game (every plugin, offscreen
//! rendering, no window, no sound) through every screen and back, by mouse,
//! touch, keyboard and gamepad, and checks the app state and the key
//! entities after each step.
//!
//! ```text
//! cargo nextest run -p bb-game --test nav_smoke
//! BB_NAV_SHOTS=/some/dir cargo nextest run -p bb-game --test nav_smoke   # + screenshots
//! ```
//!
//! Each test is its own process (nextest), so each sets its own env (demo
//! or owned, a scratch HOME so saves never touch the real ones, offline).

use std::path::PathBuf;
use std::time::Duration;

use bb_game::camera::{CameraDirector, MainCamera};
use bb_game::flow::AppState;
use bb_game::menu::{Action, Lock, Menu, Page};
use bb_game::sim::Game;
use bevy::input::ButtonState;
use bevy::input::gamepad::{Gamepad, GamepadAxis, GamepadButton, RawGamepadAxisChangedEvent, RawGamepadButtonChangedEvent, RawGamepadEvent};
use bevy::input::keyboard::{Key, KeyboardInput, NativeKey};
use bevy::input::mouse::MouseButtonInput;
use bevy::input::touch::{TouchInput, TouchPhase};
use bevy::prelude::*;
use bevy::render::view::screenshot::{Screenshot, save_to_disk};
use bevy::time::TimeUpdateStrategy;

/// Scripted input for the next frame (applied in `First`, as raw device
/// messages, so the game sees it exactly like the real thing).
#[derive(Resource, Default)]
struct Drive {
    keys: Vec<(KeyCode, bool)>,
    mouse: Option<(Vec2, Option<bool>)>,
    touch: Option<(Vec2, TouchPhase)>,
    pad: Vec<(GamepadButton, bool)>,
    stick: Option<Vec2>,
}

#[derive(Resource)]
struct Pad(Entity);

#[derive(Resource)]
struct FakeWindow(Entity);

fn drive(
    mut d: ResMut<Drive>,
    mut keys: MessageWriter<KeyboardInput>,
    mut mouse: MessageWriter<MouseButtonInput>,
    mut touch: MessageWriter<TouchInput>,
    mut pad_ev: MessageWriter<RawGamepadEvent>,
    pad: Res<Pad>,
    win: Res<FakeWindow>,
    mut windows: Query<&mut Window>,
) {
    for (k, down) in d.keys.drain(..) {
        keys.write(KeyboardInput {
            key_code: k,
            logical_key: Key::Unidentified(NativeKey::Unidentified),
            state: if down { ButtonState::Pressed } else { ButtonState::Released },
            text: None,
            repeat: false,
            window: win.0,
        });
    }
    if let Some((at, button)) = d.mouse.take() {
        if let Ok(mut w) = windows.get_mut(win.0) {
            w.set_cursor_position(Some(at));
        }
        if let Some(down) = button {
            mouse.write(MouseButtonInput { button: MouseButton::Left, state: if down { ButtonState::Pressed } else { ButtonState::Released }, window: win.0 });
        }
    }
    if let Some((at, phase)) = d.touch.take() {
        touch.write(TouchInput { phase, position: at, window: win.0, force: None, id: 7 });
    }
    for (b, down) in d.pad.drain(..) {
        pad_ev.write(RawGamepadEvent::Button(RawGamepadButtonChangedEvent::new(pad.0, b, if down { 1.0 } else { 0.0 })));
    }
    if let Some(s) = d.stick.take() {
        pad_ev.write(RawGamepadEvent::Axis(RawGamepadAxisChangedEvent::new(pad.0, GamepadAxis::LeftStickX, s.x)));
        pad_ev.write(RawGamepadEvent::Axis(RawGamepadAxisChangedEvent::new(pad.0, GamepadAxis::LeftStickY, s.y)));
    }
}

/// How a step presses a menu button.
#[derive(Clone, Copy, Debug)]
enum Via {
    Mouse,
    Touch,
}

struct Nav {
    app: App,
    size: UVec2,
    frame: u32,
    shots: Option<PathBuf>,
    tag: String,
}

/// Env for a test process. Call first thing in a test (each nextest test is
/// its own process, so this never races another test).
fn env(demo: bool, extra: &[(&str, &str)]) {
    let home = std::env::temp_dir().join(format!("bb-nav-home-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&home);
    let shot = home.join("unused.png");
    // SAFETY: set before the app (or any other thread) starts.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_DATA_HOME", home.join("data"));
        std::env::set_var("BB_SHOT", &shot);
        std::env::set_var("BB_SHOT_FRAME", "4000000000");
        std::env::set_var("BB_MUTE", "1");
        std::env::set_var("BB_OFFLINE", "1");
        std::env::set_var("BB_NO_ACCOUNT", "1");
        // Any online attempt (hosting, joining) fails fast on this machine.
        std::env::set_var("BB_PARTII_API", "http://127.0.0.1:9");
        if demo {
            std::env::set_var("BB_DEMO", "1");
        }
        for (k, v) in extra {
            std::env::set_var(k, v);
        }
    }
}

impl Nav {
    fn new(tag: &str, size: UVec2) -> Nav {
        unsafe {
            std::env::set_var("BB_SHOT_SIZE", format!("{}x{}", size.x, size.y));
        }
        let mut app = bb_game::app();
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(1.0 / 60.0)));
        app.init_resource::<Drive>();
        app.add_systems(First, drive);
        // A window with no OS window behind it (no winit): it carries the
        // mouse cursor, sized like the offscreen frame the camera renders.
        let mut w = Window::default();
        w.resolution.set(size.x as f32, size.y as f32);
        w.resolution.set_scale_factor_override(Some(1.0));
        let win = app.world_mut().spawn((w, bevy::window::PrimaryWindow)).id();
        app.insert_resource(FakeWindow(win));
        let pad = app.world_mut().spawn(Gamepad::default()).id();
        app.insert_resource(Pad(pad));
        app.finish();
        app.cleanup();
        let shots = std::env::var_os("BB_NAV_SHOTS").map(PathBuf::from);
        if let Some(s) = &shots {
            let _ = std::fs::create_dir_all(s);
        }
        Nav { app, size, frame: 0, shots, tag: tag.into() }
    }

    fn drive(&mut self) -> Mut<'_, Drive> {
        self.app.world_mut().resource_mut::<Drive>()
    }

    fn step(&mut self) {
        self.app.update();
        self.frame += 1;
    }

    fn run(&mut self, frames: u32) {
        for _ in 0..frames {
            self.step();
        }
    }

    fn state(&self) -> AppState {
        *self.app.world().resource::<State<AppState>>().get()
    }

    fn world(&self) -> &World {
        self.app.world()
    }

    fn level(&self) -> Option<String> {
        self.world().get_resource::<Game>().map(|g| g.sim.level.id.clone())
    }

    fn menu(&self) -> Option<&Menu> {
        self.world().get_resource::<Menu>()
    }

    /// Step until `ok`, or fail with what the game looked like.
    #[track_caller]
    fn until(&mut self, what: &str, max: u32, ok: impl Fn(&Nav) -> bool) {
        for _ in 0..max {
            if ok(self) {
                return;
            }
            self.step();
        }
        if ok(self) {
            return;
        }
        self.shot(&format!("FAIL-{}", what.replace(' ', "_")));
        panic!(
            "[{}] never got to: {what} (frame {}, state {:?}, level {:?}, page {:?})",
            self.tag,
            self.frame,
            self.state(),
            self.level(),
            self.menu().map(|m| m.page)
        );
    }

    fn key(&mut self, k: KeyCode) {
        self.app.world_mut().resource_mut::<Drive>().keys.push((k, true));
        self.step();
        self.app.world_mut().resource_mut::<Drive>().keys.push((k, false));
        self.step();
    }

    fn hold_key(&mut self, k: KeyCode, frames: u32) {
        self.app.world_mut().resource_mut::<Drive>().keys.push((k, true));
        self.run(frames.max(1));
        self.app.world_mut().resource_mut::<Drive>().keys.push((k, false));
        self.step();
    }

    fn hold_touch(&mut self, s: Vec2, frames: u32) {
        self.app.world_mut().resource_mut::<Drive>().touch = Some((s, TouchPhase::Started));
        self.run(frames.max(1));
        self.app.world_mut().resource_mut::<Drive>().touch = Some((s, TouchPhase::Ended));
        self.step();
    }

    fn pad(&mut self, b: GamepadButton) {
        self.app.world_mut().resource_mut::<Drive>().pad.push((b, true));
        self.run(2);
        self.app.world_mut().resource_mut::<Drive>().pad.push((b, false));
        self.run(2);
    }

    fn stick(&mut self, s: Vec2) {
        self.app.world_mut().resource_mut::<Drive>().stick = Some(s);
        self.run(2);
        self.app.world_mut().resource_mut::<Drive>().stick = Some(Vec2::ZERO);
        self.run(2);
    }

    fn to_screen(&mut self, w: Vec2) -> Vec2 {
        let mut q = self.app.world_mut().query_filtered::<(&Camera, &GlobalTransform), With<MainCamera>>();
        let (cam, tf) = q.single(self.app.world()).expect("main camera");
        cam.world_to_viewport(tf, w.extend(0.0)).expect("on screen")
    }

    /// Press and release at a screen point, by mouse or finger.
    fn press_screen(&mut self, s: Vec2, via: Via) {
        match via {
            Via::Mouse => {
                self.drive().mouse = Some((s, None));
                self.step();
                self.drive().mouse = Some((s, Some(true)));
                self.run(3);
                self.drive().mouse = Some((s, Some(false)));
                self.step();
                // Park the cursor in a corner (no hover left behind).
                self.drive().mouse = Some((Vec2::new(self.size.x as f32 - 2.0, 2.0), None));
                self.step();
            }
            Via::Touch => {
                self.drive().touch = Some((s, TouchPhase::Started));
                self.run(3);
                self.drive().touch = Some((s, TouchPhase::Ended));
                self.step();
            }
        }
    }

    fn press_world(&mut self, w: Vec2, via: Via) {
        let s = self.to_screen(w);
        self.press_screen(s, via);
    }

    /// Wait for the title page to settle (dropped in, nothing tumbling).
    #[track_caller]
    fn settle_title(&mut self, page: Page) {
        // A pressed tile fires after its squish, and a page switch rebuilds
        // the frame after that: never judge the old page.
        self.until("the press to fire", 120, |n| n.menu().is_none_or(|m| m.pending.is_none()));
        self.run(3);
        self.until(&format!("title page {page:?}"), 900, |n| {
            n.state() == AppState::Title && n.level().as_deref() == Some(bb_game::menu::TITLE_ID) && n.menu().is_some_and(|m| m.page == page && !m.buttons.is_empty() && m.drop.done() && m.falling.is_empty())
        });
        self.run(20);
        self.check_title();
    }

    /// Every button is home (not knocked over), the logo is whole, the
    /// camera looks at the menu.
    #[track_caller]
    fn check_title(&mut self) {
        let menu = self.menu().expect("menu");
        let game = self.world().resource::<Game>();
        assert_eq!(menu.letters.len(), 11, "[{}] logo letters", self.tag);
        for b in menu.buttons.iter().map(|b| b.body).chain(menu.letters.iter().copied()) {
            let body = game.sim.world.body(b).unwrap_or_else(|| panic!("[{}] button body {b:?} missing", self.tag));
            let home = body.home.as_ref().unwrap_or_else(|| panic!("[{}] a tile lost its home tether (tumbling) at frame {}: drop done {}, falling {}, page {:?}", self.tag, self.frame, menu.drop.done(), menu.falling.len(), menu.page));
            let spot = home.iter().fold(bb_physics::Vec2::ZERO, |a, p| a + *p) / home.len() as f32;
            let drift = body.centroid().distance(spot);
            assert!(drift < 40.0, "[{}] a tile is {drift:.0} px from its spot", self.tag);
        }
        let dir = self.world().resource::<CameraDirector>();
        let t = dir.target.expect("menu camera target");
        assert!(t.distance(Vec2::new(0.0, 380.0)) < 90.0, "[{}] stale camera target {t}", self.tag);
        assert!(dir.keep.is_none() && dir.cover == 0.0, "[{}] cutscene framing left on the title", self.tag);
    }

    fn button(&self, want: &Action) -> Option<(usize, Vec2)> {
        let menu = self.menu()?;
        let game = self.world().get_resource::<Game>()?;
        let (i, b) = menu.buttons.iter().enumerate().find(|(_, b)| &b.action == want)?;
        let c = game.sim.world.body(b.body)?.centroid();
        Some((i, Vec2::new(c.x, c.y)))
    }

    /// Press the title button whose action is `want`.
    #[track_caller]
    fn choose(&mut self, want: Action, via: Via) {
        let (_, at) = self.button(&want).unwrap_or_else(|| panic!("[{}] no {want:?} button on {:?}", self.tag, self.menu().map(|m| m.page)));
        self.press_world(at, via);
    }

    /// Move the keyboard focus to `want` with the arrow keys and press Enter.
    #[track_caller]
    fn choose_by_keys(&mut self, want: Action) {
        let (i, _) = self.button(&want).unwrap_or_else(|| panic!("[{}] no {want:?} button", self.tag));
        let mut guard = 0;
        while self.menu().unwrap().focus != i {
            self.hold_key(KeyCode::ArrowDown, 2);
            self.run(14);
            guard += 1;
            assert!(guard < 20, "[{}] focus never reached {want:?}", self.tag);
        }
        self.key(KeyCode::Enter);
    }

    /// The same with a gamepad: stick down, then A.
    #[track_caller]
    fn choose_by_pad(&mut self, want: Action) {
        let (i, _) = self.button(&want).unwrap_or_else(|| panic!("[{}] no {want:?} button", self.tag));
        let mut guard = 0;
        while self.menu().unwrap().focus != i {
            self.stick(Vec2::new(0.0, -1.0));
            self.run(12);
            guard += 1;
            assert!(guard < 20, "[{}] focus never reached {want:?}", self.tag);
        }
        self.pad(GamepadButton::South);
    }

    /// Save a screenshot (only with `BB_NAV_SHOTS=dir`).
    fn shot(&mut self, name: &str) {
        let Some(dir) = self.shots.clone() else { return };
        let target = {
            let mut q = self.app.world_mut().query_filtered::<&bevy::camera::RenderTarget, With<MainCamera>>();
            q.iter(self.app.world()).next().cloned()
        };
        let Some(bevy::camera::RenderTarget::Image(img)) = target else { return };
        let path = dir.join(format!("{}-{}x{}-{name}.png", self.tag, self.size.x, self.size.y));
        self.app.world_mut().spawn(Screenshot::image(img.handle.clone())).observe(save_to_disk(path));
        self.run(4);
    }

    fn entity_count(&self) -> usize {
        self.world().entities().count_spawned() as usize
    }
}

const LANDSCAPE: UVec2 = UVec2::new(1600, 900);

/// Title → Play → back by every means (Escape, the Back tile by mouse and
/// touch, the gamepad's B), every title page and its way back.
#[test]
fn title_pages_and_back() {
    env(false, &[]);
    let mut n = Nav::new("pages", LANDSCAPE);
    n.settle_title(Page::Main);
    n.shot("main");
    // Mouse into Play, Escape back.
    n.choose(Action::Goto(Page::Play), Via::Mouse);
    n.settle_title(Page::Play);
    n.shot("play");
    n.key(KeyCode::Escape);
    n.settle_title(Page::Main);
    // Touch into Play, Back tile (touch) out.
    n.choose(Action::Goto(Page::Play), Via::Touch);
    n.settle_title(Page::Play);
    n.choose(Action::Goto(Page::Main), Via::Touch);
    n.settle_title(Page::Main);
    // Keyboard into Settings; gamepad B back.
    n.choose_by_keys(Action::Goto(Page::Settings));
    n.settle_title(Page::Settings);
    n.shot("settings");
    n.pad(GamepadButton::East);
    n.settle_title(Page::Main);
    // Gamepad into Play → Multiplayer, B back twice.
    n.choose_by_pad(Action::Goto(Page::Play));
    n.settle_title(Page::Play);
    n.choose_by_pad(Action::Goto(Page::Party));
    n.settle_title(Page::Party);
    n.shot("multiplayer");
    n.pad(GamepadButton::East);
    n.settle_title(Page::Play);
    n.pad(GamepadButton::East);
    n.settle_title(Page::Main);
    // Settings toggles: each fires and stays on Settings.
    n.choose(Action::Goto(Page::Settings), Via::Mouse);
    n.settle_title(Page::Settings);
    let before = n.world().resource::<bb_game::story::StoryProgress>().pip_color;
    n.choose(Action::Color, Via::Mouse);
    n.run(30);
    assert_ne!(n.world().resource::<bb_game::story::StoryProgress>().pip_color, before, "Blob Color changes the colour");
    n.choose(Action::ToggleStreamer, Via::Mouse);
    n.run(30);
    n.choose(Action::ToggleStreamer, Via::Touch);
    n.run(30);
    n.choose(Action::ToggleFullscreen, Via::Mouse);
    n.run(30);
    n.settle_title(Page::Settings);
    n.choose(Action::Goto(Page::Main), Via::Mouse);
    n.settle_title(Page::Main);
    // Escape on the main page stays put (no accidental quit).
    n.key(KeyCode::Escape);
    n.run(30);
    assert_eq!(n.state(), AppState::Title);
    assert_eq!(n.menu().unwrap().page, Page::Main);
}

/// Sandbox twice in a row: in by mouse / keys, out through the pause menu
/// by keys and by touch, back on the Multiplayer page it came from.
#[test]
fn sandbox_in_and_out_twice() {
    env(false, &[]);
    let mut n = Nav::new("sandbox", LANDSCAPE);
    n.settle_title(Page::Main);
    let base = n.entity_count();
    for round in 0..2 {
        n.choose(Action::Goto(Page::Play), Via::Mouse);
        n.settle_title(Page::Play);
        n.choose(Action::Goto(Page::Party), Via::Mouse);
        n.settle_title(Page::Party);
        n.choose(Action::Sandbox, Via::Mouse);
        n.until("sandbox loaded", 300, |n| n.state() == AppState::Playing && n.level().as_deref() == Some("sandbox"));
        n.run(60);
        assert!(n.world().resource::<Game>().sim.player(0).is_some(), "Pip is in the sandbox");
        n.shot(&format!("sandbox{round}"));
        // Pause, then leave for the title.
        n.key(KeyCode::Escape);
        n.until("paused", 30, |n| n.world().resource::<Game>().paused);
        n.run(40);
        n.shot("sandbox-pause");
        if round == 0 {
            // Keyboard: down to "Title Screen", Enter.
            for _ in 0..2 {
                n.hold_key(KeyCode::ArrowDown, 2);
                n.run(16);
            }
            n.key(KeyCode::Enter);
        } else {
            // Gamepad B closes the pause menu; Start opens it again.
            n.pad(GamepadButton::East);
            n.until("unpaused by B", 30, |n| !n.world().resource::<Game>().paused);
            n.pad(GamepadButton::Start);
            n.until("paused by Start", 30, |n| n.world().resource::<Game>().paused);
            n.run(40);
            n.key(KeyCode::Escape);
            n.until("unpaused by Escape", 30, |n| !n.world().resource::<Game>().paused);
            n.key(KeyCode::Escape);
            n.until("paused again", 30, |n| n.world().resource::<Game>().paused);
            n.run(40);
            // Tap "Title Screen" (third pill, 200 px under the first).
            let origin = {
                let mut q = n.app.world_mut().query_filtered::<&Transform, With<MainCamera>>();
                let t = q.single(n.app.world()).unwrap().translation;
                Vec2::new(t.x, t.y)
            };
            n.press_world(origin + Vec2::new(0.0, -100.0), Via::Touch);
        }
        // Back where it came from: the Multiplayer page.
        n.settle_title(Page::Party);
        n.key(KeyCode::Escape);
        n.settle_title(Page::Play);
        n.key(KeyCode::Escape);
        n.settle_title(Page::Main);
    }
    let after = n.entity_count();
    assert!(after <= base + 40, "entities pile up across trips: {base} → {after}");
}

/// Story: Title → Story (cutscene, hold to skip) → level → pause → title,
/// twice; the touch pause button works too.
#[test]
fn story_in_and_out_twice() {
    env(false, &[]);
    let mut n = Nav::new("story", LANDSCAPE);
    n.settle_title(Page::Main);
    for round in 0..2 {
        n.choose(Action::Goto(Page::Play), Via::Touch);
        n.settle_title(Page::Play);
        n.choose(Action::Continue, Via::Touch);
        n.until("story", 200, |n| n.state() == AppState::Story);
        n.until("intro cutscene", 300, |n| n.world().contains_resource::<bb_game::story::cutscene::Runner>() && n.world().contains_resource::<Game>());
        n.run(60);
        n.shot(&format!("cutscene{round}"));
        // Hold to skip: a key the first time, a finger the second.
        if round == 0 {
            n.hold_key(KeyCode::Space, 70);
        } else {
            n.hold_touch(Vec2::new(LANDSCAPE.x as f32 * 0.75, LANDSCAPE.y as f32 * 0.5), 70);
        }
        n.until("chapter level", 400, |n| {
            n.world().get_resource::<bb_game::story::StoryFlow>().is_some_and(|f| f.phase == bb_game::story::Phase::Level) && n.level().is_some_and(|l| l.starts_with("ch"))
        });
        n.run(90);
        n.shot(&format!("level{round}"));
        if round == 0 {
            n.key(KeyCode::Escape);
            n.until("paused", 30, |n| n.world().resource::<Game>().paused);
            n.run(40);
            n.shot("story-pause");
            for _ in 0..3 {
                n.hold_key(KeyCode::ArrowDown, 2);
                n.run(16);
            }
            n.key(KeyCode::Enter);
        } else {
            // The on-screen pause button (touch players have no Escape).
            n.press_screen(Vec2::new(LANDSCAPE.x as f32 - 50.0, 50.0), Via::Touch);
            n.until("paused by the touch button", 30, |n| n.world().resource::<Game>().paused);
            n.run(40);
            n.shot("story-pause-touch");
            for _ in 0..3 {
                n.stick(Vec2::new(0.0, -1.0));
                n.run(14);
            }
            n.pad(GamepadButton::South);
        }
        n.settle_title(Page::Main);
        assert!(!n.world().contains_resource::<bb_game::story::StoryFlow>());
    }
}

/// Party lobby in and out twice (Back tile, Escape, gamepad B), and a
/// round and back to the lobby.
#[test]
fn party_lobby_in_and_out_twice() {
    env(false, &[]);
    let mut n = Nav::new("party", LANDSCAPE);
    n.settle_title(Page::Main);
    for round in 0..2 {
        n.choose(Action::Goto(Page::Play), Via::Mouse);
        n.settle_title(Page::Play);
        n.choose(Action::Goto(Page::Party), Via::Mouse);
        n.settle_title(Page::Party);
        n.choose(Action::PartyHost, Via::Mouse);
        n.until("party lobby", 300, |n| n.state() == AppState::Party && n.level().as_deref() == Some("party_lobby"));
        n.run(120);
        n.shot(&format!("lobby{round}"));
        if round == 0 {
            // Start a round with the gamepad's Start, leave it with Escape.
            n.pad(GamepadButton::Start);
            n.until("a round", 300, |n| n.level().is_some_and(|l| l != "party_lobby") && n.world().get_resource::<bb_game::party::Party>().is_some_and(|p| !p.in_lobby()));
            n.run(60);
            n.shot("round");
            n.key(KeyCode::Escape);
            n.until("back in the lobby", 300, |n| n.level().as_deref() == Some("party_lobby"));
            n.run(90);
            n.pad(GamepadButton::East);
        } else {
            n.key(KeyCode::Escape);
        }
        n.settle_title(Page::Party);
        n.key(KeyCode::Escape);
        n.settle_title(Page::Play);
        n.key(KeyCode::Escape);
        n.settle_title(Page::Main);
    }
}

/// Join a Friend: the dialog closes with Escape and with B; a join that
/// can't connect has a way back.
#[test]
fn join_dialog_and_failed_join_have_a_way_back() {
    env(false, &[]);
    let mut n = Nav::new("join", LANDSCAPE);
    n.settle_title(Page::Main);
    n.choose(Action::Goto(Page::Play), Via::Mouse);
    n.settle_title(Page::Play);
    n.choose(Action::Goto(Page::Party), Via::Mouse);
    n.settle_title(Page::Party);
    n.choose(Action::JoinFriend, Via::Mouse);
    n.until("join dialog", 60, |n| n.world().contains_resource::<bb_game::online::JoinDialog>());
    n.run(10);
    n.shot("join-dialog");
    n.key(KeyCode::Escape);
    n.until("dialog closed by Escape", 30, |n| !n.world().contains_resource::<bb_game::online::JoinDialog>());
    assert_eq!(n.menu().unwrap().page, Page::Party, "Escape closes the dialog, not the page");
    n.choose(Action::JoinFriend, Via::Touch);
    n.until("join dialog again", 60, |n| n.world().contains_resource::<bb_game::online::JoinDialog>());
    n.pad(GamepadButton::East);
    n.until("dialog closed by B", 30, |n| !n.world().contains_resource::<bb_game::online::JoinDialog>());
    n.settle_title(Page::Party);
    // A join that can't reach anyone: waiting screen, then back out.
    n.app.world_mut().write_message(bb_game::net::NetCommand::Join { room: "ZZZZ".into(), name: "Pip".into(), color: 0xff5d73 });
    n.app.world_mut().resource_mut::<NextState<AppState>>().set(AppState::Playing);
    n.until("joining", 60, |n| n.state() == AppState::Playing);
    n.run(60);
    n.shot("joining");
    n.key(KeyCode::Escape);
    n.settle_title(Page::Party);
}

/// Kids Mode from the title and back (hold HOME), twice. Kids Mode itself
/// is another agent's; this only checks the trip.
#[test]
fn kids_in_and_out_twice() {
    env(false, &[]);
    let mut n = Nav::new("kids", LANDSCAPE);
    n.settle_title(Page::Main);
    n.choose(Action::Goto(Page::Play), Via::Mouse);
    n.settle_title(Page::Play);
    for round in 0..2 {
        n.choose(Action::Kids, Via::Mouse);
        n.until("kids world", 300, |n| n.state() == AppState::Kids && n.level().as_deref() == Some("kids-playground") && n.world().contains_resource::<bb_game::kids::Kids>());
        n.run(90);
        n.shot(&format!("kids{round}"));
        let home = n.world().resource::<bb_game::kids::Kids>().ui.iter().find(|u| u.kind == bb_game::kids::ui::UiKind::Home).map(|u| Vec2::new(u.center.x, u.center.y)).expect("HOME");
        let s = n.to_screen(home);
        n.app.world_mut().resource_mut::<Drive>().touch = Some((s, TouchPhase::Started));
        n.run(130);
        n.app.world_mut().resource_mut::<Drive>().touch = Some((s, TouchPhase::Ended));
        n.step();
        n.settle_title(Page::Play);
    }
}

/// The demo: locked tiles open their unlock page and come back; Wishlist is
/// on the title.
#[test]
fn demo_locks_and_back() {
    env(true, &[]);
    let mut n = Nav::new("demo", LANDSCAPE);
    n.settle_title(Page::Main);
    assert!(n.button(&Action::Wishlist).is_some(), "the demo title offers the wishlist");
    n.shot("main");
    n.choose(Action::Goto(Page::Play), Via::Mouse);
    n.settle_title(Page::Play);
    n.choose(Action::Goto(Page::Party), Via::Mouse);
    n.settle_title(Page::Party);
    n.shot("multiplayer");
    for lock in [Lock::Host, Lock::Sandbox] {
        n.choose(Action::Locked(lock), Via::Mouse);
        n.settle_title(Page::Unlock(lock));
        n.shot(&format!("unlock-{lock:?}"));
        n.key(KeyCode::Escape);
        n.settle_title(Page::Party);
    }
    n.choose(Action::Locked(Lock::Host), Via::Touch);
    n.settle_title(Page::Unlock(Lock::Host));
    n.pad(GamepadButton::East);
    n.settle_title(Page::Party);
}

/// The demo's end card (after chapter 2's outro) goes back to the title.
#[test]
fn demo_end_card_goes_home() {
    env(true, &[("BB_SCENE", "ch02_outro")]);
    let mut n = Nav::new("demoend", LANDSCAPE);
    n.settle_title(Page::Main);
    n.choose(Action::Goto(Page::Play), Via::Mouse);
    n.settle_title(Page::Play);
    n.choose(Action::Continue, Via::Mouse);
    n.until("outro", 300, |n| n.world().contains_resource::<bb_game::story::cutscene::Runner>());
    n.hold_key(KeyCode::Space, 70);
    n.until("demo end card", 600, |n| n.world().contains_resource::<bb_game::story::demo_end::DemoEnd>());
    n.run(150);
    n.shot("demo-end");
    n.key(KeyCode::Escape);
    n.settle_title(Page::Main);
}

/// Nothing on the title is cut off at any screen shape.
#[test]
fn title_fits_every_aspect() {
    env(true, &[]);
    for size in [UVec2::new(1920, 1080), UVec2::new(1680, 1050), UVec2::new(1440, 1080), UVec2::new(2520, 1080), UVec2::new(2532, 1170), UVec2::new(1170, 2532)] {
        let mut n = Nav::new("aspect", size);
        n.settle_title(Page::Main);
        n.shot("main");
        n.assert_tiles_on_screen(size);
        // The camera leans toward the mouse: a cursor in any corner must not
        // push the menu off screen.
        for corner in [Vec2::ZERO, Vec2::new(size.x as f32 - 1.0, 0.0), Vec2::new(0.0, size.y as f32 - 1.0), size.as_vec2() - 1.0] {
            n.drive().mouse = Some((corner, None));
            n.run(120);
            n.assert_tiles_on_screen(size);
        }
        n.choose(Action::Goto(Page::Play), Via::Mouse);
        n.settle_title(Page::Play);
        n.choose(Action::Goto(Page::Party), Via::Mouse);
        n.settle_title(Page::Party);
        n.drive().mouse = Some((Vec2::new(size.x as f32 - 1.0, size.y as f32 - 1.0), None));
        n.run(120);
        n.assert_tiles_on_screen(size);
        n.shot("multiplayer");
        n.choose(Action::Locked(Lock::Host), Via::Mouse);
        n.settle_title(Page::Unlock(Lock::Host));
        n.drive().mouse = Some((Vec2::new(size.x as f32 - 1.0, 0.0), None));
        n.run(120);
        n.assert_tiles_on_screen(size);
        n.shot("unlock");
        drop(n);
    }
}

impl Nav {
    #[track_caller]
    fn assert_tiles_on_screen(&mut self, size: UVec2) {
        let n = self;
        let (lo, hi) = {
            let mut q = n.app.world_mut().query_filtered::<(&Camera, &GlobalTransform), With<MainCamera>>();
            let (cam, tf) = q.single(n.app.world()).unwrap();
            let a = cam.viewport_to_world_2d(tf, Vec2::ZERO).unwrap();
            let b = cam.viewport_to_world_2d(tf, size.as_vec2()).unwrap();
            (a.min(b), a.max(b))
        };
        let menu = n.menu().unwrap();
        let game = n.world().resource::<Game>();
        for id in menu.buttons.iter().map(|b| b.body).chain(menu.letters.iter().copied()) {
            let b = game.sim.world.body(id).unwrap();
            let (mn, mx) = b.x.iter().fold((Vec2::splat(f32::MAX), Vec2::splat(f32::MIN)), |(a, c), p| (a.min(Vec2::new(p.x, p.y)), c.max(Vec2::new(p.x, p.y))));
            assert!(mn.x >= lo.x && mn.y >= lo.y && mx.x <= hi.x && mx.y <= hi.y, "{size}: a tile is cut off ({mn}..{mx} vs view {lo}..{hi}, page {:?})", menu.page);
        }
    }
}

// ------------------------------------------------------------ buy screen

use bb_game::buy_flow::{BuyStore, Checkout, CheckoutReply, FakeStore, Phase};
use bb_game::buy_screen::{BuyAction, BuyButton, BuyQr, BuyScreen};

impl Nav {
    /// Swap partii for a fake store (before the first frame).
    fn fake_store(&mut self, reply: CheckoutReply) -> FakeStore {
        let f = FakeStore::answering(reply);
        self.app.world_mut().insert_resource(BuyStore(std::sync::Arc::new(f.clone())));
        f
    }

    fn buy(&self) -> &BuyScreen {
        self.world().resource::<BuyScreen>()
    }

    fn buy_showing(&self) -> bool {
        matches!(self.buy().flow.phase, Phase::Showing { .. })
    }

    fn qr_shown(&mut self) -> bool {
        let mut q = self.app.world_mut().query_filtered::<(), With<BuyQr>>();
        q.iter(self.app.world()).count() > 0
    }

    /// The buy screen's buttons on show, top to bottom.
    fn buy_buttons(&mut self) -> Vec<BuyAction> {
        let mut q = self.app.world_mut().query::<(&BuyButton, &bevy::ui::UiGlobalTransform)>();
        let mut v: Vec<(f32, BuyAction)> = q.iter(self.app.world()).map(|(b, t)| (t.translation.y, b.0)).collect();
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        v.into_iter().map(|x| x.1).collect()
    }

    /// Press a buy-screen button by mouse or finger.
    #[track_caller]
    fn press_buy(&mut self, a: BuyAction, via: Via) {
        let at = {
            let mut q = self.app.world_mut().query::<(&BuyButton, &bevy::ui::UiGlobalTransform, &bevy::ui::ComputedNode)>();
            q.iter(self.app.world()).find(|(b, _, _)| b.0 == a).map(|(_, t, n)| t.translation * n.inverse_scale_factor())
        };
        let at = at.unwrap_or_else(|| panic!("[{}] no {a:?} on the buy screen", self.tag));
        self.press_screen(at, via);
    }

    /// Wait for the QR to be up (and the screen to take presses).
    #[track_caller]
    fn until_buy_showing(&mut self) {
        self.until("the buy screen's QR", 200, |n| n.buy_showing());
        self.run(40);
    }

    #[track_caller]
    fn until_buy_closed(&mut self) {
        self.until("the buy screen closed", 300, |n| !n.buy().flow.open());
    }
}

fn test_checkout() -> CheckoutReply {
    CheckoutReply::Ready(Checkout { url: "https://checkout.stripe.com/c/pay/cs_test_navsmoke#fid=abc".into(), session: "cs_test_navsmoke".into() })
}

/// The desktop demo title's "Get the Full Game" opens the buy screen (QR,
/// polling) and every device closes it: Escape, the Back button by mouse
/// and by finger, the keyboard, the pad's B.
#[test]
fn buy_screen_opens_and_closes_by_every_means() {
    env(true, &[]);
    let mut n = Nav::new("buy", LANDSCAPE);
    let fake = n.fake_store(test_checkout());
    n.settle_title(Page::Main);
    assert!(n.button(&Action::Buy).is_some(), "the desktop demo title offers the purchase");
    assert!(n.button(&Action::Wishlist).is_some(), "and still the wishlist");
    n.shot("title");
    // Mouse in.
    n.choose(Action::Buy, Via::Mouse);
    n.until_buy_showing();
    assert!(n.qr_shown(), "the checkout QR is up");
    assert_eq!(n.buy_buttons(), vec![BuyAction::PayInBrowser, BuyAction::Back]);
    assert_eq!(n.buy().flow.status(), "Waiting for payment...");
    let (ok, cancel) = fake.created()[0].clone();
    assert!(ok.ends_with("/paid") && cancel.ends_with("/cancelled"), "{ok} {cancel}");
    n.shot("buy-screen");
    // It polls while it's up (every 2.5 s: ~1 check in 3.3 s)...
    let c0 = fake.checks();
    n.run(200);
    assert!((c0 + 1..=c0 + 2).contains(&fake.checks()), "polling: {c0} -> {}", fake.checks());
    // ...the menu underneath takes no input...
    n.key(KeyCode::ArrowDown);
    assert_eq!(n.menu().unwrap().page, Page::Main);
    // "Pay in browser" keeps the screen up (headless: logged, not opened).
    n.press_buy(BuyAction::PayInBrowser, Via::Mouse);
    n.run(10);
    assert!(n.buy_showing());
    // Escape closes it, and only it.
    n.key(KeyCode::Escape);
    n.until_buy_closed();
    n.run(30);
    assert_eq!((n.state(), n.menu().unwrap().page), (AppState::Title, Page::Main), "Escape closed the buy screen, not the page");
    let c1 = fake.checks();
    n.run(400);
    assert_eq!(fake.checks(), c1, "no polling once closed");
    n.settle_title(Page::Main);
    // Keyboard in; down to Back, Enter.
    n.choose_by_keys(Action::Buy);
    n.until_buy_showing();
    n.hold_key(KeyCode::ArrowDown, 2);
    n.run(4);
    n.key(KeyCode::Enter);
    n.until_buy_closed();
    n.settle_title(Page::Main);
    // Pad in, B out.
    n.choose_by_pad(Action::Buy);
    n.until_buy_showing();
    n.pad(GamepadButton::East);
    n.until_buy_closed();
    n.settle_title(Page::Main);
    // Finger in, Back tapped.
    n.choose(Action::Buy, Via::Touch);
    n.until_buy_showing();
    n.press_buy(BuyAction::Back, Via::Touch);
    n.until_buy_closed();
    n.settle_title(Page::Main);
    // Mouse in, Back clicked.
    n.choose(Action::Buy, Via::Mouse);
    n.until_buy_showing();
    n.press_buy(BuyAction::Back, Via::Mouse);
    n.until_buy_closed();
    n.settle_title(Page::Main);
    assert!(n.button(&Action::Buy).is_some(), "still the demo");
}

/// Host locked → unlock page → Get the Full Game → paid on the phone →
/// "Thanks!" → back on Multiplayer with Host unlocked, no restart.
#[test]
fn paying_on_the_phone_unlocks_host_live() {
    env(true, &[]);
    let mut n = Nav::new("buypaid", LANDSCAPE);
    let fake = n.fake_store(test_checkout());
    n.settle_title(Page::Main);
    n.choose(Action::Goto(Page::Play), Via::Mouse);
    n.settle_title(Page::Play);
    n.choose(Action::Goto(Page::Party), Via::Mouse);
    n.settle_title(Page::Party);
    n.choose(Action::Locked(Lock::Host), Via::Mouse);
    n.settle_title(Page::Unlock(Lock::Host));
    n.choose_by_pad(Action::Buy);
    n.until_buy_showing();
    n.shot("buy-from-unlock");
    // The phone pays; the next check hears it.
    fake.pay();
    n.until("paid", 200, |n| matches!(n.buy().flow.phase, Phase::Paid { .. }));
    n.run(30);
    n.shot("paid");
    assert!(n.world().resource::<bb_game::ownership::Ownership>().full(), "unlocked at once");
    n.until_buy_closed();
    n.settle_title(Page::Party);
    assert!(n.button(&Action::PartyHost).is_some(), "Host with Phones is unlocked");
    assert!(n.button(&Action::Sandbox).is_some(), "Sandbox too");
    n.shot("unlocked");
    // The title stops selling it.
    n.key(KeyCode::Escape);
    n.settle_title(Page::Play);
    n.key(KeyCode::Escape);
    n.settle_title(Page::Main);
    assert!(n.button(&Action::Buy).is_none() && n.button(&Action::Wishlist).is_none());
    // And Host really starts.
    n.choose(Action::Goto(Page::Play), Via::Mouse);
    n.settle_title(Page::Play);
    n.choose(Action::Goto(Page::Party), Via::Mouse);
    n.settle_title(Page::Party);
    n.choose(Action::PartyHost, Via::Mouse);
    n.until("party lobby", 300, |n| n.state() == AppState::Party);
}

/// Streamer mode hides the checkout QR (Pay in browser stays); "Show QR
/// code" reveals it for this visit only.
#[test]
fn streamer_mode_hides_the_checkout_qr() {
    env(true, &[("BB_STREAMER", "1")]);
    let mut n = Nav::new("buystreamer", LANDSCAPE);
    n.fake_store(test_checkout());
    n.settle_title(Page::Main);
    n.choose(Action::Buy, Via::Mouse);
    n.until_buy_showing();
    assert!(!n.qr_shown(), "no QR on stream");
    assert_eq!(n.buy_buttons(), vec![BuyAction::PayInBrowser, BuyAction::Reveal, BuyAction::Back]);
    n.shot("streamer");
    n.press_buy(BuyAction::Reveal, Via::Mouse);
    n.run(20);
    assert!(n.qr_shown(), "revealed");
    n.run(30);
    n.shot("streamer-revealed");
    n.key(KeyCode::Escape);
    n.until_buy_closed();
    n.settle_title(Page::Main);
    n.choose(Action::Buy, Via::Mouse);
    n.until_buy_showing();
    assert!(!n.qr_shown(), "hidden again next time");
    n.key(KeyCode::Escape);
    n.until_buy_closed();
}

/// No network: a clear message and Retry; a 409 "owned" unlocks.
#[test]
fn buy_screen_offline_retry_and_already_owned() {
    env(true, &[]);
    let mut n = Nav::new("buyoffline", LANDSCAPE);
    let fake = n.fake_store(CheckoutReply::Offline);
    n.settle_title(Page::Main);
    n.choose(Action::Buy, Via::Mouse);
    n.until("offline", 200, |n| n.buy().flow.phase == Phase::Offline);
    n.run(40);
    assert_eq!(n.buy_buttons(), vec![BuyAction::Retry, BuyAction::Back]);
    assert!(n.buy().flow.status().contains("Retry"));
    n.shot("offline");
    // Back online: Retry (focused first) with Enter.
    fake.set_reply(test_checkout());
    n.key(KeyCode::Enter);
    n.until_buy_showing();
    assert!(n.qr_shown());
    n.key(KeyCode::Escape);
    n.until_buy_closed();
    n.settle_title(Page::Main);
    // Bought on another device: 409 owned → refresh → unlocked.
    fake.set_reply(CheckoutReply::AlreadyOwned);
    n.choose(Action::Buy, Via::Mouse);
    n.until("owned", 300, |n| matches!(n.buy().flow.phase, Phase::Paid { .. }));
    n.until_buy_closed();
    n.settle_title(Page::Main);
    assert!(n.world().resource::<bb_game::ownership::Ownership>().full());
    assert!(n.button(&Action::Buy).is_none());
}

/// The demo's end card: Get the Full Game opens the buy screen over it;
/// Escape closes only the screen; the card still goes home.
#[test]
fn demo_end_card_opens_the_buy_screen() {
    env(true, &[("BB_SCENE", "ch02_outro")]);
    let mut n = Nav::new("buyend", LANDSCAPE);
    n.fake_store(test_checkout());
    n.settle_title(Page::Main);
    n.choose(Action::Goto(Page::Play), Via::Mouse);
    n.settle_title(Page::Play);
    n.choose(Action::Continue, Via::Mouse);
    n.until("outro", 300, |n| n.world().contains_resource::<bb_game::story::cutscene::Runner>());
    n.hold_key(KeyCode::Space, 70);
    n.until("demo end card", 600, |n| n.world().contains_resource::<bb_game::story::demo_end::DemoEnd>());
    n.run(150);
    // The card's first button (focused) is Get the Full Game.
    n.key(KeyCode::Enter);
    n.until_buy_showing();
    n.shot("demo-end-buy");
    n.key(KeyCode::Escape);
    n.until_buy_closed();
    n.run(30);
    assert_eq!(n.state(), AppState::Story, "Escape closed the buy screen, not the card");
    assert!(n.world().contains_resource::<bb_game::story::demo_end::DemoEnd>());
    n.key(KeyCode::Escape);
    n.settle_title(Page::Main);
}

/// Counts the entitlement checks of the store it wraps.
struct Counting(Box<dyn bb_game::buy_flow::StoreBackend>, std::sync::Arc<std::sync::atomic::AtomicU32>);

impl bb_game::buy_flow::StoreBackend for Counting {
    fn create_checkout(&self, ok: &str, cancel: &str) {
        self.0.create_checkout(ok, cancel)
    }
    fn take_checkout(&self) -> Option<CheckoutReply> {
        self.0.take_checkout()
    }
    fn check_owned(&self) {
        self.1.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.0.check_owned()
    }
    fn owned(&self) -> bool {
        self.0.owned()
    }
}

/// Manual: the real partii store against STAGING with a fresh guest player
/// (a scratch HOME). Makes a real Stripe test checkout, shows its QR and
/// polls; never pays. Run with the staging edge and key in the env:
///
/// ```text
/// set -a; . ~/.config/partii/bouncy-blobs-game.env; set +a
/// BB_PARTII_API=$PARTII_API BB_PARTII_KEY=$PARTII_KEY BB_NAV_SHOTS=/tmp/shots \
///   cargo nextest run -p bb-game --test nav_smoke --run-ignored only -E 'test(staging)'
/// ```
#[test]
#[ignore = "talks to partii staging"]
fn staging_checkout_shows_a_real_qr_and_polls() {
    let api = std::env::var("BB_PARTII_API").expect("BB_PARTII_API (staging)");
    assert!(api.contains("staging"), "staging only");
    assert!(std::env::var("BB_PARTII_KEY").is_ok_and(|k| k.starts_with("pk_")), "BB_PARTII_KEY (staging publishable key)");
    let home = std::env::temp_dir().join(format!("bb-buy-staging-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&home);
    // SAFETY: before the app starts.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_DATA_HOME", home.join("data"));
        std::env::set_var("BB_SHOT", home.join("unused.png"));
        std::env::set_var("BB_SHOT_FRAME", "4000000000");
        std::env::set_var("BB_MUTE", "1");
        std::env::set_var("BB_DEMO", "1");
    }
    let mut n = Nav::new("staging", LANDSCAPE);
    let checks = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    n.app.world_mut().insert_resource(BuyStore(std::sync::Arc::new(Counting(Box::new(bb_game::buy_flow::PartiiStore::default()), checks.clone()))));
    n.settle_title(Page::Main);
    // Wait for the new guest to sign in.
    n.until("signed in to staging", 1800, |_| bb_game::account::get().is_some_and(|a| a.ready()));
    let player = bb_game::account::get().and_then(|a| a.player_id()).unwrap_or_default();
    n.choose(Action::Buy, Via::Mouse);
    n.until("a real checkout", 1800, |n| n.buy().flow.open() && !matches!(n.buy().flow.phase, Phase::Creating));
    let phase = n.buy().flow.phase.clone();
    let Phase::Showing { checkout, .. } = phase else { panic!("no checkout: {phase:?} ({})", n.buy().flow.status()) };
    assert!(checkout.url.starts_with("https://checkout.stripe.com/"), "a Stripe-hosted checkout");
    assert!(checkout.session.starts_with("cs_test_"), "Stripe test mode");
    n.run(40);
    assert!(n.qr_shown(), "QR up");
    n.shot("staging-qr");
    let c0 = checks.load(std::sync::atomic::Ordering::Relaxed);
    n.run(60 * 8);
    let c1 = checks.load(std::sync::atomic::Ordering::Relaxed);
    assert!(c1 >= c0 + 3, "polling every 2.5 s: {c0} -> {c1}");
    assert!(n.buy_showing(), "still waiting for payment");
    println!("STAGING OK: guest {player}, session {}, {} checks in 8 s, QR shown", checkout.session, c1 - c0);
    n.key(KeyCode::Escape);
    n.until_buy_closed();
}
