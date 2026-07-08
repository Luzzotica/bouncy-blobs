import { useRef, useState } from 'react';
import type { TouchInput } from '../game/touchInput';

/**
 * On-screen controls for standalone local play: a virtual joystick anchored
 * bottom-left and an "expand" (jump/inflate) button bottom-right. Drives the
 * passed TouchInput, whose read API the gameplay loop merges with the keyboard.
 *
 * Multi-touch uses Touch Events with per-zone identifier tracking (Pointer
 * Events drop the second simultaneous touch on iOS), so the joystick and the
 * button work at the same time — the same approach the phone Controller uses.
 */
const JOY_RADIUS = 64; // px; travel that maps to a full-magnitude axis

export function TouchControls({ input }: { input: TouchInput }) {
  const joyRef = useRef<HTMLDivElement>(null);
  const joyTouchId = useRef<number | null>(null);
  const joyOrigin = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const btnTouchId = useRef<number | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [pressed, setPressed] = useState(false);

  const onJoyStart = (e: React.TouchEvent) => {
    if (joyTouchId.current !== null) return;
    const t = e.changedTouches[0];
    joyTouchId.current = t.identifier;
    const rect = joyRef.current!.getBoundingClientRect();
    joyOrigin.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    updateJoy(t.clientX, t.clientY);
  };

  const onJoyMove = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === joyTouchId.current) { updateJoy(t.clientX, t.clientY); break; }
    }
  };

  const onJoyEnd = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === joyTouchId.current) {
        joyTouchId.current = null;
        input.release();
        setKnob({ x: 0, y: 0 });
        break;
      }
    }
  };

  const updateJoy = (cx: number, cy: number) => {
    const dx = cx - joyOrigin.current.x;
    const dy = cy - joyOrigin.current.y;
    const nx = Math.max(-1, Math.min(1, dx / JOY_RADIUS));
    const ny = Math.max(-1, Math.min(1, dy / JOY_RADIUS));
    input.setVector(nx, ny);
    // Clamp the visual knob to the ring.
    const mag = Math.hypot(dx, dy);
    const k = mag > JOY_RADIUS ? JOY_RADIUS / mag : 1;
    setKnob({ x: dx * k, y: dy * k });
  };

  const onBtnStart = (e: React.TouchEvent) => {
    if (btnTouchId.current !== null) return;
    btnTouchId.current = e.changedTouches[0].identifier;
    input.setExpanding(true);
    setPressed(true);
  };

  const onBtnEnd = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === btnTouchId.current) {
        btnTouchId.current = null;
        input.setExpanding(false);
        setPressed(false);
        break;
      }
    }
  };

  return (
    <div style={overlay}>
      {/* Joystick zone (bottom-left) */}
      <div
        ref={joyRef}
        style={joyBase}
        onTouchStart={onJoyStart}
        onTouchMove={onJoyMove}
        onTouchEnd={onJoyEnd}
        onTouchCancel={onJoyEnd}
      >
        <div style={{ ...joyKnob, transform: `translate(${knob.x}px, ${knob.y}px)` }} />
      </div>

      {/* Expand button (bottom-right) */}
      <div
        style={{ ...expandBtn, transform: pressed ? 'scale(0.92)' : 'scale(1)', opacity: pressed ? 1 : 0.85 }}
        onTouchStart={onBtnStart}
        onTouchEnd={onBtnEnd}
        onTouchCancel={onBtnEnd}
      >
        PUFF
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40,
  pointerEvents: 'none', // only the two control zones capture touches
  touchAction: 'none',
};

const joyBase: React.CSSProperties = {
  position: 'absolute',
  left: `calc(28px + var(--safe-area-left))`,
  bottom: `calc(28px + var(--safe-area-bottom))`,
  width: 132,
  height: 132,
  borderRadius: '50%',
  background: 'rgba(20, 12, 30, 0.28)',
  border: '3px solid rgba(199, 125, 255, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
  touchAction: 'none',
};

const joyKnob: React.CSSProperties = {
  width: 60,
  height: 60,
  borderRadius: '50%',
  background: 'rgba(255, 248, 235, 0.92)',
  border: '3px solid rgba(199, 125, 255, 0.9)',
  willChange: 'transform',
};

const expandBtn: React.CSSProperties = {
  position: 'absolute',
  right: `calc(32px + var(--safe-area-right))`,
  bottom: `calc(44px + var(--safe-area-bottom))`,
  width: 104,
  height: 104,
  borderRadius: '50%',
  background: 'rgba(123, 104, 238, 0.85)',
  border: '4px solid rgba(255, 248, 235, 0.9)',
  color: '#fff8eb',
  fontWeight: 900,
  fontSize: 18,
  letterSpacing: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
  touchAction: 'none',
  userSelect: 'none',
  transition: 'transform 0.06s ease-out, opacity 0.06s ease-out',
};
