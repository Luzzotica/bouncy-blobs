import { LevelData } from './types';

export const classicLevel: LevelData = {
  name: 'Classic Race',
  version: 1,
  levelType: 'solo_racing',
  bounds: { width: 8000, height: 2200 },
  platforms: [
    // Starting area
    { id: 'start-floor', x: 400, y: 1800, width: 800, height: 40, rotation: 0 },

    // Section 1: Simple jumps
    { id: 'plat-1a', x: 1100, y: 1650, width: 250, height: 30, rotation: 0 },
    { id: 'plat-1b', x: 1500, y: 1500, width: 200, height: 30, rotation: 0 },
    { id: 'plat-1c', x: 1900, y: 1600, width: 300, height: 30, rotation: 0 },

    // Section 2: Stairs up
    { id: 'plat-2a', x: 2400, y: 1450, width: 250, height: 30, rotation: 0 },
    { id: 'plat-2b', x: 2750, y: 1300, width: 250, height: 30, rotation: 0 },
    { id: 'plat-2c', x: 3100, y: 1150, width: 250, height: 30, rotation: 0 },

    // Section 3: Wider gaps
    { id: 'plat-3a', x: 3550, y: 1300, width: 200, height: 30, rotation: 0 },
    { id: 'plat-3b', x: 4100, y: 1200, width: 200, height: 30, rotation: 0 },

    // Section 4: Tilted platforms
    { id: 'plat-4a', x: 4600, y: 1400, width: 350, height: 30, rotation: -0.2 },
    { id: 'plat-4b', x: 5100, y: 1250, width: 350, height: 30, rotation: 0.15 },

    // Section 5: Final stretch
    { id: 'plat-5a', x: 5600, y: 1400, width: 250, height: 30, rotation: 0 },
    { id: 'plat-5b', x: 6000, y: 1300, width: 250, height: 30, rotation: 0 },
    { id: 'plat-5c', x: 6400, y: 1450, width: 200, height: 30, rotation: 0 },

    // Finish platform
    { id: 'finish-floor', x: 7200, y: 1600, width: 600, height: 40, rotation: 0 },
  ],
  walls: [
    // Floor (catch-all)
    { id: 'floor', points: [{ x: -200, y: 2100 }, { x: 8200, y: 2100 }, { x: 8200, y: 2200 }, { x: -200, y: 2200 }] },
    // Left wall
    { id: 'left', points: [{ x: -200, y: -200 }, { x: 0, y: -200 }, { x: 0, y: 2200 }, { x: -200, y: 2200 }] },
    // Right wall
    { id: 'right', points: [{ x: 8000, y: -200 }, { x: 8200, y: -200 }, { x: 8200, y: 2200 }, { x: 8000, y: 2200 }] },
    // Ceiling
    { id: 'ceiling', points: [{ x: -200, y: -200 }, { x: 8200, y: -200 }, { x: 8200, y: 0 }, { x: -200, y: 0 }] },
  ],
  spawnPoints: [
    { id: 'sp1', x: 200, y: 1700, type: 'player' },
    { id: 'sp2', x: 350, y: 1700, type: 'player' },
    { id: 'sp3', x: 500, y: 1700, type: 'player' },
    { id: 'sp4', x: 650, y: 1700, type: 'player' },
  ],
  npcBlobs: [],
  goalZones: [
    { id: 'finish', x: 7200, y: 1400, width: 400, height: 400 },
  ],
  powerupSpawns: [
    { id: 'pu1', x: 1500, y: 1400 },
    { id: 'pu2', x: 3100, y: 1050 },
    { id: 'pu3', x: 5100, y: 1100 },
  ],
  springPads: [
    // Launch up from the floor to skip the first section
    { id: 'sp1', x: 900, y: 1780, width: 100, height: 40, rotation: -Math.PI / 2, force: 600 },
    // Launch diagonally up-right across a big gap
    { id: 'sp2', x: 2400, y: 1430, width: 100, height: 40, rotation: -Math.PI / 4, force: 500 },
    // Launch straight up to reach a high platform
    { id: 'sp3', x: 4600, y: 1380, width: 100, height: 40, rotation: -Math.PI / 2, force: 550 },
    // Final boost toward the finish
    { id: 'sp4', x: 6400, y: 1430, width: 100, height: 40, rotation: -Math.PI / 3, force: 500 },
  ],
  spikes: [
    // Spikes below a gap between section 1 and 2 — punishes falling
    { id: 'sk1', x: 2100, y: 2060, width: 300, height: 35, rotation: 0 },
    // Spikes on underside of a high platform — punishes overshooting
    { id: 'sk2', x: 3550, y: 1270, width: 180, height: 30, rotation: Math.PI },
    // Floor spikes in the tilted section
    { id: 'sk3', x: 4850, y: 2060, width: 250, height: 35, rotation: 0 },
    // Spikes before the finish — last obstacle
    { id: 'sk4', x: 6800, y: 2060, width: 200, height: 35, rotation: 0 },
  ],
};
