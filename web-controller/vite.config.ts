import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The phone controller for Bouncy Blobs 3.0 (the game itself is Rust/Bevy).
export default defineConfig({
  plugins: [react()],
  server: { port: 5171 },
});
