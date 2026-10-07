//! The phone-controller protocol, byte-compatible with the deployed web page
//! (`src/pages/Controller.tsx`). All messages are JSON text frames.
//!
//! Phone → host: `player_join` (once, on `data`), `customization_update`
//! (on `data`), `player_input_batch` (~30 Hz on `input`, falling back to
//! `data`). Host → phone: a personalised `customization_update` with the
//! colours/faces other players hold.

use glam::Vec2;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The phone's 12 colour swatches (`src/constants/customization.ts`).
pub const PHONE_COLORS: [&str; 12] = [
    "#e06070", "#e88a5a", "#e8c54a", "#6ecf6e", "#4ac8c8", "#5a8ae0", "#8a6ae0", "#d06eb0", "#f0f0f0", "#ff4444",
    "#44aaff", "#aa44ff",
];

/// The 16 face ids, in the order the faces are numbered in the game.
pub const FACE_IDS: [&str; 16] = [
    "default", "derp", "cool", "angry", "uwu", "sleepy", "star", "cat", "shock", "wink", "smug", "cry", "skull", "clown",
    "tired", "monocle",
];

pub fn face_index(id: &str) -> Option<u8> {
    FACE_IDS.iter().position(|f| *f == id).map(|i| i as u8)
}

pub fn face_id(index: u8) -> &'static str {
    FACE_IDS.get(index as usize).copied().unwrap_or("default")
}

/// `0xRRGGBB` → `"#rrggbb"` (the phone compares lowercase hex strings).
pub fn color_hex(c: u32) -> String {
    format!("#{:06x}", c & 0xFF_FFFF)
}

pub fn parse_hex(s: &str) -> Option<u32> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    u32::from_str_radix(s, 16).ok()
}

/// `player_join.player`. Only the fields the host uses are typed; the rest
/// (`session_id`, `slot`, `status`, ...) are accepted and ignored.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PhoneJoin {
    #[serde(default)]
    pub player_id: String,
    #[serde(default)]
    pub name: String,
    /// `""` until the phone picks one.
    #[serde(default)]
    pub color: String,
    #[serde(default, rename = "faceId")]
    pub face_id: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Customization {
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, rename = "faceId")]
    pub face_id: Option<String>,
}

/// A parsed phone message. Unknown or dead types (`cursor_move`,
/// `item_select`, `placement_confirm`) come back as `Other`.
#[derive(Clone, Debug)]
pub enum PhoneMsg {
    Join(PhoneJoin),
    Customize(Customization),
    /// `(key, value, timestamp)` entries from `player_input_batch` or a
    /// single `player_input`.
    Input(Vec<(String, Value)>, Option<f64>),
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RawMsg {
    PlayerJoin {
        player: PhoneJoin,
    },
    CustomizationUpdate {
        #[serde(default)]
        value: Option<Customization>,
    },
    PlayerInputBatch {
        #[serde(default)]
        timestamp: Option<f64>,
        #[serde(default)]
        inputs: serde_json::Map<String, Value>,
    },
    PlayerInput {
        #[serde(rename = "inputType")]
        input_type: String,
        #[serde(default)]
        value: Value,
        #[serde(default)]
        timestamp: Option<f64>,
    },
    #[serde(other)]
    Other,
}

/// Parse one text frame from a phone. Malformed input is an error, never a
/// panic.
pub fn parse(text: &str) -> Result<PhoneMsg, String> {
    let raw: RawMsg = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(match raw {
        RawMsg::PlayerJoin { player } => PhoneMsg::Join(player),
        RawMsg::CustomizationUpdate { value } => PhoneMsg::Customize(value.unwrap_or_default()),
        RawMsg::PlayerInputBatch { timestamp, inputs } => PhoneMsg::Input(inputs.into_iter().collect(), timestamp),
        RawMsg::PlayerInput { input_type, value, timestamp } => PhoneMsg::Input(vec![(input_type, value)], timestamp),
        RawMsg::Other => PhoneMsg::Other,
    })
}

#[derive(Serialize)]
struct TakenValue<'a> {
    #[serde(rename = "takenColors")]
    taken_colors: &'a [String],
    #[serde(rename = "takenFaces")]
    taken_faces: &'a [String],
}

#[derive(Serialize)]
struct TakenMsg<'a> {
    #[serde(rename = "type")]
    ty: &'static str,
    value: TakenValue<'a>,
}

/// Host → phone: what *other* players hold, so the picker greys them out.
pub fn taken_message(taken_colors: &[String], taken_faces: &[String]) -> String {
    serde_json::to_string(&TakenMsg {
        ty: "customization_update",
        value: TakenValue { taken_colors, taken_faces },
    })
    .unwrap_or_default()
}

/// One phone's latest controls, with the host's per-key monotonic dedupe:
/// a late or reordered unreliable packet (older timestamp) is dropped, so
/// the newest value always wins and stays applied until replaced.
#[derive(Clone, Debug, Default)]
pub struct PhoneInput {
    /// Game convention: +y up.
    pub stick: Vec2,
    pub button: bool,
    last_stick: Option<f64>,
    last_button: Option<f64>,
}

fn num(v: &Value, key: &str) -> f32 {
    let x = v.get(key).and_then(Value::as_f64).unwrap_or(0.0) as f32;
    if x.is_finite() { x.clamp(-1.0, 1.0) } else { 0.0 }
}

impl PhoneInput {
    /// Apply a parsed `Input` message. Returns true if anything changed.
    /// `now_ms` stamps messages that carry no timestamp.
    pub fn apply(&mut self, entries: &[(String, Value)], timestamp: Option<f64>, now_ms: f64) -> bool {
        let ts = timestamp.filter(|t| t.is_finite()).unwrap_or(now_ms);
        let mut changed = false;
        for (key, value) in entries {
            match key.as_str() {
                "joystick_left" => {
                    if self.last_stick.is_some_and(|t| ts <= t) {
                        continue;
                    }
                    self.last_stick = Some(ts);
                    // The phone's y is screen-down; the game's is up.
                    let s = Vec2::new(num(value, "x"), -num(value, "y"));
                    changed |= s != self.stick;
                    self.stick = s;
                }
                "button_right" => {
                    if self.last_button.is_some_and(|t| ts <= t) {
                        continue;
                    }
                    self.last_button = Some(ts);
                    let b = value.get("pressed").and_then(Value::as_bool).unwrap_or(false);
                    changed |= b != self.button;
                    self.button = b;
                }
                _ => {}
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_real_player_join() {
        let text = r##"{"type":"player_join","player":{"player_id":"p1","name":"Ann","session_id":"abc","slot":0,"status":"connected","controller_config":null,"joined_at":"2026-01-01T00:00:00.000Z","color":"","faceId":"default"}}"##;
        let PhoneMsg::Join(j) = parse(text).unwrap() else { panic!() };
        assert_eq!(j.player_id, "p1");
        assert_eq!(j.name, "Ann");
        assert_eq!(j.color, "");
        assert_eq!(face_index(&j.face_id), Some(0));
    }

    #[test]
    fn parses_customization() {
        let PhoneMsg::Customize(c) =
            parse(r##"{"type":"customization_update","value":{"color":"#6ecf6e","faceId":"cat"}}"##).unwrap()
        else {
            panic!()
        };
        assert_eq!(c.color.as_deref().and_then(parse_hex), Some(0x6ecf6e));
        assert_eq!(c.face_id.as_deref().and_then(face_index), Some(7));
    }

    #[test]
    fn input_batch_flips_y_and_dedupes() {
        let mut p = PhoneInput::default();
        let batch = |ts: f64, x: i32, y: i32, pressed: bool| {
            format!(
                r#"{{"type":"player_input_batch","timestamp":{ts},"inputs":{{"joystick_left":{{"x":{x},"y":{y}}},"button_right":{{"pressed":{pressed}}}}}}}"#
            )
        };
        let apply = |p: &mut PhoneInput, text: &str| {
            let PhoneMsg::Input(e, ts) = parse(text).unwrap() else { panic!() };
            p.apply(&e, ts, 0.0)
        };
        // Phone pushes the stick up (screen y = -1) → game +y.
        assert!(apply(&mut p, &batch(100.0, 1, -1, true)));
        assert_eq!(p.stick, Vec2::new(1.0, 1.0));
        assert!(p.button);
        // A late packet from before is ignored.
        assert!(!apply(&mut p, &batch(90.0, -1, 1, false)));
        assert_eq!(p.stick, Vec2::new(1.0, 1.0));
        // Same timestamp is also stale (strictly monotonic).
        assert!(!apply(&mut p, &batch(100.0, 0, 0, false)));
        assert!(apply(&mut p, &batch(133.0, 0, 1, false)));
        assert_eq!(p.stick, Vec2::new(0.0, -1.0));
        assert!(!p.button);
    }

    #[test]
    fn single_player_input_and_junk() {
        let mut p = PhoneInput::default();
        let PhoneMsg::Input(e, ts) =
            parse(r#"{"type":"player_input","inputType":"button_right","value":{"pressed":true}}"#).unwrap()
        else {
            panic!()
        };
        assert!(p.apply(&e, ts, 5.0));
        assert!(p.button);
        assert!(matches!(parse(r#"{"type":"cursor_move","value":{"x":1,"y":2}}"#), Ok(PhoneMsg::Other)));
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"type":"player_join"}"#).is_err());
        // Garbage values clamp instead of exploding.
        let PhoneMsg::Input(e, _) = parse(
            r#"{"type":"player_input_batch","timestamp":1,"inputs":{"joystick_left":{"x":"left","y":99}}}"#,
        )
        .unwrap() else {
            panic!()
        };
        p.apply(&e, Some(10.0), 0.0);
        assert_eq!(p.stick, Vec2::new(0.0, -1.0));
    }

    #[test]
    fn taken_message_shape() {
        let m = taken_message(&["#e06070".into()], &["cat".into()]);
        assert_eq!(m, r##"{"type":"customization_update","value":{"takenColors":["#e06070"],"takenFaces":["cat"]}}"##);
        assert_eq!(color_hex(0xE06070), "#e06070");
    }
}
