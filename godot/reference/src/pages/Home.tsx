import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUser } from "../contexts/UserContext";
import { supabase } from "../lib/supabase";
import { getAllGames, getGame, getDefaultControllerConfigJSON } from "../games";

export const Home: React.FC = () => {
  const navigate = useNavigate();
  const { user, signOut } = useUser();
  const availableGames = getAllGames();
  const [gameId, setGameId] = useState(availableGames[0]?.id || "simple");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await signOut();
      // User will be automatically updated via UserContext
    } catch (err: any) {
      setError(err.message || "Failed to sign out");
      setTimeout(() => setError(null), 5000);
    } finally {
      setIsLoggingOut(false);
    }
  };

  const createSession = async () => {
    // Require authentication to create sessions
    if (!user) {
      setError("You must be signed in to create a game session. Please sign in first.");
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      console.log("Creating session with game_id:", gameId);

      // Load game definition
      const game = await getGame(gameId);
      if (!game) {
        throw new Error(
          `Game "${gameId}" not found. Make sure the game is registered.`,
        );
      }

      // Convert game's controller config to JSON
      const defaultControllerConfig = getDefaultControllerConfigJSON(game);

      // Create session in Supabase - only authenticated users allowed
      const sessionData = {
        game_id: gameId,
        name: `${game.name} Session`,
        default_controller_config: defaultControllerConfig,
        is_active: true,
        master_user_id: user.id,
        master_anonymous_id: null,
      };

      const { data: newSession, error: insertError } = await supabase
        .from("game_sessions")
        .insert(sessionData)
        .select()
        .single();

      if (insertError) {
        throw insertError;
      }

      if (!newSession) {
        throw new Error("Failed to create session");
      }

      console.log("✅ Session created:", newSession.session_id);

      // Navigate to GameMaster
      navigate(`/game/${newSession.session_id}`, {
        state: {
          session: newSession,
          gameId: newSession.game_id,
        },
      });
    } catch (error) {
      console.error("Failed to create session:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      setError(
        `Failed to create game session: ${errorMessage}. Please try again.`,
      );
      setTimeout(() => setError(null), 5000); // Auto-dismiss after 5 seconds
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-black to-indigo-900 flex flex-col">
      {/* Header with logout in top right */}
      <div className="flex justify-between items-start p-4">
        <div className="flex-1">
          <h1 className="text-4xl font-bold text-white mb-1">Partii</h1>
          <p className="text-white/70 text-sm">
            Party Games with Phone Controllers
          </p>
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <>
              <p className="text-white/70 text-sm hidden sm:block">
                {user.email}
              </p>
              <button
                onClick={handleLogout}
                disabled={isLoggingOut}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed border border-white/20"
              >
                {isLoggingOut ? "Logging out..." : "Logout"}
              </button>
            </>
          ) : (
            <button
              onClick={() => navigate("/auth")}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold rounded-lg transition border border-white/20"
            >
              Sign In
            </button>
          )}
        </div>
      </div>

      {/* Scrollable games section */}
      <div className="flex-1 overflow-hidden flex flex-col pl-6 pr-4 pb-24">
        <p className="text-white font-semibold mb-4 text-xl">
          Choose a Game
        </p>
        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-2 pl-4">
            {availableGames.map((game) => (
              <button
                key={game.id}
                type="button"
                onClick={() => setGameId(game.id)}
                className={`text-left rounded-lg border-2 p-4 transition-all duration-200 ${
                  gameId === game.id
                    ? "border-purple-400 bg-purple-500/20 scale-105 shadow-lg shadow-purple-500/50"
                    : "border-white/20 bg-white/5 hover:border-purple-300/60 hover:bg-purple-500/10 hover:scale-[1.02]"
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-base font-semibold text-white flex-1">
                    {game.name}
                  </h3>
                </div>
                <p className="text-xs text-white/70 line-clamp-2">
                  {game.description || "No description available yet."}
                </p>
                <span className="text-xs text-white/40 mt-2 block">
                  {game.id}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Full-width floating bubble */}
      <div className="fixed bottom-0 left-0 right-0 z-50 px-4 pb-4">
        <div className="bg-gradient-to-r from-purple-600/90 via-pink-600/90 to-indigo-600/90 backdrop-blur-lg rounded-2xl p-4 border border-white/30 shadow-2xl flex gap-3 max-w-4xl mx-auto">
          <button
            onClick={createSession}
            disabled={isCreating || !user}
            className="flex-1 px-6 py-3 bg-white text-purple-600 rounded-lg font-bold text-base hover:bg-gray-100 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {!user
              ? "Sign in to Create"
              : isCreating
                ? "Creating..."
                : "Start Game"}
          </button>

          <button
            onClick={() => navigate("/controller")}
            className="flex-1 px-6 py-3 bg-white/20 hover:bg-white/30 text-white rounded-lg font-bold text-base transition flex items-center justify-center gap-2 border border-white/30"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            Join Game
          </button>
        </div>
      </div>

      {/* Error Toast */}
      {error && (
        <div
          className="fixed bottom-4 right-4 bg-red-600 text-white px-6 py-4 rounded-lg shadow-lg flex items-center space-x-3 z-50 max-w-md"
          style={{
            animation: "slideUp 0.3s ease-out",
          }}
        >
          <svg
            className="w-6 h-6 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div className="flex-1">
            <p className="font-semibold">Error</p>
            <p className="text-sm">{error}</p>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-white/80 hover:text-white"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};
