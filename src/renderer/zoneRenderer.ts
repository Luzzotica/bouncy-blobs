import { ZoneDef } from '../levels/types';
import { isCave, CAVE_GOAL_RGB, CAVE_HILL_RGB } from './colors';

// In the cave theme these overlays are dimmed to cooler tones so they sit in
// the palette instead of glowing neon (still readable — they're gameplay).
const GOAL_RGB = isCave ? `${CAVE_GOAL_RGB.r}, ${CAVE_GOAL_RGB.g}, ${CAVE_GOAL_RGB.b}` : '0, 255, 100';
const HILL_RGB = isCave ? `${CAVE_HILL_RGB.r}, ${CAVE_HILL_RGB.g}, ${CAVE_HILL_RGB.b}` : '255, 215, 0';

/** Draw a goal zone (green glow with FINISH label). */
export function drawGoalZone(
  ctx: CanvasRenderingContext2D,
  zone: ZoneDef,
  time: number,
): void {
  const hw = zone.width / 2;
  const hh = zone.height / 2;
  const x = zone.x - hw;
  const y = zone.y - hh;

  // Pulsing alpha
  const pulse = 0.15 + 0.1 * Math.sin(time * 3);

  ctx.save();

  // Filled zone
  ctx.fillStyle = `rgba(${GOAL_RGB}, ${pulse})`;
  ctx.fillRect(x, y, zone.width, zone.height);

  // Border
  ctx.strokeStyle = `rgba(${GOAL_RGB}, ${pulse + 0.2})`;
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 6]);
  ctx.strokeRect(x, y, zone.width, zone.height);
  ctx.setLineDash([]);

  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(${GOAL_RGB}, ${pulse + 0.4})`;
  ctx.fillText('FINISH', zone.x, zone.y);

  ctx.restore();
}

/** Draw a hill zone (golden highlight). */
export function drawHillZone(
  ctx: CanvasRenderingContext2D,
  zone: ZoneDef,
  time: number,
  ownerColor: string | null,
  /** 0..1 spawn-flash intensity — 1 right after the hill moves, fading to 0.
   *  Brightens the fill/border so a relocated hill reads as "new". */
  flash = 0,
): void {
  const hw = zone.width / 2;
  const hh = zone.height / 2;
  const x = zone.x - hw;
  const y = zone.y - hh;

  const pulse = 0.12 + 0.08 * Math.sin(time * 2.5) + 0.35 * flash;

  ctx.save();

  // Filled zone
  if (ownerColor) {
    ctx.fillStyle = ownerColor.replace(')', `, ${pulse})`).replace('rgb(', 'rgba(');
  } else {
    ctx.fillStyle = `rgba(${HILL_RGB}, ${pulse})`;
  }
  ctx.fillRect(x, y, zone.width, zone.height);

  // Border
  ctx.strokeStyle = `rgba(${HILL_RGB}, ${pulse + 0.3})`;
  ctx.lineWidth = 3 + 4 * flash;
  ctx.strokeRect(x, y, zone.width, zone.height);

  // Crown icon
  ctx.font = 'bold 24px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(${HILL_RGB}, ${pulse + 0.4})`;
  ctx.fillText('HILL', zone.x, zone.y);

  ctx.restore();
}
