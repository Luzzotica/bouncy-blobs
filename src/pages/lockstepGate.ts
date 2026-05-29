// Extracted lockstep-gate predicate so it can be unit-tested in isolation.
//
// The gate decides whether the game's `onLogic` should advance THIS frame.
// Three phase-specific behaviours:
//
//   - 'countdown' / 'lobby' / 'results': always advance.
//     During countdown the host's `world.step` doesn't run (modeManager
//     returns shouldRunPhysics=false), so the host's `world.tick` is
//     frozen and its postTickHook broadcasts the same tick number every
//     RAF. The lockstep buffer never gets a `world.tick + 1` entry —
//     waiting for one would freeze the guest's local countdown timer
//     forever. We let modeManager.update tick the timer at RAF rate.
//
//   - 'playing' (the default): require the authoritative input set for
//     `world.tick + 1` to be in the buffer. Apply inputs and consume.
//
// `applyInputs` is invoked when we have authoritative inputs to apply;
// callers control how those land on their PlayerManager.

import type { AggregatedTick } from '../lib/inputProtocol';
import type { GamePhase } from '../game/gameModes/types';

export interface LockstepGateInputs {
  /** Current `world.tick` (the engine's logical tick counter). */
  worldTick: number;
  /** Current game phase, or null if no mode is active. */
  phase: GamePhase | null;
  /** Authoritative per-tick input buffer (keyed by tick number). */
  inputBuffer: Map<number, AggregatedTick>;
  /** Apply inputs for `nextTick` to the player manager. Called only when
   *  we have authoritative inputs and the gate is about to return true. */
  applyInputs: (tickInputs: AggregatedTick) => void;
}

/** Returns true if `onLogic` should advance this frame. Mutates the input
 *  buffer (deletes the consumed tick + prunes older entries) when it
 *  consumes inputs. */
export function evaluateLockstepGate(args: LockstepGateInputs): boolean {
  const { worldTick, phase, inputBuffer, applyInputs } = args;

  // Bypass the input wait for non-playing phases (see header comment).
  if (phase === 'countdown' || phase === 'lobby' || phase === 'results') {
    return true;
  }

  const nextTick = worldTick + 1;
  const tickInputs = inputBuffer.get(nextTick);
  if (!tickInputs) return false;

  applyInputs(tickInputs);
  inputBuffer.delete(nextTick);
  for (const k of inputBuffer.keys()) if (k <= worldTick) inputBuffer.delete(k);
  return true;
}
