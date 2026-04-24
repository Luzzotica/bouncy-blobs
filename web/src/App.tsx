import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Sandbox from './pages/Sandbox'
import Editor from './pages/Editor'
import GameMaster from './pages/GameMaster'
import Controller from './pages/Controller'
import JoinLobby from './pages/JoinLobby'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/sandbox" element={<Sandbox />} />
      <Route path="/editor" element={<Editor />} />
      <Route path="/game" element={<GameMaster />} />
      <Route path="/join" element={<JoinLobby />} />
      <Route path="/controller/:sessionId" element={<Controller />} />
    </Routes>
  )
}
