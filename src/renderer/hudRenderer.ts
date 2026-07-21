import { ManagedPlayer } from '../game/playerManager';
import { displayColor } from './colors';
import { getGameTextScale, getHighContrast } from '../utils/accessibilitySettings';

/** Draw scores as horizontal bars in top-right corner. */
export function drawScoreBoard(
  ctx: CanvasRenderingContext2D,
  width: number,
  players: ManagedPlayer[],
  scores: Map<string, number>,
  targetScore?: number,
): void {
  if (scores.size === 0) return;

  const maxScore = targetScore ?? Math.max(...scores.values(), 1);
  const fontPx = Math.round(12 * getGameTextScale());
  const barWidth = 140;
  const barHeight = 16;
  const rowStep = Math.max(barHeight, fontPx) + 4;
  const padding = 8;
  const startX = width - barWidth - padding - 60;
  const startY = 12;

  ctx.save();
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  let y = startY;
  for (const p of players) {
    const score = scores.get(p.playerId) ?? 0;
    const fillWidth = Math.min(score / maxScore, 1) * barWidth;

    // Name
    ctx.fillStyle = getHighContrast() ? '#fff' : '#ccc';
    ctx.fillText(p.name, startX - 8, y + barHeight / 2);

    // Bar background
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(startX, y, barWidth, barHeight);

    // Bar fill
    ctx.fillStyle = displayColor(p.color);
    ctx.fillRect(startX, y, fillWidth, barHeight);

    // Score text
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(String(Math.floor(score)), startX + barWidth + 6, y + barHeight / 2);
    ctx.textAlign = 'right';

    y += rowStep;
  }

  ctx.restore();
}

/** Draw time remaining in top-center. */
export function drawTimer(
  ctx: CanvasRenderingContext2D,
  width: number,
  timeRemaining: number,
): void {
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = Math.ceil(timeRemaining % 60);
  const text = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  ctx.save();
  ctx.font = `bold ${Math.round(28 * getGameTextScale())}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = timeRemaining <= 10 ? '#ff4444' : '#fff';
  ctx.fillText(text, width / 2, 12);
  ctx.restore();
}
