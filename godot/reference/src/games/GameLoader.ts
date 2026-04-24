// Game Loader - Statically loads game modules

import { Game } from "./GameInterface";
import ControllerTestGame from "./controllerTest/game";
import TagRaceGame from "./tagRace/game";
import CoopShooterGame from "./coopShooter/game";
import SumoArenaGame from "./sumoArena/game";
import GridShooterGame from "./gridShooter/game";
import PicoParkGame from "./picoPark/game";
import TronGame from "./tronGame/game";
import { getGame } from "./index";
import { createBasicGame } from "./BasicGame";

// Registry of all available games
const gameRegistry = new Map<string, Game>([
  [ControllerTestGame.gameDefinition.id, ControllerTestGame],
  [TagRaceGame.gameDefinition.id, TagRaceGame],
  [CoopShooterGame.gameDefinition.id, CoopShooterGame],
  [SumoArenaGame.gameDefinition.id, SumoArenaGame],
  [GridShooterGame.gameDefinition.id, GridShooterGame],
  [PicoParkGame.gameDefinition.id, PicoParkGame],
  [TronGame.gameDefinition.id, TronGame],
]);

/**
 * Load a game module by game ID
 * Returns the Game instance if found, or null if not found
 */
export async function loadGameModule(gameId: string): Promise<Game | null> {
  // Check static registry first
  if (gameRegistry.has(gameId)) {
    return gameRegistry.get(gameId)!;
  }

  // Fallback: try to get game definition and create a basic game wrapper
  try {
    const gameDef = await getGame(gameId);
    if (gameDef) {
      return createBasicGame(gameDef);
    }
  } catch (error) {
    console.error(`Failed to load game module ${gameId}:`, error);
  }

  return null;
}

/**
 * Clear the game module cache (no-op for static loading, kept for compatibility)
 */
export function clearGameModuleCache(): void {
  // No-op - games are statically loaded
}
