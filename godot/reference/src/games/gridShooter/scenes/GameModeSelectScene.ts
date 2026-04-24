// Game Mode Select Scene - Walk-to-vote game mode selection

import Phaser from 'phaser';
import { PhaserGameBridge } from '../PhaserGame';
import { GameMode, MODE_VOTE_DURATION, Team } from '../types';

interface ModeZone {
  mode: GameMode;
  label: string;
  description: string;
  icon: string;
  color: number;
  x: number;
  y: number;
  radius: number;
  graphics: Phaser.GameObjects.Graphics;
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

interface GameModeSelectSceneData {
  playerData?: Array<{ playerId: string; name: string; color: number; team: Team }>;
}

export class GameModeSelectScene extends Phaser.Scene {
  private bridge!: PhaserGameBridge;
  private modeZones: ModeZone[] = [];
  private players: Map<string, VotePlayer> = new Map();
  private voteTimer: number = MODE_VOTE_DURATION;
  private timerText!: Phaser.GameObjects.Text;
  private waitingText!: Phaser.GameObjects.Text;
  private isVotingActive: boolean = false;
  private isWaitingForPlayers: boolean = true;
  private countdownEvent?: Phaser.Time.TimerEvent;
  private readonly MIN_PLAYERS = 2;
  private pendingPlayerData: Array<{ playerId: string; name: string; color: number; team: Team }> = [];

  constructor() {
    super({ key: 'GameModeSelectScene' });
  }

  init(data?: GameModeSelectSceneData): void {
    // Get bridge from game registry
    this.bridge = this.game.registry.get('bridge') as PhaserGameBridge;
    
    // Reset state
    this.modeZones = [];
    this.players = new Map();
    this.voteTimer = MODE_VOTE_DURATION;
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
    this.add.text(width / 2, 50, 'SELECT GAME MODE', {
      fontSize: '36px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
    }).setOrigin(0.5);

    // Subtitle
    this.add.text(width / 2, 90, 'Walk to your preferred mode to vote!', {
      fontSize: '18px',
      fontFamily: 'Arial',
      color: '#888888',
    }).setOrigin(0.5);

    // Waiting for players text
    this.waitingText = this.add.text(width / 2, height - 80, `Waiting for ${this.MIN_PLAYERS} players to join...`, {
      fontSize: '24px',
      fontFamily: 'Arial',
      color: '#f59e0b',
    }).setOrigin(0.5);

    // Timer (hidden initially)
    this.timerText = this.add.text(width / 2, height - 40, '', {
      fontSize: '32px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
    }).setOrigin(0.5);
    this.timerText.setVisible(false);

    // Create mode zones
    this.createModeZones();

    // Add pending players
    for (const playerData of this.pendingPlayerData) {
      this.addPlayer(playerData.playerId, playerData.name, playerData.color, playerData.team);
    }
    this.pendingPlayerData = [];

    // Set phase
    if (this.bridge) {
      this.bridge.setPhase('mode_select');
    }
  }

  private createModeZones(): void {
    const { width, height } = this.scale;
    const centerY = height / 2;
    const zoneRadius = 80;
    const spacing = width / 4;

    const modes: Array<{
      mode: GameMode;
      label: string;
      description: string;
      icon: string;
      color: number;
    }> = [
      {
        mode: 'free_for_all',
        label: 'FREE FOR ALL',
        description: 'Every player for themselves!\nFirst to 25 kills wins.',
        icon: '⚔️',
        color: 0xf59e0b,
      },
      {
        mode: 'team_deathmatch',
        label: 'TEAM DEATHMATCH',
        description: 'Red vs Blue!\nFirst team to 25 kills wins.',
        icon: '👥',
        color: 0x8b5cf6,
      },
      {
        mode: 'capture_the_flag',
        label: 'CAPTURE THE FLAG',
        description: 'Steal the enemy flag!\nFirst to 3 captures wins.',
        icon: '🚩',
        color: 0x10b981,
      },
    ];

    modes.forEach((modeInfo, index) => {
      const x = spacing * (index + 1);
      const y = centerY;

      // Zone graphics
      const graphics = this.add.graphics();
      this.drawModeZone(graphics, x, y, zoneRadius, modeInfo.color, false);

      // Icon
      this.add.text(x, y - 20, modeInfo.icon, {
        fontSize: '40px',
      }).setOrigin(0.5);

      // Label
      const text = this.add.text(x, y + 30, modeInfo.label, {
        fontSize: '16px',
        fontFamily: 'Arial Black',
        color: '#ffffff',
      }).setOrigin(0.5);

      // Description
      const descText = this.add.text(x, y + zoneRadius + 40, modeInfo.description, {
        fontSize: '12px',
        fontFamily: 'Arial',
        color: '#aaaaaa',
        align: 'center',
      }).setOrigin(0.5);

      this.modeZones.push({
        mode: modeInfo.mode,
        label: modeInfo.label,
        description: modeInfo.description,
        icon: modeInfo.icon,
        color: modeInfo.color,
        x,
        y,
        radius: zoneRadius,
        graphics,
        text,
        descText,
        voterCount: 0,
      });
    });
  }

  private drawModeZone(
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

    // Main circle
    graphics.fillStyle(color, 0.2);
    graphics.fillCircle(x, y, radius);

    // Border
    graphics.lineStyle(3, color, isHighlighted ? 1 : 0.6);
    graphics.strokeCircle(x, y, radius);
  }

  addPlayer(playerId: string, name: string, color: number, team: Team): void {
    if (this.players.has(playerId)) return;

    const { width, height } = this.scale;
    
    // Random starting position
    const x = width / 2 + (Math.random() - 0.5) * 100;
    const y = height - 150;

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

    this.checkPlayerCount();
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      player.sprite.destroy();
      player.nameText.destroy();
      this.players.delete(playerId);
    }
    this.checkPlayerCount();
  }

  private checkPlayerCount(): void {
    if (this.players.size >= this.MIN_PLAYERS && this.isWaitingForPlayers) {
      this.isWaitingForPlayers = false;
      this.waitingText.setText('');
      this.startVoting();
    } else if (this.players.size < this.MIN_PLAYERS) {
      this.isWaitingForPlayers = true;
      this.waitingText.setText(`Waiting for ${this.MIN_PLAYERS - this.players.size} more player(s)...`);
      this.stopVoting();
    }
  }

  private startVoting(): void {
    if (this.isVotingActive) return;
    
    this.isVotingActive = true;
    this.voteTimer = MODE_VOTE_DURATION;
    this.timerText.setVisible(true);

    // Start countdown
    this.countdownEvent = this.time.addEvent({
      delay: 100,
      callback: () => {
        this.voteTimer -= 100;
        this.timerText.setText(`Time: ${Math.ceil(this.voteTimer / 1000)}`);

        if (this.voteTimer <= 0) {
          this.endVoting();
        }
      },
      loop: true,
    });
  }

  private stopVoting(): void {
    this.isVotingActive = false;
    this.timerText.setVisible(false);
    
    if (this.countdownEvent) {
      this.countdownEvent.destroy();
      this.countdownEvent = undefined;
    }
  }

  private endVoting(): void {
    this.stopVoting();

    // Count votes for each mode
    const votes = new Map<GameMode, number>();
    for (const zone of this.modeZones) {
      votes.set(zone.mode, zone.voterCount);
    }

    // Find winner (or random if tie)
    let maxVotes = 0;
    let winners: GameMode[] = [];
    
    for (const [mode, count] of votes) {
      if (count > maxVotes) {
        maxVotes = count;
        winners = [mode];
      } else if (count === maxVotes) {
        winners.push(mode);
      }
    }

    // Pick random from winners
    const selectedMode = winners[Math.floor(Math.random() * winners.length)] || 'free_for_all';

    // Highlight winning zone
    const winningZone = this.modeZones.find(z => z.mode === selectedMode);
    if (winningZone) {
      this.drawModeZone(winningZone.graphics, winningZone.x, winningZone.y, winningZone.radius, winningZone.color, true);
      
      // Show selection text
      this.add.text(winningZone.x, winningZone.y - 60, 'SELECTED!', {
        fontSize: '24px',
        fontFamily: 'Arial Black',
        color: '#00ff00',
      }).setOrigin(0.5);
    }

    // Set game mode and transition after delay
    this.time.delayedCall(2000, () => {
      if (this.bridge) {
        this.bridge.setGameMode(selectedMode);
        this.bridge.startMapVote();
      }
    });
  }

  update(_time: number, _delta: number): void {
    // Reset zone voter counts
    for (const zone of this.modeZones) {
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
        player.y = Math.max(120, Math.min(height - 60, player.y));
      }

      // Update sprite position
      player.sprite.setPosition(player.x, player.y);
      player.nameText.setPosition(player.x, player.y + 20);

      // Check which zone player is in
      for (const zone of this.modeZones) {
        const dist = Math.sqrt(
          Math.pow(player.x - zone.x, 2) + Math.pow(player.y - zone.y, 2)
        );
        if (dist <= zone.radius) {
          zone.voterCount++;
        }
      }
    }

    // Update zone visuals based on voter count
    for (const zone of this.modeZones) {
      const hasVoters = zone.voterCount > 0;
      this.drawModeZone(zone.graphics, zone.x, zone.y, zone.radius, zone.color, hasVoters);
    }
  }
}

