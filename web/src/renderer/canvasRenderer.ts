import { SoftBodyWorld } from '../physics/softBodyWorld';
import { SlimeBlob } from '../physics/slimeBlob';
import { Camera } from './camera';
import { drawBlob } from './blobRenderer';
import { drawStaticPolygon } from './levelRenderer';
import { drawSprings, drawShapeMatchTargets } from './debugRenderer';
import { playerColor, playerColorAlpha, npcColor, NPC_HUES, BACKGROUND_COLOR } from './colors';
import { drawBlobFace } from './faceRenderer';

export interface RenderOptions {
  showSprings?: boolean;
  showShapeTargets?: boolean;
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
  for (const poly of world.staticPolygons) {
    drawStaticPolygon(ctx, poly);
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

  ctx.restore();

  // Mode HUD overlay (screen-space)
  modeOverlay?.renderHUD(ctx, canvasWidth, canvasHeight);
}
