import React, { useRef, useEffect, useState, useCallback } from 'react';

interface FloatingJoystickProps {
  onMove: (x: number, y: number) => void;
  zone: 'left' | 'right';
  color?: string;
  label?: string;
  baseSize?: number;
  knobSize?: number;
}

export const FloatingJoystick: React.FC<FloatingJoystickProps> = ({
  onMove,
  zone,
  color = '#3b82f6',
  label,
  baseSize = 120,
  knobSize = 50,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [basePosition, setBasePosition] = useState({ x: 0, y: 0 }); // Where the joystick base spawns
  const [knobOffset, setKnobOffset] = useState({ x: 0, y: 0 }); // Knob offset from base center
  const activeTouchIdRef = useRef<number | null>(null);
  const startPositionRef = useRef({ x: 0, y: 0 }); // Initial touch position

  const maxDistance = baseSize / 2 - knobSize / 2;

  const handleStart = useCallback((e: TouchEvent | MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    let clientX: number;
    let clientY: number;
    let touchId: number | null = null;

    if ('touches' in e) {
      // Find a touch that started in this zone
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (
          touch.clientX >= rect.left &&
          touch.clientX <= rect.right &&
          touch.clientY >= rect.top &&
          touch.clientY <= rect.bottom
        ) {
          clientX = touch.clientX;
          clientY = touch.clientY;
          touchId = touch.identifier;
          break;
        }
      }
      if (touchId === null) return; // No touch in our zone
      activeTouchIdRef.current = touchId;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
      activeTouchIdRef.current = -1; // Mouse
    }

    // Store the initial touch position
    startPositionRef.current = { x: clientX!, y: clientY! };

    // Set base position relative to container
    setBasePosition({
      x: clientX! - rect.left,
      y: clientY! - rect.top,
    });

    setKnobOffset({ x: 0, y: 0 });
    setIsDragging(true);
    onMove(0, 0);
  }, [onMove]);

  const handleMove = useCallback((e: TouchEvent | MouseEvent) => {
    if (!isDragging || activeTouchIdRef.current === null) return;

    let clientX: number;
    let clientY: number;

    if ('touches' in e) {
      const touch = Array.from(e.touches).find(
        (t) => t.identifier === activeTouchIdRef.current
      );
      if (!touch) return;
      clientX = touch.clientX;
      clientY = touch.clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    e.preventDefault();
    e.stopPropagation();

    // Calculate offset from start position
    let offsetX = clientX - startPositionRef.current.x;
    let offsetY = clientY - startPositionRef.current.y;

    // Clamp to max distance
    const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
    if (distance > maxDistance) {
      offsetX = (offsetX / distance) * maxDistance;
      offsetY = (offsetY / distance) * maxDistance;
    }

    setKnobOffset({ x: offsetX, y: offsetY });

    // Normalize to -1 to 1 range
    const normalizedX = offsetX / maxDistance;
    const normalizedY = -offsetY / maxDistance; // Invert Y for intuitive control
    onMove(normalizedX, normalizedY);
  }, [isDragging, maxDistance, onMove]);

  const handleEnd = useCallback((e?: TouchEvent | MouseEvent) => {
    if (e && 'changedTouches' in e) {
      if (activeTouchIdRef.current === null) return;
      const ourTouch = Array.from(e.changedTouches).find(
        (t) => t.identifier === activeTouchIdRef.current
      );
      if (!ourTouch) return;
    }

    if (activeTouchIdRef.current === null) return;

    setIsDragging(false);
    setKnobOffset({ x: 0, y: 0 });
    activeTouchIdRef.current = null;
    onMove(0, 0);
  }, [onMove]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('mousedown', handleStart);
    container.addEventListener('touchstart', handleStart, { passive: false });
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('touchmove', handleMove, { passive: false });
    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchend', handleEnd, { passive: false });
    window.addEventListener('touchcancel', handleEnd, { passive: false });

    return () => {
      container.removeEventListener('mousedown', handleStart);
      container.removeEventListener('touchstart', handleStart);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchend', handleEnd);
      window.removeEventListener('touchcancel', handleEnd);
    };
  }, [handleStart, handleMove, handleEnd]);

  return (
    <div
      ref={containerRef}
      className={`absolute top-0 bottom-0 touch-none select-none ${
        zone === 'left' ? 'left-0 right-1/2' : 'left-1/2 right-0'
      }`}
      style={{
        background: isDragging
          ? `radial-gradient(circle at ${basePosition.x}px ${basePosition.y}px, ${color}10 0%, transparent 50%)`
          : 'transparent',
      }}
    >
      {/* Label */}
      {label && (
        <div
          className={`absolute top-4 text-white/50 text-sm font-medium ${
            zone === 'left' ? 'left-4' : 'right-4'
          }`}
        >
          {label}
        </div>
      )}

      {/* Zone indicator when not dragging */}
      {!isDragging && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            className="rounded-full border-2 border-dashed opacity-20"
            style={{
              width: baseSize,
              height: baseSize,
              borderColor: color,
            }}
          />
        </div>
      )}

      {/* Joystick base - only visible when dragging */}
      {isDragging && (
        <>
          {/* Base circle */}
          <div
            className="absolute rounded-full border-4 pointer-events-none"
            style={{
              width: baseSize,
              height: baseSize,
              left: basePosition.x - baseSize / 2,
              top: basePosition.y - baseSize / 2,
              borderColor: `${color}40`,
              backgroundColor: `${color}10`,
            }}
          />
          {/* Knob */}
          <div
            className="absolute rounded-full pointer-events-none"
            style={{
              width: knobSize,
              height: knobSize,
              left: basePosition.x + knobOffset.x - knobSize / 2,
              top: basePosition.y + knobOffset.y - knobSize / 2,
              backgroundColor: color,
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            }}
          />
        </>
      )}
    </div>
  );
};

