//! Stub of the story ↔ audio interface. The story engineer's
//! `crate::story` module defines these exact names; at merge time this file
//! is replaced by a re-export (`pub use crate::story::{Blub, Voice};`).

use bevy::prelude::*;

/// Speak `syllables` of gibberish "blub" in a character's voice
/// (speech bubbles in cutscenes). Played by `audio`.
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
