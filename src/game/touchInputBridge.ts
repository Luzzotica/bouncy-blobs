import { TouchInput } from './touchInput';

/** The slice of InputManager the bridge needs (kept structural so tests can
 *  stub it). */
interface InputSink {
  processInput(
    playerId: string,
    inputType: 'joystick_left' | 'button_right',
    value: Record<string, number | boolean>,
    timestamp: number,
  ): void;
}

/**
 * Feed a local on-screen pad (`TouchInput`, driven by <TouchControls>) into
 * the InputManager bus as if it were a phone controller — the same
 * `joystick_left` / `button_right` wire vocabulary the keyboard bridge in
 * GameMaster uses, so the host's blob behaves identically to a remote
 * player's. Polls per animation frame and only forwards CHANGES (the stick
 * dedupes on a per-(player,type) monotonic timestamp, matching the keyboard
 * bridge's same-millisecond bump).
 *
 * Returns a detach function.
 */
export function attachTouchInputBridge(touch: TouchInput, im: InputSink, playerId: string): () => void {
  let raf = 0;
  let lastX = 0;
  let lastY = 0;
  let lastExpanding = false;
  let lastStickTs = 0;

  const loop = () => {
    raf = requestAnimationFrame(loop);
    const x = touch.getMoveX();
    const y = touch.getMoveY();
    if (x !== lastX || y !== lastY) {
      lastX = x;
      lastY = y;
      let ts = Date.now();
      if (ts <= lastStickTs) ts = lastStickTs + 1;
      lastStickTs = ts;
      im.processInput(playerId, 'joystick_left', { x, y }, ts);
    }
    const expanding = touch.isExpanding();
    if (expanding !== lastExpanding) {
      lastExpanding = expanding;
      im.processInput(playerId, 'button_right', { pressed: expanding }, Date.now());
    }
  };
  loop();

  return () => {
    cancelAnimationFrame(raf);
    // Don't leave the blob drifting or inflated when the pad unmounts.
    if (lastX !== 0 || lastY !== 0) im.processInput(playerId, 'joystick_left', { x: 0, y: 0 }, Date.now());
    if (lastExpanding) im.processInput(playerId, 'button_right', { pressed: false }, Date.now());
  };
}
