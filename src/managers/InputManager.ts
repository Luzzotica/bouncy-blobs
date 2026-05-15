import {
  InputEvent,
  InputType,
  ContinuousInputState,
  DiscreteInputEvent,
  InputEventListener,
} from "../types";
import type { WebRTCMessage } from "../types/webrtc";

export class InputManager {
  private playerInputStates: Map<string, Map<InputType, InputEvent>> = new Map();
  private listeners: Set<InputEventListener> = new Set();
  private processedDiscreteEvents: Set<string> = new Set();
  private lastProcessedTimestamps: Map<string, number> = new Map();

  processInput(
    playerId: string,
    inputType: InputType,
    value: Record<string, any>,
    timestamp: number,
  ): void {
    const isContinuous = inputType.startsWith("joystick_");
    const isDiscrete = inputType.startsWith("button_");

    if (isContinuous) {
      const timestampKey = `${playerId}_${inputType}`;
      const lastTimestamp = this.lastProcessedTimestamps.get(timestampKey);
      if (lastTimestamp && timestamp <= lastTimestamp) return;
      this.lastProcessedTimestamps.set(timestampKey, timestamp);

      if (typeof value.x === "number" && typeof value.y === "number") {
        const event: ContinuousInputState = {
          type: "continuous",
          inputType,
          value: { x: value.x, y: value.y },
          timestamp: BigInt(timestamp),
        };
        this.updateInputState(playerId, inputType, event);
        this.emitEvent(event, playerId);
      }
    } else if (isDiscrete) {
      if (typeof value.pressed === "boolean") {
        const inputKey = `${playerId}_${inputType}_${timestamp}`;
        if (value.pressed && !this.processedDiscreteEvents.has(inputKey)) {
          this.processedDiscreteEvents.add(inputKey);
          const event: DiscreteInputEvent = {
            type: "discrete",
            inputType,
            value: { pressed: true },
            timestamp: BigInt(timestamp),
          };
          this.updateInputState(playerId, inputType, event);
          this.emitEvent(event, playerId);
        } else if (!value.pressed) {
          const event: DiscreteInputEvent = {
            type: "discrete",
            inputType,
            value: { pressed: false },
            timestamp: BigInt(timestamp),
          };
          this.updateInputState(playerId, inputType, event);
          this.emitEvent(event, playerId);
        }
      }
    }
  }

  private updateInputState(playerId: string, inputType: InputType, event: InputEvent): void {
    if (!this.playerInputStates.has(playerId)) {
      this.playerInputStates.set(playerId, new Map());
    }
    this.playerInputStates.get(playerId)!.set(inputType, event);
  }

  private emitEvent(event: InputEvent, playerId: string): void {
    this.listeners.forEach((listener) => {
      try { listener(event, playerId); } catch (e) { console.error("Input listener error:", e); }
    });
  }

  addEventListener(listener: InputEventListener): void { this.listeners.add(listener); }
  removeEventListener(listener: InputEventListener): void { this.listeners.delete(listener); }

  getPlayerInputState(playerId: string): Map<InputType, InputEvent> | undefined {
    return this.playerInputStates.get(playerId);
  }

  getPlayerIds(): string[] {
    return Array.from(this.playerInputStates.keys());
  }

  handleWebRTCMessage(message: WebRTCMessage, playerId: string): void {
    const timestamp = message.timestamp || Date.now();

    if (message.type === "player_input_batch" && message.inputs) {
      for (const [inputType, value] of Object.entries(message.inputs)) {
        if (value) this.processInput(playerId, inputType as InputType, value, timestamp);
      }
      return;
    }

    if (message.type !== "player_input") return;
    if (message.inputType && message.value) {
      this.processInput(playerId, message.inputType as InputType, message.value, timestamp);
    }
  }

  cleanup(maxSize: number = 1000): void {
    if (this.processedDiscreteEvents.size > maxSize) {
      this.processedDiscreteEvents.clear();
    }
  }

  clear(): void {
    this.playerInputStates.clear();
    this.processedDiscreteEvents.clear();
    this.lastProcessedTimestamps.clear();
    this.listeners.clear();
  }
}
