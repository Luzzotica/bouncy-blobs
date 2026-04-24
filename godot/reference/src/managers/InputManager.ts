import {
  InputEvent,
  InputType,
  ContinuousInputState,
  DiscreteInputEvent,
  InputEventListener,
} from "../types";
import type { WebRTCMessage } from "./WebRTCManager";

/**
 * InputManager - Handles interpretation and management of user inputs
 *
 * Separates input processing from game logic by:
 * 1. Processing raw inputs from WebRTC data channel messages
 * 2. Categorizing inputs as continuous (joystick) or discrete (button)
 * 3. Managing input state per player
 * 4. Emitting events for game logic to consume
 */
export class InputManager {
  private playerInputStates: Map<string, Map<InputType, InputEvent>> =
    new Map();
  private listeners: Set<InputEventListener> = new Set();
  private processedDiscreteEvents: Set<string> = new Set(); // Track processed button presses
  private lastProcessedTimestamps: Map<string, number> = new Map(); // playerId_inputType -> last timestamp

  /**
   * Process a raw input from broadcast message
   * Determines if it's continuous or discrete and updates state accordingly
   */
  processInput(
    playerId: string,
    inputType: InputType,
    value: Record<string, any>,
    timestamp: number,
  ): void {
    try {
      const inputKey = `${playerId}_${inputType}_${timestamp}`;

      // Determine input category
      const isContinuous = inputType.startsWith("joystick_");
      const isDiscrete = inputType.startsWith("button_");

      // For continuous inputs, check timestamp to avoid reprocessing
      // For discrete inputs, we use the processedDiscreteEvents Set instead
      if (isContinuous) {
        const timestampKey = `${playerId}_${inputType}`;
        const lastTimestamp = this.lastProcessedTimestamps.get(timestampKey);
        if (lastTimestamp && timestamp <= lastTimestamp) {
          return; // Already processed
        }
        this.lastProcessedTimestamps.set(timestampKey, timestamp);
      }

      if (isContinuous) {
        // Continuous input: joystick - ONLY keep the latest state, no logging
        if (
          typeof value.x === "number" &&
          typeof value.y === "number"
        ) {
          const event: ContinuousInputState = {
            type: "continuous",
            inputType,
            value: { x: value.x, y: value.y },
            timestamp: BigInt(timestamp),
          };
          // Just update state and emit - no logging for performance
          this.updateInputState(playerId, inputType, event);
          this.emitEvent(event, playerId);
        }
      } else if (isDiscrete) {
        // Discrete input: button - only log button presses
        if (
          typeof value.pressed === "boolean" &&
          value.pressed === true
        ) {
          // Only process press events (not release)
          // Check if we've already processed this exact event (by unique key)
          if (!this.processedDiscreteEvents.has(inputKey)) {
            this.processedDiscreteEvents.add(inputKey);

            const event: DiscreteInputEvent = {
              type: "discrete",
              inputType,
              value: { pressed: true },
              timestamp: BigInt(timestamp),
            };
            this.updateInputState(playerId, inputType, event);
            this.emitEvent(event, playerId);
          }
        }
      }
    } catch (error) {
      console.error("[InputManager] Error processing input:", error);
    }
  }

  /**
   * Update the input state for a player
   */
  private updateInputState(
    playerId: string,
    inputType: InputType,
    event: InputEvent,
  ): void {
    if (!this.playerInputStates.has(playerId)) {
      this.playerInputStates.set(playerId, new Map());
    }
    const playerState = this.playerInputStates.get(playerId)!;
    playerState.set(inputType, event);
  }

  /**
   * Emit an event to all listeners
   */
  private emitEvent(event: InputEvent, playerId: string): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event, playerId);
      } catch (error) {
        console.error("Error in input event listener:", error);
      }
    });
  }

  /**
   * Add an event listener
   */
  addEventListener(listener: InputEventListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove an event listener
   */
  removeEventListener(listener: InputEventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Get the current input state for a player
   */
  getPlayerInputState(playerId: string): Map<InputType, InputEvent> | undefined {
    return this.playerInputStates.get(playerId);
  }

  /**
   * Get all player IDs that have input state
   */
  getPlayerIds(): string[] {
    return Array.from(this.playerInputStates.keys());
  }

  /**
   * Cleanup old processed events to prevent memory leaks
   */
  cleanup(maxSize: number = 1000): void {
    if (this.processedDiscreteEvents.size > maxSize) {
      // Clear all processed events (they're one-time events anyway)
      this.processedDiscreteEvents.clear();
    }
  }

  /**
   * Process a WebRTC message (called from WebRTCManager)
   * Supports both single inputs (legacy) and batched inputs (new)
   */
  handleWebRTCMessage(message: WebRTCMessage, playerId: string): void {
    const timestamp = message.timestamp || Date.now();

    // Handle batched inputs (new format - more efficient)
    if (message.type === "player_input_batch" && message.inputs) {
      const inputs = message.inputs as Record<string, any>;
      
      // Process all inputs in the batch
      for (const [inputType, value] of Object.entries(inputs)) {
        if (value) {
          this.processInput(playerId, inputType as InputType, value, timestamp);
        }
      }
      return;
    }

    // Handle single input (legacy format)
    if (message.type !== "player_input") {
      return;
    }

    const inputType = message.inputType as InputType;
    const value = message.value;

    // For discrete inputs, check if already processed
    if (inputType && inputType.startsWith("button_")) {
      const inputKey = `${playerId}_${inputType}_${timestamp}`;
      if (this.processedDiscreteEvents.has(inputKey)) {
        return; // Skip already processed discrete events
      }
    }

    // Process the input silently (no logging for performance)
    if (inputType && value) {
      this.processInput(playerId, inputType, value, timestamp);
    }
  }

  /**
   * Subscribe to WebRTC messages (no-op, kept for compatibility)
   * Actual subscription is handled by WebRTCManager
   */
  async subscribeToSession(sessionId: number): Promise<void> {
    // No-op - WebRTCManager handles the connection
    console.log(`[InputManager] Ready to process inputs for session ${sessionId}`);
  }

  /**
   * Unsubscribe (no-op, kept for compatibility)
   */
  unsubscribe(): void {
    // No-op - WebRTCManager handles cleanup
  }

  /**
   * Clear all state (useful for testing or reset)
   */
  clear(): void {
    this.unsubscribe();
    this.playerInputStates.clear();
    this.processedDiscreteEvents.clear();
    this.lastProcessedTimestamps.clear();
    this.listeners.clear();
  }
}
