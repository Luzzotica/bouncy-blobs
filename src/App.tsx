import { useEffect } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { installUiSounds } from './utils/uiSounds'
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
import LobbyBrowser from './pages/LobbyBrowser'
import OnlineGuest from './pages/OnlineGuest'
import Intro from './pages/Intro'

export default function App() {
  const navigate = useNavigate()

  useEffect(() => {
    installUiSounds()
    preloadAll(SFX_NAMES)
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
      <Route path="/game" element={<GameMaster />} />
      <Route path="/join" element={<JoinLobby />} />
      <Route path="/controller/:sessionId" element={<Controller />} />
      <Route path="/lobbies" element={<LobbyBrowser />} />
      <Route path="/online-guest" element={<OnlineGuest />} />
      <Route path="/intro" element={<Intro />} />
    </Routes>
  )
}
