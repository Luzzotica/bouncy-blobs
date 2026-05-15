import type { Player } from "./database";

export interface WebRTCMessage {
  type: string;
  playerId?: string;
  inputType?: string;
  value?: any;
  timestamp?: number;
  config?: any;
  reason?: string;
  player?: Player;
  inputs?: {
    joystick_left?: { x: number; y: number };
    joystick_right?: { x: number; y: number };
    button_left?: { pressed: boolean };
    button_right?: { pressed: boolean };
  };
}
