import { LevelData } from './types';

export const defaultLevel: LevelData = {
  name: 'Default Arena',
  version: 1,
  bounds: { width: 4400, height: 2248 },
  platforms: [
    // North tier (Y=-310)
    { id: 'p1', x: -1200, y: -310, width: 300, height: 24, rotation: 0 },
    { id: 'p2', x: 0, y: -310, width: 300, height: 24, rotation: 0 },
    { id: 'p3', x: 1200, y: -310, width: 300, height: 24, rotation: 0 },
    // Middle tier (Y=96)
    { id: 'p4', x: -900, y: 96, width: 280, height: 24, rotation: 0 },
    { id: 'p5', x: 0, y: 96, width: 280, height: 24, rotation: 0 },
    { id: 'p6', x: 900, y: 96, width: 280, height: 24, rotation: 0 },
    // Lower tier (Y=502)
    { id: 'p7', x: -600, y: 502, width: 260, height: 24, rotation: 0 },
    { id: 'p8', x: 300, y: 502, width: 260, height: 24, rotation: 0 },
    { id: 'p9', x: 1100, y: 502, width: 260, height: 24, rotation: 0 },
    // Run section (Y=1000)
    { id: 'p10', x: -500, y: 1000, width: 400, height: 24, rotation: 0 },
    { id: 'p11', x: 500, y: 1000, width: 400, height: 24, rotation: 0 },
    // Near floor (Y=1470)
    { id: 'p12', x: 0, y: 1470, width: 800, height: 24, rotation: 0 },
  ],
  walls: [
    // Floor
    { id: 'floor', points: [{ x: -2200, y: 1600 }, { x: 2200, y: 1600 }, { x: 2200, y: 1650 }, { x: -2200, y: 1650 }] },
    // Ceiling
    { id: 'ceiling', points: [{ x: -2200, y: -700 }, { x: 2200, y: -700 }, { x: 2200, y: -650 }, { x: -2200, y: -650 }] },
    // Left wall
    { id: 'left', points: [{ x: -2250, y: -700 }, { x: -2200, y: -700 }, { x: -2200, y: 1650 }, { x: -2250, y: 1650 }] },
    // Right wall
    { id: 'right', points: [{ x: 2200, y: -700 }, { x: 2250, y: -700 }, { x: 2250, y: 1650 }, { x: 2200, y: 1650 }] },
  ],
  spawnPoints: [
    { id: 'sp1', x: -440, y: 380, type: 'player' },
    { id: 'sp2', x: -220, y: 380, type: 'player' },
    { id: 'sp3', x: 0, y: 380, type: 'player' },
    { id: 'sp4', x: 220, y: 380, type: 'player' },
    { id: 'sp5', x: 440, y: 380, type: 'player' },
  ],
  npcBlobs: [
    { id: 'npc1', x: -920, y: 320, hullPreset: 'square', hue: 0.08 },
    { id: 'npc2', x: 920, y: 320, hullPreset: 'triangle', hue: 0.25 },
    { id: 'npc3', x: -520, y: 620, hullPreset: 'star', hue: 0.42 },
    { id: 'npc4', x: 520, y: 620, hullPreset: 'diamond', hue: 0.55 },
    { id: 'npc5', x: 0, y: 920, hullPreset: 'hexagon', hue: 0.75 },
  ],
};
