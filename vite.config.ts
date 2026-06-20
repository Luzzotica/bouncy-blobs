/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json' with { type: 'json' }
import { devMapsPlugin } from './vite/devMapsPlugin'

export default defineConfig({
  plugins: [react(), devMapsPlugin()],
  base: process.env.ITCH_BUILD ? './' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5170,
    strictPort: true, // Fail loudly if 5170 is taken instead of drifting to another port
    host: true, // Listen on all interfaces for LAN access
  },
  test: {
    environment: 'node',
  },
})
