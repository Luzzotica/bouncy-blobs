import React, { useRef, useEffect, useState, useCallback } from 'react';

interface FloatingButtonProps {
  onPress: (pressed: boolean) => void;
  zone: 'left' | 'right';
  color?: string;
  label?: string;
}

export const FloatingButton: React.FC<FloatingButtonProps> = ({
  onPress,
  zone,
  color = '#10b981',
  label,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPressed, setIsPressed] = useState(false);
  const activeTouchIdRef = useRef<number | null>(null);

  const handleStart = useCallback((e: TouchEvent | MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

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
          activeTouchIdRef.current = touch.identifier;
          break;
        }
      }
      if (activeTouchIdRef.current === null) return;
    } else {
      activeTouchIdRef.current = -1; // Mouse
    }

    setIsPressed(true);
    onPress(true);
  }, [onPress]);

  const handleEnd = useCallback((e?: TouchEvent | MouseEvent) => {
    if (e && 'changedTouches' in e) {
      if (activeTouchIdRef.current === null) return;
      const ourTouch = Array.from(e.changedTouches).find(
        (t) => t.identifier === activeTouchIdRef.current
      );
      if (!ourTouch) return;
    }

    if (activeTouchIdRef.current === null) return;

    setIsPressed(false);
    activeTouchIdRef.current = null;
    onPress(false);
  }, [onPress]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('mousedown', handleStart);
    container.addEventListener('touchstart', handleStart, { passive: false });
    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchend', handleEnd, { passive: false });
    window.addEventListener('touchcancel', handleEnd, { passive: false });

    return () => {
      container.removeEventListener('mousedown', handleStart);
      container.removeEventListener('touchstart', handleStart);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchend', handleEnd);
      window.removeEventListener('touchcancel', handleEnd);
    };
  }, [handleStart, handleEnd]);

  return (
    <div
      ref={containerRef}
      className={`absolute top-0 bottom-0 touch-none select-none flex items-center justify-center ${
        zone === 'left' ? 'left-0 right-1/2' : 'left-1/2 right-0'
      }`}
      style={{
        background: isPressed
          ? `radial-gradient(circle, ${color}30 0%, transparent 70%)`
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

      {/* Button visual */}
      <div
        className="rounded-full border-4 transition-all duration-100 flex items-center justify-center"
        style={{
          width: isPressed ? 140 : 120,
          height: isPressed ? 140 : 120,
          borderColor: isPressed ? color : `${color}60`,
          backgroundColor: isPressed ? `${color}40` : `${color}15`,
          boxShadow: isPressed
            ? `0 0 40px ${color}50, inset 0 0 20px ${color}30`
            : `0 4px 20px rgba(0,0,0,0.2)`,
          transform: isPressed ? 'scale(0.95)' : 'scale(1)',
        }}
      >
        <span
          className="text-4xl font-bold transition-all duration-100"
          style={{
            color: isPressed ? '#fff' : `${color}`,
            textShadow: isPressed ? `0 0 10px ${color}` : 'none',
          }}
        >
          {zone === 'left' ? 'L' : 'R'}
        </span>
      </div>
    </div>
  );
};

