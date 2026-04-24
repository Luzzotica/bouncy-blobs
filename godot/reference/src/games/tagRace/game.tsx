// Tag Race Game - Ultimate Chicken Horse style top-down racing game

import { Game, GameContext, PlayerState } from "../GameInterface";
import { InputEvent } from "../../types";
import { DEFAULT_CONTROLLER_CONFIG } from "../../types/controllerConfig";
import { Player } from "../../types/database";

// Game phases
type GamePhase = "map_selection" | "racing" | "hazard_selection" | "round_end";

// Hazard types
type HazardType = "spike" | "moving_spike" | "laser" | "pit" | "wall";

interface Hazard {
  id: string;
  type: HazardType;
  x: number; // percentage (0-100)
  y: number; // percentage (0-100)
  width?: number; // percentage
  height?: number; // percentage
  rotation?: number; // degrees
  speed?: number; // for moving hazards
  direction?: { x: number; y: number }; // for moving hazards
  active?: boolean; // for timed hazards
}

interface MapDefinition {
  id: string;
  name: string;
  startX: number;
  startY: number;
  finishX: number;
  finishY: number;
  finishRadius: number;
  initialHazards: Hazard[];
}

// Available maps
const MAPS: MapDefinition[] = [
  {
    id: "simple",
    name: "Simple Path",
    startX: 10,
    startY: 50,
    finishX: 90,
    finishY: 50,
    finishRadius: 5,
    initialHazards: [],
  },
  {
    id: "maze",
    name: "Maze",
    startX: 10,
    startY: 50,
    finishX: 90,
    finishY: 50,
    finishRadius: 5,
    initialHazards: [
      { id: "wall1", type: "wall", x: 30, y: 30, width: 5, height: 40 },
      { id: "wall2", type: "wall", x: 50, y: 20, width: 5, height: 30 },
      { id: "wall3", type: "wall", x: 70, y: 40, width: 5, height: 30 },
    ],
  },
  {
    id: "obstacle_course",
    name: "Obstacle Course",
    startX: 10,
    startY: 50,
    finishX: 90,
    finishY: 50,
    finishRadius: 5,
    initialHazards: [
      { id: "spike1", type: "spike", x: 30, y: 50 },
      { id: "spike2", type: "spike", x: 50, y: 50 },
      { id: "spike3", type: "spike", x: 70, y: 50 },
    ],
  },
];

// Available hazards for selection
const AVAILABLE_HAZARDS: Array<{
  type: HazardType;
  name: string;
  icon: string;
}> = [
  { type: "spike", name: "Spike", icon: "▲" },
  { type: "moving_spike", name: "Moving Spike", icon: "◄►" },
  { type: "laser", name: "Laser", icon: "⚡" },
  { type: "pit", name: "Pit", icon: "○" },
  { type: "wall", name: "Wall", icon: "▮" },
];

interface TagRacePlayerState extends PlayerState {
  position: { x: number; y: number };
  finished: boolean;
  dead: boolean;
  finishTime?: number;
  selectedHazard?: HazardType;
}

interface TagRaceGameState {
  phase: GamePhase;
  round: number;
  selectedMap: MapDefinition | null;
  hazards: Hazard[];
  scores: Map<string, number>;
  raceStartTime?: number;
  raceEndTime?: number;
  hazardSelectionDeadline?: number;
  playerSelections: Map<string, HazardType>;
}

// Helper functions
function checkHazardCollision(
  playerState: TagRacePlayerState,
  hazard: Hazard,
): boolean {
  const playerRadius = 2; // percentage
  const px = playerState.position.x;
  const py = playerState.position.y;

  switch (hazard.type) {
    case "spike":
    case "moving_spike":
      // Circular collision
      const dist = Math.sqrt(
        Math.pow(px - hazard.x, 2) + Math.pow(py - hazard.y, 2),
      );
      return dist < playerRadius + 2;

    case "pit":
      // Circular collision (larger)
      const pitDist = Math.sqrt(
        Math.pow(px - hazard.x, 2) + Math.pow(py - hazard.y, 2),
      );
      return pitDist < playerRadius + 3;

    case "wall":
      // Rectangular collision
      const wallWidth = hazard.width || 5;
      const wallHeight = hazard.height || 20;
      return (
        px >= hazard.x - wallWidth / 2 &&
        px <= hazard.x + wallWidth / 2 &&
        py >= hazard.y - wallHeight / 2 &&
        py <= hazard.y + wallHeight / 2
      );

    case "laser":
      // Horizontal or vertical line collision
      const laserWidth = hazard.width || 50;
      const laserHeight = hazard.height || 1;
      return (
        px >= hazard.x - laserWidth / 2 &&
        px <= hazard.x + laserWidth / 2 &&
        py >= hazard.y - laserHeight / 2 &&
        py <= hazard.y + laserHeight / 2
      );

    default:
      return false;
  }
}

function startRace(context: GameContext) {
  const gameState = context.gameState as TagRaceGameState;
  const map = gameState.selectedMap;

  // Safety check: if no map selected, use default
  if (!map) {
    console.warn("startRace called without a selected map, using default");
    gameState.selectedMap = MAPS[0];
    gameState.hazards = [...MAPS[0].initialHazards];
    return startRace(context); // Retry with default map
  }

  // Reset player states
  for (const [, playerState] of context.playerStates.entries()) {
    const state = playerState as unknown as TagRacePlayerState;
    state.position = { x: map.startX, y: map.startY };
    state.finished = false;
    state.dead = false;
    state.finishTime = undefined;
  }

  // Reset race timing
  gameState.raceStartTime = Date.now();
  gameState.raceEndTime = undefined;
}

function endRace(context: GameContext) {
  const gameState = context.gameState as TagRaceGameState;

  // Count finished players
  const finishedPlayers = Array.from(context.playerStates.values()).filter(
    (ps) => (ps as unknown as TagRacePlayerState).finished,
  );
  const deadPlayers = Array.from(context.playerStates.values()).filter(
    (ps) => (ps as unknown as TagRacePlayerState).dead,
  );

  // Only award points if at least one player didn't finish
  if (
    deadPlayers.length > 0 ||
    finishedPlayers.length < context.players.length
  ) {
    finishedPlayers.forEach((ps) => {
      const playerId = ps.playerId;
      const currentScore = gameState.scores.get(playerId) || 0;
      gameState.scores.set(playerId, currentScore + 1);
    });
  }

  // Move to hazard selection phase
  gameState.phase = "hazard_selection";
  gameState.playerSelections.clear();

  // Reset player states for next round
  for (const [, playerState] of context.playerStates.entries()) {
    const state = playerState as unknown as TagRacePlayerState;
    state.finished = false;
    state.dead = false;
    state.selectedHazard = undefined;
  }
}

const TagRaceGame: Game = {
  gameDefinition: {
    id: "tag_race",
    name: "Tag Race",
    description: "Race from point A to B. Only score if someone fails!",
    controllerConfig: DEFAULT_CONTROLLER_CONFIG,
  },

  initialize(_context: GameContext): TagRaceGameState {
    return {
      phase: "map_selection",
      round: 0,
      selectedMap: null,
      hazards: [],
      scores: new Map(),
      playerSelections: new Map(),
    };
  },

  onPlayerJoin(context: GameContext, player: Player) {
    const playerId = player.user_id || player.anonymous_id || 'unknown';
    const gameState = context.gameState as TagRaceGameState;

    // Initialize player state
    const playerState: TagRacePlayerState = {
      playerId,
      position: { x: 0, y: 0 },
      finished: false,
      dead: false,
    } as TagRacePlayerState;
    context.playerStates.set(playerId, playerState as PlayerState);

    // Initialize score if not exists
    if (!gameState.scores.has(playerId)) {
      gameState.scores.set(playerId, 0);
    }

    // Auto-select first map if no map selected and we have players
    if (
      gameState.phase === "map_selection" &&
      !gameState.selectedMap &&
      context.players.length > 0
    ) {
      gameState.selectedMap = MAPS[0];
      gameState.hazards = [...MAPS[0].initialHazards];
      gameState.phase = "racing";
      gameState.round = 1;
      startRace(context);
    }
  },

  onPlayerDisconnect(context: GameContext, playerId: string) {
    context.playerStates.delete(playerId);
    const gameState = context.gameState as TagRaceGameState;
    gameState.scores.delete(playerId);
    gameState.playerSelections.delete(playerId);
  },

  onPlayerInput(
    context: GameContext,
    playerId: string,
    inputEvent: InputEvent,
  ) {
    const gameState = context.gameState as TagRaceGameState;
    const playerState = context.playerStates.get(
      playerId,
    ) as unknown as TagRacePlayerState;

    if (!playerState) return;

    // Handle input based on game phase
    if (gameState.phase === "racing") {
      // Movement input
      if (
        inputEvent.type === "continuous" &&
        inputEvent.inputType === "joystick_left"
      ) {
        const joystick = inputEvent.value as { x: number; y: number };
        if (!playerState.dead && !playerState.finished) {
          const moveSpeed = 0.3; // percentage per frame
          const newX = Math.max(
            0,
            Math.min(100, playerState.position.x + joystick.x * moveSpeed),
          );
          const newY = Math.max(
            0,
            Math.min(100, playerState.position.y - joystick.y * moveSpeed),
          );
          playerState.position = { x: newX, y: newY };
        }
      }
    } else if (gameState.phase === "hazard_selection") {
      // Hazard selection input
      if (
        inputEvent.type === "discrete" &&
        inputEvent.inputType === "button_left"
      ) {
        const currentSelection = gameState.playerSelections.get(playerId);
        const currentIndex = currentSelection
          ? AVAILABLE_HAZARDS.findIndex((h) => h.type === currentSelection)
          : -1;
        const nextIndex = (currentIndex + 1) % AVAILABLE_HAZARDS.length;
        const nextHazard = AVAILABLE_HAZARDS[nextIndex];
        gameState.playerSelections.set(playerId, nextHazard.type);
        playerState.selectedHazard = nextHazard.type;
      } else if (
        inputEvent.type === "discrete" &&
        inputEvent.inputType === "button_right"
      ) {
        // Confirm selection
        const selected = gameState.playerSelections.get(playerId);
        if (selected) {
          // Add hazard to map at random position
          const hazard: Hazard = {
            id: `hazard_${Date.now()}_${playerId}`,
            type: selected,
            x: 20 + Math.random() * 60,
            y: 20 + Math.random() * 60,
            width: selected === "wall" ? 5 : undefined,
            height: selected === "wall" ? 20 : undefined,
            speed: selected === "moving_spike" ? 0.2 : undefined,
            direction:
              selected === "moving_spike"
                ? { x: Math.random() > 0.5 ? 1 : -1, y: 0 }
                : undefined,
          };
          gameState.hazards.push(hazard);
          gameState.playerSelections.delete(playerId);
          playerState.selectedHazard = undefined;
        }
      }
    }
  },

  update(context: GameContext, _deltaTime: number) {
    const gameState = context.gameState as TagRaceGameState;

    if (gameState.phase === "racing") {
      // Safety check: if no map selected, skip update
      if (!gameState.selectedMap) {
        return;
      }

      // Update moving hazards
      gameState.hazards.forEach((hazard) => {
        if (
          hazard.type === "moving_spike" &&
          hazard.direction &&
          hazard.speed
        ) {
          hazard.x += hazard.direction.x * hazard.speed;
          hazard.y += hazard.direction.y * hazard.speed;

          // Bounce off edges
          if (hazard.x <= 5 || hazard.x >= 95) {
            hazard.direction.x *= -1;
            hazard.x = Math.max(5, Math.min(95, hazard.x));
          }
          if (hazard.y <= 5 || hazard.y >= 95) {
            hazard.direction.y *= -1;
            hazard.y = Math.max(5, Math.min(95, hazard.y));
          }
        }
      });

      // Check collisions and finish line
      const map = gameState.selectedMap;
      for (const [, playerState] of context.playerStates.entries()) {
        const state = playerState as unknown as TagRacePlayerState;
        if (state.dead || state.finished) continue;

        // Check finish line
        const distToFinish = Math.sqrt(
          Math.pow(state.position.x - map.finishX, 2) +
            Math.pow(state.position.y - map.finishY, 2),
        );
        if (distToFinish <= map.finishRadius) {
          state.finished = true;
          state.finishTime = Date.now();
        }

        // Check hazard collisions
        for (const hazard of gameState.hazards) {
          if (checkHazardCollision(state, hazard)) {
            state.dead = true;
            break;
          }
        }
      }

      // Check if race should end
      const allFinishedOrDead = Array.from(context.playerStates.values()).every(
        (ps) =>
          (ps as unknown as TagRacePlayerState).finished ||
          (ps as unknown as TagRacePlayerState).dead,
      );
      if (allFinishedOrDead && !gameState.raceEndTime) {
        gameState.raceEndTime = Date.now();
        endRace(context);
      }
    } else if (gameState.phase === "hazard_selection") {
      // Auto-advance after timeout (10 seconds)
      if (!gameState.hazardSelectionDeadline) {
        gameState.hazardSelectionDeadline = Date.now() + 10000;
      } else if (Date.now() >= gameState.hazardSelectionDeadline) {
        // Start next race
        gameState.phase = "racing";
        gameState.round++;
        gameState.hazardSelectionDeadline = undefined;
        startRace(context);
      }
    }
  },

  render(context: GameContext, players: Player[], colors: string[]) {
    const gameState = context.gameState as TagRaceGameState;

    // Ensure game state is initialized
    if (!gameState.phase) {
      gameState.phase = "map_selection";
      gameState.round = 0;
      gameState.selectedMap = null;
      gameState.hazards = [];
      gameState.scores = gameState.scores || new Map();
      gameState.playerSelections = gameState.playerSelections || new Map();
    }

    if (gameState.phase === "map_selection") {
      return (
        <div className="bg-gray-800 rounded-2xl p-8">
          <h2 className="text-xl font-semibold text-white mb-4">Tag Race</h2>
          <p className="text-gray-400 mb-4">Select a map to begin...</p>
          <div className="grid grid-cols-3 gap-4">
            {MAPS.map((map) => (
              <button
                key={map.id}
                className="bg-gray-700 hover:bg-gray-600 rounded-lg p-4 text-white"
                onClick={() => {
                  gameState.selectedMap = map;
                  gameState.hazards = [...map.initialHazards];
                  gameState.phase = "racing";
                  gameState.round = 1;
                  startRace(context);
                }}
              >
                <h3 className="font-bold">{map.name}</h3>
              </button>
            ))}
          </div>
        </div>
      );
    }

    if (gameState.phase === "hazard_selection") {
      return (
        <div className="bg-gray-800 rounded-2xl p-8">
          <h2 className="text-xl font-semibold text-white mb-4">
            Round {gameState.round} - Add Hazards
          </h2>
          <p className="text-gray-400 mb-4">
            Select a hazard to add to the map. Press left button to cycle, right
            button to place.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            {AVAILABLE_HAZARDS.map((hazard) => (
              <div
                key={hazard.type}
                className="bg-gray-700 rounded-lg p-4 text-center text-white"
              >
                <div className="text-3xl mb-2">{hazard.icon}</div>
                <div className="text-sm">{hazard.name}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {players.map((player, index) => {
              const playerId = player.user_id || player.anonymous_id || 'unknown';
              const selected = gameState.playerSelections.get(playerId);
              const hazard = AVAILABLE_HAZARDS.find((h) => h.type === selected);
              const score = gameState.scores.get(playerId) || 0;

              return (
                <div
                  key={playerId}
                  className="bg-gray-900 rounded-lg p-4 border-2"
                  style={{ borderColor: colors[index % colors.length] }}
                >
                  <h3 className="text-white font-bold mb-2">{player.name}</h3>
                  <div className="text-sm text-gray-400">
                    Score: <span className="text-white font-bold">{score}</span>
                  </div>
                  <div className="text-sm text-gray-400 mt-2">
                    Selected:{" "}
                    <span className="text-white font-bold">
                      {hazard ? hazard.name : "None"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    // Racing phase
    // Safety check: if no map selected, go back to map selection
    if (!gameState.selectedMap) {
      gameState.phase = "map_selection";
      return (
        <div className="bg-gray-800 rounded-2xl p-8">
          <h2 className="text-xl font-semibold text-white mb-4">Tag Race</h2>
          <p className="text-gray-400 mb-4">Select a map to begin...</p>
          <div className="grid grid-cols-3 gap-4">
            {MAPS.map((map) => (
              <button
                key={map.id}
                className="bg-gray-700 hover:bg-gray-600 rounded-lg p-4 text-white"
                onClick={() => {
                  gameState.selectedMap = map;
                  gameState.hazards = [...map.initialHazards];
                  gameState.phase = "racing";
                  gameState.round = 1;
                  startRace(context);
                }}
              >
                <h3 className="font-bold">{map.name}</h3>
              </button>
            ))}
          </div>
        </div>
      );
    }

    const map = gameState.selectedMap;
    const finishedCount = Array.from(context.playerStates.values()).filter(
      (ps) => (ps as unknown as TagRacePlayerState).finished,
    ).length;
    const deadCount = Array.from(context.playerStates.values()).filter(
      (ps) => (ps as unknown as TagRacePlayerState).dead,
    ).length;

    return (
      <div className="bg-gray-800 rounded-2xl p-8">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-white">
            Tag Race - Round {gameState.round}
          </h2>
          <div className="text-white text-sm">
            Finished: {finishedCount} | Dead: {deadCount}
          </div>
        </div>

        {/* Game Area */}
        <div className="relative h-96 bg-gray-900 rounded-lg overflow-hidden mb-4">
          {/* Finish Line */}
          <div
            className="absolute rounded-full border-4 border-green-500"
            style={{
              left: `${map.finishX - map.finishRadius}%`,
              top: `${map.finishY - map.finishRadius}%`,
              width: `${map.finishRadius * 2}%`,
              height: `${map.finishRadius * 2}%`,
              borderStyle: "dashed",
            }}
          >
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-green-500 font-bold text-xs">
              FINISH
            </div>
          </div>

          {/* Start Point */}
          <div
            className="absolute rounded-full border-4 border-blue-500"
            style={{
              left: `${map.startX - 2}%`,
              top: `${map.startY - 2}%`,
              width: "4%",
              height: "4%",
            }}
          >
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-blue-500 font-bold text-xs">
              START
            </div>
          </div>

          {/* Hazards */}
          {gameState.hazards.map((hazard) => {
            switch (hazard.type) {
              case "spike":
              case "moving_spike":
                return (
                  <div
                    key={hazard.id}
                    className="absolute text-red-500 text-2xl"
                    style={{
                      left: `${hazard.x}%`,
                      top: `${hazard.y}%`,
                      transform: "translate(-50%, -50%)",
                    }}
                  >
                    ▲
                  </div>
                );
              case "pit":
                return (
                  <div
                    key={hazard.id}
                    className="absolute rounded-full bg-red-900 border-2 border-red-500"
                    style={{
                      left: `${hazard.x - 3}%`,
                      top: `${hazard.y - 3}%`,
                      width: "6%",
                      height: "6%",
                    }}
                  />
                );
              case "wall":
                return (
                  <div
                    key={hazard.id}
                    className="absolute bg-red-600 border-2 border-red-800"
                    style={{
                      left: `${hazard.x - (hazard.width || 5) / 2}%`,
                      top: `${hazard.y - (hazard.height || 20) / 2}%`,
                      width: `${hazard.width || 5}%`,
                      height: `${hazard.height || 20}%`,
                    }}
                  />
                );
              case "laser":
                return (
                  <div
                    key={hazard.id}
                    className="absolute bg-yellow-400 border border-yellow-300"
                    style={{
                      left: `${hazard.x - (hazard.width || 50) / 2}%`,
                      top: `${hazard.y - (hazard.height || 1) / 2}%`,
                      width: `${hazard.width || 50}%`,
                      height: `${hazard.height || 1}%`,
                    }}
                  />
                );
              default:
                return null;
            }
          })}

          {/* Players */}
          {players.map((player, index) => {
            const playerId = player.user_id || player.anonymous_id || 'unknown';
            const state = context.playerStates.get(
              playerId,
            ) as unknown as TagRacePlayerState;
            if (!state) return null;

            const color = colors[index % colors.length];
            const isDead = state.dead;
            const isFinished = state.finished;

            return (
              <div
                key={playerId}
                className="absolute transition-all duration-75 ease-out"
                style={{
                  left: `${state.position.x}%`,
                  top: `${state.position.y}%`,
                  transform: "translate(-50%, -50%)",
                  opacity: isDead ? 0.5 : 1,
                }}
              >
                <div
                  className="w-8 h-8 rounded-full border-2 border-white relative z-10"
                  style={{
                    backgroundColor: isFinished
                      ? "green"
                      : isDead
                        ? "red"
                        : color,
                  }}
                />
                <p
                  className="text-white text-xs text-center mt-1 relative z-10 drop-shadow-lg font-bold"
                  style={{
                    color: isFinished ? "green" : isDead ? "red" : "white",
                  }}
                >
                  {player.name}
                  {isFinished && " ✓"}
                  {isDead && " ✕"}
                </p>
              </div>
            );
          })}
        </div>

        {/* Scoreboard */}
        <div className="bg-gray-900 rounded-lg p-4">
          <h3 className="text-white font-bold mb-2">Scores</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {players.map((player, index) => {
              const playerId = player.user_id || player.anonymous_id || 'unknown';
              const score = gameState.scores.get(playerId) || 0;
              return (
                <div
                  key={playerId}
                  className="text-sm"
                  style={{ color: colors[index % colors.length] }}
                >
                  {player.name}: <span className="font-bold">{score}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  },
};

export default TagRaceGame;
