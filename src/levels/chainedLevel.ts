import { LevelData } from './types';

export const chainedLevel: LevelData = {
  name: 'Chained Climb',
  version: 1,
  levelType: 'team_racing',
  bounds: { width: 2200, height: 6000 },
  platforms: [
    // Bottom starting area
    { id: 'start-floor', x: 1100, y: 5600, width: 1000, height: 40, rotation: 0 },

    // Tier 1: Simple alternating platforms
    { id: 't1-left', x: 500, y: 5200, width: 400, height: 30, rotation: 0 },
    { id: 't1-right', x: 1700, y: 5000, width: 400, height: 30, rotation: 0 },

    // Tier 2: Narrower jumps
    { id: 't2-left', x: 600, y: 4600, width: 350, height: 30, rotation: 0 },
    { id: 't2-mid', x: 1100, y: 4400, width: 250, height: 30, rotation: 0 },
    { id: 't2-right', x: 1600, y: 4200, width: 350, height: 30, rotation: 0 },

    // Tier 3: Zigzag
    { id: 't3-left', x: 400, y: 3800, width: 300, height: 30, rotation: 0 },
    { id: 't3-right', x: 1800, y: 3500, width: 300, height: 30, rotation: 0 },
    { id: 't3-mid', x: 1100, y: 3200, width: 350, height: 30, rotation: 0 },

    // Tier 4: Tilted platforms (tricky)
    { id: 't4-left', x: 500, y: 2800, width: 350, height: 30, rotation: 0.15 },
    { id: 't4-right', x: 1700, y: 2500, width: 350, height: 30, rotation: -0.15 },

    // Tier 5: Small stepping stones
    { id: 't5-a', x: 600, y: 2100, width: 200, height: 25, rotation: 0 },
    { id: 't5-b', x: 1100, y: 1900, width: 200, height: 25, rotation: 0 },
    { id: 't5-c', x: 1600, y: 1700, width: 200, height: 25, rotation: 0 },

    // Tier 6: Final stretch
    { id: 't6-left', x: 500, y: 1300, width: 350, height: 30, rotation: 0 },
    { id: 't6-right', x: 1700, y: 1100, width: 350, height: 30, rotation: 0 },

    // Summit
    { id: 'summit', x: 1100, y: 800, width: 600, height: 40, rotation: 0 },
  ],
  walls: [
    // Left wall
    { id: 'left', points: [{ x: -100, y: -200 }, { x: 0, y: -200 }, { x: 0, y: 6100 }, { x: -100, y: 6100 }] },
    // Right wall
    { id: 'right', points: [{ x: 2200, y: -200 }, { x: 2300, y: -200 }, { x: 2300, y: 6100 }, { x: 2200, y: 6100 }] },
    // Floor
    { id: 'floor', points: [{ x: -100, y: 5900 }, { x: 2300, y: 5900 }, { x: 2300, y: 6000 }, { x: -100, y: 6000 }] },
    // Ceiling
    { id: 'ceiling', points: [{ x: -100, y: -200 }, { x: 2300, y: -200 }, { x: 2300, y: 0 }, { x: -100, y: 0 }] },
  ],
  spawnPoints: [
    { id: 'sp1', x: 900, y: 5500, type: 'player' },
    { id: 'sp2', x: 1100, y: 5500, type: 'player' },
    { id: 'sp3', x: 1300, y: 5500, type: 'player' },
    { id: 'sp4', x: 1500, y: 5500, type: 'player' },
  ],
  npcBlobs: [],
  goalZones: [
    { id: 'summit-goal', x: 1100, y: 600, width: 500, height: 400 },
  ],
  powerupSpawns: [
    { id: 'pu1', x: 1100, y: 4300 },
    { id: 'pu2', x: 1100, y: 3100 },
    { id: 'pu3', x: 1100, y: 1800 },
  ],
  springPads: [
    // Launch up from starting area
    { id: 'sp1', x: 1100, y: 5580, width: 120, height: 40, rotation: -Math.PI / 2, force: 650 },
    // Boost on mid-level platforms
    { id: 'sp2', x: 400, y: 3780, width: 100, height: 40, rotation: -Math.PI / 2, force: 600 },
    { id: 'sp3', x: 1800, y: 3480, width: 100, height: 40, rotation: -Math.PI / 2, force: 600 },
    // High-level boost toward summit
    { id: 'sp4', x: 500, y: 1280, width: 100, height: 40, rotation: -Math.PI / 3, force: 550 },
  ],
  spikes: [
    // Wall spikes on alternating sides to punish swinging into walls
    { id: 'sk1', x: 40, y: 4600, width: 200, height: 30, rotation: -Math.PI / 2 },
    { id: 'sk2', x: 2160, y: 3500, width: 200, height: 30, rotation: Math.PI / 2 },
    // Floor spikes below a tricky gap
    { id: 'sk3', x: 1100, y: 5860, width: 250, height: 35, rotation: 0 },
    // Ceiling spikes near the summit — don't overshoot!
    { id: 'sk4', x: 1100, y: 40, width: 300, height: 30, rotation: Math.PI },
  ],
};
