// Grid Utilities - Convert grid arrays to Phaser world coordinates and rendering

import Phaser from 'phaser';
import {
  Position,
  GridMapDefinition,
  CELL_WALL,
} from '../types';

/**
 * Convert grid coordinates to world (pixel) coordinates
 */
export function gridToWorld(
  gridX: number,
  gridY: number,
  cellSize: number,
  offsetX: number = 0,
  offsetY: number = 0
): Position {
  return {
    x: gridX * cellSize + cellSize / 2 + offsetX,
    y: gridY * cellSize + cellSize / 2 + offsetY,
  };
}

/**
 * Convert world (pixel) coordinates to grid coordinates
 */
export function worldToGrid(
  worldX: number,
  worldY: number,
  cellSize: number,
  offsetX: number = 0,
  offsetY: number = 0
): Position {
  return {
    x: Math.floor((worldX - offsetX) / cellSize),
    y: Math.floor((worldY - offsetY) / cellSize),
  };
}

/**
 * Check if a grid position is valid (within bounds)
 */
export function isValidGridPosition(
  gridX: number,
  gridY: number,
  grid: number[][]
): boolean {
  return (
    gridY >= 0 &&
    gridY < grid.length &&
    gridX >= 0 &&
    gridX < grid[0].length
  );
}

/**
 * Get the cell value at a grid position
 */
export function getCellAt(
  gridX: number,
  gridY: number,
  grid: number[][]
): number {
  if (!isValidGridPosition(gridX, gridY, grid)) {
    return CELL_WALL; // Treat out of bounds as walls
  }
  return grid[gridY][gridX];
}

/**
 * Check if a cell is walkable (not a wall)
 */
export function isWalkable(
  gridX: number,
  gridY: number,
  grid: number[][]
): boolean {
  const cell = getCellAt(gridX, gridY, grid);
  return cell !== CELL_WALL;
}

/**
 * Check if a world position is inside a wall
 */
export function isWorldPositionInWall(
  worldX: number,
  worldY: number,
  map: GridMapDefinition,
  offsetX: number,
  offsetY: number
): boolean {
  const gridPos = worldToGrid(worldX, worldY, map.cellSize, offsetX, offsetY);
  return getCellAt(gridPos.x, gridPos.y, map.grid) === CELL_WALL;
}

/**
 * Get the map dimensions in pixels (at base cell size)
 */
export function getMapDimensions(map: GridMapDefinition): { width: number; height: number } {
  const height = map.grid.length * map.cellSize;
  const width = map.grid[0]?.length * map.cellSize || 0;
  return { width, height };
}

/**
 * Calculate the optimal scale to fill the screen
 * Returns scale factor, effective cell size, and offset to center
 */
export function getMapScaleAndOffset(
  map: GridMapDefinition,
  screenWidth: number,
  screenHeight: number,
  padding: number = 60  // Padding for UI elements
): { scale: number; cellSize: number; offset: Position } {
  const gridHeight = map.grid.length;
  const gridWidth = map.grid[0]?.length || 0;
  
  // Available space after padding
  const availableWidth = screenWidth - padding * 2;
  const availableHeight = screenHeight - padding * 2;
  
  // Calculate scale needed to fit each dimension
  const scaleX = availableWidth / (gridWidth * map.cellSize);
  const scaleY = availableHeight / (gridHeight * map.cellSize);
  
  // Use the smaller scale to maintain aspect ratio and fit entirely
  const scale = Math.min(scaleX, scaleY);
  
  // Calculate effective cell size with scale
  const cellSize = map.cellSize * scale;
  
  // Calculate dimensions with scale
  const scaledWidth = gridWidth * cellSize;
  const scaledHeight = gridHeight * cellSize;
  
  // Center the map
  const offset = {
    x: (screenWidth - scaledWidth) / 2,
    y: (screenHeight - scaledHeight) / 2,
  };
  
  return { scale, cellSize, offset };
}

/**
 * Calculate the offset to center the map on screen (legacy - no scaling)
 */
export function getMapOffset(
  map: GridMapDefinition,
  screenWidth: number,
  screenHeight: number
): Position {
  const mapDim = getMapDimensions(map);
  return {
    x: (screenWidth - mapDim.width) / 2,
    y: (screenHeight - mapDim.height) / 2,
  };
}

/**
 * Get all cells of a specific type
 */
export function getCellsOfType(
  grid: number[][],
  cellType: number
): Position[] {
  const cells: Position[] = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (grid[y][x] === cellType) {
        cells.push({ x, y });
      }
    }
  }
  return cells;
}

/**
 * Get all portal cells (cells with value >= 2)
 */
export function getPortalCells(grid: number[][]): Map<number, Position[]> {
  const portals = new Map<number, Position[]>();
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const cell = grid[y][x];
      if (cell >= 2) {
        if (!portals.has(cell)) {
          portals.set(cell, []);
        }
        portals.get(cell)!.push({ x, y });
      }
    }
  }
  return portals;
}

/**
 * Render the grid map to Phaser graphics
 */
export function renderGrid(
  graphics: Phaser.GameObjects.Graphics,
  map: GridMapDefinition,
  offsetX: number,
  offsetY: number
): void {
  const { grid, cellSize, theme } = map;
  
  // Clear previous graphics
  graphics.clear();
  
  // Draw floor background
  graphics.fillStyle(theme.floorColor, 1);
  const mapDim = getMapDimensions(map);
  graphics.fillRect(offsetX, offsetY, mapDim.width, mapDim.height);
  
  // Draw grid lines
  graphics.lineStyle(1, theme.gridLineColor, 0.3);
  for (let y = 0; y <= grid.length; y++) {
    graphics.lineBetween(
      offsetX,
      offsetY + y * cellSize,
      offsetX + mapDim.width,
      offsetY + y * cellSize
    );
  }
  for (let x = 0; x <= grid[0].length; x++) {
    graphics.lineBetween(
      offsetX + x * cellSize,
      offsetY,
      offsetX + x * cellSize,
      offsetY + mapDim.height
    );
  }
  
  // Draw cells
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const cell = grid[y][x];
      const worldX = offsetX + x * cellSize;
      const worldY = offsetY + y * cellSize;
      
      if (cell === CELL_WALL) {
        // Draw wall
        graphics.fillStyle(theme.wallColor, 1);
        graphics.fillRect(worldX, worldY, cellSize, cellSize);
        
        // Wall border for depth effect
        graphics.lineStyle(2, 0x000000, 0.5);
        graphics.strokeRect(worldX, worldY, cellSize, cellSize);
      }
    }
  }
}

/**
 * Render portals with visual effects
 */
export function renderPortals(
  graphics: Phaser.GameObjects.Graphics,
  map: GridMapDefinition,
  offsetX: number,
  offsetY: number,
  time: number
): void {
  const { grid, cellSize, portals } = map;
  
  if (!portals || portals.length === 0) return;
  
  // Create a portal color map
  const portalColors = new Map<number, number>();
  for (const portal of portals) {
    portalColors.set(portal.id, portal.color);
  }
  
  // Pulsating effect
  const pulse = Math.sin(time / 200) * 0.2 + 0.8;
  
  // Draw portal cells
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const cell = grid[y][x];
      if (cell >= 2) {
        const color = portalColors.get(cell) || 0xff00ff;
        const worldX = offsetX + x * cellSize;
        const worldY = offsetY + y * cellSize;
        const centerX = worldX + cellSize / 2;
        const centerY = worldY + cellSize / 2;
        
        // Portal glow
        graphics.fillStyle(color, 0.3 * pulse);
        graphics.fillCircle(centerX, centerY, cellSize * 0.6);
        
        // Portal core
        graphics.fillStyle(color, 0.7 * pulse);
        graphics.fillCircle(centerX, centerY, cellSize * 0.3);
        
        // Portal ring
        graphics.lineStyle(2, color, pulse);
        graphics.strokeCircle(centerX, centerY, cellSize * 0.4);
      }
    }
  }
}

/**
 * Create Matter.js bodies for walls
 */
export function createWallBodies(
  scene: Phaser.Scene,
  map: GridMapDefinition,
  offsetX: number,
  offsetY: number
): MatterJS.BodyType[] {
  const { grid, cellSize } = map;
  const bodies: MatterJS.BodyType[] = [];
  
  // Optimize by merging adjacent walls horizontally
  for (let y = 0; y < grid.length; y++) {
    let startX = -1;
    let wallLength = 0;
    
    for (let x = 0; x <= grid[y].length; x++) {
      const isWall = x < grid[y].length && grid[y][x] === CELL_WALL;
      
      if (isWall) {
        if (startX === -1) startX = x;
        wallLength++;
      } else if (startX !== -1) {
        // Create merged wall body
        const worldX = offsetX + startX * cellSize + (wallLength * cellSize) / 2;
        const worldY = offsetY + y * cellSize + cellSize / 2;
        
        const body = scene.matter.add.rectangle(
          worldX,
          worldY,
          wallLength * cellSize,
          cellSize,
          {
            isStatic: true,
            label: 'wall',
            friction: 0,
            restitution: 0.3,
          }
        );
        bodies.push(body);
        
        startX = -1;
        wallLength = 0;
      }
    }
  }
  
  return bodies;
}

/**
 * Create portal sensor bodies
 */
export function createPortalSensors(
  scene: Phaser.Scene,
  map: GridMapDefinition,
  offsetX: number,
  offsetY: number
): Map<number, MatterJS.BodyType[]> {
  const { grid, cellSize } = map;
  const portalBodies = new Map<number, MatterJS.BodyType[]>();
  
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const cell = grid[y][x];
      if (cell >= 2) {
        const worldPos = gridToWorld(x, y, cellSize, offsetX, offsetY);
        
        const body = scene.matter.add.circle(
          worldPos.x,
          worldPos.y,
          cellSize * 0.4,
          {
            isStatic: true,
            isSensor: true,
            label: `portal_${cell}`,
          }
        );
        
        // Store grid position on body for teleportation
        (body as any).portalType = cell;
        (body as any).gridX = x;
        (body as any).gridY = y;
        
        if (!portalBodies.has(cell)) {
          portalBodies.set(cell, []);
        }
        portalBodies.get(cell)!.push(body);
      }
    }
  }
  
  return portalBodies;
}

/**
 * Find the best spawn point (away from enemies, near allies)
 */
export function findBestSpawnPoint(
  spawnPoints: Position[],
  allies: Position[],
  enemies: Position[],
  cellSize: number,
  offsetX: number,
  offsetY: number
): Position {
  if (spawnPoints.length === 0) {
    return { x: 0, y: 0 };
  }
  
  if (spawnPoints.length === 1) {
    return gridToWorld(spawnPoints[0].x, spawnPoints[0].y, cellSize, offsetX, offsetY);
  }
  
  let bestPoint = spawnPoints[0];
  let bestScore = -Infinity;
  
  for (const point of spawnPoints) {
    const worldPos = gridToWorld(point.x, point.y, cellSize, offsetX, offsetY);
    let score = 0;
    
    // Add distance from enemies (we want to be far from enemies)
    for (const enemy of enemies) {
      const dist = Math.sqrt(
        Math.pow(worldPos.x - enemy.x, 2) + Math.pow(worldPos.y - enemy.y, 2)
      );
      score += dist;
    }
    
    // Subtract distance from allies (we want to be near allies)
    for (const ally of allies) {
      const dist = Math.sqrt(
        Math.pow(worldPos.x - ally.x, 2) + Math.pow(worldPos.y - ally.y, 2)
      );
      score -= dist * 0.5; // Weight allies less than enemies
    }
    
    // Add some randomness to prevent predictable spawns
    score += Math.random() * 100;
    
    if (score > bestScore) {
      bestScore = score;
      bestPoint = point;
    }
  }
  
  return gridToWorld(bestPoint.x, bestPoint.y, cellSize, offsetX, offsetY);
}

/**
 * Render a mini-preview of a grid map
 */
export function renderMapPreview(
  graphics: Phaser.GameObjects.Graphics,
  map: GridMapDefinition,
  x: number,
  y: number,
  previewSize: number
): void {
  const { grid, theme, portals } = map;
  const mapHeight = grid.length;
  const mapWidth = grid[0]?.length || 0;
  
  if (mapWidth === 0 || mapHeight === 0) return;
  
  // Calculate scale to fit in preview
  const scale = Math.min(previewSize / mapWidth, previewSize / mapHeight);
  const cellPreviewSize = scale;
  
  // Center the preview
  const previewWidth = mapWidth * cellPreviewSize;
  const previewHeight = mapHeight * cellPreviewSize;
  const startX = x - previewWidth / 2;
  const startY = y - previewHeight / 2;
  
  // Draw floor
  graphics.fillStyle(theme.floorColor, 1);
  graphics.fillRect(startX, startY, previewWidth, previewHeight);
  
  // Create portal color map
  const portalColors = new Map<number, number>();
  if (portals) {
    for (const portal of portals) {
      portalColors.set(portal.id, portal.color);
    }
  }
  
  // Draw cells
  for (let row = 0; row < grid.length; row++) {
    for (let col = 0; col < grid[row].length; col++) {
      const cell = grid[row][col];
      const cellX = startX + col * cellPreviewSize;
      const cellY = startY + row * cellPreviewSize;
      
      if (cell === CELL_WALL) {
        graphics.fillStyle(theme.wallColor, 1);
        graphics.fillRect(cellX, cellY, cellPreviewSize, cellPreviewSize);
      } else if (cell >= 2) {
        // Portal
        const color = portalColors.get(cell) || 0xff00ff;
        graphics.fillStyle(color, 0.6);
        graphics.fillCircle(
          cellX + cellPreviewSize / 2,
          cellY + cellPreviewSize / 2,
          cellPreviewSize / 2
        );
      }
    }
  }
  
  // Border
  graphics.lineStyle(2, 0xffffff, 0.5);
  graphics.strokeRect(startX, startY, previewWidth, previewHeight);
}

