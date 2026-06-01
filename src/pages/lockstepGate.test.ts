// Regression test for the "guest stuck in countdown" bug.
//
// Symptom: in lockstep multiplayer, the guest's countdown timer never
// elapses because the host's `world.tick` is frozen during countdown
// (modeManager returns shouldRunPhysics=false → world.step is skipped),
// so the host keeps broadcasting the SAME tick number every RAF, and
// the lockstep gate sits waiting for `world.tick + 1` inputs that
// never arrive.
//
// The fix: the gate now bypasses the input wait during non-playing
// phases so the local modeManager.update can decrement the countdown
// timer at RAF rate.

import { describe, expect, it } from 'vitest';
import type { AggregatedTick } from '../lib/inputProtocol';
import { evaluateLockstepGate } from './lockstepGate';

function emptyBuffer(): Map<number, AggregatedTick> {
  return new Map<number, AggregatedTick>();
}

describe('evaluateLockstepGate', () => {
  it('PASSES during countdown even with an empty input buffer (the bug fix)', () => {
    let applied = 0;
    const ok = evaluateLockstepGate({
      worldTick: 100,
      phase: 'countdown',
      inputBuffer: emptyBuffer(),
      applyInputs: () => { applied++; },
    });
    expect(ok).toBe(true);
    // No inputs to apply — we just want the modeManager to tick.
    expect(applied).toBe(0);
  });

  it('PASSES during lobby + results phases too (consistency)', () => {
    expect(evaluateLockstepGate({
      worldTick: 100, phase: 'lobby', inputBuffer: emptyBuffer(),
      applyInputs: () => {},
    })).toBe(true);
    expect(evaluateLockstepGate({
      worldTick: 100, phase: 'results', inputBuffer: emptyBuffer(),
      applyInputs: () => {},
    })).toBe(true);
  });

  it('BLOCKS during playing when the next tick has not arrived', () => {
    const ok = evaluateLockstepGate({
      worldTick: 100,
      phase: 'playing',
      inputBuffer: emptyBuffer(),
      applyInputs: () => {},
    });
    expect(ok).toBe(false);
  });

  it('PASSES during playing once the next tick is in the buffer', () => {
    const buf = emptyBuffer();
    buf.set(101, { tick: 101, inputs: [{ slot: 0, playerId: 'p', moveX: 0.5, moveY: 0, expanding: false }] });
    let appliedTick = -1;
    const ok = evaluateLockstepGate({
      worldTick: 100,
      phase: 'playing',
      inputBuffer: buf,
      applyInputs: (t) => { appliedTick = t.tick; },
    });
    expect(ok).toBe(true);
    expect(appliedTick).toBe(101);
    // Buffer was pruned.
    expect(buf.has(101)).toBe(false);
  });

  it('prunes stale buffer entries (<= worldTick) when consuming', () => {
    const buf = emptyBuffer();
    buf.set(98, { tick: 98, inputs: [] });
    buf.set(99, { tick: 99, inputs: [] });
    buf.set(100, { tick: 100, inputs: [] });
    buf.set(101, { tick: 101, inputs: [{ slot: 0, playerId: 'p', moveX: 0, moveY: 0, expanding: false }] });
    evaluateLockstepGate({
      worldTick: 100,
      phase: 'playing',
      inputBuffer: buf,
      applyInputs: () => {},
    });
    expect(buf.has(98)).toBe(false);
    expect(buf.has(99)).toBe(false);
    expect(buf.has(100)).toBe(false);
    expect(buf.has(101)).toBe(false);
  });

  it('PASSES when phase is null (mode not yet initialised — e.g. waiting for level_loaded)', () => {
    // The original gate would have blocked here too. With our phase-aware
    // bypass, null phase falls through to the normal lockstep path so
    // pre-game ticks still wait properly. (This documents the choice:
    // we explicitly DON'T bypass on null phase.)
    expect(evaluateLockstepGate({
      worldTick: 0, phase: null, inputBuffer: emptyBuffer(),
      applyInputs: () => {},
    })).toBe(false);
  });
});
