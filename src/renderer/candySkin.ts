// Candy / jelly skin system. Two primitives — `drawHardCandy` for solid
// crystalline surfaces (static platforms, ice, spike crystals) and
// `drawJellyCandy` for gummy/taffy surfaces (soft platforms, sticky walls,
// bouncy pads). Each material picks a primitive + palette via
// MATERIAL_SKINS. Tune the look by editing palettes; tune the feel by
// editing the primitives.

import { Vec2 } from '../physics/vec2';
import { isCave, CAVE_PLATFORM_FILL } from './colors';
import { makeScratchCanvas } from './scratchCanvas';

export interface CandyPalette {
  /** Solid base fill, fully opaque hex. Translucency comes from the
   * primitive layering — keep this saturated. */
  base: string;
  /** Deeper shade of the base used for the inner shadow rim. */
  deep: string;
  /** Top-light specular tint — usually a near-white at low alpha. */
  highlight: string;
  /** Hard candy: dark stroke around the silhouette. Jelly skips it. */
  outline?: string;
  /** If true, sprinkle a fine sugar-grain texture inside the silhouette. */
  sugar?: boolean;
}

export type CandyPrimitive = 'hard' | 'jelly';

export interface MaterialSkin {
  primitive: CandyPrimitive;
  palette: CandyPalette;
}

// ── Palettes ────────────────────────────────────────────────────────────
const PALETTE_CHERRY: CandyPalette = {
  base: '#d63b56',
  deep: '#7a1d2e',
  highlight: 'rgba(255,255,255,0.55)',
  outline: '#3a0e18',
  sugar: false,
};

const PALETTE_BLUE_GLASS: CandyPalette = {
  base: '#7ec8ff',
  deep: '#2c6fa8',
  highlight: 'rgba(255,255,255,0.7)',
  outline: '#143a5e',
  sugar: true,
};

const PALETTE_GRAPE_TAFFY: CandyPalette = {
  base: '#b06ad9',
  deep: '#5b2a82',
  highlight: 'rgba(255,235,255,0.5)',
  // jelly — no outline
};

const PALETTE_ORANGE_GUMMY: CandyPalette = {
  base: '#ff8a3d',
  deep: '#a44a14',
  highlight: 'rgba(255,245,210,0.55)',
};

export const SOFT_PLATFORM_PALETTE: CandyPalette = {
  base: '#7adf78',
  deep: '#2d6a37',
  highlight: 'rgba(255,255,255,0.5)',
};

export const SPIKE_CRYSTAL_PALETTE: CandyPalette = {
  base: '#ff5773',
  deep: '#7a0d23',
  highlight: 'rgba(255,255,255,0.85)',
  outline: '#3a0411',
  sugar: true,
};

export const SPIKE_BASE_PALETTE: CandyPalette = {
  base: '#c98a3a',
  deep: '#5e3a14',
  highlight: 'rgba(255,235,200,0.55)',
  outline: '#3b1f08',
};

// Cave theme: black spike body. A separate red-tip glow (drawn in
// spikeManager) supplies the warm warning cue, so these stay near-black.
export const SPIKE_CRYSTAL_PALETTE_CAVE: CandyPalette = {
  base: '#0a0a0c',
  deep: '#000000',
  highlight: 'rgba(255,80,100,0.10)',
  outline: '#000000',
};

export const SPIKE_BASE_PALETTE_CAVE: CandyPalette = {
  base: '#050507',
  deep: '#000000',
  highlight: 'rgba(120,160,200,0.06)',
  outline: '#000000',
};

export const MATERIAL_SKINS: Record<string, MaterialSkin> = {
  default: { primitive: 'hard',  palette: PALETTE_CHERRY },
  ice:     { primitive: 'hard',  palette: PALETTE_BLUE_GLASS },
  sticky:  { primitive: 'jelly', palette: PALETTE_GRAPE_TAFFY },
  bouncy:  { primitive: 'jelly', palette: PALETTE_ORANGE_GUMMY },
};

/** Lightweight material → colors lookup for SVG previews. Returns the same
 * palette the canvas renderer uses, so previews stay in sync visually. */
export function materialPreviewColors(material: string | undefined): { fill: string; outline: string } {
  const skin = MATERIAL_SKINS[material ?? 'default'] ?? MATERIAL_SKINS.default;
  return {
    fill: skin.palette.base,
    outline: skin.palette.outline ?? skin.palette.deep,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────
interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

function polyBounds(poly: Vec2[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function tracePoly(ctx: CanvasRenderingContext2D, poly: Vec2[]): void {
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
}

/** Smoothed hull path — each vertex becomes a quadratic-bezier corner. `t`
 * in [0, 0.5] controls roundness. Matches the curve scheme used by
 * `drawBlob` so jelly platforms read as the same fluid silhouette. */
function traceSmoothPoly(ctx: CanvasRenderingContext2D, poly: Vec2[], t: number): void {
  const n = poly.length;
  const k = Math.max(0, Math.min(0.5, t));
  const cut = (from: Vec2, toward: Vec2, kk: number): Vec2 => ({
    x: from.x + (toward.x - from.x) * kk,
    y: from.y + (toward.y - from.y) * kk,
  });
  const entryFirst = cut(poly[0], poly[n - 1], k);
  ctx.beginPath();
  ctx.moveTo(entryFirst.x, entryFirst.y);
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const exit = cut(cur, nxt, k);
    ctx.quadraticCurveTo(cur.x, cur.y, exit.x, exit.y);
    const entryNext = cut(nxt, cur, k);
    ctx.lineTo(entryNext.x, entryNext.y);
  }
  ctx.closePath();
}

// ── Parallax + inclusions ───────────────────────────────────────────────
// "Frozen bubbles" / sugar specks suspended inside each candy. Generated
// once per shape (deterministic per AABB + cacheKey) and rendered with a
// small parallax offset so they appear to sit at slightly different depths
// inside the candy as the camera pans.

let parallaxX = 0;
let parallaxY = 0;
/** Renderer calls this once per frame with `camera.position` before drawing
 * any candy. Inclusions and fissures drift gently with the camera (and with
 * the shape's own motion relative to the camera) to fake interior depth. */
export function setCandyParallax(x: number, y: number): void {
  parallaxX = x;
  parallaxY = y;
}

// Strength of the parallax effect. The shift applied to each inclusion is
// `(shapeCenter − cameraPos) × depth × PARALLAX_FACTOR`, then clamped to a
// fraction of the shape's AABB so bubbles can't drift outside the candy
// silhouette no matter how far off-screen the shape is.
const PARALLAX_FACTOR = 0.1;
// Per-axis cap on the parallax shift, as a fraction of the shape's AABB
// half-size. Keeps bubbles visibly inside the candy even when the shape is
// near the edge of the viewport.
const PARALLAX_CLAMP_FRAC = 0.3;

interface Inclusion {
  /** Shape-local offset from the AABB center. */
  x: number;
  y: number;
  radius: number;
  /** 0..1 — higher values track the camera more (appear deeper inside). */
  depth: number;
  alpha: number;
  /** +1 = light speck (sugar bubble), -1 = dark facet. */
  shade: 1 | -1;
}

const inclusionCache = new Map<string, Inclusion[]>();

/** Translation + rotation invariant polygon signature. Hashes the SORTED
 * rounded edge lengths plus the vertex count — two polygons with the same
 * shape but different positions or rotations get the same hash, so the
 * inclusion/fissure cache stays hot through both translation and rotation.
 * Reflections share the hash too (acceptable trade — visually fine). */
function polySignature(poly: Vec2[]): number {
  const n = poly.length;
  if (n === 0) return 0;
  const edges: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    edges[i] = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
  }
  edges.sort((a, b) => a - b);
  let h = (n * 2654435761) >>> 0;
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h ^ edges[i], 2246822519) >>> 0);
    h = (Math.imul(h, 3266489917) >>> 0) ^ (h >>> 13);
  }
  return h >>> 0;
}

/** Per-shape coordinate frame: polygon centroid (origin) + orientation
 * (first-edge direction). All interior decoration (inclusions, fissures)
 * is stored in this LOCAL frame, then transformed into world coords at
 * draw time — so when the polygon rotates, its bubbles and layer bands
 * rotate with it. `halfW`/`halfH` are the OBB half-extents along the
 * local axes (rotation-invariant size). */
interface ShapeFrame {
  cx: number; cy: number;
  ux: number; uy: number;   // unit vector along local +X, in world coords
  vx: number; vy: number;   // unit vector along local +Y, in world coords
  halfW: number;
  halfH: number;
}

function computeShapeFrame(poly: Vec2[]): ShapeFrame {
  const n = poly.length;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += poly[i].x; cy += poly[i].y; }
  cx /= n;
  cy /= n;
  // Orient the frame off the first edge so rotations of the polygon carry
  // straight through to the local frame.
  let ux = 1, uy = 0;
  if (n >= 2) {
    const dx = poly[1].x - poly[0].x;
    const dy = poly[1].y - poly[0].y;
    const len = Math.hypot(dx, dy) || 1;
    ux = dx / len;
    uy = dy / len;
  }
  const vx = -uy;
  const vy =  ux;
  // OBB half-extents — project vertices onto the local axes.
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = poly[i].x - cx;
    const dy = poly[i].y - cy;
    const u = dx * ux + dy * uy;
    const v = dx * vx + dy * vy;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  return {
    cx, cy, ux, uy, vx, vy,
    halfW: Math.max(1, (maxU - minU) * 0.5),
    halfH: Math.max(1, (maxV - minV) * 0.5),
  };
}

function makeCacheKey(poly: Vec2[], primitive: CandyPrimitive, override: string | undefined): string {
  if (override) return `${primitive}|${override}`;
  return `${primitive}|sig${polySignature(poly)}`;
}

function generateInclusions(b: Bounds, primitive: CandyPrimitive, seedSalt: number, sig: number): Inclusion[] {
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const area = w * h;
  // One inclusion per ~1100 sq-px for jelly, ~1500 for hard candy. Floored
  // at 3 so even tiny shapes get a hint of texture; capped at 48 so a giant
  // floor doesn't trigger a fillrate explosion.
  // Hard candy is denser than jelly now — flecks carry the texture cue
  // since the sheen has been removed. Higher cap too so big platforms get
  // properly speckled rather than a few stray dots.
  const density = primitive === 'jelly' ? 1100 : 600;
  const capCount = primitive === 'jelly' ? 48 : 96;
  const count = Math.min(capCount, Math.max(3, Math.floor(area / density)));
  let seed = (sig
            ^ Math.imul(Math.round(w) | 0, 83492791)
            ^ Math.imul(Math.round(h) | 0, 50331653)
            ^ seedSalt) >>> 0;
  if (!seed) seed = 1;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) / 0x1000000;
  };
  const out: Inclusion[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: (rand() - 0.5) * w * 0.85,
      y: (rand() - 0.5) * h * 0.85,
      radius: primitive === 'jelly' ? 1.6 + rand() * 4.2 : 0.7 + rand() * 2.2,
      depth: 0.35 + rand() * 0.65,
      alpha: primitive === 'jelly' ? 0.18 + rand() * 0.28 : 0.22 + rand() * 0.34,
      shade: rand() < (primitive === 'jelly' ? 0.6 : 0.7) ? 1 : -1,
    });
  }
  return out;
}

/** Build local-frame Bounds (centered on origin) for the generator. The
 * generators consume size info — local bounds are rotation-invariant so
 * the cached pattern doesn't churn when the polygon rotates. */
function localBounds(frame: ShapeFrame): Bounds {
  return { minX: -frame.halfW, minY: -frame.halfH, maxX: frame.halfW, maxY: frame.halfH };
}

function getInclusions(poly: Vec2[], frame: ShapeFrame, primitive: CandyPrimitive, cacheKey: string | undefined): Inclusion[] {
  const key = makeCacheKey(poly, primitive, cacheKey);
  let inc = inclusionCache.get(key);
  if (!inc) {
    inc = generateInclusions(localBounds(frame), primitive, primitive === 'jelly' ? 0x9e3779b1 : 0x85ebca6b, polySignature(poly));
    inclusionCache.set(key, inc);
  }
  return inc;
}

// ── Fissures (layer lines) ──────────────────────────────────────────────
// Long lines that span the entire silhouette — the layered look of real
// hard candy where you can see the cooled sugar bands through the
// translucent body. Each fissure runs side to side through the shape and
// clips naturally against the candy outline.

/** Stable per-fissure parameters. The spine geometry is fixed at generation
 * time; only the parallax offset depends on the camera. */
interface FissureLine {
  /** Shape-local anchor point — fissure spine passes through here. */
  ax: number;
  ay: number;
  /** Unit direction along the spine. */
  dx: number;
  dy: number;
  /** Half-span — the spine runs from -half to +half along (dx, dy). */
  half: number;
  /** Number of segments along the spine. */
  steps: number;
  /** Width samples along the spine, length = steps+1, range ~0.4..1.0.
   * Multiplied by `baseWidth` to get the local ribbon width. */
  widthProfile: number[];
  /** Per-vertex perpendicular bow offset (length = steps+1). Static. */
  bowProfile: number[];
  /** Maximum ribbon width in world units. */
  baseWidth: number;
  alpha: number;
  /** 0..1 — parallax depth, same convention as inclusions. Different
   * fissures inside the same shape pick different depths so they drift at
   * different rates when the camera or shape moves. */
  depth: number;
}

const fissureCache = new Map<string, FissureLine[]>();
const FISSURE_STEPS = 16;

function generateFissures(b: Bounds, seedSalt: number, sig: number): FissureLine[] {
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const area = w * h;
  // Layers scale with area. Roughly half the previous density — fewer,
  // chunkier bands read better as layered candy than barber-pole stripes.
  const count = Math.min(6, Math.max(1, Math.floor(area / 7000)));
  let seed = (sig
            ^ Math.imul(Math.round(w) | 0, 83492791)
            ^ Math.imul(Math.round(h) | 0, 50331653)
            ^ seedSalt) >>> 0;
  if (!seed) seed = 1;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) / 0x1000000;
  };
  const diag = Math.hypot(w, h);
  const minDim = Math.min(w, h);
  const out: FissureLine[] = [];
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI;          // 0..π (direction is symmetric)
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // Width profile — smooth samples giving each fissure its own
    // pinched/swollen pattern along its length.
    const widthProfile: number[] = new Array(FISSURE_STEPS + 1);
    const raw: number[] = new Array(FISSURE_STEPS + 1);
    for (let s = 0; s <= FISSURE_STEPS; s++) raw[s] = 0.35 + rand() * 0.65;
    for (let s = 0; s <= FISSURE_STEPS; s++) {
      const a = raw[Math.max(0, s - 1)];
      const c = raw[s];
      const e = raw[Math.min(FISSURE_STEPS, s + 1)];
      widthProfile[s] = (a + c + c + e) * 0.25;
    }
    // Taper the ends so the ribbon pinches to a near-point before hitting
    // the silhouette edge, instead of butting flat against the clip path.
    for (let s = 0; s <= FISSURE_STEPS; s++) {
      const t = s / FISSURE_STEPS;
      const taper = Math.sin(t * Math.PI);    // 0 at ends, 1 at middle
      widthProfile[s] *= 0.15 + 0.85 * taper;
    }
    // Wavy bow profile — one global bow (peaks at midspan) plus two
    // higher-frequency sine harmonics with random phase. All multiplied by
    // an end-envelope so the line pinches to the spine at both tips. The
    // result is a layer-band that snakes along its length rather than
    // running ruler-straight.
    const bowAmp     = (rand() - 0.5) * minDim * 0.10;
    const wave1Amp   = (rand() - 0.5) * minDim * 0.07;
    const wave2Amp   = (rand() - 0.5) * minDim * 0.05;
    const wave1Freq  = 1.5 + rand() * 1.5;     // 1.5..3.0 full cycles
    const wave2Freq  = 3.5 + rand() * 2.5;     // 3.5..6.0 full cycles
    const wave1Phase = rand() * Math.PI * 2;
    const wave2Phase = rand() * Math.PI * 2;
    const bowProfile: number[] = new Array(FISSURE_STEPS + 1);
    for (let s = 0; s <= FISSURE_STEPS; s++) {
      const t = s / FISSURE_STEPS;
      const env = Math.sin(t * Math.PI);       // 0 at ends, 1 in middle
      const bow  = bowAmp * env;
      const wave =
        wave1Amp * Math.sin(t * wave1Freq * Math.PI * 2 + wave1Phase) +
        wave2Amp * Math.sin(t * wave2Freq * Math.PI * 2 + wave2Phase);
      bowProfile[s] = bow + wave * env;
    }
    out.push({
      ax: (rand() - 0.5) * w * 0.5,
      ay: (rand() - 0.5) * h * 0.5,
      dx,
      dy,
      half: diag * 0.85,
      steps: FISSURE_STEPS,
      widthProfile,
      bowProfile,
      // 8..32 px — peak width hits roughly the upper end thanks to the
      // width profile + taper; some fissures will read as fat bands, others
      // as slim accent layers.
      baseWidth: 8 + rand() * 24,
      alpha: 0.15 + rand() * 0.15,
      depth: 0.15 + rand() * 0.55,
    });
  }
  return out;
}

function getFissures(poly: Vec2[], frame: ShapeFrame, cacheKey: string | undefined): FissureLine[] {
  const key = makeCacheKey(poly, 'hard', cacheKey) + '|fissures';
  let f = fissureCache.get(key);
  if (!f) {
    f = generateFissures(localBounds(frame), 0xc2b2ae35, polySignature(poly));
    fissureCache.set(key, f);
  }
  return f;
}

function drawFissures(
  ctx: CanvasRenderingContext2D,
  frame: ShapeFrame,
  palette: CandyPalette,
  fissures: FissureLine[],
): void {
  if (fissures.length === 0) return;
  // Parallax shift is in world axes — the camera moves in world space, not
  // local. Convert it into local-X / local-Y components via the frame so
  // we can clamp + apply in the rotation-aware draw path.
  const maxShiftU = frame.halfW * PARALLAX_CLAMP_FRAC;
  const maxShiftV = frame.halfH * PARALLAX_CLAMP_FRAC;
  const dxw = (frame.cx - parallaxX) * PARALLAX_FACTOR;
  const dyw = (frame.cy - parallaxY) * PARALLAX_FACTOR;
  // World→local axis projection.
  const rawAxisU = dxw * frame.ux + dyw * frame.uy;
  const rawAxisV = dxw * frame.vx + dyw * frame.vy;
  ctx.fillStyle = palette.outline ?? palette.deep;
  for (const f of fissures) {
    let su = rawAxisU * f.depth;
    let sv = rawAxisV * f.depth;
    if (su >  maxShiftU) su =  maxShiftU; else if (su < -maxShiftU) su = -maxShiftU;
    if (sv >  maxShiftV) sv =  maxShiftV; else if (sv < -maxShiftV) sv = -maxShiftV;
    // Local-frame spine direction: f.dx / f.dy are unit vectors in the
    // shape's own coordinate system (saved at generation, rotation-stable
    // because the shape signature is rotation-invariant).
    const pdx = -f.dy; // perpendicular in local frame
    const pdy =  f.dx;
    const left:  { x: number; y: number }[] = new Array(f.steps + 1);
    const right: { x: number; y: number }[] = new Array(f.steps + 1);
    for (let s = 0; s <= f.steps; s++) {
      const t = (s / f.steps) * 2 - 1;
      const along = t * f.half;
      const perp = f.bowProfile[s];
      // Spine point in LOCAL coords.
      const lu = f.ax + f.dx * along + pdx * perp - su;
      const lv = f.ay + f.dy * along + pdy * perp - sv;
      const halfWidth = f.baseWidth * f.widthProfile[s] * 0.5;
      const ll_u = lu + pdx * halfWidth;
      const ll_v = lv + pdy * halfWidth;
      const lr_u = lu - pdx * halfWidth;
      const lr_v = lv - pdy * halfWidth;
      // Local → world via frame axes.
      left[s]  = {
        x: frame.cx + ll_u * frame.ux + ll_v * frame.vx,
        y: frame.cy + ll_u * frame.uy + ll_v * frame.vy,
      };
      right[s] = {
        x: frame.cx + lr_u * frame.ux + lr_v * frame.vx,
        y: frame.cy + lr_u * frame.uy + lr_v * frame.vy,
      };
    }
    ctx.globalAlpha = f.alpha;
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (let s = 1; s <= f.steps; s++) ctx.lineTo(left[s].x, left[s].y);
    for (let s = f.steps; s >= 0; s--) ctx.lineTo(right[s].x, right[s].y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawInclusions(
  ctx: CanvasRenderingContext2D,
  frame: ShapeFrame,
  palette: CandyPalette,
  inclusions: Inclusion[],
): void {
  // Parallax in world axes, projected into local — same approach as
  // drawFissures. Clamped to a fraction of the OBB so bubbles never drift
  // outside the silhouette.
  const maxShiftU = frame.halfW * PARALLAX_CLAMP_FRAC;
  const maxShiftV = frame.halfH * PARALLAX_CLAMP_FRAC;
  const dxw = (frame.cx - parallaxX) * PARALLAX_FACTOR;
  const dyw = (frame.cy - parallaxY) * PARALLAX_FACTOR;
  const rawAxisU = dxw * frame.ux + dyw * frame.uy;
  const rawAxisV = dxw * frame.vx + dyw * frame.vy;
  const computeOffset = (inc: Inclusion): { x: number; y: number } => {
    let su = rawAxisU * inc.depth;
    let sv = rawAxisV * inc.depth;
    if (su >  maxShiftU) su =  maxShiftU; else if (su < -maxShiftU) su = -maxShiftU;
    if (sv >  maxShiftV) sv =  maxShiftV; else if (sv < -maxShiftV) sv = -maxShiftV;
    // Subtract: bubbles lag the surface motion like real interior parallax.
    const lu = inc.x - su;
    const lv = inc.y - sv;
    return {
      x: frame.cx + lu * frame.ux + lv * frame.vx,
      y: frame.cy + lu * frame.uy + lv * frame.vy,
    };
  };

  // Two passes so we can batch fillStyle changes — all light specks first,
  // then dark facets. Cheaper than flipping fillStyle per bubble.
  ctx.fillStyle = 'rgba(255,255,255,1)';
  for (const inc of inclusions) {
    if (inc.shade !== 1) continue;
    const o = computeOffset(inc);
    ctx.globalAlpha = inc.alpha;
    ctx.beginPath();
    ctx.arc(o.x, o.y, inc.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = palette.deep;
  for (const inc of inclusions) {
    if (inc.shade !== -1) continue;
    const o = computeOffset(inc);
    ctx.globalAlpha = inc.alpha * 0.55;
    ctx.beginPath();
    ctx.arc(o.x, o.y, inc.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Single shared sugar-grain pattern. Built lazily on first use, cached
// forever — it's a 64×64 noise tile, cost is negligible.
let sugarPattern: CanvasPattern | null = null;
let sugarPatternCtx: CanvasRenderingContext2D | null = null;
function getSugarPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (sugarPattern && sugarPatternCtx === ctx) return sugarPattern;
  const scratch = makeScratchCanvas(64, 64);
  if (!scratch) return null;
  const pctx = scratch.ctx;
  pctx.clearRect(0, 0, 64, 64);
  // Deterministic grain so it doesn't flicker between rebuilds.
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed & 0xffffff) / 0xffffff;
  };
  for (let i = 0; i < 110; i++) {
    const x = rand() * 64;
    const y = rand() * 64;
    const r = 0.4 + rand() * 0.9;
    pctx.fillStyle = `rgba(255,255,255,${(0.35 + rand() * 0.4).toFixed(3)})`;
    pctx.fillRect(x, y, r, r);
  }
  sugarPattern = ctx.createPattern(scratch.image, 'repeat');
  sugarPatternCtx = ctx;
  return sugarPattern;
}

// ── Hard candy ──────────────────────────────────────────────────────────
/** Hard-candy primitive. Reads as a solid translucent crystal with a sharp
 * outline, a diagonal volume gradient, and a glossy highlight in the upper-
 * left quadrant. Optional sugar-grain for rock-candy / glass variants. */
export function drawHardCandy(
  ctx: CanvasRenderingContext2D,
  poly: Vec2[],
  palette: CandyPalette,
  cacheKey?: string,
): void {
  if (poly.length < 3) return;
  const b = polyBounds(poly);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;

  ctx.save();
  tracePoly(ctx, poly);
  ctx.save();
  ctx.clip();

  // 1. Base fill — saturated, slightly translucent so the background tint
  //    bleeds through and reads as candy not paint.
  ctx.fillStyle = palette.base;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(b.minX - 1, b.minY - 1, w + 2, h + 2);
  ctx.globalAlpha = 1;

  // 2. Deep-shade vignette in the lower-right corner — gives volume without
  //    the white sheen of the old linear gradient. Subtle, no whites.
  const volGrad = ctx.createLinearGradient(b.minX, b.minY, b.maxX, b.maxY);
  volGrad.addColorStop(0, 'rgba(0,0,0,0)');
  volGrad.addColorStop(0.6, 'rgba(0,0,0,0)');
  volGrad.addColorStop(1, palette.deep);
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = volGrad;
  ctx.fillRect(b.minX - 1, b.minY - 1, w + 2, h + 2);
  ctx.globalAlpha = 1;

  // 3. Sugar grain (optional, rock-candy palettes only).
  if (palette.sugar) {
    const pat = getSugarPattern(ctx);
    if (pat) {
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = pat;
      ctx.fillRect(b.minX, b.minY, w, h);
      ctx.globalAlpha = 1;
    }
  }

  // 4. Frozen inclusions — parallaxed sugar bubbles + dark facets. Now the
  //    primary texture cue (sheen removed). Stored in the polygon's local
  //    frame so they rotate with it.
  const frame = computeShapeFrame(poly);
  drawInclusions(ctx, frame, palette, getInclusions(poly, frame, 'hard', cacheKey));

  // Fissures intentionally not drawn — they read as confusing visual
  // noise on a small platform rather than a candy layer. Generator/
  // ribbon code kept in this file in case we want to re-introduce them
  // for chunkier candy props later.

  ctx.restore(); // drop clip

  // 7. Outline. Drawn last so it sits crisp on top of every fill layer.
  if (palette.outline) {
    tracePoly(ctx, poly);
    ctx.strokeStyle = palette.outline;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  ctx.restore();
}

// ── Jelly candy ─────────────────────────────────────────────────────────
/** Jelly / gummy / taffy primitive. No hard outline — the silhouette is
 * defined by a soft inner-rim shadow plus a wide diffuse highlight in the
 * top half. Reads as squishy translucent confectionery.
 *
 * `cornerRoundness` matches the convention used by `drawBlob`
 * (0 = polygon, 0.5 = fully smoothed). Pass 0 for sharp-cornered jelly
 * cubes, ~0.18 to match the existing soft-platform look. */
export function drawJellyCandy(
  ctx: CanvasRenderingContext2D,
  poly: Vec2[],
  palette: CandyPalette,
  cornerRoundness = 0.18,
  cacheKey?: string,
): void {
  if (poly.length < 3) return;
  const b = polyBounds(poly);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const cx = (b.minX + b.maxX) * 0.5;
  const cy = (b.minY + b.maxY) * 0.5;
  const diag = Math.hypot(w, h);

  ctx.save();
  traceSmoothPoly(ctx, poly, cornerRoundness);
  ctx.save();
  ctx.clip();

  // 1. Base fill — softer alpha than hard candy so it reads as gelatinous.
  ctx.fillStyle = palette.base;
  ctx.globalAlpha = 0.88;
  ctx.fillRect(b.minX - 1, b.minY - 1, w + 2, h + 2);
  ctx.globalAlpha = 1;

  // 2. Radial volume — bright at center, drops to `deep` near edges. Gummy
  //    bears read brightest in the middle of the body, darker around the
  //    rim where the material is thicker visually.
  const radGrad = ctx.createRadialGradient(cx, cy, diag * 0.05, cx, cy, diag * 0.62);
  radGrad.addColorStop(0, 'rgba(255,255,255,0.18)');
  radGrad.addColorStop(0.6, 'rgba(255,255,255,0)');
  radGrad.addColorStop(1, palette.deep);
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = radGrad;
  ctx.fillRect(b.minX - 1, b.minY - 1, w + 2, h + 2);
  ctx.globalAlpha = 1;

  // 3. Top-half diffuse highlight — soft elliptical wash, wider and gentler
  //    than the hard-candy gloss. This is the signature "wet gummy" cue.
  const hlGrad = ctx.createRadialGradient(
    cx, cy - h * 0.32, diag * 0.02,
    cx, cy - h * 0.32, diag * 0.55,
  );
  hlGrad.addColorStop(0, palette.highlight);
  hlGrad.addColorStop(0.45, 'rgba(255,255,255,0.08)');
  hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hlGrad;
  ctx.fillRect(b.minX - 1, b.minY - 1, w + 2, h + 2);

  // 4. Sugar grain (sour-gummy variant).
  if (palette.sugar) {
    const pat = getSugarPattern(ctx);
    if (pat) {
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = pat;
      ctx.fillRect(b.minX, b.minY, w, h);
      ctx.globalAlpha = 1;
    }
  }

  // 5. Frozen inclusions — bigger, softer bubbles for jelly.
  const frame = computeShapeFrame(poly);
  drawInclusions(ctx, frame, palette, getInclusions(poly, frame, 'jelly', cacheKey));

  ctx.restore(); // drop clip

  // 6. Soft inner-rim shadow. We re-trace the smoothed path and stroke it
  //    with a thick, darker, low-alpha line clipped INSIDE the silhouette.
  //    Result: a velvety darker halo just inside the edge — the gummy look
  //    instead of a hard cartoon outline.
  ctx.save();
  traceSmoothPoly(ctx, poly, cornerRoundness);
  ctx.clip();
  traceSmoothPoly(ctx, poly, cornerRoundness);
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, Math.min(10, diag * 0.04));
  ctx.strokeStyle = palette.deep;
  ctx.globalAlpha = 0.45;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();

  ctx.restore();
}

// ── Flat fill (cave theme) ──────────────────────────────────────────────
/** Draw a solid, flat-filled silhouette — no gradients, inclusions, rim or
 * outline. Used by the cave theme to render every platform as pure black.
 * `cornerRoundness` matches `drawJellyCandy`/`drawBlob` (0 = polygon corners,
 * ~0.18 = soft-platform rounding). */
export function drawFlatSurface(
  ctx: CanvasRenderingContext2D,
  poly: Vec2[],
  fill = CAVE_PLATFORM_FILL,
  cornerRoundness = 0,
): void {
  if (poly.length < 3) return;
  ctx.save();
  traceSmoothPoly(ctx, poly, cornerRoundness);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

// ── Dispatch ────────────────────────────────────────────────────────────
export function drawCandySurface(
  ctx: CanvasRenderingContext2D,
  poly: Vec2[],
  material: string,
): void {
  if (isCave) {
    drawFlatSurface(ctx, poly, CAVE_PLATFORM_FILL, 0);
    return;
  }
  const skin = MATERIAL_SKINS[material] ?? MATERIAL_SKINS.default;
  if (skin.primitive === 'hard') {
    drawHardCandy(ctx, poly, skin.palette);
  } else {
    drawJellyCandy(ctx, poly, skin.palette, 0);
  }
}
