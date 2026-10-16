// The input frame's golden vectors, shared with bb-net (crates/bb-net/src/
// play.rs `frame_golden_vector`), plus pacing and the minimum press.
//   node test/frame.test.mjs
import assert from "node:assert/strict";
import { inputFrame, framePacer, holdBits, codeFromPath, carriedQuery, parseGameMsg, BUTTON, MIN_PRESS_MS } from "../src/lib/play.ts";

assert.deepEqual([...inputFrame(0x0102, 1, -1, 0, 0.5, BUTTON.PRIMARY | BUTTON.CONFIRM)], [0x50, 0x02, 0x01, 127, 0x81, 0, 64, 17, 0, 0]);
assert.deepEqual([...inputFrame(0x1ffff, -0.5, 9, NaN, 0, 0)].slice(1, 7), [0xff, 0xff, 0xc0, 127, 0, 0]); // -63.5 → -64, clamp, NaN → 0

// ~30 Hz at rest, at once on a change.
const pace = framePacer();
const still = { lx: 0, ly: 0, rx: 0, ry: 0, buttons: 0 };
const sent = Array.from({ length: 10 }, () => pace(still)).filter(Boolean).length;
assert.equal(sent, 5);
assert.ok(pace({ ...still, lx: 1 }), "a change goes out at once");
const seqs = [pace(still), pace(still), pace(still)].filter(Boolean).map((f) => f[1] | (f[2] << 8));
assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "seq keeps rising");

// A 0 ms tap stays down for MIN_PRESS_MS.
const h = holdBits();
h.press(BUTTON.PRIMARY);
h.release(BUTTON.PRIMARY);
assert.equal(h.bits(), BUTTON.PRIMARY);
await new Promise((r) => setTimeout(r, MIN_PRESS_MS + 20));
assert.equal(h.bits(), 0);

assert.equal(codeFromPath("/c/kxqpt"), "KXQPT");
assert.equal(codeFromPath("/controller/ABCDE"), "ABCDE");
assert.equal(codeFromPath("/join"), null);
assert.equal(carriedQuery("?k=pk&e=https%3A%2F%2Fx&g=bouncy-blobs&z=1"), "?k=pk&e=https%3A%2F%2Fx&g=bouncy-blobs");
assert.deepEqual(parseGameMsg({ t: "seat", label: "P2", color: "#3b82f6" }), { t: "seat", label: "P2", color: "#3b82f6" });
assert.deepEqual(parseGameMsg({ t: "layout", buttons: ["EXPAND"] }), { t: "layout", buttons: ["EXPAND"] });
assert.equal(parseGameMsg({ type: "customization_update" }), null);
console.log(JSON.stringify({ ok: true, test: "frame" }));
