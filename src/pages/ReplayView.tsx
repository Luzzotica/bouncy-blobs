// Replay playback — reconstructs the exact match from the recorded input log,
// the same way a live guest replica reconstructs the host's sim. Loads the
// replay by id, rebuilds the game (seed + level + roster in recorded order),
// and drives it tick-by-tick from the log via the sim step driver.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import GameCanvas from '../components/GameCanvas';
import { BouncyBlobsGame } from '../game/bouncyBlobsGame';
import { ClassicMode } from '../game/gameModes/classicMode';
import { ChainedMode } from '../game/gameModes/chainedMode';
import { KingOfTheHillMode } from '../game/gameModes/kingOfTheHillMode';
import { makeBouncyBlobsSimDriver } from '../game/net/simDriver';
import type { GameContext } from '../game/GameInterface';
import type { GameMode } from '../game/gameModes/types';
import type { LevelData, LevelType } from '../levels/types';
import { CloudContent, decodeReplay } from '../lib/party';
import { roomConfig, GAME_ID } from '../lib/partyConfig';
import { REPLAY_BUILD, type BbReplay } from '../replay/replayRecorder';
import { COLORS } from '../theme/uiTheme';

const cloud = new CloudContent({ baseUrl: roomConfig.baseUrl, apiKey: roomConfig.apiKey, gameId: GAME_ID });

function modeFor(level: LevelData, type: LevelType): GameMode {
  switch (type) {
    case 'team_racing': return new ChainedMode(level);
    case 'koth': return new KingOfTheHillMode(level);
    default: return new ClassicMode(level);
  }
}

export default function ReplayView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [replay, setReplay] = useState<BbReplay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gameRef = useRef<BouncyBlobsGame | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await cloud.fetchData<unknown>(id);
        const rep = decodeReplay(typeof data === 'string' ? data : JSON.stringify(data)) as BbReplay;
        if (rep.buildVersion !== REPLAY_BUILD) {
          if (!cancelled) setError('Replay unavailable — the game has been updated since it was recorded.');
          return;
        }
        if (!cancelled) setReplay(rep);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load replay');
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const onCanvasInit = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    if (!replay) return;
    const h = replay.header;
    const game = new BouncyBlobsGame();
    gameRef.current = game;
    game.setRngSeed(h.rngSeed);
    game.setGameMode(modeFor(h.levelData, h.levelType));
    const context: GameContext = {
      connection: null, sessionId: 'replay', players: [],
      gameState: {}, playerStates: new Map(),
      inputManager: null as never, api: { updateControllerLayout: () => {} },
    };
    game.initialize(context);
    // Rebuild the roster in the recorded order (spawn order affects the seed).
    for (const p of h.players) {
      game.onPlayerJoin?.(context, {
        player_id: p.playerId, session_id: '', name: p.name ?? 'Player',
        slot: 0, status: 'connected', controller_config: null,
        joined_at: new Date().toISOString(),
      });
    }
    game.setCameraMode('fit-all');
    game.setCanvas(ctx.canvas, ctx, width, height);
    game.start();

    // Feed the recorded authoritative inputs one tick at a time (mirrors the
    // live guest replica). Group by tick once.
    const byTick = new Map<number, Record<string, { moveX: number; moveY: number; expanding: boolean }>>();
    for (const e of replay.inputs) {
      const set = byTick.get(e.t) ?? {};
      set[e.p] = { moveX: e.mx, moveY: e.my, expanding: e.e };
      byTick.set(e.t, set);
    }
    const driver = makeBouncyBlobsSimDriver(game);
    game.setStepDriver(() => {
      const world = game.getWorld();
      if (!world) return false;
      const set = byTick.get(world.tick + 1);
      if (set) driver.applyInputs(set);
      driver.stepOne();
      return true;
    });
    game.startRound();
  }, [replay]);

  useEffect(() => () => { gameRef.current?.destroy?.(); }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh', background: COLORS.bg }}>
      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 40, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button onClick={() => navigate('/replays')} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: COLORS.paper, color: COLORS.ink }}>◀ Replays</button>
        <span style={{ color: COLORS.green, fontWeight: 800 }}>▶ Replay</span>
      </div>
      {error && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: COLORS.paper }}>{error}</div>}
      {replay && !error && <GameCanvas key={replay.recordedAt} onInit={onCanvasInit} />}
    </div>
  );
}
