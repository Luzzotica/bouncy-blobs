/* Convert output/client-icon.png into a multi-res Windows .ico.
 * Requires ImageMagick `magick` on PATH. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "output", "client-icon.png");
const OUT = resolve(process.cwd(), "output", "client-icon.ico");

if (!existsSync(SRC)) {
  console.error(`Missing ${SRC} — run \`pnpm render:steam client-icon\` first.`);
  process.exit(1);
}

const res = spawnSync(
  "magick",
  [SRC, "-define", "icon:auto-resize=16,24,32,48,64,128,256", OUT],
  { stdio: "inherit" },
);

if (res.status !== 0) {
  console.error("ImageMagick `magick` not found or failed. Install: brew install imagemagick");
  process.exit(1);
}
console.log(`✓ ${OUT}`);
