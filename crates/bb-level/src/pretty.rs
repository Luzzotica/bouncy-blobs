//! Canonical, diff-friendly JSON for level files.
//!
//! * Keys keep their declaration order (struct field order), so files are
//!   stable and read top-down like the level.
//! * Anything that fits on one line (a piece, a point, a small object) stays
//!   on one line; longer lists of points wrap like a paragraph.
//! * Whole numbers drop the trailing `.0` (`2150`, not `2150.0`).
//!
//! Parsing the output back gives exactly the same values (floats are printed
//! with the shortest text that round-trips).

use serde::Serialize;

/// Lines are kept within this many columns where possible.
const WIDTH: usize = 120;

/// Serialise `value` as canonical pretty JSON (with a trailing newline).
pub fn to_pretty<T: Serialize>(value: &T) -> String {
    let compact = serde_json::to_string(value).expect("level data serialises");
    reformat(&compact).expect("serde_json output parses") + "\n"
}

/// Re-format any JSON text canonically (keeps key order and number text,
/// except that `1.0` becomes `1`).
pub fn reformat(json: &str) -> Result<String, String> {
    let mut p = Parser { s: json.as_bytes(), i: 0 };
    let n = p.value()?;
    p.ws();
    if p.i != p.s.len() {
        return Err(format!("trailing text at byte {}", p.i));
    }
    let mut out = String::new();
    write(&n, 0, &mut out);
    Ok(out)
}

enum Node {
    /// Number, string (with quotes), true / false / null: kept as text.
    Atom(String),
    Arr(Vec<Node>),
    Obj(Vec<(String, Node)>),
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at byte {}", c as char, self.i))
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.ws();
        let start = self.i;
        self.eat(b'"')?;
        while let Some(c) = self.peek() {
            self.i += 1;
            match c {
                b'\\' => self.i += 1,
                b'"' => return Ok(String::from_utf8_lossy(&self.s[start..self.i]).into_owned()),
                _ => {}
            }
        }
        Err("unterminated string".into())
    }

    fn value(&mut self) -> Result<Node, String> {
        self.ws();
        match self.peek() {
            Some(b'{') => {
                self.i += 1;
                let mut kv = Vec::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Ok(Node::Obj(kv));
                }
                loop {
                    let k = self.string()?;
                    self.eat(b':')?;
                    kv.push((k, self.value()?));
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Node::Obj(kv));
                        }
                        _ => return Err(format!("expected ',' or '}}' at byte {}", self.i)),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Ok(Node::Arr(items));
                }
                loop {
                    items.push(self.value()?);
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Node::Arr(items));
                        }
                        _ => return Err(format!("expected ',' or ']' at byte {}", self.i)),
                    }
                }
            }
            Some(b'"') => Ok(Node::Atom(self.string()?)),
            Some(_) => {
                let start = self.i;
                while let Some(c) = self.peek() {
                    if c == b',' || c == b']' || c == b'}' || c.is_ascii_whitespace() {
                        break;
                    }
                    self.i += 1;
                }
                let t = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
                Ok(Node::Atom(tidy_number(t)))
            }
            None => Err("unexpected end of input".into()),
        }
    }
}

/// `2150.0` → `2150`, `-0.0` stays (it's a different float).
fn tidy_number(t: String) -> String {
    if let Some(int) = t.strip_suffix(".0") {
        if int != "-0" && int.bytes().all(|c| c.is_ascii_digit() || c == b'-') {
            return int.to_string();
        }
    }
    t
}

fn compact(n: &Node, out: &mut String) {
    match n {
        Node::Atom(a) => out.push_str(a),
        Node::Arr(items) => {
            out.push('[');
            for (k, it) in items.iter().enumerate() {
                if k > 0 {
                    out.push_str(", ");
                }
                compact(it, out);
            }
            out.push(']');
        }
        Node::Obj(kv) => {
            out.push('{');
            for (k, (key, val)) in kv.iter().enumerate() {
                if k > 0 {
                    out.push_str(", ");
                }
                out.push_str(key);
                out.push_str(": ");
                compact(val, out);
            }
            out.push('}');
        }
    }
}

fn compact_str(n: &Node) -> String {
    let mut s = String::new();
    compact(n, &mut s);
    s
}

/// A point-like array: only atoms inside.
fn is_flat(n: &Node) -> bool {
    match n {
        Node::Atom(_) => true,
        Node::Arr(items) => items.iter().all(|i| matches!(i, Node::Atom(_))),
        Node::Obj(_) => false,
    }
}

fn pad(out: &mut String, indent: usize) {
    out.extend(std::iter::repeat_n(' ', indent));
}

/// Write `n` starting at the current column (the caller wrote the indent or
/// the `"key": ` prefix); `indent` is the current block indent.
fn write(n: &Node, indent: usize, out: &mut String) {
    let col = out.len() - out.rfind('\n').map(|i| i + 1).unwrap_or(0);
    let one = compact_str(n);
    // Top-level objects always expand (one field per line).
    if col + one.len() + 1 <= WIDTH && !(indent == 0 && col == 0 && matches!(n, Node::Obj(_))) {
        out.push_str(&one);
        return;
    }
    match n {
        Node::Atom(a) => out.push_str(a),
        Node::Arr(items) if items.iter().all(is_flat) && !items.iter().any(|i| matches!(i, Node::Atom(a) if a.starts_with('"'))) => {
            // Fill lines with points, like a paragraph.
            out.push_str("[\n");
            pad(out, indent + 2);
            let mut line = indent + 2;
            for (k, it) in items.iter().enumerate() {
                let s = compact_str(it);
                let sep = if k + 1 < items.len() { "," } else { "" };
                if line > indent + 2 && line + 1 + s.len() + sep.len() > WIDTH {
                    out.push('\n');
                    pad(out, indent + 2);
                    line = indent + 2;
                } else if line > indent + 2 {
                    out.push(' ');
                    line += 1;
                }
                out.push_str(&s);
                out.push_str(sep);
                line += s.len() + sep.len();
            }
            out.push('\n');
            pad(out, indent);
            out.push(']');
        }
        Node::Arr(items) => {
            out.push_str("[\n");
            for (k, it) in items.iter().enumerate() {
                pad(out, indent + 2);
                write(it, indent + 2, out);
                if k + 1 < items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            pad(out, indent);
            out.push(']');
        }
        // A one-key wrapper (a piece): keep the key on the opening line.
        Node::Obj(kv) if kv.len() == 1 && indent > 0 => {
            out.push('{');
            out.push_str(&kv[0].0);
            out.push_str(": ");
            write(&kv[0].1, indent, out);
            out.push('}');
        }
        Node::Obj(kv) => {
            out.push_str("{\n");
            for (k, (key, val)) in kv.iter().enumerate() {
                pad(out, indent + 2);
                out.push_str(key);
                out.push_str(": ");
                write(val, indent + 2, out);
                if k + 1 < kv.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            pad(out, indent);
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_short_things_inline_and_tidies_numbers() {
        let s = reformat(r#"{"a":1.0,"b":[1.5,-0.0,2e3],"c":{"x":[0.0,1.0]}}"#).unwrap();
        assert_eq!(s, "{\n  \"a\": 1,\n  \"b\": [1.5, -0.0, 2e3],\n  \"c\": {\"x\": [0, 1]}\n}");
    }

    #[test]
    fn wraps_long_point_lists() {
        let pts: Vec<[f32; 2]> = (0..40).map(|i| [i as f32 * 1000.5, 12.25]).collect();
        let s = to_pretty(&serde_json::json!({ "pieces": [{ "floor": pts }] }));
        assert!(s.lines().all(|l| l.len() <= WIDTH), "{s}");
        let back: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(back["pieces"][0]["floor"].as_array().unwrap().len(), 40);
    }
}
