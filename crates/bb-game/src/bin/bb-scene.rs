//! `bb-scene`: the Bouncy Blobs scene runner (content's SCENE-SPEC v0/v0.1).
//!
//!   bb-scene validate SHOT.json
//!   bb-scene preview  SHOT.json [--seed N] [--out DIR] [--bin GAME]
//!   bb-scene render   SHOT.json [--seed N] [--out DIR] [--bin GAME]
//!
//! `build: "current"` is the head of origin/game-polish; the runner checks
//! that origin/port-capture (the capture code) is inside it, then renders
//! with a game built from exactly that commit (built once and cached under
//! ~/.cache/bb-scene, or `--bin` if that binary reports the same commit).
//! Every render runs the real game headless and muted, once per output
//! size, from the same script, so all sizes are the same performance.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::Instant;

use bb_game::scene::{self, Output, Scene};
use serde_json::{Value, json};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "usage: bb-scene validate|preview|render SHOT.json [--seed N] [--out DIR] [--bin GAME]";
    let (Some(cmd), Some(file)) = (args.first(), args.get(1)) else {
        eprintln!("{usage}");
        return ExitCode::from(64);
    };
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Can't read {file}: {e}");
            return ExitCode::from(66);
        }
    };
    let mut s = match scene::parse(&text) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("✗ {file}\n  - {e}");
            return ExitCode::from(65);
        }
    };
    if let Some(seed) = flag("--seed").and_then(|v| v.parse().ok()) {
        s.seeds = vec![seed];
    }
    // A relative replay path is relative to the scene file (the game reads it the same way).
    let mut check_s = s.clone();
    if let Some(r) = &s.replay {
        if !Path::new(r).is_absolute() {
            check_s.replay = Some(Path::new(file).parent().unwrap_or(Path::new(".")).join(r).to_string_lossy().into_owned());
        }
    }
    match scene::validate(&check_s) {
        Ok(warnings) => {
            println!("✓ {file} is a valid scene.");
            for w in warnings {
                println!("  warning: {w}");
            }
        }
        Err(errs) => {
            eprintln!("✗ {file} has {} problem{}:", errs.len(), if errs.len() == 1 { "" } else { "s" });
            for e in errs {
                eprintln!("  - {e}");
            }
            return ExitCode::from(65);
        }
    }
    if cmd == "validate" {
        return ExitCode::SUCCESS;
    }
    if cmd != "preview" && cmd != "render" {
        eprintln!("{usage}");
        return ExitCode::from(64);
    }
    let out = flag("--out").map(PathBuf::from).unwrap_or_else(|| Path::new(file).parent().unwrap_or(Path::new(".")).to_path_buf());
    let r = resolve_build(&s, flag("--bin").map(PathBuf::from)).and_then(|b| run(&s, Path::new(file), &out, &b, cmd == "preview"));
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("✗ {e}");
            ExitCode::from(1)
        }
    }
}

// ───────────────────────────────────────────────────────────── the build

struct Build {
    bin: PathBuf,
    commit: String,
    /// How "build" was resolved, for NOTES.
    resolved: String,
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn git(args: &[&str]) -> Option<String> {
    let o = Command::new("git").arg("-C").arg(repo()).args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn is_ancestor(a: &str, b: &str) -> bool {
    Command::new("git").arg("-C").arg(repo()).args(["merge-base", "--is-ancestor", a, b]).status().is_ok_and(|s| s.success())
}

/// Ask a game binary which commit it was built from. The probe is always
/// headless and muted with a time limit: a binary too old to know
/// BB_PRINT_BUILD would otherwise start the game in a visible window.
fn bin_commit(bin: &Path) -> Option<String> {
    let probe = std::env::temp_dir().join(format!("bb-scene-probe-{}.png", std::process::id()));
    let mut child = Command::new(bin)
        .env("BB_PRINT_BUILD", "1")
        .env("BB_MUTE", "1")
        .env("BB_SHOT", &probe)
        .env("BB_SHOT_FRAME", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > std::time::Duration::from_secs(20) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&probe);
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
    let _ = std::fs::remove_file(&probe);
    let o = child.wait_with_output().ok()?;
    let out = String::from_utf8_lossy(&o.stdout).trim().to_string();
    // A real stamp is a short hash (maybe "-dirty"); anything else
    // (a game that ran a frame instead) means "unknown".
    let hash = out.strip_suffix("-dirty").unwrap_or(&out);
    (o.status.success() && !hash.is_empty() && hash.len() <= 40 && hash.chars().all(|c| c.is_ascii_hexdigit())).then_some(out)
}

fn resolve_build(s: &Scene, bin: Option<PathBuf>) -> Result<Build, String> {
    if Command::new("git").arg("-C").arg(repo()).args(["fetch", "-q", "origin"]).status().map_or(true, |s| !s.success()) {
        println!("  warning: couldn't fetch origin; using the last known origin/game-polish.");
    }
    let gp = git(&["rev-parse", "origin/game-polish"]).ok_or("Can't find origin/game-polish in the repo.")?;
    let (target, resolved) = if s.build == "current" {
        if let Some(pc) = git(&["rev-parse", "origin/port-capture"]) {
            if !is_ancestor(&pc, &gp) {
                return Err(format!(
                    "\"build\": \"current\" is origin/game-polish ({}), but it doesn't include the latest capture code (origin/port-capture {}). The capture code there is stale: merge port-capture into game-polish first.",
                    &gp[..9],
                    &pc[..9]
                ));
            }
        }
        (gp.clone(), format!("current = head of origin/game-polish ({})", &gp[..9]))
    } else {
        let t = git(&["rev-parse", &format!("{}^{{commit}}", s.build)]).ok_or_else(|| format!("\"build\" {:?} isn't a commit in the repo.", s.build))?;
        if !is_ancestor(&gp, &t) {
            match s.allow_old_build.as_deref().filter(|r| !r.trim().is_empty()) {
                Some(r) => println!("  warning: rendering an older build ({}), allowed because: {r}", &t[..9]),
                None => {
                    return Err(format!(
                        "\"build\" {} is older than the current build (origin/game-polish {}). Sterling: no content on old versions. Add \"allow_old_build\": \"<reason>\" if you really mean it.",
                        &t[..9],
                        &gp[..9]
                    ));
                }
            }
        }
        (t.clone(), if t.starts_with(&s.build) { "an explicit commit".to_string() } else { format!("\"{}\"", s.build) })
    };
    let short = &target[..9];
    // 1. A binary passed in that reports exactly this commit.
    if let Some(b) = bin {
        match bin_commit(&b) {
            Some(c) if c == short => return Ok(Build { bin: b, commit: c, resolved }),
            Some(c) => println!("  note: {} was built from {c}, not {short}; using a build of {short} instead.", b.display()),
            None => println!("  note: {} doesn't report its build; using a build of {short} instead.", b.display()),
        }
    }
    // 2. The cache, else build it from a clean export of that commit.
    let cache = dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("bb-scene").join(short);
    let cached = cache.join("bouncy-blobs");
    if bin_commit(&cached).as_deref() == Some(short) {
        return Ok(Build { bin: cached, commit: short.into(), resolved });
    }
    build_commit(&target, short, &cache)?;
    Ok(Build { bin: cached, commit: short.into(), resolved })
}

/// Build the game at `commit` from a `git archive` export (nobody's
/// worktree is touched), sharing the build cache, and keep the binary.
fn build_commit(commit: &str, short: &str, cache: &Path) -> Result<(), String> {
    println!("Building the game at {short} (once; cached in {})…", cache.display());
    let t = Instant::now();
    // The export sits next to the repo so relative path dependencies resolve.
    let dir = repo().join("..").join(format!(".bb-scene-build-{short}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let archive = Command::new("git").arg("-C").arg(repo()).args(["archive", "--format=tar", commit, "Cargo.toml", "Cargo.lock", "crates"]).stdout(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let st = Command::new("tar").arg("-x").arg("-C").arg(&dir).stdin(archive.stdout.unwrap()).status().map_err(|e| e.to_string())?;
    if !st.success() {
        return Err("Couldn't export the commit with git archive.".into());
    }
    // Never make a new target dir (disk): reuse the shared build cache.
    let Some(target) = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from) else {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("Building the game needs CARGO_TARGET_DIR set to the shared build cache (so no new target dir fills the disk). Set it, or pass --bin with a binary of this exact commit.".into());
    };
    let mut cmd = Command::new("cargo");
    cmd.current_dir(&dir).args(["build", "-p", "bb-game", "--bin", "bouncy-blobs"]);
    for p in ["bb-game", "bb-level", "bb-sim", "bb-physics", "bb-net"] {
        // Distinct artifacts per build, so another tree's build of the same
        // crate can never be picked up from a shared target dir.
        cmd.args(["--config", &format!("profile.dev.package.{p}.codegen-units=255")]);
    }
    let st = cmd.env("CARGO_TARGET_DIR", &target).env("CARGO_INCREMENTAL", "0").env("CARGO_PROFILE_DEV_DEBUG", "0").env("BB_GIT_COMMIT", short).status().map_err(|e| e.to_string())?;
    if !st.success() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("Building {short} failed (see the cargo output above)."));
    }
    // Make sure the binary really came from this export.
    let deps = std::fs::read_to_string(target.join("debug/bouncy-blobs.d")).unwrap_or_default();
    let here = dir.file_name().unwrap().to_string_lossy().to_string();
    if !deps.contains(&here) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("The built binary isn't from the exported commit (shared build cache collision); try again.".into());
    }
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    std::fs::copy(target.join("debug/bouncy-blobs"), cache.join("bouncy-blobs")).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&dir);
    println!("  built in {:.0} s", t.elapsed().as_secs_f32());
    Ok(())
}

// ───────────────────────────────────────────────────────────── running

#[allow(clippy::too_many_arguments)]
fn run_game(s: &Scene, scene_path: &Path, bin: &Path, seed: u32, size: (u32, u32), transparent: bool, floor: Option<[f32; 2]>, frames: u32, mp4: &Path, check: &Path, stills: &[u32]) -> Result<(), String> {
    let abs = std::fs::canonicalize(scene_path).map_err(|e| format!("{}: {e}", scene_path.display()))?;
    let env = scene::env_for(s, &abs.to_string_lossy(), seed, size, transparent, floor, frames, &mp4.to_string_lossy(), &check.to_string_lossy());
    let home = std::env::temp_dir().join(format!("bb-scene-home-{}-{seed}-{}x{}-{}", std::process::id(), size.0, size.1, transparent as u8));
    let _ = std::fs::create_dir_all(&home);
    let mut cmd = Command::new(bin);
    cmd.envs(&env).env("HOME", &home).stdout(Stdio::null()).stderr(Stdio::piped());
    if !stills.is_empty() {
        cmd.env("BB_SCENE_STILLS", stills.iter().map(u32::to_string).collect::<Vec<_>>().join(","));
    }
    let o = cmd.output().map_err(|e| format!("Couldn't start the game at {}: {e}.", bin.display()))?;
    let _ = std::fs::remove_dir_all(&home);
    if !o.status.success() || !mp4.exists() || !check.exists() {
        let err = String::from_utf8_lossy(&o.stderr);
        let tail: Vec<String> = err.lines().filter(|l| l.contains("ERROR") || l.contains("panicked")).take(8).map(plain).collect();
        return Err(format!("The game run ({}x{}, seed {seed}) failed ({}).\n  {}", size.0, size.1, o.status, tail.join("\n  ")));
    }
    Ok(())
}

/// A log line without terminal colours, timestamp or module path.
fn plain(l: &str) -> String {
    let mut out = String::new();
    let mut it = l.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            for d in it.by_ref() {
                if d.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    match out.find("scene: ") {
        Some(i) => out[i + 7..].to_string(),
        None => out.trim().to_string(),
    }
}

fn load(p: &Path) -> Result<Value, String> {
    let t = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
    serde_json::from_str(&t).map_err(|e| format!("{}: {e}", p.display()))
}

fn f4(v: &Value) -> Option<[f32; 4]> {
    let a = v.as_array()?;
    Some([a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32, a.get(3)?.as_f64()? as f32])
}

#[derive(Default)]
struct Verdict {
    errors: Vec<String>,
    warnings: Vec<String>,
    pops: Vec<String>,
}

fn pct(b: [f32; 4]) -> String {
    format!("x {:.0}–{:.0}%, y {:.0}–{:.0}%", b[0] * 100.0, b[2] * 100.0, b[1] * 100.0, b[3] * 100.0)
}

/// Check one run against the scene's rules.
fn judge(s: &Scene, o: &Output, chk: &Value) -> Verdict {
    let (bx, by) = (o.band_x(s), s.check.band_y);
    let (w, h) = o.dims().unwrap_or((1, 1));
    let mut v = Verdict::default();
    let frames = chk["frames"].as_array().cloned().unwrap_or_default();
    let events = chk["events"].as_array().cloned().unwrap_or_default();
    let inside = |b: [f32; 4], x: [f32; 2], y: [f32; 2]| b[0] >= x[0] - 1e-4 && b[2] <= x[1] + 1e-4 && b[1] >= y[0] - 1e-4 && b[3] <= y[1] + 1e-4;
    let members: Vec<String> = s.check.objects.iter().filter(|x| x.as_str() != scene::WORD_SELECTOR).cloned().collect();
    let checks_word = s.check.objects.iter().any(|x| x == scene::WORD_SELECTOR);
    let tag = format!("{} seed {}", o.size, chk["seed"]);
    let boxof = |f: &Value, id: &str| f4(&f["boxes"][id]);
    // Frame 1: every checked cast member fully in frame; the first one moving.
    if let Some(f) = frames.first() {
        for (i, id) in members.iter().enumerate() {
            match boxof(f, id) {
                Some(b) if inside(b, [0.0, 1.0], [0.0, 1.0]) => {
                    let sp = f["speeds"][id].as_f64().unwrap_or(0.0);
                    if i == 0 && s.check.frame1_moving && sp < 20.0 {
                        v.errors.push(format!("{tag}: on frame 1 {id} is standing still (speed {sp:.0}); add a pre_roll or start an input before t 0."));
                    }
                }
                Some(b) => v.errors.push(format!("{tag}: on frame 1 {id} isn't fully in frame ({}).", pct(b))),
                None => v.errors.push(format!("{tag}: on frame 1 {id} isn't there (popped, or not spawned yet).")),
            }
        }
    } else {
        v.errors.push(format!("{tag}: the run recorded no frames."));
    }
    for id in &members {
        let mut bad = 0;
        for f in &frames {
            if let Some(b) = boxof(f, id) {
                if !inside(b, bx, by) {
                    if bad < 4 {
                        v.errors.push(format!("{tag}: frame {} ({:.2} s): {id} at {} leaves the safe band (x {:.0}–{:.0}%, y {:.0}–{:.0}%).", f["frame"], f["frame"].as_f64().unwrap_or(0.0) / 60.0, pct(b), bx[0] * 100.0, bx[1] * 100.0, by[0] * 100.0, by[1] * 100.0));
                    }
                    bad += 1;
                }
            }
        }
        if bad > 4 {
            v.errors.push(format!("{tag}: …and {} more frames with {id} outside the band.", bad - 4));
        }
    }
    if let (Some(id), true) = (members.first(), h > w) {
        let mut ws: Vec<f32> = frames.iter().filter_map(|f| boxof(f, id).map(|b| b[2] - b[0])).collect();
        ws.sort_by(f32::total_cmp);
        if let Some(med) = ws.get(ws.len() / 2) {
            if *med < s.check.min_subject_width {
                v.warnings.push(format!("{tag}: {id} is only {:.0}% of the frame width (typical); the floor is {:.0}%.", med * 100.0, s.check.min_subject_width * 100.0));
            }
        }
    }
    if checks_word {
        let mut bad = 0;
        for f in &frames {
            for wb in f["words"].as_array().into_iter().flatten().filter_map(f4) {
                if !inside(wb, bx, by) {
                    if bad < 4 {
                        v.errors.push(format!("{tag}: frame {}: the POP! word at {} leaves the safe band.", f["frame"], pct(wb)));
                    }
                    bad += 1;
                }
            }
        }
        if bad > 4 {
            v.errors.push(format!("{tag}: …and {} more frames with the word outside the band.", bad - 4));
        }
    }
    for (i, e) in events.iter().filter(|e| e["kind"] == "pop" && !e["frame"].is_null()).enumerate() {
        let fp = e["frame"].as_i64().unwrap_or(0);
        let who = e["who"].as_str().unwrap_or("");
        let at = |k: i64| frames.iter().find(|f| f["frame"].as_i64() == Some(k));
        let pb = (2..8).filter_map(|d| at(fp - d).and_then(|f| boxof(f, who))).next();
        let mut wb: Option<[f32; 4]> = None;
        for k in fp..fp + 60 {
            for b in at(k).and_then(|f| f["words"].as_array().cloned()).into_iter().flatten().filter_map(|b| f4(&b)) {
                wb = Some(wb.map_or(b, |a| [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]));
            }
        }
        let show = |b: Option<[f32; 4]>| b.map_or("—".into(), |b| format!("{:.0}–{:.0}%", b[0] * 100.0, b[2] * 100.0));
        v.pops.push(format!("pop {:2} at {:5.2} s (frame {fp}): {who} x {}, POP! x {}", i + 1, fp as f32 / 60.0, show(pb), show(wb)));
    }
    v
}

fn ff(args: &[&str]) -> Result<(), String> {
    let o = Command::new("ffmpeg").args(["-y", "-loglevel", "error"]).args(args).output().map_err(|e| format!("ffmpeg: {e}"))?;
    if o.status.success() { Ok(()) } else { Err(format!("ffmpeg failed: {}", String::from_utf8_lossy(&o.stderr))) }
}

/// SFX family of a sound file (SCENE-SPEC families: pop, land, ui; the
/// rest only goes into the mix).
fn family(path: &str) -> &'static str {
    if path.starts_with("music/") {
        "music"
    } else if path.contains("spike-splat") {
        "pop"
    } else if path.contains("land-squelch") {
        "land"
    } else if path.contains("/ui-") {
        "ui"
    } else {
        "other"
    }
}

type AudioRow = (f64, Option<f64>, f64, f64, bool, String);

fn mix(rows: &[AudioRow], assets: &Path, dur: f32, out: &Path) -> Result<(), String> {
    let mut args: Vec<String> = Vec::new();
    let mut filt = Vec::new();
    for (n, (start, end, gain, speed, looped, path)) in rows.iter().enumerate() {
        if *looped {
            args.extend(["-stream_loop".into(), "-1".into()]);
        }
        args.extend(["-i".into(), assets.join(path).to_string_lossy().into_owned()]);
        let mut f = format!("[{n}:a]aresample=48000,aformat=channel_layouts=stereo");
        if (speed - 1.0).abs() > 1e-3 {
            f += &format!(",asetrate={:.0},aresample=48000", 48000.0 * speed);
        }
        if *start < 0.0 {
            f += &format!(",atrim=start={:.4},asetpts=PTS-STARTPTS", -start);
        }
        if let (Some(e), true) = (end, *looped) {
            f += &format!(",atrim=duration={:.4}", if *start >= 0.0 { e - start } else { *e });
        }
        if *start > 0.0 {
            f += &format!(",adelay={:.0}:all=1", start * 1000.0);
        }
        f += &format!(",volume={gain:.4}[a{n}]");
        filt.push(f);
    }
    let n = rows.len();
    args.extend(["-f".into(), "lavfi".into(), "-t".into(), format!("{dur:.4}"), "-i".into(), "anullsrc=r=48000:cl=stereo".into()]);
    let ins: String = (0..n).map(|i| format!("[a{i}]")).collect();
    filt.push(format!("{ins}[{n}:a]amix=inputs={}:normalize=0:duration=longest,atrim=duration={dur:.4},alimiter=limit=0.95[mix]", n + 1));
    args.extend(["-filter_complex".into(), filt.join(";"), "-map".into(), "[mix]".into(), "-c:a".into(), "pcm_s16le".into(), "-ar".into(), "48000".into(), out.to_string_lossy().into_owned()]);
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    ff(&a)
}

/// Offline audio from the game's own sound log: music stem, one SFX stem
/// per family, and the full mix. Returns the mix path.
fn audio(s: &Scene, mp4: &Path, base: &str, out: &Path, dur: f32) -> Result<Option<PathBuf>, String> {
    let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    let tsv = std::fs::read_to_string(format!("{}.audio.tsv", mp4.display())).map_err(|e| format!("audio log: {e}"))?;
    let rows: Vec<AudioRow> = tsv
        .lines()
        .skip(1)
        .filter_map(|l| {
            let c: Vec<&str> = l.split('\t').collect();
            Some((c.first()?.parse().ok()?, c.get(1)?.parse().ok(), c.get(2)?.parse().ok()?, c.get(3)?.parse().ok()?, *c.get(4)? == "1", c.get(5)?.to_string()))
        })
        .filter(|r: &AudioRow| r.0 < dur as f64 && r.1.is_none_or(|e| e > 0.0))
        .collect();
    let pick = |fam: &str| -> Vec<AudioRow> { rows.iter().filter(|r| family(&r.5) == fam).cloned().collect() };
    if s.audio.music_stem {
        mix(&pick("music"), &assets, dur, &out.join(format!("{base}.music.wav")))?;
    }
    for fam in &s.audio.sfx_families {
        mix(&pick(fam), &assets, dur, &out.join(format!("{base}.sfx-{fam}.wav")))?;
    }
    if s.audio.mix {
        let p = out.join(format!("{base}.mix.wav"));
        mix(&rows, &assets, dur, &p)?;
        return Ok(Some(p));
    }
    Ok(None)
}

fn sha256(p: &Path) -> String {
    Command::new("shasum").args(["-a", "256"]).arg(p).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().next().unwrap_or("").to_string()).unwrap_or_default()
}

fn contact(mp4: &Path, jpg: &Path, frames: u32) -> Result<(), String> {
    let step = (frames / 12).max(1);
    ff(&["-i", &mp4.to_string_lossy(), "-vf", &format!("select='not(mod(n\\,{step}))',scale=320:-2,tile=6x2"), "-frames:v", "1", "-q:v", "3", &jpg.to_string_lossy()])
}

/// A distinct render: one size, opaque or transparent.
#[derive(Clone, PartialEq)]
struct Pass {
    size: (u32, u32),
    transparent: bool,
    floor: Option<[f32; 2]>,
}

fn passes(s: &Scene) -> Vec<(Pass, Vec<&Output>)> {
    let mut v: Vec<(Pass, Vec<&Output>)> = Vec::new();
    for o in &s.outputs {
        let p = Pass { size: o.dims().unwrap(), transparent: o.transparent, floor: o.view };
        match v.iter_mut().find(|(q, _)| *q == p) {
            Some(e) => e.1.push(o),
            None => v.push((p, vec![o])),
        }
    }
    v
}

fn now() -> String {
    Command::new("date").arg("+%Y-%m-%d %H:%M").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

fn run(s: &Scene, path: &Path, out: &Path, build: &Build, preview: bool) -> Result<(), String> {
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let tmp = out.join(".bb-scene-tmp");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let cap_frames = s.length.seconds.map_or(120 * 60, |x| (x * 60.0).round() as u32);
    let mut notes = String::new();
    println!("Build: {} — {}", build.commit, build.resolved);
    for &seed in &s.seeds {
        let base = format!("{}-{seed}", s.scene);
        let mut summary = Vec::new();
        // 1. Fast pass at low resolution: every distinct size, all at once.
        println!("Seed {seed}: checking the whole timeline at low resolution…");
        let t1 = Instant::now();
        let ps = passes(s);
        let results: Vec<Result<(Verdict, Value, Pass), String>> = std::thread::scope(|sc| {
            let hs: Vec<_> = ps
                .iter()
                .map(|(p, outs)| {
                    let tmp = &tmp;
                    let base = &base;
                    sc.spawn(move || -> Result<(Verdict, Value, Pass), String> {
                        let (w, h) = p.size;
                        let k = (480.0 / w.max(h) as f32).min(1.0);
                        let small = ((((w as f32 * k) as u32) & !1).max(16), (((h as f32 * k) as u32) & !1).max(16));
                        let stem = format!("{base}-{w}x{h}{}.preview", if p.transparent { "-rgba" } else { "" });
                        let mp4 = tmp.join(format!("{stem}.mp4"));
                        let check = tmp.join(format!("{stem}.check.json"));
                        run_game(s, path, &build.bin, seed, small, p.transparent, p.floor, cap_frames, &mp4, &check, &[])?;
                        let chk = load(&check)?;
                        let v = judge(s, outs[0], &chk);
                        if preview {
                            let pm = out.join(format!("{stem}.mp4"));
                            let _ = std::fs::rename(&mp4, &pm);
                            let frames = chk["frames"].as_array().map_or(1, |a| a.len() as u32);
                            contact(&pm, &out.join(format!("{stem}.contact.jpg")), frames)?;
                        }
                        Ok((v, chk, p.clone()))
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("a check run crashed".into()))).collect()
        });
        let mut problems = Vec::new();
        let mut warnings = Vec::new();
        let mut first_chk = None;
        for r in results {
            let (v, chk, p) = r?;
            problems.extend(v.errors);
            warnings.extend(v.warnings);
            if !v.pops.is_empty() {
                println!("  {}x{}:", p.size.0, p.size.1);
                for x in &v.pops {
                    println!("    {x}");
                }
            }
            first_chk.get_or_insert(chk);
        }
        println!("  done in {:.0} s", t1.elapsed().as_secs_f32());
        for w in &warnings {
            println!("  warning: {w}");
        }
        if !problems.is_empty() {
            return Err(format!("Seed {seed}: the framing check failed, so nothing final was rendered:\n  - {}", problems.join("\n  - ")));
        }
        let chk0 = first_chk.unwrap_or(Value::Null);
        let frames = chk0["frames"].as_array().map_or(cap_frames, |a| a.len() as u32).max(1);
        if preview {
            println!("✓ Seed {seed}: preview passed ({frames} frames). Low-res clips and contact sheets are in {}.", out.display());
            continue;
        }
        // Stills: resolve times / events to frames.
        let ev: Vec<Value> = chk0["events"].as_array().cloned().unwrap_or_default();
        let still_frame = |o: &Output| -> Result<u32, String> {
            match &o.at {
                Some(Value::Number(n)) => Ok(((n.as_f64().unwrap_or(0.0) * 60.0).round() as u32).min(frames - 1)),
                Some(Value::String(a)) => {
                    let (kind, n) = a.trim_start_matches("event:").split_once('#').ok_or("bad still")?;
                    let n: usize = n.parse().map_err(|_| format!("still {a}: bad number"))?;
                    ev.iter()
                        .filter(|e| e["kind"] == kind && !e["frame"].is_null())
                        .nth(n.saturating_sub(1))
                        .and_then(|e| e["frame"].as_u64())
                        .map(|f| f as u32)
                        .ok_or_else(|| format!("Still {a}: seed {seed} has fewer than {n} {kind} events."))
                }
                _ => Err("bad still".into()),
            }
        };
        // 2. Final passes.
        let mut logs = Vec::new();
        let mut mixp: Option<Option<PathBuf>> = None;
        for (p, outs) in passes(s) {
            let (w, h) = p.size;
            let stills: Vec<(u32, &Output)> = outs.iter().filter(|o| o.kind == "still").map(|o| still_frame(o).map(|f| (f, *o))).collect::<Result<_, _>>()?;
            let tag = format!("{w}x{h}{}", if p.transparent { "-rgba" } else { "" });
            let mp4 = tmp.join(format!("{base}-{tag}.mp4"));
            let check = tmp.join(format!("{base}-{tag}.check.json"));
            let t = Instant::now();
            println!("Seed {seed}: rendering {tag}…");
            let sf: Vec<u32> = stills.iter().map(|s| s.0).collect();
            run_game(s, path, &build.bin, seed, p.size, p.transparent, p.floor, frames, &mp4, &check, &sf)?;
            println!("  done in {:.0} s", t.elapsed().as_secs_f32());
            let chk = load(&check)?;
            let v = judge(s, outs[0], &chk);
            if !v.errors.is_empty() {
                return Err(format!("The full-size {tag} render failed its check:\n  - {}", v.errors.join("\n  - ")));
            }
            let evs: Vec<(String, i64)> = chk["events"].as_array().into_iter().flatten().filter(|e| !e["frame"].is_null()).map(|e| (e["kind"].as_str().unwrap_or("").to_string(), e["frame"].as_i64().unwrap_or(-1))).collect();
            logs.push((tag.clone(), evs));
            for (f, o) in &stills {
                let raw = PathBuf::from(format!("{}.still-{f}.rgba", mp4.display()));
                let at = match &o.at {
                    Some(Value::String(a)) => a.trim_start_matches("event:").replace('#', ""),
                    Some(n) => format!("{n}s"),
                    None => String::new(),
                };
                let png = out.join(format!("{base}-{w}x{h}-{at}.png"));
                ff(&["-f", "rawvideo", "-pix_fmt", "rgba", "-s", &format!("{w}x{h}"), "-i", &raw.to_string_lossy(), "-frames:v", "1", "-pix_fmt", if p.transparent { "rgba" } else { "rgb24" }, &png.to_string_lossy()])?;
                let _ = std::fs::remove_file(raw);
                summary.push(format!("| {} | still {w}x{h}{} | frame {f} | |", png.file_name().unwrap().to_string_lossy(), if p.transparent { " RGBA (straight alpha)" } else { "" }));
            }
            if outs.iter().any(|o| o.kind == "video") {
                let final_mp4 = out.join(format!("{base}-{w}x{h}.mp4"));
                // Audio once per seed (every size is the same performance).
                if mixp.is_none() {
                    mixp = Some(audio(s, &mp4, &base, out, frames as f32 / 60.0)?);
                    contact(&mp4, &out.join(format!("{base}.contact.jpg")), frames)?;
                    let evj = json!({"scene": s.scene, "seed": seed, "fps": 60, "frames": frames, "build": build.commit,
                        "events": chk["events"].as_array().into_iter().flatten().filter(|e| !e["frame"].is_null()).collect::<Vec<_>>()});
                    std::fs::write(out.join(format!("{base}.events.json")), serde_json::to_string_pretty(&evj).unwrap()).map_err(|e| e.to_string())?;
                }
                match mixp.as_ref().unwrap() {
                    Some(m) => ff(&["-i", &mp4.to_string_lossy(), "-i", &m.to_string_lossy(), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", &final_mp4.to_string_lossy()])?,
                    None => std::fs::rename(&mp4, &final_mp4).map_err(|e| e.to_string())?,
                }
                let count = |k: &str| chk["events"].as_array().into_iter().flatten().filter(|e| e["kind"] == k && !e["frame"].is_null()).count();
                summary.push(format!("| {} | video {w}x{h} 60 fps | {:.2} s | {} pops, {} landings, {} jumps |", final_mp4.file_name().unwrap().to_string_lossy(), frames as f32 / 60.0, count("pop"), count("land"), count("jump")));
                for x in v.pops {
                    summary.push(format!("| | {x} | | |"));
                }
            }
        }
        let same = logs.iter().all(|l| l.1 == logs[0].1);
        // 3. NOTES (appended).
        notes += &format!("\n## {} — seed {seed} (rendered {})\n\n", s.scene, now());
        notes += &format!("- **Build:** {} — {}\n", build.commit, build.resolved);
        notes += &format!("- **Seed:** {seed}\n- **Scene file:** `{}`, sha256 {}\n", path.file_name().unwrap_or_default().to_string_lossy(), sha256(path));
        notes += &format!("- **Stage:** {} {}{}\n", s.stage.kind, s.stage.id, s.stage.r#override.as_ref().map_or(String::new(), |o| format!(" (override: {o})")));
        if let Some(r) = &s.allow_old_build {
            notes += &format!("- **Old build allowed:** {r}\n");
        }
        if s.capture_only.is_empty() {
            notes += "- **capture_only:** none — the game behaves as it ships.\n";
        } else {
            notes += "- **capture_only (not how the game ships):**\n";
            for c in &s.capture_only {
                notes += &format!("  - {} = {}: {}\n", c.what, c.value, c.why);
            }
        }
        let vary: Vec<String> = chk0["vary"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
        if s.vary == scene::Vary::default() {
            notes += "- **vary:** none — every seed of this file is the same performance.\n";
        } else {
            notes += &format!("- **vary:** respawn_x ±{}, input_jitter ±{} s; this seed's values: {}\n", s.vary.respawn_x.unwrap_or(0.0), s.vary.input_jitter.unwrap_or(0.0), if vary.is_empty() { "none used".into() } else { vary.join("; ") });
        }
        notes += &format!("- **staged:** {}\n", if s.staged { "yes" } else { "no — every move is player input through the real simulation" });
        if !s.show.iter().any(|x| x == "pickups") {
            notes += "- Glow drops were cleared at load (default; `show: [\"pickups\"]` keeps them).\n";
        }
        notes += &format!(
            "- **Check:** passed (band x {:.0}–{:.0}%, objects {:?}, frame 1 moving and in frame){}.\n",
            s.check.band_x[0] * 100.0,
            s.check.band_x[1] * 100.0,
            s.check.objects,
            if warnings.is_empty() { String::new() } else { format!("; warnings: {}", warnings.join("; ")) }
        );
        notes += &format!("- **Sizes:** one script for every size; event logs {}.\n", if same { "match frame for frame" } else { "DIFFER between sizes" });
        notes += "- **Audio:** rendered offline from the game's own sound log (music stem, SFX stems by family, mix), not recorded from the speakers.\n\n";
        notes += "| file | what | length / frame | events |\n|---|---|---|---|\n";
        for r in summary {
            notes += &r;
            notes += "\n";
        }
    }
    // BB_SCENE_KEEP=1 keeps the per-run check files (debugging).
    if std::env::var_os("BB_SCENE_KEEP").is_none() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    if !preview {
        let np = out.join("NOTES.md");
        let mut all = std::fs::read_to_string(&np).unwrap_or_default();
        all += &notes;
        std::fs::write(&np, all).map_err(|e| e.to_string())?;
    }
    println!("✓ Done in {:.0} s → {}", t0.elapsed().as_secs_f32(), out.display());
    Ok(())
}
