//! One-off: record the Rust chapter builders as blueprint files and prove
//! the files expand to exactly the levels the builders made.
//!
//! `cargo run -p bb-level --example export_campaign [out_dir]`

use bb_level::blueprint::Blueprint;

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/../bb-game/assets/levels/campaign").into());
    std::fs::create_dir_all(&dir).unwrap();
    for n in 1..=bb_level::campaign::CHAPTERS {
        let (bp, built) = bb_level::campaign::recorded(n);
        let text = bp.to_json();
        let path = format!("{dir}/ch{n:02}.json");
        std::fs::write(&path, &text).unwrap();
        // Round trip: file text → blueprint → level, against the builder's level.
        let back = Blueprint::from_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back, bp, "ch{n:02}: blueprint changes through the file");
        let course = back.expand();
        assert_eq!(course.level, built.level, "ch{n:02}: level differs");
        assert_eq!(course.level.to_json(), built.level.to_json(), "ch{n:02}: level JSON differs");
        assert_eq!(course.path, built.path, "ch{n:02}: path differs");
        assert_eq!(back.to_json(), text, "ch{n:02}: file isn't canonical");
        println!("{path}: {} pieces, {} lines — round trip exact", bp.pieces.len(), text.lines().count());
    }
}
