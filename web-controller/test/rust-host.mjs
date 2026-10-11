// The phone page against the real Rust host: bb-net's `phone_host` example
// hosts a bouncy-blobs room on partii and exits 0 once it has seen a
// player_join, a stick push right and a button press from a phone. An
// emulated phone opens /join, types the printed code and plays.
//   npm run build && PARTII_API=http://127.0.0.1:8787 PARTII_KEY=pk_... npm run test:rust-host
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../dist");
const repo = join(here, "../..");
const edge = process.env.PARTII_API ?? "http://127.0.0.1:8787";
const key = process.env.PARTII_KEY ?? "pk_demo_k1_A7ZzxXtfq8H806VOVu-1Jq";
if (!existsSync(join(dist, "engine/partii_engine_bg.wasm"))) throw new Error("run `npm run build` first");

execFileSync("cargo", ["build", "-q", "-p", "bb-net", "--example", "phone_host"], { cwd: repo, stdio: "inherit" });
const host = spawn(join(repo, "target/debug/examples/phone_host"), [], {
  cwd: repo,
  env: { ...process.env, BB_PARTII_API: edge, BB_PARTII_KEY: key },
});
let log = "";
const hostExit = new Promise((r) => host.on("exit", (c) => r(c)));
const code = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`host printed no room:\n${log}`)), 20000);
  host.stdout.on("data", (d) => {
    log += d;
    const m = log.match(/ROOM ([A-Z]{5})/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
  host.stderr.on("data", (d) => (log += d));
});

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  let p = join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(dist, "index.html");
  res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const finish = async (result) => {
  console.log(JSON.stringify(result));
  host.kill();
  await browser.close();
  server.close();
  process.exit(result.ok ? 0 : 1);
};

const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"] });
const phone = await ctx.newPage();
const t0 = Date.now();
await phone.goto(`${base}/join?k=${encodeURIComponent(key)}&e=${encodeURIComponent(edge)}`);
await phone.fill('input[placeholder="ABCDE"]', code);
await phone.getByRole("button", { name: "Join" }).click();
await phone.fill('input[placeholder="Your name"]', "Rusty");
await phone.getByRole("button", { name: "Join" }).click();
try {
  await phone.getByRole("heading", { name: "Customize" }).waitFor({ timeout: 15000 });
} catch {
  await finish({ ok: false, error: "phone never joined", host: log });
}
const joinMs = Date.now() - t0;
// The host marks "#e06070" and the cat face taken once the link opens.
let sawTaken = false;
try {
  await phone.locator("[data-testid=face-swatch][data-face='cat'][data-taken='1']").waitFor({ timeout: 8000 });
  sawTaken = true;
} catch {}
await phone.getByRole("button", { name: "Let's Go!" }).click();
const zone = await phone.locator("[data-testid=controller-move-zone]").boundingBox();
const cx = zone.x + zone.width / 2, cy = zone.y + zone.height / 2;
await phone.mouse.move(cx, cy);
await phone.mouse.down();
await phone.mouse.move(cx + 70, cy, { steps: 4 });
await phone.waitForTimeout(400);
await phone.mouse.up();
await phone.mouse.move(zone.x + zone.width * 1.5, cy);
await phone.mouse.down();
await phone.waitForTimeout(400);
await phone.mouse.up();

const exit = await Promise.race([hostExit, new Promise((r) => setTimeout(() => r("timeout"), 15000))]);
await finish({
  ok: exit === 0 && sawTaken,
  code,
  join_ms: joinMs,
  host_exit: exit,
  checks: { host_saw_join_move_press: exit === 0, phone_saw_taken_from_host: sawTaken },
  host_log: exit === 0 ? undefined : log,
});
