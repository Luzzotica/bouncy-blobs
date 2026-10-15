//! Loading any level file — a blueprint (`"pieces": [...]`), a plain level
//! (format v3) or a legacy 2.x map — with mistakes explained in plain words
//! ("line 57, piece 42 (ledge): missing field `y`").

use std::path::Path;

use serde_json::Value;

use crate::blueprint::{Blueprint, Course, Piece};
use crate::types::Level;

/// What kind of file was loaded.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum FileKind {
    Blueprint,
    Level,
    Legacy,
}

/// A successfully loaded file.
#[derive(Clone, Debug)]
pub struct Loaded {
    pub course: Course,
    pub kind: FileKind,
    /// The blueprint (when the file is one).
    pub blueprint: Option<Blueprint>,
    /// Things that loaded but look wrong (unknown fields that were ignored).
    pub warnings: Vec<String>,
}

/// Why a file didn't load: one plain-words line per problem.
#[derive(Clone, Debug)]
pub struct LoadError {
    pub problems: Vec<String>,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.problems.join("\n"))
    }
}

impl std::error::Error for LoadError {}

fn fail<T>(p: String) -> Result<T, LoadError> {
    Err(LoadError { problems: vec![p] })
}

pub fn load_level_file(path: &Path) -> Result<Loaded, LoadError> {
    let text = std::fs::read_to_string(path).map_err(|e| LoadError { problems: vec![format!("can't read {}: {e}", path.display())] })?;
    load_level_text(&text)
}

/// Load a blueprint, plain level or legacy map from JSON text.
pub fn load_level_text(text: &str) -> Result<Loaded, LoadError> {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => return fail(syntax_error(text, &e)),
    };
    let Some(obj) = value.as_object() else {
        return fail("the file should be one JSON object ({ ... }) holding the level".into());
    };
    if obj.contains_key("pieces") {
        return load_blueprint(text, &value);
    }
    if crate::legacy::is_legacy(text) {
        let level = crate::legacy::import_legacy(text).map_err(|e| LoadError { problems: vec![format!("legacy map: {e}")] })?;
        return Ok(Loaded { course: Course { level, path: Vec::new() }, kind: FileKind::Legacy, blueprint: None, warnings: Vec::new() });
    }
    let level: Level = serde_json::from_str(text).map_err(|e| LoadError { problems: vec![located(text, &e, "")] })?;
    let mut warnings = Vec::new();
    unknown_keys(&value, &serde_json::to_value(&level).unwrap(), "", &mut warnings);
    Ok(Loaded { course: Course { level, path: Vec::new() }, kind: FileKind::Level, blueprint: None, warnings })
}

fn load_blueprint(text: &str, value: &Value) -> Result<Loaded, LoadError> {
    let mut problems = Vec::new();
    let mut warnings = Vec::new();
    // The header on its own (so one bad piece doesn't hide header mistakes).
    let mut head = value.clone();
    let pieces = head.as_object_mut().unwrap().insert("pieces".into(), Value::Array(Vec::new())).unwrap_or(Value::Null);
    if let Err(e) = serde_json::from_value::<Blueprint>(head) {
        problems.push(format!("level header: {}", explain(&e.to_string(), false)));
    }
    let Some(items) = pieces.as_array() else {
        problems.push("`pieces` should be a list: \"pieces\": [ {...}, {...} ]".into());
        return Err(LoadError { problems });
    };
    let lines = item_lines(text, "pieces");
    let mut parsed = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let line = lines.get(i).map(|l| format!("line {l}, ")).unwrap_or_default();
        let kind = item.as_object().and_then(|o| (o.len() == 1).then(|| o.keys().next().cloned()).flatten());
        let what = match &kind {
            Some(k) => format!("{line}piece {} ({k})", i + 1),
            None => format!("{line}piece {}", i + 1),
        };
        if item.as_object().is_none_or(|o| o.len() != 1) {
            problems.push(format!("{what}: each piece is an object with exactly one key, like {{\"ledge\": {{\"x0\": 0, \"x1\": 400, \"y\": 0}}}}"));
            continue;
        }
        match serde_json::from_value::<Piece>(item.clone()) {
            Ok(p) => {
                let mut w = Vec::new();
                unknown_keys(item, &serde_json::to_value(&p).unwrap(), "", &mut w);
                warnings.extend(w.into_iter().map(|w| format!("{what}: {w}")));
                parsed.push(p);
            }
            Err(e) => problems.push(format!("{what}: {}", explain(&e.to_string(), true))),
        }
    }
    if !problems.is_empty() {
        return Err(LoadError { problems });
    }
    let mut bp: Blueprint = serde_json::from_value({
        let mut h = value.clone();
        h.as_object_mut().unwrap().insert("pieces".into(), Value::Array(Vec::new()));
        h
    })
    .map_err(|e| LoadError { problems: vec![explain(&e.to_string(), false)] })?;
    bp.pieces = parsed;
    let course = bp.expand();
    Ok(Loaded { course, kind: FileKind::Blueprint, blueprint: Some(bp), warnings })
}

/// Keys in `input` that the parsed value doesn't have (so they were
/// ignored: usually a typo). Fields left at their default may be omitted
/// from `output`, so those aren't reported.
fn unknown_keys(input: &Value, output: &Value, at: &str, out: &mut Vec<String>) {
    match (input, output) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in a {
                let here = if at.is_empty() { k.clone() } else { format!("{at}.{k}") };
                match b.get(k) {
                    Some(w) => unknown_keys(v, w, &here, out),
                    None if is_defaultish(v) => {}
                    None => {
                        let near = closest(k, b.keys().map(|s| s.as_str()));
                        let hint = near.map(|n| format!(" (did you mean `{n}`?)")).unwrap_or_default();
                        out.push(format!("unknown field `{here}` was ignored{hint}"));
                    }
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            for (i, (v, w)) in a.iter().zip(b).enumerate() {
                unknown_keys(v, w, &format!("{at}[{i}]"), out);
            }
        }
        _ => {}
    }
}

fn is_defaultish(v: &Value) -> bool {
    match v {
        Value::Bool(b) => !b,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Null => true,
        _ => false,
    }
}

/// Line numbers (1-based) where each element of the top-level array `key`
/// starts.
fn item_lines(text: &str, key: &str) -> Vec<usize> {
    let b = text.as_bytes();
    let needle = format!("\"{key}\"");
    let mut depth = 0i32;
    let mut i = 0;
    let mut line = 1;
    let mut in_array = false;
    let mut at_item = false;
    let mut out = Vec::new();
    while i < b.len() {
        let c = b[i];
        if c == b'\n' {
            line += 1;
        }
        if c == b'"' {
            if depth == 1 && !in_array && text[i..].starts_with(&needle) {
                // Skip to the '[' after the colon.
                if let Some(off) = text[i..].find('[') {
                    for &ch in &b[i..i + off] {
                        if ch == b'\n' {
                            line += 1;
                        }
                    }
                    i += off + 1;
                    depth += 1;
                    in_array = true;
                    at_item = true;
                    continue;
                }
            }
            if in_array && depth == 2 && at_item {
                out.push(line);
                at_item = false;
            }
            // Skip the string.
            i += 1;
            while i < b.len() && b[i] != b'"' {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        match c {
            b'{' | b'[' => {
                if in_array && depth == 2 && at_item {
                    out.push(line);
                    at_item = false;
                }
                depth += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                if in_array && depth == 1 {
                    in_array = false;
                }
            }
            b',' if in_array && depth == 2 => at_item = true,
            c if in_array && depth == 2 && at_item && !c.is_ascii_whitespace() => {
                out.push(line);
                at_item = false;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

fn syntax_error(text: &str, e: &serde_json::Error) -> String {
    let mut msg = e.to_string();
    if let Some(i) = msg.find(" at line ") {
        msg.truncate(i);
    }
    let hint = if msg.contains("trailing comma") {
        " (JSON doesn't allow a comma before ] or })"
    } else if msg.contains("key must be a string") {
        " (keys need double quotes: \"x0\": 100)"
    } else if msg.contains("expected `,` or") {
        " (a comma is probably missing at the end of the previous line)"
    } else {
        ""
    };
    format!("line {}, column {}: not valid JSON: {msg}{hint}{}", e.line(), e.column(), source_line(text, e.line()))
}

fn located(text: &str, e: &serde_json::Error, ctx: &str) -> String {
    let mut msg = e.to_string();
    if let Some(i) = msg.find(" at line ") {
        msg.truncate(i);
    }
    format!("line {}, column {}: {ctx}{}{}", e.line(), e.column(), explain(&msg, false), source_line(text, e.line()))
}

fn source_line(text: &str, line: usize) -> String {
    text.lines().nth(line.saturating_sub(1)).map(|l| format!("\n    | {}", l.trim())).unwrap_or_default()
}

/// Turn a serde message into plain words (with "did you mean" hints).
pub fn explain(msg: &str, piece: bool) -> String {
    let tick = |s: &str| -> Vec<String> { s.split('`').skip(1).step_by(2).map(String::from).collect() };
    if let Some(rest) = msg.strip_prefix("unknown variant ") {
        let names = tick(rest);
        if let Some((bad, options)) = names.split_first() {
            let hint = closest(bad, options.iter().map(|s| s.as_str())).map(|n| format!(" — did you mean `{n}`?")).unwrap_or_default();
            let what = if piece && options.iter().any(|o| o == "ledge") { "unknown piece type" } else { "unknown value" };
            return format!("{what} `{bad}`{hint} (choices: {})", options.join(", "));
        }
    }
    if let Some(rest) = msg.strip_prefix("unknown field ") {
        let names = tick(rest);
        if let Some((bad, options)) = names.split_first() {
            let hint = closest(bad, options.iter().map(|s| s.as_str())).map(|n| format!(" — did you mean `{n}`?")).unwrap_or_default();
            return format!("unknown field `{bad}`{hint} (this piece takes: {})", options.join(", "));
        }
    }
    if let Some(rest) = msg.strip_prefix("missing field ") {
        return format!("missing field {rest} (every field without a default must be given)");
    }
    if let Some(rest) = msg.strip_prefix("invalid type: ") {
        if let Some((found, expected)) = rest.split_once(", expected ") {
            let expected = expected.replace("f32", "a number").replace("usize", "a whole number").replace("a sequence", "a list");
            return format!("wrong kind of value: found {found}, expected {expected}");
        }
    }
    if let Some(rest) = msg.strip_prefix("invalid length ") {
        let hint = if piece { " (points are [x, y]; waypoints are [\"how\", x, y])" } else { " (points are [x, y])" };
        return format!("wrong number of values: {rest}{hint}");
    }
    msg.to_string()
}

/// The closest name by edit distance (if reasonably close).
fn closest<'a>(word: &str, options: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    options
        .map(|o| (o, edit_distance(word, o)))
        .filter(|(o, d)| *d <= (o.len().max(word.len()) / 3).max(2))
        .min_by_key(|(_, d)| *d)
        .map(|(o, _)| o)
}

fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            cur.push((prev[j] + (ca != cb) as usize).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{
  "id": "t", "name": "T", "kill_y": -800, "spawn": [0, 40],
  "pieces": [
    {"ledge": {"x0": -400, "x1": 400, "y": 0}},
    {"wp": ["walk", 0, 0]}
  ]
}"#;

    #[test]
    fn loads_a_blueprint() {
        let l = load_level_text(GOOD).unwrap();
        assert_eq!(l.kind, FileKind::Blueprint);
        assert_eq!(l.course.level.terrain.len(), 1);
        assert_eq!(l.course.path.len(), 1);
    }

    #[test]
    fn explains_mistakes_with_lines() {
        let bad = GOOD.replace("\"ledge\"", "\"ledg\"").replace("\"walk\"", "\"wlak\"");
        let e = load_level_text(&bad).unwrap_err();
        assert_eq!(e.problems.len(), 2, "{e}");
        assert!(e.problems[0].starts_with("line 4, piece 1 (ledg): unknown piece type `ledg` — did you mean `ledge`?"), "{e}");
        assert!(e.problems[1].contains("line 5, piece 2 (wp)") && e.problems[1].contains("`walk`"), "{e}");
        let bad = GOOD.replace("\"x1\"", "\"x2\"");
        let e = load_level_text(&bad).unwrap_err();
        assert!(e.problems[0].contains("unknown field `x2` — did you mean `x0`?") || e.problems[0].contains("did you mean `x1`"), "{e}");
        let bad = GOOD.replace("0}},\n    {\"wp\"", "0}}\n    {\"wp\"");
        let e = load_level_text(&bad).unwrap_err();
        assert!(e.problems[0].starts_with("line 5"), "{e}");
    }

    #[test]
    fn warns_about_ignored_fields_in_raw_data() {
        let t = GOOD.replace("{\"wp\"", "{\"npc\": {\"pos\": [0, 50], \"colour\": \"#fff\"}},\n    {\"wp\"");
        let l = load_level_text(&t).unwrap();
        assert_eq!(l.warnings.len(), 1, "{:?}", l.warnings);
        assert!(l.warnings[0].contains("colour`") && l.warnings[0].contains("`color`"), "{:?}", l.warnings);
    }

    #[test]
    fn loads_plain_levels_too() {
        let mut level = Level::new("x", "X");
        level.spawn = glam::Vec2::new(1.0, 2.0);
        let l = load_level_text(&level.to_json()).unwrap();
        assert_eq!(l.kind, FileKind::Level);
        assert_eq!(l.course.level, level);
    }
}
