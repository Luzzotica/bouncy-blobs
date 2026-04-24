// Grid Shooter Map Definitions

import { GridMapDefinition, MapTheme, PortalDefinition } from '../types';

// Theme definitions
const THEMES: Record<string, MapTheme> = {
  industrial: {
    floorColor: 0x2d3436,
    wallColor: 0x636e72,
    backgroundColor: 0x1a1a2e,
    gridLineColor: 0x444444,
    name: 'Industrial',
  },
  neon: {
    floorColor: 0x0f0f23,
    wallColor: 0x6c5ce7,
    backgroundColor: 0x0a0a1a,
    gridLineColor: 0x2d2d5a,
    name: 'Neon',
  },
  military: {
    floorColor: 0x3d5a40,
    wallColor: 0x2d4a30,
    backgroundColor: 0x1a2a1a,
    gridLineColor: 0x4a6a4a,
    name: 'Military',
  },
  ice: {
    floorColor: 0xa8dadc,
    wallColor: 0x457b9d,
    backgroundColor: 0x1d3557,
    gridLineColor: 0x5a9aba,
    name: 'Ice',
  },
  lava: {
    floorColor: 0x2b2b2b,
    wallColor: 0x8b0000,
    backgroundColor: 0x1a0a0a,
    gridLineColor: 0x4a2a2a,
    name: 'Lava',
  },
};

// Portal definitions - same colored portals teleport to each other
const PORTAL_DEFS: PortalDefinition[] = [
  { id: 2, color: 0x00ff88, name: 'Green Portal', linkedPortalId: 2 },   // Green to Green
  { id: 3, color: 0xff6600, name: 'Orange Portal', linkedPortalId: 3 }, // Orange to Orange
  { id: 4, color: 0x00ccff, name: 'Blue Portal', linkedPortalId: 4 },   // Blue to Blue
  { id: 5, color: 0xff00ff, name: 'Pink Portal', linkedPortalId: 5 },   // Pink to Pink
];

// Map: Warehouse (simple layout for beginners)
const WAREHOUSE: GridMapDefinition = {
  id: 'warehouse',
  name: 'Warehouse',
  description: 'Open warehouse with scattered cover',
  cellSize: 32,
  grid: [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
  spawnPoints: {
    ffa: [
      { x: 2, y: 2 }, { x: 17, y: 2 },
      { x: 2, y: 16 }, { x: 17, y: 16 },
      { x: 9, y: 6 }, { x: 10, y: 6 },
      { x: 9, y: 12 }, { x: 10, y: 12 },
    ],
    red: [
      { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 3 },
      { x: 2, y: 16 }, { x: 3, y: 16 }, { x: 2, y: 15 },
    ],
    blue: [
      { x: 17, y: 2 }, { x: 16, y: 2 }, { x: 17, y: 3 },
      { x: 17, y: 16 }, { x: 16, y: 16 }, { x: 17, y: 15 },
    ],
  },
  flagPositions: {
    red: { x: 2, y: 9 },
    blue: { x: 17, y: 9 },
  },
  theme: THEMES.industrial,
};

// Map: Corridors (tight corridors with portals)
const CORRIDORS: GridMapDefinition = {
  id: 'corridors',
  name: 'Corridors',
  description: 'Tight corridors with portal shortcuts',
  cellSize: 32,
  grid: [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1],
    [1, 0, 2, 0, 1, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 3, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1],
    [1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1],
    [1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1],
    [1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 3, 0, 1, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 2, 0, 1],
    [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
  spawnPoints: {
    ffa: [
      { x: 1, y: 1 }, { x: 18, y: 1 },
      { x: 1, y: 18 }, { x: 18, y: 18 },
      { x: 9, y: 9 }, { x: 10, y: 9 },
      { x: 9, y: 10 }, { x: 10, y: 10 },
    ],
    red: [
      { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 },
      { x: 1, y: 18 }, { x: 2, y: 18 }, { x: 1, y: 17 },
    ],
    blue: [
      { x: 18, y: 1 }, { x: 17, y: 1 }, { x: 18, y: 2 },
      { x: 18, y: 18 }, { x: 17, y: 18 }, { x: 18, y: 17 },
    ],
  },
  flagPositions: {
    red: { x: 2, y: 9 },
    blue: { x: 17, y: 9 },
  },
  portals: [
    PORTAL_DEFS[0], // Green (2)
    PORTAL_DEFS[1], // Orange (3)
  ],
  theme: THEMES.neon,
};

// Map: Bunkers (military theme with fortifications)
const BUNKERS: GridMapDefinition = {
  id: 'bunkers',
  name: 'Bunkers',
  description: 'Military compound with fortified positions',
  cellSize: 32,
  grid: [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1],
    [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
  spawnPoints: {
    ffa: [
      { x: 2, y: 2 }, { x: 21, y: 2 },
      { x: 2, y: 11 }, { x: 21, y: 11 },
      { x: 11, y: 2 }, { x: 12, y: 2 },
      { x: 11, y: 11 }, { x: 12, y: 11 },
    ],
    red: [
      { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 3 },
      { x: 2, y: 11 }, { x: 3, y: 11 }, { x: 2, y: 10 },
    ],
    blue: [
      { x: 21, y: 2 }, { x: 20, y: 2 }, { x: 21, y: 3 },
      { x: 21, y: 11 }, { x: 20, y: 11 }, { x: 21, y: 10 },
    ],
  },
  flagPositions: {
    red: { x: 3, y: 6 },
    blue: { x: 20, y: 6 },
  },
  theme: THEMES.military,
};

// Map: Arena (symmetric arena for competitive play)
const ARENA: GridMapDefinition = {
  id: 'arena',
  name: 'Arena',
  description: 'Symmetric competitive arena',
  cellSize: 32,
  grid: [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1],
    [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1],
    [1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
  spawnPoints: {
    ffa: [
      { x: 2, y: 2 }, { x: 19, y: 2 },
      { x: 2, y: 18 }, { x: 19, y: 18 },
      { x: 10, y: 2 }, { x: 11, y: 2 },
      { x: 10, y: 18 }, { x: 11, y: 18 },
      { x: 2, y: 10 }, { x: 19, y: 10 },
    ],
    red: [
      { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 3 },
      { x: 2, y: 18 }, { x: 3, y: 18 }, { x: 2, y: 17 },
      { x: 2, y: 10 },
    ],
    blue: [
      { x: 19, y: 2 }, { x: 18, y: 2 }, { x: 19, y: 3 },
      { x: 19, y: 18 }, { x: 18, y: 18 }, { x: 19, y: 17 },
      { x: 19, y: 10 },
    ],
  },
  flagPositions: {
    red: { x: 2, y: 10 },
    blue: { x: 19, y: 10 },
  },
  theme: THEMES.ice,
};

// Map: Portal Chaos (many portals for chaotic gameplay)
const PORTAL_CHAOS: GridMapDefinition = {
  id: 'portal_chaos',
  name: 'Portal Chaos',
  description: 'Multiple portal networks for unpredictable gameplay',
  cellSize: 32,
  grid: [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 2, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 3, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1],
    [1, 0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 1, 0, 1],
    [1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 3, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 2, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
  spawnPoints: {
    ffa: [
      { x: 1, y: 1 }, { x: 18, y: 1 },
      { x: 1, y: 16 }, { x: 18, y: 16 },
      { x: 9, y: 1 }, { x: 10, y: 1 },
      { x: 9, y: 16 }, { x: 10, y: 16 },
    ],
    red: [
      { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 },
      { x: 1, y: 16 }, { x: 2, y: 16 }, { x: 1, y: 15 },
    ],
    blue: [
      { x: 18, y: 1 }, { x: 17, y: 1 }, { x: 18, y: 2 },
      { x: 18, y: 16 }, { x: 17, y: 16 }, { x: 18, y: 15 },
    ],
  },
  flagPositions: {
    red: { x: 2, y: 8 },
    blue: { x: 17, y: 8 },
  },
  portals: PORTAL_DEFS,
  theme: THEMES.lava,
};

// Map: The Gauntlet (long narrow map)
const GAUNTLET: GridMapDefinition = {
  id: 'gauntlet',
  name: 'The Gauntlet',
  description: 'Long narrow battlefield with cover',
  cellSize: 32,
  grid: [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
  spawnPoints: {
    ffa: [
      { x: 1, y: 2 }, { x: 1, y: 3 },
      { x: 26, y: 2 }, { x: 26, y: 3 },
      { x: 13, y: 2 }, { x: 14, y: 2 },
    ],
    red: [
      { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 2, y: 2 }, { x: 2, y: 3 },
    ],
    blue: [
      { x: 26, y: 2 }, { x: 26, y: 3 }, { x: 25, y: 2 }, { x: 25, y: 3 },
    ],
  },
  flagPositions: {
    red: { x: 2, y: 2 },
    blue: { x: 25, y: 2 },
  },
  theme: THEMES.industrial,
};

// All maps collection
const ALL_MAPS: GridMapDefinition[] = [
  WAREHOUSE,
  CORRIDORS,
  BUNKERS,
  ARENA,
  PORTAL_CHAOS,
  GAUNTLET,
];

/**
 * Get all available maps
 */
export function getAllMaps(): GridMapDefinition[] {
  return ALL_MAPS;
}

/**
 * Get a map by ID
 */
export function getMapById(id: string): GridMapDefinition | undefined {
  return ALL_MAPS.find(map => map.id === id);
}

/**
 * Get random maps for voting
 */
export function getRandomMapsForVoting(count: number = 3): GridMapDefinition[] {
  const shuffled = [...ALL_MAPS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, ALL_MAPS.length));
}

/**
 * Get maps suitable for a specific game mode
 */
export function getMapsForGameMode(mode: 'free_for_all' | 'team_deathmatch' | 'capture_the_flag'): GridMapDefinition[] {
  // All maps support all modes, but some may be better suited
  // For CTF, filter maps that have flag positions defined
  if (mode === 'capture_the_flag') {
    return ALL_MAPS.filter(map => map.flagPositions);
  }
  return ALL_MAPS;
}

