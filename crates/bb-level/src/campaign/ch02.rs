//! Chapter 2 (stub).
use super::*;

pub fn build() -> Course {
    let mut c = Ch::new(2, "Stub", Theme::Hollow, -1200.0);
    c.spawn(v(0.0, 40.0));
    c.ledge(-500.0, 3000.0, 0.0);
    c.wp(Move::Walk, 0.0, 0.0).wp(Move::Walk, 2500.0, 0.0);
    c.goal(v(2500.0, 0.0), v(2700.0, 200.0));
    c.finish()
}
