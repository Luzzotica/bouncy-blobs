import {
  ControllerConfigJSON,
  ControllerLayout,
  DEFAULT_CONTROLLER_LAYOUT,
} from "../types/controllerConfig";
import { GameContext } from "./GameInterface";

export type SlotKey = "left" | "right";

export const layoutFromConfig = (
  config: ControllerConfigJSON | null,
): ControllerLayout => {
  if (!config || !config.layout) {
    return DEFAULT_CONTROLLER_LAYOUT;
  }
  const leftType = config.layout.left?.type ?? DEFAULT_CONTROLLER_LAYOUT.left;
  const rightType =
    config.layout.right?.type ?? DEFAULT_CONTROLLER_LAYOUT.right;
  return {
    left: leftType === "button" ? "button" : "joystick",
    right: rightType === "button" ? "button" : "joystick",
  };
};

export const getSessionControllerLayout = (
  context: GameContext,
): ControllerLayout => {
  // Controller layout is now stored in context.gameState
  // This function is deprecated - use context.gameState.controllerLayout instead
  return (context.gameState.controllerLayout as ControllerLayout) || DEFAULT_CONTROLLER_LAYOUT;
};

export const updateSessionControllerLayout = (
  context: GameContext,
  layout: ControllerLayout,
) => {
  // Use the GameAPI to update controller layout
  // This ensures the update goes through Supabase
  try {
    context.api.updateControllerLayout(layout);
    console.log("[ControllerTest] Updated controller layout:", layout);
  } catch (error) {
    console.error(
      "[ControllerTest] Failed to update controller layout:",
      error,
    );
  }
};
