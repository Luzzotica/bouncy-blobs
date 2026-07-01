// Cave foreground — black rock surrounding the MAP, with a craggy organic edge.
// World-anchored: the rock sits just OUTSIDE the map's bounding box, so it's
// invisible while the camera is in the open middle and only comes into view as
// you approach the ground, ceiling or far left/right walls. Any blob that
// strays into the rock keeps a soft pool of light around it, so characters are
// never fully cut off.
//
// Drawn on an offscreen mask (so the light pools can be soft): the mask starts
// solid black, the craggy play region is erased (destination-out), a feathered
// circle is erased around each blob, then the mask is blitted over the world.

import { fbm } from './backgroundRenderer';
import { isCave } from './colors';
import { Vec2 } from '../physics/vec2';
import { makeScratchCanvas, type ScratchCanvas } from './scratchCanvas';

export interface Bounds {
  minX: number; minY: number; maxX: number; maxY: number;
}

/** Reveal a lit pool around blobs in the rock (true) vs. hide them (false). */
const REVEAL = true;
/** Reveal radius around a blob, world units. */
const SPOTLIGHT_WORLD = 150;
/** Baseline distance the rock sits past the map edge, world units. The lit
 *  region always extends at least (MARGIN − CRAG_AMP) past the map, so blobs
 *  inside the play area are never covered. */
const MARGIN = 220;
/** Craggy swing of the rock edge, world units. Must stay below MARGIN. */
const CRAG_AMP = 140;
/** Noise frequency (per world unit) — smaller = broader boulders. */
const CRAG_FREQ = 0.006;
/** Edge sampling pitch, world units. */
const STEP = 44;

let mask: ScratchCanvas | null = null;

function ensureMask(w: number, h: number): CanvasRenderingContext2D {
  if (!mask) mask = makeScratchCanvas(w, h);
  if (!mask) throw new Error('caveForeground: no 2D canvas available');
  mask.resize(w, h);
  return mask.ctx;
}

/** Craggy edge offset at edge-parameter `s` (world units). Two octaves: broad
 * lumps + finer roughness, so it reads as rock rather than a smooth wave. */
function crag(s: number, seed: number): number {
  const broad = (fbm(s * CRAG_FREQ + seed) - 0.5) * 2;
  const fine = (fbm(s * CRAG_FREQ * 3.3 + seed + 50) - 0.5) * 2;
  return (broad * 0.78 + fine * 0.3) * CRAG_AMP;
}

export function drawCaveForeground(
  ctx: CanvasRenderingContext2D,
  camera: { position: { x: number; y: number }; zoom: number },
  w: number,
  h: number,
  bounds: Bounds | null,
  blobCenters: Vec2[],
): void {
  if (!isCave || !bounds) return;

  const m = ensureMask(w, h);
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.globalCompositeOperation = 'source-over';
  m.clearRect(0, 0, w, h);
  m.fillStyle = '#000';
  m.fillRect(0, 0, w, h);

  const zoom = camera.zoom;
  const sx = (wx: number): number => w / 2 + (wx - camera.position.x) * zoom;
  const sy = (wy: number): number => h / 2 + (wy - camera.position.y) * zoom;

  // Craggy carved region (world coords) — the map bbox grown by MARGIN with a
  // noise-perturbed edge on all four sides. Walk the perimeter: top L→R, right
  // T→B, bottom R→L, left B→T. Each edge baseline is MARGIN beyond the bbox; the
  // crag swing (< MARGIN) never reaches back inside the bbox.
  const x0 = bounds.minX - MARGIN, x1 = bounds.maxX + MARGIN;
  const y0 = bounds.minY - MARGIN, y1 = bounds.maxY + MARGIN;
  const pts: Array<[number, number]> = [];
  for (let x = x0; x <= x1; x += STEP) pts.push([x, y0 + crag(x, 0)]);
  for (let y = y0; y <= y1; y += STEP) pts.push([x1 - crag(y, 200), y]);
  for (let x = x1; x >= x0; x -= STEP) pts.push([x, y1 - crag(x, 400)]);
  for (let y = y1; y >= y0; y -= STEP) pts.push([x0 + crag(y, 600), y]);

  m.globalCompositeOperation = 'destination-out';
  m.fillStyle = '#000';
  m.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const px = sx(pts[i][0]), py = sy(pts[i][1]);
    if (i === 0) m.moveTo(px, py); else m.lineTo(px, py);
  }
  m.closePath();
  m.fill();

  // Reveal a soft pool around any blob that ventures into the rock.
  if (REVEAL) {
    m.globalCompositeOperation = 'destination-out';
    const r = SPOTLIGHT_WORLD * zoom;
    for (const c of blobCenters) {
      const px = sx(c.x), py = sy(c.y);
      const grad = m.createRadialGradient(px, py, r * 0.15, px, py, r);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.55, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      m.fillStyle = grad;
      m.beginPath();
      m.arc(px, py, r, 0, Math.PI * 2);
      m.fill();
    }
  }

  m.globalCompositeOperation = 'source-over';
  ctx.drawImage(mask!.image, 0, 0);
}
