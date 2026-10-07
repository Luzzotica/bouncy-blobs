//! Blob feel tuning, loaded from `tuning.toml`.
//!
//! The TOML next to this crate is compiled in as the defaults. Desktop dev
//! builds also watch it (see bb-game's `tuning` module) and push edits here
//! with [`set_live`]; every new [`Sim`](crate::Sim) starts from [`current`].

use std::sync::RwLock;

use serde::{Deserialize, Serialize};

/// The compiled-in tuning file.
pub const DEFAULT_TOML: &str = include_str!("../tuning.toml");

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tuning {
    pub jump: Jump,
    pub gravity: Gravity,
    #[serde(rename = "move")]
    pub movement: Move,
    pub stick: Stick,
    pub sticky: Sticky,
    pub body: BodyTune,
    pub vine: Vine,
    pub water: Water,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Jump {
    pub expand_scale: f32,
    pub expand_rate_press: f32,
    pub expand_rate_release: f32,
    pub expand_spring_mult: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Gravity {
    pub gravity: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Move {
    pub accel: f32,
    pub air: f32,
    pub wall: f32,
    pub ceiling: f32,
    pub max_speed: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Stick {
    pub down_accel: f32,
    pub squash_x: f32,
    pub squash_y: f32,
    pub up_accel: f32,
    pub ledge_up_mult: f32,
    pub ceiling_hold: f32,
    pub wall_climb_mult: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sticky {
    pub min_contacts: usize,
    pub jump: f32,
    pub release_grace: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BodyTune {
    pub spring_k: f32,
    pub spring_damp: f32,
    pub shear: f32,
    pub pressure_k: f32,
    pub shape_k: f32,
    pub shape_damp: f32,
    pub spin_damp: f32,
    pub static_friction: f32,
    pub dynamic_friction: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Vine {
    pub swing_accel: f32,
    pub jump_x: f32,
    pub jump_y: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Water {
    pub swim_kick: f32,
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning::parse(DEFAULT_TOML).expect("built-in tuning.toml is valid")
    }
}

impl Tuning {
    /// Parse a tuning file. Keys missing from `text` keep their built-in
    /// values, so a file can hold just the numbers being tweaked.
    pub fn parse(text: &str) -> Result<Tuning, String> {
        let mut base: toml::Table = DEFAULT_TOML.parse().map_err(|e: toml::de::Error| e.to_string())?;
        let over: toml::Table = text.parse().map_err(|e: toml::de::Error| e.to_string())?;
        merge(&mut base, over);
        let t: Tuning = toml::Value::Table(base).try_into().map_err(|e: toml::de::Error| e.to_string())?;
        t.validate()?;
        Ok(t)
    }

    fn validate(&self) -> Result<(), String> {
        let j = &self.jump;
        if !(j.expand_scale >= 1.0 && j.expand_scale <= 5.0) {
            return Err(format!("jump.expand_scale {} must be 1..5", j.expand_scale));
        }
        if self.gravity.gravity <= 0.0 {
            return Err("gravity.gravity must be > 0".into());
        }
        let b = &self.body;
        for (name, v) in [("spring_k", b.spring_k), ("shape_k", b.shape_k), ("pressure_k", b.pressure_k), ("spring_damp", b.spring_damp), ("shape_damp", b.shape_damp)] {
            if !(v >= 0.0 && v.is_finite()) {
                return Err(format!("body.{name} must be ≥ 0"));
            }
        }
        // Explicit-Euler stability at the 720 Hz substep.
        if b.spring_k.max(b.shape_k) > 60_000.0 {
            return Err("body.spring_k / shape_k above 60000 will explode".into());
        }
        Ok(())
    }

    /// The force model for blob bodies.
    pub fn force_model(&self) -> bb_physics::ForceModel {
        let b = &self.body;
        bb_physics::ForceModel {
            spring_k: b.spring_k,
            spring_damp: b.spring_damp,
            shear: b.shear,
            pressure_k: b.pressure_k,
            shape_k: b.shape_k,
            shape_damp: b.shape_damp,
            spin_damp: b.spin_damp,
        }
    }

    pub fn material(&self) -> bb_physics::Material {
        bb_physics::Material { static_friction: self.body.static_friction, dynamic_friction: self.body.dynamic_friction, restitution: 0.0 }
    }
}

fn merge(base: &mut toml::Table, over: toml::Table) {
    for (k, v) in over {
        match (base.get_mut(&k), v) {
            (Some(toml::Value::Table(b)), toml::Value::Table(o)) => merge(b, o),
            // Integers are fine where floats are expected (`gravity = 2000`).
            (Some(toml::Value::Float(_)), toml::Value::Integer(i)) => {
                base.insert(k, toml::Value::Float(i as f64));
            }
            (_, v) => {
                base.insert(k, v);
            }
        }
    }
}

static LIVE: RwLock<Option<Tuning>> = RwLock::new(None);

/// The tuning new sims start with: the live-edited file if any, else the
/// built-in one.
pub fn current() -> Tuning {
    LIVE.read().ok().and_then(|l| l.clone()).unwrap_or_default()
}

/// Install a live tuning (from the watched file).
pub fn set_live(t: Tuning) {
    if let Ok(mut l) = LIVE.write() {
        *l = Some(t);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_parses_and_partial_overrides_merge() {
        let d = Tuning::default();
        let t = Tuning::parse("[jump]\nexpand_scale = 3\n").unwrap();
        assert_eq!(t.jump.expand_scale, 3.0);
        assert_eq!(t.jump.expand_rate_press, d.jump.expand_rate_press);
        assert!(Tuning::parse("[jump]\nexpand_scale = 99.0\n").is_err());
        assert!(Tuning::parse("not toml [").is_err());
    }
}
