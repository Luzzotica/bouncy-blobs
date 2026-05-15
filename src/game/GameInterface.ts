import { InputEvent } from "../types";
import { Player } from "../types/database";
import { InputManager } from "../managers/InputManager";
import { ControllerConfigJSON } from "../types/controllerConfig";
import { ControllerLayout } from "../types/controllerConfig";

export interface GameState {
  [key: string]: any;
}

export interface PlayerState {
  playerId: string;
  position?: { x: number; y: number };
  [key: string]: any;
}

export interface GameAPI {
  updateControllerLayout(layout: ControllerLayout): void;
}

export interface GameDefinition {
  id: string;
  name: string;
  description?: string;
  controllerConfig: ControllerConfigJSON;
}

export interface GameContext {
  connection: null;
  sessionId: string;
  players: Player[];
  gameState: GameState;
  playerStates: Map<string, PlayerState>;
  inputManager: InputManager;
  api: GameAPI;
}

export interface Game {
  gameDefinition: GameDefinition;
  onPlayerJoin?(context: GameContext, player: Player): void;
  onPlayerDisconnect?(context: GameContext, playerId: string): void;
  onPlayerInput(context: GameContext, playerId: string, inputEvent: InputEvent): void;
  update?(context: GameContext, deltaTime: number): void;
  render(context: GameContext, players: Player[], colors: string[]): React.ReactNode;
  initialize?(context: GameContext): GameState;
}
