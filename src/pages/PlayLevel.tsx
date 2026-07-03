import React, { useRef, useCallback, useEffect, useState } from 'react';
import { COLORS, tape } from '../theme/uiTheme';
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createSoftBodyEngine } from '../physics/engineSelector';
import { SlimeBlob } from '../physics/slimeBlob';
import { Camera } from '../renderer/camera';
import { render, RenderOptions } from '../renderer/canvasRenderer';
import { drawGoalZone } from '../renderer/zoneRenderer';
import { GameLoop } from '../game/gameLoop';
import { KeyboardInput } from '../game/keyboardInput';
import { PlayerManager } from '../game/playerManager';
import { SpikeManager } from '../game/spikeManager';
import { computeMapAABB, FALL_KILL_MARGIN, lavaKillPlaneY } from '../game/mapBounds';
import { SpringPadManager } from '../game/springPadManager';
import { TriggerManager } from '../game/triggerManager';
import { ActionManager } from '../game/actionManager';
import { PlatformMover } from '../game/platformMover';
import { loadLevel, GetSpriteShape } from '../levels/levelLoader';
import { getSprite, preloadSprites } from '../assets/spriteRegistry';
import { preloadBackground } from '../renderer/backgroundRenderer';
import { loadBuiltinLevel } from '../levels/levelRegistry';
import { LevelData, ZoneDef } from '../levels/types';
import GameCanvas from '../components/GameCanvas';
import SettingsModal from '../components/SettingsModal';
import PauseMenu from '../components/PauseMenu';
import { EffectsBindings } from '../game/effectsBindings';
import { updateParticles, clearParticles } from '../renderer/particles';
import { clearDecals, setDecalResolvers } from '../renderer/decals';
import { preloadAll, SFX_NAMES, resumeAudio, playSfx } from '../utils/audio';
import { getPlayerColor, getPlayerFaceId, onAudioSettingsChange } from '../utils/audioSettings';
import { loadPlayCampaign } from '../lib/campaignRegistry';
import { getLevelProgress, recordCompletion, recordDeaths } from '../lib/playProgress';

interface RunnerState {
  world: SoftBodyEngine;
  camera: Camera;
  playerManager: PlayerManager;
  playerBlob: SlimeBlob;
  npcBlobs: SlimeBlob[];
  input: KeyboardInput;
  loop: GameLoop;
  ctx: CanvasRenderingContext2D;
  canvasWidth: number;
  canvasHeight: number;
  renderOptions: RenderOptions;
  spikeManager: SpikeManager | null;
  springPadManager: SpringPadManager | null;
  triggerManager: TriggerManager;
  actionManager: ActionManager;
  platformMover: PlatformMover;
  effects: EffectsBindings;
  unsubColor: () => void;
  goal: ZoneDef | null;
  // Run telemetry
  elapsedMs: number;
  runDeaths: number;
  finished: boolean;
  /** True while the pause menu is open — freezes the sim + run clock. */
  paused: boolean;
}

/** mm:ss.mmm */
function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${m}:${s.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

export default function PlayLevel() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const levelId = searchParams.get('level') ?? '';

  const [levelData, setLevelData] = useState<LevelData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bumped to force a clean remount of the engine (Replay).
  const [runKey, setRunKey] = useState(0);
  // Ordered campaign ids + display names, for the Next button + hub link.
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [levelName, setLevelName] = useState<string>('');
  // Set once when the player reaches the goal.
  const [complete, setComplete] = useState<{ timeMs: number; deaths: number; isBest: boolean } | null>(null);

  const stateRef = useRef<RunnerState | null>(null);

  const teardown = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    s.loop.stop();
    s.input.detach();
    s.spikeManager?.cleanup();
    s.springPadManager?.cleanup();
    s.actionManager.cleanup();
    s.triggerManager.cleanup();
    s.platformMover.cleanup();
    s.unsubColor();
    s.effects.reset();
    // Persist deaths even if the player quit mid-level without finishing.
    if (!s.finished) recordDeaths(levelId, s.runDeaths);
    clearParticles();
    clearDecals();
    stateRef.current = null;
  }, [levelId]);

  // Load the campaign once (for ordering + display names).
  useEffect(() => {
    loadPlayCampaign()
      .then((c) => {
        setOrderedIds(c.levels.map((l) => l.id));
        const entry = c.levels.find((l) => l.id === levelId);
        if (entry?.name) setLevelName(entry.name);
      })
      .catch(() => { /* hub link still works */ });
  }, [levelId]);

  // (Re)load the level whenever the selected id changes. Reset overlay state.
  useEffect(() => {
    if (!levelId) {
      navigate('/play', { replace: true });
      return;
    }
    setComplete(null);
    setLevelData(null);
    setLoadError(null);
    let cancelled = false;
    loadBuiltinLevel(levelId)
      .then((data) => {
        if (cancelled) return;
        if (!data.name) data.name = levelId;
        if (!levelName) setLevelName(data.name);
        setLevelData(data);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load level', levelId, err);
        setLoadError(String(err?.message ?? err));
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelId]);

  const onInit = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    if (!levelData) return;
    // Tear down any prior run (Replay / Next reuse this component).
    teardown();

    preloadAll(SFX_NAMES);
    resumeAudio();
    void preloadSprites();
    preloadBackground();

    const world = createSoftBodyEngine({ substeps: 4, gravityScale: 4.0 });

    const {
      playerSpawnPoints,
      npcBlobs,
      pointShapeParticles,
      triggerShapeIdxToId,
      softPlatforms,
      pointShapes,
      chains,
      softPlatformStaticParticles,
      platformSurfaces,
    } = loadLevel(
      world,
      levelData,
      ((id: string) => getSprite(id)?.def.shape ?? null) as GetSpriteShape,
    );

    const spawnPos = playerSpawnPoints[0] ?? { x: 0, y: 380 };

    const playerManager = new PlayerManager(playerSpawnPoints);
    const managed = playerManager.addPlayer('play-player', 'Player', world, 'circle16', getPlayerColor(), getPlayerFaceId());
    const playerBlob = managed.blob;
    const unsubColor = onAudioSettingsChange(() => {
      managed.color = getPlayerColor();
      managed.faceId = getPlayerFaceId();
    });
    world.teleportBlob(playerBlob.blobId, spawnPos);

    const mapBounds = computeMapAABB(
      world, levelData, platformSurfaces, softPlatforms, pointShapes, playerSpawnPoints,
    );

    // Hazards: spikes, death zones, fall-off-the-bottom — all respawn the blob
    // at spawn (deathMode 'instant'). We just tally deaths on top.
    let spikeManager: SpikeManager | null = null;
    const hasSpikes = (levelData.spikes?.length ?? 0) > 0;
    const hasDeathZones = (levelData.deathZones?.length ?? 0) > 0;
    if (hasSpikes || hasDeathZones || levelData.bounds) {
      spikeManager = new SpikeManager();
      spikeManager.initialize(world, playerManager, levelData.spikes ?? [], npcBlobs);
      spikeManager.deathMode = 'instant';
      if (hasDeathZones) spikeManager.setDeathZones(levelData.deathZones ?? []);
      // Kill anyone (players AND NPCs) who falls below the lowest map geometry (AABB).
      spikeManager.setKillBelowY(mapBounds.maxY + FALL_KILL_MARGIN);
    }

    // Physics crush events (Rust-detected): route a crushed blob through the
    // normal death/respawn flow instead of letting the solver eject it.
    const smForCrush = spikeManager;
    world.onBlobCrushed = (blobId) => { smForCrush?.killPlayerByBlobId(blobId); };

    let springPadManager: SpringPadManager | null = null;
    if (levelData.springPads && levelData.springPads.length > 0) {
      springPadManager = new SpringPadManager();
      springPadManager.initialize(world, levelData.springPads);
    }

    const effects = new EffectsBindings();
    if (spikeManager) {
      spikeManager.onKill = (killedPlayerId, deathPos) => {
        const p = playerManager.getPlayer(killedPlayerId);
        if (p) effects.onSpikeKill(p, deathPos);
        if (stateRef.current && !stateRef.current.finished) stateRef.current.runDeaths++;
      };
    }
    if (springPadManager) {
      springPadManager.onFire = (pos, dir) => effects.onSpringFire(pos, dir);
    }

    const platformMover = new PlatformMover();
    platformMover.initialize(levelData.platforms, platformSurfaces, world);

    setDecalResolvers({
      getPlatformLivePos: (id) => platformMover.getLivePosition(id),
      getPlatformLivePoly: (id) => platformMover.getLivePoly(id),
      getParticlePos: (idx) => world.pos[idx] ?? null,
      getSpringLivePos: (id) => springPadManager?.getSpringLivePosition(id) ?? null,
    });

    const triggerManager = new TriggerManager();
    const npcBlobIds = new Set(npcBlobs.map((b) => b.blobId));
    triggerManager.initialize(
      world,
      levelData.triggers ?? [],
      triggerShapeIdxToId,
      (blobId) => npcBlobIds.has(blobId),
      (blobId) => playerManager.getPlayerByBlobId(blobId) !== undefined,
    );

    const actionManager = new ActionManager();
    actionManager.initialize(
      world,
      levelData.actions ?? [],
      pointShapeParticles,
      softPlatformStaticParticles,
      platformMover,
      triggerManager,
      spikeManager,
    );

    const camera = new Camera();
    camera.snapTo(spawnPos, 0.7);

    const input = new KeyboardInput();
    input.attach();

    const renderOptions: RenderOptions = {
      showSprings: false,
      showShapeTargets: false,
      showPoints: false,
      showHull: false,
    };

    const goal = levelData.goalZones?.[0] ?? null;

    const state: RunnerState = {
      world, camera, playerManager, playerBlob, npcBlobs, input,
      loop: null as unknown as GameLoop,
      ctx, canvasWidth: width, canvasHeight: height, renderOptions,
      spikeManager, springPadManager, triggerManager, actionManager, platformMover,
      effects, unsubColor, goal,
      elapsedMs: 0, runDeaths: 0, finished: false, paused: false,
    };

    const insideGoal = (z: ZoneDef): boolean => {
      const c = playerBlob.getCentroid();
      return Math.abs(c.x - z.x) <= z.width / 2 && Math.abs(c.y - z.y) <= z.height / 2;
    };

    const loop = new GameLoop((dt) => {
      // While the pause menu is open we freeze the whole simulation (and the
      // run clock) but keep rendering the static frame beneath the overlay.
      if (!state.paused) {
        const moveX = input.getMoveX(1);
        const moveY = input.getMoveY(1);
        playerBlob.setInput(moveX, moveY, input.isExpanding(1));
        playerBlob.update(dt);

        // Ease the gaze toward the movement direction so the eyes look where the
        // blob is heading (mirrors playerManager.applyInputsAndStep in netplay).
        const mag = Math.hypot(moveX, moveY);
        const tx = mag > 0.01 ? moveX / mag : 0;
        const ty = mag > 0.01 ? moveY / mag : 0;
        const a = 1 - Math.exp(-12 * dt);
        managed.gazeX += (tx - managed.gazeX) * a;
        managed.gazeY += (ty - managed.gazeY) * a;

        world.step(dt);
        springPadManager?.update(dt);
        spikeManager?.update(dt);
        triggerManager.update(dt);
        actionManager.update(dt);
        effects.update(dt, playerManager, npcBlobs, world, [...softPlatforms, ...pointShapes], platformMover, undefined, springPadManager ?? undefined);
        updateParticles(dt);
        camera.followTargets([playerBlob.getCentroid()], state.canvasWidth, state.canvasHeight);
        camera.update(dt);

        // Run clock + goal check (only while the level is still in progress).
        if (!state.finished) {
          state.elapsedMs += dt * 1000;
          if (state.goal && insideGoal(state.goal)) {
            state.finished = true;
            const prevBest = getLevelProgress(levelId).bestTimeMs;
            const isBest = prevBest == null || state.elapsedMs < prevBest;
            recordCompletion(levelId, state.elapsedMs, state.runDeaths);
            playSfx('ui-modal-open', { volume: 0.6 });
            setComplete({ timeMs: state.elapsedMs, deaths: state.runDeaths, isBest });
          }
        }
      }

      const hasTriggers = (levelData.triggers?.length ?? 0) > 0;
      const modeOverlay = {
        renderWorld: (rctx: CanvasRenderingContext2D) => {
          springPadManager?.render(rctx);
          spikeManager?.render(rctx);
          spikeManager?.renderDeadPlayers(rctx);
          if (hasTriggers) triggerManager.render(rctx);
          if (state.goal) drawGoalZone(rctx, state.goal, state.elapsedMs / 1000);
        },
        renderHUD: (hctx: CanvasRenderingContext2D, w: number) => {
          drawRunHud(hctx, w, state.elapsedMs);
        },
      };

      const playerData = [{
        name: managed.name,
        color: managed.color,
        faceId: managed.faceId,
        expanding: playerBlob.isExpanding(),
        expandScale: playerBlob.getExpandScale(),
        gaze: { x: managed.gazeX, y: managed.gazeY },
      }];

      render(
        ctx, world, camera, [playerBlob], npcBlobs,
        state.canvasWidth, state.canvasHeight, renderOptions, modeOverlay,
        playerData, [...softPlatforms, ...pointShapes], chains,
        lavaKillPlaneY(levelData, mapBounds),
      );
    });

    state.loop = loop;
    stateRef.current = state;
    loop.start();
  }, [levelData, levelId, teardown]);

  const onResize = useCallback((width: number, height: number) => {
    if (stateRef.current) {
      stateRef.current.canvasWidth = width;
      stateRef.current.canvasHeight = height;
    }
  }, []);

  // Tear down on unmount.
  useEffect(() => () => teardown(), [teardown]);

  // The pause menu or the settings modal both freeze the sim + run clock.
  useEffect(() => {
    if (stateRef.current) stateRef.current.paused = pauseOpen || settingsOpen;
  }, [pauseOpen, settingsOpen]);

  // Escape: close settings back to the pause menu, otherwise toggle the pause menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (settingsOpen) {
        setSettingsOpen(false);
        setPauseOpen(true);
      } else {
        setPauseOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  const idx = orderedIds.indexOf(levelId);
  const nextId = idx >= 0 && idx + 1 < orderedIds.length ? orderedIds[idx + 1] : null;

  function handleReplay() {
    setComplete(null);
    setRunKey((k) => k + 1);
  }

  function handleNext() {
    if (nextId) navigate(`/play/level?level=${encodeURIComponent(nextId)}`);
  }

  if (loadError) {
    return (
      <div style={centerShell}>
        <div style={{ color: COLORS.titleInk, textAlign: 'center' }}>
          <p style={{ marginBottom: 16 }}>Couldn't load level "{levelId}".</p>
          <Link to="/play"><button style={overlayBtn}>← Back to levels</button></Link>
        </div>
      </div>
    );
  }

  if (!levelData) {
    return (
      <div style={centerShell}>
        <span style={{ color: '#888', fontSize: 14 }}>Loading level…</span>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#0f1629' }}>
      <GameCanvas key={`${levelId}:${runKey}`} onInit={onInit} onResize={onResize} />

      {/* Top-left controls */}
      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="bb-hover-btn" style={chipBtn} onClick={() => setPauseOpen(true)}>Pause</button>
      </div>

      {complete && (
        <div style={completeBackdrop}>
          <div style={completeCard}>
            <div style={completeTape} />
            <h2 style={completeHeading}>Level Complete!</h2>
            <div style={statRow}><span>Time</span><span style={statVal}>{formatTime(complete.timeMs)}</span></div>
            <div style={statRow}><span>Deaths</span><span style={statVal}>{complete.deaths}</span></div>
            {complete.isBest && <div style={bestBadge}>★ New best time!</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'center' }}>
              {nextId
                ? <button style={primaryBtn} onClick={handleNext}>Next →</button>
                : <Link to="/play"><button style={primaryBtn}>Finish ✓</button></Link>}
              <button style={secondaryBtn} onClick={handleReplay}>Replay</button>
              <Link to="/play"><button style={secondaryBtn}>Levels</button></Link>
            </div>
          </div>
        </div>
      )}

      <PauseMenu
        open={pauseOpen}
        onResume={() => setPauseOpen(false)}
        onSettings={() => { setPauseOpen(false); setSettingsOpen(true); }}
        onQuit={() => navigate('/play')}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); setPauseOpen(true); }}
      />
    </div>
  );
}

/** Cream "paper chip" run timer, centered at top of screen. */
function drawRunHud(ctx: CanvasRenderingContext2D, canvasWidth: number, elapsedMs: number): void {
  const timeStr = formatTime(elapsedMs);
  ctx.save();
  ctx.font = 'bold 22px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  const pad = 12;
  const chipH = 34;
  const top = 12;

  const timeW = ctx.measureText(timeStr).width + pad * 2;
  const x = Math.round((canvasWidth - timeW) / 2);
  ctx.fillStyle = COLORS.paper;
  ctx.strokeStyle = '#0a0612';
  ctx.lineWidth = 3;
  roundRect(ctx, x, top, timeW, chipH, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = COLORS.ink;
  ctx.fillText(timeStr, x + pad, top + chipH / 2 + 1);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const centerShell: React.CSSProperties = {
  width: '100%', height: '100%', display: 'flex',
  alignItems: 'center', justifyContent: 'center', background: '#0f1629',
};

const chipBtn: React.CSSProperties = {
  padding: '6px 12px', fontSize: 14, background: COLORS.paper, color: COLORS.ink,
  border: '3px solid #0a0612', borderRadius: 4, cursor: 'pointer', fontWeight: 700,
  transform: 'rotate(-2deg)',
};

const overlayBtn: React.CSSProperties = { ...chipBtn, padding: '10px 18px' };

const levelTitle: React.CSSProperties = {
  position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%) rotate(-1.5deg)',
  fontSize: 22, fontWeight: 900, color: COLORS.titleInk,
  textShadow: `2px 2px 0 ${COLORS.lavender}, -1px -1px 0 #0a0612, 1px 1px 0 #0a0612`,
  pointerEvents: 'none', userSelect: 'none',
};

const completeBackdrop: React.CSSProperties = {
  position: 'absolute', inset: 0, background: 'rgba(10, 6, 18, 0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
};

const completeCard: React.CSSProperties = {
  position: 'relative', background: COLORS.paper, color: COLORS.ink,
  border: '4px solid #0a0612', borderRadius: 6, padding: '30px 40px 24px',
  minWidth: 320, boxShadow: '0 12px 50px rgba(0,0,0,0.5)', textAlign: 'center',
};

const completeTape: React.CSSProperties = tape(COLORS.lavender);

const completeHeading: React.CSSProperties = {
  margin: '0 0 18px', fontSize: 26, fontWeight: 900,
  textShadow: `2px 2px 0 ${COLORS.lavender}`,
};

const statRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  gap: 24, margin: '8px 0', fontSize: 16, fontWeight: 700,
};

const statVal: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const bestBadge: React.CSSProperties = {
  marginTop: 12, fontSize: 15, fontWeight: 800, color: COLORS.purple,
};

const primaryBtn: React.CSSProperties = {
  padding: '12px 22px', background: COLORS.purple, color: COLORS.onAccent,
  border: '3px solid #0a0612', borderRadius: 4, fontSize: 15, fontWeight: 800,
  cursor: 'pointer', boxShadow: '0 4px 0 #0a0612',
};

const secondaryBtn: React.CSSProperties = {
  padding: '12px 18px', background: COLORS.paper, color: COLORS.ink,
  border: '3px solid #0a0612', borderRadius: 4, fontSize: 15, fontWeight: 700,
  cursor: 'pointer',
};
