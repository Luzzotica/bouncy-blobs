// Level Select Scene - Choose which level to play

import Phaser from 'phaser';
import { PhaserGameBridge } from '../PhaserGame';
import { LEVELS } from '../levels/LevelDefinitions';
import { PicoParkLevel } from '../types';

interface LevelSelectSceneData {
  playerData?: Array<{ playerId: string; name: string; color: number }>;
}

export class LevelSelectScene extends Phaser.Scene {
  private bridge!: PhaserGameBridge;
  private pendingPlayerData: Array<{ playerId: string; name: string; color: number }> = [];
  
  // UI elements
  private levelButtons: Phaser.GameObjects.Container[] = [];
  private selectedIndex: number = 0;
  private playerCountText!: Phaser.GameObjects.Text;
  
  // Player indicators for voting
  private playerIndicators: Map<string, Phaser.GameObjects.Arc> = new Map();
  private playerVotes: Map<string, number> = new Map(); // playerId -> levelIndex
  
  // Selection cooldown to slow down scrolling (100x slower)
  private selectionCooldowns: Map<string, number> = new Map();
  private readonly SELECTION_COOLDOWN = 500; // ms between selection changes (was instant)

  constructor() {
    super({ key: 'LevelSelectScene' });
  }

  init(data: LevelSelectSceneData): void {
    this.bridge = this.game.registry.get('bridge') as PhaserGameBridge;
    this.pendingPlayerData = data.playerData || [];
    this.levelButtons = [];
    this.selectedIndex = 0;
    this.playerIndicators.clear();
    this.playerVotes.clear();
    this.selectionCooldowns.clear();
  }

  create(): void {
    const { width, height } = this.scale;
    
    // Background
    this.cameras.main.setBackgroundColor('#1a1a2e');
    
    // Title
    this.add.text(width / 2, 60, '🎮 PICO PARK 🎮', {
      fontSize: '48px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 6,
    }).setOrigin(0.5);

    // Subtitle
    this.add.text(width / 2, 110, 'Cooperative Platformer', {
      fontSize: '20px',
      fontFamily: 'Arial',
      color: '#88ccff',
    }).setOrigin(0.5);

    // Player count
    const playerCount = this.pendingPlayerData.length || this.bridge?.getPlayerCount() || 0;
    this.playerCountText = this.add.text(width / 2, 150, `${playerCount} Players Connected`, {
      fontSize: '18px',
      fontFamily: 'Arial',
      color: '#66ff66',
    }).setOrigin(0.5);

    // Create level selection buttons
    this.createLevelButtons();

    // Instructions
    this.add.text(width / 2, height - 60, 'Move joystick left/right to select • Press Jump to start', {
      fontSize: '16px',
      fontFamily: 'Arial',
      color: '#aaaaaa',
    }).setOrigin(0.5);

    // Add player indicators
    this.createPlayerIndicators();

    // Set phase
    this.bridge?.setPhase('level_select');
  }

  private createLevelButtons(): void {
    const { width } = this.scale;
    const buttonWidth = 280;
    const buttonHeight = 120;
    const padding = 30;
    const startY = 220;
    
    // Calculate grid layout
    const cols = Math.min(LEVELS.length, 3);
    const totalWidth = cols * buttonWidth + (cols - 1) * padding;
    const startX = (width - totalWidth) / 2 + buttonWidth / 2;

    LEVELS.forEach((level, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = startX + col * (buttonWidth + padding);
      const y = startY + row * (buttonHeight + padding);

      const container = this.add.container(x, y);

      // Button background
      const bg = this.add.rectangle(0, 0, buttonWidth, buttonHeight, 0x2a2a4a, 1);
      bg.setStrokeStyle(3, 0x4a4a6a);
      container.add(bg);

      // Level name
      const nameText = this.add.text(0, -35, level.name, {
        fontSize: '22px',
        fontFamily: 'Arial Black',
        color: '#ffffff',
      }).setOrigin(0.5);
      container.add(nameText);

      // Difficulty indicator
      const difficultyColor = level.difficulty === 'easy' ? '#66ff66' : 
                             level.difficulty === 'medium' ? '#ffaa00' : '#ff4444';
      const difficultyText = this.add.text(0, -5, level.difficulty.toUpperCase(), {
        fontSize: '14px',
        fontFamily: 'Arial',
        color: difficultyColor,
      }).setOrigin(0.5);
      container.add(difficultyText);

      // Player requirement
      const playersText = this.add.text(0, 20, `${level.requiredPlayers}+ players`, {
        fontSize: '14px',
        fontFamily: 'Arial',
        color: '#888888',
      }).setOrigin(0.5);
      container.add(playersText);

      // Coin count
      const coinText = this.add.text(0, 40, `🪙 ${level.coinPositions.length} coins`, {
        fontSize: '14px',
        fontFamily: 'Arial',
        color: '#ffcc00',
      }).setOrigin(0.5);
      container.add(coinText);

      // Store reference
      (container as any).levelData = level;
      (container as any).bgRect = bg;
      this.levelButtons.push(container);
    });

    // Highlight first level
    this.updateSelection();
  }

  private createPlayerIndicators(): void {
    const players = this.pendingPlayerData.length > 0 
      ? this.pendingPlayerData 
      : this.bridge?.getRegisteredPlayers() || [];

    players.forEach((player) => {
      const indicator = this.add.circle(0, 0, 8, player.color);
      indicator.setVisible(false);
      this.playerIndicators.set(player.playerId, indicator);
      // Initialize all players to select first level
      this.playerVotes.set(player.playerId, 0);
    });
  }

  private updateSelection(): void {
    this.levelButtons.forEach((container, index) => {
      const bg = (container as any).bgRect as Phaser.GameObjects.Rectangle;
      if (index === this.selectedIndex) {
        bg.setFillStyle(0x3a5a8a, 1);
        bg.setStrokeStyle(4, 0x66aaff);
        container.setScale(1.05);
      } else {
        bg.setFillStyle(0x2a2a4a, 1);
        bg.setStrokeStyle(3, 0x4a4a6a);
        container.setScale(1);
      }
    });

    // Update player indicator positions
    this.updatePlayerIndicators();
  }

  private updatePlayerIndicators(): void {
    // Group players by their vote
    const voteGroups: Map<number, string[]> = new Map();
    for (const [playerId, levelIndex] of this.playerVotes) {
      if (!voteGroups.has(levelIndex)) {
        voteGroups.set(levelIndex, []);
      }
      voteGroups.get(levelIndex)!.push(playerId);
    }

    // Position indicators on their respective buttons
    for (const [levelIndex, playerIds] of voteGroups) {
      const button = this.levelButtons[levelIndex];
      if (!button) continue;

      const indicatorSpacing = 20;
      const totalWidth = (playerIds.length - 1) * indicatorSpacing;
      const startX = -totalWidth / 2;

      playerIds.forEach((playerId, i) => {
        const indicator = this.playerIndicators.get(playerId);
        if (indicator) {
          indicator.setPosition(button.x + startX + i * indicatorSpacing, button.y + 55);
          indicator.setVisible(true);
        }
      });
    }
  }

  addPlayer(playerId: string, _name: string, color: number): void {
    // Create indicator for new player
    const indicator = this.add.circle(0, 0, 8, color);
    this.playerIndicators.set(playerId, indicator);
    this.playerVotes.set(playerId, this.selectedIndex);
    
    // Update player count
    const playerCount = this.bridge?.getPlayerCount() || 0;
    this.playerCountText?.setText(`${playerCount} Players Connected`);
    
    this.updatePlayerIndicators();
  }

  removePlayer(playerId: string): void {
    const indicator = this.playerIndicators.get(playerId);
    if (indicator) {
      indicator.destroy();
      this.playerIndicators.delete(playerId);
    }
    this.playerVotes.delete(playerId);
    
    // Update player count
    const playerCount = this.bridge?.getPlayerCount() || 0;
    this.playerCountText?.setText(`${playerCount} Players Connected`);
    
    this.updatePlayerIndicators();
  }

  update(time: number, _delta: number): void {
    if (!this.bridge) return;

    // Process player inputs for level selection
    const inputs = this.bridge.getAllPlayerInputs();
    let anyJumpPressed = false;
    
    for (const [playerId, input] of inputs) {
      // Move selection based on joystick (with cooldown for slower scrolling)
      if (Math.abs(input.movement.x) > 0.5) {
        const lastSelectionTime = this.selectionCooldowns.get(playerId) || 0;
        
        // Only allow selection change after cooldown (100x slower)
        if (time - lastSelectionTime >= this.SELECTION_COOLDOWN) {
          const currentVote = this.playerVotes.get(playerId) || 0;
          let newVote = currentVote;
          
          if (input.movement.x > 0.5) {
            newVote = Math.min(currentVote + 1, LEVELS.length - 1);
          } else if (input.movement.x < -0.5) {
            newVote = Math.max(currentVote - 1, 0);
          }
          
          if (newVote !== currentVote) {
            this.playerVotes.set(playerId, newVote);
            this.selectionCooldowns.set(playerId, time);
            // Use the most recent selection as the highlighted one
            this.selectedIndex = newVote;
            this.updateSelection();
          }
        }
      } else {
        // Reset cooldown when joystick returns to center
        this.selectionCooldowns.delete(playerId);
      }

      // Check for jump to confirm
      if (input.jumpPressed) {
        anyJumpPressed = true;
      }
    }

    // Start game if any player presses jump
    if (anyJumpPressed && LEVELS.length > 0) {
      const selectedLevel = LEVELS[this.selectedIndex];
      const playerCount = this.bridge.getPlayerCount();
      
      if (playerCount >= selectedLevel.requiredPlayers) {
        this.startLevel(selectedLevel);
      } else {
        // Flash warning
        this.playerCountText.setColor('#ff4444');
        this.playerCountText.setText(`Need ${selectedLevel.requiredPlayers} players! (${playerCount} connected)`);
        this.time.delayedCall(1500, () => {
          this.playerCountText.setColor('#66ff66');
          this.playerCountText.setText(`${playerCount} Players Connected`);
        });
      }
    }
  }

  private startLevel(level: PicoParkLevel): void {
    this.bridge?.startLevel(level);
  }
}

