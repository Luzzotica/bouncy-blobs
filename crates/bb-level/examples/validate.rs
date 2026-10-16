//! Check level files against the format and every design rule, in plain
//! words.
//!
//! ```text
//! cargo run -p bb-level --example validate                       # the whole campaign
//! cargo run -p bb-level --example validate -- path/to/level.json  # any level file(s)
//! cargo run -p bb-level --example validate -- --fmt ch03          # also re-format canonically
//! ```
//!
//! `chNN` is short for `crates/bb-game/assets/levels/campaign/chNN.json`.
//! Flags: `--quick` skips the (slower) resting-at-respawns check; `--fmt`
//! rewrites blueprint files in the canonical layout; `--strict` makes
//! warnings fail too. Exit status 1 when anything fails.

use std::path::{Path, PathBuf};

use bb_level::lint::{Finding, Severity};
use bb_level::load::{FileKind, item_lines, load_level_text};

fn main() {
    let mut files: Vec<PathBuf> = Vec::new();
    let (mut quick, mut fmt, mut strict) = (false, false, false);
    for a in std::env::args().skip(1) {
        match a.as_str() {
            "--quick" => quick = true,
            "--fmt" => fmt = true,
            "--strict" => strict = true,
            "-h" | "--help" => {
                println!("usage: validate [--quick] [--fmt] [--strict] [FILE|chNN]...");
                return;
            }
            _ => files.push(match bb_level::campaign::number(&a) {
                Some(n) => bb_level::campaign::source_path(n),
                None => PathBuf::from(a),
            }),
        }
    }
    if files.is_empty() {
        files = (1..=bb_level::campaign::CHAPTERS).map(bb_level::campaign::source_path).collect();
    }
    let scripts = Scripts::read();
    let (mut errors, mut warnings) = (0, 0);
    for path in &files {
        let (e, w) = check(path, &scripts, quick, fmt);
        errors += e;
        warnings += w;
    }
    println!("\n{} file(s): {errors} error(s), {warnings} warning(s)", files.len());
    if errors > 0 || (strict && warnings > 0) {
        std::process::exit(1);
    }
}

fn check(path: &Path, scripts: &Scripts, quick: bool, fmt: bool) -> (usize, usize) {
    let name = path.display().to_string();
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            println!("{name}: can't read it: {e}");
            return (1, 0);
        }
    };
    let loaded = match load_level_text(&text) {
        Ok(l) => l,
        Err(e) => {
            for p in &e.problems {
                println!("{name}: error: {p}");
            }
            return (e.problems.len(), 0);
        }
    };
    let mut findings: Vec<Finding> = loaded.warnings.iter().map(|w| Finding::error("format", w.clone())).collect();
    let has = |id: &str| scripts.has(id);
    let opts = bb_sim::validate::Options { rest: !quick, has_script: scripts.found.then_some(&has as &dyn Fn(&str) -> bool) };
    findings.extend(bb_sim::validate::validate(&loaded.course, loaded.blueprint.as_ref(), &opts));
    if let Some(bp) = &loaded.blueprint {
        let canon = bp.to_json();
        if canon != text {
            if fmt {
                std::fs::write(path, &canon).unwrap_or_else(|e| println!("{name}: can't rewrite: {e}"));
                println!("{name}: re-formatted");
            } else {
                findings.push(Finding::warning("format", "not in the canonical layout (run with --fmt to tidy it; values are unchanged)"));
            }
        }
    }
    findings.sort_by_key(|f| (f.severity, f.piece));
    let lines = if loaded.kind == FileKind::Blueprint { item_lines(&text, "pieces") } else { Vec::new() };
    let kinds: Vec<String> = loaded.blueprint.as_ref().map(|b| b.pieces.iter().map(|p| p.kind()).collect()).unwrap_or_default();
    let (mut e, mut w) = (0, 0);
    for f in &findings {
        let at = match f.piece {
            Some(i) => format!("{}:{}: piece {} ({}): ", name, lines.get(i).copied().unwrap_or(0), i + 1, kinds.get(i).map_or("?", |s| s.as_str())),
            None => format!("{name}: "),
        };
        println!("{at}{f}");
        match f.severity {
            Severity::Error => e += 1,
            Severity::Warning => w += 1,
        }
    }
    let l = &loaded.course.level;
    println!(
        "{name}: {:?} `{}` \"{}\": {} terrain, {} jelly, {} checkpoints, {} drops, {} waypoints — {}",
        loaded.kind,
        l.id,
        l.name,
        l.terrain.len(),
        l.jelly.len(),
        l.checkpoints.len(),
        l.pickups.len(),
        loaded.course.path.len(),
        if e == 0 { "OK" } else { "FAILED" }
    );
    (e, w)
}

/// Script ids that have words, read from bb-game's story scripts (the
/// `"id" =>` arms of `level_lines` and `cutscene`).
struct Scripts {
    found: bool,
    ids: Vec<String>,
}

impl Scripts {
    fn read() -> Scripts {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../bb-game/src/story/scripts.rs");
        let Ok(src) = std::fs::read_to_string(path) else { return Scripts { found: false, ids: Vec::new() } };
        let mut ids = Vec::new();
        for line in src.lines() {
            // `"a" | "b" => ...` match arms.
            let t = line.trim_start();
            let Some((arms, _)) = t.split_once("=>") else { continue };
            if !t.starts_with('"') || !arms.split('|').all(|a| a.trim().starts_with('"') && a.trim().ends_with('"')) {
                continue;
            }
            ids.extend(arms.split('|').map(|a| a.trim().trim_matches('"').to_string()));
        }
        Scripts { found: true, ids }
    }

    fn has(&self, id: &str) -> bool {
        self.ids.iter().any(|i| i == id)
    }
}
