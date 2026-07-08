import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'

// On itch.io (and any non-root host) the page URL doesn't match our app
// routes, so BrowserRouter renders nothing. HashRouter is host-agnostic.
const Router = import.meta.env.BASE_URL === '/' ? BrowserRouter : HashRouter
import App from './App'
import { UserProvider } from './contexts/UserContext'
import { AuthProvider } from './contexts/AuthContext'
import { prepareEngine } from './physics/engineSelector'
import { installAudioUnlock } from './utils/audio'
import './index.css'

// iOS/WKWebView keep the AudioContext suspended until the first user gesture —
// install the app-wide unlock before anything renders.
installAudioUnlock()

function mount() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Router>
        <AuthProvider>
          <UserProvider>
            <App />
          </UserProvider>
        </AuthProvider>
      </Router>
    </React.StrictMode>,
  )
}

// Await the wasm physics module before first render — synchronous engine
// construction in the boot path crashes with "wasm not initialized" otherwise.
// The Rust integer sim is the only engine; there is no fallback.
prepareEngine().then(mount).catch(err => {
  console.error('[engine] wasm physics module failed to load:', err);
  // Surface the failure rather than mounting a broken, engine-less app.
  document.getElementById('root')!.textContent =
    'Failed to load the physics engine. Please reload.';
});
