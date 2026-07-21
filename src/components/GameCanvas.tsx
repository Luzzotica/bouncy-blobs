import React, { useRef, useEffect, useCallback } from 'react';

interface GameCanvasProps {
  onInit: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  onResize?: (width: number, height: number) => void;
  style?: React.CSSProperties;
}

export default function GameCanvas({ onInit, onResize, style }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const initialized = useRef(false);
  // Latest callbacks stashed in a ref so handleResize can read them without
  // re-creating its identity on every render. Without this, consumers that
  // pass non-memoized callbacks (plain function declarations rather than
  // useCallback) would churn handleResize → useEffect's listener gets torn
  // down and re-registered on every parent render, dropping resize events
  // and cancelling the initial-layout RAF retry before it fires.
  const callbacksRef = useRef({ onInit, onResize });
  callbacksRef.current.onInit = onInit;
  callbacksRef.current.onResize = onResize;

  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // Bail when layout isn't ready (zero-size rect). Otherwise we'd hand
    // the game canvasHeight=0, which makes the renderer translate by
    // -cam.y*zoom → all blobs render at screen y=0 (camera "offset up").
    // A pending RAF in the mount effect retries on the next frame.
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    callbacksRef.current.onResize?.(rect.width, rect.height);

    if (!initialized.current) {
      initialized.current = true;
      callbacksRef.current.onInit(ctx, rect.width, rect.height);
    }
  }, []);

  useEffect(() => {
    handleResize();
    // Initial-mount race: if `handleResize` measured a zero-size rect
    // (DOM mounted but layout not yet computed), it bailed. Poll once
    // per RAF until we actually capture a size — typically resolves
    // on the first or second frame.
    let raf: number | null = null;
    const tryInit = () => {
      raf = null;
      if (initialized.current) return;
      handleResize();
      if (!initialized.current) raf = requestAnimationFrame(tryInit);
    };
    if (!initialized.current) raf = requestAnimationFrame(tryInit);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [handleResize]);

  return (
    <canvas
      ref={canvasRef}
      // Prevent iOS long-press select / callout while grabbing blobs.
      onContextMenu={(e) => e.preventDefault()}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        touchAction: 'none',
        ...style,
      } as React.CSSProperties}
    />
  );
}
