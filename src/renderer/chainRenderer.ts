import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { Vec2 } from '../physics/vec2';

/** Draw a single rope-chain. `particleIndices` is the full ordered list
 * including both endpoints (matches `LevelLoader.ChainInfo.particleIndices`
 * and the internal layout of `addRopeChain`). The color gradient encodes
 * tension: green when the rope is slack, red as it pulls taut against
 * `totalLength`. */
export function drawChain(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyEngine,
  particleIndices: number[],
  totalLength: number,
): void {
  if (particleIndices.length < 2) return;

  const pts: Vec2[] = [];
  for (const idx of particleIndices) {
    const p = world.pos[idx];
    if (p) pts.push(p);
  }
  if (pts.length < 2) return;

  // Tension: straight-line distance between endpoints vs the rope's slack
  // budget. <85% slack = green; ramps to red as it tightens.
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const straight = Math.sqrt(dx * dx + dy * dy);
  const tension = Math.min(Math.max(0, (straight - totalLength * 0.85) / (totalLength * 0.15)), 1);
  let r: number, g: number, bv: number;
  if (tension < 0.5) {
    const t = tension * 2;
    r = Math.floor(110 * t + 60 * (1 - t));
    g = Math.floor(180 * (1 - t) + 200 * t);
    bv = Math.floor(60 * (1 - t) + 40 * t);
  } else {
    const t = (tension - 0.5) * 2;
    r = Math.floor(255 * t + 200 * (1 - t));
    g = Math.floor(180 * (1 - t) + 80 * t);
    bv = 40;
  }

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Dark outline + colored fill — two passes give the rope a comic-book
  // chain look without needing per-link art.
  ctx.lineWidth = 9;
  ctx.strokeStyle = '#0a0612';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();

  ctx.lineWidth = 6;
  ctx.strokeStyle = `rgb(${r}, ${g}, ${bv})`;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();

  ctx.restore();
}
