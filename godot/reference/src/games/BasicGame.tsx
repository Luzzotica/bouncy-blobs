// Basic Game - Wrapper for GameDefinition to Game interface
// Used for backwards compatibility with simple game definitions

import { Game, GameContext } from "./GameInterface";
import { GameDefinition } from "./types";
import { InputEvent } from "../types";

/**
 * Create a basic game from a GameDefinition
 * This provides a simple default implementation
 */
export function createBasicGame(gameDef: GameDefinition): Game {
  return {
    gameDefinition: gameDef,

    onPlayerInput(
      _context: GameContext,
      playerId: string,
      inputEvent: InputEvent,
    ) {
      // Basic implementation - can be overridden
      console.log(
        `[${this.gameDefinition.name}] Input from ${playerId}:`,
        inputEvent,
      );
    },

    render(_context: GameContext, players: any[], _colors: string[]) {
      return (
        <div className="bg-gray-800 rounded-2xl p-8">
          <h2 className="text-xl font-semibold text-white mb-4">
            {this.gameDefinition.name}
          </h2>
          <div className="relative h-64 bg-gray-900 rounded-lg overflow-hidden">
            {players.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-gray-400 text-lg">
                  Waiting for players to join...
                </p>
              </div>
            ) : (
              <div className="text-white p-4">
                <p>Players: {players.length}</p>
                <p className="text-gray-400 text-sm mt-2">
                  This is a basic game. Implement custom game logic in{" "}
                  <code className="bg-gray-700 px-2 py-1 rounded">
                    games/{this.gameDefinition.id}/game.ts
                  </code>
                </p>
              </div>
            )}
          </div>
        </div>
      );
    },
  };
}
