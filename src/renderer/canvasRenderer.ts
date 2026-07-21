import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { SlimeBlob } from '../physics/slimeBlob';
import { Camera } from './camera';
import { drawBlob, drawBlobShine, perturbHullForWind } from './blobRenderer';
import { drawJellyCandy, drawFlatSurface, SOFT_PLATFORM_PALETTE, setCandyParallax } from './candySkin';
import { drawStaticPolygon } from './levelRenderer';
import { drawSprings, drawShapeMatchTargets, drawBlobPoints, drawBlobHulls } from './debugRenderer';
import { playerColor, playerColorAlpha, npcColor, NPC_HUES, BACKGROUND_COLOR, isCave, CAVE_PLATFORM_FILL, CAVE_GRAVITY_POINT_RGB, CAVE_GRAVITY_DIR_RGB, displayColor } from './colors';
import { getHighContrast, getGameTextScale } from '../utils/accessibilitySettings';
import { drawBlobFace } from './faceRenderer';
import { drawChain } from './chainRenderer';
import { renderDecals } from './decals';
import { drawGameBackground } from './backgroundRenderer';
import { drawCaveForeground } from './caveForeground';
import { renderParticles } from './particles';
import { impactsFor } from './blobImpacts';
import { drawLava } from './lavaRenderer';
import { Vec2 } from '../physics/vec2';

/** Extra world-space margin so the lava reaches past the viewport edges and
 *  its surface wave never reveals a seam at the screen border. */
const WAVE_PAD = 80;

// Render-only velocity tracker: per-blob {prevCentroid, prevTimeMs}. Used to
// drive wind ripples + leading-edge perturbation. The physics engine has its
// own velocity, but threading it through every render layer is messy and the
// shine doesn't need exact values — a centroid-delta estimate is plenty.
//
// `armed` is a debouncer for the wind perturbation: the reported velocity is
// zeroed until the blob has sustained motion above WIND_ARM_SPEED for
// WIND_ARM_SECONDS. Without this, fresh-spawned blobs (which fall into place
// from their spawn point) flash the wind ruffle on landing, and a settled
// blob's residual centroid jitter can also flicker it on. Disarms instantly
// when speed drops below threshold so a blob that stops moving snaps back to
// its raw hull.
const WIND_ARM_SPEED = 140;
const WIND_ARM_SECONDS = 0.15;
const renderVel = new Map<number, {
  x: number; y: number; vx: number; vy: number; t: number;
  armTimer: number; armed: boolean;
}>();
/** Draw a player's name tag in world space, anchored just above
 *  (worldX, topY). Called inside the camera transform — font size is
 *  therefore in world units, which is fine because zoom is bounded by
 *  the camera follower. A dark stroke under the fill keeps the text
 *  readable over both pale and saturated blob colors. */
function drawNameTag(ctx: CanvasRenderingContext2D, name: string, worldX: number, topY: number, color: string): void {
  const fontPx = Math.round(18 * getGameTextScale());
  const padAbove = 12;
  ctx.save();
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const y = topY - padAbove;
  if (getHighContrast()) {
    // Solid dark pill + white text — maximum legibility over any scene.
    const w = ctx.measureText(name).width;
    const padX = 7;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
    ctx.fillRect(worldX - w / 2 - padX, y - fontPx - 3, w + padX * 2, fontPx + 7);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, worldX, y);
  } else {
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillStyle = displayColor(color) || '#ffffff';
    ctx.strokeText(name, worldX, y);
    ctx.fillText(name, worldX, y);
  }
  ctx.restore();
}

function sampleBlobVelocity(blob: SlimeBlob, c: Vec2, nowMs: number): { x: number; y: number } {
  const prev = renderVel.get(blob.blobId);
  let vx = 0, vy = 0;
  let armTimer = 0;
  let armed = false;
  if (prev) {
    const dt = Math.max(0.001, (nowMs - prev.t) / 1000);
    // Cap dt so a long pause (tab backgrounded) doesn't produce huge spikes.
    const safeDt = Math.min(dt, 0.1);
    vx = (c.x - prev.x) / safeDt;
    vy = (c.y - prev.y) / safeDt;
    // Soft EMA so per-frame jitter doesn't strobe the rim/wind effects.
    const a = 0.4;
    vx = prev.vx * (1 - a) + vx * a;
    vy = prev.vy * (1 - a) + vy * a;
    const speed = Math.hypot(vx, vy);
    if (speed >= WIND_ARM_SPEED) {
      armTimer = Math.min(WIND_ARM_SECONDS, prev.armTimer + safeDt);
      armed = prev.armed || armTimer >= WIND_ARM_SECONDS;
    } else {
      armTimer = 0;
      armed = false;
    }
  }
  renderVel.set(blob.blobId, { x: c.x, y: c.y, vx, vy, t: nowMs, armTimer, armed });
  if (!armed) return { x: 0, y: 0 };
  return { x: vx, y: vy };
}

export interface SoftPlatformRenderInfo {
  id: string;
  hullIndices: number[];
  staticHullIndices: number[];
}

export interface ChainRenderInfo {
  particleIndices: number[];
  totalLength: number;
}

export interface RenderOptions {
  showSprings?: boolean;
  showShapeTargets?: boolean;
  showPoints?: boolean;
  /** Draw each blob's hull perimeter polygon + its hull points. */
  showHull?: boolean;
  /**
   * Hull corner smoothing for drawBlob (0 = sharp polygon, 0.5 = full blob round).
   * Kids shape mode uses a lower value so stars/squares read as shapes.
   */
  cornerRoundness?: number;
}

export interface ModeOverlay {
  renderWorld: (ctx: CanvasRenderingContext2D) => void;
  renderHUD: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
}

export interface PlayerRenderData {
  name: string;
  color: string;
  faceId: string;
  expanding: boolean;
  expandScale: number;
  /** Smoothed gaze direction (unit-ish). Drives pupil offset in face renderer. */
  gaze: { x: number; y: number };
}

// Gravity-zone overlay rgb prefixes — dimmed to cooler tones in the cave
// theme. Zero-g zones are already cyan (cool) so they're left as-is.
const GRAV_POINT_RGB = isCave
  ? `${CAVE_GRAVITY_POINT_RGB.r}, ${CAVE_GRAVITY_POINT_RGB.g}, ${CAVE_GRAVITY_POINT_RGB.b}`
  : '180, 60, 220';
const GRAV_DIR_RGB = isCave
  ? `${CAVE_GRAVITY_DIR_RGB.r}, ${CAVE_GRAVITY_DIR_RGB.g}, ${CAVE_GRAVITY_DIR_RGB.b}`
  : '255, 160, 60';
const GRAV_DIR_ARROW_RGB = isCave
  ? `${CAVE_GRAVITY_DIR_RGB.r}, ${CAVE_GRAVITY_DIR_RGB.g}, ${CAVE_GRAVITY_DIR_RGB.b}`
  : '255, 200, 100';

/** Mean of a hull's nodes — the centroid of the (possibly interpolated) polygon
 *  used to anchor the face + name tag so they follow the drawn shape. */
function centroidOf(hull: { x: number; y: number }[]): { x: number; y: number } {
  let x = 0, y = 0;
  for (const p of hull) { x += p.x; y += p.y; }
  const n = hull.length || 1;
  return { x: x / n, y: y / n };
}

export function render(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyEngine,
  camera: Camera,
  playerBlobs: SlimeBlob[],
  npcBlobs: SlimeBlob[],
  canvasWidth: number,
  canvasHeight: number,
  options: RenderOptions = {},
  modeOverlay?: ModeOverlay,
  playerData?: PlayerRenderData[],
  softPlatforms: SoftPlatformRenderInfo[] = [],
  chains: ChainRenderInfo[] = [],
  killPlaneY?: number,
  /** Per-blob INTERPOLATED HULL (blobId → world-space node positions). Composes
   *  per-node physics→render interpolation (lerp between the last two ticks by the
   *  accumulator alpha) with the post-rollback DisplaySmoother ease-in, so BOTH
   *  motion and SHAPE (expansion) are decoupled from raw physics. The blob is drawn
   *  from this hull instead of its live one — render-only, never touches the sim. */
  renderHulls?: Map<number, { x: number; y: number }[]>,
  /** Debug overlay: draw each blob's RAW physics hull nodes (un-interpolated) as
   *  dots, to visualize how far the smoothed visuals lag the sim. */
  showPhysicsPoints = false,
): void {
  // Background image (or solid fallback color while it's still loading).
  // High-contrast mode: a flat dark backdrop instead of the decorated art so
  // foreground gameplay elements stand out.
  const highContrast = getHighContrast();
  if (highContrast) {
    ctx.fillStyle = '#0a0c14';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  } else {
    drawGameBackground(ctx, camera, canvasWidth, canvasHeight, BACKGROUND_COLOR);
  }

  ctx.save();

  // Camera transform
  const cx = canvasWidth / 2 - camera.position.x * camera.zoom;
  const cy = canvasHeight / 2 - camera.position.y * camera.zoom;
  ctx.translate(cx, cy);
  ctx.scale(camera.zoom, camera.zoom);

  // Mode world overlays (zones, behind everything)
  modeOverlay?.renderWorld(ctx);

  // Parallax anchor for candy-skin inclusions — bubbles inside the candy
  // drift gently with the camera to fake interior depth.
  setCandyParallax(camera.position.x, camera.position.y);

  // Static polygons
  for (const surface of world.staticSurfaces) {
    drawStaticPolygon(ctx, surface.poly, surface.material);
  }

  // Soft platforms — lightly-rounded polygon following current hull positions
  for (const sp of softPlatforms) {
    if (sp.hullIndices.length < 3) continue;
    const positions = world.getPositions();
    const hull = sp.hullIndices.map(i => positions[i]);
    if (isCave) {
      drawFlatSurface(ctx, hull, CAVE_PLATFORM_FILL, 0.18);
    } else {
      drawJellyCandy(ctx, hull, SOFT_PLATFORM_PALETTE, 0.18, `soft-${sp.id}`);
    }
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
      grad.addColorStop(0, `rgba(${GRAV_POINT_RGB}, 0.55)`);
      grad.addColorStop(1, `rgba(${GRAV_POINT_RGB}, 0)`);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = `rgba(${GRAV_POINT_RGB}, 0.6)`;
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
        ctx.fillStyle = `rgba(${GRAV_DIR_RGB}, 0.16)`;
        ctx.strokeStyle = `rgba(${GRAV_DIR_RGB}, 0.7)`;
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
        ctx.strokeStyle = `rgba(${GRAV_DIR_ARROW_RGB}, 0.95)`;
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
        ctx.fillStyle = `rgba(${GRAV_DIR_ARROW_RGB}, 0.95)`;
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

  // Persistent slime decals — drawn ON the world geometry, UNDER the blobs.
  renderDecals(ctx);

  // Shared monotonic seconds for ambient ripple phase + any future time-
  // driven effects in the blob shine. Lives in the renderer so blobs in
  // unrelated game modes share one clock.
  const nowMs = performance.now();
  const shineTime = nowMs / 1000;

  // Goopy lava at the fall-off-the-map kill plane — under the blobs so a
  // falling blob visibly sinks into it. Spans the full visible width and down
  // to the bottom of the viewport (world-space; camera transform is active).
  if (killPlaneY !== undefined) {
    const halfW = canvasWidth / (2 * camera.zoom);
    const left = camera.position.x - halfW - WAVE_PAD;
    const right = camera.position.x + halfW + WAVE_PAD;
    const bottom = camera.position.y + canvasHeight / (2 * camera.zoom) + WAVE_PAD;
    if (bottom > killPlaneY) drawLava(ctx, killPlaneY, left, right, bottom, shineTime);
  }

  // Chains/tethers — drawn BEHIND the blobs so the line tucks under them.
  for (const chain of chains) {
    drawChain(ctx, world, chain.particleIndices, chain.totalLength);
  }

  // NPC blobs — no wind perturbation; NPCs render with their raw hull so
  // they don't appear to jitter when idle (the soft-body sim already
  // produces a tiny centroid wobble that would otherwise drive the wind
  // shader on a stationary NPC).
  for (let i = 0; i < npcBlobs.length; i++) {
    const npc = npcBlobs[i];
    if (npc.destroyed) continue; // retired NPC (e.g. fell off the map) — don't draw
    const hull = renderHulls?.get(npc.blobId) ?? npc.getHullPolygon();
    const c = centroidOf(hull);
    const v = sampleBlobVelocity(npc, npc.getCentroid(), nowMs);
    const hue = NPC_HUES[i % NPC_HUES.length];
    const fill = npcColor(hue);
    const roundness = options.cornerRoundness ?? 0.5;
    drawBlob(ctx, hull, fill, fill, 2.25, roundness);
    drawBlobShine(ctx, hull, shineTime, c, v, impactsFor(npc.blobId), roundness);
  }

  // Player blobs
  const cornerRoundness = options.cornerRoundness ?? 0.5;
  for (let i = 0; i < playerBlobs.length; i++) {
    const blob = playerBlobs[i];
    // Draw from the interpolated/smoothed hull (motion + shape eased) when present,
    // else the raw physics hull. The face/name follow this hull's centroid so the
    // whole blob moves together.
    const hull = renderHulls?.get(blob.blobId) ?? blob.getHullPolygon();
    const c = centroidOf(hull);
    const v = sampleBlobVelocity(blob, blob.getCentroid(), nowMs);
    const pd = playerData?.[i];

    // Use player's custom color or fall back to palette. High contrast:
    // fully-opaque fill + thick dark outline so blobs pop off the scene.
    let fill: string;
    let stroke: string;
    if (pd?.color) {
      const base = displayColor(pd.color);
      fill = highContrast ? base : base + 'd9'; // ~85% alpha when not HC
      stroke = highContrast ? '#0a0612' : base;
    } else {
      fill = playerColorAlpha(i, highContrast ? 1 : 0.85);
      stroke = highContrast ? '#0a0612' : playerColor(i);
    }

    drawBlob(ctx, hull, fill, stroke, highContrast ? 4 : 2.5, cornerRoundness);
    drawBlobShine(ctx, hull, shineTime, c, v, impactsFor(blob.blobId), cornerRoundness);

    // Draw face at the interpolated centroid.
    if (pd) {
      drawBlobFace(ctx, c, pd.faceId, pd.expanding, pd.expandScale, pd.gaze);
    }

    // Name tag above the blob — anchored to the (interpolated) hull's topmost
    // vertex so it tracks expansion and sits just above the silhouette.
    if (pd?.name) {
      let topY = Infinity;
      for (let k = 0; k < hull.length; k++) {
        if (hull[k].y < topY) topY = hull[k].y;
      }
      drawNameTag(ctx, pd.name, c.x, topY, pd.color);
    }
  }

  // Debug overlay: each blob's RAW physics hull nodes (un-interpolated) as dots,
  // so the gap between the sim and the smoothed visuals is visible.
  if (showPhysicsPoints) {
    ctx.save();
    ctx.fillStyle = '#ff2d5d';
    for (const b of [...playerBlobs, ...npcBlobs]) {
      if (b.destroyed) continue;
      for (const n of b.getHullPolygon()) { ctx.beginPath(); ctx.arc(n.x, n.y, 2.5, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }

  // Debug: hull perimeter + hull points (on top of blobs so they're visible)
  if (options.showHull) {
    drawBlobHulls(ctx, world);
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

  // Particles (transient impact/puff/sparkle bursts) — on top of blobs.
  renderParticles(ctx);

  ctx.restore();

  // Cave foreground — craggy black rock surrounding the MAP. World-anchored so
  // it only appears as the camera nears a map edge; never covers the open
  // middle. Bounds computed here from the static geometry + soft-platform hulls.
  if (isCave && !highContrast) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const surface of world.staticSurfaces) {
      for (const p of surface.poly) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    const positions = world.getPositions();
    for (const sp of softPlatforms) {
      for (const i of sp.hullIndices) {
        const p = positions[i];
        if (!p) continue;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    const bounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
    const centers: Vec2[] = [];
    for (const b of playerBlobs) centers.push(b.getCentroid());
    for (const b of npcBlobs) centers.push(b.getCentroid());
    drawCaveForeground(ctx, camera, canvasWidth, canvasHeight, bounds, centers);
  }

  // Mode HUD overlay (screen-space)
  modeOverlay?.renderHUD(ctx, canvasWidth, canvasHeight);
}
