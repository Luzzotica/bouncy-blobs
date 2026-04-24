import { Vec2 } from '../physics/vec2';

export interface FacePreset {
  id: string;
  label: string;
  drawNormal: (ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number) => void;
  drawPuffed: (ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number) => void;
}

function drawEyes(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, eyeW: number, eyeH: number, pupilR: number) {
  // Left eye
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(cx - 8 * s, cy - 4 * s, eyeW * s, eyeH * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(cx - 8 * s, cy - 3 * s, pupilR * s, 0, Math.PI * 2);
  ctx.fill();

  // Right eye
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(cx + 8 * s, cy - 4 * s, eyeW * s, eyeH * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(cx + 8 * s, cy - 3 * s, pupilR * s, 0, Math.PI * 2);
  ctx.fill();
}

const FACE_PRESETS: FacePreset[] = [
  {
    id: 'default',
    label: ':)',
    drawNormal(ctx, cx, cy, s) {
      drawEyes(ctx, cx, cy, s, 5, 6, 2.5);
      // Smile
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.arc(cx, cy + 4 * s, 7 * s, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      // Wide eyes
      drawEyes(ctx, cx, cy, s, 6, 7, 3);
      // Puffed cheeks (small circle mouth)
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 6 * s, 4 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // Blush
      ctx.fillStyle = 'rgba(255, 100, 100, 0.3)';
      ctx.beginPath();
      ctx.ellipse(cx - 14 * s, cy + 3 * s, 5 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + 14 * s, cy + 3 * s, 5 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: 'derp',
    label: 'xD',
    drawNormal(ctx, cx, cy, s) {
      // Derpy eyes (different sizes)
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(cx - 8 * s, cy - 4 * s, 6 * s, 7 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx - 9 * s, cy - 2 * s, 3 * s, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(cx + 8 * s, cy - 5 * s, 4 * s, 5 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx + 7 * s, cy - 4 * s, 2 * s, 0, Math.PI * 2);
      ctx.fill();

      // Tongue out
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.arc(cx, cy + 3 * s, 6 * s, 0, Math.PI);
      ctx.stroke();
      ctx.fillStyle = '#ff6688';
      ctx.beginPath();
      ctx.ellipse(cx + 3 * s, cy + 10 * s, 4 * s, 3 * s, 0.2, 0, Math.PI * 2);
      ctx.fill();
    },
    drawPuffed(ctx, cx, cy, s) {
      // X eyes
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2 * s;
      const ex = 8 * s, ey = 4 * s, es = 4 * s;
      ctx.beginPath();
      ctx.moveTo(cx - ex - es, cy - ey - es); ctx.lineTo(cx - ex + es, cy - ey + es);
      ctx.moveTo(cx - ex + es, cy - ey - es); ctx.lineTo(cx - ex - es, cy - ey + es);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + ex - es, cy - ey - es); ctx.lineTo(cx + ex + es, cy - ey + es);
      ctx.moveTo(cx + ex + es, cy - ey - es); ctx.lineTo(cx + ex - es, cy - ey + es);
      ctx.stroke();
      // Wavy mouth
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 8 * s, cy + 6 * s);
      ctx.quadraticCurveTo(cx - 4 * s, cy + 3 * s, cx, cy + 6 * s);
      ctx.quadraticCurveTo(cx + 4 * s, cy + 9 * s, cx + 8 * s, cy + 6 * s);
      ctx.stroke();
    },
  },
  {
    id: 'cool',
    label: 'B)',
    drawNormal(ctx, cx, cy, s) {
      // Sunglasses
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.roundRect(cx - 14 * s, cy - 8 * s, 11 * s, 8 * s, 2 * s);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(cx + 3 * s, cy - 8 * s, 11 * s, 8 * s, 2 * s);
      ctx.fill();
      // Bridge
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 3 * s, cy - 4 * s);
      ctx.lineTo(cx + 3 * s, cy - 4 * s);
      ctx.stroke();
      // Glint
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.arc(cx - 10 * s, cy - 6 * s, 2 * s, 0, Math.PI * 2);
      ctx.fill();
      // Smirk
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 5 * s, cy + 5 * s);
      ctx.quadraticCurveTo(cx + 2 * s, cy + 9 * s, cx + 8 * s, cy + 4 * s);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      // Sunglasses (slightly tilted)
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.roundRect(cx - 15 * s, cy - 9 * s, 12 * s, 9 * s, 2 * s);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(cx + 3 * s, cy - 9 * s, 12 * s, 9 * s, 2 * s);
      ctx.fill();
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 3 * s, cy - 5 * s);
      ctx.lineTo(cx + 3 * s, cy - 5 * s);
      ctx.stroke();
      // Puffed cheeks oval mouth
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 7 * s, 5 * s, 4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: 'angry',
    label: '>:(',
    drawNormal(ctx, cx, cy, s) {
      // Angry eyebrows
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 13 * s, cy - 10 * s);
      ctx.lineTo(cx - 4 * s, cy - 7 * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 13 * s, cy - 10 * s);
      ctx.lineTo(cx + 4 * s, cy - 7 * s);
      ctx.stroke();
      // Eyes
      drawEyes(ctx, cx, cy, s, 4, 5, 2.5);
      // Frown
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.arc(cx, cy + 12 * s, 7 * s, 1.1 * Math.PI, 1.9 * Math.PI);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      // Very angry
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 3 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 14 * s, cy - 12 * s);
      ctx.lineTo(cx - 3 * s, cy - 6 * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 14 * s, cy - 12 * s);
      ctx.lineTo(cx + 3 * s, cy - 6 * s);
      ctx.stroke();
      // Squinty eyes
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx - 8 * s, cy - 3 * s, 5 * s, 2 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + 8 * s, cy - 3 * s, 5 * s, 2 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // Gritted teeth
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 8 * s, cy + 6 * s);
      ctx.lineTo(cx + 8 * s, cy + 6 * s);
      ctx.stroke();
      // Teeth lines
      for (let i = -6; i <= 6; i += 4) {
        ctx.beginPath();
        ctx.moveTo(cx + i * s, cy + 4 * s);
        ctx.lineTo(cx + i * s, cy + 8 * s);
        ctx.stroke();
      }
    },
  },
  {
    id: 'uwu',
    label: 'uwu',
    drawNormal(ctx, cx, cy, s) {
      // Closed happy eyes (^_^)
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx - 8 * s, cy - 3 * s, 5 * s, 1.1 * Math.PI, 1.9 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + 8 * s, cy - 3 * s, 5 * s, 1.1 * Math.PI, 1.9 * Math.PI);
      ctx.stroke();
      // Cat mouth
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 6 * s, cy + 5 * s);
      ctx.quadraticCurveTo(cx - 2 * s, cy + 8 * s, cx, cy + 5 * s);
      ctx.quadraticCurveTo(cx + 2 * s, cy + 8 * s, cx + 6 * s, cy + 5 * s);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      // > < eyes
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2 * s;
      const es = 4 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 12 * s, cy - 6 * s);
      ctx.lineTo(cx - 7 * s, cy - 3 * s);
      ctx.lineTo(cx - 12 * s, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 4 * s, cy - 6 * s);
      ctx.lineTo(cx + 9 * s, cy - 3 * s);
      ctx.lineTo(cx + 4 * s, cy);
      ctx.stroke();
      // Small o mouth
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.arc(cx, cy + 7 * s, 3 * s, 0, Math.PI * 2);
      ctx.stroke();
      // Blush
      ctx.fillStyle = 'rgba(255, 130, 130, 0.35)';
      ctx.beginPath();
      ctx.ellipse(cx - 14 * s, cy + 2 * s, 5 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + 14 * s, cy + 2 * s, 5 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
];

const FACE_MAP = new Map(FACE_PRESETS.map(f => [f.id, f]));

export function getFacePreset(id: string): FacePreset {
  return FACE_MAP.get(id) ?? FACE_PRESETS[0];
}

export function getAllFacePresets(): FacePreset[] {
  return FACE_PRESETS;
}

/** Draw a face at the blob's centroid. */
export function drawBlobFace(
  ctx: CanvasRenderingContext2D,
  centroid: Vec2,
  faceId: string,
  isExpanding: boolean,
  expandScale: number,
): void {
  const face = getFacePreset(faceId);
  // Scale face with blob expansion (but not too much)
  const s = 0.8 + Math.min(expandScale - 1, 1.5) * 0.15;

  ctx.save();
  if (isExpanding) {
    face.drawPuffed(ctx, centroid.x, centroid.y, s);
  } else {
    face.drawNormal(ctx, centroid.x, centroid.y, s);
  }
  ctx.restore();
}
