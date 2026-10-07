//! XPBD softbody physics for Bouncy Blobs.
//!
//! Engine-agnostic (only depends on `glam`), so it runs headless in tests on
//! every platform and inside Bevy on desktop, mobile and the web.
//!
//! Units: pixels and seconds, y up.

pub mod body;
pub mod collide;
pub mod constraints;
pub mod geom;
pub mod rope;
pub mod world;

pub use body::{Body, BodyDesc, BodyId, BodyKind, BodyParams, Material, StrainLimits};
pub use geom::Aabb;
pub use glam::Vec2;
pub use rope::{Anchor, Joint, JointId, Rope, RopeDesc, RopeId};
pub use world::{Collider, Config, Contact, Event, PopCause, Static, StaticDesc, StaticId, World};
