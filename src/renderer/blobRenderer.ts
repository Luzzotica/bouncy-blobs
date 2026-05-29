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
 * Volume / motion pass. Call AFTER `drawBlob` on a blob (not soft platforms).
 *
 * Layers, all clipped to the blob silhouette:
 *   1. A subtle inner-darkness gradient — slightly tints the centre so the
 *      blob reads as 3D jelly instead of a flat sticker.
 *   2. Ripples — concentric expanding rings clipped to the hull. There's
 *      one ambient ring per blob that drifts in a slow loop, plus one or
 *      more "impact" rings emanating from recent contact points
 *      (`impacts`), expanding and fading over their lifetime.
 *   3. Wind streaks — speed-driven arcs hugging the inside of the leading
 *      edge.
 */
/**
 * Cosmetic-only hull perturbation simulating wind pressure on a viscous
 * surface. Returns a NEW hull array; the physics hull is untouched.
 *
 * Leading-edge points (those whose outward normal aligns with velocity
 * direction) are pushed slightly inward + jittered with a high-frequency
 * sine wave. Trailing-edge points pass through unchanged. Amplitude
 * scales with speed and caps so even a fast blob only deforms by a few
 * pixels. Below MIN_SPEED the hull is returned as-is (cheap pointer copy).
 */
export function perturbHullForWind(
  hull: Vec2[],
  centroid: Vec2,
  velocity: Vec2,
  time: number,
): Vec2[] {
  // Threshold sits above the noise floor of `sampleBlobVelocity`'s
  // centroid-delta estimate: a settled soft body's hull keeps micro-
  // oscillating so the estimated speed stays in the tens of px/s even
  // when the player isn't moving. RAMP_END gives a smooth fade-in so
  // crossing the threshold doesn't pop.
  const MIN_SPEED = 140;
  const RAMP_END = 220;
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed < MIN_SPEED) return hull;
  const fade = Math.min(1, (speed - MIN_SPEED) / (RAMP_END - MIN_SPEED));
  // Gentle ramp on top of fade: at 250 px/s ≈ 3 px; at 500 px/s ≈ 5.5 px; cap 7 px.
  const amp = fade * Math.min(7, (speed - MIN_SPEED) * 0.012);
  const vx = velocity.x / speed;
  const vy = velocity.y / speed;
  const out: Vec2[] = new Array(hull.length);
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const ox = p.x - centroid.x;
    const oy = p.y - centroid.y;
    const om = Math.hypot(ox, oy) || 1;
    const nx = ox / om;
    const ny = oy / om;
    const dot = nx * vx + ny * vy;          // -1..1
    if (dot <= 0) { out[i] = p; continue }   // trailing half — pass through
    const w = dot;                           // linear taper — visible further around
    // Two jitter phases (one slow, one fast) so the edge ruffles instead
    // of pulsing as a single shape.
    const jitter = Math.sin(time * 13 + i * 0.83) * 0.6
                 + Math.sin(time * 23 + i * 1.7) * 0.35;
    const push = -amp * w * (0.65 + 0.35 * jitter);
    out[i] = { x: p.x + nx * push, y: p.y + ny * push };
  }
  return out;
}

export function drawBlobShine(
  ctx: CanvasRenderingContext2D,
  hull: Vec2[],
  time: number,
  centroid: Vec2,
  velocity: Vec2,
  impacts: readonly BlobImpact[] = [],
  cornerRoundness = 0.5,
): void {
  const n = hull.length;
  if (n < 3) return;

  // AABB for sizing only — caller already gave us the centroid.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of hull) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = centroid.x;
  const cy = centroid.y;
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
  // blob — even if the impact origin is on the silhouette. Stored in
  // blob-LOCAL coords so the ring rides with the blob: world origin =
  // current centroid + local offset.
  for (const im of impacts) {
    const lifeT = Math.min(1, im.age / im.maxAge);
    if (lifeT >= 1) continue;
    const wx = cx + im.localX;
    const wy = cy + im.localY;
    const ringCount = 1 + Math.floor(im.strength * 2.4); // 1..3
    const maxR = radius * (1.0 + im.strength * 0.4);
    for (let r = 0; r < ringCount; r++) {
      const ringPhase = lifeT + r * 0.18;
      if (ringPhase >= 1 || ringPhase <= 0) continue;
      const rad = maxR * ringPhase;
      const a = (1 - ringPhase) * (0.28 * im.strength + 0.12);
      if (a < 0.02) continue;
      ctx.strokeStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
      ctx.lineWidth = 1.0 + im.strength * 1.0;
      ctx.beginPath();
      ctx.arc(wx, wy, rad, 0, Math.PI * 2);
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
