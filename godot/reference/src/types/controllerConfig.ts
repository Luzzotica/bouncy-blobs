// Controller Configuration Types

export type InputSlotType = "joystick" | "button";

export interface ControllerInputConfig {
  type: InputSlotType;
  id?: string;
  label?: string;
  // Future extensions:
  // position?: "left" | "right" | "top" | "bottom";
  // color?: string;
  // sensitivity?: number;
}

export type ControllerLayout = {
  left: InputSlotType;
  right: InputSlotType;
};

export interface ControllerConfigJSON {
  layout: {
    left: ControllerInputConfig;
    right: ControllerInputConfig;
  };
}

const defaultLeftConfig: ControllerInputConfig = {
  type: "joystick",
  label: "Left Input",
};

const defaultRightConfig: ControllerInputConfig = {
  type: "button",
  label: "Right Input",
};

export const DEFAULT_CONTROLLER_LAYOUT: ControllerLayout = {
  left: defaultLeftConfig.type,
  right: defaultRightConfig.type,
};

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfigJSON = {
  layout: {
    left: { ...defaultLeftConfig },
    right: { ...defaultRightConfig },
  },
};

/**
 * Create a normalized controller config object from layout choices
 */
export function buildControllerConfig(
  layout: ControllerLayout,
  labels?: { left?: string; right?: string },
): ControllerConfigJSON {
  return {
    layout: {
      left: {
        type: layout.left,
        label: labels?.left ?? defaultLeftConfig.label,
      },
      right: {
        type: layout.right,
        label: labels?.right ?? defaultRightConfig.label,
      },
    },
  };
}

/**
 * Convert controller config to JSON string for reducers
 */
export function controllerConfigToJSON(config: ControllerConfigJSON): string {
  return JSON.stringify(config);
}

const normalizeType = (
  candidate: any,
  fallback: InputSlotType,
): InputSlotType => {
  // Check for explicit joystick or button type
  if (candidate === "joystick") return "joystick";
  if (candidate === "button") return "button";
  // If candidate has a type property, check that
  if (candidate?.type === "joystick") return "joystick";
  if (candidate?.type === "button") return "button";
  // Otherwise use fallback
  return fallback;
};

const normalizeInputConfig = (
  candidate: any,
  fallback: ControllerInputConfig,
): ControllerInputConfig => ({
  type: normalizeType(candidate?.type, fallback.type),
  label:
    typeof candidate?.label === "string" ? candidate.label : fallback.label,
});

/**
 * Parse controller config JSON string (supports legacy slot arrays)
 */
export function parseControllerConfig(
  json: string | null | undefined,
): ControllerConfigJSON | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (parsed.layout && typeof parsed.layout === "object") {
      const left = normalizeInputConfig(
        parsed.layout.left,
        DEFAULT_CONTROLLER_CONFIG.layout.left,
      );
      const right = normalizeInputConfig(
        parsed.layout.right,
        DEFAULT_CONTROLLER_CONFIG.layout.right,
      );
      return {
        layout: { left, right },
      };
    }

    if (Array.isArray(parsed.slots) && parsed.slots.length >= 2) {
      const left = normalizeInputConfig(
        parsed.slots[0],
        DEFAULT_CONTROLLER_CONFIG.layout.left,
      );
      const right = normalizeInputConfig(
        parsed.slots[1],
        DEFAULT_CONTROLLER_CONFIG.layout.right,
      );
      return {
        layout: { left, right },
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Convert ControllerConfigJSON to InputType mapping for the controller component
 */
export function configToInputTypes(config: ControllerConfigJSON): {
  input1: string;
  input2: string;
} {
  const leftType = config.layout.left?.type ?? DEFAULT_CONTROLLER_LAYOUT.left;
  const rightType =
    config.layout.right?.type ?? DEFAULT_CONTROLLER_LAYOUT.right;

  const input1 = leftType === "joystick" ? "joystick_left" : "button_left";
  const input2 = rightType === "joystick" ? "joystick_right" : "button_right";

  return { input1, input2 };
}
