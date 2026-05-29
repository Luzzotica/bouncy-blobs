import { describe, it, expect } from 'vitest';
import { LevelData, validateLevelType } from './types';

function baseLevel(): LevelData {
  return {
    name: 't', version: 1,
    bounds: { width: 1000, height: 1000 },
    platforms: [],
    walls: [],
    spawnPoints: [{ id: 'sp1', x: 0, y: 0, type: 'player' }],
    npcBlobs: [],
  };
}

describe('validateLevelType', () => {
  it('solo_racing / team_racing need a goal zone', () => {
    const l = baseLevel();
    expect(validateLevelType(l, 'solo_racing')).toMatch(/goal/i);
    expect(validateLevelType(l, 'team_racing')).toMatch(/goal/i);
    l.goalZones = [{ id: 'g1', x: 0, y: 0, width: 100, height: 100 }];
    expect(validateLevelType(l, 'solo_racing')).toBeNull();
    expect(validateLevelType(l, 'team_racing')).toBeNull();
  });

  it('koth needs a hill zone', () => {
    const l = baseLevel();
    expect(validateLevelType(l, 'koth')).toMatch(/hill/i);
    l.hillZones = [{ id: 'h1', x: 0, y: 0, width: 100, height: 100 }];
    expect(validateLevelType(l, 'koth')).toBeNull();
  });

  it('party only needs a player spawn', () => {
    const l = baseLevel();
    expect(validateLevelType(l, 'party')).toBeNull();
  });

  it('every mode requires at least one player spawn', () => {
    const l = baseLevel();
    l.spawnPoints = [];
    l.goalZones = [{ id: 'g1', x: 0, y: 0, width: 100, height: 100 }];
    l.hillZones = [{ id: 'h1', x: 0, y: 0, width: 100, height: 100 }];
    expect(validateLevelType(l, 'solo_racing')).toMatch(/spawn/i);
    expect(validateLevelType(l, 'koth')).toMatch(/spawn/i);
    expect(validateLevelType(l, 'party')).toMatch(/spawn/i);
  });
});
