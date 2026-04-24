import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { GameSession } from "../types/database";

export const SessionList: React.FC = () => {
  const navigate = useNavigate();
  const [activeSessions, setActiveSessions] = useState<GameSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Poll sessions periodically (no real-time needed for sessions)
  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const { data, error } = await supabase
          .from("game_sessions")
          .select("*")
          .eq("is_active", true)
          .order("created_at", { ascending: false });

        if (error) {
          console.error("Error fetching sessions:", error);
          return;
        }

        setActiveSessions(data || []);
        setIsLoading(false);
      } catch (err) {
        console.error("Error fetching sessions:", err);
        setIsLoading(false);
      }
    };

    // Fetch immediately
    fetchSessions();

    // Poll every 5 seconds
    const interval = setInterval(fetchSessions, 5000);

    return () => clearInterval(interval);
  }, []);

  const handleJoinSession = (sessionId: number) => {
    navigate(`/controller/${sessionId}`);
  };

  const formatTimestamp = (timestamp: string): string => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleString();
    } catch (e) {
      console.error("Error formatting timestamp:", e);
      return "Unknown";
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center">
          <h1 className="text-3xl font-bold mb-4">Loading Sessions...</h1>
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-500 to-pink-500 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white/10 backdrop-blur-lg rounded-3xl p-6 mb-6">
          <h1 className="text-4xl font-bold text-white text-center mb-2">
            Join a Session
          </h1>
          <p className="text-white/80 text-center text-sm">
            Select a session to join as a player
          </p>
        </div>

        {activeSessions.length === 0 ? (
          <div className="bg-white/10 backdrop-blur-lg rounded-3xl p-8 text-center">
            <p className="text-white text-lg mb-4">
              No active sessions available
            </p>
            <p className="text-white/70 text-sm">
              Create a new session from the home page
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {activeSessions.map((session) => (
              <div
                key={session.session_id}
                className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 hover:bg-white/20 transition-all duration-200"
              >
                <div className="flex flex-col h-full">
                  <h3 className="text-xl font-bold text-white mb-2">
                    {session.name}
                  </h3>
                  <div className="text-white/70 text-sm mb-4 space-y-1">
                    <p>
                      <span className="font-semibold">Game:</span>{" "}
                      {session.game_id}
                    </p>
                    <p>
                      <span className="font-semibold">Session ID:</span>{" "}
                      <span className="font-mono text-xs">
                        {session.session_id}
                      </span>
                    </p>
                    <p>
                      <span className="font-semibold">Created:</span>{" "}
                      {formatTimestamp(session.created_at)}
                    </p>
                  </div>
                  <button
                    onClick={() => handleJoinSession(session.session_id)}
                    className="mt-auto bg-purple-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-purple-700 transition w-full"
                  >
                    Join Session
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
