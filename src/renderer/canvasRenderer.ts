import { SoftBodyWorld } from '../physics/softBodyWorld';
import { SlimeBlob } from '../physics/slimeBlob';
import { Camera } from './camera';
import { drawBlob } from './blobRenderer';
import { drawStaticPolygon } from './levelRenderer';
import { drawSprings, drawShapeMatchTargets, drawBlobPoints } from './debugRenderer';
import { playerColor, playerColorAlpha, npcColor, NPC_HUES, BACKGROUND_COLOR } from './colors';
import { drawBlobFace } from './faceRenderer';

export interface SoftPlatformRenderInfo {
  hullIndices: number[];
  staticHullIndices: number[];
}

export interface RenderOptions {
  showSprings?: boolean;
  showShapeTargets?: boolean;
  showPoints?: boolean;
}

export interface ModeOverlay {
  renderWorld: (ctx: CanvasRenderingContext2D) => void;
  renderHUD: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
}

export interface PlayerRenderData {
  color: string;
  faceId: string;
  expanding: boolean;
  expandScale: number;
}

export function render(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyWorld,
  camera: Camera,
  playerBlobs: SlimeBlob[],
  npcBlobs: SlimeBlob[],
  canvasWidth: number,
  canvasHeight: number,
  options: RenderOptions = {},
  modeOverlay?: ModeOverlay,
  playerData?: PlayerRenderData[],
  softPlatforms: SoftPlatformRenderInfo[] = [],
): void {
  // Clear
  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.save();

  // Camera transform
  const cx = canvasWidth / 2 - camera.position.x * camera.zoom;
  const cy = canvasHeight / 2 - camera.position.y * camera.zoom;
  ctx.translate(cx, cy);
  ctx.scale(camera.zoom, camera.zoom);

  // Mode world overlays (zones, behind everything)
  modeOverlay?.renderWorld(ctx);

  // Static polygons
  for (const surface of world.staticSurfaces) {
    drawStaticPolygon(ctx, surface.poly, surface.material);
  }

  // Soft platforms — lightly-rounded polygon following current hull positions
  for (const sp of softPlatforms) {
    if (sp.hullIndices.length < 3) continue;
    const positions = world.getPositions();
    const hull = sp.hullIndices.map(i => positions[i]);
    drawBlob(ctx, hull, '#9aa6c0', '#4f5874', 2.5, 0.18);
    // Static-point highlights (yellow dots) — debug-only
    if (options.showPoints) {
      const staticSet = new Set(sp.staticHullIndices);
      ctx.fillStyle = '#ffcc55';
      ctx.strokeStyle = '#0f1629';
      ctx.lineWidth = 1.5;
      for (const idx of sp.hullIndices) {
        if (!staticSet.has(idx)) continue;
        const p = positions[idx];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // Gravity-zone overlays
  for (const shape of world.shapes) {
    if (!shape.isTrigger || shape.gravityField === null || shape.staticPoly.length < 3) continue;
    const field = shape.gravityField;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(shape.staticPoly[0].x, shape.staticPoly[0].y);
    for (let i = 1; i < shape.staticPoly.length; i++) {
      ctx.lineTo(shape.staticPoly[i].x, shape.staticPoly[i].y);
    }
    ctx.closePath();
    if (field.kind === 'point') {
      // Radial gradient toward the singularity
      const grad = ctx.createRadialGradient(
        field.center.x, field.center.y, 5,
        field.center.x, field.center.y, 350,
      );
      grad.addColorStop(0, 'rgba(180, 60, 220, 0.55)');
      grad.addColorStop(1, 'rgba(180, 60, 220, 0)');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(180, 60, 220, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Center marker
      ctx.beginPath();
      ctx.arc(field.center.x, field.center.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 230, 255, 0.9)';
      ctx.fill();
    } else {
      // Uniform — color by zero-g vs directional
      const isZero = Math.abs(field.vector.x) + Math.abs(field.vector.y) < 1e-3;
      if (isZero) {
        ctx.fillStyle = 'rgba(80, 220, 220, 0.18)';
        ctx.strokeStyle = 'rgba(80, 220, 220, 0.7)';
      } else {
        ctx.fillStyle = 'rgba(255, 160, 60, 0.16)';
        ctx.strokeStyle = 'rgba(255, 160, 60, 0.7)';
      }
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Arrow showing gravity direction inside the zone (non-zero only)
      if (!isZero) {
        // Centroid of zone polygon (average)
        let cxz = 0, cyz = 0;
        for (const p of shape.staticPoly) { cxz += p.x; cyz += p.y; }
        cxz /= shape.staticPoly.length;
        cyz /= shape.staticPoly.length;
        const mag = Math.sqrt(field.vector.x * field.vector.x + field.vector.y * field.vector.y);
        const dx = field.vector.x / mag, dy = field.vector.y / mag;
        const arrowLen = 70;
        const ex = cxz + dx * arrowLen, ey = cyz + dy * arrowLen;
        ctx.beginPath();
        ctx.moveTo(cxz - dx * arrowLen, cyz - dy * arrowLen);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = 'rgba(255, 200, 100, 0.95)';
        ctx.lineWidth = 3;
        ctx.stroke();
        // Arrowhead
        const ah = 12;
        const pX = -dy, pY = dx;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - dx * ah + pX * ah * 0.5, ey - dy * ah + pY * ah * 0.5);
        ctx.lineTo(ex - dx * ah - pX * ah * 0.5, ey - dy * ah - pY * ah * 0.5);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 200, 100, 0.95)';
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Debug: springs
  if (options.showSprings) {
    drawSprings(ctx, world);
  }

  // Debug: shape match targets
  if (options.showShapeTargets) {
    drawShapeMatchTargets(ctx, world);
  }

  // NPC blobs
  for (let i = 0; i < npcBlobs.length; i++) {
    const hull = npcBlobs[i].getHullPolygon();
    const hue = NPC_HUES[i % NPC_HUES.length];
    const fill = npcColor(hue);
    drawBlob(ctx, hull, fill, fill, 2.25);
  }

  // Player blobs
  for (let i = 0; i < playerBlobs.length; i++) {
    const hull = playerBlobs[i].getHullPolygon();
    const pd = playerData?.[i];

    // Use player's custom color or fall back to palette
    let fill: string;
    let stroke: string;
    if (pd?.color) {
      fill = pd.color + 'd9'; // ~85% alpha
      stroke = pd.color;
    } else {
      fill = playerColorAlpha(i, 0.85);
      stroke = playerColor(i);
    }

    drawBlob(ctx, hull, fill, stroke, 2.5);

    // Draw face on blob
    if (pd) {
      const centroid = playerBlobs[i].getCentroid();
      drawBlobFace(ctx, centroid, pd.faceId, pd.expanding, pd.expandScale);
    }
  }

  // Debug: hull + center points (on top of blobs so they're visible)
  if (options.showPoints) {
    drawBlobPoints(ctx, world);
    // Outline every static collision polygon so misalignment with visual
    // platforms is obvious (rotated platforms in particular).
    ctx.strokeStyle = 'rgba(255, 100, 100, 0.85)';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 4]);
    for (const surface of world.staticSurfaces) {
      const poly = surface.poly;
      if (poly.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Sticky-wall aim indicator: arrow from blob centroid showing release direction
  for (let i = 0; i < playerBlobs.length; i++) {
    const stick = playerBlobs[i].getStickAim();
    if (!stick) continue;
    const c = playerBlobs[i].getCentroid();
    const len = 90;
    const ex = c.x + stick.aim.x * len;
    const ey = c.y + stick.aim.y * len;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 80, 0.95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Arrowhead
    const ah = 10;
    const pX = -stick.aim.y, pY = stick.aim.x;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - stick.aim.x * ah + pX * ah * 0.5, ey - stick.aim.y * ah + pY * ah * 0.5);
    ctx.lineTo(ex - stick.aim.x * ah - pX * ah * 0.5, ey - stick.aim.y * ah - pY * ah * 0.5);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 80, 0.95)';
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();

  // Mode HUD overlay (screen-space)
  modeOverlay?.renderHUD(ctx, canvasWidth, canvasHeight);
}
