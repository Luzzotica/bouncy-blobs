import { LevelData } from './types';

export const partyLevel: LevelData = {
  name: 'Party Arena',
  version: 1,
  levelType: 'party',
  bounds: { width: 4000, height: 2800 },
  platforms: [
    // Starting area (bottom left)
    { id: 'start', x: 400, y: 2200, width: 600, height: 40, rotation: 0 },

    // Section 1: Easy jumps
    { id: 'p1a', x: 950, y: 2050, width: 200, height: 30, rotation: 0 },
    { id: 'p1b', x: 1300, y: 1900, width: 250, height: 30, rotation: 0 },

    // Section 2: Staircase up
    { id: 'p2a', x: 1700, y: 1750, width: 220, height: 30, rotation: 0 },
    { id: 'p2b', x: 2050, y: 1600, width: 220, height: 30, rotation: 0 },
    { id: 'p2c', x: 2400, y: 1450, width: 220, height: 30, rotation: 0 },

    // Section 3: Mid bridge
    { id: 'p3a', x: 2850, y: 1350, width: 350, height: 25, rotation: 0 },

    // Section 4: Vertical climb
    { id: 'p4a', x: 3200, y: 1150, width: 180, height: 30, rotation: 0 },
    { id: 'p4b', x: 2900, y: 950, width: 180, height: 30, rotation: 0 },
    { id: 'p4c', x: 3300, y: 750, width: 180, height: 30, rotation: 0 },

    // Section 5: Final stretch to goal
    { id: 'p5a', x: 3000, y: 550, width: 250, height: 30, rotation: 0 },
    { id: 'goal-plat', x: 3500, y: 400, width: 300, height: 40, rotation: 0 },
  ],
  walls: [
    // Floor
    { id: 'floor', points: [
      { x: -100, y: 2600 },
      { x: 4100, y: 2600 },
      { x: 4100, y: 2800 },
      { x: -100, y: 2800 },
    ]},
    // Left wall
    { id: 'left', points: [
      { x: -100, y: -200 },
      { x: 0, y: -200 },
      { x: 0, y: 2800 },
      { x: -100, y: 2800 },
    ]},
    // Right wall
    { id: 'right', points: [
      { x: 4000, y: -200 },
      { x: 4100, y: -200 },
      { x: 4100, y: 2800 },
      { x: 4000, y: 2800 },
    ]},
    // Ceiling
    { id: 'ceiling', points: [
      { x: -100, y: -200 },
      { x: 4100, y: -200 },
      { x: 4100, y: -100 },
      { x: -100, y: -100 },
    ]},
  ],
  spawnPoints: [
    { id: 'sp1', x: 250, y: 2100, type: 'player' },
    { id: 'sp2', x: 350, y: 2100, type: 'player' },
    { id: 'sp3', x: 450, y: 2100, type: 'player' },
    { id: 'sp4', x: 550, y: 2100, type: 'player' },
  ],
  npcBlobs: [],
  goalZones: [
    { id: 'goal', x: 3500, y: 300, width: 300, height: 200 },
  ],
  spikes: [
    // Pit spikes below the mid section
    { id: 'sk1', x: 2000, y: 2560, width: 400, height: 40, rotation: 0 },
    { id: 'sk2', x: 3000, y: 2560, width: 400, height: 40, rotation: 0 },
  ],
  springPads: [
    // Launch pad at the bottom to help recover
    { id: 'spring1', x: 200, y: 2580, width: 100, height: 40, rotation: -Math.PI / 2, force: 600 },
  ],
};
