import React, { useRef, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SoftBodyWorld } from '../physics/softBodyWorld';
import { SlimeBlob } from '../physics/slimeBlob';
import { Camera } from '../renderer/camera';
import { render, RenderOptions } from '../renderer/canvasRenderer';
import { GameLoop } from '../game/gameLoop';
import { KeyboardInput } from '../game/keyboardInput';
import { PlayerManager } from '../game/playerManager';
import { SpikeManager } from '../game/spikeManager';
import { SpringPadManager } from '../game/springPadManager';
import { loadLevel } from '../levels/levelLoader';
import { loadBuiltinLevel } from '../levels/levelRegistry';
import { LevelData } from '../levels/types';
import GameCanvas from '../components/GameCanvas';

export default function Sandbox() {
  const [searchParams] = useSearchParams();
  const [levelData, setLevelData] = useState<LevelData | null>(null);
  const stateRef = useRef<{
    world: SoftBodyWorld;
    camera: Camera;
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
    loadBuiltinLevel('default').then(setLevelData).catch(err => {
      console.error('Failed to load default level:', err);
    });
  }, [searchParams]);

  const onInit = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    if (!levelData) return;

    const world = new SoftBodyWorld({
      substeps: 4,
      gravityScale: 4.0,
    });

    const { playerSpawnPoints, npcBlobs } = loadLevel(world, levelData);

    const spawnPos = playerSpawnPoints[0] ?? { x: 0, y: 380 };

    // Use PlayerManager so SpikeManager can handle kills/respawns
    const playerManager = new PlayerManager(playerSpawnPoints);
    const managed = playerManager.addPlayer('sandbox-player', 'Player', world, 'circle16');
    const playerBlob = managed.blob;
    // Teleport to first spawn since PlayerManager picks its own spawn order
    world.teleportBlob(playerBlob.blobId, spawnPos);

    // Initialize spike and spring pad managers if the level has them
    let spikeManager: SpikeManager | null = null;
    if (levelData.spikes && levelData.spikes.length > 0) {
      spikeManager = new SpikeManager();
      spikeManager.initialize(world, playerManager, levelData.spikes);
      spikeManager.deathMode = 'instant';
    }

    let springPadManager: SpringPadManager | null = null;
    if (levelData.springPads && levelData.springPads.length > 0) {
      springPadManager = new SpringPadManager();
      springPadManager.initialize(world, levelData.springPads);
    }

    const camera = new Camera();
    camera.snapTo(spawnPos, 0.7);

    const input = new KeyboardInput();
    input.attach();

    const renderOptions: RenderOptions = {
      showSprings: false,
      showShapeTargets: false,
    };

    const state = {
      world,
      camera,
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
    };

    const loop = new GameLoop((dt) => {
      playerBlob.setInput(input.getMoveX(), input.isExpanding());
      playerBlob.update(dt);
      world.step(dt);
      springPadManager?.update(dt);
      spikeManager?.update(dt);
      camera.followTargets([playerBlob.getCentroid()], state.canvasWidth, state.canvasHeight);
      camera.update(dt);

      const modeOverlay = (spikeManager || springPadManager) ? {
        renderWorld: (rctx: CanvasRenderingContext2D) => {
          springPadManager?.render(rctx);
          spikeManager?.render(rctx);
          spikeManager?.renderDeadPlayers(rctx);
        },
        renderHUD: () => {},
      } : undefined;

      render(ctx, world, camera, [playerBlob], npcBlobs, state.canvasWidth, state.canvasHeight, renderOptions, modeOverlay);
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
        stateRef.current = null;
      }
    };
  }, []);

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
        <Link to="/">
          <button style={{ padding: '6px 12px', fontSize: 14 }}>Home</button>
        </Link>
        <span style={{ color: '#888', fontSize: 13 }}>
          A/D: Move | Space: Expand
        </span>
      </div>
    </div>
  );
}
