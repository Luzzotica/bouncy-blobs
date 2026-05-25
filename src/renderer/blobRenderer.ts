import { Vec2 } from '../physics/vec2';
import { BlobImpact } from './blobImpacts';

export function drawBlob(
  ctx: CanvasRenderingContext2D,
  hull: Vec2[],
  fillColor: string,
  strokeColor: string,
  lineWidth = 2.25,
  cornerRoundness = 0.5,
): void {
  const n = hull.length;
  if (n < 3) return;

  ctx.beginPath();

  // Smooth: each hull vertex is a quadratic-bezier control point. The path
  // runs straight along each edge, then curves through each corner. Clamp
  // `cornerRoundness` in [0, 0.5]. 0 = sharp polygon, 0.5 = full midpoint
  // smoothing (blob look). Smaller values keep edges mostly straight with
  // just rounded corners.
  const t = Math.max(0, Math.min(0.5, cornerRoundness));
  const cut = (from: Vec2, toward: Vec2, k: number): Vec2 => ({
    x: from.x + (toward.x - from.x) * k,
    y: from.y + (toward.y - from.y) * k,
  });

  // Start at the entry point to corner 0 — t-fraction from hull[0] toward
  // the previous vertex.
  const entryFirst = cut(hull[0], hull[n - 1], t);
  ctx.moveTo(entryFirst.x, entryFirst.y);

  for (let i = 0; i < n; i++) {
    const current = hull[i];
    const next = hull[(i + 1) % n];
    // Curve through current to the exit point along the current→next edge
    const exit = cut(current, next, t);
    ctx.quadraticCurveTo(current.x, current.y, exit.x, exit.y);
    // Straight line along the edge to the entry of the next corner
    const entryNext = cut(next, current, t);
    ctx.lineTo(entryNext.x, entryNext.y);
  }

  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/** Build the same smoothed hull path drawBlob uses, on whatever ctx state
 * is current. Used for clipping the shine layers to the blob silhouette. */
function tracehullPath(ctx: CanvasRenderingContext2D, hull: Vec2[], cornerRoundness: number): void {
  const n = hull.length;
  const t = Math.max(0, Math.min(0.5, cornerRoundness));
  const cut = (from: Vec2, toward: Vec2, k: number): Vec2 => ({
    x: from.x + (toward.x - from.x) * k,
    y: from.y + (toward.y - from.y) * k,
  });
  const entryFirst = cut(hull[0], hull[n - 1], t);
  ctx.moveTo(entryFirst.x, entryFirst.y);
  for (let i = 0; i < n; i++) {
    const current = hull[i];
    const next = hull[(i + 1) % n];
    const exit = cut(current, next, t);
    ctx.quadraticCurveTo(current.x, current.y, exit.x, exit.y);
    const entryNext = cut(next, current, t);
    ctx.lineTo(entryNext.x, entryNext.y);
  }
  ctx.closePath();
}

/**
 * Wet-slime shine pass. Call AFTER `drawBlob` on a blob (not soft platforms).
 *
 * Three composited layers, all clipped to the blob silhouette:
 *   1. A subtle inner-darkness gradient — slightly tints the centre so the
 *      blob reads as 3D jelly instead of a flat sticker.
 *   2. A top-right rim light — a soft crescent hugging the lit side of the
 *      silhouette, not a central gloss spot. This is what makes the blob
 *      look wet without going glossy/plastic.
 *   3. Ripples — concentric expanding rings clipped to the hull. There's
 *      one ambient ring per blob that drifts in a slow loop, plus one or
 *      more "impact" rings emanating from recent contact points
 *      (`impacts`), expanding and fading over their lifetime.
 *
 * No central glint, no specular hotspot — it was reading as harsh/plastic.
 */
export function drawBlobShine(
  ctx: CanvasRenderingContext2D,
  hull: Vec2[],
  time: number,
  impacts: BlobImpact[] = [],
  cornerRoundness = 0.5,
): void {
  const n = hull.length;
  if (n < 3) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let cx = 0, cy = 0;
  for (const p of hull) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  const halfW = (maxX - minX) * 0.5;
  const halfH = (maxY - minY) * 0.5;
  const radius = Math.max(halfW, halfH);
  if (radius < 4) return;

  ctx.save();
  ctx.beginPath();
  tracehullPath(ctx, hull, cornerRoundness);
  ctx.clip();

  // ── Layer 1: inner darkness ─────────────────────────────────────────
  // Soft radial — transparent in the centre, slight cool wash at the edge.
  // Adds volume without darkening the silhouette enough to look painted-on.
  const innerGrad = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 1.05);
  innerGrad.addColorStop(0.0, 'rgba(0, 30, 40, 0)');
  innerGrad.addColorStop(0.75, 'rgba(0, 30, 40, 0.08)');
  innerGrad.addColorStop(1.0, 'rgba(0, 30, 40, 0.22)');
  ctx.fillStyle = innerGrad;
  ctx.fillRect(cx - radius - 2, cy - radius - 2, radius * 2 + 4, radius * 2 + 4);

  // ── Layer 2: rim light (top-right) ──────────────────────────────────
  // A bright source offset OUTSIDE the blob on the lit side, with the
  // gradient peaking just inside the silhouette. Result: a thin crescent
  // of highlight hugging the upper-right edge — reads as wet skin, not as
  // a gloss spot. Tunable so we can dim it without overhauling the look.
  const LIGHT_X = 0.55;
  const LIGHT_Y = -0.55;
  const lx = cx + LIGHT_X * radius * 1.35;
  const ly = cy + LIGHT_Y * radius * 1.35;
  const rimInner = radius * 0.55;
  const rimOuter = radius * 1.3;
  const rimGrad = ctx.createRadialGradient(lx, ly, rimInner, lx, ly, rimOuter);
  rimGrad.addColorStop(0.0, 'rgba(255, 255, 255, 0)');
  rimGrad.addColorStop(0.55, 'rgba(220, 250, 250, 0.18)');
  rimGrad.addColorStop(0.82, 'rgba(255, 255, 255, 0.35)');
  rimGrad.addColorStop(1.0, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = rimGrad;
  ctx.fillRect(cx - radius * 1.5, cy - radius * 1.5, radius * 3, radius * 3);

  // ── Layer 3a: ambient ripple ────────────────────────────────────────
  // One slow ring that loops every ~3.5s, drifts outward, fades at the end.
  // Gives the blob a default "jelly" feel even when it's at rest.
  {
    const period = 3.5;
    const phase = (time % period) / period;     // 0..1
    const r = radius * (0.25 + phase * 0.85);
    const alpha = 0.18 * (1 - phase) * Math.sin(phase * Math.PI);
    if (alpha > 0.005) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── Layer 3b: impact ripples ────────────────────────────────────────
  // Concentric rings emanating from each recent contact point, expanding
  // and fading over the impact's lifetime. Bigger impact = more rings,
  // brighter, faster. Clipped to the hull so rings only show inside the
  // blob — even if the impact origin is on the silhouette.
  for (const im of impacts) {
    const lifeT = Math.min(1, im.age / im.maxAge);   // 0..1
    if (lifeT >= 1) continue;
    const ringCount = 1 + Math.floor(im.strength * 2.4); // 1..3
    const maxR = radius * (1.0 + im.strength * 0.4);
    for (let r = 0; r < ringCount; r++) {
      const ringPhase = lifeT + r * 0.18;
      if (ringPhase >= 1 || ringPhase <= 0) continue;
      const rad = maxR * ringPhase;
      const a = (1 - ringPhase) * (0.55 * im.strength + 0.25);
      if (a < 0.02) continue;
      ctx.strokeStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
      ctx.lineWidth = 1.4 + im.strength * 1.6;
      ctx.beginPath();
      ctx.arc(im.x, im.y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}

export function drawBlobOutline(
  ctx: CanvasRenderingContext2D,
  hull: Vec2[],
  color: string,
  lineWidth = 2.25,
): void {
  const n = hull.length;
  if (n < 2) return;
  ctx.beginPath();
  ctx.moveTo(hull[0].x, hull[0].y);
  for (let i = 1; i < n; i++) {
    ctx.lineTo(hull[i].x, hull[i].y);
  }
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}
