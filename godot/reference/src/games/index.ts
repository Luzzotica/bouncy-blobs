// Game registry - exports all available games
// Note: This is for built-in games only. User-generated games are loaded dynamically via loader.ts
import { GameDefinition } from "./types";
import { loadGame, registerGameUrl, getRegisteredGameIds } from "./loader";
import ControllerTestGame from "./controllerTest/game";
import TagRaceGame from "./tagRace/game";
import CoopShooterGame from "./coopShooter/game";
import SumoArenaGame from "./sumoArena/game";
import GridShooterGame from "./gridShooter/game";
import PicoParkGame from "./picoPark/game";
import TronGame from "./tronGame/game";

// Built-in games (loaded statically)

const builtInGames: Record<string, GameDefinition> = {
  [ControllerTestGame.gameDefinition.id]: ControllerTestGame.gameDefinition,
  [TagRaceGame.gameDefinition.id]: TagRaceGame.gameDefinition,
  [CoopShooterGame.gameDefinition.id]: CoopShooterGame.gameDefinition,
  [SumoArenaGame.gameDefinition.id]: SumoArenaGame.gameDefinition,
  [GridShooterGame.gameDefinition.id]: GridShooterGame.gameDefinition,
  [PicoParkGame.gameDefinition.id]: PicoParkGame.gameDefinition,
  [TronGame.gameDefinition.id]: TronGame.gameDefinition,
};

// Register built-in games with the loader
Object.values(builtInGames).forEach((game) => {
  if (game.downloadUrl) {
    registerGameUrl(game.id, game.downloadUrl);
  }
});

/**
 * Get a game definition by ID
 * First checks built-in games, then tries to load from URL
 */
export async function getGame(
  gameId: string,
): Promise<GameDefinition | undefined> {
  // Check built-in games first
  if (builtInGames[gameId]) {
    return builtInGames[gameId];
  }

  // Try to load from URL (only if it's registered)
  try {
    const game = await loadGame(gameId);
    return game;
  } catch (error: any) {
    // Silently ignore errors for games that don't exist
    // Only log if it's not a "not found" error
    const errorMessage = error?.message || String(error);
    if (!errorMessage.includes('not found') && 
        !errorMessage.includes('MIME type') &&
        !errorMessage.includes('text/html')) {
      console.warn(`Failed to load game ${gameId}:`, error);
    }
    return undefined;
  }
}

/**
 * Get all available games (built-in + registered)
 * Note: This only returns built-in games synchronously
 * For user-generated games, use loadGame() with specific IDs
 */
export function getAllGames(): GameDefinition[] {
  return Object.values(builtInGames);
}

/**
 * Register a user-generated game URL
 */
export function registerGame(gameId: string, url: string): void {
  registerGameUrl(gameId, url);
}

/**
 * Get all registered game IDs (built-in + user-generated)
 */
export function getAllGameIds(): string[] {
  return [...Object.keys(builtInGames), ...getRegisteredGameIds()];
}

/**
 * Export the helper function for converting game config to JSON
 */
export { getDefaultControllerConfigJSON } from "./types";
