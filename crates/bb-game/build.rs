//! Bakes the git commit into the game (`build_info::COMMIT`) so captures and
//! scene renders can name the exact build in their NOTES.
use std::process::Command;

/// `--features steam`: the binaries link libsteam_api dynamically, and the
/// release layout ships it NEXT TO the executable (Steam depots, partii zips;
/// scripts/steam/assemble.sh). Linux needs RUNPATH `$ORIGIN` for that (the
/// Steam Linux Runtime does not add the game dir to the search path). macOS
/// already finds it (install name `@loader_path/libsteam_api.dylib`); the
/// `@executable_path` rpath is belt and braces.
fn steam_rpath() {
    if std::env::var_os("CARGO_FEATURE_STEAM").is_none() {
        return;
    }
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux") => println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN"),
        Ok("macos") => println!("cargo:rustc-link-arg-bins=-Wl,-rpath,@executable_path"),
        _ => {}
    }
}

fn git(args: &[&str]) -> Option<String> {
    let o = Command::new("git").args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    steam_rpath();
    println!("cargo:rerun-if-env-changed=BB_GIT_COMMIT");
    // bb-scene builds exact commits from a `git archive` (no .git there).
    if let Ok(c) = std::env::var("BB_GIT_COMMIT") {
        println!("cargo:rustc-env=BB_GIT_COMMIT={c}");
        return;
    }
    let commit = git(&["rev-parse", "--short=9", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
    println!("cargo:rustc-env=BB_GIT_COMMIT={commit}{}", if dirty { "-dirty" } else { "" });
    // Rebuild when HEAD moves (works in worktrees: --git-dir is per worktree).
    if let Some(gd) = git(&["rev-parse", "--git-dir"]) {
        println!("cargo:rerun-if-changed={gd}/HEAD");
    }
    if let Some(cd) = git(&["rev-parse", "--git-common-dir"]) {
        println!("cargo:rerun-if-changed={cd}/packed-refs");
        println!("cargo:rerun-if-changed={cd}/refs/heads");
    }
}
