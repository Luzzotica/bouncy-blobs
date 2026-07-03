// Menu blob playground — driven by the REAL Rust/wasm softbody engine, so the
// blobs are genuine soft bodies that collide with each other exactly like in
// gameplay. They LAUNCH up from below, arc across the screen (bumping into each
// other mid-air) and fall back out the bottom, where they're recycled and
// launched again. Grab one to drag/deform it (a velocity servo on the nearest
// hull particle — never a hard teleport, which explodes the springs) and
// release to fling it.
//
// Menu blobs are built via addBlobFromHull directly (NOT SlimeBlob) with much
// softer shape-matching than gameplay: the engine's shape matcher pulls every
// particle toward a best-fit AVERAGE-angle rest pose, which at gameplay
// stiffness acts as strong rotational resistance — dragging one point around
// the rim just snaps it back to its "slot" instead of spinning the body. With
// soft matching, ring springs + pressure carry the shape and the hull rotates
// freely under your drag.
//
// Debug: append `?springs=1` to the URL to overlay the spring network + points.

import { Vec2, vec2 } from '../physics/vec2';
import { createSoftBodyEngine, prepareEngine } from '../physics/engineSelector';
import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import * as HullPresets from '../physics/hullPresets';
import * as Tuning from '../physics/tuning';
import { drawBlob, drawBlobShine } from './blobRenderer';
import { drawBlobFace, getAllFacePresets } from './faceRenderer';

const MAX_BLOBS = 6;
const R = 48;                    // blob radius (matches gameplay BLOB_RADIUS)
const HULL_N = 16;
const GRAVITY = vec2(0, 2600);   // drives the launch arc; floatier than gameplay
const GRAB_RADIUS = 74;          // how close a click must be to a blob's center
// Grab is a VELOCITY SERVO, not a position teleport and not a stiff force
// spring. Each frame the held particle's velocity is set to glide toward the
// cursor at a bounded speed — unconditionally stable.
const FOLLOW_RATE = 18;          // 1/s — fraction of remaining gap closed per second
const MAX_PULL_SPEED = 2800;     // px/s — cap so springs to neighbours can keep up
// Soft cohesion: ~5x weaker than gameplay so the hull can rotate when dragged
// (gameplay: K=132, damp=1.5 — the damp term bleeds spin, see tuning.ts).
const MENU_SHAPE_MATCH_K = 26;
const MENU_SHAPE_MATCH_DAMP = 0.35;

const BODY_COLORS = [
  '#4ac8c8', '#ff6b7d', '#5a9cff', '#ffd54a',
  '#ff7bd5', '#8fe36b', '#b98cff', '#ff9d4a',
];
const FACE_IDS = getAllFacePresets().map(f => f.id);
const DEBUG_SPRINGS = (() => {
  try { return new URLSearchParams(window.location.search).get('springs') === '1'; }
  catch { return false; }
})();

interface MBlob {
  blobId: number;
  centerIdx: number;
  color: string;
  faceId: string;
}

export interface MenuBlobSim {
  update(dt: number, w: number, h: number): void;
  draw(ctx: CanvasRenderingContext2D): void;
  grab(x: number, y: number): boolean;
  moveTo(x: number, y: number): void;
  release(): void;
  holding(): boolean;
  hitTest(x: number, y: number): boolean;
  resize(w: number, h: number): void;
  destroy(): void;
}

const rndColor = () => BODY_COLORS[(Math.random() * BODY_COLORS.length) | 0];
const rndFace = () => FACE_IDS[(Math.random() * FACE_IDS.length) | 0];
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

function launchVel(h: number): Vec2 {
  const apex = h * (0.55 + Math.random() * 0.35);
  return vec2((Math.random() * 2 - 1) * 300, -Math.sqrt(2 * GRAVITY.y * apex));
}

function centroidOf(hull: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of hull) { x += p.x; y += p.y; }
  const n = hull.length || 1;
  return { x: x / n, y: y / n };
}

// One shared engine for the whole app lifetime (the interface exposes no
// dispose) — each sim just adds/removes its own blobs.
let sharedWorld: SoftBodyEngine | null = null;

export async function createMenuBlobSim(vw: number, vh: number): Promise<MenuBlobSim> {
  await prepareEngine();
  // 4 substeps — matches gameplay (see bouncyBlobsGame.ts). At the menu's
  // launch speeds, 2 substeps doubled the per-substep travel and made
  // blob-blob tunneling far more likely.
  if (!sharedWorld) sharedWorld = createSoftBodyEngine({ gravity: GRAVITY, substeps: 4 });
  const world = sharedWorld;

  const blobs: MBlob[] = [];
  let held: { blobId: number; idx: number } | null = null;
  let targetX = 0, targetY = 0, lastTX = 0, lastTY = 0;
  let pvx = 0, pvy = 0; // smoothed pointer velocity, for the release throw

  function addMenuBlob(origin: Vec2): MBlob {
    const result = world.addBlobFromHull({
      hullRestLocal: HullPresets.circle(HULL_N, R),
      centerLocal: vec2(0, 0),
      centerMass: Tuning.CENTER_MASS,
      hullMass: Tuning.HULL_MASS,
      springK: Tuning.SPRING_K,
      springDamp: Tuning.SPRING_DAMP,
      radialK: 0,
      radialDamp: 0,
      pressureK: Tuning.PRESSURE_K,
      shapeMatchK: MENU_SHAPE_MATCH_K,
      shapeMatchDamp: MENU_SHAPE_MATCH_DAMP,
      worldOrigin: origin,
    });
    return { blobId: result.blobId, centerIdx: result.centerIdx, color: rndColor(), faceId: rndFace() };
  }

  // Seed the pool mid-flight so the screen is populated immediately.
  for (let i = 0; i < MAX_BLOBS; i++) {
    const x = 80 + Math.random() * Math.max(1, vw - 160);
    const y = 100 + Math.random() * (vh - 200);
    const mb = addMenuBlob(vec2(x, y));
    world.applyBlobLinearVelocityDelta(mb.blobId, launchVel(vh));
    blobs.push(mb);
  }

  function relaunch(mb: MBlob, w: number, h: number): void {
    mb.color = rndColor();
    mb.faceId = rndFace();
    const x = 60 + Math.random() * Math.max(1, w - 120);
    world.resetBlobToRest(mb.blobId, vec2(x, h + R + 20));
    world.applyBlobLinearVelocityDelta(mb.blobId, launchVel(h));
  }

  function nearest(x: number, y: number): { blobId: number; idx: number } | null {
    const pos = world.getPositions();
    let best: { blobId: number; idx: number } | null = null;
    let bestD = Infinity;
    for (const mb of blobs) {
      const range = world.getBlobRange(mb.blobId);
      if (!range) continue;
      const c = centroidOf(world.getHullPolygon(mb.blobId));
      if (Math.hypot(c.x - x, c.y - y) > GRAB_RADIUS) continue;
      for (const i of range.hull) {
        const p = pos[i];
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) { bestD = d; best = { blobId: mb.blobId, idx: i }; }
      }
    }
    return best;
  }

  return {
    update(dt, w, h) {
      if (dt > 0.05) dt = 0.05;
      if (dt <= 0) return;

      if (held) {
        // Track a smoothed pointer velocity for the release throw.
        pvx = pvx * 0.6 + ((targetX - lastTX) / dt) * 0.4;
        pvy = pvy * 0.6 + ((targetY - lastTY) / dt) * 0.4;
        // Velocity servo: glide the held particle toward the cursor at a
        // bounded speed. The rest of the body trails via the engine's own
        // springs and sags under gravity while you hold.
        const pos = world.getPositions();
        const p = pos[held.idx];
        let sx = (targetX - p.x) * FOLLOW_RATE;
        let sy = (targetY - p.y) * FOLLOW_RATE;
        const sm = Math.hypot(sx, sy);
        if (sm > MAX_PULL_SPEED) { const s = MAX_PULL_SPEED / sm; sx *= s; sy *= s; }
        world.setParticleVel(held.idx, sx, sy);
      }
      lastTX = targetX; lastTY = targetY;

      world.step(dt);

      // Recycle blobs that have left the screen (never the held one).
      for (const mb of blobs) {
        if (held && held.blobId === mb.blobId) continue;
        const c = centroidOf(world.getHullPolygon(mb.blobId));
        if (c.y - R > h + 80 || c.x < -220 || c.x > w + 220) relaunch(mb, w, h);
      }
    },

    draw(ctx) {
      const time = performance.now() / 1000;
      const vels = world.getVelocities();
      for (const mb of blobs) {
        const hull = world.getHullPolygon(mb.blobId);
        if (hull.length < 3) continue;
        const c = centroidOf(hull);
        const cv = vels[mb.centerIdx] ?? { x: 0, y: 0 };
        drawBlob(ctx, hull, mb.color + 'd9', mb.color, 2.5, 0.5);
        drawBlobShine(ctx, hull, time, c, cv);
        drawBlobFace(ctx, c, mb.faceId, false, 1, { x: clamp1(cv.x / 500), y: clamp1(cv.y / 500) });
      }

      if (DEBUG_SPRINGS) {
        const pos = world.getPositions();
        const pairs = world.getSpringIndexPairs();
        ctx.save();
        ctx.strokeStyle = 'rgba(0,255,180,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const [a, b] of pairs) {
          const pa = pos[a], pb = pos[b];
          if (!pa || !pb) continue;
          ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
        }
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,220,80,0.9)';
        for (const mb of blobs) {
          const range = world.getBlobRange(mb.blobId);
          if (!range) continue;
          for (let i = range.start; i < range.end; i++) {
            const p = pos[i];
            if (!p) continue;
            ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
          }
        }
        if (held) {
          const p = pos[held.idx];
          ctx.strokeStyle = 'rgba(255,80,80,0.9)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(targetX, targetY); ctx.stroke();
          ctx.fillStyle = 'rgba(255,80,80,0.9)';
          ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
    },

    grab(x, y) {
      const hit = nearest(x, y);
      if (hit) { held = hit; targetX = lastTX = x; targetY = lastTY = y; pvx = pvy = 0; return true; }
      return false;
    },
    moveTo(x, y) { targetX = x; targetY = y; },
    release() {
      if (held) {
        const tx = Math.max(-1800, Math.min(1800, pvx));
        const ty = Math.max(-1800, Math.min(1800, pvy));
        world.applyBlobLinearVelocityDelta(held.blobId, vec2(tx, ty));
      }
      held = null;
    },
    holding() { return held !== null; },
    hitTest(x, y) { return nearest(x, y) !== null; },
    resize() { /* no container walls — free launch space */ },
    destroy() {
      for (const mb of blobs) world.removeBlob(mb.blobId);
      blobs.length = 0;
    },
  };
}
