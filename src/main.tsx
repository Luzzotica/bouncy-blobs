import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'

// On itch.io (and any non-root host) the page URL doesn't match our app
// routes, so BrowserRouter renders nothing. HashRouter is host-agnostic.
const Router = import.meta.env.BASE_URL === '/' ? BrowserRouter : HashRouter
import App from './App'
import { UserProvider } from './contexts/UserContext'
import { AuthProvider } from './contexts/AuthContext'
import { getEngine, prepareEngine } from './physics/engineSelector'
import './index.css'

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

// In Rust mode, await the wasm module before first render — otherwise
// any synchronous engine construction in the boot path crashes with
// "wasm not initialized". In TS mode we mount immediately AND kick off
// a background wasm load so SPA navigations to `?engine=rust` (e.g. the
// Home page's "Sandbox (Rust)" button) don't race a not-yet-loaded
// wasm module. The background load is fire-and-forget; the wasm
// init promise is memoised inside `prepareEngine` so a later page
// awaiting it just gets the already-resolved promise.
const pick = getEngine();
if (pick === 'rust') {
  prepareEngine('rust').then(mount).catch(err => {
    console.error('[engine] wasm load failed — falling back to TS sim. Error:', err);
    mount();
  });
} else {
  mount();
  prepareEngine('rust').catch(err => {
    console.warn('[engine] background wasm preload failed:', err);
  });
}
