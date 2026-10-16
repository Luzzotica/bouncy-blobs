//! Local input → per-slot `Input`.
//!
//! * Slot 0: keyboard (A/D or ←/→ to roll, W/↑/Space/Z to expand) **or**
//!   touch (left half = the fixed square pad, right half = button). The pad
//!   is the phone controller's square + band layout ([`shape_pad`]).
//! * Gamepads take slots 1, 2, 3… (or slot 0 if no keyboard/touch player).
//! * Phone controllers (bb-net) write their slots directly into `Inputs`.

use bb_sim::{Input, Vec2 as PVec2};
use bevy::input::gamepad::{Gamepad, GamepadAxis, GamepadButton};
use bevy::input::touch::Touches;
use bevy::prelude::*;

use crate::sim::Inputs;

/// Which local slots are driven by local devices (vs phones / network).
#[derive(Resource, Clone)]
pub struct LocalDevices {
    pub keyboard_slot: Option<u8>,
    pub touch_slot: Option<u8>,
    /// Gamepad entity → slot.
    pub pads: Vec<(Entity, u8)>,
}

impl Default for LocalDevices {
    fn default() -> Self {
        LocalDevices { keyboard_slot: Some(0), touch_slot: Some(0), pads: Vec::new() }
    }
}

/// Horizontal deadzone before the pad snaps to ±1 (`DEADZONE_X` in
/// web-controller/src/lib/joystickInput.ts).
pub const PAD_DEADZONE_X: f32 = 0.15;
/// Half-height of the pad's neutral left/right band (`BAND_HALF`).
pub const PAD_BAND_HALF: f32 = 0.3;

/// The phone controller's square + band shaping (`shapeJoystickInput`).
///
/// `dx`/`dy` are the touch offset from the pad centre normalised by its
/// half-size, **screen y down**. Horizontal snaps to ±1 past the deadzone in
/// every zone; vertical is three zones: inside the band → 0, above → -1
/// (up), below → +1 (down). Returns the same screen-y-down convention.
pub fn shape_pad(dx: f32, dy: f32) -> (f32, f32) {
    let x = if dx.abs() <= PAD_DEADZONE_X { 0.0 } else { dx.signum() };
    let y = if dy < -PAD_BAND_HALF {
        -1.0
    } else if dy > PAD_BAND_HALF {
        1.0
    } else {
        0.0
    };
    (x, y)
}

/// Where the fixed touch pad and the expand button sit, in logical px
/// (screen y down) for a window of `size`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PadLayout {
    pub center: Vec2,
    /// Half the pad's side.
    pub half: f32,
    pub button_center: Vec2,
    pub button_radius: f32,
}

/// Lay the pad out bottom-left and the button bottom-right, clear of the
/// notch / rounded corners ([`crate::platform::SAFE_SIDE`]) and the home
/// indicator ([`crate::platform::SAFE_BOTTOM`]).
pub fn pad_layout(size: Vec2) -> PadLayout {
    use crate::platform::{SAFE_BOTTOM, SAFE_SIDE};
    let short = size.x.min(size.y);
    let half = (short * 0.2).clamp(64.0, 130.0);
    let margin = (short * 0.06).clamp(18.0, 48.0);
    let y = size.y - SAFE_BOTTOM - margin - half;
    let button_radius = half * 0.8;
    PadLayout {
        center: Vec2::new(SAFE_SIDE + margin + half, y),
        half,
        button_center: Vec2::new(size.x - SAFE_SIDE - margin - half, y),
        button_radius,
    }
}

/// Touch pad state, for drawing.
#[derive(Resource, Default)]
pub struct TouchPad {
    /// The touch that owns the pad (it started on the left half).
    pub pad_id: Option<u64>,
    /// Thumb offset from the pad centre, normalised and clamped per axis
    /// (screen y down). Zero when untouched.
    pub thumb: Vec2,
    /// Shaped output (screen y down), see [`shape_pad`].
    pub out: Vec2,
    pub button: bool,
}

/// The kind of device the player last touched, so tutorial tips can name
/// the right control ("press Space" vs "tap the right side").
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LastDevice {
    Keyboard,
    Touch,
    Gamepad,
    /// A phone used as a controller (party / co-op).
    Phone,
}

impl Default for LastDevice {
    fn default() -> Self {
        if crate::platform::IS_MOBILE { LastDevice::Touch } else { LastDevice::Keyboard }
    }
}

/// Fill control placeholders in a tip for `device`. Lower-case names give a
/// phrase to use mid-sentence; capitalise the first letter (`{Jump}`) to
/// start a sentence with it.
///
/// * `{jump}` – press the jump/swell button ("press Space")
/// * `{hold}` – hold the jump/swell button ("hold Space")
/// * `{button}` – the button's name ("Space")
/// * `{move}` – the rolling controls ("the arrow keys (or A and D)")
/// * `{down}` – squish down ("press Down (or S)")
/// * `{updown}` – climb ("Up and Down (or W and S)")
pub fn control_text(text: &str, device: LastDevice) -> String {
    use LastDevice::*;
    let phrase = |key: &str| -> Option<&'static str> {
        Some(match (key, device) {
            ("jump", Keyboard) => "press Space",
            ("jump", Touch) => "tap the right side of the screen",
            ("jump", Gamepad) => "press A",
            ("jump", Phone) => "press the big button on your phone",
            ("hold", Keyboard) => "hold Space",
            ("hold", Touch) => "hold a finger on the right side of the screen",
            ("hold", Gamepad) => "hold A",
            ("hold", Phone) => "hold the big button on your phone",
            ("button", Keyboard) => "Space",
            ("button", Touch) => "a tap on the right side",
            ("button", Gamepad) => "A",
            ("button", Phone) => "the big button",
            ("move", Keyboard) => "the arrow keys (or A and D)",
            ("move", Touch) => "the square pad on the left",
            ("move", Gamepad) => "the left stick",
            ("move", Phone) => "your phone's joystick",
            ("down", Keyboard) => "press Down (or S)",
            ("down", Touch) => "press the bottom of the pad",
            ("down", Gamepad) => "push the left stick down",
            ("down", Phone) => "push your phone's joystick down",
            ("updown", Keyboard) => "Up and Down (or W and S)",
            ("updown", Touch) => "the top and bottom of the pad",
            ("updown", Gamepad) => "the left stick, up and down",
            ("updown", Phone) => "your phone's joystick, up and down",
            _ => return None,
        })
    };
    let mut out = String::with_capacity(text.len() + 16);
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let name = &after[..close];
        let cap = name.chars().next().is_some_and(|c| c.is_uppercase());
        match phrase(&name.to_lowercase()) {
            Some(p) if cap => {
                let mut c = p.chars();
                if let Some(f) = c.next() {
                    out.extend(f.to_uppercase());
                    out.push_str(c.as_str());
                }
            }
            Some(p) => out.push_str(p),
            None => out.push_str(&rest[open..open + close + 2]),
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

/// Slots claimed by phone/network players this frame (don't overwrite).
#[derive(Resource, Default)]
pub struct RemoteSlots(pub [bool; 16]);

pub struct InputPlugin;

impl Plugin for InputPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<LocalDevices>()
            .init_resource::<TouchPad>()
            .init_resource::<RemoteSlots>()
            .init_resource::<LastDevice>()
            .add_plugins(crate::touch_pad::TouchPadPlugin)
            .add_systems(PreUpdate, gather.in_set(GatherInput).after(bevy::input::InputSystems));
    }
}

#[derive(SystemSet, Clone, Debug, PartialEq, Eq, Hash)]
pub struct GatherInput;

impl InputPlugin {
    pub fn gather_set() -> GatherInput {
        GatherInput
    }
}

fn gather(
    keys: Res<ButtonInput<KeyCode>>,
    pads: Query<(Entity, &Gamepad)>,
    touches: Res<Touches>,
    windows: Query<&Window>,
    mut devices: ResMut<LocalDevices>,
    mut pad: ResMut<TouchPad>,
    remote: Res<RemoteSlots>,
    mut inputs: ResMut<Inputs>,
    mut last: ResMut<LastDevice>,
) {
    let mut used: Option<LastDevice> = None;
    if remote.0.iter().enumerate().any(|(s, r)| *r && (inputs.slots[s].button || inputs.slots[s].stick.length() > 0.3)) {
        used = Some(LastDevice::Phone);
    }
    for s in 0..16 {
        if !remote.0[s] {
            inputs.slots[s] = Input::default();
            inputs.active[s] = false;
        }
    }

    if let Some(slot) = devices.keyboard_slot {
        let mut x = 0.0;
        let mut y = 0.0;
        if keys.any_pressed([KeyCode::KeyA, KeyCode::ArrowLeft]) {
            x -= 1.0;
        }
        if keys.any_pressed([KeyCode::KeyD, KeyCode::ArrowRight]) {
            x += 1.0;
        }
        if keys.any_pressed([KeyCode::KeyW, KeyCode::ArrowUp]) {
            y += 1.0;
        }
        if keys.any_pressed([KeyCode::KeyS, KeyCode::ArrowDown]) {
            y -= 1.0;
        }
        let button = keys.any_pressed([KeyCode::Space, KeyCode::KeyZ, KeyCode::KeyJ]);
        let i = &mut inputs.slots[slot as usize];
        i.stick = PVec2::new(x, y);
        i.button |= button;
        if x != 0.0 || y != 0.0 || button {
            inputs.active[slot as usize] = true;
        }
    }
    if keys.get_just_pressed().next().is_some() {
        used = Some(LastDevice::Keyboard);
    }
    if touches.iter_just_pressed().next().is_some() {
        used = Some(LastDevice::Touch);
    }

    // Touch: a touch that starts on the left half drives the fixed square
    // pad (measured from the pad's centre wherever the finger goes); any
    // touch that starts on the right half is the button.
    if let Some(slot) = devices.touch_slot {
        let size = windows.iter().next().map_or(Vec2::new(1000.0, 600.0), |w| w.size());
        let layout = pad_layout(size);
        let mut button = false;
        let mut pad_touch = None;
        for t in touches.iter() {
            if t.start_position().x < size.x * 0.5 {
                if pad.pad_id.is_none() {
                    pad.pad_id = Some(t.id());
                }
                if pad.pad_id == Some(t.id()) {
                    pad_touch = Some(t.position());
                }
            } else {
                button = true;
            }
        }
        if pad_touch.is_none() {
            pad.pad_id = None;
        }
        pad.button = button;
        match pad_touch {
            Some(p) => {
                let d = (p - layout.center) / layout.half;
                pad.thumb = d.clamp(Vec2::splat(-1.0), Vec2::splat(1.0));
                let (x, y) = shape_pad(d.x, d.y);
                pad.out = Vec2::new(x, y);
                // Screen y is down; the sim's stick y is up.
                inputs.slots[slot as usize].stick += PVec2::new(x, -y);
                inputs.active[slot as usize] = true;
            }
            None => {
                pad.thumb = Vec2::ZERO;
                pad.out = Vec2::ZERO;
            }
        }
        if button {
            inputs.slots[slot as usize].button = true;
            inputs.active[slot as usize] = true;
        }
    }

    // Gamepads: assign new pads to the next free slot.
    for (e, _) in pads.iter() {
        if !devices.pads.iter().any(|(pe, _)| *pe == e) {
            let used: Vec<u8> = devices.pads.iter().map(|p| p.1).collect();
            let slot = (1..8u8).find(|s| !used.contains(s)).unwrap_or(7);
            devices.pads.push((e, slot));
        }
    }
    devices.pads.retain(|(e, _)| pads.get(*e).is_ok());
    for (e, slot) in devices.pads.clone() {
        let Ok((_, pad)) = pads.get(e) else { continue };
        let mut x = pad.get(GamepadAxis::LeftStickX).unwrap_or(0.0);
        let mut y = pad.get(GamepadAxis::LeftStickY).unwrap_or(0.0);
        if pad.pressed(GamepadButton::DPadLeft) {
            x = -1.0;
        }
        if pad.pressed(GamepadButton::DPadRight) {
            x = 1.0;
        }
        if pad.pressed(GamepadButton::DPadUp) {
            y = 1.0;
        }
        if pad.pressed(GamepadButton::DPadDown) {
            y = -1.0;
        }
        let x = if x.abs() < 0.2 { 0.0 } else { x };
        let y = if y.abs() < 0.3 { 0.0 } else { y };
        let button = pad.any_pressed([GamepadButton::South, GamepadButton::East, GamepadButton::RightTrigger]);
        if button || x != 0.0 || y != 0.0 || pad.get_just_pressed().next().is_some() {
            used = Some(LastDevice::Gamepad);
        }
        let i = &mut inputs.slots[slot as usize];
        i.stick = PVec2::new(x, y);
        i.button = button;
        if x != 0.0 || y != 0.0 || button {
            inputs.active[slot as usize] = true;
        }
    }
    if let Some(d) = used {
        if *last != d {
            *last = d;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tips_name_the_real_control() {
        let tip = "{Jump} to hop. {Hold} to swell. Roll with {move}.";
        assert_eq!(control_text(tip, LastDevice::Keyboard), "Press Space to hop. Hold Space to swell. Roll with the arrow keys (or A and D).");
        assert_eq!(control_text(tip, LastDevice::Gamepad), "Press A to hop. Hold A to swell. Roll with the left stick.");
        assert_eq!(
            control_text(tip, LastDevice::Touch),
            "Tap the right side of the screen to hop. Hold a finger on the right side of the screen to swell. Roll with the square pad on the left."
        );
        // Unknown names and stray braces pass through untouched.
        assert_eq!(control_text("a {nope} b {", LastDevice::Keyboard), "a {nope} b {");
        assert_eq!(control_text("no placeholders", LastDevice::Phone), "no placeholders");
    }

    /// Mirrors web-controller/src/lib/joystickInput.ts `shapeJoystickInput`.
    #[test]
    fn pad_shaping_matches_the_phone_controller() {
        // Dead centre and inside the horizontal deadzone: nothing.
        assert_eq!(shape_pad(0.0, 0.0), (0.0, 0.0));
        assert_eq!(shape_pad(0.15, 0.0), (0.0, 0.0));
        assert_eq!(shape_pad(-0.15, 0.3), (0.0, 0.0));
        // Past the deadzone horizontal snaps straight to ±1 (no ramp).
        assert_eq!(shape_pad(0.16, 0.0), (1.0, 0.0));
        assert_eq!(shape_pad(-0.2, 0.0), (-1.0, 0.0));
        assert_eq!(shape_pad(-3.0, 0.1), (-1.0, 0.0));
        // The band edges are inclusive: still pure left/right.
        assert_eq!(shape_pad(1.0, -0.3), (1.0, 0.0));
        assert_eq!(shape_pad(1.0, 0.3), (1.0, 0.0));
        // Above the band is up (-1, screen y down), below is down; horizontal
        // stays live so diagonals work like a keyboard.
        assert_eq!(shape_pad(0.0, -0.31), (0.0, -1.0));
        assert_eq!(shape_pad(0.0, 0.31), (0.0, 1.0));
        assert_eq!(shape_pad(-0.5, -0.9), (-1.0, -1.0));
        assert_eq!(shape_pad(0.5, 5.0), (1.0, 1.0));
    }

    #[test]
    fn pad_fits_phones_and_ipads() {
        // iPhone 17 landscape, iPad Pro 13" landscape, iPad 4:3, desktop.
        for size in [Vec2::new(874.0, 402.0), Vec2::new(1376.0, 1032.0), Vec2::new(1024.0, 768.0), Vec2::new(1600.0, 900.0)] {
            let l = pad_layout(size);
            let left = l.center.x - l.half;
            let bottom = l.center.y + l.half;
            assert!(left >= crate::platform::SAFE_SIDE, "{size}: pad clipped left");
            assert!(bottom <= size.y - crate::platform::SAFE_BOTTOM, "{size}: pad under the home bar");
            // Pad and button stay in their own halves (the touch split).
            assert!(l.center.x + l.half < size.x * 0.5, "{size}: pad crosses the middle");
            assert!(l.button_center.x - l.button_radius > size.x * 0.5, "{size}: button crosses the middle");
            assert!(l.button_center.x + l.button_radius <= size.x - crate::platform::SAFE_SIDE);
            // A thumb-sized pad: big enough to find, not a quarter of the screen.
            assert!(l.half >= 64.0 && l.half <= 130.0);
        }
    }
}
