import React, { useRef, useEffect, useState, useCallback } from 'react';

interface JoystickProps {
  onMove: (x: number, y: number) => void;
  size?: number;
  color?: string;
}

export const Joystick: React.FC<JoystickProps> = ({ 
  onMove, 
  size = 150,
  color = '#3b82f6' 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const activeTouchIdRef = useRef<number | null>(null); // Track which touch is controlling the joystick

  const getPositionFromEvent = useCallback((e: TouchEvent | MouseEvent, touchId?: number | null) => {
    if (!containerRef.current) return { x: 0, y: 0 };

    const rect = containerRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    let clientX: number;
    let clientY: number;

    if ('touches' in e) {
      // Find the touch with the matching identifier, or use the first touch for start events
      const targetTouchId = touchId ?? activeTouchIdRef.current;
      let touch: Touch | undefined;
      
      if (targetTouchId !== null && targetTouchId !== undefined && targetTouchId !== -1) {
        touch = Array.from(e.touches).find(t => t.identifier === targetTouchId);
      }
      
      // Fallback to first touch if not found (for start events)
      if (!touch && e.touches.length > 0) {
        touch = e.touches[0];
      }
      
      if (!touch) return { x: 0, y: 0 };
      
      clientX = touch.clientX;
      clientY = touch.clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    let x = clientX - centerX;
    let y = clientY - centerY;

    const maxDistance = size / 2 - 30;
    const distance = Math.sqrt(x * x + y * y);

    if (distance > maxDistance) {
      x = (x / distance) * maxDistance;
      y = (y / distance) * maxDistance;
    }

    return { x, y };
  }, [size]);

  const handleStart = useCallback((e: TouchEvent | MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent event from bubbling to other elements
    
    // For touch events, find the touch that started on this joystick
    let touchId: number | null = null;
    if ('touches' in e && e.changedTouches.length > 0) {
      // Use changedTouches to get the touch that just started
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        // Find the touch that's within this joystick's bounds
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
              touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
            touchId = touch.identifier;
            break;
          }
        }
      }
      if (touchId === null && e.changedTouches.length > 0) {
        touchId = e.changedTouches[0].identifier;
      }
      activeTouchIdRef.current = touchId;
    } else {
      activeTouchIdRef.current = -1; // Use -1 for mouse events
    }
    
    setIsDragging(true);
    const pos = getPositionFromEvent(e, touchId);
    setPosition(pos);
    const normalizedX = pos.x / (size / 2 - 30);
    const normalizedY = -pos.y / (size / 2 - 30); // Invert Y for intuitive control
    onMove(normalizedX, normalizedY);
  }, [getPositionFromEvent, onMove, size]);

  const handleMove = useCallback((e: TouchEvent | MouseEvent) => {
    if (!isDragging) return;
    if (activeTouchIdRef.current === null) return;
    
    // For touch events, only process if it's our tracked touch
    if ('touches' in e) {
      // Find the touch with our identifier
      const ourTouch = Array.from(e.touches).find(
        touch => touch.identifier === activeTouchIdRef.current
      );
      if (!ourTouch) return; // Our touch is gone, but don't end yet (might be temporary)
    }
    
    e.preventDefault();
    e.stopPropagation();
    const pos = getPositionFromEvent(e, activeTouchIdRef.current);
    setPosition(pos);
    const normalizedX = pos.x / (size / 2 - 30);
    const normalizedY = -pos.y / (size / 2 - 30);
    onMove(normalizedX, normalizedY);
  }, [isDragging, getPositionFromEvent, onMove, size]);

  const handleEnd = useCallback((e?: TouchEvent | MouseEvent) => {
    // For touch events, only end if it's our tracked touch
    if (e && 'changedTouches' in e) {
      const touchEvent = e as TouchEvent;
      if (activeTouchIdRef.current === null) return;
      
      // Check if the ended touch is our tracked touch
      const ourTouch = Array.from(touchEvent.changedTouches).find(
        touch => touch.identifier === activeTouchIdRef.current
      );
      if (!ourTouch) return; // Not our touch, ignore
    }
    
    // Only end if we have an active touch (mouse uses -1)
    if (activeTouchIdRef.current === null) return;
    
    setIsDragging(false);
    setPosition({ x: 0, y: 0 });
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
    window.addEventListener('touchcancel', handleEnd, { passive: false }); // Handle touch cancellation

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
      className="relative rounded-full border-4 border-gray-300 bg-gray-100 touch-none select-none"
      style={{
        width: size,
        height: size,
        cursor: 'pointer',
      }}
    >
      <div
        className="absolute rounded-full transition-all duration-75"
        style={{
          width: 60,
          height: 60,
          backgroundColor: color,
          left: '50%',
          top: '50%',
          transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))`,
          boxShadow: isDragging ? '0 4px 12px rgba(0,0,0,0.3)' : '0 2px 6px rgba(0,0,0,0.2)',
        }}
      />
    </div>
  );
};

