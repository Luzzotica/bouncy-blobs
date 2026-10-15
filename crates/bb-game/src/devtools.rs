//! Developer hooks for automated visual checks.
//!
//! * `BB_SHOT=/path.png` — save a screenshot after `BB_SHOT_FRAME` frames
//!   (default 150) and exit. `BB_SHOT_COUNT=n BB_SHOT_EVERY=k` saves a
//!   flipbook of n shots k frames apart.
//! * `BB_AUTOPLAY=1` — slot 0 holds right and jumps every second.
//! * `BB_AMOEBA=frame:deg,…` — feed player 1 an amoeba from a side (ink.rs).
//! * `BB_START=kids` — boot straight into Kids Mode (skips the sandbox).
//! * `BB_PRESS=...` — scripted keys (see [`PressItem`]). In capture mode
//!   (`crate::capture`) the numbers are sim ticks (1/60 s of game time), so
//!   a script means the same thing at any capture speed.

use bevy::prelude::*;
use bevy::render::view::screenshot::{Screenshot, save_to_disk};

use crate::sim::Inputs;

pub struct DevToolsPlugin;

impl Plugin for DevToolsPlugin {
    fn build(&self, app: &mut App) {
        if std::env::var("BB_SHOT").is_ok() {
            // A headless capture run sets up its own offscreen target.
            if !crate::capture::config().is_some_and(|c| c.headless()) {
                app.add_systems(PostStartup, offscreen);
            }
            app.add_systems(Update, shoot);
        }
        if std::env::var("BB_PRESS").is_ok() {
            app.add_systems(PreUpdate, press.after(bevy::input::InputSystems));
        }
        if std::env::var("BB_POP").is_ok() {
            app.add_systems(Update, dev_pop);
        }
        if std::env::var("BB_AMOEBA").is_ok() {
            app.add_systems(Update, crate::ink::dev_amoeba);
        }
        if std::env::var("BB_AUTOPLAY").is_ok() {
            app.add_systems(PreUpdate, autoplay.after(crate::input::InputPlugin::gather_set()));
        }
    }
}

/// Offscreen target for screenshots: renders even when the display is
/// asleep or the session is locked (windows aren't presented then).
#[derive(Resource)]
struct ShotTarget(Handle<Image>);

fn offscreen(
    mut commands: Commands,
    mut images: ResMut<Assets<Image>>,
    cams: Query<Entity, With<crate::camera::MainCamera>>,
) {
    use bevy::camera::RenderTarget;
    use bevy::render::render_resource::TextureFormat;
    // Capture mode picks the size (and keeps the screen clean: no UI camera).
    let size = crate::capture::config().map_or(UVec2::new(1920, 1080), |c| c.size);
    let image = Image::new_target_texture(size.x, size.y, TextureFormat::Rgba8UnormSrgb, None);
    let handle = images.add(image);
    for cam in cams.iter() {
        commands.entity(cam).insert(RenderTarget::Image(handle.clone().into()));
        // UI too: make this camera the UI's camera explicitly (otherwise
        // the UI looks for a window camera and the shots have no HUD).
        if !crate::capture::on() {
            commands.entity(cam).insert(bevy::ui::IsDefaultUiCamera);
        }
    }
    commands.insert_resource(ShotTarget(handle));
}

fn shoot(mut commands: Commands, mut frame: Local<u32>, mut exit: MessageWriter<AppExit>, target: Option<Res<ShotTarget>>, time: Res<Time>) {
    *frame += 1;
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|s| s.parse().ok()).unwrap_or(d);
    let at = env("BB_SHOT_FRAME", 150);
    // `BB_SHOT_COUNT=n BB_SHOT_EVERY=k`: n shots k frames apart, saved as
    // `<stem>_<i>.png` (a cheap flipbook for checking animation).
    let count = env("BB_SHOT_COUNT", 1).max(1);
    let every = env("BB_SHOT_EVERY", 5).max(1);
    let last = at + (count - 1) * every;
    if *frame >= at && *frame <= last && (*frame - at) % every == 0 {
        let path = std::env::var("BB_SHOT").unwrap();
        let path = if count > 1 {
            let i = (*frame - at) / every;
            match path.rsplit_once('.') {
                Some((stem, ext)) => format!("{stem}_{i:02}.{ext}"),
                None => format!("{path}_{i:02}"),
            }
        } else {
            path
        };
        info!("BB_SHOT frame {} at {:.2}s", *frame, time.elapsed_secs());
        let shot = match &target {
            Some(t) => Screenshot::image(t.0.clone()),
            None => Screenshot::primary_window(),
        };
        commands.spawn(shot).observe(save_to_disk(path));
    }
    if *frame == last + 20 {
        exit.write(AppExit::Success);
    }
}

fn autoplay(time: Res<Time>, mut inputs: ResMut<Inputs>) {
    let t = time.elapsed_secs();
    inputs.slots[0].stick.x = 1.0;
    inputs.slots[0].button = t.fract() < 0.35;
}

/// `BB_POP=n` pops player 1 on frame n (to look at pop effects).
fn dev_pop(game: Option<ResMut<crate::sim::Game>>, mut frame: Local<u32>) {
    *frame += 1;
    let Some(n) = std::env::var("BB_POP").ok().and_then(|v| v.parse::<u32>().ok()) else { return };
    if *frame == n {
        if let Some(mut g) = game {
            if let Some(id) = g.sim.player(0).map(|p| p.ctl.body) {
                g.sim.pop(id);
            }
        }
    }
}

/// One `BB_PRESS` item, `key@when`:
/// * `key@f` taps on frame f; `key@a-b` holds from a to b; `key@a-` holds
///   from a on;
/// * `key@every:P:H[:from[:to]]` holds for H frames every P frames (from
///   `from`, default 0, until `to`), e.g. `space@every:40:12:30` bounces.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PressItem {
    pub key: KeyCode,
    pub from: u32,
    pub to: u32,
    /// (period, hold) for repeating presses.
    pub every: Option<(u32, u32)>,
}

impl PressItem {
    pub fn parse(item: &str) -> Option<PressItem> {
        let (k, f) = item.trim().split_once('@')?;
        let key = match k {
            "escape" => KeyCode::Escape,
            "enter" => KeyCode::Enter,
            "space" => KeyCode::Space,
            "down" => KeyCode::ArrowDown,
            "right" => KeyCode::ArrowRight,
            "left" => KeyCode::ArrowLeft,
            "up" => KeyCode::ArrowUp,
            _ => return None,
        };
        if let Some(rest) = f.strip_prefix("every:") {
            let n: Vec<u32> = rest.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
            let (period, hold) = (*n.first()?, *n.get(1)?);
            return Some(PressItem { key, from: n.get(2).copied().unwrap_or(0), to: n.get(3).copied().unwrap_or(u32::MAX), every: Some((period.max(1), hold)) });
        }
        let (from, to) = match f.split_once('-') {
            Some((a, "")) => (a.parse().ok()?, u32::MAX),
            Some((a, b)) => (a.parse().ok()?, b.parse().ok()?),
            None => {
                let a = f.parse().ok()?;
                (a, a)
            }
        };
        Some(PressItem { key, from, to, every: None })
    }

    /// Is the key held on frame `f`?
    pub fn held(&self, f: u32) -> bool {
        if f < self.from || f > self.to {
            return false;
        }
        match self.every {
            Some((period, hold)) => (f - self.from) % period < hold,
            None => true,
        }
    }
}

pub fn parse_press(spec: &str) -> Vec<PressItem> {
    spec.split(',').filter_map(PressItem::parse).collect()
}

/// `BB_PRESS=escape@60,enter@90,right@30-,space@every:40:12` drives keys.
fn press(mut keys: ResMut<ButtonInput<KeyCode>>, mut frame: Local<u32>, mut ours: Local<Vec<KeyCode>>, vtime: Res<Time<Virtual>>) {
    *frame += 1;
    // Capture mode: sim ticks, so scripts are speed-independent.
    let f = if crate::capture::config().is_some_and(|c| c.headless()) { crate::capture::press_tick(&vtime) } else { *frame };
    let items = parse_press(&std::env::var("BB_PRESS").unwrap_or_default());
    let mut want: Vec<KeyCode> = items.iter().filter(|i| i.held(f)).map(|i| i.key).collect();
    want.dedup();
    for k in ours.iter() {
        if !want.contains(k) {
            keys.release(*k);
        }
    }
    for k in &want {
        keys.press(*k);
    }
    *ours = want;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn press_specs() {
        let tap = PressItem::parse("enter@90").unwrap();
        assert!(!tap.held(89) && tap.held(90) && !tap.held(91));
        let hold = PressItem::parse("right@10-20").unwrap();
        assert!(hold.held(10) && hold.held(20) && !hold.held(21));
        let open = PressItem::parse("right@30-").unwrap();
        assert!(!open.held(29) && open.held(100_000));
        let bounce = PressItem::parse("space@every:40:12:30").unwrap();
        assert_eq!(bounce.key, KeyCode::Space);
        assert!(!bounce.held(29) && bounce.held(30) && bounce.held(41) && !bounce.held(42) && bounce.held(70));
        let capped = PressItem::parse("space@every:40:12:0:100").unwrap();
        assert!(capped.held(80) && !capped.held(120));
        assert!(PressItem::parse("jump@3").is_none());
        assert!(PressItem::parse("space@every:x").is_none());
        assert_eq!(parse_press("right@1-,space@every:40:12,bogus").len(), 2);
    }
}
