// Type definitions for the party game system

export type InputType = 
  | 'joystick_left'
  | 'joystick_right'
  | 'button_left'
  | 'button_right';

export interface ControllerConfig {
  input1: InputType;
  input2: InputType;
}

export interface JoystickValue {
  x: number; // -1 to 1
  y: number; // -1 to 1
}

export interface ButtonValue {
  pressed: boolean;
}

export type InputValue = JoystickValue | ButtonValue | string;

// Input Event System Types
export type InputCategory = 'continuous' | 'discrete';

export interface ContinuousInputState {
  type: 'continuous';
  inputType: InputType;
  value: JoystickValue;
  timestamp: bigint;
}

export interface DiscreteInputEvent {
  type: 'discrete';
  inputType: InputType;
  value: ButtonValue;
  timestamp: bigint;
}

export type InputEvent = ContinuousInputState | DiscreteInputEvent;

export interface PlayerInputState {
  playerId: string;
  inputs: Map<InputType, InputEvent>;
}

export type InputEventListener = (event: InputEvent, playerId: string) => void;

export interface Player {
  identity: string;
  name: string;
  connectedAt: number;
  isDisplay: boolean;
}

export interface GameSession {
  sessionId: number;
  gameId: string; // Changed from gameType to gameId
  createdAt: number;
  isActive: boolean;
  defaultControllerConfig: string;
}

export interface PlayerInput {
  inputId: number;
  playerIdentity: string;
  sessionId: number;
  inputType: string;
  value: string;
  timestamp: number;
}

export interface GameEntity {
  entityId: number;
  sessionId: number;
  entityType: number;
  positionX: number;
  positionY: number;
  positionZ: number;
  rotationX: number; // Quaternion x
  rotationY: number; // Quaternion y
  rotationZ: number; // Quaternion z
  rotationW: number; // Quaternion w
  updatedAt: number;
}

export interface TriggerEvent {
  eventId: number;
  triggerEntityId: number; // The trigger that was triggered
  entityId: number; // The entity that entered/exited
  eventType: 'enter' | 'exit';
  sessionId: number;
  timestamp: number;
}
