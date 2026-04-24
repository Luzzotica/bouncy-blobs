// Arena Scene - Main gameplay scene with shooting mechanics

import Phaser from 'phaser';
import { PhaserGameBridge } from '../PhaserGame';
import {
  GridMapDefinition,
  GameMode,
  Team,
  Position,
  ROUND_END_DELAY,
  FFA_WIN_SCORE,
  TDM_WIN_SCORE,
  CTF_WIN_SCORE,
} from '../types';
import { Player } from '../entities/Player';
import { Bullet, BulletPool } from '../entities/Bullet';
import { Flag } from '../entities/Flag';
import {
  renderGrid,
  renderPortals,
  createWallBodies,
  createPortalSensors,
  getMapScaleAndOffset,
  gridToWorld,
  findBestSpawnPoint,
} from '../utils/gridUtils';

interface ArenaSceneData {
  map: GridMapDefinition;
  playerData?: Array<{ playerId: string; name: string; color: number; team: Team }>;
  gameMode?: GameMode;
}

export class ArenaScene extends Phaser.Scene {
  private bridge!: PhaserGameBridge;
  private currentMap!: GridMapDefinition;
  private gameMode: GameMode = 'free_for_all';
  private pendingPlayerData: Array<{ playerId: string; name: string; color: number; team: Team }> = [];
  
  // Map rendering
  private gridGraphics!: Phaser.GameObjects.Graphics;
  private portalGraphics!: Phaser.GameObjects.Graphics;
  private mapOffset: Position = { x: 0, y: 0 };
  private effectiveCellSize: number = 32;
  private portalBodies: Map<number, MatterJS.BodyType[]> = new Map();
  
  // Entities
  private players: Map<string, Player> = new Map();
  private bulletPool!: BulletPool;
  private flags: Map<Team, Flag> = new Map();
  private carriedFlagGraphics: Map<string, Phaser.GameObjects.Graphics> = new Map();
  
  // Game state
  private isRoundActive: boolean = false;
  private scores: {
    ffa: Map<string, number>;
    red: number;
    blue: number;
  } = { ffa: new Map(), red: 0, blue: 0 };
  
  // Portal cooldowns - tracks when entities can use portals again (entityId -> timestamp)
  private portalCooldowns: Map<string, number> = new Map();
  private readonly PORTAL_COOLDOWN = 500; // ms before can use portal again
  
  // UI elements
  private countdownText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private winnerText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'ArenaScene' });
  }

  init(data: ArenaSceneData): void {
    // Get bridge from game registry
    this.bridge = this.game.registry.get('bridge') as PhaserGameBridge;
    
    this.currentMap = data.map;
    this.gameMode = data.gameMode || this.bridge?.getGameMode() || 'free_for_all';
    this.pendingPlayerData = data.playerData || [];
    
    // Reset state
    this.players.clear();
    this.flags.clear();
    this.carriedFlagGraphics.clear();
    // Wall bodies created but not stored (cleaned up by Phaser)
    this.portalBodies.clear();
    this.portalCooldowns.clear();
    this.isRoundActive = false;
    this.scores = { ffa: new Map(), red: 0, blue: 0 };
  }

  create(): void {
    const { width, height } = this.scale;

    // Calculate map scale and offset to fill screen
    const { cellSize, offset } = getMapScaleAndOffset(this.currentMap, width, height, 60);
    this.effectiveCellSize = cellSize;
    this.mapOffset = offset;

    // Create a scaled version of the map for rendering
    const scaledMap = {
      ...this.currentMap,
      cellSize: this.effectiveCellSize,
    };

    // Create graphics objects
    this.gridGraphics = this.add.graphics().setDepth(0);
    this.portalGraphics = this.add.graphics().setDepth(1);

    // Render static grid with scaled cell size
    renderGrid(this.gridGraphics, scaledMap, this.mapOffset.x, this.mapOffset.y);

    // Create physics walls with scaled cell size
    createWallBodies(this, scaledMap, this.mapOffset.x, this.mapOffset.y);

    // Create portal sensors with scaled cell size
    this.portalBodies = createPortalSensors(this, scaledMap, this.mapOffset.x, this.mapOffset.y);

    // Create bullet pool
    this.bulletPool = new BulletPool(this);

    // Setup collision detection
    this.setupCollisions();

    // Create UI
    this.createUI();

    // Create flags for CTF mode
    if (this.gameMode === 'capture_the_flag' && this.currentMap.flagPositions) {
      this.createFlags();
    }

    // Assign teams if needed
    if (this.gameMode === 'team_deathmatch' || this.gameMode === 'capture_the_flag') {
      this.assignTeams();
    }

    // Add pending players
    for (const playerData of this.pendingPlayerData) {
      this.addPlayer(playerData.playerId, playerData.name, playerData.color, playerData.team);
    }
    this.pendingPlayerData = [];

    // Start countdown
    this.startCountdown();
  }

  private createUI(): void {
    const { width, height } = this.scale;

    // Countdown text
    this.countdownText = this.add.text(width / 2, height / 2, '', {
      fontSize: '100px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 8,
    }).setOrigin(0.5).setDepth(100).setVisible(false);

    // Score display
    this.scoreText = this.add.text(width / 2, 30, '', {
      fontSize: '24px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(100);

    // Winner text
    this.winnerText = this.add.text(width / 2, height / 2 - 50, '', {
      fontSize: '48px',
      fontFamily: 'Arial Black',
      color: '#00ff00',
      stroke: '#000000',
      strokeThickness: 6,
    }).setOrigin(0.5).setDepth(101).setVisible(false);

    this.updateScoreDisplay();
  }

  private createFlags(): void {
    if (!this.currentMap.flagPositions) return;

    const { red, blue } = this.currentMap.flagPositions;

    // Red flag (use effective cell size)
    const redPos = gridToWorld(red.x, red.y, this.effectiveCellSize, this.mapOffset.x, this.mapOffset.y);
    this.flags.set('red', new Flag(this, 'red', redPos.x, redPos.y));

    // Blue flag
    const bluePos = gridToWorld(blue.x, blue.y, this.effectiveCellSize, this.mapOffset.x, this.mapOffset.y);
    this.flags.set('blue', new Flag(this, 'blue', bluePos.x, bluePos.y));
  }

  private assignTeams(): void {
    // Balance teams based on existing team assignments
    const redCount = this.pendingPlayerData.filter(p => p.team === 'red').length;
    const blueCount = this.pendingPlayerData.filter(p => p.team === 'blue').length;

    for (const playerData of this.pendingPlayerData) {
      if (playerData.team === 'none') {
        // Assign to smaller team
        if (redCount <= blueCount) {
          playerData.team = 'red';
        } else {
          playerData.team = 'blue';
        }
      }
    }
  }

  private setupCollisions(): void {
    // Collision between bullets and players
    this.matter.world.on('collisionstart', (event: Phaser.Physics.Matter.Events.CollisionStartEvent) => {
      for (const pair of event.pairs) {
        const bodyA = pair.bodyA;
        const bodyB = pair.bodyB;

        // Check for bullet-player collision
        if (bodyA.label === 'bullet' && bodyB.label === 'player') {
          this.handleBulletHit(bodyA, bodyB);
        } else if (bodyB.label === 'bullet' && bodyA.label === 'player') {
          this.handleBulletHit(bodyB, bodyA);
        }

        // Check for bullet-wall collision
        if ((bodyA.label === 'bullet' && bodyB.label === 'wall') ||
            (bodyB.label === 'bullet' && bodyA.label === 'wall')) {
          const bulletBody = bodyA.label === 'bullet' ? bodyA : bodyB;
          const bullet = (bulletBody as any).bulletRef as Bullet;
          if (bullet) {
            bullet.onHit();
          }
        }

        // Check for player-portal collision
        if (bodyA.label?.startsWith('portal_') && bodyB.label === 'player') {
          this.handlePortalEntry(bodyB, bodyA);
        } else if (bodyB.label?.startsWith('portal_') && bodyA.label === 'player') {
          this.handlePortalEntry(bodyA, bodyB);
        }

        // Check for bullet-portal collision (bullets go through portals)
        if (bodyA.label?.startsWith('portal_') && bodyB.label === 'bullet') {
          this.handlePortalEntry(bodyB, bodyA);
        } else if (bodyB.label?.startsWith('portal_') && bodyA.label === 'bullet') {
          this.handlePortalEntry(bodyA, bodyB);
        }
      }
    });
  }

  private handleBulletHit(bulletBody: MatterJS.BodyType, playerBody: MatterJS.BodyType): void {
    const bullet = (bulletBody as any).bulletRef as Bullet;
    const victimId = (playerBody as any).playerId as string;

    if (!bullet || !victimId) return;

    const victim = this.players.get(victimId);
    const shooterId = bullet.getOwnerId();
    const shooter = this.players.get(shooterId);

    // Can't shoot yourself
    if (shooterId === victimId) return;

    // Can't hit dead players
    if (!victim || !victim.isAlive()) return;

    // Can't shoot teammates in team modes
    if (this.gameMode !== 'free_for_all') {
      if (shooter && victim && shooter.getTeam() === victim.getTeam()) {
        return;
      }
    }

    // Check if victim is invulnerable
    if (!victim.isInvulnerable()) {
      // Kill the victim
      victim.die();

      // Credit the shooter
      if (shooter) {
        shooter.addKill();
        this.recordKill(shooterId, victimId);
      }

      // Drop flag if carrying
      const carriedFlag = victim?.getCarriedFlag();
      if (carriedFlag) {
        const flag = this.flags.get(carriedFlag);
        if (flag) {
          const victimPos = victim.getPosition();
          flag.drop(victimPos.x, victimPos.y);
          this.bridge?.getEvents().onFlagReturn(carriedFlag);
        }
      }

      // Notify events
      this.bridge?.getEvents().onPlayerKilled(shooterId, victimId);
    }

    // Destroy bullet
    bullet.onHit();
  }

  private handlePortalEntry(entityBody: MatterJS.BodyType, portalBody: MatterJS.BodyType): void {
    // Get entity ID (either player or bullet)
    const playerId = (entityBody as any).playerId as string | undefined;
    const bulletRef = (entityBody as any).bulletRef;
    const entityId = playerId || (bulletRef ? bulletRef.getId() : null);
    
    if (!entityId) return;

    const portalType = (portalBody as any).portalType as number;
    if (!this.currentMap.portals) return;

    // Check portal cooldown
    const now = Date.now();
    const lastPortalTime = this.portalCooldowns.get(entityId) || 0;
    if (now - lastPortalTime < this.PORTAL_COOLDOWN) {
      return; // Still on cooldown, don't teleport
    }

    const portalDef = this.currentMap.portals.find(p => p.id === portalType);
    if (!portalDef || !portalDef.linkedPortalId) return;

    // Find destination portals of the same type
    const destPortals = this.portalBodies.get(portalDef.linkedPortalId);
    if (!destPortals || destPortals.length === 0) return;

    // Filter out the current portal (teleport to a DIFFERENT portal of same color)
    const currentPortalX = portalBody.position.x;
    const currentPortalY = portalBody.position.y;
    const otherPortals = destPortals.filter(p => {
      const px = p.position.x;
      const py = p.position.y;
      // Exclude if it's the same portal (within small distance)
      return Math.abs(px - currentPortalX) > 10 || Math.abs(py - currentPortalY) > 10;
    });

    // If no other portals of this color, don't teleport
    if (otherPortals.length === 0) return;

    // Pick random destination portal from other portals of same type
    const destPortal = otherPortals[Math.floor(Math.random() * otherPortals.length)];
    const destX = destPortal.position.x;
    const destY = destPortal.position.y;

    // Store current velocity to maintain momentum
    const currentVelocity = { x: entityBody.velocity.x, y: entityBody.velocity.y };

    // Teleport entity
    this.matter.body.setPosition(entityBody, { x: destX, y: destY });
    
    // Maintain velocity (for ball-like physics and bullets)
    this.matter.body.setVelocity(entityBody, currentVelocity);

    // Set cooldown
    this.portalCooldowns.set(entityId, now);
  }

  private recordKill(killerId: string, _victimId: string): void {
    const killer = this.players.get(killerId);
    
    if (this.gameMode === 'free_for_all') {
      // FFA: Individual kills count
      const currentScore = this.scores.ffa.get(killerId) || 0;
      this.scores.ffa.set(killerId, currentScore + 1);
    } else if (this.gameMode === 'team_deathmatch') {
      // TDM: Team kills count
      const team = killer?.getTeam();
      if (team === 'red') {
        this.scores.red++;
      } else if (team === 'blue') {
        this.scores.blue++;
      }
    }
    // CTF: Kills don't count toward score (only flag captures do)

    this.updateScoreDisplay();
    this.checkWinCondition();
  }

  private recordFlagCapture(capturingTeam: Team): void {
    if (capturingTeam === 'red') {
      this.scores.red++;
    } else if (capturingTeam === 'blue') {
      this.scores.blue++;
    }

    this.updateScoreDisplay();
    this.checkWinCondition();
  }

  private updateScoreDisplay(): void {
    let scoreStr = '';

    if (this.gameMode === 'free_for_all') {
      // Show top 3 scores
      const sorted = Array.from(this.scores.ffa.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      
      scoreStr = sorted.map(([id, score]) => {
        const player = this.players.get(id);
        return `${player?.getName() || 'Player'}: ${score}`;
      }).join('  |  ');

      if (scoreStr === '') {
        scoreStr = `First to ${FFA_WIN_SCORE} kills`;
      }
    } else if (this.gameMode === 'team_deathmatch') {
      scoreStr = `🔴 Red: ${this.scores.red}  |  🔵 Blue: ${this.scores.blue}  (First to ${TDM_WIN_SCORE})`;
    } else if (this.gameMode === 'capture_the_flag') {
      scoreStr = `🔴 Red: ${this.scores.red}  |  🔵 Blue: ${this.scores.blue}  (First to ${CTF_WIN_SCORE})`;
    }

    this.scoreText.setText(scoreStr);
  }

  private checkWinCondition(): void {
    let winnerId: string | null = null;
    let winningTeam: Team | null = null;

    if (this.gameMode === 'free_for_all') {
      for (const [playerId, score] of this.scores.ffa) {
        if (score >= FFA_WIN_SCORE) {
          winnerId = playerId;
          break;
        }
      }
    } else if (this.gameMode === 'team_deathmatch') {
      if (this.scores.red >= TDM_WIN_SCORE) {
        winningTeam = 'red';
      } else if (this.scores.blue >= TDM_WIN_SCORE) {
        winningTeam = 'blue';
      }
    } else if (this.gameMode === 'capture_the_flag') {
      if (this.scores.red >= CTF_WIN_SCORE) {
        winningTeam = 'red';
      } else if (this.scores.blue >= CTF_WIN_SCORE) {
        winningTeam = 'blue';
      }
    }

    if (winnerId || winningTeam) {
      this.endRound(winnerId, winningTeam);
    }
  }

  private startCountdown(): void {
    this.bridge?.setPhase('countdown');
    this.countdownText.setVisible(true);

    let countdown = 3;
    this.countdownText.setText(countdown.toString());

    const timer = this.time.addEvent({
      delay: 1000,
      callback: () => {
        countdown--;
        if (countdown > 0) {
          this.countdownText.setText(countdown.toString());
        } else if (countdown === 0) {
          this.countdownText.setText('GO!');
        } else {
          this.countdownText.setVisible(false);
          this.startRound();
          timer.destroy();
        }
      },
      loop: true,
    });
  }

  private startRound(): void {
    this.isRoundActive = true;
    this.bridge?.setPhase('playing');
  }

  private endRound(winnerId: string | null, winningTeam: Team | null): void {
    this.isRoundActive = false;
    this.bridge?.setPhase('round_end');

    // Show winner
    let winText = '';
    if (winnerId) {
      const winner = this.players.get(winnerId);
      winText = `🏆 ${winner?.getName() || 'Player'} WINS! 🏆`;
    } else if (winningTeam) {
      const teamEmoji = winningTeam === 'red' ? '🔴' : '🔵';
      winText = `${teamEmoji} ${winningTeam.toUpperCase()} TEAM WINS! ${teamEmoji}`;
    }

    this.winnerText.setText(winText);
    this.winnerText.setVisible(true);

    // Notify bridge
    this.bridge?.getEvents().onGameOver(winnerId, winningTeam);

    // Return to mode select after delay
    this.time.delayedCall(ROUND_END_DELAY, () => {
      this.bridge?.returnToModeSelect();
    });
  }

  addPlayer(playerId: string, name: string, color: number, team: Team): void {
    if (this.players.has(playerId)) return;

    // Get spawn point
    const spawnPos = this.getSpawnPosition(team, playerId);

    // Create player entity
    const player = new Player(this, playerId, name, color, team, spawnPos.x, spawnPos.y);
    this.players.set(playerId, player);

    // Initialize score for FFA
    if (this.gameMode === 'free_for_all') {
      this.scores.ffa.set(playerId, 0);
    }

    // Create carried flag graphics
    this.carriedFlagGraphics.set(playerId, this.add.graphics().setDepth(15));
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      // Drop flag if carrying
      const carriedFlag = player.getCarriedFlag();
      if (carriedFlag) {
        const flag = this.flags.get(carriedFlag);
        if (flag) {
          flag.returnToBase();
        }
      }

      player.destroy();
      this.players.delete(playerId);
    }

    // Remove score
    this.scores.ffa.delete(playerId);

    // Remove flag graphics
    const flagGraphics = this.carriedFlagGraphics.get(playerId);
    if (flagGraphics) {
      flagGraphics.destroy();
      this.carriedFlagGraphics.delete(playerId);
    }
  }

  private getSpawnPosition(team: Team, playerId: string): Position {
    const spawnPoints = team === 'red' ? this.currentMap.spawnPoints.red :
                        team === 'blue' ? this.currentMap.spawnPoints.blue :
                        this.currentMap.spawnPoints.ffa;

    // Get positions of allies and enemies
    const allies: Position[] = [];
    const enemies: Position[] = [];

    for (const [id, player] of this.players) {
      if (id === playerId) continue;
      
      const pos = player.getPosition();
      if (player.getTeam() === team) {
        allies.push(pos);
      } else {
        enemies.push(pos);
      }
    }

    return findBestSpawnPoint(
      spawnPoints,
      allies,
      enemies,
      this.effectiveCellSize,
      this.mapOffset.x,
      this.mapOffset.y
    );
  }

  update(time: number, delta: number): void {
    // Render portals with animation (use scaled map)
    this.portalGraphics.clear();
    const scaledMap = { ...this.currentMap, cellSize: this.effectiveCellSize };
    renderPortals(this.portalGraphics, scaledMap, this.mapOffset.x, this.mapOffset.y, time);

    // Update bullets
    this.bulletPool.update(time, delta);

    // Update flags
    for (const flag of this.flags.values()) {
      flag.update(time, delta);
    }

    // Update players
    for (const [playerId, player] of this.players) {
      const input = this.bridge?.getPlayerInput(playerId);
      player.update(time, delta, input);

      // Handle respawning
      if (player.isReadyToRespawn()) {
        const spawnPos = this.getSpawnPosition(player.getTeam(), playerId);
        player.respawn(spawnPos.x, spawnPos.y);
        this.bridge?.getEvents().onPlayerRespawn(playerId);
      }

      // Handle shooting (only during active round)
      if (this.isRoundActive && player.isAlive() && input?.aim) {
        const aimMagnitude = Math.sqrt(input.aim.x ** 2 + input.aim.y ** 2);
        
        if (aimMagnitude > 0.3 && player.canFire(time)) {
          // Fire bullet
          const gunTip = player.getGunTipPosition();
          const angle = player.getAimAngle();
          
          this.bulletPool.create(
            playerId,
            player.getTeam(),
            gunTip.x,
            gunTip.y,
            angle,
            player.getColor()
          );

          player.recordFire(time);
        }
      }

      // Handle flag pickup and capture
      if (this.gameMode === 'capture_the_flag' && player.isAlive()) {
        this.handleFlagInteraction(player);
      }

      // Update carried flag visual
      this.updateCarriedFlagGraphics(playerId, player);
    }

    // Update score display periodically
    if (Math.floor(time / 1000) !== Math.floor((time - delta) / 1000)) {
      this.updateScoreDisplay();
    }
  }

  private handleFlagInteraction(player: Player): void {
    const playerPos = player.getPosition();
    const playerTeam = player.getTeam();
    const carriedFlag = player.getCarriedFlag();

    // Check for flag capture
    if (carriedFlag) {
      const ownFlag = this.flags.get(playerTeam);
      if (ownFlag && ownFlag.isAtBase() && ownFlag.isInCaptureRange(playerPos.x, playerPos.y)) {
        // Capture the flag!
        const capturedFlag = this.flags.get(carriedFlag);
        if (capturedFlag) {
          capturedFlag.returnToBase();
          player.dropFlag();
          this.recordFlagCapture(playerTeam);
          this.bridge?.getEvents().onFlagCapture(player.getPlayerId(), carriedFlag);
        }
      }
    }

    // Check for flag pickup
    if (!carriedFlag) {
      for (const [team, flag] of this.flags) {
        // Can only pick up enemy flag
        if (team !== playerTeam && flag.isInPickupRange(playerPos.x, playerPos.y)) {
          flag.pickUp(player.getPlayerId());
          player.pickUpFlag(team);
          this.bridge?.getEvents().onFlagPickup(player.getPlayerId(), team);
          break;
        }
      }
    }

    // Check for flag return (touch own flag when it's not at base)
    const ownFlag = this.flags.get(playerTeam);
    if (ownFlag && !ownFlag.isAtBase() && !ownFlag.getCarrierId() &&
        ownFlag.isInPickupRange(playerPos.x, playerPos.y)) {
      ownFlag.returnToBase();
      this.bridge?.getEvents().onFlagReturn(playerTeam);
    }
  }

  private updateCarriedFlagGraphics(playerId: string, player: Player): void {
    const graphics = this.carriedFlagGraphics.get(playerId);
    if (!graphics) return;

    graphics.clear();

    const carriedFlag = player.getCarriedFlag();
    if (!carriedFlag || !player.isAlive()) return;

    const pos = player.getPosition();
    const color = carriedFlag === 'red' ? 0xff4444 : 0x4488ff;
    const offsetX = 15;
    const offsetY = -20;

    // Draw small flag indicator
    graphics.fillStyle(0x8b4513, 1);
    graphics.fillRect(pos.x + offsetX - 1, pos.y + offsetY - 15, 2, 15);

    graphics.fillStyle(color, 1);
    graphics.fillTriangle(
      pos.x + offsetX + 1, pos.y + offsetY - 15,
      pos.x + offsetX + 12, pos.y + offsetY - 10,
      pos.x + offsetX + 1, pos.y + offsetY - 5
    );
  }
}

