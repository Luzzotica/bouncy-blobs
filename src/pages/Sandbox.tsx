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
import { loadLevel, GetSpriteShape } from '../levels/levelLoader';
import { getSprite, preloadSprites } from '../assets/spriteRegistry';
import { preloadBackground } from '../renderer/backgroundRenderer';
import { loadBuiltinLevel } from '../levels/levelRegistry';
import { LevelData } from '../levels/types';
import GameCanvas from '../components/GameCanvas';
import SettingsModal from '../components/SettingsModal';
import { ChainRenderInfo } from '../renderer/canvasRenderer';
import { EffectsBindings } from '../game/effectsBindings';
import { updateParticles, clearParticles } from '../renderer/particles';
import { clearDecals, setDecalResolvers } from '../renderer/decals';
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

    // Point shapes are closed soft-blob hulls — draw the polygon outline
    // from the live particle positions (legacy `ps.edges` is always empty).
    if (ids.length >= 2) {
      ctx.beginPath();
      const first = world.pos[ids[0]];
      if (first) {
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < ids.length; i++) {
          const p = world.pos[ids[i]];
          if (p) ctx.lineTo(p.x, p.y);
        }
        if (ids.length > 2) ctx.closePath();
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
  const [showTargets, setShowTargets] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playersChained, setPlayersChained] = useState(false);
  const stateRef = useRef<{
    world: SoftBodyEngine;
    camera: Camera;
    playerManager: PlayerManager;
    playerBlob: SlimeBlob;
    playerBlob2: SlimeBlob | null;
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
    playerChain: ChainRenderInfo | null;
    createPlayerChain: () => boolean;
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
    setPlayersChained(false);

    preloadAll(SFX_NAMES);
    resumeAudio();
    void preloadSprites();
    preloadBackground();

    const world = createSoftBodyEngine({
      // Mirror bouncyBlobsGame: 4 substeps. See the bouncyBlobsGame comment
      // for the rationale (prev_poly kinematic CCD + 3× iterated discrete
      // pass make 8 substeps unnecessary and burned the frame budget).
      substeps: 4,
      gravityScale: 4.0,
    });

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

    // Second local player (editor playtest only) so chained triggers/actions
    // that need two blobs can be exercised. Arrow keys + Shift.
    let managed2: ReturnType<PlayerManager['addPlayer']> | null = null;
    let playerBlob2: SlimeBlob | null = null;
    if (fromEditor) {
      managed2 = playerManager.addPlayer('sandbox-player-2', 'Player 2', world, 'circle16', '#ff9c5b');
      playerBlob2 = managed2.blob;
      const spawn2 = playerSpawnPoints[1] ?? { x: spawnPos.x + 80, y: spawnPos.y };
      world.teleportBlob(playerBlob2.blobId, spawn2);
    }

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

    // Wire the splat decal renderer's anchor resolvers so splats on moving
    // platforms follow them, and splats on soft bodies follow the hull
    // particles they're attached to. Called once per Sandbox init; the
    // module-level registry is reset whenever a new level loads.
    setDecalResolvers({
      getPlatformLivePos: (id) => platformMover.getLivePosition(id),
      getPlatformLivePoly: (id) => platformMover.getLivePoly(id),
      getParticlePos: (idx) => world.pos[idx] ?? null,
    });

    // Trigger areas detect blobs and expose isPressed() to actions.
    const triggerManager = new TriggerManager();
    const npcBlobIds = new Set(npcBlobs.map(b => b.blobId));
    triggerManager.initialize(
      world,
      levelData.triggers ?? [],
      triggerShapeIdxToId,
      (blobId) => npcBlobIds.has(blobId),
    );

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

    // Tuned to match the working rope-test demo (src/physics/rope-test.html
     // scene 4 "two blobs over peg"): dense short segments + high iteration
     // count make the rope feel taut and predictable.
     //
     // Endpoint = a hull particle, NOT the center. The center is a virtual
     // control point: each substep `pin_blob_centers_to_hull_centroid`
     // overwrites pos[centerIdx], discarding any correction the chain
     // solver applied (see crates/softbody/src/world.rs step 13). Attaching
     // to a real hull particle means the chain actually yanks the blob.
    const PLAYER_CHAIN_TOTAL_LENGTH = 700;
    const createPlayerChain = (): boolean => {
      if (!playerBlob2 || state.playerChain) return false;
      // Pick the hull particle on each blob closest to the other blob, so
      // the rope attaches on the "facing" side instead of yanking from a
      // random vertex.
      const pickFacingHullIdx = (a: SlimeBlob, b: SlimeBlob): number => {
        const target = world.pos[b.centerIdx] ?? a.getCentroid();
        let best = a.hullIndices[0];
        let bestD = Infinity;
        for (const idx of a.hullIndices) {
          const p = world.pos[idx];
          if (!p) continue;
          const dx = p.x - target.x;
          const dy = p.y - target.y;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = idx; }
        }
        return best;
      };
      const aIdx = pickFacingHullIdx(playerBlob, playerBlob2);
      const bIdx = pickFacingHullIdx(playerBlob2, playerBlob);
      // Match the rope-test demo (src/physics/rope-test.html scene 4) —
      // `segmentMass: 0.5` is what makes PBD pair-corrections actually
      // propagate from end to end, so when the rope wraps around a wall
      // the geodesic length is what limits the players. A featherweight
      // chain (mass≪hull) collapses corrections onto the segment side
      // and the rope effectively never goes taut.
      const rope = world.addRopeChain(aIdx, bIdx, {
        totalLength: PLAYER_CHAIN_TOTAL_LENGTH,
        maxSegmentLength: 12,
        segmentMass: 0.5,
        segmentRadius: 6,
        iterations: 16,
      });
      state.playerChain = {
        particleIndices: [aIdx, ...rope.particleIndices, bIdx],
        totalLength: PLAYER_CHAIN_TOTAL_LENGTH,
      };
      return true;
    };

    const state = {
      world,
      camera,
      playerManager,
      playerBlob,
      playerBlob2,
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
      playerChain: null as ChainRenderInfo | null,
      createPlayerChain,
    };

    const loop = new GameLoop((dt) => {
      playerBlob.setInput(input.getMoveX(1), input.getMoveY(1), input.isExpanding(1));
      playerBlob.update(dt);
      if (playerBlob2) {
        playerBlob2.setInput(input.getMoveX(2), input.getMoveY(2), input.isExpanding(2));
        playerBlob2.update(dt);
      }
      world.step(dt);
      springPadManager?.update(dt);
      spikeManager?.update(dt);
      // Trigger areas first: they flip `pressed` flags based on occupancy.
      triggerManager.update(dt);
      // Then actions poll the trigger states and tween their targets.
      actionManager.update(dt);
      effects.update(dt, playerManager, npcBlobs, world, [...softPlatforms, ...pointShapes], platformMover);
      updateParticles(dt);
      const followTargets = playerBlob2
        ? [playerBlob.getCentroid(), playerBlob2.getCentroid()]
        : [playerBlob.getCentroid()];
      camera.followTargets(followTargets, state.canvasWidth, state.canvasHeight);
      camera.update(dt);

      const hasPointShapes = pointShapeParticles.size > 0;
      const hasTriggers = (levelData.triggers?.length ?? 0) > 0;
      const modeOverlay = (spikeManager || springPadManager || hasTriggers || hasPointShapes || state.playerChain) ? {
        renderWorld: (rctx: CanvasRenderingContext2D) => {
          springPadManager?.render(rctx);
          spikeManager?.render(rctx);
          spikeManager?.renderDeadPlayers(rctx);
          triggerManager.render(rctx);
          // Per-particle debug dots + outline for point-shape soft blobs.
          // Only show when the "Points" toggle is on — otherwise pinned
          // shapes leak debug visuals into normal play.
          if (renderOptions.showPoints) {
            renderPointShapesLive(rctx, world, pointShapeParticles, levelData);
          }
        },
        renderHUD: () => {},
      } : undefined;

      const playerData = [{
        name: managed.name,
        color: managed.color,
        faceId: managed.faceId,
        expanding: playerBlob.isExpanding(),
        expandScale: playerBlob.getExpandScale(),
        gaze: { x: managed.gazeX, y: managed.gazeY },
      }];
      const playerBlobs = [playerBlob];
      if (playerBlob2 && managed2) {
        playerBlobs.push(playerBlob2);
        playerData.push({
          name: managed2.name,
          color: managed2.color,
          faceId: managed2.faceId,
          expanding: playerBlob2.isExpanding(),
          expandScale: playerBlob2.getExpandScale(),
          gaze: { x: managed2.gazeX, y: managed2.gazeY },
        });
      }
      const allChains = state.playerChain ? [...chains, state.playerChain] : chains;
      render(ctx, world, camera, playerBlobs, npcBlobs, state.canvasWidth, state.canvasHeight, renderOptions, modeOverlay, playerData, [...softPlatforms, ...pointShapes], allChains);

      // Chain particle dots — drawn last so they sit on top of the rope
      // and any static geometry the rope is wrapping. `render()`'s
      // modeOverlay.renderWorld runs before static polygons, so dots
      // drawn there get covered up; this pass mirrors render()'s camera
      // transform and overlays the dots.
      if (renderOptions.showPoints && state.playerChain) {
        ctx.save();
        ctx.translate(state.canvasWidth / 2 - camera.position.x * camera.zoom, state.canvasHeight / 2 - camera.position.y * camera.zoom);
        ctx.scale(camera.zoom, camera.zoom);
        ctx.fillStyle = '#ffcc55';
        ctx.strokeStyle = '#0f1629';
        ctx.lineWidth = 1.5;
        for (const idx of state.playerChain.particleIndices) {
          const p = world.pos[idx];
          if (!p) continue;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
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
  useEffect(() => {
    if (stateRef.current) {
      stateRef.current.renderOptions.showShapeTargets = showTargets;
    }
  }, [showTargets]);

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
            background: showTargets ? '#3b6ab8' : '#1f2a3f',
            color: '#fff',
            border: '1px solid #4f5874',
            cursor: 'pointer',
          }}
          onClick={() => setShowTargets(p => !p)}
          title="Draw the shape-match rest hull (dashed cyan), the frame centroid (magenta cross), and the center particle (yellow dot) for every blob"
        >
          Targets: {showTargets ? 'ON' : 'OFF'}
        </button>
        {fromEditor && (
          <button
            style={{
              padding: '6px 12px',
              fontSize: 14,
              background: playersChained ? '#3b6ab8' : '#1f2a3f',
              color: '#fff',
              border: '1px solid #4f5874',
              cursor: playersChained ? 'default' : 'pointer',
              opacity: playersChained ? 0.7 : 1,
            }}
            disabled={playersChained}
            onClick={() => {
              if (stateRef.current?.createPlayerChain()) {
                setPlayersChained(true);
              }
            }}
            title="Tether P1 and P2 with a rope. Re-launch playtest to remove."
          >
            {playersChained ? 'Chained' : 'Chain Players'}
          </button>
        )}
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
          {fromEditor
            ? 'P1: WASD + Space | P2: Arrows + Shift'
            : 'WASD: Move | Space: Expand'}
        </span>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
