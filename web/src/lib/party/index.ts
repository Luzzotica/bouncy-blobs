export { SignalingService } from "./SignalingService";
export { HostWebRTCManager, ControllerWebRTCManager } from "./WebRTCManager";
export type {
  PartySession,
  PartyPlayer,
  Signal,
  CreateSessionResult,
  JoinSessionResult,
  PollSignalsResult,
  PartyClientConfig,
  HostCallbacks,
  ControllerCallbacks,
  SessionStatus,
  PlayerStatus,
  SignalType,
  SessionSummary,
  ListSessionsResult,
} from "./types";

import { SignalingService } from "./SignalingService";
import { HostWebRTCManager, ControllerWebRTCManager } from "./WebRTCManager";
import type {
  PartyClientConfig,
  HostCallbacks,
  ControllerCallbacks,
  CreateSessionResult,
  JoinSessionResult,
} from "./types";

// ─── Convenience factories ────────────────────────────────────────────────────

export async function createHostSession(
  config: PartyClientConfig,
  options?: { game_id?: string; max_players?: number; metadata?: Record<string, unknown> },
  callbacks?: HostCallbacks,
): Promise<{
  result: CreateSessionResult;
  manager: HostWebRTCManager;
  signaling: SignalingService;
}> {
  const signaling = new SignalingService(config);
  const result = await signaling.createSession(options);

  const manager = new HostWebRTCManager(result.session_id, signaling, callbacks ?? {});

  // Host polls for answers + ICE candidates from players
  signaling.startPolling(result.session_id, "host", (signal) => {
    return manager.handleSignal(signal);
  });

  return { result, manager, signaling };
}

export async function joinAsController(
  config: PartyClientConfig,
  sessionId: string,
  displayName: string,
  callbacks?: ControllerCallbacks,
): Promise<{
  result: JoinSessionResult;
  manager: ControllerWebRTCManager;
  signaling: SignalingService;
}> {
  const signaling = new SignalingService(config);
  const result = await signaling.joinSession(sessionId, displayName);

  const manager = new ControllerWebRTCManager(
    sessionId,
    result.player_id,
    signaling,
    callbacks ?? {},
  );
  manager.startListening();

  return { result, manager, signaling };
}
