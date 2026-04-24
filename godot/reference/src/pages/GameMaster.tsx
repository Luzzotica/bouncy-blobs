import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
} from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { supabase } from "../lib/supabase";
import { InputManager } from "../managers/InputManager";
import {
  ControllerConfigJSON,
  ControllerLayout,
  DEFAULT_CONTROLLER_LAYOUT,
  parseControllerConfig,
  buildControllerConfig,
} from "../types/controllerConfig";
import {
  Game,
  GameContext,
  GameState,
  PlayerState,
} from "../games/GameInterface";
import { GameAPI } from "../games/GameAPI";
import { loadGameModule } from "../games/GameLoader";
import type { Player, GameSession } from "../types/database";
import { WebRTCManager, type WebRTCMessage } from "../managers/WebRTCManager";

const colors = [
  "#3b82f6",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
];

const layoutFromConfig = (
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

const controllerLayoutsEqual = (
  a: ControllerLayout,
  b: ControllerLayout,
): boolean => a.left === b.left && a.right === b.right;

const GameMaster: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [sessionPlayers, setSessionPlayers] = useState<Player[]>([]);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const sessionDataRef = useRef<GameSession | null>(null);

  // Get session data from route state (passed from Home)
  const routeSessionData = (location.state as any)?.session;
  const routeGameId = (location.state as any)?.gameId;

  const [_status, setStatus] = useState("Initializing GameMaster...");
  const [error, setError] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [gameModule, setGameModule] = useState<Game | null>(null);
  const [gameState, setGameState] = useState<GameState>({
    controllerLayout: DEFAULT_CONTROLLER_LAYOUT,
  });
  const [playerStatesVersion, setPlayerStatesVersion] = useState(0);
  const playerStatesRef = useRef<Map<string, PlayerState>>(new Map());
  const inputManagerRef = useRef(new InputManager());
  const [renderVersion, setRenderVersion] = useState(0);
  const lastRenderTimeRef = useRef(0);
  const webrtcManagerRef = useRef<WebRTCManager | null>(null);
  const playersPollingIntervalRef = useRef<number | null>(null);

  const updateControllerLayoutState = useCallback(
    (layout: ControllerLayout) => {
      setGameState((prevState) => {
        const currentLayout = prevState.controllerLayout as
          | ControllerLayout
          | undefined;
        if (currentLayout && controllerLayoutsEqual(currentLayout, layout)) {
          return prevState;
        }
        return { ...prevState, controllerLayout: layout };
      });
    },
    [],
  );

  // Create GameAPI object for games to interact with the session
  const gameAPI = useMemo((): GameAPI => {
    return {
      updateControllerLayout: async (layout: ControllerLayout) => {
        if (!sessionId) return;
        try {
          const config = buildControllerConfig(layout);
          const sessionIdNum = parseInt(sessionId, 10);
          if (isNaN(sessionIdNum)) return;

          // Update session in Supabase
          console.log("[GameMaster] Step 1: Updating Supabase with config:", {
            sessionId: sessionIdNum,
            config,
            configType: typeof config,
            configStringified: JSON.stringify(config),
            layout,
          });
          
          // Ensure config is properly formatted for JSONB storage
          const configForDB = typeof config === 'string' ? JSON.parse(config) : config;
          
          const { data, error } = await supabase
            .from("game_sessions")
            .update({
              default_controller_config: configForDB,
            })
            .eq("session_id", sessionIdNum)
            .select();

          if (error) {
            console.error(
              "[GameMaster] Step 1 FAILED: Failed to update controller layout:",
              error,
            );
            return;
          }

          console.log("[GameMaster] Step 1 SUCCESS: Supabase updated:", {
            data,
            updatedConfig: data?.[0]?.default_controller_config,
          });

          // Verify the update by fetching the session again
          const { data: verifyData, error: verifyError } = await supabase
            .from("game_sessions")
            .select("default_controller_config, session_id")
            .eq("session_id", sessionIdNum)
            .single();

          if (verifyError) {
            console.error("[GameMaster] Step 1 VERIFY FAILED: Error fetching session to verify:", verifyError);
          } else if (verifyData) {
            console.log("[GameMaster] Step 1 VERIFY SUCCESS: Database contains config:", {
              sessionId: verifyData.session_id,
              config: verifyData.default_controller_config,
              configType: typeof verifyData.default_controller_config,
              configString: typeof verifyData.default_controller_config === 'string' 
                ? verifyData.default_controller_config 
                : JSON.stringify(verifyData.default_controller_config),
            });
            
            // Compare with what we sent
            const sentConfigString = JSON.stringify(configForDB);
            const receivedConfigString = typeof verifyData.default_controller_config === 'string'
              ? verifyData.default_controller_config
              : JSON.stringify(verifyData.default_controller_config);
            
            if (sentConfigString === receivedConfigString) {
              console.log("[GameMaster] Step 1 VERIFY MATCH: Config in database matches what we sent ✅");
            } else {
              console.warn("[GameMaster] Step 1 VERIFY MISMATCH: Config in database differs from what we sent ⚠️", {
                sent: sentConfigString,
                received: receivedConfigString,
              });
            }
          }

          // Broadcast the config change to all controllers via WebRTC
          const webrtcManager = webrtcManagerRef.current;
          if (webrtcManager) {
            console.log("[GameMaster] Step 2: Broadcasting config change to controllers via WebRTC...");
            try {
              webrtcManager.broadcast({
                type: "controller_config_update",
                config: configForDB,
              });
              console.log("[GameMaster] Step 2 SUCCESS: Config broadcast sent to controllers");
            } catch (error) {
              console.error("[GameMaster] Step 2 ERROR: Exception broadcasting config:", error);
            }
          } else {
            console.warn("[GameMaster] Step 2 SKIPPED: WebRTC manager not ready");
          }

          // Update local state immediately
          updateControllerLayoutState(layout);
          console.log(
            "[GameMaster] Step 1 COMPLETE: Controller layout updated via API:",
            layout,
          );
        } catch (error) {
          console.error(
            "[GameMaster] Failed to update controller layout:",
            error,
          );
        }
      },
    };
  }, [sessionId, updateControllerLayoutState]);

  const [joined, setJoined] = useState(false);

  // Cleanup function - delete session and all players, navigate back to home
  const cleanupAndExit = useCallback(async () => {
    if (!sessionId || isCleaningUp) return;
    
    setIsCleaningUp(true);
    const sessionIdNum = parseInt(sessionId, 10);
    if (isNaN(sessionIdNum)) {
      navigate("/");
      return;
    }

    console.log("[GameMaster] Cleaning up session:", sessionIdNum);

    try {
      // Broadcast session ended to all controllers via WebRTC
      if (webrtcManagerRef.current) {
        webrtcManagerRef.current.broadcast({
          type: "session_ended",
          reason: "GameMaster ended the session",
        });
        webrtcManagerRef.current.closeAll();
        console.log("[GameMaster] Session ended broadcast sent");
      }

      // First, delete all players in this session
      const { error: playersError } = await supabase
        .from("players")
        .delete()
        .eq("session_id", sessionIdNum);

      if (playersError) {
        console.error("[GameMaster] Failed to delete players:", playersError);
      } else {
        console.log("[GameMaster] Players deleted");
      }

      // Then, mark session as inactive
      const { error: sessionError } = await supabase
        .from("game_sessions")
        .update({ is_active: false })
        .eq("session_id", sessionIdNum);

      if (sessionError) {
        console.error("[GameMaster] Failed to deactivate session:", sessionError);
      } else {
        console.log("[GameMaster] Session deactivated");
      }
    } catch (err) {
      console.error("[GameMaster] Cleanup error:", err);
    }

    // Navigate back to home
    navigate("/");
  }, [sessionId, navigate, isCleaningUp]);

  // Handle page unload - try to cleanup
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Show confirmation dialog
      e.preventDefault();
      e.returnValue = "Are you sure you want to leave? The game session will end.";
      return e.returnValue;
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  // Handler for when session data is received
  const handleSessionData = useCallback(
    (session: GameSession) => {
      if (!session) return;

      const sessionGameId = session.game_id;
      if (!sessionGameId) return;

      // Set gameId once - it never changes after this
      setGameId((currentGameId) => {
        if (currentGameId) {
          // Already set, don't update
          return currentGameId;
        }
        return sessionGameId;
      });

      setStatus(`Session ${session.session_id} ready`);

      // Set initial layout from session config (only on first load)
      const defaultControllerConfig = session.default_controller_config;
      const parsedConfig = parseControllerConfig(
        JSON.stringify(defaultControllerConfig),
      );
      const layout = layoutFromConfig(parsedConfig);
      updateControllerLayoutState(layout);
    },
    [updateControllerLayoutState],
  );

  // Fetch session data
  useEffect(() => {
    if (!sessionId) return;

    // If we have session data from route state, use it immediately
    if (routeSessionData) {
      console.log("[GameMaster] Using session data from route state");
      handleSessionData(routeSessionData);
      if (routeGameId) {
        setGameId(routeGameId);
      }
      setJoined(true);
      return;
    }

    // Otherwise, fetch from Supabase
    const fetchSession = async () => {
      try {
        const sessionIdNum = parseInt(sessionId, 10);
        if (isNaN(sessionIdNum)) {
          throw new Error("Invalid session ID");
        }

        const { data, error } = await supabase
          .from("game_sessions")
          .select("*")
          .eq("session_id", sessionIdNum)
          .single();

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("Session not found");
        }

        if (!data.is_active) {
          throw new Error("Session is no longer active");
        }

        sessionDataRef.current = data;
        handleSessionData(data);
        setJoined(true);
      } catch (err: any) {
        console.error("Error fetching session:", err);
        setError(err.message || "Failed to load session");
        setStatus("Failed to load session");
        
        // If session not found or inactive, navigate back to home after a delay
        setTimeout(() => {
          navigate("/");
        }, 3000);
      }
    };

    fetchSession();
  }, [sessionId, routeSessionData, routeGameId, handleSessionData, navigate]);

  // Track disconnected players for reconnection
  const disconnectedPlayersRef = useRef<Set<string>>(new Set());

  // Initialize WebRTC Manager for GameMaster
  useEffect(() => {
    if (!sessionId || !joined) return;

    const sessionIdNum = parseInt(sessionId, 10);
    if (isNaN(sessionIdNum)) return;

    const webrtcManager = new WebRTCManager(sessionIdNum, "gamemaster");
    webrtcManagerRef.current = webrtcManager;

    // Initialize WebRTC with message handlers
    webrtcManager
      .initializeAsGameMaster(
        (message: WebRTCMessage, playerId: string) => {
          // Handle incoming messages from controllers
          // Support both single inputs (legacy) and batched inputs (new)
          if (message.type === "player_input" || message.type === "player_input_batch") {
            inputManagerRef.current.handleWebRTCMessage(message, playerId);
          }
        },
        (playerId: string, state: RTCPeerConnectionState) => {
          console.log(`[GameMaster] Connection state for ${playerId}: ${state}`);
          
          // Handle player disconnection - mark as disconnected for potential reconnection
          if (state === "closed" || state === "disconnected" || state === "failed") {
            console.log(`[GameMaster] Player ${playerId} WebRTC disconnected - marking for potential reconnection`);
            disconnectedPlayersRef.current.add(playerId);
            // Don't remove from sessionPlayers immediately - player may reconnect
            // The polling loop will handle reconnection attempts
          } else if (state === "connected") {
            // Player reconnected - remove from disconnected set
            disconnectedPlayersRef.current.delete(playerId);
          }
        },
      )
      .catch((error) => {
        console.error("[GameMaster] Failed to initialize WebRTC:", error);
        setError("Failed to initialize WebRTC connection");
      });

    return () => {
      webrtcManager.closeAll();
      webrtcManagerRef.current = null;
    };
  }, [sessionId, joined]);

  // Poll for players and create WebRTC connections
  useEffect(() => {
    if (!sessionId || !joined) return;

    const sessionIdNum = parseInt(sessionId, 10);
    if (isNaN(sessionIdNum)) return;

    let previousPlayerIds = new Set<string>();
    let previousPlayers: Player[] = [];

    // Fetch initial players
    const fetchPlayers = async () => {
      try {
        const { data, error } = await supabase
          .from("players")
          .select("*")
          .eq("session_id", sessionIdNum)
          .eq("is_display", false); // Only get controllers, not displays

        if (error) {
          console.error("Error fetching players:", error);
          return;
        }

        const currentPlayers = data || [];
        const currentPlayerIds = new Set(
          currentPlayers.map((p) => p.user_id || p.anonymous_id || "").filter(Boolean),
        );

        // Find new players
        const newPlayers = currentPlayers.filter(
          (p) => {
            const id = p.user_id || p.anonymous_id || "";
            return id && !previousPlayerIds.has(id);
          },
        );

        // Find removed players (from previous state)
        const removedPlayerIds = Array.from(previousPlayerIds).filter(
          (id) => !currentPlayerIds.has(id),
        );
        const removedPlayers = previousPlayers.filter(
          (p) => {
            const id = p.user_id || p.anonymous_id || "";
            return id && removedPlayerIds.includes(id);
          },
        );

        // Update previous state
        previousPlayerIds = currentPlayerIds;
        previousPlayers = currentPlayers;

        // Create WebRTC connections for new players and reconnecting players
        const webrtcManager = webrtcManagerRef.current;
        if (webrtcManager) {
          // Handle new players
          for (const newPlayer of newPlayers) {
            const playerId = newPlayer.user_id || newPlayer.anonymous_id || "";
            if (playerId) {
              console.log(`[GameMaster] Creating WebRTC connection for new player: ${playerId}`);
              webrtcManager
                .createPeerConnectionForController(playerId)
                .catch((error) => {
                  console.error(`[GameMaster] Failed to create peer connection for ${playerId}:`, error);
                });
            }
          }

          // Handle reconnecting players (players that exist in DB but have disconnected WebRTC)
          for (const player of currentPlayers) {
            const playerId = player.user_id || player.anonymous_id || "";
            if (playerId && disconnectedPlayersRef.current.has(playerId)) {
              console.log(`[GameMaster] Attempting to reconnect player: ${playerId}`);
              // Remove from disconnected set before attempting reconnection
              disconnectedPlayersRef.current.delete(playerId);
              webrtcManager
                .createPeerConnectionForController(playerId)
                .catch((error) => {
                  console.error(`[GameMaster] Failed to reconnect ${playerId}:`, error);
                  // Add back to disconnected set if reconnection failed
                  disconnectedPlayersRef.current.add(playerId);
                });
            }
          }

          // Handle removed players - call onPlayerDisconnect and close connections
          for (const removedPlayer of removedPlayers) {
            const playerId = removedPlayer.user_id || removedPlayer.anonymous_id || "";
            if (!playerId) continue;

            console.log(`[GameMaster] Player removed from database: ${playerId}`);
            // Remove from disconnected tracking since they're fully gone
            disconnectedPlayersRef.current.delete(playerId);

            // Call onPlayerDisconnect if game module is loaded
            const module = gameModuleRef.current;
            if (module?.onPlayerDisconnect) {
              const ctx = buildContextRef.current();
              ctx.players = currentPlayers; // Use updated player list (without removed player)
              try {
                module.onPlayerDisconnect(ctx, playerId);
                setGameState(ctx.gameState);
                mergeGameStateRef.current(ctx);
                console.log(`[GameMaster] Called onPlayerDisconnect for ${playerId}`);
              } catch (error) {
                console.error(`[GameMaster] Error in onPlayerDisconnect for ${playerId}:`, error);
              }
            }

            // Close WebRTC connection
            webrtcManager.closeConnection(playerId);
          }
        }

        // Update state if there are changes (new or removed players)
        if (newPlayers.length > 0 || removedPlayerIds.length > 0) {
          setSessionPlayers(currentPlayers);

          // Call onPlayerJoin for new players if game module is loaded
          const module = gameModuleRef.current;
          if (module?.onPlayerJoin && newPlayers.length > 0) {
            for (const newPlayer of newPlayers) {
              const ctx = buildContextRef.current();
              ctx.players = currentPlayers;
              try {
                module.onPlayerJoin(ctx, newPlayer);
                setGameState(ctx.gameState);
                mergeGameStateRef.current(ctx);
              } catch (error) {
                console.error("[GameMaster] Error in onPlayerJoin:", error);
              }
            }
          }
        }
      } catch (err) {
        console.error("Error fetching players:", err);
      }
    };

    // Initial fetch
    fetchPlayers();

    // Poll for players every 2 seconds
    playersPollingIntervalRef.current = window.setInterval(fetchPlayers, 2000);

    return () => {
      if (playersPollingIntervalRef.current) {
        clearInterval(playersPollingIntervalRef.current);
        playersPollingIntervalRef.current = null;
      }
    };
  }, [sessionId, joined]);

  const buildContext = useCallback((): GameContext => {
    return {
      connection: null, // No longer needed - entities are client-side only
      sessionId: sessionId ? BigInt(sessionId) : BigInt(0),
      players: sessionPlayers,
      gameState,
      playerStates: playerStatesRef.current,
      inputManager: inputManagerRef.current,
      api: gameAPI,
    };
  }, [sessionId, sessionPlayers, gameState, gameAPI]);

  const mergeGameState = useCallback(
    (ctx: GameContext) => {
      setGameState(ctx.gameState);
      // Update player states ref and trigger re-render
      playerStatesRef.current = new Map(ctx.playerStates);
      // Force a re-render by incrementing version counter
      setPlayerStatesVersion((v) => v + 1);
      // No database persistence - entities are client-side only
    },
    [],
  );

  const gameModuleRef = useRef(gameModule);
  const buildContextRef = useRef(buildContext);
  const mergeGameStateRef = useRef(mergeGameState);

  useEffect(() => {
    gameModuleRef.current = gameModule;
  }, [gameModule]);

  useEffect(() => {
    buildContextRef.current = buildContext;
  }, [buildContext]);

  useEffect(() => {
    mergeGameStateRef.current = mergeGameState;
  }, [mergeGameState]);

  // Subscribe to player inputs via WebRTC
  useEffect(() => {
    if (!sessionId || !joined) return;
    const sessionIdNum = parseInt(sessionId, 10);
    if (isNaN(sessionIdNum)) return;

    const listener = (event: any, playerId: string) => {
      const module = gameModuleRef.current;
      if (!module) return;
      const ctx = buildContextRef.current();
      module.onPlayerInput(ctx, playerId, event);
      // Immediately sync gameState changes to React state
      setGameState(ctx.gameState);
      mergeGameStateRef.current(ctx);
    };
    inputManagerRef.current.addEventListener(listener);
    
    // Subscribe to session (WebRTC handles the connection)
    inputManagerRef.current.subscribeToSession(sessionIdNum).catch((error) => {
      console.error("[GameMaster] Failed to subscribe to inputs:", error);
    });

    return () => {
      inputManagerRef.current.removeEventListener(listener);
      inputManagerRef.current.unsubscribe();
    };
  }, [sessionId, joined]);

  useEffect(() => {
    console.log("[GameMaster] gameId effect triggered", gameId);
    if (!gameId) return;
    let canceled = false;
    setStatus(`Loading game module ${gameId}...`);
    console.log(`[GameMaster] loading game module ${gameId}`);
    
    // Small delay to ensure component is still mounted
    loadGameModule(gameId)
      .then((module) => {
        if (canceled) {
          console.log(`[GameMaster] Module load canceled for ${gameId}`);
          return;
        }
        if (module) {
          setGameModule(module);
          setStatus(`${module.gameDefinition.name} loaded`);
          console.log(
            `[GameMaster] successfully loaded module ${module.gameDefinition.name}`,
          );
        } else {
          if (!canceled) {
            setStatus("Game module returned null");
            console.warn(`[GameMaster] module ${gameId} returned null`);
          }
        }
      })
      .catch((loadError: any) => {
        if (canceled) {
          console.log(`[GameMaster] Module load canceled (error) for ${gameId}`);
          return;
        }
        // Ignore MIME type errors (happen when file doesn't exist)
        if (loadError?.message?.includes('MIME type') || loadError?.message?.includes('text/html')) {
          console.warn(`[GameMaster] Module not found at expected path for ${gameId}`);
          setStatus("Game module not found");
        } else {
          console.error("[GameMaster] failed to load module", loadError);
          setError(loadError.message || "Failed to load module");
          setStatus("Failed to load module");
        }
      });
    
    return () => {
      canceled = true;
      // Clear module on unmount to prevent stale references
      setGameModule(null);
    };
  }, [gameId]);

  useEffect(() => {
    if (!sessionId || !gameModule || !gameModule.update) return;
    let last = performance.now();
    const handle = setInterval(() => {
      const now = performance.now();
      const deltaTime = now - last;
      last = now;
      const ctx = buildContext();
      gameModule.update?.(ctx, deltaTime);
      // Immediately sync gameState changes to React state (e.g., controller layout changes)
      setGameState(ctx.gameState);
      mergeGameState(ctx);

      // Throttle render updates to ~60Hz (every ~16ms)
      const timeSinceLastRender = now - lastRenderTimeRef.current;
      if (timeSinceLastRender >= 16) {
        setRenderVersion((v) => v + 1);
        lastRenderTimeRef.current = now;
      }
    }, 16);
    return () => clearInterval(handle);
  }, [sessionId, gameModule, buildContext, mergeGameState]);

  // Memoize render output and only update when renderVersion changes (throttled to 60Hz)
  const gameRenderOutput = useMemo(() => {
    if (!gameModule) return null;
    return gameModule.render(buildContext(), sessionPlayers, colors);
  }, [
    gameModule,
    renderVersion,
    playerStatesVersion,
    sessionPlayers.length,
    buildContext,
    sessionPlayers,
  ]);

  // Generate controller URL for QR code
  const controllerUrl = useMemo(() => {
    if (!sessionId) return "";
    // Use the base URL from environment variables
    // For local dev: set VITE_BASE_URL in .env.local (e.g., http://192.168.1.46:3000)
    // For production: set VITE_BASE_URL in Vercel env vars (https://www.partii.live)
    const baseUrl = import.meta.env.VITE_BASE_URL || window.location.origin;
    return `${baseUrl}/controller/${sessionId}`;
  }, [sessionId]);

  return (
    <div className="fixed inset-0 bg-gray-900 text-white overflow-hidden">
      {/* Full screen game area */}
      <div className="w-full h-full">
        {gameRenderOutput || (
          <div className="flex items-center justify-center h-full">
            <p className="text-center text-gray-400 text-xl">Loading game view...</p>
          </div>
        )}
      </div>

      {/* Floating overlay - QR code and controls */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-3">
        {/* QR Code */}
        {controllerUrl && (
          <div className="flex flex-col items-center bg-black/70 backdrop-blur-sm rounded-xl p-3 border border-white/20 shadow-2xl">
            <p className="text-xs text-white/80 mb-2 font-medium">
              Scan to Join ({sessionId})
            </p>
            <div className="bg-white p-1.5 rounded-lg">
              <QRCodeSVG
                value={controllerUrl}
                size={100}
                level="M"
                includeMargin={false}
              />
            </div>
            <p className="text-xs text-white/50 mt-2 text-center">
              {sessionPlayers.length} player{sessionPlayers.length !== 1 ? 's' : ''}
            </p>
          </div>
        )}

        {/* End Game Button */}
        <button
          onClick={cleanupAndExit}
          disabled={isCleaningUp}
          className="px-4 py-2 bg-red-600/90 hover:bg-red-600 text-white text-sm font-semibold rounded-xl transition shadow-lg disabled:opacity-50 backdrop-blur-sm border border-red-500/30"
        >
          {isCleaningUp ? "Ending..." : "End Game"}
        </button>
      </div>

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-red-600/90 rounded-lg text-sm">
          {error}
        </div>
      )}
    </div>
  );
};

export default GameMaster;
