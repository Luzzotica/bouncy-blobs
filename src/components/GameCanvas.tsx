import React, { useRef, useEffect, useCallback } from 'react';

interface GameCanvasProps {
  onInit: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  onResize?: (width: number, height: number) => void;
  style?: React.CSSProperties;
}

export default function GameCanvas({ onInit, onResize, style }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const initialized = useRef(false);

  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    onResize?.(rect.width, rect.height);

    if (!initialized.current) {
      initialized.current = true;
      onInit(ctx, rect.width, rect.height);
    }
  }, [onInit, onResize]);

  useEffect(() => {
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        ...style,
      }}
    />
  );
}
