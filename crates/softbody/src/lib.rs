// Deterministic fixed-point softbody physics.
//
// Phase 1: primitives only — Fx (Q32.32), FxVec2, sqrt, trig LUT, Mulberry32.
// Phase 2 will add the simulation core (world, collision, constraints,
// shape matching) ported from src/physics/*.ts.

pub mod collision;
pub mod constraints;
pub mod dynamic_items;
pub mod fx;
pub mod layers;
pub mod math;
pub mod rng;
pub mod shape_matching;
pub mod snapshot;
pub mod spring_pads;
pub mod tuning;
pub mod types;
pub mod world;

pub use fx::{Fx, FxVec2};
