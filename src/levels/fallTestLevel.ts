import { LevelData } from './types';

/**
 * A deliberately tiny arena for the fall-off-the-map test: a single ledge over
 * an open void. The ledge spans x[-400,400], y[-50,50], so the lowest map
 * geometry is its bottom edge at y=50 and the fall-off kill plane lands at
 * y = 50 + 100 = 150 (see computeMapAABB / setKillBelowY).
 *
 * - The `safe` spawn sits above the ledge → a blob there lands and survives.
 * - The `void` spawn is far to the side over nothing → a blob there free-falls
 *   straight through the kill plane.
 *
 * Used by src/game/fallOffMap.test.ts. Kept intentionally minimal and stable so
 * the expected kill-plane Y is easy to assert.
 */
export const fallTestLevel: LevelData = {
  name: 'Fall Test',
  version: 1,
  bounds: { width: 4000, height: 2000 },
  platforms: [
    { id: 'ledge', x: 0, y: 0, width: 800, height: 100, rotation: 0 },
  ],
  walls: [],
  spawnPoints: [
    { id: 'safe', x: 0, y: -200, type: 'player' },
    { id: 'void', x: 2000, y: -200, type: 'player' },
  ],
  // An NPC (multi-shape blob) spawned over the void — it should fall off and die
  // just like a player. NPCs aren't part of the geometry AABB, so this doesn't
  // shift the kill plane.
  npcBlobs: [
    { id: 'npc-faller', x: 2000, y: -200, hullPreset: 'star' },
  ],
};
