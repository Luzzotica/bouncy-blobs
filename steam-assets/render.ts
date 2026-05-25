/* Renders each Steam asset to output/<name>.png by:
 *   1) starting Vite dev server
 *   2) opening chromium at /?asset=<name> with the asset's exact viewport
 *   3) screenshotting #root
 */
import { chromium, type Browser } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ASSETS } from "./templates/_manifest";

const OUTPUT = resolve(process.cwd(), "output");
const HOST = "http://localhost:5183";

function startVite(): Promise<ChildProcess> {
  return new Promise((res, rej) => {
    const proc = spawn("pnpm", ["dev"], { stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => rej(new Error("Vite did not start in 20s")), 20000);
    proc.stdout?.on("data", (chunk) => {
      const s = chunk.toString();
      if (s.includes("Local:") || s.includes("ready in")) {
        clearTimeout(timeout);
        res(proc);
      }
    });
    proc.stderr?.on("data", (c) => process.stderr.write(c));
    proc.on("exit", (code) => {
      if (code !== 0) rej(new Error(`Vite exited ${code}`));
    });
  });
}

async function renderOne(browser: Browser, name: string) {
  const spec = ASSETS[name];
  if (!spec) throw new Error(`Unknown asset: ${name}`);
  const scale = spec.scale ?? 1;
  const ctx = await browser.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: scale,
  });
  const page = await ctx.newPage();
  await page.goto(`${HOST}/?asset=${name}`, { waitUntil: "networkidle" });
  const el = await page.locator("#root > *").first();
  await el.waitFor({ state: "visible" });
  const file = resolve(OUTPUT, `${name}.png`);
  await el.screenshot({ path: file, omitBackground: !!spec.transparent });
  await ctx.close();
  const outW = spec.width * scale;
  const outH = spec.height * scale;
  console.log(`✓ ${name} → ${file} (${outW}×${outH}${scale > 1 ? ` @${scale}x` : ""})`);
}

async function main() {
  if (!existsSync(OUTPUT)) mkdirSync(OUTPUT, { recursive: true });

  const args = process.argv.slice(2);
  const target = args[0] ?? "all";
  const list = target === "all" ? Object.keys(ASSETS) : [target];

  const vite = await startVite();
  const browser = await chromium.launch();
  try {
    for (const name of list) await renderOne(browser, name);
  } finally {
    await browser.close();
    vite.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
