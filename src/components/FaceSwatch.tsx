import { useEffect, useRef } from 'react';
import { getFacePreset } from '../renderer/faceRenderer';

/** A small canvas swatch showing a face preset rendered on a colored circle.
 * Shared between LobbyPanel (host) and GuestLobbyPanel (guest). */
export default function FaceSwatch({ faceId, color, size = 28 }: { faceId: string; color: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    const preset = getFacePreset(faceId);
    const scale = size / 80;
    // 5th arg is gaze direction — swatches are static, so neutral (0,0).
    preset.drawNormal(ctx, size / 2, size / 2, scale, { x: 0, y: 0 });
  }, [faceId, color, size]);
  return <canvas ref={ref} style={{ width: size, height: size, borderRadius: '50%' }} />;
}
