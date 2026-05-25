// ─────────────────────────────────────────────────────────────────────────────
// Binary wire protocol — host → guest world snapshot frames.
//
// Two record formats, both share the same magic-byte / header / tick / count
// prefix:
//
// PlayerRecord (root + offsets, per the PDF spec):
//   f32 rootX,rootY + u16 activeMask + (i16 ox, i16 oy)*popcount(mask),
//   plus the player extras (move/expand/flags/score).
//   Quantized: offsets in ±MAX_OFFSET px. Players have exactly 16 hull nodes
//   (circle16 preset) and a blob radius of ~50 px, so the offset format is a
//   clean fit with sub-pixel quantum.
//
// WorldRecord (absolute positions, all nodes):
//   f32 rootX,rootY (centroid — used for settled / proximity, not for delta
//   reconstruction) + u8 flags + u16 nodeCount + (f32 x, f32 y) per node.
//   World objects (soft platforms, point shapes, NPC blobs) can have arbitrary
//   particle counts and arbitrary spans (a 560-wide platform's hull stretches
//   well beyond MAX_OFFSET), so the offset+mask format doesn't fit them.
//   Absolute f32 positions cost ~8 bytes/node but remove the cap and the
//   clamping artifacts entirely.
//
// Metadata that rarely changes (player name, color, face id, score, scoreboard
// state) rides the reliable channel as JSON ReliableEvents. The binary
// snapshot is purely physics state — bandwidth-critical.
//
// Quantization:
//   PlayerRecord offset:    int16, range = ±MAX_OFFSET px (default 200)
//   move:                   int16, range = ±1.0
//   expandScale:            uint16, range = [0, EXPAND_RANGE] (default 2.0)
// ─────────────────────────────────────────────────────────────────────────────

/** Magic byte at index 0 of every encoded frame. Lets receivers cheaply
 * distinguish binary world-snapshot frames from text JSON reliable events
 * (which always start with a printable ASCII char like `{` or `[`). 0x00 is
 * not a valid first byte of any UTF-8 JSON document. */
export const BINARY_MAGIC = 0x00;
export const WIRE_VERSION = 1;
export const MAX_OFFSET = 200; // px — covers hull deformation with headroom
// `expandShapeScale` can ramp all the way to `expandShapeScaleMax` (default 3.0,
// clamped to [0.35, 3.5] in `setExpandStateExternal`). Anything below this
// ceiling would silently clamp the guest's expand integrator below the host's
// value during quantization — the guest would then integrate forward from a
// LOWER value than the host, producing different `shapeMatchRestScale`,
// different spring/shape-match forces, and visible drift on the very next
// physics tick. Use 4 to give a small headroom above 3.5 so the worst case
// is still represented exactly through the round trip.
export const EXPAND_RANGE = 4;

const KEYFRAME_BIT = 0x01;
const FLAG_EXPANDING = 0x01;
const FLAG_SETTLED = 0x02;

export const ENTITY_KIND_PLAYER = 0;
export const ENTITY_KIND_NPC = 1;
export const ENTITY_KIND_PLATFORM = 2;
export const ENTITY_KIND_POINT_SHAPE = 3;

export interface EntityOffset {
  idx: number;
  ox: number;
  oy: number;
  /** Absolute particle velocity in world space. Critical for keyframe sync —
   * snapping positions without velocities lets the local sim drive the
   * particle out of place on the next physics step, defeating the snap. */
  vx: number;
  vy: number;
}

export interface PlayerRecord {
  id: string;
  rootX: number;
  rootY: number;
  /** Velocity of the root (center) particle. */
  rootVx: number;
  rootVy: number;
  /** Hull-node offsets + velocities. Only entries whose index bit is set
   * in `activeMask` are encoded. */
  activeMask: number;
  offsets: EntityOffset[];
  // Player extras
  moveX: number;        // -1..1
  moveY: number;        // -1..1
  expandScale: number;  // 0..EXPAND_RANGE
  expanding: boolean;
  settled: boolean;
  score: number;
}

export interface WorldNode { x: number; y: number; vx: number; vy: number }

export interface WorldRecord {
  kind: typeof ENTITY_KIND_NPC | typeof ENTITY_KIND_PLATFORM | typeof ENTITY_KIND_POINT_SHAPE;
  id: string;
  /** Centroid — used for camera/settled/proximity, not for reconstructing
   * node positions (those are absolute on the wire). */
  rootX: number;
  rootY: number;
  settled: boolean;
  /** Absolute world positions + velocities for ALL particles in this
   * entity, in the same order the level loader produced them. */
  nodes: WorldNode[];
}

export interface SnapshotFrame {
  version: number;
  isKeyframe: boolean;
  tick: number;
  players: PlayerRecord[];
  world: WorldRecord[];
}

// ── Quantization helpers ────────────────────────────────────────────────────

function q16Signed(v: number, range: number): number {
  const clamped = Math.max(-range, Math.min(range, v));
  return Math.round((clamped / range) * 32767);
}
function dqSigned(q: number, range: number): number {
  return (q / 32767) * range;
}
function q16Unsigned(v: number, range: number): number {
  const clamped = Math.max(0, Math.min(range, v));
  return Math.round((clamped / range) * 65535);
}
function dqUnsigned(q: number, range: number): number {
  return (q / 65535) * range;
}

function popcount16(x: number): number {
  x &= 0xffff;
  x = x - ((x >> 1) & 0x5555);
  x = (x & 0x3333) + ((x >> 2) & 0x3333);
  x = (x + (x >> 4)) & 0x0f0f;
  return (x * 0x0101) >> 8 & 0xff;
}

// ── Sizing ──────────────────────────────────────────────────────────────────

const TE = new TextEncoder();
const TD = new TextDecoder();

function idBytesLen(id: string): number {
  return Math.min(255, TE.encode(id).length);
}

function sizePlayerRecord(p: PlayerRecord): number {
  const idLen = idBytesLen(p.id);
  const nodeBlockSize = popcount16(p.activeMask) * 12; // 2*i16 offset + 2*f32 velocity
  return 1 + idLen +    // u8 idLen + bytes
         4 + 4 +        // f32 rootX, rootY
         4 + 4 +        // f32 rootVx, rootVy
         2 +            // u16 activeMask
         nodeBlockSize +
         2 + 2 +        // i16 moveX_q, moveY_q
         2 +            // u16 expandScale_q
         1 +            // u8 flags
         4;             // f32 score
}

function sizeWorldRecord(w: WorldRecord): number {
  const idLen = idBytesLen(w.id);
  return 1 +            // u8 kind
         1 + idLen +    // u8 idLen + bytes
         1 +            // u8 flags
         4 + 4 +        // f32 rootX, rootY
         2 +            // u16 nodeCount
         w.nodes.length * 16; // f32 x + f32 y + f32 vx + f32 vy per node
}

// ── Encoder ─────────────────────────────────────────────────────────────────

export function encodeSnapshot(frame: SnapshotFrame): ArrayBuffer {
  let total = 9; // 1 magic + 8 header
  for (const p of frame.players) total += sizePlayerRecord(p);
  for (const w of frame.world) total += sizeWorldRecord(w);

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;

  dv.setUint8(p, BINARY_MAGIC); p += 1;
  // Header: 1 magic + 1 ver + 1 flags + 4 tick (u32) + 1 playerCount + 1 worldCount
  dv.setUint8(p, frame.version); p += 1;
  dv.setUint8(p, frame.isKeyframe ? KEYFRAME_BIT : 0); p += 1;
  dv.setUint32(p, frame.tick >>> 0, true); p += 4;
  dv.setUint8(p, frame.players.length); p += 1;
  dv.setUint8(p, frame.world.length); p += 1;

  for (const pr of frame.players) {
    const idBytes = TE.encode(pr.id).slice(0, 255);
    dv.setUint8(p, idBytes.length); p += 1;
    u8.set(idBytes, p); p += idBytes.length;
    dv.setFloat32(p, pr.rootX, true); p += 4;
    dv.setFloat32(p, pr.rootY, true); p += 4;
    dv.setFloat32(p, pr.rootVx, true); p += 4;
    dv.setFloat32(p, pr.rootVy, true); p += 4;
    dv.setUint16(p, pr.activeMask & 0xffff, true); p += 2;
    for (let i = 0; i < 16; i++) {
      if (!(pr.activeMask & (1 << i))) continue;
      const off = pr.offsets.find((o) => o.idx === i);
      const ox = off ? off.ox : 0;
      const oy = off ? off.oy : 0;
      const vx = off ? off.vx : 0;
      const vy = off ? off.vy : 0;
      dv.setInt16(p, q16Signed(ox, MAX_OFFSET), true); p += 2;
      dv.setInt16(p, q16Signed(oy, MAX_OFFSET), true); p += 2;
      dv.setFloat32(p, vx, true); p += 4;
      dv.setFloat32(p, vy, true); p += 4;
    }
    dv.setInt16(p, q16Signed(pr.moveX, 1), true); p += 2;
    dv.setInt16(p, q16Signed(pr.moveY, 1), true); p += 2;
    dv.setUint16(p, q16Unsigned(pr.expandScale, EXPAND_RANGE), true); p += 2;
    let flags = 0;
    if (pr.expanding) flags |= FLAG_EXPANDING;
    if (pr.settled) flags |= FLAG_SETTLED;
    dv.setUint8(p, flags); p += 1;
    dv.setFloat32(p, pr.score, true); p += 4;
  }

  for (const wr of frame.world) {
    dv.setUint8(p, wr.kind); p += 1;
    const idBytes = TE.encode(wr.id).slice(0, 255);
    dv.setUint8(p, idBytes.length); p += 1;
    u8.set(idBytes, p); p += idBytes.length;
    let flags = 0;
    if (wr.settled) flags |= FLAG_SETTLED;
    dv.setUint8(p, flags); p += 1;
    dv.setFloat32(p, wr.rootX, true); p += 4;
    dv.setFloat32(p, wr.rootY, true); p += 4;
    const count = Math.min(wr.nodes.length, 0xffff);
    dv.setUint16(p, count, true); p += 2;
    for (let i = 0; i < count; i++) {
      const n = wr.nodes[i];
      dv.setFloat32(p, n.x, true); p += 4;
      dv.setFloat32(p, n.y, true); p += 4;
      dv.setFloat32(p, n.vx, true); p += 4;
      dv.setFloat32(p, n.vy, true); p += 4;
    }
  }

  return buf;
}

// ── Decoder ─────────────────────────────────────────────────────────────────

export function decodeSnapshot(data: ArrayBuffer | Uint8Array): SnapshotFrame | null {
  const buf = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
  if (buf.byteLength < 9) return null;
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;

  // Magic byte
  if (dv.getUint8(p) !== BINARY_MAGIC) return null;
  p += 1;

  const version = dv.getUint8(p); p += 1;
  if (version !== WIRE_VERSION) return null;
  const flags = dv.getUint8(p); p += 1;
  const isKeyframe = !!(flags & KEYFRAME_BIT);
  const tick = dv.getUint32(p, true); p += 4;
  const playerCount = dv.getUint8(p); p += 1;
  const worldCount = dv.getUint8(p); p += 1;

  const players: PlayerRecord[] = [];
  try {
    for (let n = 0; n < playerCount; n++) {
      const idLen = dv.getUint8(p); p += 1;
      const id = TD.decode(u8.subarray(p, p + idLen)); p += idLen;
      const rootX = dv.getFloat32(p, true); p += 4;
      const rootY = dv.getFloat32(p, true); p += 4;
      const rootVx = dv.getFloat32(p, true); p += 4;
      const rootVy = dv.getFloat32(p, true); p += 4;
      const activeMask = dv.getUint16(p, true); p += 2;
      const offsets: EntityOffset[] = [];
      for (let i = 0; i < 16; i++) {
        if (!(activeMask & (1 << i))) continue;
        const ox = dqSigned(dv.getInt16(p, true), MAX_OFFSET); p += 2;
        const oy = dqSigned(dv.getInt16(p, true), MAX_OFFSET); p += 2;
        const vx = dv.getFloat32(p, true); p += 4;
        const vy = dv.getFloat32(p, true); p += 4;
        offsets.push({ idx: i, ox, oy, vx, vy });
      }
      const moveX = dqSigned(dv.getInt16(p, true), 1); p += 2;
      const moveY = dqSigned(dv.getInt16(p, true), 1); p += 2;
      const expandScale = dqUnsigned(dv.getUint16(p, true), EXPAND_RANGE); p += 2;
      const pflags = dv.getUint8(p); p += 1;
      const score = dv.getFloat32(p, true); p += 4;
      players.push({
        id, rootX, rootY, rootVx, rootVy, activeMask, offsets,
        moveX, moveY, expandScale,
        expanding: !!(pflags & FLAG_EXPANDING),
        settled: !!(pflags & FLAG_SETTLED),
        score,
      });
    }

    const world: WorldRecord[] = [];
    for (let n = 0; n < worldCount; n++) {
      const kind = dv.getUint8(p) as WorldRecord["kind"]; p += 1;
      const idLen = dv.getUint8(p); p += 1;
      const id = TD.decode(u8.subarray(p, p + idLen)); p += idLen;
      const wflags = dv.getUint8(p); p += 1;
      const rootX = dv.getFloat32(p, true); p += 4;
      const rootY = dv.getFloat32(p, true); p += 4;
      const nodeCount = dv.getUint16(p, true); p += 2;
      const nodes: WorldNode[] = new Array(nodeCount);
      for (let i = 0; i < nodeCount; i++) {
        const x = dv.getFloat32(p, true); p += 4;
        const y = dv.getFloat32(p, true); p += 4;
        const vx = dv.getFloat32(p, true); p += 4;
        const vy = dv.getFloat32(p, true); p += 4;
        nodes[i] = { x, y, vx, vy };
      }
      world.push({ kind, id, rootX, rootY, settled: !!(wflags & FLAG_SETTLED), nodes });
    }

    return { version, isKeyframe, tick, players, world };
  } catch {
    return null;
  }
}
