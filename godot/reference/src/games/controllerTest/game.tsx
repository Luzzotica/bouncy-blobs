// Controller Test Game - Full implementation

import React from "react";
import { Game, GameContext, PlayerState } from "../GameInterface";
import { InputEvent } from "../../types";
import {
  ControllerLayout,
  DEFAULT_CONTROLLER_CONFIG,
  InputSlotType,
} from "../../types/controllerConfig";
import { Player } from "../../types/database";
import { getSessionControllerLayout, SlotKey } from "../controllerUtils";

// Track player input states
interface ControllerTestPlayerState extends PlayerState {
  leftJoystick?: { x: number; y: number };
  rightJoystick?: { x: number; y: number };
  leftButtonPressTime?: number;
  rightButtonPressTime?: number;
}

const ControllerTestGame: Game = {
  gameDefinition: {
    id: "controller_test",
    name: "Controller Test Game",
    description: "Test all controller inputs with visual feedback",
    controllerConfig: DEFAULT_CONTROLLER_CONFIG,
  },

  initialize(context: GameContext) {
    return {
      controllerLayout: getSessionControllerLayout(context),
    };
  },

  onPlayerJoin(context: GameContext, player: Player) {
    const playerId = player.user_id || player.anonymous_id || 'unknown';
    const playerState: ControllerTestPlayerState = {
      playerId,
      position: { x: 20 + context.players.length * 30, y: 50 },
      leftJoystick: { x: 0, y: 0 },
      rightJoystick: { x: 0, y: 0 },
    };
    context.playerStates.set(playerId, playerState);
    console.log(`[ControllerTest] Player ${player.name} joined`, {
      playerId,
      playerState,
      totalPlayers: context.players.length,
      playerStatesSize: context.playerStates.size,
    });
    // Force a re-render by updating gameState
    context.gameState._playerJoinVersion =
      (context.gameState._playerJoinVersion || 0) + 1;
  },

  onPlayerDisconnect(context: GameContext, playerId: string) {
    context.playerStates.delete(playerId);
    console.log(`[ControllerTest] Player ${playerId} disconnected`);
  },

  onPlayerInput(
    context: GameContext,
    playerId: string,
    inputEvent: InputEvent,
  ) {
    let playerState = context.playerStates.get(
      playerId,
    ) as ControllerTestPlayerState;

    if (!playerState) {
      // Initialize player state if it doesn't exist
      playerState = {
        playerId,
        position: { x: 50, y: 50 },
        leftJoystick: { x: 0, y: 0 },
        rightJoystick: { x: 0, y: 0 },
      };
      context.playerStates.set(playerId, playerState);
    }

    if (inputEvent.type === "continuous") {
      // Joystick input
      if (inputEvent.inputType === "joystick_left") {
        playerState.leftJoystick = inputEvent.value as { x: number; y: number };
      } else if (inputEvent.inputType === "joystick_right") {
        playerState.rightJoystick = inputEvent.value as {
          x: number;
          y: number;
        };
      }
    } else if (inputEvent.type === "discrete") {
      // Button input
      const timestamp = Number(inputEvent.timestamp) / 1000;
      if (inputEvent.inputType === "button_left") {
        playerState.leftButtonPressTime = timestamp;
      } else if (inputEvent.inputType === "button_right") {
        playerState.rightButtonPressTime = timestamp;
      }
    }
  },

  update(context: GameContext, deltaTime: number) {
    // Update player positions based on left joystick
    for (const [, playerState] of context.playerStates.entries()) {
      const state = playerState as ControllerTestPlayerState;
      if (!state.position || !state.leftJoystick) continue;

      const moveSpeed = 0.8 * (deltaTime / 16.67); // Normalize to 60fps
      const newX = Math.max(
        5,
        Math.min(95, state.position.x + state.leftJoystick.x * moveSpeed),
      );
      const newY = Math.max(
        5,
        Math.min(95, state.position.y - state.leftJoystick.y * moveSpeed),
      );

      state.position = { x: newX, y: newY };
    }
  },

  render(context: GameContext, players: any[], colors: string[]) {
    const layout =
      (context.gameState.controllerLayout as ControllerLayout) ??
      getSessionControllerLayout(context);
    const layoutOptions: InputSlotType[] = ["joystick", "button"];
    const slotConfig: Array<{ slot: SlotKey; label: string }> = [
      { slot: "left", label: "Left Input" },
      { slot: "right", label: "Right Input" },
    ];
    const handleLayoutChange = (slot: SlotKey, type: InputSlotType) => {
      console.log("[ControllerTest] handleLayoutChange FUNCTION CALLED", {
        slot,
        type,
        timestamp: Date.now(),
      });
      console.log("[ControllerTest] handleLayoutChange called", {
        slot,
        type,
        currentLayout: layout,
        currentSlotValue: layout[slot],
      });

      if (layout[slot] === type) {
        console.log("[ControllerTest] Layout unchanged, skipping");
        return;
      }

      const nextLayout = { ...layout, [slot]: type };
      console.log("[ControllerTest] Updating layout", {
        oldLayout: layout,
        newLayout: nextLayout,
        api: context.api,
      });

      context.gameState.controllerLayout = nextLayout;

      // Use the API to update the controller layout
      console.log("[ControllerTest] Calling api.updateControllerLayout");
      try {
        context.api.updateControllerLayout(nextLayout);
        console.log(
          "[ControllerTest] api.updateControllerLayout completed successfully",
        );
      } catch (error) {
        console.error(
          "[ControllerTest] Error calling api.updateControllerLayout:",
          error,
        );
      }
    };

    return (
      <div className="bg-gray-800 rounded-2xl p-8">
        <h2 className="text-xl font-semibold text-white mb-4">
          Controller Test - Visual Input Feedback
        </h2>
        <div className="relative h-96 bg-gray-900 rounded-lg overflow-hidden">
          {players.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-gray-400 text-lg">
                Waiting for players to join...
              </p>
            </div>
          ) : (
            players.map((player, index) => {
              const color = colors[index % colors.length];
              const playerId = player.user_id || player.anonymous_id || 'unknown';
              const state = context.playerStates.get(
                playerId,
              ) as ControllerTestPlayerState;

              if (!state) return null;

              const position = state.position || { x: 50, y: 50 };
              const rightJoystick = state.rightJoystick || { x: 0, y: 0 };
              const leftButtonPressTime = state.leftButtonPressTime;
              const rightButtonPressTime = state.rightButtonPressTime;

              // Calculate aimer position
              const aimerDistance = 50;
              const aimerX = position.x + rightJoystick.x * aimerDistance;
              const aimerY = position.y - rightJoystick.y * aimerDistance;

              // Left button effect: scale up
              const leftButtonTimeMs = leftButtonPressTime
                ? leftButtonPressTime > 1000000000000
                  ? leftButtonPressTime
                  : leftButtonPressTime * 1000
                : 0;
              const timeSinceLeftPress = leftButtonTimeMs
                ? Date.now() - leftButtonTimeMs
                : Infinity;
              const leftButtonActive = timeSinceLeftPress < 500;
              const leftButtonScale = leftButtonActive
                ? 1 + 0.3 * Math.max(0, 1 - timeSinceLeftPress / 500)
                : 1;

              // Right button effect: pulse
              const rightButtonTimeMs = rightButtonPressTime
                ? rightButtonPressTime > 1000000000000
                  ? rightButtonPressTime
                  : rightButtonPressTime * 1000
                : 0;
              const timeSinceRightPress = rightButtonTimeMs
                ? Date.now() - rightButtonTimeMs
                : Infinity;
              const rightButtonActive = timeSinceRightPress < 300;
              const pulseScale = rightButtonActive
                ? 1 + 0.4 * Math.max(0, 1 - timeSinceRightPress / 300)
                : 1;
              const glowIntensity = rightButtonActive
                ? Math.max(0, 1 - timeSinceRightPress / 300)
                : 0;

              return (
                <React.Fragment key={playerId}>
                  {/* Player Circle */}
                  <div
                    className="absolute transition-all duration-75 ease-out"
                    style={{
                      left: `${position.x}%`,
                      top: `${position.y}%`,
                      transform: `translate(-50%, -50%) scale(${leftButtonScale * pulseScale})`,
                    }}
                  >
                    <div
                      className="w-16 h-16 rounded-full border-4 border-white transition-all duration-75 relative z-10"
                      style={{
                        backgroundColor: color,
                        filter: `brightness(${1 + glowIntensity * 0.5})`,
                        boxShadow:
                          glowIntensity > 0
                            ? `0 0 ${20 * glowIntensity}px ${color}, 0 0 ${40 * glowIntensity}px ${color}`
                            : "none",
                      }}
                    />
                    <p className="text-white text-xs text-center mt-1 relative z-10 drop-shadow-lg font-bold">
                      {player.name}
                    </p>
                  </div>

                  {/* Aimer */}
                  {Math.abs(rightJoystick.x) > 0.01 ||
                  Math.abs(rightJoystick.y) > 0.01 ? (
                    <div
                      className="absolute transition-all duration-75 ease-out pointer-events-none"
                      style={{
                        left: `${aimerX}%`,
                        top: `${aimerY}%`,
                        transform: "translate(-50%, -50%)",
                      }}
                    >
                      <div className="relative w-8 h-8">
                        <div
                          className="absolute top-1/2 left-0 w-full h-0.5 -translate-y-1/2"
                          style={{ backgroundColor: color }}
                        />
                        <div
                          className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2"
                          style={{ backgroundColor: color }}
                        />
                        <div
                          className="absolute top-1/2 left-1/2 w-2 h-2 rounded-full -translate-x-1/2 -translate-y-1/2"
                          style={{ backgroundColor: color }}
                        />
                      </div>
                    </div>
                  ) : null}
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="bg-white/5 border border-white/10 rounded-3xl p-4 mb-6">
          <h3 className="text-xs uppercase tracking-[0.3em] text-white/70 text-center">
            Controller Layout
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {slotConfig.map(({ slot, label }) => (
              <div key={slot} className="space-y-1">
                <p className="text-xs text-gray-300 uppercase tracking-wide">
                  {label}
                </p>
                <div className="flex gap-2">
                  {layoutOptions.map((type) => {
                    const isSelected = layout[slot] === type;
                    return (
                      <button
                        key={`${slot}-${type}`}
                        type="button"
                        className={`flex-1 rounded-full py-2 text-[11px] font-semibold uppercase tracking-[0.2em] transition ${
                          isSelected
                            ? "bg-white text-purple-700"
                            : "bg-white/10 text-white/70 hover:bg-white/20"
                        }`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleLayoutChange(slot, type);
                        }}
                      >
                        {type === "joystick" ? "Joystick" : "Button"}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Input Status Panel */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {players.map((player, index) => {
            const color = colors[index % colors.length];
            const playerId = player.user_id || player.anonymous_id || 'unknown';
            const state = context.playerStates.get(
              playerId,
            ) as ControllerTestPlayerState;

            if (!state) return null;

            const leftJoystick = state.leftJoystick;
            const rightJoystick = state.rightJoystick;
            const leftButtonActive = !!state.leftButtonPressTime;
            const rightButtonActive = !!state.rightButtonPressTime;

            return (
              <div
                key={playerId}
                className="bg-gray-900 rounded-lg p-4 border-2"
                style={{ borderColor: color }}
              >
                <h3 className="text-white font-bold mb-3 text-sm">
                  {player.name}
                </h3>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Left Joystick:</span>
                    <span className="text-white font-mono">
                      {leftJoystick
                        ? `${leftJoystick.x.toFixed(2)}, ${leftJoystick.y.toFixed(2)}`
                        : "---"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Right Joystick:</span>
                    <span className="text-white font-mono">
                      {rightJoystick
                        ? `${rightJoystick.x.toFixed(2)}, ${rightJoystick.y.toFixed(2)}`
                        : "---"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Left Button:</span>
                    <span
                      className={
                        leftButtonActive
                          ? "text-green-400 font-bold"
                          : "text-gray-500"
                      }
                    >
                      {leftButtonActive ? "PRESSED" : "---"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Right Button:</span>
                    <span
                      className={
                        rightButtonActive
                          ? "text-green-400 font-bold"
                          : "text-gray-500"
                      }
                    >
                      {rightButtonActive ? "PRESSED" : "---"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
};

export default ControllerTestGame;
