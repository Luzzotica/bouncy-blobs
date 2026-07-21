import { ZoneDef } from '../levels/types';
import { isCave, CAVE_GOAL_RGB, CAVE_HILL_RGB, displayColor, colorWithAlpha } from './colors';
import { getGameTextScale, getHighContrast } from '../utils/accessibilitySettings';

// In the cave theme these overlays are dimmed to cooler tones so they sit in
// the palette instead of glowing neon (still readable — they're gameplay).
const GOAL_RGB = isCave ? `${CAVE_GOAL_RGB.r}, ${CAVE_GOAL_RGB.g}, ${CAVE_GOAL_RGB.b}` : '0, 255, 100';
const HILL_RGB = isCave ? `${CAVE_HILL_RGB.r}, ${CAVE_HILL_RGB.g}, ${CAVE_HILL_RGB.b}` : '255, 215, 0';

/** Zone label: colored pulse normally; high contrast switches to solid white
 * text with a dark stroke so the label never fades into the scene. */
function drawZoneLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  basePx: number,
  coloredFill: string,
): void {
  ctx.font = `bold ${Math.round(basePx * getGameTextScale())}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (getHighContrast()) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#ffffff';
  } else {
    ctx.fillStyle = coloredFill;
  }
  ctx.fillText(text, x, y);
}

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

  const hc = getHighContrast();
  // Pulsing alpha — high contrast keeps a solid floor so the zone never dims.
  const pulse = hc ? 0.3 : 0.15 + 0.1 * Math.sin(time * 3);

  ctx.save();

  // Filled zone
  ctx.fillStyle = `rgba(${GOAL_RGB}, ${pulse})`;
  ctx.fillRect(x, y, zone.width, zone.height);

  // Border
  ctx.strokeStyle = `rgba(${GOAL_RGB}, ${hc ? 0.95 : pulse + 0.2})`;
  ctx.lineWidth = hc ? 4 : 3;
  ctx.setLineDash([10, 6]);
  ctx.strokeRect(x, y, zone.width, zone.height);
  ctx.setLineDash([]);

  drawZoneLabel(ctx, 'FINISH', zone.x, zone.y, 28, `rgba(${GOAL_RGB}, ${pulse + 0.4})`);

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

  const hc = getHighContrast();
  const pulse = hc
    ? 0.28 + 0.35 * flash
    : 0.12 + 0.08 * Math.sin(time * 2.5) + 0.35 * flash;

  ctx.save();

  // Filled zone
  if (ownerColor) {
    ctx.fillStyle = colorWithAlpha(displayColor(ownerColor), pulse);
  } else {
    ctx.fillStyle = `rgba(${HILL_RGB}, ${pulse})`;
  }
  ctx.fillRect(x, y, zone.width, zone.height);

  // Border
  ctx.strokeStyle = `rgba(${HILL_RGB}, ${hc ? 0.95 : pulse + 0.3})`;
  ctx.lineWidth = (hc ? 4 : 3) + 4 * flash;
  ctx.strokeRect(x, y, zone.width, zone.height);

  drawZoneLabel(ctx, 'HILL', zone.x, zone.y, 24, `rgba(${HILL_RGB}, ${pulse + 0.4})`);

  ctx.restore();
}
