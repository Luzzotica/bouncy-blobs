import { useEffect, useRef } from 'react';
import { drawBlob, drawBlobShine } from '../renderer/blobRenderer';
import { drawBlobFace } from '../renderer/faceRenderer';
import type { Vec2 } from '../physics/vec2';

/** Live, animated preview of the player's blob: it swerves side to side
 * (eyes tracking the movement) and periodically puffs up, so the player can
 * see exactly how their chosen colour + face will look in-game. Uses the same
 * renderer the real game uses (drawBlob + drawBlobShine + drawBlobFace). */
export default function BlobPreview({ color, faceId, size = 200 }: { color: string; faceId: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Latest props read inside the animation loop without restarting it.
  const colorRef = useRef(color);
  const faceRef = useRef(faceId);
  colorRef.current = color;
  faceRef.current = faceId;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cx0 = size / 2;
    const cy0 = size / 2;
    // Hull radius tuned so the fixed-size face (drawBlobFace uses scale ~2.0)
    // sits correctly on the body — same proportion as an in-game blob.
    const baseR = 52;
    const POINTS = 16;

    let raf = 0;
    let start = 0;
    let prevX = cx0;
    let gazeX = 0;
    let gazeY = 0;

    const frame = (now: number) => {
      if (!start) start = now;
      const t = (now - start) / 1000; // seconds

      // Breathing puff: expandScale eases between ~1.0 and ~1.35.
      const puff = 0.5 + 0.5 * Math.sin(t * 1.7);
      const expandScale = 1 + 0.35 * puff;
      const isExpanding = Math.sin(t * 1.7) > 0.15;

      // Swerve left/right with a gentle vertical bob.
      const cx = cx0 + Math.sin(t * 1.4) * 16;
      const cy = cy0 + Math.sin(t * 2.3) * 6;
      const vx = cx - prevX;
      prevX = cx;

      // Gaze eases toward the movement direction (mirrors the in-game logic).
      const tx = Math.abs(vx) > 0.05 ? Math.sign(vx) : 0;
      gazeX += (tx - gazeX) * 0.12;
      gazeY += (0 - gazeY) * 0.12;

      const r = baseR * expandScale;
      const hull: Vec2[] = [];
      for (let i = 0; i < POINTS; i++) {
        const a = (i / POINTS) * Math.PI * 2;
        hull.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      const fill = colorRef.current + 'd9'; // ~85% alpha, matches the game
      const stroke = colorRef.current;
      drawBlob(ctx, hull, fill, stroke, 2.5);
      drawBlobShine(ctx, hull, t, { x: cx, y: cy }, { x: vx * 60, y: 0 });
      drawBlobFace(ctx, { x: cx, y: cy }, faceRef.current, isExpanding, expandScale, { x: gazeX, y: gazeY });

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={ref} style={{ width: size, height: size, display: 'block' }} />;
}
