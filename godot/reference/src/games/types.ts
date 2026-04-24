// Game system types

import { ControllerConfigJSON } from "../types/controllerConfig";

export interface GameDefinition {
  id: string;
  name: string;
  description?: string;
  // Controller config JSON describing the game's default layout
  controllerConfig: ControllerConfigJSON;
  // Optional: URL where this game can be downloaded from
  // If not provided, assumes the game is built-in
  downloadUrl?: string;
  // Game-specific logic will be added here
}

/**
 * Get the default controller config as JSON string for a game
 */
export function getDefaultControllerConfigJSON(
  game: GameDefinition,
): string {
  return JSON.stringify(game.controllerConfig);
}

