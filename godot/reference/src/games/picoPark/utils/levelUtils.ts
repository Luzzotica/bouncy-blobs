// Level Utilities - Rendering and collision helpers for levels

import Phaser from 'phaser';
import {
  PicoParkLevel,
  Position,
  TILE_EMPTY,
  TILE_SOLID,
  TILE_PLATFORM,
  TILE_HAZARD,
  TILE_BOUNCY,
  TILE_ICE,
} from '../types';

/**
 * Calculate scale and offset to fit level in screen
 */
export function getMapScaleAndOffset(
  level: PicoParkLevel,
  screenWidth: number,
  screenHeight: number,
  padding: number = 60
): { scale: number; cellSize: number; offset: Position } {
  const gridWidth = level.grid[0]?.length || 1;
  const gridHeight = level.grid.length;
  
  const availableWidth = screenWidth - padding * 2;
  const availableHeight = screenHeight - padding * 2;
  
  const scaleX = availableWidth / (gridWidth * level.cellSize);
  const scaleY = availableHeight / (gridHeight * level.cellSize);
  const scale = Math.min(scaleX, scaleY, 1.5); // Cap at 1.5x zoom
  
  const cellSize = level.cellSize * scale;
  const mapWidth = gridWidth * cellSize;
  const mapHeight = gridHeight * cellSize;
  
  const offsetX = (screenWidth - mapWidth) / 2;
  const offsetY = (screenHeight - mapHeight) / 2;
  
  return {
    scale,
    cellSize,
    offset: { x: offsetX, y: offsetY },
  };
}

/**
 * Convert grid coordinates to world coordinates
 */
export function gridToWorld(
  gridX: number,
  gridY: number,
  cellSize: number,
  offsetX: number,
  offsetY: number
): Position {
  return {
    x: offsetX + gridX * cellSize,
    y: offsetY + gridY * cellSize,
  };
}

/**
 * Convert world coordinates to grid coordinates
 */
export function worldToGrid(
  worldX: number,
  worldY: number,
  cellSize: number,
  offsetX: number,
  offsetY: number
): Position {
  return {
    x: Math.floor((worldX - offsetX) / cellSize),
    y: Math.floor((worldY - offsetY) / cellSize),
  };
}

/**
 * Render the level visuals
 */
export function renderLevel(
  graphics: Phaser.GameObjects.Graphics,
  level: PicoParkLevel,
  cellSize: number,
  offset: Position
): void {
  const theme = level.theme;
  
  // Background
  graphics.fillStyle(theme.backgroundColor, 1);
  const mapWidth = level.grid[0].length * cellSize;
  const mapHeight = level.grid.length * cellSize;
  graphics.fillRect(offset.x, offset.y, mapWidth, mapHeight);
  
  // Render each cell
  for (let y = 0; y < level.grid.length; y++) {
    for (let x = 0; x < level.grid[y].length; x++) {
      const tile = level.grid[y][x];
      const worldX = offset.x + x * cellSize;
      const worldY = offset.y + y * cellSize;
      
      switch (tile) {
        case TILE_SOLID:
          graphics.fillStyle(theme.groundColor, 1);
          graphics.fillRect(worldX, worldY, cellSize, cellSize);
          // Add subtle border
          graphics.lineStyle(1, theme.accentColor, 0.3);
          graphics.strokeRect(worldX, worldY, cellSize, cellSize);
          break;
          
        case TILE_PLATFORM:
          // One-way platform (just the top)
          graphics.fillStyle(theme.platformColor, 1);
          graphics.fillRect(worldX, worldY, cellSize, cellSize / 4);
          // Add pattern to indicate one-way
          graphics.lineStyle(2, theme.accentColor, 0.5);
          for (let i = 0; i < 3; i++) {
            const px = worldX + cellSize * (0.2 + i * 0.3);
            graphics.lineBetween(px, worldY + cellSize / 4, px + 5, worldY + cellSize / 2);
          }
          break;
          
        case TILE_HAZARD:
          // Spikes or danger
          graphics.fillStyle(theme.hazardColor, 1);
          // Draw spikes pattern
          const spikeCount = 3;
          const spikeWidth = cellSize / spikeCount;
          for (let i = 0; i < spikeCount; i++) {
            const sx = worldX + i * spikeWidth;
            graphics.fillTriangle(
              sx, worldY + cellSize,
              sx + spikeWidth / 2, worldY + cellSize * 0.3,
              sx + spikeWidth, worldY + cellSize
            );
          }
          break;
          
        case TILE_BOUNCY:
          // Bouncy surface
          graphics.fillStyle(0x00ff88, 1);
          graphics.fillRect(worldX, worldY, cellSize, cellSize);
          // Spring pattern
          graphics.lineStyle(3, 0x00cc66, 1);
          const springY = worldY + cellSize / 2;
          for (let i = 0; i < 4; i++) {
            const sx1 = worldX + i * (cellSize / 4);
            const sx2 = worldX + (i + 0.5) * (cellSize / 4);
            const sy1 = springY + (i % 2 === 0 ? -5 : 5);
            const sy2 = springY + (i % 2 === 0 ? 5 : -5);
            graphics.lineBetween(sx1, sy1, sx2, sy2);
          }
          break;
          
        case TILE_ICE:
          // Slippery ice surface
          graphics.fillStyle(0x88ccff, 1);
          graphics.fillRect(worldX, worldY, cellSize, cellSize);
          // Ice shine effect
          graphics.fillStyle(0xffffff, 0.3);
          graphics.fillRect(worldX + 2, worldY + 2, cellSize / 3, cellSize / 4);
          break;
      }
    }
  }

  // Render goal area indicator
  const goal = level.goalArea;
  const goalX = offset.x + goal.x * cellSize;
  const goalY = offset.y + goal.y * cellSize;
  const goalW = goal.width * cellSize;
  const goalH = goal.height * cellSize;
  
  // Goal background with gradient effect
  graphics.fillStyle(0x00ff00, 0.2);
  graphics.fillRect(goalX, goalY, goalW, goalH);
  graphics.lineStyle(3, 0x00ff00, 0.8);
  graphics.strokeRect(goalX, goalY, goalW, goalH);
  
  // Goal flag/banner
  graphics.fillStyle(0x00ff00, 1);
  const flagX = goalX + goalW / 2;
  const flagY = goalY + 10;
  graphics.fillRect(flagX - 2, flagY, 4, goalH - 20);
  graphics.fillTriangle(
    flagX + 2, flagY,
    flagX + 25, flagY + 15,
    flagX + 2, flagY + 30
  );
}

/**
 * Create physics colliders for the level
 */
export function createLevelColliders(
  scene: Phaser.Scene,
  level: PicoParkLevel,
  cellSize: number,
  offset: Position
): {
  walls: MatterJS.BodyType[];
  platforms: MatterJS.BodyType[];
  hazards: MatterJS.BodyType[];
} {
  const walls: MatterJS.BodyType[] = [];
  const platforms: MatterJS.BodyType[] = [];
  const hazards: MatterJS.BodyType[] = [];
  
  // Optimization: merge adjacent tiles into larger bodies
  const processed = new Set<string>();
  
  for (let y = 0; y < level.grid.length; y++) {
    for (let x = 0; x < level.grid[y].length; x++) {
      const key = `${x},${y}`;
      if (processed.has(key)) continue;
      
      const tile = level.grid[y][x];
      if (tile === TILE_EMPTY) continue;
      
      // Find horizontal extent of same tile type
      let width = 1;
      while (x + width < level.grid[y].length && 
             level.grid[y][x + width] === tile &&
             !processed.has(`${x + width},${y}`)) {
        width++;
      }
      
      // Mark as processed
      for (let i = 0; i < width; i++) {
        processed.add(`${x + i},${y}`);
      }
      
      const worldX = offset.x + (x + width / 2) * cellSize;
      const worldY = offset.y + (y + 0.5) * cellSize;
      const bodyWidth = width * cellSize;
      const bodyHeight = cellSize;
      
      switch (tile) {
        case TILE_SOLID:
        case TILE_ICE:
          const wallBody = scene.matter.add.rectangle(worldX, worldY, bodyWidth, bodyHeight, {
            isStatic: true,
            friction: tile === TILE_ICE ? 0.001 : 0.5,
            label: 'wall',
          });
          walls.push(wallBody);
          break;
          
        case TILE_PLATFORM:
          // One-way platform - sensor at top only
          const platformBody = scene.matter.add.rectangle(
            worldX,
            offset.y + y * cellSize + cellSize / 8,
            bodyWidth,
            cellSize / 4,
            {
              isStatic: true,
              friction: 0.5,
              label: 'platform',
              chamfer: { radius: 2 },
            }
          );
          platforms.push(platformBody);
          break;
          
        case TILE_HAZARD:
          const hazardBody = scene.matter.add.rectangle(worldX, worldY, bodyWidth, bodyHeight * 0.7, {
            isStatic: true,
            isSensor: true,
            label: 'hazard',
          });
          hazards.push(hazardBody);
          break;
          
        case TILE_BOUNCY:
          const bouncyBody = scene.matter.add.rectangle(worldX, worldY, bodyWidth, bodyHeight, {
            isStatic: true,
            restitution: 1.5,
            label: 'bouncy',
          });
          walls.push(bouncyBody);
          break;
      }
    }
  }
  
  // Add boundary walls
  const mapWidth = level.grid[0].length * cellSize;
  const mapHeight = level.grid.length * cellSize;
  const wallThickness = 20;
  
  // Left wall
  walls.push(scene.matter.add.rectangle(
    offset.x - wallThickness / 2,
    offset.y + mapHeight / 2,
    wallThickness,
    mapHeight + wallThickness * 2,
    { isStatic: true, label: 'boundary' }
  ));
  
  // Right wall
  walls.push(scene.matter.add.rectangle(
    offset.x + mapWidth + wallThickness / 2,
    offset.y + mapHeight / 2,
    wallThickness,
    mapHeight + wallThickness * 2,
    { isStatic: true, label: 'boundary' }
  ));
  
  // Top wall
  walls.push(scene.matter.add.rectangle(
    offset.x + mapWidth / 2,
    offset.y - wallThickness / 2,
    mapWidth + wallThickness * 2,
    wallThickness,
    { isStatic: true, label: 'boundary' }
  ));
  
  // Bottom wall (death pit or solid)
  walls.push(scene.matter.add.rectangle(
    offset.x + mapWidth / 2,
    offset.y + mapHeight + wallThickness / 2,
    mapWidth + wallThickness * 2,
    wallThickness,
    { isStatic: true, label: 'boundary' }
  ));
  
  return { walls, platforms, hazards };
}

