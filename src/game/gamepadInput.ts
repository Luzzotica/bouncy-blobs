/* Gamepad → InputManager bridge.
 *
 * Polls `navigator.getGamepads()` on every RAF tick and translates the
 * standard browser-gamepad mapping (Xbox layout, also used by Steam Deck's
 * built-in controls and most modern PC pads) into the same `joystick_left`
 * + `button_right` events the keyboard path already produces.
 *
 * Up to 4 gamepads are supported. Each gets a stable `playerId` of
 * `local-gamepad-<index>` (matches the position in `navigator.getGamepads()`).
 *
 * Auto-join model: a gamepad's player slot is requested via `onJoinRequest`
 * the FIRST time it produces real input (stick past deadzone OR A button
 * pressed) — never on mere connection. This prevents ghost gamepads from
 * spawning empty blobs.
 */
import type { InputManager } from "../managers/InputManager";

export interface GamepadInputOptions {
  inputManager: InputManager;
  /** Called the first time gamepad <i> produces real input. Should register the player slot. */
  onJoinRequest: (playerId: string, gamepadIndex: number) => void;
  /** Optional: called when gamepad <i> disconnects. Should leave the player slot. */
  onDisconnect?: (playerId: string, gamepadIndex: number) => void;
  /** Stick deadzone (0–1). Below this the stick reads as 0,0. */
  deadzone?: number;
  /** Max simultaneous gamepads. Defaults to 4. */
  maxGamepads?: number;
}

const STD_BUTTON_A = 0;      // primary action — "expand"
const STD_BUTTON_RT = 7;     // right trigger — alt expand (Steam Deck friendly)
const STD_AXIS_LX = 0;
const STD_AXIS_LY = 1;

interface PadState {
  joined: boolean;
  lastStickX: number;
  lastStickY: number;
  lastExpand: boolean;
  lastStickTs: number;
}

export function createGamepadInput(opts: GamepadInputOptions) {
  const deadzone = opts.deadzone ?? 0.15;
  const maxGamepads = opts.maxGamepads ?? 8;
  const states: PadState[] = Array.from({ length: maxGamepads }, () => ({
    joined: false,
    lastStickX: 0,
    lastStickY: 0,
    lastExpand: false,
    lastStickTs: 0,
  }));
  let raf = 0;
  let running = false;

  const applyDeadzone = (v: number): number => (Math.abs(v) < deadzone ? 0 : v);

  const playerIdFor = (i: number) => `local-gamepad-${i}`;

  const tick = () => {
    if (!running) return;
    const pads = navigator.getGamepads();
    for (let i = 0; i < maxGamepads; i++) {
      const pad = pads[i];
      const st = states[i];
      if (!pad) {
        if (st.joined) {
          opts.onDisconnect?.(playerIdFor(i), i);
          st.joined = false;
          st.lastStickX = 0;
          st.lastStickY = 0;
          st.lastExpand = false;
        }
        continue;
      }

      const rawX = pad.axes[STD_AXIS_LX] ?? 0;
      const rawY = pad.axes[STD_AXIS_LY] ?? 0;
      const x = applyDeadzone(rawX);
      const y = applyDeadzone(rawY);

      const aBtn = pad.buttons[STD_BUTTON_A]?.pressed ?? false;
      const rtBtn = (pad.buttons[STD_BUTTON_RT]?.value ?? 0) > 0.5;
      const expand = aBtn || rtBtn;

      // Auto-join the slot only when we see meaningful input.
      if (!st.joined && (x !== 0 || y !== 0 || expand)) {
        opts.onJoinRequest(playerIdFor(i), i);
        st.joined = true;
      }
      if (!st.joined) continue;

      // Stick — only fire if changed (Tauri's WebKit gets noisy if we spam).
      if (x !== st.lastStickX || y !== st.lastStickY) {
        let ts = Date.now();
        if (ts <= st.lastStickTs) ts = st.lastStickTs + 1;
        st.lastStickTs = ts;
        opts.inputManager.processInput(playerIdFor(i), "joystick_left", { x, y }, ts);
        st.lastStickX = x;
        st.lastStickY = y;
      }

      // Expand — edge-triggered.
      if (expand !== st.lastExpand) {
        opts.inputManager.processInput(
          playerIdFor(i),
          "button_right",
          { pressed: expand },
          Date.now(),
        );
        st.lastExpand = expand;
      }
    }
    raf = requestAnimationFrame(tick);
  };

  return {
    start() {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    /** True if at least one gamepad is currently joined. */
    anyJoined(): boolean {
      return states.some((s) => s.joined);
    },
  };
}
