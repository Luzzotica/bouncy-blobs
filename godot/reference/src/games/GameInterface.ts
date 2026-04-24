// Game Interface - Contract that all games must implement

import { InputEvent } from "../types";
import { Player } from "../types/database";
import { InputManager } from "../managers/InputManager";
import { GameDefinition } from "./types";
import { GameAPI } from "./GameAPI";

export interface GameState {
  [key: string]: any; // Game-specific state
}

export interface PlayerState {
  playerId: string;
  position?: { x: number; y: number };
  [key: string]: any; // Game-specific player state
}

export interface GameContext {
  connection: null; // No longer needed - entities are client-side only
  sessionId: bigint;
  players: Player[];
  gameState: GameState;
  playerStates: Map<string, PlayerState>;
  inputManager: InputManager; // Games can access current input states
  api: GameAPI; // API for games to interact with the session
}

/**
 * Game Interface - All games must implement this
 */
export interface Game {
  // Game metadata
  gameDefinition: GameDefinition;

  // Lifecycle methods
  /**
   * Called when a player joins the game
   */
  onPlayerJoin?(context: GameContext, player: Player): void;

  /**
   * Called when a player disconnects
   */
  onPlayerDisconnect?(context: GameContext, playerId: string): void;

  /**
   * Called when a player sends input
   */
  onPlayerInput(
    context: GameContext,
    playerId: string,
    inputEvent: InputEvent,
  ): void;

  /**
   * Called every frame to update game state
   */
  update?(context: GameContext, deltaTime: number): void;

  /**
   * Render the game visualization
   */
  render(
    context: GameContext,
    players: Player[],
    colors: string[],
  ): React.ReactNode;

  /**
   * Initialize game state
   */
  initialize?(context: GameContext): GameState;
}
