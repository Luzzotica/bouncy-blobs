import { Vec2 } from '../physics/vec2';

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
