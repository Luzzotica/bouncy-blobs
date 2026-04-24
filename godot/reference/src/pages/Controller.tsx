import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { FloatingJoystick } from "../components/FloatingJoystick";
import { FloatingButton } from "../components/FloatingButton";
import { InputType } from "../types";
import {
  parseControllerConfig,
  configToInputTypes,
  ControllerConfigJSON,
} from "../types/controllerConfig";
import { supabase } from "../lib/supabase";
import { useUser } from "../contexts/UserContext";
import { getAnonymousIdForSession, clearSessionPlayerId } from "../utils/anonymousUser";

// Session persistence keys
const SESSION_STATE_KEY = 'partii_controller_session';

interface PersistedSessionState {
  sessionId: string;
  playerName: string;
  playerId: string;
  timestamp: number;
}

// Save session state to localStorage
function saveSessionState(sessionId: string, playerName: string, playerId: string): void {
  const state: PersistedSessionState = {
    sessionId,
    playerName,
    playerId,
    timestamp: Date.now(),
  };
  localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(state));
  console.log('[Controller] Saved session state:', state);
}

// Get saved session state (if still valid - within 1 hour)
function getSavedSessionState(sessionId: string): PersistedSessionState | null {
  try {
    const saved = localStorage.getItem(SESSION_STATE_KEY);
    if (!saved) return null;
    
    const state: PersistedSessionState = JSON.parse(saved);
    
    // Check if it's for the same session
    if (state.sessionId !== sessionId) {
      console.log('[Controller] Saved session is for different session, clearing old state');
      clearSavedSessionState(); // Clear old state for different session
      return null;
    }
    
    // Check if it's still valid (within 1 hour)
    const ONE_HOUR = 60 * 60 * 1000;
    if (Date.now() - state.timestamp > ONE_HOUR) {
      console.log('[Controller] Saved session expired');
      clearSavedSessionState();
      return null;
    }
    
    console.log('[Controller] Found valid saved session state:', state);
    return state;
  } catch (e) {
    console.error('[Controller] Error reading saved session state:', e);
    clearSavedSessionState(); // Clear corrupted state
    return null;
  }
}

// Clear saved session state
function clearSavedSessionState(): void {
  localStorage.removeItem(SESSION_STATE_KEY);
  console.log('[Controller] Cleared saved session state');
}
import type { GameSession } from "../types/database";
import { WebRTCManager, type WebRTCMessage } from "../managers/WebRTCManager";

// Landing page component when no session ID is provided
const ControllerLanding: React.FC = () => {
  const navigate = useNavigate();
  const [gameCode, setGameCode] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const handleJoinGame = () => {
    const code = gameCode.trim();
    if (code) {
      navigate(`/controller/${code}`);
    }
  };

  const startScanner = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setShowScanner(true);
    } catch (err) {
      console.error("Camera access denied:", err);
      alert("Could not access camera. Please enter the game code manually.");
    }
  };

  const stopScanner = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setShowScanner(false);
  };

  // Simple QR detection using BarcodeDetector API (if available)
  useEffect(() => {
    if (!showScanner || !videoRef.current) return;

    // Check if BarcodeDetector is available
    if (!("BarcodeDetector" in window)) {
      console.log("BarcodeDetector not available - manual entry required");
      return;
    }

    const barcodeDetector = new (window as any).BarcodeDetector({
      formats: ["qr_code"],
    });

    const scanInterval = setInterval(async () => {
      if (videoRef.current && videoRef.current.readyState === 4) {
        try {
          const barcodes = await barcodeDetector.detect(videoRef.current);
          if (barcodes.length > 0) {
            const url = barcodes[0].rawValue;
            // Extract session ID from URL like /controller/123
            const match = url.match(/\/controller\/(\d+)/);
            if (match) {
              stopScanner();
              navigate(`/controller/${match[1]}`);
            }
          }
        } catch {
          // Ignore detection errors
        }
      }
    }, 200);

    return () => clearInterval(scanInterval);
  }, [showScanner, navigate]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-black to-indigo-900 flex items-center justify-center p-4">
      <div className="bg-white/10 backdrop-blur-lg rounded-3xl shadow-2xl p-8 max-w-md w-full border-2 border-purple-400 shadow-lg shadow-purple-500/50">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">Join Game</h1>
          <p className="text-white/80">Scan a QR code or enter your game code</p>
        </div>

        {showScanner ? (
          <div className="space-y-4">
            <div className="relative rounded-2xl overflow-hidden bg-black aspect-square">
              <video
                ref={videoRef}
                className="w-full h-full object-cover"
                playsInline
                muted
              />
              <div className="absolute inset-0 border-4 border-purple-400/50 rounded-2xl pointer-events-none">
                <div className="absolute inset-8 border-2 border-purple-300/50 rounded-lg" />
              </div>
            </div>
            <p className="text-white/70 text-sm text-center">
              Point your camera at the QR code on the game screen
            </p>
            <button
              onClick={stopScanner}
              className="w-full bg-white/20 text-white py-3 rounded-xl font-semibold hover:bg-white/30 transition border border-white/20"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <button
              onClick={startScanner}
              className="w-full bg-white text-purple-600 py-4 rounded-xl font-bold text-lg hover:bg-gray-100 transition flex items-center justify-center gap-3"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Scan QR Code
            </button>

            <div className="text-center">
              <span className="text-white/70 text-sm">or enter code</span>
            </div>

            <div className="space-y-3">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Game Code"
                value={gameCode}
                onChange={(e) => setGameCode(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === "Enter") handleJoinGame();
                }}
                className="w-full px-4 py-4 bg-white/20 border-2 border-white/30 rounded-xl text-white text-center text-2xl font-mono placeholder-white/50 focus:outline-none focus:border-purple-400/60"
              />
              <button
                onClick={handleJoinGame}
                disabled={!gameCode.trim()}
                className="w-full bg-gradient-to-r from-purple-600 to-pink-600 text-white py-4 rounded-xl font-bold text-lg hover:from-purple-700 hover:to-pink-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Join Game
              </button>
            </div>
          </div>
        )}

        <div className="mt-8 text-center">
          <button
            onClick={() => {
              // Clear any saved session state when navigating back
              clearSavedSessionState();
              navigate("/");
            }}
            className="text-white/70 hover:text-white text-sm underline bg-transparent border-none cursor-pointer"
          >
            ← Back to Home
          </button>
        </div>
      </div>
    </div>
  );
};

export const Controller: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { user, anonymousId } = useUser();
  const [playerName, setPlayerName] = useState("");
  const [isJoined, setIsJoined] = useState(false);
  const [wasKicked, setWasKicked] = useState(false);
  const [kickReason, setKickReason] = useState<string | null>(null);
  const [config, setConfig] = useState<{
    input1: InputType;
    input2: InputType;
  }>({
    input1: "joystick_left",
    input2: "button_right",
  });
  const [controllerConfigJSON, setControllerConfigJSON] =
    useState<ControllerConfigJSON | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isValidatingSession, setIsValidatingSession] = useState(true);
  const [session, setSession] = useState<GameSession | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | null>(null);
  const [isAutoReconnecting, setIsAutoReconnecting] = useState(false);
  const webrtcManagerRef = useRef<WebRTCManager | null>(null);
  const playerIdRef = useRef<string | null>(null);
  const sessionRef = useRef<GameSession | null>(null); // Use ref to avoid stale closures
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const hasAttemptedAutoReconnect = useRef(false);
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY_MS = 2000;
  
  // Batched input system - store current input state and send at 60 FPS
  const INPUT_SEND_INTERVAL_MS = 16; // ~60 FPS
  const inputStateRef = useRef<{
    joystick_left: { x: number; y: number };
    joystick_right: { x: number; y: number };
    button_left: { pressed: boolean };
    button_right: { pressed: boolean };
  }>({
    joystick_left: { x: 0, y: 0 },
    joystick_right: { x: 0, y: 0 },
    button_left: { pressed: false },
    button_right: { pressed: false },
  });
  const lastSentStateRef = useRef<string>(""); // JSON stringified last sent state for change detection
  const inputSendIntervalRef = useRef<number | null>(null);

  const applyConfigFromJSON = useCallback(
    (jsonConfig: string | null | undefined): boolean => {
      if (!jsonConfig) {
        console.warn("[Controller] Step 4.1: No JSON config provided");
        return false;
      }
      console.log("[Controller] Step 4.1: applyConfigFromJSON called with:", jsonConfig);
      const parsed = parseControllerConfig(jsonConfig);
      console.log("[Controller] Step 4.2: Parsed config:", parsed);
      if (!parsed) {
        console.warn("[Controller] Step 4.2 FAILED: Failed to parse config");
        return false;
      }
      console.log("[Controller] Step 4.3: Setting controllerConfigJSON:", {
        left: parsed.layout?.left,
        right: parsed.layout?.right,
      });
      setControllerConfigJSON(parsed);
      const inputTypes = configToInputTypes(parsed);
      console.log("[Controller] Step 4.4: Input types derived:", inputTypes);
      setConfig({
        input1: inputTypes.input1 as InputType,
        input2: inputTypes.input2 as InputType,
      });
      console.log("[Controller] Step 4.5 SUCCESS: Config state updated");
      return true;
    },
    [],
  );

  const applySessionConfig = useCallback(
    (session: GameSession) => {
      const defaultConfig = session.default_controller_config;

      console.log("[Controller] Step 4: applySessionConfig called", {
        sessionId: session.session_id,
        configType: typeof defaultConfig,
        configValue: defaultConfig,
      });

      const configString = typeof defaultConfig === 'string' 
        ? defaultConfig 
        : JSON.stringify(defaultConfig);
      
      console.log("[Controller] Step 4: Config string to parse:", configString);

      if (applyConfigFromJSON(configString)) {
        console.log("[Controller] Step 4 SUCCESS: Config applied successfully");
        return;
      }

      console.warn(
        "[Controller] Step 4 FAILED: No valid controller config found in session, keeping local defaults",
        { defaultConfig },
      );
    },
    [applyConfigFromJSON],
  );

  // Fetch and subscribe to session changes (including controller config)
  useEffect(() => {
    if (!sessionId) return;

    const sessionIdNum = parseInt(sessionId, 10);
    if (isNaN(sessionIdNum)) {
      setSessionError("Invalid session ID");
      setIsValidatingSession(false);
      return;
    }

    // Reset state when sessionId changes
    setIsValidatingSession(true);
    setSessionError(null);
    setIsJoined(false);
    setIsConnecting(false);
    setIsAutoReconnecting(false);
    setWasKicked(false);
    setKickReason(null);
    setPlayerName("");
    setConnectionState(null);
    hasAttemptedAutoReconnect.current = false;
    
    // Check for saved session state (this will clear old state if for different session)
    getSavedSessionState(sessionId);
    
    // Clean up any existing WebRTC manager when sessionId changes
    if (webrtcManagerRef.current) {
      console.log("[Controller] Cleaning up WebRTC manager due to sessionId change");
      webrtcManagerRef.current.closeAll();
      webrtcManagerRef.current = null;
    }
    
    // Reset player ID when session changes
    playerIdRef.current = null;

    // Initial fetch
    const fetchSession = async () => {
      try {
        const { data, error } = await supabase
          .from("game_sessions")
          .select("*")
          .eq("session_id", sessionIdNum)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("Session not found");
        }

        if (!data.is_active) {
          throw new Error("Session is no longer active");
        }

        setSession(data);
        sessionRef.current = data; // Update ref
        applySessionConfig(data);
        setIsValidatingSession(false);
      } catch (err: any) {
        console.error("Error fetching session:", err);
        setSessionError(err.message || "Failed to load session");
        setIsValidatingSession(false);
      }
    };

    fetchSession();

    return () => {
      // Cleanup handled in joinSession/unmount
    };
  }, [sessionId, applySessionConfig, applyConfigFromJSON]);

  // Auto-reconnect if we have a saved session state (e.g., after phone wakes from sleep)
  useEffect(() => {
    if (!sessionId || isValidatingSession || hasAttemptedAutoReconnect.current) return;
    if (isJoined || isConnecting || isAutoReconnecting) return;
    if (sessionError) return;

    const savedState = getSavedSessionState(sessionId);
    if (!savedState) return;

    // Mark that we've attempted auto-reconnect to avoid loops
    hasAttemptedAutoReconnect.current = true;
    
    console.log('[Controller] Attempting auto-reconnect with saved state');
    setIsAutoReconnecting(true);
    setPlayerName(savedState.playerName);
    playerIdRef.current = savedState.playerId;

    // Attempt to reconnect
    const autoReconnect = async () => {
      try {
        const sessionIdNum = parseInt(sessionId, 10);
        if (isNaN(sessionIdNum)) throw new Error("Invalid session ID");

        // Check if player still exists in database
        const { data: existingPlayer } = await supabase
          .from("players")
          .select("*")
          .eq("session_id", sessionIdNum)
          .eq("anonymous_id", savedState.playerId)
          .maybeSingle();

        if (!existingPlayer) {
          // Player was removed, need to re-join with new ID
          console.log('[Controller] Player record not found, need to rejoin');
          clearSavedSessionState();
          setIsAutoReconnecting(false);
          playerIdRef.current = null;
          return;
        }

        console.log('[Controller] Player record exists, reconnecting WebRTC');
        
        // Set joined state and start connecting
        setIsJoined(true);
        setIsConnecting(true);

        // Initialize WebRTC connection
        const webrtcManager = new WebRTCManager(sessionIdNum, "controller");
        webrtcManager.setPlayerId(savedState.playerId);
        webrtcManagerRef.current = webrtcManager;

        await webrtcManager.initializeAsController(
          (message: WebRTCMessage) => {
            if (message.type === "controller_config_update") {
              const configString = typeof message.config === "string"
                ? message.config
                : JSON.stringify(message.config);
              if (applyConfigFromJSON(configString)) {
                const currentSession = sessionRef.current;
                if (currentSession) {
                  const updatedSession: GameSession = {
                    ...currentSession,
                    default_controller_config: message.config,
                  };
                  setSession(updatedSession);
                  sessionRef.current = updatedSession;
                }
              }
            } else if (message.type === "session_ended") {
              console.log("[Controller] Session ended by GameMaster:", message.reason);
              setWasKicked(true);
              setKickReason(message.reason || "The game session has ended");
              setIsJoined(false);
              setIsConnecting(false);
              setIsAutoReconnecting(false);
              webrtcManager.closeAll();
              clearSavedSessionState();
              playerIdRef.current = null;
            }
          },
          (state: RTCPeerConnectionState) => {
            console.log(`[Controller] Auto-reconnect WebRTC state: ${state}`);
            setConnectionState(state);
            
            if (state === "connected") {
              setIsConnecting(false);
              setIsAutoReconnecting(false);
              // Re-save session state with updated timestamp
              saveSessionState(sessionId, savedState.playerName, savedState.playerId);
            } else if (state === "failed" || state === "closed") {
              // Auto-reconnect failed, user needs to manually rejoin
              console.log("[Controller] Auto-reconnect failed");
              setIsJoined(false);
              setIsConnecting(false);
              setIsAutoReconnecting(false);
              clearSavedSessionState();
              playerIdRef.current = null;
              if (webrtcManagerRef.current) {
                webrtcManagerRef.current.closeAll();
                webrtcManagerRef.current = null;
              }
            } else if (state === "connecting") {
              setIsConnecting(true);
            }
          },
        );

        console.log("[Controller] Auto-reconnect WebRTC initialized");
      } catch (error) {
        console.error("[Controller] Auto-reconnect failed:", error);
        setIsAutoReconnecting(false);
        setIsJoined(false);
        setIsConnecting(false);
        clearSavedSessionState();
        playerIdRef.current = null;
      }
    };

    autoReconnect();
  }, [sessionId, isValidatingSession, sessionError, isJoined, isConnecting, isAutoReconnecting, applyConfigFromJSON]);

  const joinSession = async () => {
    if (!sessionId || sessionError) {
      alert("Cannot join: " + (sessionError || "Invalid session"));
      return;
    }

    try {
      const sessionIdNum = parseInt(sessionId, 10);
      if (isNaN(sessionIdNum)) {
        throw new Error("Invalid session ID");
      }

      const name = playerName || `Player ${Date.now()}`;

      // Generate session-specific anonymous ID to ensure uniqueness
      // This ensures each device is treated as a different user per session
      const sessionAnonymousId = user ? null : getAnonymousIdForSession(sessionIdNum);

      console.log("Controller - Joining as player:", {
        sessionId: sessionIdNum,
        name,
        userId: user?.id || null,
        deviceAnonymousId: anonymousId,
        sessionAnonymousId: sessionAnonymousId,
      });

      // Insert player record
      const playerData: any = {
        session_id: sessionIdNum,
        name,
        is_display: false,
      };

      if (user) {
        playerData.user_id = user.id;
        playerData.anonymous_id = null;
      } else {
        playerData.user_id = null;
        playerData.anonymous_id = sessionAnonymousId; // Use session-specific ID
      }

      // Try to insert, but if player already exists (e.g., reconnecting after sleep), that's okay
      const { error: insertError } = await supabase
        .from("players")
        .insert(playerData);

      if (insertError) {
        // If it's a duplicate key error, the player already exists - that's fine for reconnection
        if (insertError.code === '23505') {
          console.log("[Controller] Player record already exists, continuing with reconnection");
        } else {
          throw insertError;
        }
      }

      // Store player ID for broadcasting (use session-specific anonymous ID)
      playerIdRef.current = user?.id || sessionAnonymousId || anonymousId;

      // Fetch fresh session config after joining to ensure we have the latest
      // This is important because the session might have been updated since initial load
      const fetchLatestConfig = async () => {
        try {
          const { data: latestSession, error } = await supabase
            .from("game_sessions")
            .select("default_controller_config")
            .eq("session_id", sessionIdNum)
            .maybeSingle();
          
          if (error) {
            console.error("[Controller] Failed to fetch latest config:", error);
            return;
          }
          
          if (latestSession && latestSession.default_controller_config) {
            console.log("[Controller] Applying latest config after joining:", latestSession.default_controller_config);
            const configString = typeof latestSession.default_controller_config === 'string'
              ? latestSession.default_controller_config
              : JSON.stringify(latestSession.default_controller_config);
            applyConfigFromJSON(configString);
          } else {
            // Fallback to session state if available
            const currentGameSession = sessionRef.current;
            if (currentGameSession) {
              console.log("[Controller] Applying session config from state after joining:", currentGameSession.default_controller_config);
              applySessionConfig(currentGameSession);
            }
          }
        } catch (err) {
          console.error("[Controller] Error fetching latest config:", err);
          // Fallback to session state
          const currentGameSession = sessionRef.current;
          if (currentGameSession) {
            console.log("[Controller] Fallback: Applying session config from state:", currentGameSession.default_controller_config);
            applySessionConfig(currentGameSession);
          }
        }
      };
      
      await fetchLatestConfig();

      // Clean up any existing WebRTC manager before creating a new one
      if (webrtcManagerRef.current) {
        console.log("[Controller] Cleaning up existing WebRTC manager before reconnecting");
        webrtcManagerRef.current.closeAll();
        webrtcManagerRef.current = null;
      }

      // Set connecting state
      setIsConnecting(true);
      setConnectionState(null);
      setIsJoined(true); // Set joined immediately so we show connecting UI

      // Initialize WebRTC connection to GameMaster
      const webrtcManager = new WebRTCManager(sessionIdNum, "controller");
      // Set playerId after creating manager
      if (playerIdRef.current) {
        webrtcManager.setPlayerId(playerIdRef.current);
      }
      webrtcManagerRef.current = webrtcManager;

      // Initialize WebRTC with message handlers
      await webrtcManager.initializeAsController(
        (message: WebRTCMessage) => {
          // Handle incoming messages from GameMaster
          if (message.type === "controller_config_update") {
            console.log("[Controller] Config update received via WebRTC:", message.config);
            const configString =
              typeof message.config === "string"
                ? message.config
                : JSON.stringify(message.config);

            if (applyConfigFromJSON(configString)) {
              // Update session state if we have it
              const currentSession = sessionRef.current;
              if (currentSession) {
                const updatedSession: GameSession = {
                  ...currentSession,
                  default_controller_config: message.config,
                };
                setSession(updatedSession);
                sessionRef.current = updatedSession;
              }
            }
          } else if (message.type === "session_ended") {
            console.log("[Controller] Session ended by GameMaster:", message.reason);
            const reason = message.reason || "The game session has ended";
            setWasKicked(true);
            setKickReason(reason);
            setIsJoined(false);
            setIsConnecting(false);
            webrtcManager.closeAll();
            clearSavedSessionState();
            playerIdRef.current = null;
          }
        },
        (state: RTCPeerConnectionState) => {
          console.log(`[Controller] WebRTC connection state: ${state}`);
          setConnectionState(state);
          
          // Update connecting state based on connection state
          if (state === "connected") {
            setIsConnecting(false);
            // Reset reconnect attempts on successful connection
            reconnectAttemptRef.current = 0;
            if (reconnectTimeoutRef.current) {
              clearTimeout(reconnectTimeoutRef.current);
              reconnectTimeoutRef.current = null;
            }
            // Save session state for auto-reconnect after sleep/reload
            if (playerIdRef.current) {
              saveSessionState(sessionId, name, playerIdRef.current);
            }
          } else if (state === "failed" || state === "disconnected" || state === "closed") {
            setIsConnecting(false);
            // Attempt to reconnect automatically
            if (reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
              reconnectAttemptRef.current += 1;
              console.log(`[Controller] Connection lost. Attempting reconnect ${reconnectAttemptRef.current}/${MAX_RECONNECT_ATTEMPTS}`);
              
              // Clear any existing reconnect timeout
              if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
              }
              
              reconnectTimeoutRef.current = window.setTimeout(() => {
                attemptReconnect();
              }, RECONNECT_DELAY_MS);
            } else {
              console.log("[Controller] Max reconnect attempts reached. Player needs to rejoin.");
            }
          } else if (state === "connecting") {
            setIsConnecting(true);
          }
        },
      );

      console.log("[Controller] WebRTC connection initialized");
    } catch (error) {
      console.error("Failed to join session:", error);
      alert(
        `Failed to join game session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // Attempt to reconnect after WebRTC disconnection
  const attemptReconnect = async () => {
    if (!sessionId || !playerIdRef.current) {
      console.log("[Controller] Cannot reconnect: missing sessionId or playerId");
      return;
    }

    const sessionIdNum = parseInt(sessionId, 10);
    if (isNaN(sessionIdNum)) return;

    console.log("[Controller] Attempting to reconnect...");
    setIsConnecting(true);

    try {
      // Close existing WebRTC manager and create a new one
      if (webrtcManagerRef.current) {
        // Reset signaling state to allow reconnection
        webrtcManagerRef.current.resetProcessedSignaling();
        webrtcManagerRef.current.closeAll();
        webrtcManagerRef.current = null;
      }

      // Create new WebRTC manager with same player ID
      const webrtcManager = new WebRTCManager(sessionIdNum, "controller");
      webrtcManager.setPlayerId(playerIdRef.current);
      webrtcManagerRef.current = webrtcManager;

      // Re-initialize WebRTC connection
      await webrtcManager.initializeAsController(
        (message: WebRTCMessage) => {
          // Handle incoming messages from GameMaster
          if (message.type === "controller_config_update") {
            const configString =
              typeof message.config === "string"
                ? message.config
                : JSON.stringify(message.config);

            if (applyConfigFromJSON(configString)) {
              const currentSession = sessionRef.current;
              if (currentSession) {
                const updatedSession: GameSession = {
                  ...currentSession,
                  default_controller_config: message.config,
                };
                setSession(updatedSession);
                sessionRef.current = updatedSession;
              }
            }
          } else if (message.type === "session_ended") {
            console.log("[Controller] Session ended by GameMaster:", message.reason);
            const reason = message.reason || "The game session has ended";
            setWasKicked(true);
            setKickReason(reason);
            setIsJoined(false);
            setIsConnecting(false);
            webrtcManager.closeAll();
            playerIdRef.current = null;
          }
        },
        (state: RTCPeerConnectionState) => {
          console.log(`[Controller] Reconnect - WebRTC connection state: ${state}`);
          setConnectionState(state);
          
          if (state === "connected") {
            console.log("[Controller] Reconnection successful!");
            setIsConnecting(false);
            reconnectAttemptRef.current = 0;
          } else if (state === "failed" || state === "disconnected" || state === "closed") {
            setIsConnecting(false);
            // Attempt another reconnect if we haven't reached max attempts
            if (reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
              reconnectAttemptRef.current += 1;
              console.log(`[Controller] Reconnect failed. Attempting again ${reconnectAttemptRef.current}/${MAX_RECONNECT_ATTEMPTS}`);
              reconnectTimeoutRef.current = window.setTimeout(() => {
                attemptReconnect();
              }, RECONNECT_DELAY_MS);
            }
          } else if (state === "connecting") {
            setIsConnecting(true);
          }
        },
      );

      console.log("[Controller] Reconnect initiated");
    } catch (error) {
      console.error("[Controller] Reconnect failed:", error);
      setIsConnecting(false);
    }
  };

  // Send batched input state at 60 FPS
  const sendBatchedInput = useCallback(() => {
    if (!sessionId || !isJoined || !webrtcManagerRef.current || !playerIdRef.current) {
      return;
    }

    const currentState = inputStateRef.current;
    const stateString = JSON.stringify(currentState);
    
    // Only send if state has changed
    if (stateString === lastSentStateRef.current) {
      return;
    }
    
    lastSentStateRef.current = stateString;

    try {
      const webrtcManager = webrtcManagerRef.current;

      // Send batched input via WebRTC data channel
      webrtcManager.sendToGameMaster({
        type: "player_input_batch",
        playerId: playerIdRef.current,
        inputs: {
          joystick_left: currentState.joystick_left,
          joystick_right: currentState.joystick_right,
          button_left: currentState.button_left,
          button_right: currentState.button_right,
        },
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error("[Controller] Failed to send batched input:", error);
    }
  }, [sessionId, isJoined]);

  // Start/stop the 60 FPS input send loop
  useEffect(() => {
    if (isJoined && !isConnecting) {
      // Start the input send loop
      inputSendIntervalRef.current = window.setInterval(sendBatchedInput, INPUT_SEND_INTERVAL_MS);
      
      return () => {
        if (inputSendIntervalRef.current) {
          clearInterval(inputSendIntervalRef.current);
          inputSendIntervalRef.current = null;
        }
      };
    }
  }, [isJoined, isConnecting, sendBatchedInput]);

  // Handle player disconnect - remove from database and cleanup
  // Set clearSession=true for explicit user disconnect, false for page unload (to allow reconnection)
  const handlePlayerDisconnect = useCallback(async (clearSession: boolean = true) => {
    if (!sessionId || !playerIdRef.current) return;

    const sessionIdNum = parseInt(sessionId, 10);
    if (isNaN(sessionIdNum)) return;

    console.log("[Controller] Player disconnecting, cleaning up...", { clearSession });

    // Clear any pending reconnect attempts
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectAttemptRef.current = 0;

    // Close WebRTC connection first
    if (webrtcManagerRef.current) {
      console.log("[Controller] Closing WebRTC connections");
      webrtcManagerRef.current.closeAll();
      webrtcManagerRef.current = null;
    }

    try {
      // Remove player from database
      const { error } = await supabase
        .from("players")
        .delete()
        .eq("session_id", sessionIdNum)
        .eq("anonymous_id", playerIdRef.current);

      if (error) {
        console.error("[Controller] Failed to remove player from database:", error);
      } else {
        console.log("[Controller] Player removed from database");
      }
    } catch (err) {
      console.error("[Controller] Error during disconnect cleanup:", err);
    }

    // Only clear session player ID if explicitly disconnecting (not on page unload)
    // This allows reconnection if the page is refreshed
    if (clearSession) {
      clearSessionPlayerId(sessionIdNum);
      clearSavedSessionState();
    }
    
    // Reset state
    setIsJoined(false);
    setIsConnecting(false);
    setIsAutoReconnecting(false);
    setConnectionState(null);
    playerIdRef.current = null;
    setPlayerName(""); // Reset player name for re-join
  }, [sessionId]);

  // Cleanup broadcast channel on unmount and handle disconnect
  useEffect(() => {
    // Handle page unload (closing tab, navigating away)
    // Pass false to allow reconnection on page refresh
    const handleBeforeUnload = () => {
      handlePlayerDisconnect(false);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      
      // Cleanup on component unmount - also allow reconnection
      handlePlayerDisconnect(false);
      
      if (webrtcManagerRef.current) {
        webrtcManagerRef.current.closeAll();
        webrtcManagerRef.current = null;
      }
    };
  }, [handlePlayerDisconnect]);

  // Update local input state (will be sent at 60 FPS)
  const handleJoystickMove = useCallback(
    (inputType: "joystick_left" | "joystick_right") => (x: number, y: number) => {
      // Clamp small values to zero
      const clampedX = Math.abs(x) < 0.01 ? 0 : x;
      const clampedY = Math.abs(y) < 0.01 ? 0 : y;
      
      // Update local state (will be batched and sent at 60 FPS)
      inputStateRef.current[inputType] = { x: clampedX, y: clampedY };
    },
    []
  );

  const handleButtonPress = useCallback(
    (inputType: "button_left" | "button_right") => (pressed: boolean) => {
      // Update local state (will be batched and sent at 60 FPS)
      inputStateRef.current[inputType] = { pressed };
    },
    []
  );

  // If no sessionId, show landing page (check AFTER all hooks are called)
  if (!sessionId) {
    return <ControllerLanding />;
  }

  if (isValidatingSession) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-black to-indigo-900 flex items-center justify-center p-4">
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl shadow-2xl p-8 max-w-md w-full text-center border border-white/20">
          <h1 className="text-3xl font-bold mb-4 text-white">Validating Session...</h1>
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-400 mx-auto"></div>
        </div>
      </div>
    );
  }

  // Show kicked message if player was disconnected by GameMaster
  if (wasKicked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-black to-indigo-900 flex items-center justify-center p-4">
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl shadow-2xl p-8 max-w-md w-full text-center border border-white/20">
          <div className="text-6xl mb-4">👋</div>
          <h1 className="text-3xl font-bold mb-4 text-white">Game Ended</h1>
          <p className="text-white/70 mb-6">
            {kickReason || "The game session has ended"}
          </p>
          <button
            onClick={() => navigate("/controller")}
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 text-white py-3 rounded-lg font-semibold text-lg hover:from-purple-700 hover:to-pink-700 transition"
          >
            Join Another Game
          </button>
          <button
            onClick={() => navigate("/")}
            className="block mt-4 text-white/70 hover:text-white text-sm underline w-full text-center"
          >
            Go to Home
          </button>
        </div>
      </div>
    );
  }

  // Show connecting/reconnecting UI when waiting for WebRTC connection
  if ((isJoined && isConnecting) || isAutoReconnecting) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-black to-indigo-900 flex items-center justify-center p-4">
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl shadow-2xl p-8 max-w-md w-full text-center border border-white/20">
          <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-purple-400 mx-auto mb-6"></div>
          <h1 className="text-3xl font-bold mb-4 text-white">
            {isAutoReconnecting ? "Reconnecting..." : "Connecting..."}
          </h1>
          <p className="text-white/70 mb-2">
            {isAutoReconnecting 
              ? `Welcome back, ${playerName}! Reconnecting to game...`
              : "Establishing connection to game master"
            }
          </p>
          {connectionState && (
            <p className="text-sm text-white/50">
              Status: <span className="font-mono">{connectionState}</span>
            </p>
          )}
        </div>
      </div>
    );
  }

  if (!isJoined) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-black to-indigo-900 flex items-center justify-center p-4">
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl shadow-2xl p-8 max-w-md w-full border border-white/20">
          <h1 className="text-3xl font-bold text-center mb-6 text-white">Join Game</h1>
          <p className="text-white/70 text-center mb-4 text-sm">
            Session ID: <span className="font-mono">{sessionId}</span>
          </p>

          {sessionError && (
            <div className="mb-4 p-3 bg-red-500/20 border-2 border-red-400/50 rounded-lg">
              <p className="text-red-200 text-sm font-semibold">
                ⚠️ {sessionError}
              </p>
            </div>
          )}

          {session && (
            <div className="mb-4 p-3 bg-purple-500/20 border-2 border-purple-400/50 rounded-lg">
              <p className="text-white text-sm">
                <span className="font-semibold">Game:</span> {session.game_id}
              </p>
              <p className="text-white text-sm">
                <span className="font-semibold">Session:</span> {session.name}
              </p>
            </div>
          )}

          <input
            type="text"
            placeholder="Enter your name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            className="w-full px-4 py-3 bg-white/20 border-2 border-white/30 rounded-lg mb-4 text-lg text-white placeholder-white/50 focus:outline-none focus:border-purple-400"
            onKeyPress={(e) => {
              if (e.key === "Enter") {
                joinSession();
              }
            }}
            disabled={!!sessionError}
          />
          <button
            onClick={joinSession}
            disabled={!!sessionError}
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 text-white py-3 rounded-lg font-semibold text-lg hover:from-purple-700 hover:to-pink-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sessionError ? "Cannot Join" : "Join Session"}
          </button>

          <button
            onClick={() => {
              // Clear saved session state when navigating back
              clearSavedSessionState();
              navigate("/controller");
            }}
            className="w-full mt-4 bg-transparent border-2 border-white/30 text-white py-3 rounded-lg font-semibold text-lg hover:bg-white/10 transition"
          >
            ← Back to Game Code
          </button>
        </div>
      </div>
    );
  }

  // Handle explicit disconnect (user action)
  const handleDisconnectClick = () => {
    handlePlayerDisconnect(true); // Clear session to prevent auto-reconnect
    navigate("/controller");
  };

  // Get controller config for left and right zones
  const leftConfig = controllerConfigJSON?.layout?.left ?? {
    type: config.input1.startsWith("joystick") ? "joystick" : "button",
    label: config.input1.replace("_", " "),
  };
  const rightConfig = controllerConfigJSON?.layout?.right ?? {
    type: config.input2.startsWith("joystick") ? "joystick" : "button",
    label: config.input2.replace("_", " "),
  };

  const leftLabel = leftConfig.label || "Left";
  const rightLabel = rightConfig.label || "Right";
  const leftIsJoystick = leftConfig.type === "joystick";
  const rightIsJoystick = rightConfig.type === "joystick";

  // Full-screen split layout for all configurations
  return (
    <div className="h-screen w-screen bg-gradient-to-br from-purple-900 via-black to-indigo-900 overflow-hidden relative border-4 border-purple-400 shadow-lg shadow-purple-500/50">
      {/* Header overlay */}
      <div className="absolute top-0 left-0 right-0 z-10 p-3 flex justify-between items-start pointer-events-none">
        <div className="bg-black/30 backdrop-blur-sm rounded-xl px-4 py-2 pointer-events-auto">
          <h2 className="text-lg font-bold text-white">
            {playerName || "Controller"}
          </h2>
          <p className="text-white/70 text-xs">
            Session: {sessionId}
          </p>
          {connectionState && connectionState !== "connected" && (
            <p className="text-yellow-300 text-xs mt-1">
              ⚠️ {connectionState === "connecting" ? "Connecting..." : `Reconnecting...`}
            </p>
          )}
        </div>
        <button
          onClick={handleDisconnectClick}
          className="bg-red-500/80 hover:bg-red-600 text-white text-xs px-3 py-2 rounded-lg transition pointer-events-auto"
        >
          Leave
        </button>
      </div>

      {/* Left zone */}
      {leftIsJoystick ? (
        <FloatingJoystick
          onMove={handleJoystickMove("joystick_left")}
          zone="left"
          color="#3b82f6"
          label={leftLabel}
        />
      ) : (
        <FloatingButton
          onPress={handleButtonPress("button_left")}
          zone="left"
          color="#3b82f6"
          label={leftLabel}
        />
      )}

      {/* Right zone */}
      {rightIsJoystick ? (
        <FloatingJoystick
          onMove={handleJoystickMove("joystick_right")}
          zone="right"
          color="#ef4444"
          label={rightLabel}
        />
      ) : (
        <FloatingButton
          onPress={handleButtonPress("button_right")}
          zone="right"
          color="#ef4444"
          label={rightLabel}
        />
      )}

      {/* Center divider line */}
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-white/10 pointer-events-none" />
    </div>
  );
};
