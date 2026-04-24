// Game loader - dynamically loads games from URLs
import { GameDefinition } from "./types";

// Cache for loaded games
const gameCache = new Map<string, GameDefinition>();

// Registry of game URLs (can be extended to fetch from a server)
// Format: gameId -> URL to the game's JS file
const gameRegistry: Record<string, string> = {
  // Built-in games (loaded from local files)
  simple: "/games/simple.js",
  race: "/games/colorRace.js",
  // User-generated games can be added here dynamically
};

/**
 * Register a game URL for a given game ID
 * This allows users to add their own games
 */
export function registerGameUrl(gameId: string, url: string): void {
  gameRegistry[gameId] = url;
}

/**
 * Load a game definition from a URL
 * Supports both local imports and remote URLs
 * Games are expected to export a default GameDefinition object
 */
async function loadGameFromUrl(url: string): Promise<GameDefinition> {
  try {
    // Check if it's a remote URL (http/https)
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // Fetch the JS file as text
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch game from ${url}: ${response.statusText}`);
      }
      
      const jsCode = await response.text();
      
      // Create a blob URL and import it
      const blob = new Blob([jsCode], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      
      try {
        // Dynamic import from blob URL
        const module = await import(/* @vite-ignore */ blobUrl);
        
        // Games should export a default GameDefinition
        const game = module.default || module.game;
        
        if (!game || !game.id) {
          throw new Error(`Invalid game format: game must export a GameDefinition with an id`);
        }
        
        // Clean up blob URL
        URL.revokeObjectURL(blobUrl);
        
        return game as GameDefinition;
      } catch (importError) {
        URL.revokeObjectURL(blobUrl);
        throw importError;
      }
    } else {
      // Local import (for built-in games)
      try {
        const module = await import(/* @vite-ignore */ url);
        
        // Verify it's actually a module, not HTML (404 page)
        if (module && typeof module === 'object') {
          const moduleStr = JSON.stringify(module);
          if (moduleStr.includes('<!DOCTYPE') || moduleStr.includes('<html')) {
            throw new Error(`Game file not found: ${url}`);
          }
        }
        
        // Games should export a default GameDefinition
        const game = module.default || module.game;
        
        if (!game || !game.id) {
          throw new Error(`Invalid game format: game must export a GameDefinition with an id`);
        }
        
        return game as GameDefinition;
      } catch (importError: any) {
        // Check if it's a MIME type error (file doesn't exist)
        if (importError?.message?.includes('MIME type') || 
            importError?.message?.includes('text/html') ||
            importError?.message?.includes('Failed to fetch')) {
          throw new Error(`Game file not found: ${url}`);
        }
        throw importError;
      }
    }
  } catch (error) {
    // Don't log MIME type errors - they're expected when files don't exist
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!errorMessage.includes('MIME type') && !errorMessage.includes('text/html')) {
      console.error(`Failed to load game from ${url}:`, error);
    }
    throw new Error(`Failed to load game: ${errorMessage}`);
  }
}

/**
 * Get a game definition by ID
 * First checks cache, then loads from URL if needed
 */
export async function loadGame(gameId: string): Promise<GameDefinition> {
  // Check cache first
  if (gameCache.has(gameId)) {
    return gameCache.get(gameId)!;
  }
  
  // Check if we have a URL for this game
  const url = gameRegistry[gameId];
  if (!url) {
    throw new Error(`Game "${gameId}" not found in registry. Available games: ${Object.keys(gameRegistry).join(", ")}`);
  }
  
  // Load the game
  const game = await loadGameFromUrl(url);
  
  // Cache it
  gameCache.set(gameId, game);
  
  return game;
}

/**
 * Preload multiple games
 */
export async function preloadGames(gameIds: string[]): Promise<void> {
  await Promise.allSettled(
    gameIds.map(gameId => loadGame(gameId).catch(err => {
      console.warn(`Failed to preload game ${gameId}:`, err);
    }))
  );
}

/**
 * Get all registered game IDs
 */
export function getRegisteredGameIds(): string[] {
  return Object.keys(gameRegistry);
}

/**
 * Clear the game cache (useful for development/reloading)
 */
export function clearGameCache(): void {
  gameCache.clear();
}

