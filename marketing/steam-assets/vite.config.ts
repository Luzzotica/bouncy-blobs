import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Serve bouncy-blobs' /public so /menu/menu_hero.png and /refs/reg/*.png
// resolve identically here and in the game itself.
export default defineConfig({
  plugins: [react()],
  server: { port: 5183, strictPort: true },
  publicDir: resolve(__dirname, "../../public"),
});
