import { LevelData } from './types';

export const kothLevel: LevelData = {
  name: 'King of the Hill Arena',
  version: 1,
  levelType: 'koth',
  bounds: { width: 3200, height: 2400 },
  platforms: [
    // Center hill platform (the main contested area)
    { id: 'hill', x: 1600, y: 1200, width: 500, height: 40, rotation: 0 },

    // Ramps leading up to the hill
    { id: 'ramp-left', x: 1100, y: 1400, width: 400, height: 30, rotation: -0.3 },
    { id: 'ramp-right', x: 2100, y: 1400, width: 400, height: 30, rotation: 0.3 },

    // Lower side platforms (spawn areas)
    { id: 'left-spawn', x: 500, y: 1700, width: 500, height: 40, rotation: 0 },
    { id: 'right-spawn', x: 2700, y: 1700, width: 500, height: 40, rotation: 0 },

    // Upper platforms (alternative routes)
    { id: 'upper-left', x: 800, y: 1000, width: 300, height: 30, rotation: 0 },
    { id: 'upper-right', x: 2400, y: 1000, width: 300, height: 30, rotation: 0 },

    // Small floating platforms around hill
    { id: 'float-left', x: 1200, y: 1050, width: 150, height: 25, rotation: 0 },
    { id: 'float-right', x: 2000, y: 1050, width: 150, height: 25, rotation: 0 },
  ],
  walls: [
    // Floor
    { id: 'floor', points: [{ x: -100, y: 2200 }, { x: 3300, y: 2200 }, { x: 3300, y: 2400 }, { x: -100, y: 2400 }] },
    // Left wall
    { id: 'left', points: [{ x: -100, y: -100 }, { x: 0, y: -100 }, { x: 0, y: 2400 }, { x: -100, y: 2400 }] },
    // Right wall
    { id: 'right', points: [{ x: 3200, y: -100 }, { x: 3300, y: -100 }, { x: 3300, y: 2400 }, { x: 3200, y: 2400 }] },
    // Ceiling
    { id: 'ceiling', points: [{ x: -100, y: -100 }, { x: 3300, y: -100 }, { x: 3300, y: 0 }, { x: -100, y: 0 }] },
  ],
  spawnPoints: [
    { id: 'sp1', x: 400, y: 1600, type: 'player' },
    { id: 'sp2', x: 600, y: 1600, type: 'player' },
    { id: 'sp3', x: 2600, y: 1600, type: 'player' },
    { id: 'sp4', x: 2800, y: 1600, type: 'player' },
  ],
  npcBlobs: [
    { id: 'npc1', x: 1600, y: 1100, hullPreset: 'star' },
  ],
  hillZones: [
    { id: 'hill-zone', x: 1600, y: 1100, width: 500, height: 250 },
  ],
  powerupSpawns: [
    { id: 'pu1', x: 800, y: 900 },
    { id: 'pu2', x: 2400, y: 900 },
    { id: 'pu3', x: 1600, y: 1600 },
  ],
  springPads: [
    // Launch from spawn areas up toward the hill
    { id: 'sp1', x: 500, y: 1680, width: 100, height: 40, rotation: -Math.PI / 3, force: 500 },
    { id: 'sp2', x: 2700, y: 1680, width: 100, height: 40, rotation: -Math.PI * 2 / 3, force: 500 },
  ],
  spikes: [
    // Spikes on the sides of the hill — fall off and get punished
    { id: 'sk1', x: 1250, y: 2160, width: 200, height: 35, rotation: 0 },
    { id: 'sk2', x: 1950, y: 2160, width: 200, height: 35, rotation: 0 },
    // Ceiling spikes above the hill — punishes getting launched too high
    { id: 'sk3', x: 1600, y: 40, width: 300, height: 30, rotation: Math.PI },
  ],
};
