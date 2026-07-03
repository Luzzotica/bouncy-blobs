// Game background images — multiple cartoon-candy backdrops drawn behind
// everything in screen space. The renderer holds all variants once they
// load; `preloadBackground()` (called on each level/game init) picks a
// new random variant so the world doesn't look the same on every run.

import { assetUrl } from '../utils/assetUrl';
import {
  isCave,
  CAVE_BG_TOP, CAVE_BG_MID, CAVE_BG_BOTTOM,
  CAVE_ROCK_LAYERS, CAVE_BACKWALL,
} from './colors';

const VARIANTS = [
  assetUrl('/backgrounds/game_bg_workbench_corner.png'),
  assetUrl('/backgrounds/game_bg_couch_corner.png'),
  assetUrl('/backgrounds/game_bg_goop_tank_wide.png'),
];

const images: HTMLImageElement[] = [];
const ready: boolean[] = [];
let currentIndex = 0;
let loaded = false;

function loadAll(): void {
  if (loaded) return;
  loaded = true;
  for (let i = 0; i < VARIANTS.length; i++) {
    const idx = i;
    const img = new Image();
    img.onload = () => { ready[idx] = true; };
    img.onerror = () => { /* leave ready[idx] = false; renderer falls back */ };
    img.src = VARIANTS[i];
    images.push(img);
    ready.push(false);
  }
}

/** Trigger image loading (idempotent) and pick a new random variant for
 * this level/session. Called at the top of each game/sandbox init so each
 * run rolls a fresh backdrop. */
export function preloadBackground(): void {
  if (typeof Image === 'undefined') return; // worker — no background image
  loadAll();
  if (VARIANTS.length > 0) {
    currentIndex = Math.floor(Math.random() * VARIANTS.length);
  }
}

/** Draw the currently-picked background image scaled to FIT inside the
 * viewport (contain), with a small camera-driven parallax offset. Letterbox
 * bars on whichever axis is shorter pick up the `fallback` color. Called
 * BEFORE the camera transform — this draws in screen space. */
export function drawGameBackground(
  ctx: CanvasRenderingContext2D,
  camera: { position: { x: number; y: number } },
  canvasWidth: number,
  canvasHeight: number,
  fallback: string,
): void {
  if (isCave) {
    drawCaveBackground(ctx, camera, canvasWidth, canvasHeight);
    return;
  }

  // Always fill the viewport with the fallback first — covers letterbox
  // bars and the fully-not-loaded case.
  ctx.fillStyle = fallback;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const img = images[currentIndex];
  if (!img || !ready[currentIndex]) return;

  // object-fit: cover — image is scaled to fully cover the viewport with
  // the excess cropped on whichever axis is longer. Then bumped up by an
  // OVERSCAN factor so there's slack on both axes for parallax movement
  // without ever exposing the image's edge.
  const OVERSCAN = 1.18;
  const imgRatio = img.width / img.height;
  const vpRatio  = canvasWidth / canvasHeight;
  let drawW: number, drawH: number;
  if (vpRatio > imgRatio) {
    drawW = canvasWidth;
    drawH = canvasWidth / imgRatio;
  } else {
    drawH = canvasHeight;
    drawW = canvasHeight * imgRatio;
  }
  drawW *= OVERSCAN;
  drawH *= OVERSCAN;
  const baseX = (canvasWidth  - drawW) * 0.5;
  const baseY = (canvasHeight - drawH) * 0.5;

  // Very subtle parallax — and CLAMPED to the overscan slack so we can
  // never push the image past the viewport edge regardless of how far the
  // camera roams. On big levels this means the bg appears almost still
  // (which is what we want — it's distant scenery, not a moving tile).
  const PARALLAX = 0.012;
  const slackX = (drawW - canvasWidth)  * 0.5;
  const slackY = (drawH - canvasHeight) * 0.5;
  let px = -camera.position.x * PARALLAX;
  let py = -camera.position.y * PARALLAX;
  if (px >  slackX) px =  slackX; else if (px < -slackX) px = -slackX;
  if (py >  slackY) py =  slackY; else if (py < -slackY) py = -slackY;

  ctx.drawImage(img, baseX + px, baseY + py, drawW, drawH);

  // Very light wash to keep foreground contrast — cartoon palette is
  // already mid-tone so we don't need to darken much.
  ctx.fillStyle = 'rgba(10, 10, 28, 0.08)';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
}

// ── Cave theme backdrop ─────────────────────────────────────────────────
// A procedural cavern, drawn in screen space with parallax depth layers.
//
// How the rock is generated mathematically:
//  • Placement: a per-column integer HASH (deterministic, no Math.random) so
//    the cave is stable frame-to-frame; only camera parallax animates it.
//  • Silhouette: 1-D value noise summed over octaves (fBm) perturbs each
//    spike's two edges and centre-line, so no two rocks share an outline and
//    none look like clean triangles.
//  • Profile: width tapers as a power law of distance from the root,
//    w(t) = W·(1−t)^p, giving a natural point; fBm jitter rides on top.
//  • Columns: when a column's hash rolls under `columnChance`, the top and
//    bottom spikes JOIN into one full-height pillar with a thin waist (where
//    the drips met) and a small collar bulge — a real cave column.
//  • Depth: the farthest layer is a big, slow "cave" layer (large pillars +
//    a lighter back-wall haze); nearer layers are smaller, darker, faster.

/** Stable pseudo-random in [0,1) from two integers. */
export function hash2(a: number, b: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 1-D value noise in ~[0,1) with smooth (smoothstep) interpolation. */
function vnoise(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash2(i, 7) * (1 - u) + hash2(i + 1, 7) * u;
}

/** Fractal Brownian motion — octaves of value noise. Output ~[0,1). Exported
 * so the foreground crag frame can share the same organic noise. */
export function fbm(x: number): number {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 5; o++) {
    sum += amp * vnoise(x * freq);
    freq *= 2;
    amp *= 0.5;
  }
  return sum;
}

interface RockLayer {
  color: string;
  spacing: number;       // horizontal column pitch (px)
  parallax: number;      // fraction of camera motion this layer follows
  lenBase: number;       // base spike length (px)
  lenVar: number;        // additional length jitter (px)
  width: number;         // base feature width (px)
  columnChance: number;  // odds a column becomes a full-height pillar
  skipChance: number;    // odds a column is empty (breaks the comb up)
  sheen: boolean;        // faint edge highlight (near layer only)
}

const ROCK_LAYERS: RockLayer[] = [
  // L0 — deepest spikes, BEHIND the columns. Long, slow, lightest; spikes
  //       reach far toward the middle so the cavern feels tight.
  { color: CAVE_ROCK_LAYERS[0], spacing: 300, parallax: 0.018, lenBase: 210, lenVar: 300, width: 200, columnChance: 0.00, skipChance: 0.08, sheen: false },
  // L1 — column layer #1 (big pillars).
  { color: CAVE_ROCK_LAYERS[1], spacing: 380, parallax: 0.040, lenBase: 160, lenVar: 250, width: 240, columnChance: 0.55, skipChance: 0.22, sheen: false },
  // L2 — column layer #2 (smaller pillars, a touch faster).
  { color: CAVE_ROCK_LAYERS[2], spacing: 280, parallax: 0.075, lenBase: 130, lenVar: 215, width: 175, columnChance: 0.45, skipChance: 0.20, sheen: false },
  // L3 — mid spikes.
  { color: CAVE_ROCK_LAYERS[3], spacing: 175, parallax: 0.120, lenBase: 100, lenVar: 175, width: 120, columnChance: 0.05, skipChance: 0.18, sheen: false },
  // L4 — near spikes.
  { color: CAVE_ROCK_LAYERS[4], spacing: 130, parallax: 0.190, lenBase: 75,  lenVar: 140, width: 96,  columnChance: 0.02, skipChance: 0.22, sheen: true  },
];

/** Build a fBm-perturbed spike silhouette as two edge polylines and fill it.
 * `dir` = +1 hangs down from `rootY`, −1 rises up from it. Fills with the
 * ctx's current `fillStyle`. Exported so the foreground cave-frame crags can
 * reuse the exact same silhouette. */
export function drawRockSpike(
  ctx: CanvasRenderingContext2D,
  cx: number, rootY: number, dir: number,
  length: number, halfW: number, lean: number, seed: number,
): void {
  const N = 12;
  ctx.beginPath();
  // Down the left edge, root → tip.
  for (let s = 0; s <= N; s++) {
    const t = s / N;
    const w = halfW * Math.pow(1 - t, 1.22);
    const center = cx + lean * t + (fbm(seed + t * 3.0) - 0.48) * halfW * 0.7;
    const edge = 0.72 + 0.55 * fbm(seed + 11 + t * 6.0);
    const x = center - w * edge;
    const y = rootY + dir * length * t;
    if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  // Up the right edge, tip → root.
  for (let s = N; s >= 0; s--) {
    const t = s / N;
    const w = halfW * Math.pow(1 - t, 1.22);
    const center = cx + lean * t + (fbm(seed + t * 3.0) - 0.48) * halfW * 0.7;
    const edge = 0.72 + 0.55 * fbm(seed + 23 + t * 6.0);
    ctx.lineTo(center + w * edge, rootY + dir * length * t);
  }
  ctx.closePath();
  ctx.fill();
}

/** Full-height column — a stalactite and stalagmite that met. Fat at both
 * ends, thin at the waist (the join), with a small collar bulge there. */
function drawRockColumn(
  ctx: CanvasRenderingContext2D,
  cx: number, topY: number, botY: number, halfW: number, seed: number,
): void {
  const N = 22;
  const H = botY - topY;
  const widthAt = (t: number): number => {
    const waist = 0.30 + 0.70 * Math.pow(Math.abs(2 * t - 1), 1.4);
    const collar = 1 + 0.22 * Math.exp(-((t - 0.5) * (t - 0.5)) / 0.004);
    return halfW * waist * collar;
  };
  ctx.beginPath();
  for (let s = 0; s <= N; s++) {
    const t = s / N;
    const w = widthAt(t);
    const center = cx + (fbm(seed + t * 2.2) - 0.5) * halfW * 0.45;
    const edge = 0.80 + 0.40 * fbm(seed + 5 + t * 5.0);
    const x = center - w * edge;
    const y = topY + H * t;
    if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  for (let s = N; s >= 0; s--) {
    const t = s / N;
    const w = widthAt(t);
    const center = cx + (fbm(seed + t * 2.2) - 0.5) * halfW * 0.45;
    const edge = 0.80 + 0.40 * fbm(seed + 9 + t * 5.0);
    ctx.lineTo(center + w * edge, topY + H * t);
  }
  ctx.closePath();
  ctx.fill();
}

function drawCaveBackground(
  ctx: CanvasRenderingContext2D,
  camera: { position: { x: number; y: number } },
  w: number,
  h: number,
): void {
  // Deep-blue vertical gradient.
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, CAVE_BG_TOP);
  g.addColorStop(0.5, CAVE_BG_MID);
  g.addColorStop(1, CAVE_BG_BOTTOM);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Cavern depth haze behind the deepest rock.
  const haze = ctx.createRadialGradient(
    w * 0.5, h * 0.42, Math.min(w, h) * 0.08,
    w * 0.5, h * 0.42, Math.max(w, h) * 0.7,
  );
  haze.addColorStop(0, CAVE_BACKWALL);
  haze.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, w, h);

  // Parallax rock layers, far → near.
  for (let l = 0; l < ROCK_LAYERS.length; l++) {
    const layer = ROCK_LAYERS[l];
    const offX = camera.position.x * layer.parallax;
    const margin = layer.width * 1.5;
    const firstCol = Math.floor((offX - margin) / layer.spacing);
    const lastCol = Math.ceil((offX + w + margin) / layer.spacing);

    ctx.fillStyle = layer.color;
    for (let col = firstCol; col <= lastCol; col++) {
      if (hash2(col, l + 90) < layer.skipChance) continue;

      const baseX = col * layer.spacing - offX;
      const cxTop = baseX + (hash2(col, l + 3) - 0.5) * layer.spacing * 0.8;
      const halfW = layer.width * (0.28 + 0.34 * hash2(col, l + 31));
      const seed = col * 13.13 + l * 7.7;

      if (hash2(col, l + 57) < layer.columnChance) {
        // Full-height column.
        drawRockColumn(ctx, cxTop, 0, h, halfW * 1.05, seed);
      } else {
        // Stalactite (top).
        const lenT = layer.lenBase + layer.lenVar * fbm(col * 1.7 + l + 0.5);
        const leanT = (hash2(col, l + 41) - 0.5) * halfW * 0.9;
        drawRockSpike(ctx, cxTop, 0, +1, lenT, halfW, leanT, seed + 0.3);
        // Stalagmite (bottom), interlaced half a column over.
        const cxBot = baseX + layer.spacing * 0.5 + (hash2(col, l + 71) - 0.5) * layer.spacing * 0.6;
        const halfWb = layer.width * (0.28 + 0.34 * hash2(col, l + 97));
        const lenB = layer.lenBase + layer.lenVar * fbm(col * 2.3 + l + 9.1);
        const leanB = (hash2(col, l + 19) - 0.5) * halfWb * 0.9;
        drawRockSpike(ctx, cxBot, h, -1, lenB, halfWb, leanB, seed + 5.1);
      }
    }
  }

  // Soft vignette to settle the edges and push the play area forward.
  const vg = ctx.createRadialGradient(
    w * 0.5, h * 0.5, Math.min(w, h) * 0.35,
    w * 0.5, h * 0.5, Math.max(w, h) * 0.75,
  );
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);
}
