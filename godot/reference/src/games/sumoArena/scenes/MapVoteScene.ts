// Map Vote Scene - Walk-to-vote map selection

import Phaser from 'phaser';
import { PhaserGameBridge } from '../PhaserGame';
import { MapDefinition, MAP_VOTE_DURATION } from '../types';
import { getAllMaps } from '../maps/MapDefinitions';

interface VoteZone {
  map: MapDefinition;
  x: number;
  y: number;
  radius: number;
  graphics: Phaser.GameObjects.Graphics;
  text: Phaser.GameObjects.Text;
  voterCount: number;
  previewGraphics: Phaser.GameObjects.Graphics;
}

interface VotePlayer {
  playerId: string;
  name: string;
  color: number;
  sprite: Phaser.GameObjects.Arc;
  nameText: Phaser.GameObjects.Text;
  x: number;
  y: number;
}

interface MapVoteSceneData {
  playerData?: Array<{ playerId: string; name: string; color: number }>;
}

export class MapVoteScene extends Phaser.Scene {
  private bridge!: PhaserGameBridge;
  private voteZones: VoteZone[] = [];
  private players: Map<string, VotePlayer> = new Map();
  private voteTimer: number = MAP_VOTE_DURATION;
  private timerText!: Phaser.GameObjects.Text;
  private titleText!: Phaser.GameObjects.Text;
  private subtitleText!: Phaser.GameObjects.Text;
  private waitingText!: Phaser.GameObjects.Text;
  private isVotingActive: boolean = false;
  private isWaitingForPlayers: boolean = true;
  private countdownEvent?: Phaser.Time.TimerEvent;
  private readonly MIN_PLAYERS = 2;
  private pendingPlayerData: Array<{ playerId: string; name: string; color: number }> = [];

  constructor() {
    super({ key: 'MapVoteScene' });
  }

  setBridge(bridge: PhaserGameBridge): void {
    this.bridge = bridge;
  }

  init(data?: MapVoteSceneData): void {
    // Get bridge from game registry (set in preBoot callback)
    this.bridge = this.game.registry.get('bridge') as PhaserGameBridge;
    
    // Reset state for scene restart
    this.voteZones = [];
    this.players = new Map();
    this.voteTimer = MAP_VOTE_DURATION;
    this.isVotingActive = false;
    this.isWaitingForPlayers = true;
    
    // Store player data to add after create
    this.pendingPlayerData = data?.playerData || [];
  }

  create(): void {
    const { width, height } = this.scale;

    // Background
    this.cameras.main.setBackgroundColor('#1a1a2e');

    // Title
    this.titleText = this.add.text(width / 2, 40, 'CHOOSE YOUR ARENA', {
      fontSize: '32px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
    }).setOrigin(0.5);

    // Subtitle
    this.subtitleText = this.add.text(width / 2, 80, 'Walk to your preferred map to vote!', {
      fontSize: '16px',
      fontFamily: 'Arial',
      color: '#888888',
    }).setOrigin(0.5);

    // Waiting for players text
    this.waitingText = this.add.text(width / 2, height / 2 + 200, `Waiting for ${this.MIN_PLAYERS} players to join...`, {
      fontSize: '24px',
      fontFamily: 'Arial',
      color: '#f59e0b',
    }).setOrigin(0.5);

    // Timer - hidden initially
    this.timerText = this.add.text(width / 2, height - 40, '', {
      fontSize: '48px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
    }).setOrigin(0.5);
    this.timerText.setVisible(false);

    // Create vote zones for available maps
    this.createVoteZones();

    // Add any pending players from scene data (e.g., returning from arena)
    for (const playerData of this.pendingPlayerData) {
      this.addPlayer(playerData.playerId, playerData.name, playerData.color);
    }
    this.pendingPlayerData = [];

    // Set phase to map_vote
    if (this.bridge) {
      this.bridge.setPhase('map_vote');
    }
    
    // Don't auto-start voting - wait for enough players
  }

  private createVoteZones(): void {
    const { width, height } = this.scale;
    const maps = getAllMaps();
    
    // Select 3 random maps for voting (fewer to avoid overlap)
    const shuffled = [...maps].sort(() => Math.random() - 0.5);
    const selectedMaps = shuffled.slice(0, Math.min(3, maps.length));

    // Smaller zones and proper spacing to avoid overlap
    const zoneRadius = 60;
    const totalZoneWidth = selectedMaps.length * zoneRadius * 2.5;
    const startX = (width - totalZoneWidth) / 2 + zoneRadius * 1.25;
    const spacing = totalZoneWidth / selectedMaps.length;
    const yPosition = height / 2 - 20;

    selectedMaps.forEach((map, index) => {
      const x = startX + spacing * index;
      const y = yPosition;

      // Create zone graphics
      const graphics = this.add.graphics();
      this.drawVoteZone(graphics, x, y, zoneRadius, map.theme.floorColor, false);

      // Create preview of the map
      const previewGraphics = this.add.graphics();
      this.drawMapPreview(previewGraphics, x, y, map);

      // Map name
      const text = this.add.text(x, y + zoneRadius + 20, map.name, {
        fontSize: '18px',
        fontFamily: 'Arial',
        color: '#ffffff',
        align: 'center',
      }).setOrigin(0.5);

      // Category badge
      const categoryColors: Record<string, number> = {
        'shrinking': 0x3b82f6,
        'hazard': 0xef4444,
        'ice': 0x06b6d4,
        'special': 0x8b5cf6,
      };
      
      const badgeColor = categoryColors[map.category] || 0x888888;
      this.add.rectangle(x, y + zoneRadius + 50, 80, 20, badgeColor, 0.8)
        .setOrigin(0.5);
      this.add.text(x, y + zoneRadius + 50, map.category.toUpperCase(), {
        fontSize: '10px',
        fontFamily: 'Arial',
        color: '#ffffff',
      }).setOrigin(0.5);

      // Difficulty stars
      const starY = y + zoneRadius + 75;
      for (let i = 0; i < 3; i++) {
        const starX = x - 20 + i * 20;
        const filled = i < map.difficulty;
        this.add.text(starX, starY, '★', {
          fontSize: '14px',
          color: filled ? '#fbbf24' : '#444444',
        }).setOrigin(0.5);
      }

      this.voteZones.push({
        map,
        x,
        y,
        radius: zoneRadius,
        graphics,
        text,
        voterCount: 0,
        previewGraphics,
      });
    });
  }

  private drawVoteZone(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    radius: number,
    color: number,
    highlighted: boolean
  ): void {
    graphics.clear();
    
    // Outer glow when highlighted
    if (highlighted) {
      graphics.fillStyle(color, 0.3);
      graphics.fillCircle(x, y, radius + 10);
    }
    
    // Main circle
    graphics.fillStyle(color, 0.6);
    graphics.fillCircle(x, y, radius);
    
    // Border
    graphics.lineStyle(3, highlighted ? 0xffffff : 0x888888, 1);
    graphics.strokeCircle(x, y, radius);
  }

  private drawMapPreview(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    map: MapDefinition
  ): void {
    const scale = 0.15; // Scale down the arena preview
    const previewRadius = map.arena.initialRadius * scale;

    // Draw mini arena
    graphics.fillStyle(map.theme.edgeColor, 0.5);
    graphics.fillCircle(x, y, previewRadius + 2);
    
    graphics.fillStyle(map.theme.floorColor, 0.8);
    graphics.fillCircle(x, y, previewRadius);

    // Draw hazard indicators
    if (map.hazards && map.hazards.length > 0) {
      graphics.fillStyle(0xff0000, 0.8);
      map.hazards.slice(0, 3).forEach((_, i) => {
        const angle = (i / 3) * Math.PI * 2;
        const hx = x + Math.cos(angle) * previewRadius * 0.5;
        const hy = y + Math.sin(angle) * previewRadius * 0.5;
        graphics.fillTriangle(
          hx, hy - 5,
          hx - 4, hy + 3,
          hx + 4, hy + 3
        );
      });
    }

    // Draw zone indicators
    if (map.zones && map.zones.length > 0) {
      map.zones.slice(0, 2).forEach((zone, i) => {
        const zoneColors: Record<string, number> = {
          'ice': 0x06b6d4,
          'bounce': 0xf59e0b,
          'conveyor': 0x10b981,
          'portal': 0x8b5cf6,
          'gravity': 0x6366f1,
        };
        const color = zoneColors[zone.type] || 0x888888;
        const angle = (i / 2) * Math.PI + Math.PI / 4;
        const zx = x + Math.cos(angle) * previewRadius * 0.6;
        const zy = y + Math.sin(angle) * previewRadius * 0.6;
        
        graphics.fillStyle(color, 0.6);
        graphics.fillCircle(zx, zy, 8);
      });
    }

    // Donut shape special case
    if (map.arena.shape === 'donut') {
      graphics.fillStyle(0x1a1a2e, 1);
      graphics.fillCircle(x, y, previewRadius * 0.3);
    }
  }

  private startVoting(): void {
    if (this.isVotingActive) return;
    
    this.isVotingActive = true;
    this.isWaitingForPlayers = false;
    this.voteTimer = MAP_VOTE_DURATION;

    // Hide waiting text, show timer
    this.waitingText.setVisible(false);
    this.timerText.setVisible(true);
    this.timerText.setText(`${Math.ceil(this.voteTimer / 1000)}`);
    this.subtitleText.setText('Stand on a map to vote!');

    // Countdown timer
    this.countdownEvent = this.time.addEvent({
      delay: 1000,
      callback: () => {
        this.voteTimer -= 1000;
        this.timerText.setText(`${Math.ceil(this.voteTimer / 1000)}`);

        if (this.voteTimer <= 0) {
          this.endVoting();
        }
      },
      repeat: Math.ceil(MAP_VOTE_DURATION / 1000) - 1,
    });
  }

  private checkVotingConditions(): void {
    // Don't check if already voting
    if (this.isVotingActive) return;

    // Need at least MIN_PLAYERS
    if (this.players.size < this.MIN_PLAYERS) {
      this.waitingText.setText(`Waiting for ${this.MIN_PLAYERS - this.players.size} more player(s)...`);
      this.waitingText.setVisible(true);
      return;
    }

    // Check if any player is standing on a map
    let anyPlayerOnMap = false;
    for (const player of this.players.values()) {
      for (const zone of this.voteZones) {
        const dx = player.x - zone.x;
        const dy = player.y - zone.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < zone.radius) {
          anyPlayerOnMap = true;
          break;
        }
      }
      if (anyPlayerOnMap) break;
    }

    if (!anyPlayerOnMap) {
      this.waitingText.setText('Walk onto a map to start voting!');
      this.waitingText.setVisible(true);
      return;
    }

    // All conditions met - start voting!
    this.startVoting();
  }

  private endVoting(): void {
    this.isVotingActive = false;
    if (this.countdownEvent) {
      this.countdownEvent.destroy();
    }

    // Count votes in each zone
    this.updateVoteCounts();

    // Check if anyone voted
    const totalVotes = this.voteZones.reduce((sum, zone) => sum + zone.voterCount, 0);
    if (totalVotes === 0) {
      // No one voted - pick random map
      const randomIndex = Math.floor(Math.random() * this.voteZones.length);
      this.voteZones[randomIndex].voterCount = 1;
    }

    // Find winning map
    let winningZone = this.voteZones[0];
    for (const zone of this.voteZones) {
      if (zone.voterCount > winningZone.voterCount) {
        winningZone = zone;
      }
    }

    // Handle ties by random selection
    const tiedZones = this.voteZones.filter(z => z.voterCount === winningZone.voterCount);
    if (tiedZones.length > 1) {
      winningZone = tiedZones[Math.floor(Math.random() * tiedZones.length)];
    }

    // Highlight winner
    this.drawVoteZone(
      winningZone.graphics,
      winningZone.x,
      winningZone.y,
      winningZone.radius,
      winningZone.map.theme.floorColor,
      true
    );

    // Show selection text
    this.titleText.setText(`SELECTED: ${winningZone.map.name.toUpperCase()}`);
    this.subtitleText.setText('Get ready!');

    // Start the selected map after short delay
    this.time.delayedCall(2000, () => {
      // Pass player data to arena scene
      const playerData = Array.from(this.players.values()).map(p => ({
        playerId: p.playerId,
        name: p.name,
        color: p.color,
      }));
      this.bridge.startMap(winningZone.map, playerData);
    });
  }

  private updateVoteCounts(): void {
    // Reset counts
    for (const zone of this.voteZones) {
      zone.voterCount = 0;
    }

    // Count players in each zone
    for (const player of this.players.values()) {
      for (const zone of this.voteZones) {
        const dx = player.x - zone.x;
        const dy = player.y - zone.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < zone.radius) {
          zone.voterCount++;
          break;
        }
      }
    }

    // Update zone visuals based on votes
    for (const zone of this.voteZones) {
      const hasVotes = zone.voterCount > 0;
      this.drawVoteZone(
        zone.graphics,
        zone.x,
        zone.y,
        zone.radius,
        zone.map.theme.floorColor,
        hasVotes
      );
    }
  }

  update(_time: number, _delta: number): void {
    if (!this.bridge) return;

    // Update player positions based on input
    for (const [playerId, player] of this.players) {
      const input = this.bridge.getPlayerInput(playerId);
      if (input) {
        const speed = 3;
        player.x += input.joystick.x * speed;
        player.y -= input.joystick.y * speed;

        // Keep within bounds
        const { width, height } = this.scale;
        player.x = Math.max(20, Math.min(width - 20, player.x));
        player.y = Math.max(100, Math.min(height - 100, player.y));

        // Update sprite position
        player.sprite.setPosition(player.x, player.y);
        player.nameText.setPosition(player.x, player.y + 25);
      }
    }

    // Update vote counts every frame (for visual feedback)
    this.updateVoteCounts();

    // Check if we can start voting (when waiting for players)
    if (this.isWaitingForPlayers) {
      this.checkVotingConditions();
    }
  }

  addPlayer(playerId: string, name: string, color: number): void {
    if (this.players.has(playerId)) return;

    const { width, height } = this.scale;
    const x = width / 2 + (Math.random() - 0.5) * 100;
    const y = height / 2 + 150;

    const sprite = this.add.circle(x, y, 15, color);
    sprite.setStrokeStyle(2, 0xffffff);

    const nameText = this.add.text(x, y + 25, name, {
      fontSize: '12px',
      fontFamily: 'Arial',
      color: '#ffffff',
    }).setOrigin(0.5);

    this.players.set(playerId, {
      playerId,
      name,
      color,
      sprite,
      nameText,
      x,
      y,
    });
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      player.sprite.destroy();
      player.nameText.destroy();
      this.players.delete(playerId);
    }
  }
}

