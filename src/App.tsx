import { useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { installUiSounds } from './utils/uiSounds'
import { CloudContent, initArcadeSso } from './lib/party'
import { roomConfig, GAME_ID } from './lib/partyConfig'
import { ARCADE_ORIGINS } from './lib/arcadeOrigins'
import { preloadAll, SFX_NAMES } from './utils/audio'
import { onJoinRequested, onLaunchJoin } from './lib/steamLobbyApi'
import Home from './pages/Home'
import PlayHub from './pages/PlayHub'
import PlayLevel from './pages/PlayLevel'
import Sandbox from './pages/Sandbox'
import Editor from './pages/Editor'
import GameMaster from './pages/GameMaster'
import Controller from './pages/Controller'
import JoinLobby from './pages/JoinLobby'
import Multiplayer from './pages/Multiplayer'
import OnlineGuest from './pages/OnlineGuest'
import Intro from './pages/Intro'
import NetcodeHarness from './pages/NetcodeHarness'
import MyReplays from './pages/MyReplays'
import ReplayView from './pages/ReplayView'

export default function App() {
  const navigate = useNavigate()

  useEffect(() => {
    installUiSounds()
    preloadAll(SFX_NAMES)
  }, [])

  // Arcade SSO: auto-sign-in when embedded in the arcade (iframe/mobile).
  useEffect(() => {
    const cloud = new CloudContent({ baseUrl: roomConfig.baseUrl, apiKey: roomConfig.apiKey, gameId: GAME_ID })
    return initArcadeSso(cloud, { allowedOrigins: ARCADE_ORIGINS })
  }, [])

  // Steam invite handlers — fire when a friend launches us via "Join Game"
  // (onLaunchJoin via +connect_lobby) or invokes "Join Game" while we're
  // already running (onJoinRequested). Both navigate to the Steam guest
  // route; OnlineGuest reads `?steam_lobby` and dials over Steam Networking.
  useEffect(() => {
    let unlistenLaunch: (() => void) | null = null
    let unlistenJoin: (() => void) | null = null
    onLaunchJoin((lobbyId) => navigate(`/online-guest?steam_lobby=${lobbyId}`))
      .then((u) => { unlistenLaunch = u })
      .catch(() => {})
    onJoinRequested((lobbyId) => navigate(`/online-guest?steam_lobby=${lobbyId}`))
      .then((u) => { unlistenJoin = u })
      .catch(() => {})
    return () => {
      unlistenLaunch?.()
      unlistenJoin?.()
    }
  }, [navigate])

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/play" element={<PlayHub />} />
      <Route path="/play/level" element={<PlayLevel />} />
      <Route path="/sandbox" element={<Sandbox />} />
      <Route path="/editor" element={<Editor />} />
      <Route path="/replays" element={<MyReplays />} />
      <Route path="/replay/:id" element={<ReplayView />} />
      <Route path="/game" element={<GameMaster />} />
      <Route path="/join" element={<JoinLobby />} />
      <Route path="/controller/:sessionId" element={<Controller />} />
      <Route path="/multiplayer" element={<Multiplayer />} />
      {/* Old Browse route — folded into Multiplayer; redirect stale links. */}
      <Route path="/lobbies" element={<Navigate to="/multiplayer" replace />} />
      <Route path="/online-guest" element={<OnlineGuest />} />
      <Route path="/netcode-harness" element={<NetcodeHarness />} />
      <Route path="/intro" element={<Intro />} />
    </Routes>
  )
}
