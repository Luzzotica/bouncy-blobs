// The generic partii controller pieces, kept in ONE module so they can be
// swapped for partii-backend's `@partii/controller-kit` when it lands (the
// Rust twin is `crates/bb-net/src/play.rs`, to become `partii-play`). Nothing
// in here is Bouncy Blobs specific.
//
// * The 10-byte 0x50 input frame (partii docs/CONTROLLER.md) and its pacing.
// * The controller link: /c/<CODE>?k=<key>&e=<edge>&g=<game>.
// * Game → phone messages: seat, layout, rumble.

/** Button bits (docs/CONTROLLER.md). */
export const BUTTON = { PRIMARY: 1, SECONDARY: 2, START: 4, LEAVE: 8, CONFIRM: 16, BACK: 32 } as const;

/** Frames go out on a 16 ms tick: at once when anything changed, else every
 *  other tick (~30 Hz) as a heartbeat. */
export const TICK_MS = 16;
/** Shortest press the game is sent: a tap shorter than a frame interval
 *  would otherwise never reach it. */
export const MIN_PRESS_MS = 100;

/** One input frame. Sticks are -1..1 with +y DOWN. */
export function inputFrame(seq: number, lx: number, ly: number, rx: number, ry: number, buttons: number): Uint8Array {
  const b = new Uint8Array(10);
  const v = new DataView(b.buffer);
  // Round half away from zero, like Rust's f32::round (bb-net play.rs).
  const ax = (x: number) => {
    if (!Number.isFinite(x)) return 0;
    const v = Math.max(-1, Math.min(1, x)) * 127;
    return Math.sign(v) * Math.round(Math.abs(v));
  };
  b[0] = 0x50;
  v.setUint16(1, seq & 0xffff, true);
  v.setInt8(3, ax(lx));
  v.setInt8(4, ax(ly));
  v.setInt8(5, ax(rx));
  v.setInt8(6, ax(ry));
  v.setUint16(7, buttons & 0xffff, true);
  return b;
}

/** What a pad sends: left/right stick and the button bits. */
export interface PadState { lx: number; ly: number; rx: number; ry: number; buttons: number }

/** Paces frames: `tick()` every TICK_MS returns the frame to send, or null.
 *  Sends at once on a change, else on every other tick. */
export function framePacer() {
  let seq = 0;
  let last = '';
  return (s: PadState): Uint8Array | null => {
    const key = `${s.lx.toFixed(2)},${s.ly.toFixed(2)},${s.rx.toFixed(2)},${s.ry.toFixed(2)},${s.buttons}`;
    if (key !== last || seq % 2 === 0) {
      last = key;
      return inputFrame(++seq, s.lx, s.ly, s.rx, s.ry, s.buttons);
    }
    seq++;
    return null;
  };
}

/** A button bit held at least MIN_PRESS_MS. `press()` on finger down,
 *  `release()` on up; `bits()` is what to send now. */
export function holdBits() {
  let held = 0;
  const pressedAt: Record<number, number> = {};
  return {
    press(bit: number) {
      held |= bit;
      pressedAt[bit] = performance.now();
    },
    release(bit: number) {
      const at = pressedAt[bit] ?? 0;
      const left = MIN_PRESS_MS - (performance.now() - at);
      if (left <= 0) {
        held &= ~bit;
        return;
      }
      setTimeout(() => {
        // Pressed again meanwhile: that press owns the bit now.
        if (pressedAt[bit] === at) held &= ~bit;
      }, left);
    },
    bits: () => held,
  };
}

/** The room code in a controller path: /c/CODE (QR link), /p/CODE, or the
 *  older /controller/CODE. */
export function codeFromPath(path: string): string | null {
  const m = /^\/(?:c|p|controller)\/([A-Za-z0-9]{4,8})/.exec(path);
  return m ? m[1].toUpperCase() : null;
}

/** The link params that must survive /join → /c/CODE (k, e, g). */
export function carriedQuery(search: string = location.search): string {
  const q = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const k of ['k', 'e', 'g']) {
    const v = q.get(k);
    if (v) out.set(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

/** A game → phone message (reliable JSON). */
export type GameMsg =
  | { t: 'seat'; label: string; color: string }
  | { t: 'layout'; buttons: string[] }
  | { t: 'rumble'; ms: number };

/** Parse a standard game → phone message, or null for anything else. */
export function parseGameMsg(m: any): GameMsg | null {
  if (!m || typeof m.t !== 'string') return null;
  if (m.t === 'seat' && typeof m.label === 'string') return { t: 'seat', label: m.label, color: String(m.color ?? '') };
  if (m.t === 'layout' && Array.isArray(m.buttons)) return { t: 'layout', buttons: m.buttons.map(String) };
  if (m.t === 'rumble') return { t: 'rumble', ms: Number(m.ms) || 80 };
  return null;
}

/** Vibrate for a rumble message (capped at 400 ms). */
export function rumble(ms: number) {
  try { navigator.vibrate?.(Math.min(Math.max(ms, 0), 400)); } catch { /* not allowed */ }
}

/** partii's standard greeting. */
export function helloMsg(name: string, player: string | null = null, profile: unknown = null): string {
  return JSON.stringify({ t: 'hello', name, player, profile });
}
