export type InputSlotType = "joystick" | "button";

export interface ControllerInputConfig {
  type: InputSlotType;
  id?: string;
  label?: string;
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
  label: "Move",
};

const defaultRightConfig: ControllerInputConfig = {
  type: "button",
  label: "Expand",
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

export function parseControllerConfig(
  json: string | null | undefined,
): ControllerConfigJSON | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;

    if (parsed.layout && typeof parsed.layout === "object") {
      return {
        layout: {
          left: normalizeInputConfig(parsed.layout.left, DEFAULT_CONTROLLER_CONFIG.layout.left),
          right: normalizeInputConfig(parsed.layout.right, DEFAULT_CONTROLLER_CONFIG.layout.right),
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeInputConfig(
  candidate: any,
  fallback: ControllerInputConfig,
): ControllerInputConfig {
  const type = candidate?.type === "joystick" || candidate?.type === "button"
    ? candidate.type
    : fallback.type;
  return {
    type,
    label: typeof candidate?.label === "string" ? candidate.label : fallback.label,
  };
}

export function configToInputTypes(config: ControllerConfigJSON): {
  input1: string;
  input2: string;
} {
  const leftType = config.layout.left?.type ?? DEFAULT_CONTROLLER_LAYOUT.left;
  const rightType = config.layout.right?.type ?? DEFAULT_CONTROLLER_LAYOUT.right;
  return {
    input1: leftType === "joystick" ? "joystick_left" : "button_left",
    input2: rightType === "joystick" ? "joystick_right" : "button_right",
  };
}
