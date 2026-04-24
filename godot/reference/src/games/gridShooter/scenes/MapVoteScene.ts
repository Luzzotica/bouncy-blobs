// Map Vote Scene - Walk-to-vote map selection

import Phaser from 'phaser';
import { PhaserGameBridge } from '../PhaserGame';
import { GridMapDefinition, GameMode, MAP_VOTE_DURATION, Team } from '../types';
import { getRandomMapsForVoting, getMapsForGameMode } from '../maps/MapDefinitions';
import { renderMapPreview } from '../utils/gridUtils';

interface MapZone {
  map: GridMapDefinition;
  x: number;
  y: number;
  radius: number;
  graphics: Phaser.GameObjects.Graphics;
  previewGraphics: Phaser.GameObjects.Graphics;
  text: Phaser.GameObjects.Text;
  descText: Phaser.GameObjects.Text;
  voterCount: number;
}

interface VotePlayer {
  playerId: string;
  name: string;
  color: number;
  team: Team;
  sprite: Phaser.GameObjects.Arc;
  nameText: Phaser.GameObjects.Text;
  x: number;
  y: number;
}

interface MapVoteSceneData {
  playerData?: Array<{ playerId: string; name: string; color: number; team: Team }>;
  gameMode?: GameMode;
}

export class MapVoteScene extends Phaser.Scene {
  private bridge!: PhaserGameBridge;
  private mapZones: MapZone[] = [];
  private players: Map<string, VotePlayer> = new Map();
  private voteTimer: number = MAP_VOTE_DURATION;
  private timerText!: Phaser.GameObjects.Text;
  private isVotingActive: boolean = false;
  private countdownEvent?: Phaser.Time.TimerEvent;
  private pendingPlayerData: Array<{ playerId: string; name: string; color: number; team: Team }> = [];
  private gameMode: GameMode = 'free_for_all';

  constructor() {
    super({ key: 'MapVoteScene' });
  }

  init(data?: MapVoteSceneData): void {
    // Get bridge from game registry
    this.bridge = this.game.registry.get('bridge') as PhaserGameBridge;
    
    // Reset state
    this.mapZones = [];
    this.players = new Map();
    this.voteTimer = MAP_VOTE_DURATION;
    this.isVotingActive = false;
    
    // Store data
    this.pendingPlayerData = data?.playerData || [];
    this.gameMode = data?.gameMode || this.bridge?.getGameMode() || 'free_for_all';
  }

  create(): void {
    const { width, height } = this.scale;

    // Background
    this.cameras.main.setBackgroundColor('#1a1a2e');

    // Title
    this.add.text(width / 2, 40, 'CHOOSE YOUR MAP', {
      fontSize: '32px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
    }).setOrigin(0.5);

    // Game mode indicator
    const modeLabels: Record<GameMode, string> = {
      'free_for_all': '⚔️ Free For All',
      'team_deathmatch': '👥 Team Deathmatch',
      'capture_the_flag': '🚩 Capture The Flag',
    };
    this.add.text(width / 2, 75, modeLabels[this.gameMode], {
      fontSize: '18px',
      fontFamily: 'Arial',
      color: '#f59e0b',
    }).setOrigin(0.5);

    // Subtitle
    this.add.text(width / 2, 105, 'Walk to your preferred map to vote!', {
      fontSize: '16px',
      fontFamily: 'Arial',
      color: '#888888',
    }).setOrigin(0.5);

    // Timer
    this.timerText = this.add.text(width / 2, height - 40, '', {
      fontSize: '32px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
    }).setOrigin(0.5);

    // Create map vote zones
    this.createMapZones();

    // Add pending players
    for (const playerData of this.pendingPlayerData) {
      this.addPlayer(playerData.playerId, playerData.name, playerData.color, playerData.team);
    }
    this.pendingPlayerData = [];

    // Set phase
    if (this.bridge) {
      this.bridge.setPhase('map_vote');
    }

    // Start voting immediately
    this.startVoting();
  }

  private createMapZones(): void {
    const { width, height } = this.scale;
    
    // Get maps suitable for the game mode
    getMapsForGameMode(this.gameMode);
    const selectedMaps = getRandomMapsForVoting(3);
    
    // 3x larger zones for better visibility
    const zoneRadius = 180;
    const spacing = width / 4;
    const centerY = height / 2 + 20; // Slightly lower to make room for title

    selectedMaps.forEach((map, index) => {
      const x = spacing * (index + 1);
      const y = centerY;

      // Zone graphics
      const graphics = this.add.graphics();
      this.drawMapZone(graphics, x, y, zoneRadius, map.theme.wallColor, false);

      // Preview graphics - render map preview larger
      const previewGraphics = this.add.graphics();
      renderMapPreview(previewGraphics, map, x, y - 20, zoneRadius * 1.1);

      // Map name - larger font
      const text = this.add.text(x, y + zoneRadius + 30, map.name.toUpperCase(), {
        fontSize: '24px',
        fontFamily: 'Arial Black',
        color: '#ffffff',
      }).setOrigin(0.5);

      // Description - larger font
      const descText = this.add.text(x, y + zoneRadius + 60, map.description, {
        fontSize: '16px',
        fontFamily: 'Arial',
        color: '#aaaaaa',
        align: 'center',
        wordWrap: { width: 200 },
      }).setOrigin(0.5);

      this.mapZones.push({
        map,
        x,
        y,
        radius: zoneRadius,
        graphics,
        previewGraphics,
        text,
        descText,
        voterCount: 0,
      });
    });
  }

  private drawMapZone(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    radius: number,
    color: number,
    isHighlighted: boolean
  ): void {
    graphics.clear();

    // Outer glow
    if (isHighlighted) {
      graphics.fillStyle(color, 0.3);
      graphics.fillCircle(x, y, radius + 10);
    }

    // Border
    graphics.lineStyle(3, color, isHighlighted ? 1 : 0.5);
    graphics.strokeCircle(x, y, radius);
  }

  addPlayer(playerId: string, name: string, color: number, team: Team): void {
    if (this.players.has(playerId)) return;

    const { width, height } = this.scale;
    
    // Random starting position
    const x = width / 2 + (Math.random() - 0.5) * 100;
    const y = height - 100;

    const sprite = this.add.circle(x, y, 12, color);
    sprite.setStrokeStyle(2, 0xffffff);
    sprite.setDepth(10);

    const nameText = this.add.text(x, y + 20, name, {
      fontSize: '10px',
      fontFamily: 'Arial',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(11);

    this.players.set(playerId, {
      playerId,
      name,
      color,
      team,
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

  private startVoting(): void {
    if (this.isVotingActive) return;
    
    this.isVotingActive = true;
    this.voteTimer = MAP_VOTE_DURATION;

    // Start countdown
    this.countdownEvent = this.time.addEvent({
      delay: 100,
      callback: () => {
        this.voteTimer -= 100;
        const seconds = Math.ceil(this.voteTimer / 1000);
        this.timerText.setText(`Starting in: ${seconds}`);

        if (this.voteTimer <= 0) {
          this.endVoting();
        }
      },
      loop: true,
    });
  }

  private endVoting(): void {
    if (this.countdownEvent) {
      this.countdownEvent.destroy();
      this.countdownEvent = undefined;
    }

    // Count votes for each map
    let maxVotes = 0;
    let winners: GridMapDefinition[] = [];
    
    for (const zone of this.mapZones) {
      if (zone.voterCount > maxVotes) {
        maxVotes = zone.voterCount;
        winners = [zone.map];
      } else if (zone.voterCount === maxVotes && zone.voterCount > 0) {
        winners.push(zone.map);
      }
    }

    // If no votes, pick random
    if (winners.length === 0) {
      winners = this.mapZones.map(z => z.map);
    }

    // Pick random from winners
    const selectedMap = winners[Math.floor(Math.random() * winners.length)];

    // Highlight winning zone
    const winningZone = this.mapZones.find(z => z.map.id === selectedMap.id);
    if (winningZone) {
      this.drawMapZone(
        winningZone.graphics,
        winningZone.x,
        winningZone.y,
        winningZone.radius,
        0x00ff00,
        true
      );
      
      // Show selection text
      this.add.text(winningZone.x, winningZone.y - winningZone.radius - 20, 'SELECTED!', {
        fontSize: '20px',
        fontFamily: 'Arial Black',
        color: '#00ff00',
      }).setOrigin(0.5);
    }

    this.timerText.setText('Loading map...');

    // Transition after delay
    this.time.delayedCall(2000, () => {
      if (this.bridge) {
        this.bridge.startMap(selectedMap);
      }
    });
  }

  update(_time: number, _delta: number): void {
    if (!this.isVotingActive) return;

    // Reset zone voter counts
    for (const zone of this.mapZones) {
      zone.voterCount = 0;
    }

    // Update player positions based on input
    for (const [playerId, player] of this.players) {
      const input = this.bridge?.getPlayerInput(playerId);
      
      if (input && input.movement) {
        // Move player based on joystick input
        const speed = 2;
        player.x += input.movement.x * speed;
        player.y += -input.movement.y * speed; // Inverted Y axis

        // Clamp to screen bounds
        const { width, height } = this.scale;
        player.x = Math.max(20, Math.min(width - 20, player.x));
        player.y = Math.max(130, Math.min(height - 60, player.y));
      }

      // Update sprite position
      player.sprite.setPosition(player.x, player.y);
      player.nameText.setPosition(player.x, player.y + 20);

      // Check which zone player is in
      for (const zone of this.mapZones) {
        const dist = Math.sqrt(
          Math.pow(player.x - zone.x, 2) + Math.pow(player.y - zone.y, 2)
        );
        if (dist <= zone.radius) {
          zone.voterCount++;
        }
      }
    }

    // Update zone visuals based on voter count
    for (const zone of this.mapZones) {
      const hasVoters = zone.voterCount > 0;
      this.drawMapZone(
        zone.graphics,
        zone.x,
        zone.y,
        zone.radius,
        zone.map.theme.wallColor,
        hasVoters
      );
    }
  }
}

