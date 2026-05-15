export type InputType =
  | 'joystick_left'
  | 'joystick_right'
  | 'button_left'
  | 'button_right';

export interface JoystickValue {
  x: number;
  y: number;
}

export interface ButtonValue {
  pressed: boolean;
}

export type InputValue = JoystickValue | ButtonValue | string;

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
  gameId: string;
  createdAt: number;
  isActive: boolean;
  defaultControllerConfig: string;
}
