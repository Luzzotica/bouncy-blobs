// Level Definitions for Pico Park

import {
  PicoParkLevel,
  LevelTheme,
  TILE_EMPTY as _,
  TILE_SOLID as S,
  TILE_PLATFORM as P,
  TILE_HAZARD as H,
  TILE_BOUNCY as B,
} from '../types';

// Theme definitions
const THEME_GRASS: LevelTheme = {
  name: 'Grass',
  backgroundColor: 0x87ceeb,
  groundColor: 0x228b22,
  platformColor: 0x8b4513,
  hazardColor: 0xff4444,
  accentColor: 0x006400,
};

const THEME_CAVE: LevelTheme = {
  name: 'Cave',
  backgroundColor: 0x1a1a2e,
  groundColor: 0x4a4a6a,
  platformColor: 0x6a6a8a,
  hazardColor: 0xff4444,
  accentColor: 0x2a2a4a,
};

const THEME_FACTORY: LevelTheme = {
  name: 'Factory',
  backgroundColor: 0x2d2d2d,
  groundColor: 0x555555,
  platformColor: 0x888888,
  hazardColor: 0xff6600,
  accentColor: 0x444444,
};

const THEME_NEON: LevelTheme = {
  name: 'Neon',
  backgroundColor: 0x0a0a1a,
  groundColor: 0x1a1a3a,
  platformColor: 0x2a2a5a,
  hazardColor: 0xff00ff,
  accentColor: 0x00ffff,
};

// Level 1: First Steps (Tutorial)
const LEVEL_1: PicoParkLevel = {
  id: 'first_steps',
  name: 'First Steps',
  difficulty: 'easy',
  requiredPlayers: 2,
  cellSize: 32,
  grid: [
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,S,S,S,S,S,S,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,P,P,P,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,S,S,S,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [S,S,S,S,_,_,_,_,_,_,S,S,S,S,S,S,S,S,S,S],
    [S,S,S,S,H,H,H,H,H,H,S,S,S,S,S,S,S,S,S,S],
  ],
  coinPositions: [
    { x: 5, y: 7 },
    { x: 9, y: 5 },
    { x: 13, y: 3 },
    { x: 16, y: 3 },
    { x: 2, y: 9 },
    { x: 11, y: 9 },
    { x: 14, y: 9 },
    { x: 17, y: 9 },
    { x: 9, y: 9 },
    { x: 6, y: 5 },
  ],
  spawnPoints: [
    { x: 1, y: 9 },
    { x: 2, y: 9 },
    { x: 1, y: 8 },
    { x: 2, y: 8 },
  ],
  goalArea: { x: 17, y: 8, width: 2, height: 2 },
  theme: THEME_GRASS,
};

// Level 2: Bridge the Gap
const LEVEL_2: PicoParkLevel = {
  id: 'bridge_gap',
  name: 'Bridge the Gap',
  difficulty: 'easy',
  requiredPlayers: 2,
  cellSize: 32,
  grid: [
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [S,S,S,S,S,S,_,_,_,_,_,_,_,_,S,S,S,S,S,S],
    [S,S,S,S,S,S,H,H,H,H,H,H,H,H,S,S,S,S,S,S],
  ],
  coinPositions: [
    { x: 2, y: 8 },
    { x: 4, y: 8 },
    { x: 8, y: 6 },
    { x: 10, y: 5 },
    { x: 12, y: 6 },
    { x: 15, y: 8 },
    { x: 17, y: 8 },
    { x: 10, y: 8 },
    { x: 9, y: 7 },
    { x: 11, y: 7 },
    { x: 3, y: 7 },
    { x: 16, y: 7 },
  ],
  spawnPoints: [
    { x: 1, y: 8 },
    { x: 2, y: 8 },
    { x: 3, y: 8 },
    { x: 4, y: 8 },
  ],
  goalArea: { x: 17, y: 7, width: 2, height: 2 },
  theme: THEME_CAVE,
};

// Level 3: Heavy Doors
const LEVEL_3: PicoParkLevel = {
  id: 'heavy_doors',
  name: 'Heavy Doors',
  difficulty: 'medium',
  requiredPlayers: 3,
  cellSize: 32,
  grid: [
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,S,_,_,_,_,_,S,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,S,_,_,_,_,_,S,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,S,_,_,_,_,_,S,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,S,_,_,_,_,_,S,_,_,_,_,_,_,_,_],
    [S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S],
    [S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S],
  ],
  coinPositions: [
    { x: 2, y: 7 },
    { x: 4, y: 7 },
    { x: 6, y: 7 },
    { x: 9, y: 7 },
    { x: 11, y: 7 },
    { x: 15, y: 7 },
    { x: 17, y: 7 },
    { x: 19, y: 7 },
    { x: 10, y: 5 },
    { x: 10, y: 3 },
    { x: 3, y: 5 },
    { x: 5, y: 4 },
    { x: 16, y: 5 },
    { x: 18, y: 4 },
    { x: 20, y: 6 },
  ],
  spawnPoints: [
    { x: 1, y: 7 },
    { x: 2, y: 7 },
    { x: 3, y: 7 },
    { x: 4, y: 7 },
  ],
  goalArea: { x: 19, y: 6, width: 2, height: 2 },
  pressurePlates: [
    {
      id: 'plate1',
      position: { x: 5, y: 7 },
      width: 2,
      requiredWeight: 2,
      controls: ['door1'],
    },
  ],
  doors: [
    {
      id: 'door1',
      position: { x: 7, y: 4 },
      width: 1,
      height: 4,
      isOpen: false,
    },
    {
      id: 'door2',
      position: { x: 13, y: 4 },
      width: 1,
      height: 4,
      isOpen: false,
    },
  ],
  theme: THEME_FACTORY,
};

// Level 4: Vertical Venture
const LEVEL_4: PicoParkLevel = {
  id: 'vertical_venture',
  name: 'Vertical Venture',
  difficulty: 'medium',
  requiredPlayers: 2,
  cellSize: 32,
  grid: [
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,S,S,S,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,P,P,P,_,_,_,P,P,P,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,S,S,S,_,_,_,_,_,_,_,S,S,S,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,P,P,P,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,B,_,_,_,_,_,_,S],
    [S,S,S,S,S,S,S,S,S,S,S,S,S,S,S],
  ],
  coinPositions: [
    { x: 7, y: 12 },
    { x: 4, y: 10 },
    { x: 10, y: 10 },
    { x: 7, y: 8 },
    { x: 2, y: 6 },
    { x: 12, y: 6 },
    { x: 4, y: 4 },
    { x: 10, y: 4 },
    { x: 7, y: 2 },
    { x: 3, y: 2 },
    { x: 11, y: 2 },
    { x: 7, y: 0 },
    { x: 1, y: 10 },
    { x: 13, y: 10 },
    { x: 7, y: 5 },
    { x: 2, y: 8 },
    { x: 12, y: 8 },
    { x: 5, y: 7 },
  ],
  spawnPoints: [
    { x: 2, y: 12 },
    { x: 4, y: 12 },
    { x: 10, y: 12 },
    { x: 12, y: 12 },
  ],
  goalArea: { x: 6, y: 1, width: 3, height: 2 },
  theme: THEME_NEON,
};

// Level 5: Synchronized Chaos
const LEVEL_5: PicoParkLevel = {
  id: 'synchronized_chaos',
  name: 'Synchronized Chaos',
  difficulty: 'hard',
  requiredPlayers: 4,
  cellSize: 28,
  grid: [
    [S,_,_,_,_,_,_,_,_,_,_,_,_,S,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,S,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,S,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,S,S,S,S,_,_,_,S,_,_,_,S,S,S,S,_,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,S,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,P,P,P,_,_,_,_,_,_,_,S,_,_,_,_,_,_,P,P,P,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,S,_,_,_,_,_,_,_,_,_,_,S],
    [S,S,S,S,S,_,_,_,_,_,S,S,S,S,S,S,S,_,_,_,_,S,S,S,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,P,P,P,_,_,_,_,_,_,P,P,P,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,S],
    [S,H,H,H,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,H,H,H,S],
    [S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S,S],
  ],
  coinPositions: [
    { x: 2, y: 11 },
    { x: 6, y: 11 },
    { x: 8, y: 8 },
    { x: 4, y: 4 },
    { x: 9, y: 2 },
    { x: 11, y: 6 },
    { x: 15, y: 8 },
    { x: 17, y: 8 },
    { x: 22, y: 11 },
    { x: 18, y: 11 },
    { x: 20, y: 4 },
    { x: 15, y: 2 },
    { x: 12, y: 0 },
    { x: 7, y: 6 },
    { x: 3, y: 8 },
    { x: 21, y: 8 },
    { x: 5, y: 10 },
    { x: 19, y: 10 },
    { x: 10, y: 5 },
    { x: 14, y: 5 },
    { x: 12, y: 3 },
    { x: 8, y: 1 },
    { x: 16, y: 1 },
    { x: 1, y: 6 },
    { x: 23, y: 6 },
  ],
  spawnPoints: [
    { x: 2, y: 12 },
    { x: 5, y: 12 },
    { x: 19, y: 12 },
    { x: 22, y: 12 },
  ],
  goalArea: { x: 11, y: 0, width: 3, height: 3 },
  pressurePlates: [
    {
      id: 'plate_left',
      position: { x: 3, y: 7 },
      width: 2,
      requiredWeight: 2,
      controls: ['door_left'],
    },
    {
      id: 'plate_right',
      position: { x: 20, y: 7 },
      width: 2,
      requiredWeight: 2,
      controls: ['door_right'],
    },
  ],
  doors: [
    {
      id: 'door_left',
      position: { x: 13, y: 0 },
      width: 1,
      height: 7,
      isOpen: false,
    },
    {
      id: 'door_right',
      position: { x: 13, y: 7 },
      width: 1,
      height: 6,
      isOpen: true,
    },
  ],
  movingPlatforms: [
    {
      id: 'platform_center',
      startPos: { x: 10, y: 11 },
      endPos: { x: 14, y: 11 },
      width: 3,
      speed: 50,
      pauseTime: 500,
    },
  ],
  theme: THEME_NEON,
};

// Export all levels
export const LEVELS: PicoParkLevel[] = [
  LEVEL_1,
  LEVEL_2,
  LEVEL_3,
  LEVEL_4,
  LEVEL_5,
];

// Get level by ID
export function getLevelById(id: string): PicoParkLevel | undefined {
  return LEVELS.find(level => level.id === id);
}

// Get next level after given ID
export function getNextLevel(currentId: string): PicoParkLevel | undefined {
  const currentIndex = LEVELS.findIndex(level => level.id === currentId);
  if (currentIndex >= 0 && currentIndex < LEVELS.length - 1) {
    return LEVELS[currentIndex + 1];
  }
  return undefined;
}

