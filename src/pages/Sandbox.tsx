import React, { useRef, useCallback, useEffect, useState } from 'react';
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import { Link, useSearchParams } from 'react-router-dom';
import { createSoftBodyEngine } from '../physics/engineSelector';
import { SlimeBlob } from '../physics/slimeBlob';
import { Camera } from '../renderer/camera';
import { render, RenderOptions } from '../renderer/canvasRenderer';
import { GameLoop } from '../game/gameLoop';
import { KeyboardInput } from '../game/keyboardInput';
import { PlayerManager } from '../game/playerManager';
import { SpikeManager } from '../game/spikeManager';
import { SpringPadManager } from '../game/springPadManager';
import { TriggerManager } from '../game/triggerManager';
import { ActionManager } from '../game/actionManager';
import { PlatformMover } from '../game/platformMover';
import { loadLevel } from '../levels/levelLoader';
import { loadBuiltinLevel } from '../levels/levelRegistry';
import { LevelData } from '../levels/types';
import GameCanvas from '../components/GameCanvas';
import SettingsModal from '../components/SettingsModal';
import { EffectsBindings } from '../game/effectsBindings';
import { updateParticles, clearParticles } from '../renderer/particles';
import { clearDecals } from '../renderer/decals';
import { preloadAll, SFX_NAMES, resumeAudio } from '../utils/audio';
import { getPlayerColor, onAudioSettingsChange } from '../utils/audioSettings';

function renderPointShapesLive(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyEngine,
  particles: Map<string, number[]>,
  level: LevelData,
): void {
  if (!level.pointShapes) return;
  for (const ps of level.pointShapes) {
    const ids = particles.get(ps.id);
    if (!ids) continue;

    ctx.save();
    ctx.strokeStyle = '#88c0ff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const e of ps.edges) {
      const pa = world.pos[ids[e.a]];
      const pb = world.pos[ids[e.b]];
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    if (ps.closed && ps.points.length > 2) {
      const pa = world.pos[ids[ids.length - 1]];
      const pb = world.pos[ids[0]];
      if (pa && pb) {
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
    }

    for (let i = 0; i < ids.length; i++) {
      const p = world.pos[ids[i]];
      if (!p) continue;
      const anchored = ps.points[i].anchored;
      ctx.fillStyle = anchored ? '#ffcc55' : '#88c0ff';
      ctx.strokeStyle = '#0f1629';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, anchored ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

export default function Sandbox() {
  const [searchParams] = useSearchParams();
  const fromEditor = searchParams.get('from') === 'editor';
  const [levelData, setLevelData] = useState<LevelData | null>(null);
  const [showPoints, setShowPoints] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const stateRef = useRef<{
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
  } | null>(null);

  // Load level data (test level from editor or default)
  useEffect(() => {
    if (searchParams.get('testLevel')) {
      const testJson = sessionStorage.getItem('testLevel');
      if (testJson) {
        try {
          setLevelData(JSON.parse(testJson) as LevelData);
          return;
        } catch { /* fall through to default */ }
      }
    }
    loadBuiltinLevel('playground').then(setLevelData).catch(err => {
      console.error('Failed to load playground level:', err);
    });
  }, [searchParams]);

  const onInit = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    if (!levelData) return;

    preloadAll(SFX_NAMES);
    resumeAudio();

    const world = createSoftBodyEngine({
      substeps: 4,
      gravityScale: 4.0,
    });

    const {
      playerSpawnPoints,
      npcBlobs,
      pointShapeParticles,
      triggerShapeIdxToId,
      softPlatforms,
      softPlatformStaticParticles,
      platformSurfaces,
    } = loadLevel(world, levelData);

    const spawnPos = playerSpawnPoints[0] ?? { x: 0, y: 380 };

    // Use PlayerManager so SpikeManager can handle kills/respawns
    const playerManager = new PlayerManager(playerSpawnPoints);
    const managed = playerManager.addPlayer('sandbox-player', 'Player', world, 'circle16', getPlayerColor());
    const playerBlob = managed.blob;
    // Live-update the blob's colour when the user changes it in Settings.
    const unsubColor = onAudioSettingsChange(() => {
      managed.color = getPlayerColor();
    });
    // Teleport to first spawn since PlayerManager picks its own spawn order
    world.teleportBlob(playerBlob.blobId, spawnPos);

    // Initialize spike and spring pad managers if the level has them
    let spikeManager: SpikeManager | null = null;
    const hasSpikes = (levelData.spikes?.length ?? 0) > 0;
    const hasDeathZones = (levelData.deathZones?.length ?? 0) > 0;
    if (hasSpikes || hasDeathZones || levelData.bounds) {
      spikeManager = new SpikeManager();
      spikeManager.initialize(world, playerManager, levelData.spikes ?? []);
      spikeManager.deathMode = 'instant';
      if (hasDeathZones) spikeManager.setDeathZones(levelData.deathZones ?? []);
      if (levelData.bounds) spikeManager.setKillBelowY(levelData.bounds.height + 500);
    }

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
      };
    }
    if (springPadManager) {
      springPadManager.onFire = (pos, dir) => effects.onSpringFire(pos, dir);
    }

    // PlatformMover owns the platform static surfaces; ActionManager talks to it.
    const platformMover = new PlatformMover();
    platformMover.initialize(levelData.platforms, platformSurfaces, world);

    // Trigger areas detect blobs and expose isPressed() to actions.
    const triggerManager = new TriggerManager();
    triggerManager.initialize(world, levelData.triggers ?? [], triggerShapeIdxToId);

    // Actions poll the triggers and animate their targets each frame.
    const actionManager = new ActionManager();
    actionManager.initialize(
      world,
      levelData.actions ?? [],
      pointShapeParticles,
      softPlatformStaticParticles,
      platformMover,
      triggerManager,
    );

    const camera = new Camera();
    camera.snapTo(spawnPos, 0.7);

    const input = new KeyboardInput();
    input.attach();

    const renderOptions: RenderOptions = {
      showSprings: false,
      showShapeTargets: false,
      showPoints,
    };

    const state = {
      world,
      camera,
      playerManager,
      playerBlob,
      npcBlobs,
      input,
      loop: null as unknown as GameLoop,
      ctx,
      canvasWidth: width,
      canvasHeight: height,
      renderOptions,
      spikeManager,
      springPadManager,
      triggerManager,
      actionManager,
      platformMover,
      effects,
      unsubColor,
    };

    const loop = new GameLoop((dt) => {
      playerBlob.setInput(input.getMoveX(), input.getMoveY(), input.isExpanding());
      playerBlob.update(dt);
      world.step(dt);
      springPadManager?.update(dt);
      spikeManager?.update(dt);
      // Trigger areas first: they flip `pressed` flags based on occupancy.
      triggerManager.update(dt);
      // Then actions poll the trigger states and tween their targets.
      actionManager.update(dt);
      effects.update(dt, playerManager);
      updateParticles(dt);
      camera.followTargets([playerBlob.getCentroid()], state.canvasWidth, state.canvasHeight);
      camera.update(dt);

      const hasPointShapes = pointShapeParticles.size > 0;
      const hasTriggers = (levelData.triggers?.length ?? 0) > 0;
      const modeOverlay = (spikeManager || springPadManager || hasTriggers || hasPointShapes) ? {
        renderWorld: (rctx: CanvasRenderingContext2D) => {
          springPadManager?.render(rctx);
          spikeManager?.render(rctx);
          spikeManager?.renderDeadPlayers(rctx);
          triggerManager.render(rctx);
          renderPointShapesLive(rctx, world, pointShapeParticles, levelData);
        },
        renderHUD: () => {},
      } : undefined;

      const playerData = [{
        color: managed.color,
        faceId: managed.faceId,
        expanding: playerBlob.isExpanding(),
        expandScale: playerBlob.getExpandScale(),
        gaze: { x: managed.gazeX, y: managed.gazeY },
      }];
      render(ctx, world, camera, [playerBlob], npcBlobs, state.canvasWidth, state.canvasHeight, renderOptions, modeOverlay, playerData, softPlatforms);
    });

    state.loop = loop;
    stateRef.current = state;
    loop.start();
  }, [levelData]);

  const onResize = useCallback((width: number, height: number) => {
    if (stateRef.current) {
      stateRef.current.canvasWidth = width;
      stateRef.current.canvasHeight = height;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (stateRef.current) {
        stateRef.current.loop.stop();
        stateRef.current.input.detach();
        stateRef.current.spikeManager?.cleanup();
        stateRef.current.springPadManager?.cleanup();
        stateRef.current.actionManager.cleanup();
        stateRef.current.triggerManager.cleanup();
        stateRef.current.platformMover.cleanup();
        stateRef.current.unsubColor();
        stateRef.current.effects.reset();
        clearParticles();
        clearDecals();
        stateRef.current = null;
      }
    };
  }, []);

  // Live-sync renderOptions when the user toggles debug points
  useEffect(() => {
    if (stateRef.current) {
      stateRef.current.renderOptions.showPoints = showPoints;
    }
  }, [showPoints]);

  if (!levelData) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f1629' }}>
        <span style={{ color: '#888', fontSize: 14 }}>Loading level...</span>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <GameCanvas key={levelData.name} onInit={onInit} onResize={onResize} />
      <div style={{
        position: 'absolute',
        top: 12,
        left: 12,
        display: 'flex',
        gap: 8,
        alignItems: 'center',
      }}>
        {fromEditor ? (
          <Link to="/editor?restore=1">
            <button style={{ padding: '6px 12px', fontSize: 14 }}>← Back to Editor</button>
          </Link>
        ) : (
          <Link to="/">
            <button style={{ padding: '6px 12px', fontSize: 14 }}>Home</button>
          </Link>
        )}
        <button
          style={{
            padding: '6px 12px',
            fontSize: 14,
            background: showPoints ? '#3b6ab8' : '#1f2a3f',
            color: '#fff',
            border: '1px solid #4f5874',
            cursor: 'pointer',
          }}
          onClick={() => setShowPoints(p => !p)}
        >
          Points: {showPoints ? 'ON' : 'OFF'}
        </button>
        <button
          style={{
            padding: '6px 12px',
            fontSize: 14,
            background: '#1f2a3f',
            color: '#fff',
            border: '1px solid #4f5874',
            cursor: 'pointer',
          }}
          onClick={() => setSettingsOpen(true)}
        >
          ⚙ Settings
        </button>
        <span style={{ color: '#888', fontSize: 13 }}>
          A/D: Move | Space: Expand
        </span>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
