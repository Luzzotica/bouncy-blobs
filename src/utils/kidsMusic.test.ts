import { describe, it, expect, vi, beforeEach } from 'vitest';

// kidsMusic uses Web Audio — mock enough of AudioContext for node tests.
class FakeOsc {
  type = 'triangle';
  frequency = { value: 0 };
  connect() {}
  start() {}
  stop() {}
}
class FakeGain {
  gain = {
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
  };
  connect() {}
}
class FakeCtx {
  state = 'running';
  currentTime = 0;
  createOscillator() { return new FakeOsc(); }
  createGain() { return new FakeGain(); }
  resume() { return Promise.resolve(); }
  get destination() { return {}; }
}

vi.stubGlobal('AudioContext', FakeCtx);
vi.stubGlobal('webkitAudioContext', FakeCtx);

vi.mock('./audio', () => ({
  resumeAudio: vi.fn(),
}));

import { KidsTwinkleProgress } from './kidsMusic';

describe('KidsTwinkleProgress', () => {
  beforeEach(() => {
    // fresh instance each test
  });

  it('advances notes on expand and debounces', () => {
    const m = new KidsTwinkleProgress();
    expect(m.onExpand(1000)).toBe(1);
    expect(m.onExpand(1050)).toBeNull();
    expect(m.onExpand(1300)).toBe(2);
  });

  it('loops the phrase', () => {
    const m = new KidsTwinkleProgress();
    const n = m.noteCount();
    for (let i = 0; i < n; i++) {
      m.onExpand(1000 + i * 500);
    }
    expect(m.peekIndex()).toBe(1);
    expect(m.onExpand(1000 + n * 500)).toBe(1);
  });
});
