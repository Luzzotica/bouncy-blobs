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
  {
    id: 'sleepy',
    label: '-_-',
    drawNormal(ctx, cx, cy, s) {
      // Half-closed eyes
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 12 * s, cy - 3 * s);
      ctx.lineTo(cx - 4 * s, cy - 3 * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 4 * s, cy - 3 * s);
      ctx.lineTo(cx + 12 * s, cy - 3 * s);
      ctx.stroke();
      // Small droopy mouth
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 4 * s, cy + 6 * s);
      ctx.lineTo(cx + 4 * s, cy + 6 * s);
      ctx.stroke();
      // Zzz
      ctx.font = `bold ${10 * s}px sans-serif`;
      ctx.fillStyle = 'rgba(150,180,255,0.6)';
      ctx.textAlign = 'left';
      ctx.fillText('z', cx + 14 * s, cy - 8 * s);
      ctx.font = `bold ${7 * s}px sans-serif`;
      ctx.fillText('z', cx + 18 * s, cy - 14 * s);
    },
    drawPuffed(ctx, cx, cy, s) {
      // Startled awake — wide eyes
      drawEyes(ctx, cx, cy, s, 7, 8, 3.5);
      // Yawning mouth
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 7 * s, 6 * s, 5 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: 'star',
    label: '*_*',
    drawNormal(ctx, cx, cy, s) {
      // Star eyes
      ctx.fillStyle = '#ffd700';
      for (const ox of [-8, 8]) {
        ctx.save();
        ctx.translate(cx + ox * s, cy - 4 * s);
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          ctx.moveTo(0, -5 * s);
          ctx.lineTo(1.5 * s, -1.5 * s);
          ctx.lineTo(5 * s, -1.5 * s);
          ctx.lineTo(2 * s, 1 * s);
          ctx.lineTo(3 * s, 5 * s);
          ctx.lineTo(0, 2.5 * s);
          ctx.lineTo(-3 * s, 5 * s);
          ctx.lineTo(-2 * s, 1 * s);
          ctx.lineTo(-5 * s, -1.5 * s);
          ctx.lineTo(-1.5 * s, -1.5 * s);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
      // Happy open mouth
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx, cy + 5 * s, 5 * s, 0, Math.PI);
      ctx.fill();
    },
    drawPuffed(ctx, cx, cy, s) {
      // Spinning star eyes
      ctx.fillStyle = '#ffd700';
      for (const ox of [-8, 8]) {
        ctx.save();
        ctx.translate(cx + ox * s, cy - 4 * s);
        ctx.beginPath();
        ctx.arc(0, 0, 6 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 7 * s, 7 * s, 5 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: 'cat',
    label: ':3',
    drawNormal(ctx, cx, cy, s) {
      // Cat ears (triangles on top)
      ctx.fillStyle = 'rgba(255,150,200,0.5)';
      ctx.beginPath();
      ctx.moveTo(cx - 15 * s, cy - 12 * s);
      ctx.lineTo(cx - 10 * s, cy - 22 * s);
      ctx.lineTo(cx - 5 * s, cy - 12 * s);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + 5 * s, cy - 12 * s);
      ctx.lineTo(cx + 10 * s, cy - 22 * s);
      ctx.lineTo(cx + 15 * s, cy - 12 * s);
      ctx.fill();
      // Eyes
      drawEyes(ctx, cx, cy, s, 4, 5, 2);
      // :3 mouth
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.arc(cx - 3 * s, cy + 5 * s, 3 * s, 0, Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + 3 * s, cy + 5 * s, 3 * s, 0, Math.PI);
      ctx.stroke();
      // Whiskers
      ctx.lineWidth = 1 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 18 * s, cy + 2 * s); ctx.lineTo(cx - 8 * s, cy + 4 * s);
      ctx.moveTo(cx - 17 * s, cy + 6 * s); ctx.lineTo(cx - 8 * s, cy + 5 * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 18 * s, cy + 2 * s); ctx.lineTo(cx + 8 * s, cy + 4 * s);
      ctx.moveTo(cx + 17 * s, cy + 6 * s); ctx.lineTo(cx + 8 * s, cy + 5 * s);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      // Cat ears
      ctx.fillStyle = 'rgba(255,150,200,0.5)';
      ctx.beginPath();
      ctx.moveTo(cx - 15 * s, cy - 12 * s);
      ctx.lineTo(cx - 10 * s, cy - 22 * s);
      ctx.lineTo(cx - 5 * s, cy - 12 * s);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + 5 * s, cy - 12 * s);
      ctx.lineTo(cx + 10 * s, cy - 22 * s);
      ctx.lineTo(cx + 15 * s, cy - 12 * s);
      ctx.fill();
      // Wide eyes
      drawEyes(ctx, cx, cy, s, 6, 7, 3);
      // Hissing mouth
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.moveTo(cx - 7 * s, cy + 4 * s);
      ctx.lineTo(cx, cy + 10 * s);
      ctx.lineTo(cx + 7 * s, cy + 4 * s);
      ctx.fill();
    },
  },
  {
    id: 'shock',
    label: 'O_O',
    drawNormal(ctx, cx, cy, s) {
      // Big round eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx - 8 * s, cy - 4 * s, 7 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx - 8 * s, cy - 3 * s, 3.5 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx + 8 * s, cy - 4 * s, 7 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx + 8 * s, cy - 3 * s, 3.5 * s, 0, Math.PI * 2);
      ctx.fill();
      // Small O mouth
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.arc(cx, cy + 7 * s, 4 * s, 0, Math.PI * 2);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      // Even bigger eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx - 9 * s, cy - 4 * s, 9 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx - 9 * s, cy - 3 * s, 2 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx + 9 * s, cy - 4 * s, 9 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx + 9 * s, cy - 3 * s, 2 * s, 0, Math.PI * 2);
      ctx.fill();
      // Big O mouth
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 8 * s, 6 * s, 7 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: 'wink',
    label: ';)',
    drawNormal(ctx, cx, cy, s) {
      // Left eye (open)
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(cx - 8 * s, cy - 4 * s, 5 * s, 6 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx - 8 * s, cy - 3 * s, 2.5 * s, 0, Math.PI * 2);
      ctx.fill();
      // Right eye (winking)
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx + 8 * s, cy - 3 * s, 5 * s, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.stroke();
      // Smile
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.arc(cx, cy + 4 * s, 7 * s, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      // Both eyes open wide
      drawEyes(ctx, cx, cy, s, 6, 7, 3);
      // Cheeky grin
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx, cy + 5 * s, 6 * s, 0, Math.PI);
      ctx.fill();
      // Tongue
      ctx.fillStyle = '#ff6688';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 11 * s, 3 * s, 2 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: 'smug',
    label: '>.>',
    drawNormal(ctx, cx, cy, s) {
      // Half-lidded eyes looking to side
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(cx - 8 * s, cy - 3 * s, 5 * s, 4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx - 5 * s, cy - 2 * s, 2.5 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(cx + 8 * s, cy - 3 * s, 5 * s, 4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx + 11 * s, cy - 2 * s, 2.5 * s, 0, Math.PI * 2);
      ctx.fill();
      // Eyelids (top half)
      ctx.fillStyle = 'rgba(30,30,30,0.15)';
      ctx.beginPath();
      ctx.ellipse(cx - 8 * s, cy - 5 * s, 5.5 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + 8 * s, cy - 5 * s, 5.5 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // Smirk
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 4 * s, cy + 6 * s);
      ctx.quadraticCurveTo(cx + 4 * s, cy + 6 * s, cx + 8 * s, cy + 3 * s);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      drawEyes(ctx, cx, cy, s, 5, 6, 2.5);
      // Forced grin
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx, cy + 4 * s, 8 * s, 0.05 * Math.PI, 0.95 * Math.PI);
      ctx.stroke();
    },
  },
  {
    id: 'cry',
    label: 'T_T',
    drawNormal(ctx, cx, cy, s) {
      // Crying eyes
      drawEyes(ctx, cx, cy, s, 5, 6, 2.5);
      // Eyebrows (worried)
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 13 * s, cy - 8 * s);
      ctx.lineTo(cx - 4 * s, cy - 10 * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 13 * s, cy - 8 * s);
      ctx.lineTo(cx + 4 * s, cy - 10 * s);
      ctx.stroke();
      // Tears
      ctx.fillStyle = 'rgba(100,180,255,0.6)';
      ctx.beginPath();
      ctx.ellipse(cx - 12 * s, cy + 4 * s, 2 * s, 5 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + 12 * s, cy + 4 * s, 2 * s, 5 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // Wobbly mouth
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 6 * s, cy + 8 * s);
      ctx.quadraticCurveTo(cx - 3 * s, cy + 6 * s, cx, cy + 8 * s);
      ctx.quadraticCurveTo(cx + 3 * s, cy + 10 * s, cx + 6 * s, cy + 8 * s);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      drawEyes(ctx, cx, cy, s, 6, 7, 3);
      // Big tears
      ctx.fillStyle = 'rgba(100,180,255,0.7)';
      ctx.beginPath();
      ctx.ellipse(cx - 14 * s, cy + 4 * s, 3 * s, 8 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + 14 * s, cy + 4 * s, 3 * s, 8 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // Wailing mouth
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 8 * s, 7 * s, 6 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: 'skull',
    label: 'x_x',
    drawNormal(ctx, cx, cy, s) {
      // Hollow circle eyes
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx - 8 * s, cy - 4 * s, 5 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + 8 * s, cy - 4 * s, 5 * s, 0, Math.PI * 2);
      ctx.stroke();
      // Nose hole
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.moveTo(cx, cy + 1 * s);
      ctx.lineTo(cx - 2 * s, cy + 5 * s);
      ctx.lineTo(cx + 2 * s, cy + 5 * s);
      ctx.fill();
      // Stitched mouth
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 8 * s, cy + 9 * s);
      ctx.lineTo(cx + 8 * s, cy + 9 * s);
      ctx.stroke();
      for (let i = -6; i <= 6; i += 4) {
        ctx.beginPath();
        ctx.moveTo(cx + i * s, cy + 7 * s);
        ctx.lineTo(cx + i * s, cy + 11 * s);
        ctx.stroke();
      }
    },
    drawPuffed(ctx, cx, cy, s) {
      // X eyes
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2.5 * s;
      const es = 4 * s;
      for (const ox of [-8, 8]) {
        ctx.beginPath();
        ctx.moveTo(cx + ox * s - es, cy - 4 * s - es);
        ctx.lineTo(cx + ox * s + es, cy - 4 * s + es);
        ctx.moveTo(cx + ox * s + es, cy - 4 * s - es);
        ctx.lineTo(cx + ox * s - es, cy - 4 * s + es);
        ctx.stroke();
      }
      // Ghost mouth
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 8 * s, 5 * s, 4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: 'clown',
    label: '0w0',
    drawNormal(ctx, cx, cy, s) {
      // Eyes with lashes
      drawEyes(ctx, cx, cy, s, 5, 6, 2.5);
      // Red nose
      ctx.fillStyle = '#ff3333';
      ctx.beginPath();
      ctx.arc(cx, cy + 2 * s, 4 * s, 0, Math.PI * 2);
      ctx.fill();
      // Big smile
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx, cy + 4 * s, 10 * s, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.stroke();
      // Cheek circles
      ctx.fillStyle = 'rgba(255,100,100,0.4)';
      ctx.beginPath();
      ctx.arc(cx - 14 * s, cy + 3 * s, 4 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + 14 * s, cy + 3 * s, 4 * s, 0, Math.PI * 2);
      ctx.fill();
    },
    drawPuffed(ctx, cx, cy, s) {
      drawEyes(ctx, cx, cy, s, 7, 8, 3.5);
      // Big red nose
      ctx.fillStyle = '#ff3333';
      ctx.beginPath();
      ctx.arc(cx, cy + 2 * s, 6 * s, 0, Math.PI * 2);
      ctx.fill();
      // Honk mouth
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 10 * s, 8 * s, 5 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: 'tired',
    label: 'u_u',
    drawNormal(ctx, cx, cy, s) {
      // Bags under eyes
      ctx.fillStyle = 'rgba(100,80,120,0.3)';
      ctx.beginPath();
      ctx.ellipse(cx - 8 * s, cy, 6 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + 8 * s, cy, 6 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // Droopy eyes
      drawEyes(ctx, cx, cy, s, 4, 3, 2);
      // Flat mouth
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 5 * s, cy + 7 * s);
      ctx.quadraticCurveTo(cx, cy + 8 * s, cx + 5 * s, cy + 7 * s);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      // Startled awake
      drawEyes(ctx, cx, cy, s, 6, 8, 3);
      // Bags still there
      ctx.fillStyle = 'rgba(100,80,120,0.3)';
      ctx.beginPath();
      ctx.ellipse(cx - 8 * s, cy + 2 * s, 7 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + 8 * s, cy + 2 * s, 7 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // Coffee would be nice mouth
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 8 * s, 4 * s, 3 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    id: 'monocle',
    label: 'o_Q',
    drawNormal(ctx, cx, cy, s) {
      // Normal left eye
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(cx - 8 * s, cy - 4 * s, 5 * s, 6 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx - 8 * s, cy - 3 * s, 2.5 * s, 0, Math.PI * 2);
      ctx.fill();
      // Monocle on right eye
      ctx.strokeStyle = '#c8a84e';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx + 8 * s, cy - 4 * s, 7 * s, 0, Math.PI * 2);
      ctx.stroke();
      // Chain
      ctx.strokeStyle = '#c8a84e';
      ctx.lineWidth = 1 * s;
      ctx.beginPath();
      ctx.moveTo(cx + 15 * s, cy - 2 * s);
      ctx.quadraticCurveTo(cx + 18 * s, cy + 8 * s, cx + 12 * s, cy + 14 * s);
      ctx.stroke();
      // Right eye behind monocle
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(cx + 8 * s, cy - 4 * s, 5 * s, 6 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx + 8 * s, cy - 3 * s, 2.5 * s, 0, Math.PI * 2);
      ctx.fill();
      // Redraw monocle rim on top
      ctx.strokeStyle = '#c8a84e';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx + 8 * s, cy - 4 * s, 7 * s, 0, Math.PI * 2);
      ctx.stroke();
      // Raised eyebrow
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx - 8 * s, cy - 12 * s, 5 * s, 0.2 * Math.PI, 0.8 * Math.PI);
      ctx.stroke();
      // Slight smile
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.arc(cx, cy + 5 * s, 6 * s, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    },
    drawPuffed(ctx, cx, cy, s) {
      // Monocle pops off
      drawEyes(ctx, cx, cy, s, 6, 7, 3);
      // Monocle flying away
      ctx.strokeStyle = '#c8a84e';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx + 18 * s, cy - 14 * s, 6 * s, 0, Math.PI * 2);
      ctx.stroke();
      // Surprised mouth
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 7 * s, 5 * s, 4 * s, 0, 0, Math.PI * 2);
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
