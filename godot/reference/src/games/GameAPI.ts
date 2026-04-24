import { ControllerLayout } from "../types/controllerConfig";

/**
 * API object exposed to games for interacting with the session
 */
export interface GameAPI {
  /**
   * Update the controller layout for this session
   * @param layout The new controller layout
   */
  updateControllerLayout(layout: ControllerLayout): void;
}
