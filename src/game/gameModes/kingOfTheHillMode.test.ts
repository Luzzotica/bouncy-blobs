import { describe, it, expect } from 'vitest';
import { KingOfTheHillMode } from './kingOfTheHillMode';
import type { GameModeState } from './types';
import type { SoftBodyEngine } from '../../physics/SoftBodyEngine';
import type { PlayerManager } from '../playerManager';
import { LevelData } from '../../levels/types';
import { createRng } from '../../lib/rng';

// A KOTH level with three hills and fast rotation. The mode draws timing +
// next-zone selection from `world.rng`, so these tests stand in a deterministic
// RNG and tick the mode directly — no browser/physics needed.
function makeLevel(rotation: { minSeconds: number; maxSeconds: number } | undefined): LevelData {
  return {
    name: 'koth-test',
    version: 1,
    levelType: 'koth',
    bounds: { width: 3200, height: 2400 },
    platforms: [],
    walls: [],
    spawnPoints: [{ id: 'sp1', x: 0, y: 0, type: 'player' }],
    npcBlobs: [],
    hillZones: [
      { id: 'hill-a', x: 1600, y: 1100, width: 500, height: 250 },
      { id: 'hill-b', x: 800, y: 900, width: 360, height: 220 },
      { id: 'hill-c', x: 2400, y: 900, width: 360, height: 220 },
    ],
    ...(rotation ? { hillRotation: rotation } : {}),
  };
}

// `world.rng` is the only piece of the engine the mode touches.
function makeWorld(seed: number): SoftBodyEngine {
  return { rng: createRng(seed) } as unknown as SoftBodyEngine;
}

// No players on the hill — scoring is irrelevant to these rotation tests.
const emptyPlayers = {
  getAllPlayers: () => [],
  getPlayer: () => undefined,
} as unknown as PlayerManager;

function freshState(): GameModeState {
  return {
    phase: 'playing',
    phaseTimer: 0,
    scores: new Map(),
    winner: null,
    winnerName: null,
    timeRemaining: 90,
  };
}

/** Drive the mode for `seconds` at 60 Hz, returning the distinct-consecutive
 *  sequence of active hill ids (one entry per move). */
function runAndCollect(mode: KingOfTheHillMode, world: SoftBodyEngine, seconds: number): string[] {
  const state = freshState();
  mode.initialize(world, emptyPlayers);
  mode.onPhaseStart('playing', state);
  const dt = 1 / 60;
  const seq: string[] = [];
  for (let t = 0; t < seconds; t += dt) {
    mode.update(dt, state, emptyPlayers, world);
    const id = mode.getActiveHill()?.id;
    if (id && seq[seq.length - 1] !== id) seq.push(id);
  }
  return seq;
}

describe('KingOfTheHillMode hill rotation', () => {
  it('starts on the first hill and then moves to other zones', () => {
    const mode = new KingOfTheHillMode(makeLevel({ minSeconds: 2, maxSeconds: 3 }));
    const seq = runAndCollect(mode, makeWorld(20260624), 20);

    expect(seq[0]).toBe('hill-a');           // always pinned to hillZones[0] at start
    expect(seq.length).toBeGreaterThan(1);   // it moved
    expect(new Set(seq).size).toBeGreaterThanOrEqual(2);
  });

  it('only ever activates defined hill zones', () => {
    const mode = new KingOfTheHillMode(makeLevel({ minSeconds: 2, maxSeconds: 3 }));
    const seq = runAndCollect(mode, makeWorld(7), 20);
    for (const id of seq) expect(['hill-a', 'hill-b', 'hill-c']).toContain(id);
  });

  it('never moves to the zone it just left (no-repeat)', () => {
    const mode = new KingOfTheHillMode(makeLevel({ minSeconds: 2, maxSeconds: 3 }));
    const seq = runAndCollect(mode, makeWorld(999), 30);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });

  it('respects the configured interval range (no move before minSeconds)', () => {
    const mode = new KingOfTheHillMode(makeLevel({ minSeconds: 5, maxSeconds: 6 }));
    const state = freshState();
    const world = makeWorld(42);
    mode.initialize(world, emptyPlayers);
    mode.onPhaseStart('playing', state);
    const dt = 1 / 60;
    // After 4s of play the first interval (>=5s) cannot have elapsed yet.
    for (let t = 0; t < 4; t += dt) mode.update(dt, state, emptyPlayers, world);
    expect(mode.getActiveHill()?.id).toBe('hill-a');
  });

  it('is deterministic for a given seed', () => {
    const a = runAndCollect(new KingOfTheHillMode(makeLevel({ minSeconds: 2, maxSeconds: 3 })), makeWorld(123), 20);
    const b = runAndCollect(new KingOfTheHillMode(makeLevel({ minSeconds: 2, maxSeconds: 3 })), makeWorld(123), 20);
    expect(a).toEqual(b);
  });

  it('rotates by default with 2+ hills even without an explicit config', () => {
    const mode = new KingOfTheHillMode(makeLevel(undefined));
    const seq = runAndCollect(mode, makeWorld(1), 40);
    expect(seq[0]).toBe('hill-a');
    expect(seq.length, 'should move on the default ~10s interval').toBeGreaterThan(1);
    for (const id of seq) expect(['hill-a', 'hill-b', 'hill-c']).toContain(id);
  });

  it('does not move with rotation set but only one hill', () => {
    const level = makeLevel({ minSeconds: 2, maxSeconds: 3 });
    level.hillZones = [{ id: 'only-hill', x: 0, y: 0, width: 100, height: 100 }];
    const seq = runAndCollect(new KingOfTheHillMode(level), makeWorld(5), 30);
    expect(seq).toEqual(['only-hill']);
  });

  it('round-trips the active hill through dump/restore', () => {
    const mode = new KingOfTheHillMode(makeLevel({ minSeconds: 2, maxSeconds: 3 }));
    const state = freshState();
    const world = makeWorld(20260624);
    mode.initialize(world, emptyPlayers);
    mode.onPhaseStart('playing', state);
    const dt = 1 / 60;
    // Advance until at least one move has happened.
    for (let t = 0; t < 10 && mode.getActiveHill()?.id === 'hill-a'; t += dt) {
      mode.update(dt, state, emptyPlayers, world);
    }
    const movedId = mode.getActiveHill()?.id;
    expect(movedId).not.toBe('hill-a');

    const snap = mode.dumpState();
    const restored = new KingOfTheHillMode(makeLevel({ minSeconds: 2, maxSeconds: 3 }));
    restored.initialize(world, emptyPlayers);
    restored.restoreState(snap);
    expect(restored.getActiveHill()?.id).toBe(movedId);
  });
});
