// Results Scene - Show level completion stats and scores

import Phaser from 'phaser';
import { PhaserGameBridge } from '../PhaserGame';
import { LEVELS } from '../levels/LevelDefinitions';
import { PicoParkLevel } from '../types';

interface ResultsSceneData {
  level: PicoParkLevel;
  time: number;
  scores: Map<string, number>;
  playerData?: Array<{ playerId: string; name: string; color: number }>;
}

export class ResultsScene extends Phaser.Scene {
  private bridge!: PhaserGameBridge;
  private currentLevel!: PicoParkLevel;
  private completionTime: number = 0;
  private scores: Map<string, number> = new Map();
  private playerData: Array<{ playerId: string; name: string; color: number }> = [];
  
  // UI elements
  private canAct: boolean = false;

  constructor() {
    super({ key: 'ResultsScene' });
  }

  init(data: ResultsSceneData): void {
    this.bridge = this.game.registry.get('bridge') as PhaserGameBridge;
    this.currentLevel = data.level;
    this.completionTime = data.time;
    this.scores = data.scores || new Map();
    this.playerData = data.playerData || [];
    this.canAct = false;
  }

  create(): void {
    const { width, height } = this.scale;
    
    // Background
    this.cameras.main.setBackgroundColor('#1a1a2e');

    // Title
    this.add.text(width / 2, 50, '🏆 LEVEL COMPLETE! 🏆', {
      fontSize: '42px',
      fontFamily: 'Arial Black',
      color: '#00ff00',
      stroke: '#000000',
      strokeThickness: 6,
    }).setOrigin(0.5);

    // Level name
    this.add.text(width / 2, 100, this.currentLevel.name, {
      fontSize: '24px',
      fontFamily: 'Arial',
      color: '#88ccff',
    }).setOrigin(0.5);

    // Time display
    const timeStr = this.formatTime(this.completionTime);
    this.add.text(width / 2, 160, `⏱️ Time: ${timeStr}`, {
      fontSize: '32px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
    }).setOrigin(0.5);

    // Star rating based on time (rough estimates)
    const stars = this.calculateStars();
    this.add.text(width / 2, 200, '⭐'.repeat(stars) + '☆'.repeat(3 - stars), {
      fontSize: '36px',
    }).setOrigin(0.5);

    // Player scores
    this.createScoreboard();

    // Instructions
    this.add.text(width / 2, height - 100, 'Move left: Level Select • Move right: Next Level', {
      fontSize: '16px',
      fontFamily: 'Arial',
      color: '#888888',
    }).setOrigin(0.5);

    this.add.text(width / 2, height - 70, 'Press Jump to continue', {
      fontSize: '18px',
      fontFamily: 'Arial',
      color: '#aaaaaa',
    }).setOrigin(0.5);

    // Set phase
    this.bridge?.setPhase('results');

    // Delay before allowing input
    this.time.delayedCall(1000, () => {
      this.canAct = true;
    });
  }

  private formatTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const centiseconds = Math.floor((ms % 1000) / 10);
    return `${minutes}:${secs.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
  }

  private calculateStars(): number {
    // Based on level difficulty and time
    const baseTime = this.currentLevel.difficulty === 'easy' ? 30000 :
                     this.currentLevel.difficulty === 'medium' ? 60000 : 90000;
    
    if (this.completionTime < baseTime * 0.5) return 3;
    if (this.completionTime < baseTime) return 2;
    return 1;
  }

  private createScoreboard(): void {
    const { width } = this.scale;
    const startY = 260;
    const rowHeight = 50;

    // Header
    this.add.text(width / 2, startY - 30, 'COIN LEADERBOARD', {
      fontSize: '20px',
      fontFamily: 'Arial Black',
      color: '#ffcc00',
    }).setOrigin(0.5);

    // Sort players by score
    const sortedPlayers = [...this.playerData].sort((a, b) => {
      const scoreA = this.scores.get(a.playerId) || 0;
      const scoreB = this.scores.get(b.playerId) || 0;
      return scoreB - scoreA;
    });

    // Display each player
    sortedPlayers.forEach((player, index) => {
      const y = startY + index * rowHeight;
      const score = this.scores.get(player.playerId) || 0;
      
      // Rank
      const rankEmoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      this.add.text(width / 2 - 150, y, rankEmoji, {
        fontSize: '24px',
      }).setOrigin(0.5);

      // Player color indicator
      this.add.circle(width / 2 - 100, y, 10, player.color);

      // Player name
      this.add.text(width / 2 - 70, y, player.name, {
        fontSize: '22px',
        fontFamily: 'Arial',
        color: '#ffffff',
      }).setOrigin(0, 0.5);

      // Score
      this.add.text(width / 2 + 120, y, `🪙 ${score}`, {
        fontSize: '22px',
        fontFamily: 'Arial',
        color: '#ffcc00',
      }).setOrigin(0.5);
    });
  }

  addPlayer(playerId: string, name: string, color: number): void {
    // Add to player data if not exists
    if (!this.playerData.find(p => p.playerId === playerId)) {
      this.playerData.push({ playerId, name, color });
    }
  }

  removePlayer(playerId: string): void {
    this.playerData = this.playerData.filter(p => p.playerId !== playerId);
  }

  update(_time: number, _delta: number): void {
    if (!this.canAct || !this.bridge) return;

    // Process player inputs
    const inputs = this.bridge.getAllPlayerInputs();
    
    for (const [_playerId, input] of inputs) {
      // Check for navigation
      if (input.jumpPressed) {
        // Default action: Go to next level if exists
        const currentIndex = LEVELS.findIndex(l => l.id === this.currentLevel.id);
        const nextLevel = LEVELS[currentIndex + 1];
        
        if (input.movement.x < -0.3) {
          // Left: Return to level select
          this.bridge.returnToLevelSelect();
          return;
        } else if (input.movement.x > 0.3 && nextLevel) {
          // Right: Next level
          this.bridge.nextLevel(nextLevel);
          return;
        } else if (nextLevel) {
          // Default: Next level
          this.bridge.nextLevel(nextLevel);
          return;
        } else {
          // No more levels: Return to select
          this.bridge.returnToLevelSelect();
          return;
        }
      }
    }
  }
}

