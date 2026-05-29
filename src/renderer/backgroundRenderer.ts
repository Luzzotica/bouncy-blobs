// Game background images — multiple cartoon-candy backdrops drawn behind
// everything in screen space. The renderer holds all variants once they
// load; `preloadBackground()` (called on each level/game init) picks a
// new random variant so the world doesn't look the same on every run.

const VARIANTS = [
  '/backgrounds/game_bg_workbench_corner.png',
  '/backgrounds/game_bg_couch_corner.png',
  '/backgrounds/game_bg_goop_tank_wide.png',
];

const images: HTMLImageElement[] = [];
const ready: boolean[] = [];
let currentIndex = 0;
let loaded = false;

function loadAll(): void {
  if (loaded) return;
  loaded = true;
  for (let i = 0; i < VARIANTS.length; i++) {
    const idx = i;
    const img = new Image();
    img.onload = () => { ready[idx] = true; };
    img.onerror = () => { /* leave ready[idx] = false; renderer falls back */ };
    img.src = VARIANTS[i];
    images.push(img);
    ready.push(false);
  }
}

/** Trigger image loading (idempotent) and pick a new random variant for
 * this level/session. Called at the top of each game/sandbox init so each
 * run rolls a fresh backdrop. */
export function preloadBackground(): void {
  loadAll();
  if (VARIANTS.length > 0) {
    currentIndex = Math.floor(Math.random() * VARIANTS.length);
  }
}

/** Draw the currently-picked background image scaled to FIT inside the
 * viewport (contain), with a small camera-driven parallax offset. Letterbox
 * bars on whichever axis is shorter pick up the `fallback` color. Called
 * BEFORE the camera transform — this draws in screen space. */
export function drawGameBackground(
  ctx: CanvasRenderingContext2D,
  camera: { position: { x: number; y: number } },
  canvasWidth: number,
  canvasHeight: number,
  fallback: string,
): void {
  // Always fill the viewport with the fallback first — covers letterbox
  // bars and the fully-not-loaded case.
  ctx.fillStyle = fallback;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const img = images[currentIndex];
  if (!img || !ready[currentIndex]) return;

  // object-fit: cover — image is scaled to fully cover the viewport with
  // the excess cropped on whichever axis is longer. Then bumped up by an
  // OVERSCAN factor so there's slack on both axes for parallax movement
  // without ever exposing the image's edge.
  const OVERSCAN = 1.18;
  const imgRatio = img.width / img.height;
  const vpRatio  = canvasWidth / canvasHeight;
  let drawW: number, drawH: number;
  if (vpRatio > imgRatio) {
    drawW = canvasWidth;
    drawH = canvasWidth / imgRatio;
  } else {
    drawH = canvasHeight;
    drawW = canvasHeight * imgRatio;
  }
  drawW *= OVERSCAN;
  drawH *= OVERSCAN;
  const baseX = (canvasWidth  - drawW) * 0.5;
  const baseY = (canvasHeight - drawH) * 0.5;

  // Very subtle parallax — and CLAMPED to the overscan slack so we can
  // never push the image past the viewport edge regardless of how far the
  // camera roams. On big levels this means the bg appears almost still
  // (which is what we want — it's distant scenery, not a moving tile).
  const PARALLAX = 0.012;
  const slackX = (drawW - canvasWidth)  * 0.5;
  const slackY = (drawH - canvasHeight) * 0.5;
  let px = -camera.position.x * PARALLAX;
  let py = -camera.position.y * PARALLAX;
  if (px >  slackX) px =  slackX; else if (px < -slackX) px = -slackX;
  if (py >  slackY) py =  slackY; else if (py < -slackY) py = -slackY;

  ctx.drawImage(img, baseX + px, baseY + py, drawW, drawH);

  // Very light wash to keep foreground contrast — cartoon palette is
  // already mid-tone so we don't need to darken much.
  ctx.fillStyle = 'rgba(10, 10, 28, 0.08)';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
}
