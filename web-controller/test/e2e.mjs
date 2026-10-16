// End to end against a partii platform: a "game" page hosts a bouncy-blobs
// room with the engine (kind "game"); an emulated phone opens /join, types the
// code (landing on /c/CODE), enters a name and plays. The game must get a
// reliable player_join + hello, the phone must react to a game→phone
// customization_update (taken colors/faces) and seat/layout, stick + expand
// must arrive as partii's unreliable 10-byte 0x50 frames (~30 Hz), a 0 ms tap
// must still reach the game, and the host leaving must send the phone back to
// /join.
//   npm run build && PARTII_API=http://127.0.0.1:8787 PARTII_KEY=pk_... npm test
//   (PAGE=https://bouncy-blobs-staging.partii.games to test the deployed page)
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const edge = process.env.PARTII_API ?? "http://127.0.0.1:8787";
const key = process.env.PARTII_KEY ?? "pk_demo_k1_A7ZzxXtfq8H806VOVu-1Jq";
if (!existsSync(join(dist, "engine/partii_engine_bg.wasm"))) throw new Error("run `npm run build` first");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  let p = join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(dist, "index.html");
  res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
// PAGE=https://bouncy-blobs-staging.partii.games tests a deployed page.
const base = process.env.PAGE?.replace(/\/$/, "") ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--mute-audio'] }); // never through the speakers
const done = async (result) => {
  console.log(JSON.stringify(result));
  await browser.close();
  server.close();
  process.exit(result.ok ? 0 : 1);
};
const fail = (error, extra = {}) => done({ ok: false, error, ...extra });

// ── The game side: a plain engine instance in a page, kind "game". ──
const game = await browser.newPage();
await game.goto(`${base}/join`);
let code;
try {
  code = await game.evaluate(async ({ edge, key }) => {
    const mod = await import("/engine/partii_engine.js");
    await mod.default();
    const e = new mod.WebEngine(JSON.stringify({ edge, key, conn: "", client: "e2e-bb-game", player_token: null, no_webrtc: false }));
    const g = (window.__game = { e, msgs: [], members: [], left: [] });
    return await new Promise((resolve, reject) => {
      let asked = false;
      setTimeout(() => reject(new Error("no room created")), 15000);
      setInterval(() => {
        for (const ev of JSON.parse(e.poll())) {
          if (ev.ev === "online" && !asked) { asked = true; e.create("bouncy-blobs", 9, "game", "Bouncy Blobs", "{}"); }
          if (ev.ev === "created") resolve(ev.room.code);
          if (ev.ev === "failed") reject(new Error(`${ev.code}: ${ev.message}`));
          if (ev.ev === "member_joined") g.members.push(ev.member);
          if (ev.ev === "member_left") g.left.push(ev.mid);
          if (ev.ev === "message") {
            const b = new Uint8Array(ev.bytes);
            if (b[0] === 0x50 && b.length >= 9) {
              const v = new DataView(b.buffer);
              g.msgs.push({ from: ev.from, reliable: ev.reliable, at: performance.now(), frame: { seq: v.getUint16(1, true), lx: v.getInt8(3), ly: v.getInt8(4), buttons: v.getUint16(7, true), len: b.length } });
              continue;
            }
            const text = new TextDecoder().decode(b);
            let msg = null;
            try { msg = JSON.parse(text); } catch {}
            g.msgs.push({ from: ev.from, reliable: ev.reliable, msg });
          }
        }
      }, 10);
    });
  }, { edge, key });
} catch (err) {
  await fail(`game could not create a room: ${err.message}`);
}

// ── The phone: /join → type code → name → customize → play. ──
const phoneCtx = await browser.newContext({ ...devices["iPhone 13 landscape"] });
const phone = await phoneCtx.newPage();
const t0 = Date.now();
await phone.goto(`${base}/join?k=${encodeURIComponent(key)}&e=${encodeURIComponent(edge)}`);
await phone.fill('input[placeholder="ABCDE"]', code.toLowerCase());
await phone.getByRole("button", { name: "Join" }).click();
await phone.waitForURL(new RegExp(`/c/${code}\\?`));
await phone.fill('input[placeholder="Your name"]', "Sam");
await phone.getByRole("button", { name: "Join" }).click();
try {
  await phone.getByRole("heading", { name: "Customize" }).waitFor({ timeout: 15000 });
} catch {
  await fail(`phone never joined: ${await phone.textContent("body")}`);
}
const joinMs = Date.now() - t0;

const msgs = () => game.evaluate(() => window.__game.msgs);
const waitMsg = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = (await msgs()).find(pred);
    if (m) return m;
    await phone.waitForTimeout(50);
  }
  return null;
};

const joinMsg = await waitMsg((m) => m.msg?.type === "player_join");
const helloMsg = await waitMsg((m) => m.msg?.t === "hello");
const phoneMember = (await game.evaluate(() => window.__game.members)).find((m) => m.kind === "phone");

// Game → phone: the first palette color and the default face are taken.
const firstColor = await phone.locator("[data-testid=color-swatch]").first().getAttribute("data-color");
const takenBefore = await phone.locator("[data-testid=color-swatch][data-taken='1']").count();
await game.evaluate(({ to, color }) => {
  const m = { type: "customization_update", value: { takenColors: [color], takenFaces: ["default"] } };
  window.__game.e.send(to, true, new TextEncoder().encode(JSON.stringify(m)));
}, { to: phoneMember?.mid ?? 0, color: firstColor });
let pageReacted = false;
try {
  await phone.locator(`[data-testid=color-swatch][data-color='${firstColor}'][data-taken='1']`).waitFor({ timeout: 5000 });
  await phone.locator("[data-testid=face-swatch][data-face='default'][data-taken='1']").waitFor({ timeout: 2000 });
  pageReacted = true;
} catch {}
// The page re-picks a free color/face and tells the game (reliable).
const custom = await waitMsg((m) => m.msg?.type === "customization_update" && m.msg.value?.color && m.msg.value.color !== firstColor && m.msg.value.faceId !== "default");

// Game → phone: seat and layout (partii's standard messages).
await game.evaluate(({ to }) => {
  const enc = (m) => new TextEncoder().encode(JSON.stringify(m));
  window.__game.e.send(to, true, enc({ t: "seat", label: "P2", color: "#6ecf6e" }));
  window.__game.e.send(to, true, enc({ t: "layout", buttons: ["EXPAND"] }));
  window.__game.e.send(to, true, enc({ t: "rumble", ms: 120 }));
}, { to: phoneMember?.mid ?? 0 });

// Play: stick right, release, then hold expand.
await phone.getByRole("button", { name: "Let's Go!" }).click();
let seated = false;
try {
  await phone.locator("[data-testid=controller][data-seat='P2'][data-seat-color='#6ecf6e']").waitFor({ timeout: 5000 });
  seated = true;
} catch {}
const expandLabel = (await phone.locator("[data-testid=controller-expand-zone]").textContent())?.trim();
// Frame rate at rest over one second.
const restFrom = await game.evaluate(() => performance.now());
await phone.waitForTimeout(1000);
const restFrames = (await msgs()).filter((m) => m.frame && m.at >= restFrom && m.at < restFrom + 1000).length;
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
await phone.waitForTimeout(300);
// A 0 ms tap on EXPAND still reaches the game (held >= 100 ms).
const tapFrom = (await msgs()).length;
await phone.mouse.move(zone.x + zone.width * 1.5, cy);
await phone.mouse.down();
await phone.mouse.up();
await phone.waitForTimeout(400);
const tapSeen = (await msgs()).slice(tapFrom).some((m) => m.frame && (m.frame.buttons & 1));

const all = await msgs();
const frames = all.filter((m) => m.frame).map((m) => ({ ...m.frame, reliable: m.reliable }));
// Unreliable frames may arrive out of order (the game drops stale ones), but
// seq never restarts: a restart would make the game drop every later frame.
let maxSeq = 0;
const backsteps = frames.filter((f) => { const back = f.seq < maxSeq; maxSeq = Math.max(maxSeq, f.seq); return back; }).map((f) => [f.seq, maxSeq]);
// A restart would leave the stream's newest frames far below the highest seq
// seen; stragglers (old frames arriving late, seen on staging just after the
// path upgrade) don't.
const tail = frames.slice(-10).map((f) => f.seq).sort((a, b) => a - b);
const seqUp = frames.length > 0 && maxSeq - tail[tail.length >> 1] < 30;
const fromPhone = all.every((m) => m.from === phoneMember?.mid);

// The host leaves: the playing phone goes back to /join (keeping ?k=&e=).
await game.evaluate(() => window.__game.e.leave());
let backToJoin = false;
try {
  await phone.waitForURL(/\/join\?k=/, { timeout: 8000 });
  backToJoin = true;
} catch {}

const checks = {
  phone_member: phoneMember?.name === "Sam",
  player_join_reliable: !!joinMsg && joinMsg.reliable === true && joinMsg.msg.player?.name === "Sam" && joinMsg.msg.player?.session_id === code,
  hello_reliable: !!helloMsg && helloMsg.reliable === true && helloMsg.msg.name === "Sam",
  page_shows_taken: pageReacted && takenBefore === 0,
  customization_reliable: !!custom && custom.reliable === true,
  seat_and_layout_shown: seated && expandLabel === "EXPAND",
  frames_unreliable_10_bytes: frames.length > 10 && frames.every((f) => f.reliable === false && f.len === 10),
  frames_about_30hz_at_rest: restFrames >= 20 && restFrames <= 45,
  seq_rises: seqUp,
  moved_right: frames.some((f) => f.lx > 100 && f.ly === 0),
  expand_is_primary: frames.some((f) => f.buttons === 1),
  released: frames.length > 0 && frames[frames.length - 1].buttons === 0,
  zero_ms_tap_lands: tapSeen,
  no_json_input: !all.some((m) => m.msg?.type === "player_input_batch"),
  all_from_phone: fromPhone,
  host_left_to_join: backToJoin,
};
await done({
  ok: Object.values(checks).every(Boolean),
  code,
  join_ms: joinMs,
  messages: all.length,
  frames: frames.length,
  rest_frames_per_s: restFrames,
  seq_backsteps: backsteps.slice(0, 10),
  checks,
});
