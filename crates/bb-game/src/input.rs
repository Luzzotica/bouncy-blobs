//! Local input → per-slot `Input`.
//!
//! * Slot 0: keyboard (A/D or ←/→ to roll, W/↑/Space/Z to expand) **or**
//!   touch (left half = floating stick, right half = button).
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

/// Floating touch stick state, for drawing.
#[derive(Resource, Default)]
pub struct TouchStick {
    pub origin: Option<Vec2>,
    pub current: Vec2,
    pub button: bool,
    pub stick_id: Option<u64>,
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
            ("move", Touch) => "a finger dragged on the left side of the screen",
            ("move", Gamepad) => "the left stick",
            ("move", Phone) => "your phone's joystick",
            ("down", Keyboard) => "press Down (or S)",
            ("down", Touch) => "drag down on the left side of the screen",
            ("down", Gamepad) => "push the left stick down",
            ("down", Phone) => "push your phone's joystick down",
            ("updown", Keyboard) => "Up and Down (or W and S)",
            ("updown", Touch) => "drag up and down on the left side",
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
            .init_resource::<TouchStick>()
            .init_resource::<RemoteSlots>()
            .init_resource::<LastDevice>()
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
    mut stick: ResMut<TouchStick>,
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

    // Touch: left half floating stick, right half button.
    if let Some(slot) = devices.touch_slot {
        let width = windows.iter().next().map_or(1000.0, |w| w.width());
        let mut button = false;
        let mut seen_stick = false;
        for t in touches.iter() {
            let p = t.position();
            if p.x < width * 0.5 {
                if stick.stick_id.is_none() {
                    stick.stick_id = Some(t.id());
                    stick.origin = Some(t.start_position());
                }
                if stick.stick_id == Some(t.id()) {
                    seen_stick = true;
                    stick.current = p;
                }
            } else {
                button = true;
            }
        }
        if !seen_stick {
            stick.stick_id = None;
            stick.origin = None;
        }
        stick.button = button;
        if let Some(o) = stick.origin {
            let d = (stick.current - o) / 60.0;
            // Screen y is down.
            let s = PVec2::new(d.x, -d.y).clamp_length_max(1.0);
            let s = PVec2::new(if s.x.abs() < 0.2 { 0.0 } else { s.x }, if s.y.abs() < 0.35 { 0.0 } else { s.y });
            inputs.slots[slot as usize].stick += s;
            inputs.active[slot as usize] = true;
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
        assert!(control_text(tip, LastDevice::Touch).starts_with("Tap the right side of the screen to hop."));
        // Unknown names and stray braces pass through untouched.
        assert_eq!(control_text("a {nope} b {", LastDevice::Keyboard), "a {nope} b {");
        assert_eq!(control_text("no placeholders", LastDevice::Phone), "no placeholders");
    }
}
