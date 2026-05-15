import { Vec2 } from '../physics/vec2';

export function drawBlob(
  ctx: CanvasRenderingContext2D,
  hull: Vec2[],
  fillColor: string,
  strokeColor: string,
  lineWidth = 2.25,
): void {
  const n = hull.length;
  if (n < 3) return;

  ctx.beginPath();

  // Smooth blob: quadratic bezier through midpoints
  const mid = (a: Vec2, b: Vec2) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const firstMid = mid(hull[n - 1], hull[0]);
  ctx.moveTo(firstMid.x, firstMid.y);

  for (let i = 0; i < n; i++) {
    const current = hull[i];
    const next = hull[(i + 1) % n];
    const midNext = mid(current, next);
    ctx.quadraticCurveTo(current.x, current.y, midNext.x, midNext.y);
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
