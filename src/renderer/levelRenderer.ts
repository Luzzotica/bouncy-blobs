import { Vec2, vec2 } from '../physics/vec2';
import { PLATFORM_COLOR, PLATFORM_BORDER } from './colors';

/**
 * Detect if a polygon is an axis-aligned (or near-axis-aligned) rectangle.
 * Returns the bounding dimensions if so, or null if it's an irregular shape.
 */
function detectRect(poly: Vec2[]): { cx: number; cy: number; w: number; h: number } | null {
  if (poly.length !== 4) return null;

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  // Check all 4 vertices are near corners of the bounding box
  const tolerance = 2;
  for (const p of poly) {
    const nearX = Math.abs(p.x - minX) < tolerance || Math.abs(p.x - maxX) < tolerance;
    const nearY = Math.abs(p.y - minY) < tolerance || Math.abs(p.y - maxY) < tolerance;
    if (!nearX || !nearY) return null;
  }

  const w = maxX - minX;
  const h = maxY - minY;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h };
}

/**
 * Draw a capsule (stadium) shape: a rectangle with semicircular ends on the short sides.
 */
function drawCapsule(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  fillColor: string,
  strokeColor: string,
  lineWidth: number,
): void {
  // The radius is half the shorter dimension
  const r = Math.min(w, h) / 2;

  ctx.beginPath();
  if (w >= h) {
    // Horizontal capsule — semicircles on left and right
    const halfBody = w / 2 - r;
    ctx.arc(cx - halfBody, cy, r, Math.PI * 0.5, Math.PI * 1.5);  // left cap
    ctx.lineTo(cx + halfBody, cy - r);
    ctx.arc(cx + halfBody, cy, r, Math.PI * 1.5, Math.PI * 0.5);  // right cap
    ctx.lineTo(cx - halfBody, cy + r);
  } else {
    // Vertical capsule — semicircles on top and bottom
    const halfBody = h / 2 - r;
    ctx.arc(cx, cy - halfBody, r, Math.PI, 0);       // top cap
    ctx.lineTo(cx + r, cy + halfBody);
    ctx.arc(cx, cy + halfBody, r, 0, Math.PI);       // bottom cap
    ctx.lineTo(cx - r, cy - halfBody);
  }
  ctx.closePath();

  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

export function drawStaticPolygon(
  ctx: CanvasRenderingContext2D,
  poly: Vec2[],
  fillColor = PLATFORM_COLOR,
  strokeColor = PLATFORM_BORDER,
  lineWidth = 2,
): void {
  if (poly.length < 2) return;

  // Check if this is a rectangular platform — draw as capsule
  const rect = detectRect(poly);
  if (rect && rect.w > 40 && rect.w < 800 && rect.h < rect.w * 0.6 && rect.h < 100) {
    // Looks like a platform (wide but not massive, thin) — draw as capsule
    drawCapsule(ctx, rect.cx, rect.cy, rect.w, rect.h, fillColor, strokeColor, lineWidth);
    return;
  }

  // Default polygon rendering for walls, floors, irregular shapes
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) {
    ctx.lineTo(poly[i].x, poly[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}
