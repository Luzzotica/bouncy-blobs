// Co-op Shooter Game - Players work together to reach the goal

import { Fragment } from "react";
import { Game, GameContext, PlayerState } from "../GameInterface";
import { InputEvent } from "../../types";
import { buildControllerConfig } from "../../types/controllerConfig";
import { Player } from "../../types/database";

// Game phases
type GamePhase = "playing" | "round_complete" | "game_over" | "round_transition";

// Bullet interface
interface Bullet {
  id: string;
  playerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  lifetime: number;
  maxLifetime: number;
}

// Enemy interface
interface Enemy {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  health: number;
  maxHealth: number;
  radius: number;
  color: string;
}

// Explosion particle
interface Particle {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  lifetime: number;
  maxLifetime: number;
}

// Obstacle interface
interface Obstacle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: "wall" | "rock" | "barrier";
}

interface CoopShooterPlayerState extends PlayerState {
  position: { x: number; y: number };
  angle: number; // Shooting angle
  health: number;
  maxHealth: number;
  lastShotTime: number;
  lastMoveInput: { x: number; y: number }; // Last movement joystick input
  lastAimInput: { x: number; y: number }; // Last aim/shoot joystick input
}

interface CoopShooterGameState {
  phase: GamePhase;
  round: number;
  startPoint: { x: number; y: number };
  finishPoint: { x: number; y: number };
  finishRadius: number;
  bullets: Bullet[];
  enemies: Enemy[];
  particles: Particle[];
  obstacles: Obstacle[];
  camera: {
    x: number;
    y: number;
    zoom: number;
  };
  nextEnemySpawn: number;
  enemySpawnRate: number;
  maxPlayerDistance: number; // Max distance players can be from each other
  allPlayersInGoalStartTime?: number; // When all players entered goal
  roundTransitionMessage?: string; // Message to show before next round
  roundTransitionEndTime?: number; // When to end transition phase
}

// Enemy colors for variety
const ENEMY_COLORS = ["#ef4444", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"];

// Particle colors for explosions
const PARTICLE_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#fbbf24",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#10b981",
  "#ffffff",
];

// Quirky round transition messages
const ROUND_TRANSITION_MESSAGES = [
  "The heroes press onward, determined to vanquish their foes!",
  "With unwavering courage, the team advances to the next challenge!",
  "Victory achieved! The warriors march forward to face greater dangers!",
  "The squad celebrates briefly, then steels themselves for what lies ahead!",
  "Another obstacle overcome! The adventure continues!",
  "The team high-fives and charges into the next battle!",
  "Success! But the journey is far from over...",
  "The heroes catch their breath and prepare for round two!",
  "Well done! But the enemies are getting stronger...",
  "The party celebrates and moves forward together!",
];

// Helper functions
function getDistance(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

function normalize(x: number, y: number): { x: number; y: number } {
  const len = Math.sqrt(x * x + y * y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createExplosion(
  x: number,
  y: number,
  _color: string,
): Particle[] {
  const particles: Particle[] = [];
  const particleCount = 20;
  for (let i = 0; i < particleCount; i++) {
    const angle = (Math.PI * 2 * i) / particleCount;
    const speed = 2 + Math.random() * 3;
    particles.push({
      id: `particle_${Date.now()}_${i}`,
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
      lifetime: 0,
      maxLifetime: 30 + Math.random() * 20,
    });
  }
  return particles;
}

function updateCamera(
  context: GameContext,
  gameState: CoopShooterGameState,
) {
  const players = Array.from(context.playerStates.values()) as unknown as CoopShooterPlayerState[];
  if (players.length === 0) return;

  // Find bounding box of all players
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;

  players.forEach((player) => {
    minX = Math.min(minX, player.position.x);
    maxX = Math.max(maxX, player.position.x);
    minY = Math.min(minY, player.position.y);
    maxY = Math.max(maxY, player.position.y);
  });

  // Add padding
  const padding = 50;
  minX -= padding;
  maxX += padding;
  minY -= padding;
  maxY += padding;

  // Center camera on players
  gameState.camera.x = (minX + maxX) / 2;
  gameState.camera.y = (minY + maxY) / 2;

  // Calculate zoom based on player spread
  const width = maxX - minX;
  const height = maxY - minY;
  const maxDimension = Math.max(width, height);
  // Zoom so that the larger dimension fits in ~80% of the view
  gameState.camera.zoom = clamp(100 / Math.max(maxDimension, 200), 0.5, 2);
}

function constrainPlayerDistance(
  context: GameContext,
  gameState: CoopShooterGameState,
) {
  const players = Array.from(
    context.playerStates.values(),
  ) as unknown as CoopShooterPlayerState[];
  if (players.length < 2) return;

  const maxDist = gameState.maxPlayerDistance;

  // Check all pairs of players
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const p1 = players[i];
      const p2 = players[j];
      const dist = getDistance(
        p1.position.x,
        p1.position.y,
        p2.position.x,
        p2.position.y,
      );

      if (dist > maxDist) {
        // Move players closer together
        const dir = normalize(
          p2.position.x - p1.position.x,
          p2.position.y - p1.position.y,
        );
        const midpointX = (p1.position.x + p2.position.x) / 2;
        const midpointY = (p1.position.y + p2.position.y) / 2;

        p1.position.x = midpointX - dir.x * (maxDist / 2);
        p1.position.y = midpointY - dir.y * (maxDist / 2);
        p2.position.x = midpointX + dir.x * (maxDist / 2);
        p2.position.y = midpointY + dir.y * (maxDist / 2);
      }
    }
  }
}

// Collision detection and resolution
function resolveCircleCollision(
  x1: number,
  y1: number,
  r1: number,
  x2: number,
  y2: number,
  r2: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const dist = getDistance(x1, y1, x2, y2);
  const minDist = r1 + r2;

  if (dist < minDist && dist > 0) {
    // Calculate overlap
    const overlap = minDist - dist;
    const dir = normalize(x2 - x1, y2 - y1);

    // Separate circles by moving them apart
    const moveX = dir.x * (overlap / 2);
    const moveY = dir.y * (overlap / 2);

    return {
      x1: x1 - moveX,
      y1: y1 - moveY,
      x2: x2 + moveX,
      y2: y2 + moveY,
    };
  }

  return { x1, y1, x2, y2 };
}

function resolvePlayerCollisions(players: CoopShooterPlayerState[]) {
  const playerRadius = 12; // Player collision radius

  // Check all pairs of players
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const p1 = players[i];
      const p2 = players[j];
      const resolved = resolveCircleCollision(
        p1.position.x,
        p1.position.y,
        playerRadius,
        p2.position.x,
        p2.position.y,
        playerRadius,
      );

      p1.position.x = resolved.x1;
      p1.position.y = resolved.y1;
      p2.position.x = resolved.x2;
      p2.position.y = resolved.y2;
    }
  }
}

function resolveEnemyCollisions(enemies: Enemy[]) {
  // Check all pairs of enemies
  for (let i = 0; i < enemies.length; i++) {
    for (let j = i + 1; j < enemies.length; j++) {
      const e1 = enemies[i];
      const e2 = enemies[j];
      const resolved = resolveCircleCollision(
        e1.x,
        e1.y,
        e1.radius,
        e2.x,
        e2.y,
        e2.radius,
      );

      e1.x = resolved.x1;
      e1.y = resolved.y1;
      e2.x = resolved.x2;
      e2.y = resolved.y2;
    }
  }
}

function resolvePlayerEnemyCollisions(
  players: CoopShooterPlayerState[],
  enemies: Enemy[],
) {
  const playerRadius = 12;

  players.forEach((player) => {
    enemies.forEach((enemy) => {
      const resolved = resolveCircleCollision(
        player.position.x,
        player.position.y,
        playerRadius,
        enemy.x,
        enemy.y,
        enemy.radius,
      );

      // Only move the player (enemies push players)
      player.position.x = resolved.x1;
      player.position.y = resolved.y1;
      enemy.x = resolved.x2;
      enemy.y = resolved.y2;
    });
  });
}

// Check if a circle collides with a rectangle
function circleRectCollision(
  cx: number,
  cy: number,
  radius: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  // Find closest point on rectangle to circle center
  const closestX = Math.max(rx, Math.min(cx, rx + rw));
  const closestY = Math.max(ry, Math.min(cy, ry + rh));

  // Calculate distance from circle center to closest point
  const distX = cx - closestX;
  const distY = cy - closestY;
  const distSq = distX * distX + distY * distY;

  return distSq < radius * radius;
}

// Resolve circle-rectangle collision by pushing circle out
function resolveCircleRectCollision(
  cx: number,
  cy: number,
  radius: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): { x: number; y: number } {
  // Find closest point on rectangle to circle center
  const closestX = Math.max(rx, Math.min(cx, rx + rw));
  const closestY = Math.max(ry, Math.min(cy, ry + rh));

  // Calculate direction from obstacle to circle
  const dx = cx - closestX;
  const dy = cy - closestY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < radius && dist > 0) {
    // Push circle out
    const overlap = radius - dist;
    const dir = normalize(dx, dy);
    return {
      x: cx + dir.x * overlap,
      y: cy + dir.y * overlap,
    };
  }

  return { x: cx, y: cy };
}

function resolveObstacleCollisions(
  players: CoopShooterPlayerState[],
  enemies: Enemy[],
  obstacles: Obstacle[],
) {
  const playerRadius = 12;

  // Resolve player-obstacle collisions
  players.forEach((player) => {
    obstacles.forEach((obstacle) => {
      if (
        circleRectCollision(
          player.position.x,
          player.position.y,
          playerRadius,
          obstacle.x - obstacle.width / 2,
          obstacle.y - obstacle.height / 2,
          obstacle.width,
          obstacle.height,
        )
      ) {
        const resolved = resolveCircleRectCollision(
          player.position.x,
          player.position.y,
          playerRadius,
          obstacle.x - obstacle.width / 2,
          obstacle.y - obstacle.height / 2,
          obstacle.width,
          obstacle.height,
        );
        player.position.x = resolved.x;
        player.position.y = resolved.y;
      }
    });
  });

  // Resolve enemy-obstacle collisions
  enemies.forEach((enemy) => {
    obstacles.forEach((obstacle) => {
      if (
        circleRectCollision(
          enemy.x,
          enemy.y,
          enemy.radius,
          obstacle.x - obstacle.width / 2,
          obstacle.y - obstacle.height / 2,
          obstacle.width,
          obstacle.height,
        )
      ) {
        const resolved = resolveCircleRectCollision(
          enemy.x,
          enemy.y,
          enemy.radius,
          obstacle.x - obstacle.width / 2,
          obstacle.y - obstacle.height / 2,
          obstacle.width,
          obstacle.height,
        );
        enemy.x = resolved.x;
        enemy.y = resolved.y;
      }
    });
  });
}

// Generate random obstacles
function generateRandomObstacles(count: number = 20): Obstacle[] {
  const obstacles: Obstacle[] = [];
  const types: Obstacle["type"][] = ["wall", "rock", "barrier"];
  
  // Define a larger playable area (since goal can be up to 2000 units away)
  // Use a larger area to accommodate the longer distances
  const minX = -500;
  const maxX = 1500;
  const minY = -500;
  const maxY = 1500;

  for (let i = 0; i < count; i++) {
    const type = types[Math.floor(Math.random() * types.length)];
    const width = 30 + Math.random() * 50;
    const height = 30 + Math.random() * 80;
    
    obstacles.push({
      id: `obs_${i}_${Date.now()}`,
      x: minX + Math.random() * (maxX - minX),
      y: minY + Math.random() * (maxY - minY),
      width,
      height,
      type,
    });
  }

  return obstacles;
}

// Generate random finish point
function generateRandomFinishPoint(startPoint: { x: number; y: number }): { x: number; y: number } {
  const minDistance = 1000; // Minimum distance from start point
  const maxDistance = 2000; // Maximum distance from start point
  
  // Generate a random distance between min and max
  const distance = minDistance + Math.random() * (maxDistance - minDistance);
  
  // Generate a random angle
  const angle = Math.random() * Math.PI * 2;
  
  // Place finish point at the calculated distance and angle
  return {
    x: startPoint.x + Math.cos(angle) * distance,
    y: startPoint.y + Math.sin(angle) * distance,
  };
}

function spawnEnemy(
  gameState: CoopShooterGameState,
  camera: { x: number; y: number; zoom: number },
  players: CoopShooterPlayerState[],
): Enemy | null {
  if (players.length === 0) return null;

  // Spawn far off-screen relative to camera and players
  // Find the furthest player from camera center
  let maxPlayerDistance = 0;
  players.forEach((player) => {
    const dist = getDistance(
      camera.x,
      camera.y,
      player.position.x,
      player.position.y,
    );
    maxPlayerDistance = Math.max(maxPlayerDistance, dist);
  });

  // Spawn at least 800 units away, or further if players are spread out
  const spawnDistance = Math.max(800, maxPlayerDistance + 400);
  const angle = Math.random() * Math.PI * 2;
  const spawnX = camera.x + Math.cos(angle) * spawnDistance;
  const spawnY = camera.y + Math.sin(angle) * spawnDistance;

  // Base stats that scale with round
  const baseHealth = 1;
  const baseSpeed = 0.8;
  const healthMultiplier = 1 + gameState.round * 0.3;
  const speedMultiplier = 1 + gameState.round * 0.1;

  return {
    id: `enemy_${Date.now()}_${Math.random()}`,
    x: spawnX,
    y: spawnY,
    vx: 0,
    vy: 0,
    speed: baseSpeed * speedMultiplier,
    health: baseHealth * healthMultiplier,
    maxHealth: baseHealth * healthMultiplier,
    radius: 20 + gameState.round * 2,
    color: ENEMY_COLORS[Math.floor(Math.random() * ENEMY_COLORS.length)],
  };
}

const CoopShooterGame: Game = {
  gameDefinition: {
    id: "coop_shooter",
    name: "Co-op Shooter",
    description: "Work together to reach the goal while fighting off enemies!",
    controllerConfig: buildControllerConfig(
      { left: "joystick", right: "joystick" },
      { left: "Movement", right: "Aim & Shoot" },
    ),
  },

  initialize(_context: GameContext): CoopShooterGameState {
    const startPoint = { x: 100, y: 100 };
    // Generate random obstacles and finish point
    const obstacles = generateRandomObstacles(20);
    const finishPoint = generateRandomFinishPoint(startPoint);

    return {
      phase: "playing",
      round: 1,
      startPoint,
      finishPoint,
      finishRadius: 120,
      bullets: [],
      enemies: [],
      particles: [],
      obstacles,
      camera: { x: 300, y: 300, zoom: 1 },
      nextEnemySpawn: Date.now() + 2000,
      enemySpawnRate: 2000 - 100, // Gets faster each round
      maxPlayerDistance: 200,
    };
  },

  onPlayerJoin(context: GameContext, player: Player) {
    const playerId = player.user_id || player.anonymous_id || 'unknown';
    const gameState = context.gameState as CoopShooterGameState;

    const playerState: CoopShooterPlayerState = {
      playerId,
      position: { ...gameState.startPoint },
      angle: 0,
      health: 100,
      maxHealth: 100,
      lastShotTime: 0,
      lastMoveInput: { x: 0, y: 0 },
      lastAimInput: { x: 0, y: 0 },
    } as CoopShooterPlayerState;
    context.playerStates.set(playerId, playerState as PlayerState);
  },

  onPlayerDisconnect(context: GameContext, playerId: string) {
    const gameState = context.gameState as CoopShooterGameState;
    context.playerStates.delete(playerId);

    // Remove player's bullets
    gameState.bullets = gameState.bullets.filter(
      (b) => b.playerId !== playerId,
    );
  },

  onPlayerInput(
    context: GameContext,
    playerId: string,
    inputEvent: InputEvent,
  ) {
    const gameState = context.gameState as CoopShooterGameState;
    const playerState = context.playerStates.get(
      playerId,
    ) as unknown as CoopShooterPlayerState;

    if (!playerState || gameState.phase !== "playing") return;

    // Dead players can't move or shoot
    if (playerState.health <= 0) return;

    if (inputEvent.type === "continuous") {
      if (inputEvent.inputType === "joystick_left") {
        // Store movement input
        const joystick = inputEvent.value as { x: number; y: number };
        playerState.lastMoveInput = { x: joystick.x, y: joystick.y };
      } else if (inputEvent.inputType === "joystick_right") {
        // Store aim input
        const joystick = inputEvent.value as { x: number; y: number };
        playerState.lastAimInput = { x: joystick.x, y: joystick.y };
        
        // Update aim angle if joystick is pushed far enough
        const magnitude = Math.sqrt(joystick.x * joystick.x + joystick.y * joystick.y);
        if (magnitude > 0.3) {
          playerState.angle = Math.atan2(-joystick.y, joystick.x);
        }
      }
    }
  },

  update(context: GameContext, _deltaTime: number) {
    const gameState = context.gameState as CoopShooterGameState;

    // Handle round transition phase first (needs to run even when not playing)
    if (gameState.phase === "round_transition" && gameState.roundTransitionEndTime) {
      const now = Date.now();
      if (now >= gameState.roundTransitionEndTime) {
        // Start next round
        gameState.round++;
        gameState.enemies = [];
        gameState.bullets = [];
        gameState.particles = [];
        gameState.allPlayersInGoalStartTime = undefined;
        gameState.roundTransitionMessage = undefined;
        gameState.roundTransitionEndTime = undefined;

        // Generate new random obstacles and finish point
        gameState.obstacles = generateRandomObstacles(20);
        gameState.finishPoint = generateRandomFinishPoint(gameState.startPoint);

        const playerStates = Array.from(
          context.playerStates.values(),
        ) as CoopShooterPlayerState[];

        // Reset player positions
        playerStates.forEach((player) => {
          player.position = { ...gameState.startPoint };
          player.health = player.maxHealth;
          // Reset input to stop movement/shooting when round resets
          player.lastMoveInput = { x: 0, y: 0 };
          player.lastAimInput = { x: 0, y: 0 };
        });

        // Increase difficulty
        gameState.enemySpawnRate = Math.max(
          500,
          gameState.enemySpawnRate - 100,
        );
        gameState.maxPlayerDistance = Math.max(
          150,
          gameState.maxPlayerDistance - 10,
        );

        gameState.phase = "playing";
        return; // Exit early after starting new round
      }
      return; // Don't process game logic during transition
    }

    if (gameState.phase !== "playing") return;

    const playerStates = Array.from(
      context.playerStates.values(),
    ) as CoopShooterPlayerState[];

    if (playerStates.length === 0) return;

    // Resolve collisions before movement
    resolvePlayerCollisions(playerStates);
    resolveEnemyCollisions(gameState.enemies);
    resolvePlayerEnemyCollisions(playerStates, gameState.enemies);

    // Constrain player distances
    constrainPlayerDistance(context, gameState);

    // Update player movement and shooting based on last input
    playerStates.forEach((playerState) => {
      // Dead players can't move or shoot
      if (playerState.health <= 0) {
        // Clear inputs for dead players
        playerState.lastMoveInput = { x: 0, y: 0 };
        playerState.lastAimInput = { x: 0, y: 0 };
        return;
      }

      // Continuous movement based on last input
      const moveMagnitude = Math.sqrt(
        playerState.lastMoveInput.x * playerState.lastMoveInput.x +
        playerState.lastMoveInput.y * playerState.lastMoveInput.y,
      );
      if (moveMagnitude > 0.1) {
        // Only move if there's significant input
        const moveSpeed = 2;
        playerState.position.x += playerState.lastMoveInput.x * moveSpeed;
        playerState.position.y -= playerState.lastMoveInput.y * moveSpeed;
      }

      // Continuous shooting based on last aim input
      const aimMagnitude = Math.sqrt(
        playerState.lastAimInput.x * playerState.lastAimInput.x +
        playerState.lastAimInput.y * playerState.lastAimInput.y,
      );
      if (aimMagnitude > 0.3) {
        // Update angle if there's significant input
        playerState.angle = Math.atan2(
          -playerState.lastAimInput.y,
          playerState.lastAimInput.x,
        );

        // Shoot continuously
        const now = Date.now();
        const shootCooldown = 150; // ms between shots
        if (now - playerState.lastShotTime > shootCooldown) {
          playerState.lastShotTime = now;

          // Create bullet
          const bulletSpeed = 8;
          const bulletPlayerId = (playerState as PlayerState).playerId;
          const bullet: Bullet = {
            id: `bullet_${Date.now()}_${bulletPlayerId}_${Math.random()}`,
            playerId: bulletPlayerId,
            x: playerState.position.x,
            y: playerState.position.y,
            vx: Math.cos(playerState.angle) * bulletSpeed,
            vy: Math.sin(playerState.angle) * bulletSpeed,
            speed: bulletSpeed,
            lifetime: 0,
            maxLifetime: 600, // frames (10 seconds at 60fps)
          };
          gameState.bullets.push(bullet);
        }
      }
    });

    // Resolve collisions after movement
    resolvePlayerCollisions(playerStates);
    resolveEnemyCollisions(gameState.enemies);
    resolvePlayerEnemyCollisions(playerStates, gameState.enemies);
    resolveObstacleCollisions(playerStates, gameState.enemies, gameState.obstacles);

    // Update camera
    updateCamera(context, gameState);

    // Spawn enemies
    const now = Date.now();
    if (now >= gameState.nextEnemySpawn) {
      const enemy = spawnEnemy(gameState, gameState.camera, playerStates);
      if (enemy) {
        gameState.enemies.push(enemy);
      }
      gameState.nextEnemySpawn =
        now + Math.max(500, gameState.enemySpawnRate - gameState.round * 50);
    }

    // Update bullets
    gameState.bullets = gameState.bullets.filter((bullet) => {
      bullet.x += bullet.vx;
      bullet.y += bullet.vy;
      bullet.lifetime++;

      // Remove if lifetime expired
      if (bullet.lifetime >= bullet.maxLifetime) {
        return false;
      }

      // Check collision with obstacles
      for (const obstacle of gameState.obstacles) {
        if (
          circleRectCollision(
            bullet.x,
            bullet.y,
            3, // Bullet radius
            obstacle.x - obstacle.width / 2,
            obstacle.y - obstacle.height / 2,
            obstacle.width,
            obstacle.height,
          )
        ) {
          // Hit obstacle - remove bullet
          return false;
        }
      }

      // Check collision with enemies
      for (let i = gameState.enemies.length - 1; i >= 0; i--) {
        const enemy = gameState.enemies[i];
        const dist = getDistance(bullet.x, bullet.y, enemy.x, enemy.y);
        if (dist < enemy.radius) {
          // Hit enemy
          enemy.health -= 1;
          if (enemy.health <= 0) {
            // Enemy killed - create explosion
            const explosion = createExplosion(enemy.x, enemy.y, enemy.color);
            gameState.particles.push(...explosion);
            gameState.enemies.splice(i, 1);
          }
          return false; // Remove bullet
        }
      }

      return true;
    });

    // Update enemies
    gameState.enemies.forEach((enemy) => {
      // Find closest player
      let closestPlayer: CoopShooterPlayerState | null = null;
      let closestDist = Infinity;

      for (const playerState of playerStates) {
        const dist = getDistance(
          enemy.x,
          enemy.y,
          playerState.position.x,
          playerState.position.y,
        );
        if (dist < closestDist) {
          closestDist = dist;
          closestPlayer = playerState;
        }
      }

      // Move toward closest player
      if (closestPlayer !== null) {
        const player = closestPlayer;
        const dir = normalize(
          player.position.x - enemy.x,
          player.position.y - enemy.y,
        );
        enemy.vx = dir.x * enemy.speed;
        enemy.vy = dir.y * enemy.speed;
        enemy.x += enemy.vx;
        enemy.y += enemy.vy;

        // Check collision with players for damage
        const dist = getDistance(
          enemy.x,
          enemy.y,
          player.position.x,
          player.position.y,
        );
        if (dist < enemy.radius + 12) {
          // Damage player
          player.health -= 0.5;
          if (player.health <= 0) {
            player.health = 0;
            // Could add respawn logic here
          }
        }
      }
    });

    // Resolve collisions after enemy movement
    resolveEnemyCollisions(gameState.enemies);
    resolvePlayerEnemyCollisions(playerStates, gameState.enemies);
    resolveObstacleCollisions(playerStates, gameState.enemies, gameState.obstacles);

    // Update particles
    gameState.particles = gameState.particles.filter((particle) => {
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vx *= 0.95; // Friction
      particle.vy *= 0.95;
      particle.lifetime++;
      return particle.lifetime < particle.maxLifetime;
    });

    // Check win condition - all players must be in goal for 10 seconds
    const allAtFinish = playerStates.every((player) => {
      const dist = getDistance(
        player.position.x,
        player.position.y,
        gameState.finishPoint.x,
        gameState.finishPoint.y,
      );
      return dist <= gameState.finishRadius;
    });

    if (allAtFinish && playerStates.length > 0) {
      const now = Date.now();
      
      if (!gameState.allPlayersInGoalStartTime) {
        // Start the timer
        gameState.allPlayersInGoalStartTime = now;
      } else {
        // Check if 10 seconds have passed
        const timeInGoal = now - gameState.allPlayersInGoalStartTime;
        if (timeInGoal >= 10000) {
          // Round complete - show transition message
          if (gameState.phase === "playing") {
            gameState.phase = "round_transition";
            gameState.roundTransitionMessage =
              ROUND_TRANSITION_MESSAGES[
                Math.floor(Math.random() * ROUND_TRANSITION_MESSAGES.length)
              ];
            gameState.roundTransitionEndTime = now + 3000; // Show message for 3 seconds
          }
        }
      }
    } else {
      // Reset timer if not all players are in goal
      gameState.allPlayersInGoalStartTime = undefined;
    }

  },

  render(context: GameContext, players: Player[], colors: string[]) {
    const gameState = context.gameState as CoopShooterGameState;

    // Ensure state is initialized
    if (!gameState.phase) {
      const initState = this.initialize!(context);
      Object.assign(gameState, initState);
    }

    const playerStates = Array.from(
      context.playerStates.values(),
    ) as CoopShooterPlayerState[];

    // Calculate viewport bounds based on camera
    const viewWidth = 800;
    const viewHeight = 600;
    const zoom = gameState.camera.zoom;
    const worldWidth = viewWidth / zoom;
    const worldHeight = viewHeight / zoom;

    const viewLeft = gameState.camera.x - worldWidth / 2;
    const viewTop = gameState.camera.y - worldHeight / 2;

    // Helper to convert world coordinates to screen coordinates (0-100%)
    const worldToScreen = (wx: number, wy: number) => {
      const screenX = ((wx - viewLeft) / worldWidth) * 100;
      const screenY = ((wy - viewTop) / worldHeight) * 100;
      return { x: screenX, y: screenY };
    };

    // Helper to convert world size to screen size (%)
    const worldSizeToScreen = (worldSize: number, isWidth: boolean = true) => {
      const worldDim = isWidth ? worldWidth : worldHeight;
      return (worldSize / worldDim) * 100;
    };

    // Check if all players are in goal and show countdown
    const allAtFinish = playerStates.every((player) => {
      const dist = getDistance(
        player.position.x,
        player.position.y,
        gameState.finishPoint.x,
        gameState.finishPoint.y,
      );
      return dist <= gameState.finishRadius;
    });
    const timeInGoal = gameState.allPlayersInGoalStartTime
      ? Date.now() - gameState.allPlayersInGoalStartTime
      : 0;
    const timeRemaining = Math.max(0, 10000 - timeInGoal);

    // Calculate progress bar percentage
    const progressPercent = allAtFinish && gameState.allPlayersInGoalStartTime
      ? Math.min(100, (timeInGoal / 10000) * 100)
      : 0;

    return (
      <div className="bg-gray-900 rounded-2xl p-8 relative">

        {/* Round Transition Message Overlay */}
        {gameState.phase === "round_transition" && gameState.roundTransitionMessage && gameState.roundTransitionEndTime && (
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center rounded-2xl">
            <div className="bg-gray-800 rounded-2xl p-8 border-4 border-yellow-500 max-w-2xl text-center">
              <h3 className="text-3xl font-bold text-yellow-400 mb-4">
                Round {gameState.round} Complete!
              </h3>
              <p className="text-xl text-white mb-6">
                {gameState.roundTransitionMessage}
              </p>
              <p className="text-2xl font-bold text-yellow-400 mb-2">
                Next round starts in {Math.max(0, Math.ceil((gameState.roundTransitionEndTime - Date.now()) / 1000))}...
              </p>
              <p className="text-sm text-gray-400">
                Preparing next round...
              </p>
            </div>
          </div>
        )}

        {/* Game Area */}
        <div
          className="relative bg-gray-950 rounded-lg overflow-hidden mb-4"
          style={{
            width: "100%",
            height: "600px",
            position: "relative",
          }}
        >

          {/* Header Text Overlay */}
          <div className="absolute top-2 left-2 right-2 z-40 flex justify-between items-start pointer-events-none">
            <h2 className="text-lg font-semibold text-white drop-shadow-lg bg-black/50 px-3 py-1 rounded">
              Co-op Shooter - Round {gameState.round}
            </h2>
            <div className="text-white text-sm drop-shadow-lg bg-black/50 px-3 py-1 rounded">
              Enemies: {gameState.enemies.length} | Players: {players.length}
              {allAtFinish && timeRemaining > 0 && (
                <span className="ml-2 text-green-400">
                  Hold for {Math.ceil(timeRemaining / 1000)}s...
                </span>
              )}
            </div>
          </div>

          <div
            className="absolute inset-0"
            style={{
              width: "100%",
              height: "100%",
            }}
          >
            {/* Finish Point */}
            {(() => {
              const screen = worldToScreen(
                gameState.finishPoint.x,
                gameState.finishPoint.y,
              );
              const radiusPercent = worldSizeToScreen(gameState.finishRadius * 2);
              return (
                <div
                  className="absolute rounded-full border-4 border-green-500 bg-green-500/20"
                  style={{
                    left: `${screen.x}%`,
                    top: `${screen.y}%`,
                    width: `${radiusPercent}%`,
                    height: `${radiusPercent}%`,
                    transform: "translate(-50%, -50%)",
                    borderStyle: "dashed",
                  }}
                >
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-green-500 font-bold text-xs whitespace-nowrap">
                    GOAL
                  </div>
                </div>
              );
            })()}

            {/* Start Point */}
            {(() => {
              const screen = worldToScreen(
                gameState.startPoint.x,
                gameState.startPoint.y,
              );
              return (
                <div
                  className="absolute rounded-full border-4 border-blue-500 bg-blue-500/20"
                  style={{
                    left: `${screen.x}%`,
                    top: `${screen.y}%`,
                    width: "40px",
                    height: "40px",
                    transform: "translate(-50%, -50%)",
                  }}
                >
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-blue-500 font-bold text-xs whitespace-nowrap">
                    START
                  </div>
                </div>
              );
            })()}

            {/* Obstacles */}
            {gameState.obstacles.map((obstacle) => {
              const screen = worldToScreen(obstacle.x, obstacle.y);
              const widthPercent = worldSizeToScreen(obstacle.width);
              const heightPercent = worldSizeToScreen(obstacle.height, false);
              
              let bgColor = "#4b5563"; // Default gray
              let borderColor = "#6b7280";
              
              if (obstacle.type === "wall") {
                bgColor = "#374151";
                borderColor = "#4b5563";
              } else if (obstacle.type === "rock") {
                bgColor = "#525252";
                borderColor = "#737373";
              } else if (obstacle.type === "barrier") {
                bgColor = "#1f2937";
                borderColor = "#374151";
              }

              return (
                <div
                  key={obstacle.id}
                  className="absolute border-2"
                  style={{
                    left: `${screen.x}%`,
                    top: `${screen.y}%`,
                    width: `${widthPercent}%`,
                    height: `${heightPercent}%`,
                    backgroundColor: bgColor,
                    borderColor: borderColor,
                    transform: "translate(-50%, -50%)",
                    opacity: 0.9,
                  }}
                />
              );
            })}

            {/* Particles */}
            {gameState.particles.map((particle) => {
              const screen = worldToScreen(particle.x, particle.y);
              const opacity = 1 - particle.lifetime / particle.maxLifetime;
              return (
                <div
                  key={particle.id}
                  className="absolute rounded-full"
                  style={{
                    left: `${screen.x}%`,
                    top: `${screen.y}%`,
                    width: "4px",
                    height: "4px",
                    backgroundColor: particle.color,
                    opacity,
                    transform: "translate(-50%, -50%)",
                  }}
                />
              );
            })}

            {/* Bullets */}
            {gameState.bullets.map((bullet) => {
              const screen = worldToScreen(bullet.x, bullet.y);
              const playerColor =
                colors[
                  players.findIndex(
                    (p) =>
                      (p.user_id || p.anonymous_id || 'unknown') === bullet.playerId,
                  ) % colors.length
                ] || "#ffffff";
              return (
                <div
                  key={bullet.id}
                  className="absolute rounded-full"
                  style={{
                    left: `${screen.x}%`,
                    top: `${screen.y}%`,
                    width: "6px",
                    height: "6px",
                    backgroundColor: playerColor,
                    transform: "translate(-50%, -50%)",
                    boxShadow: `0 0 4px ${playerColor}`,
                  }}
                />
              );
            })}

            {/* Enemies */}
            {gameState.enemies.map((enemy) => {
              const screen = worldToScreen(enemy.x, enemy.y);
              const healthPercent = enemy.health / enemy.maxHealth;
              const sizePercent = worldSizeToScreen(enemy.radius * 2);
              return (
                <div
                  key={enemy.id}
                  className="absolute rounded-full border-2 border-white"
                  style={{
                    left: `${screen.x}%`,
                    top: `${screen.y}%`,
                    width: `${sizePercent}%`,
                    height: `${sizePercent}%`,
                    backgroundColor: enemy.color,
                    transform: "translate(-50%, -50%)",
                    opacity: 0.8,
                  }}
                >
                  {/* Health bar */}
                  <div
                    className="absolute -top-1 left-1/2 -translate-x-1/2 h-0.5 bg-red-900 rounded"
                    style={{ width: `${sizePercent * 0.6}%` }}
                  >
                    <div
                      className="h-full bg-red-500 rounded"
                      style={{ width: `${healthPercent * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}

            {/* Players */}
            {players.map((player, index) => {
              const playerId = player.user_id || player.anonymous_id || 'unknown';
              const state = playerStates.find((ps) => (ps as PlayerState).playerId === playerId);
              if (!state) return null;

              const screen = worldToScreen(state.position.x, state.position.y);
              const color = colors[index % colors.length];

              return (
                <Fragment key={playerId}>
                  {/* Player circle */}
                  <div
                    className="absolute rounded-full border-2 border-white transition-all duration-75"
                    style={{
                      left: `${screen.x}%`,
                      top: `${screen.y}%`,
                      width: "24px",
                      height: "24px",
                      backgroundColor: color,
                      transform: "translate(-50%, -50%)",
                      opacity: state.health > 0 ? 1 : 0.5,
                    }}
                  />

                  {/* Aiming direction indicator - extends from player edge */}
                  <div
                    className="absolute w-6 h-1"
                    style={{
                      left: `${screen.x}%`,
                      top: `${screen.y}%`,
                      backgroundColor: color,
                      transformOrigin: "center center",
                      transform: `translate(-50%, -50%) translate(${Math.cos(state.angle) * 12}px, ${Math.sin(state.angle) * 12}px) rotate(${state.angle}rad)`,
                      boxShadow: `0 0 4px ${color}`,
                    }}
                  />

                  {/* Player name */}
                  <div
                    className="absolute text-white text-xs font-bold drop-shadow-lg whitespace-nowrap"
                    style={{
                      left: `${screen.x}%`,
                      top: `${screen.y}%`,
                      transform: "translate(-50%, -180%)",
                    }}
                  >
                    {player.name}
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>

        {/* Progress Bar Above Player Info */}
        {allAtFinish && (
          <div className="absolute bottom-0 left-0 right-0 z-40 px-4 pt-2 pb-0">
            <div className="w-full h-3 bg-gray-700/80 backdrop-blur-sm rounded-full overflow-hidden border border-white/20">
              <div
                className="h-full bg-green-500 transition-all duration-100 ease-linear"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Progress Bar Above Player Info */}
        {allAtFinish && (
          <div className="absolute bottom-0 left-0 right-0 z-40 px-4 pt-2 pb-0 pointer-events-none">
            <div className="w-full h-3 bg-gray-700/80 backdrop-blur-sm rounded-full overflow-hidden border border-white/20">
              <div
                className="h-full bg-green-500 transition-all duration-100 ease-linear"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Bottom Overlay UI - Smash Bros style */}
        <div className="absolute bottom-0 left-0 right-0 bg-black/80 backdrop-blur-sm border-t-2 border-white/20 p-4 rounded-b-2xl" style={{ paddingBottom: allAtFinish ? '3.5rem' : '1rem' }}>
          <div className="flex justify-center items-center gap-6 flex-wrap">
            {players.map((player, index) => {
              const playerId = player.user_id || player.anonymous_id || 'unknown';
              const state = playerStates.find((ps) => (ps as PlayerState).playerId === playerId);
              if (!state) return null;

              const color = colors[index % colors.length];
              const healthPercent = state.health / state.maxHealth;

              return (
                <div
                  key={playerId}
                  className="flex flex-col items-center gap-1 min-w-[120px]"
                >
                  {/* Player color indicator */}
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: color }}
                  />

                  {/* Player name */}
                  <div className="text-white font-bold text-sm text-center">
                    {player.name}
                  </div>

                  {/* Health bar */}
                  <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden border border-white/20">
                    <div
                      className="h-full rounded-full transition-all duration-150"
                      style={{
                        width: `${healthPercent * 100}%`,
                        backgroundColor:
                          healthPercent > 0.5
                            ? "#10b981"
                            : healthPercent > 0.25
                              ? "#f59e0b"
                              : "#ef4444",
                      }}
                    />
                  </div>

                  {/* Health text */}
                  <div className="text-white text-xs font-mono text-center">
                    {Math.max(0, Math.floor(state.health))}/{state.maxHealth}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  },
};

export default CoopShooterGame;

