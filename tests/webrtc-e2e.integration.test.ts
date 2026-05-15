/**
 * End-to-end WebRTC integration test using node-datachannel + hexii party API.
 *
 * Tests the FULL flow: session creation → player join → signaling → WebRTC
 * connection → data channel message exchange.
 *
 * Requires: hexii running at localhost:3000 (cd hexii && npm run dev)
 * Run: npm test
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { PeerConnection, DataChannel } from "node-datachannel";

const BASE_URL = process.env.PARTY_API_URL ?? "http://localhost:3000";

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function get(path: string) {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ─── Signal Helpers ───────────────────────────────────────────────────────────

async function sendHostSignal(sessionId: string, hostSecret: string, recipientId: string, signalType: string, payload: any) {
  return post(`/api/party/sessions/${sessionId}/signals`, {
    host_secret: hostSecret,
    recipient_id: recipientId,
    signal_type: signalType,
    payload,
  });
}

async function sendPlayerSignal(sessionId: string, playerId: string, playerSecret: string, recipientId: string, signalType: string, payload: any) {
  return post(`/api/party/sessions/${sessionId}/signals`, {
    player_secret: playerSecret,
    sender_player_id: playerId,
    recipient_id: recipientId,
    signal_type: signalType,
    payload,
  });
}

async function pollSignals(sessionId: string, recipientId: string, sinceId: number) {
  return get(
    `/api/party/sessions/${sessionId}/signals?recipient_id=${encodeURIComponent(recipientId)}&since_id=${sinceId}&limit=50`,
  );
}

async function waitForSignal(
  sessionId: string,
  recipientId: string,
  signalType: string,
  sinceId: number,
  timeoutMs = 10000,
  fromSenderId?: string,
) {
  const deadline = Date.now() + timeoutMs;
  let cursor = sinceId;
  while (Date.now() < deadline) {
    const result = await pollSignals(sessionId, recipientId, cursor);
    const match = result.signals.find(
      (s: any) => s.signal_type === signalType && (!fromSenderId || s.sender_id === fromSenderId),
    );
    if (match) return { signal: match, next_since_id: result.next_since_id };
    cursor = result.next_since_id;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${signalType} signal for ${recipientId}`);
}

// ─── WebRTC + Signaling Flow ──────────────────────────────────────────────────

/**
 * Runs the complete offer/answer/ICE exchange through the hexii API
 * and establishes a WebRTC connection with a data channel.
 */
async function connectViaSignaling(opts: {
  sessionId: string;
  hostSecret: string;
  playerId: string;
  playerSecret: string;
  hostSignalCursor?: number;
}): Promise<{
  hostPc: InstanceType<typeof PeerConnection>;
  controllerPc: InstanceType<typeof PeerConnection>;
  hostDc: InstanceType<typeof DataChannel>;
  controllerDc: InstanceType<typeof DataChannel>;
  hostSignalCursorAfter: number;
}> {
  const { sessionId, hostSecret, playerId, playerSecret, hostSignalCursor = 0 } = opts;

  const hostPc = new PeerConnection("host", { iceServers: [] });
  const controllerPc = new PeerConnection("controller", { iceServers: [] });

  // ── Wire up ICE candidate forwarding via API ──

  hostPc.onLocalCandidate((candidate: string, mid: string) => {
    sendHostSignal(sessionId, hostSecret, playerId, "ice_candidate", { candidate, sdpMid: mid }).catch(() => {});
  });

  controllerPc.onLocalCandidate((candidate: string, mid: string) => {
    sendPlayerSignal(sessionId, playerId, playerSecret, "host", "ice_candidate", { candidate, sdpMid: mid }).catch(() => {});
  });

  // ── Host: set up description callback BEFORE creating data channel ──
  // (creating the data channel triggers offer generation immediately)

  const offerPromise = new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Host offer timeout")), 5000);
    hostPc.onLocalDescription((sdp: string, _type: string) => {
      clearTimeout(t);
      resolve(sdp);
    });
  });

  const hostDc = hostPc.createDataChannel("game-input");
  const offerSdp = await offerPromise;

  // Send offer via API
  await sendHostSignal(sessionId, hostSecret, playerId, "offer", { type: "offer", sdp: offerSdp });

  // ── Controller: receive offer, set remote, auto-generates answer ──

  const { signal: offerSig, next_since_id: cursor1 } = await waitForSignal(sessionId, playerId, "offer", 0);

  // Set up answer callback BEFORE setting remote description (which triggers answer generation)
  const answerPromise = new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Controller answer timeout")), 5000);
    controllerPc.onLocalDescription((sdp: string, _type: string) => {
      clearTimeout(t);
      resolve(sdp);
    });
  });

  controllerPc.setRemoteDescription(offerSig.payload.sdp, "offer");
  const answerSdp = await answerPromise;

  // Send answer via API
  await sendPlayerSignal(sessionId, playerId, playerSecret, "host", "answer", { type: "answer", sdp: answerSdp });

  // ── Host: receive answer (filter by this player's sender_id) ──

  const { signal: answerSig, next_since_id: hostCursor } = await waitForSignal(
    sessionId, "host", "answer", hostSignalCursor, 10000, playerId,
  );
  hostPc.setRemoteDescription(answerSig.payload.sdp, "answer");

  // ── Exchange ICE candidates via API (give them time to accumulate) ──

  await new Promise((r) => setTimeout(r, 500));

  // Apply controller → host ICE candidates (only from this player)
  const hostBound = (await pollSignals(sessionId, "host", hostSignalCursor)).signals;
  for (const s of hostBound.filter((s: any) => s.signal_type === "ice_candidate" && s.sender_id === playerId)) {
    hostPc.addRemoteCandidate(s.payload.candidate, s.payload.sdpMid ?? "0");
  }

  // Apply host → controller ICE candidates
  const ctrlBound = (await pollSignals(sessionId, playerId, 0)).signals;
  for (const s of ctrlBound.filter((s: any) => s.signal_type === "ice_candidate")) {
    controllerPc.addRemoteCandidate(s.payload.candidate, s.payload.sdpMid ?? "0");
  }

  // ── Wait for peer connection ──

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Host connection timeout (state: ${hostPc.state()})`)), 10000);
    if (hostPc.state() === "connected") { clearTimeout(t); resolve(); return; }
    hostPc.onStateChange((state: string) => {
      if (state === "connected") { clearTimeout(t); resolve(); }
      if (state === "failed" || state === "closed") { clearTimeout(t); reject(new Error(`Host state: ${state}`)); }
    });
  });

  // ── Wait for controller data channel ──

  const controllerDc = await new Promise<InstanceType<typeof DataChannel>>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Controller data channel timeout")), 10000);
    controllerPc.onDataChannel((dc: DataChannel) => {
      clearTimeout(t);
      resolve(dc);
    });
  });

  // Get the final cursor so subsequent connections can skip past these signals
  const finalHostPoll = await pollSignals(sessionId, "host", 0);
  const hostSignalCursorAfter = finalHostPoll.next_since_id;

  return { hostPc, controllerPc, hostDc, controllerDc, hostSignalCursorAfter };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Single-player WebRTC E2E", () => {
  let hostPc: InstanceType<typeof PeerConnection>;
  let controllerPc: InstanceType<typeof PeerConnection>;
  let hostDc: InstanceType<typeof DataChannel>;
  let controllerDc: InstanceType<typeof DataChannel>;
  let sessionId: string;
  let playerId: string;

  afterAll(() => {
    hostPc?.close();
    controllerPc?.close();
  });

  it("creates session, player joins, WebRTC connects, messages flow", async () => {
    // Create session
    const session = await post("/api/party/sessions", { game_id: "e2e-test" });
    sessionId = session.session_id;

    // Player joins
    const player = await post(`/api/party/sessions/${sessionId}/players`, { display_name: "Alice" });
    playerId = player.player_id;

    // Verify session state
    const sessionData = await get(`/api/party/sessions/${sessionId}`);
    expect(sessionData.player_count).toBe(1);
    expect(sessionData.players[0].player_id).toBe(playerId);

    // Full WebRTC connection via signaling API
    const result = await connectViaSignaling({
      sessionId,
      hostSecret: session.host_secret,
      playerId: player.player_id,
      playerSecret: player.player_secret,
    });
    hostPc = result.hostPc;
    controllerPc = result.controllerPc;
    hostDc = result.hostDc;
    controllerDc = result.controllerDc;

    expect(controllerDc.getLabel()).toBe("game-input");

    // ── Host → Controller message ──
    const configMsg = JSON.stringify({ type: "controller_config", config: { layout: "joystick-button" } });
    const receivedByCtrl = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Ctrl msg timeout")), 5000);
      controllerDc.onMessage((msg: string | Buffer) => { clearTimeout(t); resolve(msg.toString()); });
    });
    hostDc.sendMessage(configMsg);
    expect(JSON.parse(await receivedByCtrl)).toEqual(JSON.parse(configMsg));

    // ── Controller → Host message (simulated player input) ──
    const inputMsg = JSON.stringify({
      type: "player_input_batch",
      timestamp: Date.now(),
      inputs: { joystick_left: { x: 0.5, y: 0 }, button_right: { pressed: true } },
    });
    const receivedByHost = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Host msg timeout")), 5000);
      hostDc.onMessage((msg: string | Buffer) => { clearTimeout(t); resolve(msg.toString()); });
    });
    controllerDc.sendMessage(inputMsg);
    expect(JSON.parse(await receivedByHost)).toEqual(JSON.parse(inputMsg));
  }, 30000);
});

describe("Multi-player WebRTC E2E", () => {
  const peerConnections: InstanceType<typeof PeerConnection>[] = [];

  afterAll(() => {
    for (const pc of peerConnections) pc?.close();
  });

  it("two players connect independently and exchange messages with host", async () => {
    const session = await post("/api/party/sessions", { game_id: "e2e-multi" });
    const p1 = await post(`/api/party/sessions/${session.session_id}/players`, { display_name: "P1" });
    const p2 = await post(`/api/party/sessions/${session.session_id}/players`, { display_name: "P2" });

    const sessionData = await get(`/api/party/sessions/${session.session_id}`);
    expect(sessionData.player_count).toBe(2);

    // Connect player 1
    const c1 = await connectViaSignaling({
      sessionId: session.session_id,
      hostSecret: session.host_secret,
      playerId: p1.player_id,
      playerSecret: p1.player_secret,
    });
    peerConnections.push(c1.hostPc, c1.controllerPc);

    // Connect player 2 (pass cursor so it skips player 1's signals)
    const c2 = await connectViaSignaling({
      sessionId: session.session_id,
      hostSecret: session.host_secret,
      playerId: p2.player_id,
      playerSecret: p2.player_secret,
      hostSignalCursor: c1.hostSignalCursorAfter,
    });
    peerConnections.push(c2.hostPc, c2.controllerPc);

    // Player 1 sends → host receives
    const p1Input = JSON.stringify({ type: "input", x: 0.3 });
    const p1Rx = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("P1→Host timeout")), 5000);
      c1.hostDc.onMessage((m: string | Buffer) => { clearTimeout(t); resolve(m.toString()); });
    });
    c1.controllerDc.sendMessage(p1Input);
    expect(JSON.parse(await p1Rx)).toEqual(JSON.parse(p1Input));

    // Player 2 sends → host receives
    const p2Input = JSON.stringify({ type: "input", x: -0.7 });
    const p2Rx = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("P2→Host timeout")), 5000);
      c2.hostDc.onMessage((m: string | Buffer) => { clearTimeout(t); resolve(m.toString()); });
    });
    c2.controllerDc.sendMessage(p2Input);
    expect(JSON.parse(await p2Rx)).toEqual(JSON.parse(p2Input));

    // Host broadcasts to both (host sends to each player's data channel)
    const broadcast = JSON.stringify({ type: "game_state", tick: 42 });

    const b1Rx = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Broadcast→P1 timeout")), 5000);
      c1.controllerDc.onMessage((m: string | Buffer) => { clearTimeout(t); resolve(m.toString()); });
    });
    const b2Rx = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Broadcast→P2 timeout")), 5000);
      c2.controllerDc.onMessage((m: string | Buffer) => { clearTimeout(t); resolve(m.toString()); });
    });

    c1.hostDc.sendMessage(broadcast);
    c2.hostDc.sendMessage(broadcast);

    const [r1, r2] = await Promise.all([b1Rx, b2Rx]);
    expect(JSON.parse(r1)).toEqual(JSON.parse(broadcast));
    expect(JSON.parse(r2)).toEqual(JSON.parse(broadcast));
  }, 60000);
});

// ─── Input Pipeline E2E ─────────────────────────────────────────────────────

describe("Input Pipeline E2E", () => {
  let hostPc: InstanceType<typeof PeerConnection>;
  let controllerPc: InstanceType<typeof PeerConnection>;
  let hostDc: InstanceType<typeof DataChannel>;
  let controllerDc: InstanceType<typeof DataChannel>;

  afterAll(() => {
    hostPc?.close();
    controllerPc?.close();
  });

  /**
   * Helper: send a message and wait for the other side to receive it.
   */
  function sendAndReceive(
    sender: InstanceType<typeof DataChannel>,
    receiver: InstanceType<typeof DataChannel>,
    msg: string,
    label: string,
  ): Promise<string> {
    const p = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timeout`)), 5000);
      receiver.onMessage((m: string | Buffer) => { clearTimeout(t); resolve(m.toString()); });
    });
    sender.sendMessage(msg);
    return p;
  }

  it("establishes connection for input tests", async () => {
    const session = await post("/api/party/sessions", { game_id: "e2e-input" });
    const player = await post(`/api/party/sessions/${session.session_id}/players`, { display_name: "Tester" });

    const result = await connectViaSignaling({
      sessionId: session.session_id,
      hostSecret: session.host_secret,
      playerId: player.player_id,
      playerSecret: player.player_secret,
    });
    hostPc = result.hostPc;
    controllerPc = result.controllerPc;
    hostDc = result.hostDc;
    controllerDc = result.controllerDc;

    expect(controllerDc.getLabel()).toBe("game-input");
  }, 30000);

  it("controller sends player_join and host receives it", async () => {
    const joinMsg = {
      type: "player_join",
      player: {
        player_id: "test-player-1",
        name: "Tester",
        session_id: "test-session",
        slot: 1,
        status: "connected",
        controller_config: null,
        joined_at: new Date().toISOString(),
      },
    };

    const received = await sendAndReceive(controllerDc, hostDc, JSON.stringify(joinMsg), "player_join");
    const parsed = JSON.parse(received);
    expect(parsed.type).toBe("player_join");
    expect(parsed.player.player_id).toBe("test-player-1");
    expect(parsed.player.name).toBe("Tester");
  });

  it("controller sends player_input_batch with joystick + button", async () => {
    const inputMsg = {
      type: "player_input_batch",
      timestamp: Date.now(),
      inputs: {
        joystick_left: { x: 0.75, y: 0 },
        button_right: { pressed: true },
      },
    };

    const received = await sendAndReceive(controllerDc, hostDc, JSON.stringify(inputMsg), "input_batch");
    const parsed = JSON.parse(received);
    expect(parsed.type).toBe("player_input_batch");
    expect(parsed.inputs.joystick_left.x).toBe(0.75);
    expect(parsed.inputs.joystick_left.y).toBe(0);
    expect(parsed.inputs.button_right.pressed).toBe(true);
  });

  it("host receives rapid input stream at 30Hz pace", async () => {
    const received: string[] = [];
    const allReceived = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Only got ${received.length}/5 inputs`)), 5000);
      hostDc.onMessage((m: string | Buffer) => {
        received.push(m.toString());
        if (received.length >= 5) { clearTimeout(t); resolve(); }
      });
    });

    // Send 5 frames of input at ~33ms intervals (like the controller does)
    for (let i = 0; i < 5; i++) {
      const msg = {
        type: "player_input_batch",
        timestamp: Date.now(),
        inputs: {
          joystick_left: { x: (i - 2) * 0.25, y: 0 }, // -0.5, -0.25, 0, 0.25, 0.5
          button_right: { pressed: i >= 3 }, // false, false, false, true, true
        },
      };
      controllerDc.sendMessage(JSON.stringify(msg));
      await new Promise(r => setTimeout(r, 33));
    }

    await allReceived;
    expect(received.length).toBe(5);

    // Verify the last input has the expected values
    const last = JSON.parse(received[4]);
    expect(last.inputs.joystick_left.x).toBe(0.5);
    expect(last.inputs.button_right.pressed).toBe(true);

    // Verify inputs arrived in order
    const xs = received.map(r => JSON.parse(r).inputs.joystick_left.x);
    expect(xs).toEqual([-0.5, -0.25, 0, 0.25, 0.5]);
  });

  it("host sends controller_config and controller receives it", async () => {
    const configMsg = {
      type: "controller_config",
      config: {
        layout: {
          left: { type: "joystick", label: "Move" },
          right: { type: "button", label: "Expand" },
        },
      },
    };

    const received = await sendAndReceive(hostDc, controllerDc, JSON.stringify(configMsg), "config");
    const parsed = JSON.parse(received);
    expect(parsed.type).toBe("controller_config");
    expect(parsed.config.layout.left.type).toBe("joystick");
    expect(parsed.config.layout.right.type).toBe("button");
  });

  it("bidirectional: input + game state flow simultaneously", async () => {
    // Controller sends input
    const inputMsg = {
      type: "player_input_batch",
      timestamp: Date.now(),
      inputs: { joystick_left: { x: -1, y: 0 }, button_right: { pressed: false } },
    };

    // Host sends game state
    const stateMsg = {
      type: "game_state",
      tick: 100,
      players: [{ id: "p1", x: 50, y: 200, expanding: false }],
    };

    const hostRx = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("bidir host rx timeout")), 5000);
      hostDc.onMessage((m: string | Buffer) => { clearTimeout(t); resolve(m.toString()); });
    });
    const ctrlRx = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("bidir ctrl rx timeout")), 5000);
      controllerDc.onMessage((m: string | Buffer) => { clearTimeout(t); resolve(m.toString()); });
    });

    // Send both directions at the same time
    controllerDc.sendMessage(JSON.stringify(inputMsg));
    hostDc.sendMessage(JSON.stringify(stateMsg));

    const [hostReceived, ctrlReceived] = await Promise.all([hostRx, ctrlRx]);
    expect(JSON.parse(hostReceived).inputs.joystick_left.x).toBe(-1);
    expect(JSON.parse(ctrlReceived).tick).toBe(100);
  });
});
