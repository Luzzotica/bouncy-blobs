/**
 * Integration tests for the party signaling API.
 *
 * These tests hit the live hexii API at PARTY_API_URL (default http://localhost:3000).
 * Start hexii before running: cd hexii && npm run dev
 *
 * Run: npm test
 */
import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = process.env.PARTY_API_URL ?? "http://localhost:3000";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

async function patch(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Party API - Session lifecycle", () => {
  let sessionId: string;
  let joinCode: string;
  let hostSecret: string;

  it("creates a session", async () => {
    const data = await post("/api/party/sessions", {
      game_id: "bouncy-blobs-test",
      max_players: 4,
    });
    expect(data.session_id).toBeDefined();
    expect(data.join_code).toBeDefined();
    expect(data.host_secret).toBeDefined();
    expect(data.join_code).toHaveLength(6);

    sessionId = data.session_id;
    joinCode = data.join_code;
    hostSecret = data.host_secret;
  });

  it("retrieves session with empty player list", async () => {
    const data = await get(`/api/party/sessions/${sessionId}`);
    expect(data.session_id).toBe(sessionId);
    expect(data.join_code).toBe(joinCode);
    expect(data.game_id).toBe("bouncy-blobs-test");
    expect(data.status).toBe("waiting");
    expect(data.players).toEqual([]);
    expect(data.player_count).toBe(0);
  });

  it("ends a session", async () => {
    const data = await patch(`/api/party/sessions/${sessionId}`, {
      host_secret: hostSecret,
      status: "ended",
    });
    expect(data.ok).toBe(true);

    const session = await get(`/api/party/sessions/${sessionId}`);
    expect(session.status).toBe("ended");
  });
});

describe("Party API - Player join", () => {
  let sessionId: string;
  let hostSecret: string;
  let player1Id: string;
  let player1Secret: string;
  let player2Id: string;
  let player2Secret: string;

  beforeAll(async () => {
    const session = await post("/api/party/sessions", {
      game_id: "bouncy-blobs-test",
      max_players: 4,
    });
    sessionId = session.session_id;
    hostSecret = session.host_secret;
  });

  it("player 1 joins with display name", async () => {
    const data = await post(`/api/party/sessions/${sessionId}/players`, {
      display_name: "Alice",
    });
    expect(data.player_id).toBeDefined();
    expect(data.player_secret).toBeDefined();
    expect(data.display_name).toBe("Alice");
    expect(data.slot).toBe(1);

    player1Id = data.player_id;
    player1Secret = data.player_secret;
  });

  it("player 2 joins", async () => {
    const data = await post(`/api/party/sessions/${sessionId}/players`, {
      display_name: "Bob",
    });
    expect(data.player_id).toBeDefined();
    expect(data.slot).toBe(2);

    player2Id = data.player_id;
    player2Secret = data.player_secret;
  });

  it("session shows both players", async () => {
    const data = await get(`/api/party/sessions/${sessionId}`);
    expect(data.player_count).toBe(2);
    expect(data.players).toHaveLength(2);

    const names = data.players.map((p: any) => p.display_name);
    expect(names).toContain("Alice");
    expect(names).toContain("Bob");

    // Verify player_id matches what was returned at join time
    const alice = data.players.find((p: any) => p.display_name === "Alice");
    expect(alice.player_id).toBe(player1Id);
  });
});

describe("Party API - Signal exchange (full WebRTC signaling flow)", () => {
  let sessionId: string;
  let hostSecret: string;
  let playerId: string;
  let playerSecret: string;

  beforeAll(async () => {
    // Create session
    const session = await post("/api/party/sessions", {
      game_id: "bouncy-blobs-test",
    });
    sessionId = session.session_id;
    hostSecret = session.host_secret;

    // Player joins
    const player = await post(`/api/party/sessions/${sessionId}/players`, {
      display_name: "TestPlayer",
    });
    playerId = player.player_id;
    playerSecret = player.player_secret;
  });

  it("host sends offer to player, player receives it", async () => {
    // Host sends offer addressed to the player
    const offerPayload = { type: "offer", sdp: "v=0\r\nfake-sdp-offer" };
    const sendResult = await post(`/api/party/sessions/${sessionId}/signals`, {
      host_secret: hostSecret,
      recipient_id: playerId,
      signal_type: "offer",
      payload: offerPayload,
    });
    expect(sendResult.signal_id).toBeDefined();

    // Player polls for signals
    const pollResult = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=${playerId}&since_id=0`,
    );
    expect(pollResult.signals.length).toBeGreaterThanOrEqual(1);

    const offer = pollResult.signals.find((s: any) => s.signal_type === "offer");
    expect(offer).toBeDefined();
    expect(offer.sender_id).toBe("host");
    expect(offer.payload).toEqual(offerPayload);
    expect(pollResult.next_since_id).toBeGreaterThan(0);
  });

  it("player sends answer to host, host receives it", async () => {
    // Player sends answer
    const answerPayload = { type: "answer", sdp: "v=0\r\nfake-sdp-answer" };
    const sendResult = await post(`/api/party/sessions/${sessionId}/signals`, {
      player_secret: playerSecret,
      sender_player_id: playerId,
      recipient_id: "host",
      signal_type: "answer",
      payload: answerPayload,
    });
    expect(sendResult.signal_id).toBeDefined();

    // Host polls for signals
    const pollResult = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=host&since_id=0`,
    );
    expect(pollResult.signals.length).toBeGreaterThanOrEqual(1);

    const answer = pollResult.signals.find((s: any) => s.signal_type === "answer");
    expect(answer).toBeDefined();
    expect(answer.sender_id).toBe(playerId);
    expect(answer.payload).toEqual(answerPayload);
  });

  it("host sends ICE candidates to player, player receives them", async () => {
    const candidate1 = { candidate: "candidate:1 1 udp 2113937151 192.168.1.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    const candidate2 = { candidate: "candidate:2 1 udp 1845501695 1.2.3.4 6000 typ srflx", sdpMid: "0", sdpMLineIndex: 0 };

    // Host sends two ICE candidates
    await post(`/api/party/sessions/${sessionId}/signals`, {
      host_secret: hostSecret,
      recipient_id: playerId,
      signal_type: "ice_candidate",
      payload: candidate1,
    });
    await post(`/api/party/sessions/${sessionId}/signals`, {
      host_secret: hostSecret,
      recipient_id: playerId,
      signal_type: "ice_candidate",
      payload: candidate2,
    });

    // Player polls — should get offer + 2 ICE candidates
    const pollResult = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=${playerId}&since_id=0`,
    );
    const iceCandidates = pollResult.signals.filter((s: any) => s.signal_type === "ice_candidate");
    expect(iceCandidates.length).toBe(2);
    expect(iceCandidates[0].sender_id).toBe("host");
  });

  it("player sends ICE candidates to host, host receives them", async () => {
    const candidate = { candidate: "candidate:3 1 udp 2113937151 192.168.1.2 7000 typ host", sdpMid: "0", sdpMLineIndex: 0 };

    await post(`/api/party/sessions/${sessionId}/signals`, {
      player_secret: playerSecret,
      sender_player_id: playerId,
      recipient_id: "host",
      signal_type: "ice_candidate",
      payload: candidate,
    });

    const pollResult = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=host&since_id=0`,
    );
    const iceCandidates = pollResult.signals.filter((s: any) => s.signal_type === "ice_candidate");
    expect(iceCandidates.length).toBeGreaterThanOrEqual(1);
    expect(iceCandidates[0].sender_id).toBe(playerId);
  });

  it("cursor-based polling skips already-seen signals", async () => {
    // Get all signals for player first
    const firstPoll = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=${playerId}&since_id=0`,
    );
    const cursor = firstPoll.next_since_id;
    expect(cursor).toBeGreaterThan(0);

    // Poll again with the cursor — should get nothing new
    const secondPoll = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=${playerId}&since_id=${cursor}`,
    );
    expect(secondPoll.signals).toHaveLength(0);
    expect(secondPoll.next_since_id).toBe(cursor);
  });
});

describe("Party API - Multi-player signaling", () => {
  let sessionId: string;
  let hostSecret: string;
  let player1Id: string;
  let player1Secret: string;
  let player2Id: string;
  let player2Secret: string;

  beforeAll(async () => {
    const session = await post("/api/party/sessions", { game_id: "bouncy-blobs-test" });
    sessionId = session.session_id;
    hostSecret = session.host_secret;

    const p1 = await post(`/api/party/sessions/${sessionId}/players`, { display_name: "P1" });
    player1Id = p1.player_id;
    player1Secret = p1.player_secret;

    const p2 = await post(`/api/party/sessions/${sessionId}/players`, { display_name: "P2" });
    player2Id = p2.player_id;
    player2Secret = p2.player_secret;
  });

  it("host sends offers to both players independently", async () => {
    // Send offer to player 1
    await post(`/api/party/sessions/${sessionId}/signals`, {
      host_secret: hostSecret,
      recipient_id: player1Id,
      signal_type: "offer",
      payload: { type: "offer", sdp: "offer-for-p1" },
    });

    // Send offer to player 2
    await post(`/api/party/sessions/${sessionId}/signals`, {
      host_secret: hostSecret,
      recipient_id: player2Id,
      signal_type: "offer",
      payload: { type: "offer", sdp: "offer-for-p2" },
    });

    // Player 1 should only see their offer
    const p1Poll = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=${player1Id}&since_id=0`,
    );
    expect(p1Poll.signals).toHaveLength(1);
    expect(p1Poll.signals[0].payload.sdp).toBe("offer-for-p1");

    // Player 2 should only see their offer
    const p2Poll = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=${player2Id}&since_id=0`,
    );
    expect(p2Poll.signals).toHaveLength(1);
    expect(p2Poll.signals[0].payload.sdp).toBe("offer-for-p2");
  });

  it("both players can answer and host sees both answers", async () => {
    // Player 1 answers
    await post(`/api/party/sessions/${sessionId}/signals`, {
      player_secret: player1Secret,
      sender_player_id: player1Id,
      recipient_id: "host",
      signal_type: "answer",
      payload: { type: "answer", sdp: "answer-from-p1" },
    });

    // Player 2 answers
    await post(`/api/party/sessions/${sessionId}/signals`, {
      player_secret: player2Secret,
      sender_player_id: player2Id,
      recipient_id: "host",
      signal_type: "answer",
      payload: { type: "answer", sdp: "answer-from-p2" },
    });

    // Host polls — should see both answers with correct sender_ids
    const hostPoll = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=host&since_id=0`,
    );
    const answers = hostPoll.signals.filter((s: any) => s.signal_type === "answer");
    expect(answers).toHaveLength(2);

    const senders = answers.map((a: any) => a.sender_id).sort();
    expect(senders).toEqual([player1Id, player2Id].sort());
  });

  it("host can route ICE candidates to specific players", async () => {
    // Send ICE only to player 2
    await post(`/api/party/sessions/${sessionId}/signals`, {
      host_secret: hostSecret,
      recipient_id: player2Id,
      signal_type: "ice_candidate",
      payload: { candidate: "ice-for-p2-only" },
    });

    // Player 1 shouldn't see it (since_id=0 to get all, but filter by new signals)
    const p1Poll = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=${player1Id}&since_id=0`,
    );
    const p1Ice = p1Poll.signals.filter((s: any) => s.signal_type === "ice_candidate");
    expect(p1Ice).toHaveLength(0);

    // Player 2 should see it
    const p2Poll = await get(
      `/api/party/sessions/${sessionId}/signals?recipient_id=${player2Id}&since_id=0`,
    );
    const p2Ice = p2Poll.signals.filter((s: any) => s.signal_type === "ice_candidate");
    expect(p2Ice.length).toBeGreaterThanOrEqual(1);
    expect(p2Ice.some((s: any) => s.payload.candidate === "ice-for-p2-only")).toBe(true);
  });
});

describe("Party API - Auth validation", () => {
  let sessionId: string;
  let hostSecret: string;
  let playerId: string;

  beforeAll(async () => {
    const session = await post("/api/party/sessions", { game_id: "auth-test" });
    sessionId = session.session_id;
    hostSecret = session.host_secret;

    const player = await post(`/api/party/sessions/${sessionId}/players`, { display_name: "AuthTest" });
    playerId = player.player_id;
  });

  it("rejects signal with wrong host_secret", async () => {
    const res = await fetch(`${BASE_URL}/api/party/sessions/${sessionId}/signals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host_secret: "wrong-secret",
        recipient_id: playerId,
        signal_type: "offer",
        payload: { type: "offer", sdp: "bad" },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects signal with no auth", async () => {
    const res = await fetch(`${BASE_URL}/api/party/sessions/${sessionId}/signals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient_id: playerId,
        signal_type: "offer",
        payload: { type: "offer", sdp: "bad" },
      }),
    });
    expect(res.status).toBe(400);
  });
});
