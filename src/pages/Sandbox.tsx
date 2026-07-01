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
import { computeMapAABB, STATIC_MAP_FIT_ZOOM, readStaticCamOverride, FALL_KILL_MARGIN, lavaKillPlaneY } from '../game/mapBounds';
import { updateParticles, clearParticles } from '../renderer/particles';
import { clearDecals, setDecalResolvers } from '../renderer/decals';
import { preloadAll, SFX_NAMES, resumeAudio } from '../utils/audio';
import { getPlayerColor, onAudioSettingsChange } from '../utils/audioSettings';
import { COLORS, paperBtnSm, actionBtnSm } from '../theme/uiTheme';

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

/** Shoelace area of a closed polygon (absolute value, px²). */
function polygonArea(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export default function Sandbox() {
  const [searchParams] = useSearchParams();
  const fromEditor = searchParams.get('from') === 'editor';
  const [levelData, setLevelData] = useState<LevelData | null>(null);
  const [showPoints, setShowPoints] = useState(true);
  const [showTargets, setShowTargets] = useState(false);
  const [showHull, setShowHull] = useState(false);
  const [showArea, setShowArea] = useState(true);
  const showAreaRef = useRef(true);
  showAreaRef.current = showArea;
  // Cached unexpanded rest area per blob (captured the first time we see it, at
  // spawn — undeformed, scale 1). Current area / this = the % the crush reads.
  const baseAreasRef = useRef(new Map<number, number>());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playersChained, setPlayersChained] = useState(false);
  // Slow-motion / pause / single-step debug controls. The loop reads
  // `timeControlRef` every tick; the React state mirrors it for the UI.
  const [timeScale, setTimeScale] = useState(1);
  const [paused, setPaused] = useState(false);
  const timeControlRef = useRef({ divisor: 1, paused: false, stepRequested: false, stepBackRequested: false, slowTick: 0 });
  // Ring buffer of per-sim-tick world snapshots (serializeState bytes) so we can
  // step BACKWARD. `cursor` is the currently-displayed frame within the buffer.
  const historyRef = useRef<{ buffer: Uint8Array[]; cursor: number }>({ buffer: [], cursor: -1 });
  const setSpeed = useCallback((scale: number) => {
    timeControlRef.current.divisor = Math.max(1, Math.round(1 / scale));
    timeControlRef.current.slowTick = 0;
    setTimeScale(scale);
  }, []);
  const togglePause = useCallback(() => {
    setPaused(p => { const next = !p; timeControlRef.current.paused = next; return next; });
  }, []);
  const stepOnce = useCallback(() => { timeControlRef.current.stepRequested = true; }, []);
  const stepBack = useCallback(() => { timeControlRef.current.stepBackRequested = true; }, []);
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

    const mapBounds = computeMapAABB(
      world, levelData, platformSurfaces, softPlatforms, pointShapes, playerSpawnPoints,
    );

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
      getSpringLivePos: (id) => springPadManager?.getSpringLivePosition(id) ?? null,
    });

    // Trigger areas detect blobs and expose isPressed() to actions.
    const triggerManager = new TriggerManager();
    const npcBlobIds = new Set(npcBlobs.map(b => b.blobId));
    triggerManager.initialize(
      world,
      levelData.triggers ?? [],
      triggerShapeIdxToId,
      (blobId) => npcBlobIds.has(blobId),
      (blobId) => playerManager.getPlayerByBlobId(blobId) !== undefined,
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
      spikeManager,
    );

    // Same map-AABB framing as a real match: open on the whole arena, then the
    // follow code below eases onto the players. Small maps stay static (KOTH).
    const staticCamOverride = readStaticCamOverride();
    const camera = new Camera();
    camera.snapToBounds(mapBounds.minX, mapBounds.minY, mapBounds.maxX, mapBounds.maxY, width, height);

    const input = new KeyboardInput();
    input.attach();

    const renderOptions: RenderOptions = {
      showSprings: false,
      showShapeTargets: false,
      showPoints,
      showHull,
    };

    // Phase 1 leash: a unilateral distance constraint between the two blobs,
    // applied in the Rust engine (`addBlobTether`). No rope particles, no
    // weight — while the blobs are within PLAYER_CHAIN_TOTAL_LENGTH it does
    // nothing at all; past it, an elastic pull is spread evenly across every
    // hull particle of both blobs, so each is translated as a whole toward the
    // other (no single-point yank, never drags you to the ground). The visual
    // is just a line between the two centroids that reddens as it goes taut.
    // (A real geometry-wrapping rope is a separate, later effort.)
    const PLAYER_CHAIN_TOTAL_LENGTH = 700;
    const TETHER_STIFFNESS = 4;   // pull per world-unit past the slack budget
    const TETHER_MAX_FORCE = 560; // peak pull, in MOVE_FORCE (≈240) units
    const createPlayerChain = (): boolean => {
      if (!playerBlob2 || state.playerChain) return false;
      world.addBlobTether(
        playerBlob.blobId, playerBlob2.blobId,
        PLAYER_CHAIN_TOTAL_LENGTH, TETHER_STIFFNESS, TETHER_MAX_FORCE,
      );
      // Two endpoints for the rendered line: each blob's centre particle.
      state.playerChain = {
        particleIndices: [playerBlob.centerIdx, playerBlob2.centerIdx],
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
      // Time control + history scrubbing. A per-sim-tick snapshot ring buffer
      // lets us step BACKWARD; `cursor` is the currently-displayed frame within
      // it. Camera + render below always run so the (paused / slow / scrubbed)
      // state stays live on screen.
      const tc = timeControlRef.current;
      const hist = historyRef.current;
      const MAX_HISTORY = 600; // ~10s of sim time

      if (tc.stepBackRequested) {
        // Rewind one recorded frame — restoreState rewinds blobs AND platforms.
        tc.stepBackRequested = false;
        if (hist.cursor > 0) {
          hist.cursor--;
          world.restoreState(hist.buffer[hist.cursor]);
          clearParticles(); // transient dust isn't snapshotted; drop it on rewind
        }
      } else {
        // Should we advance one frame this tick? (paused → only on a step
        // request; slow-mo → every Nth tick; otherwise every tick.)
        let advance: boolean;
        if (tc.paused) {
          advance = tc.stepRequested;
          tc.stepRequested = false;
        } else if (tc.divisor > 1) {
          tc.slowTick = (tc.slowTick + 1) % tc.divisor;
          advance = tc.slowTick === 0;
        } else {
          advance = true;
        }

        if (advance) {
          if (hist.cursor < hist.buffer.length - 1) {
            // Scrubbed back: replay the next recorded frame (display only — no
            // managers, no step — so the managers stay in sync at the live edge).
            hist.cursor++;
            world.restoreState(hist.buffer[hist.cursor]);
            clearParticles();
          } else {
            // Live edge: simulate a fresh tick, then record it.
            playerBlob.setInput(input.getMoveX(1), input.getMoveY(1), input.isExpanding(1));
            playerBlob.update(dt);
            if (playerBlob2) {
              playerBlob2.setInput(input.getMoveX(2), input.getMoveY(2), input.isExpanding(2));
              playerBlob2.update(dt);
            }
            // Move kinematic platforms BEFORE stepping the physics, so collisions
            // resolve against where the platform actually is this tick. Previously
            // actions ran AFTER world.step, so a descending crusher slid into the
            // just-resolved hull and left the blob embedded a frame — and never
            // got fully crushed. Triggers flip `pressed` from (last tick's)
            // occupancy; actions poll them and tween the platform's live pose +
            // surface velocity, which world.step's collisions then read.
            triggerManager.update(dt);
            actionManager.update(dt);
            world.step(dt);
            springPadManager?.update(dt);
            spikeManager?.update(dt);
            effects.update(dt, playerManager, npcBlobs, world, [...softPlatforms, ...pointShapes], platformMover, undefined, springPadManager ?? undefined);
            updateParticles(dt);

            hist.buffer.push(world.serializeState());
            if (hist.buffer.length > MAX_HISTORY) hist.buffer.shift();
            hist.cursor = hist.buffer.length - 1;
          }
        }
      }
      const { minX, minY, maxX, maxY } = mapBounds;
      const canW = state.canvasWidth, canH = state.canvasHeight;
      const watchWholeMap = canW > 0 && (
        staticCamOverride !== null
          ? staticCamOverride
          : Camera.boundsFitZoom(minX, minY, maxX, maxY, canW, canH) >= STATIC_MAP_FIT_ZOOM
      );
      if (watchWholeMap) {
        camera.watchBounds(minX, minY, maxX, maxY, canW, canH);
      } else {
        const followTargets = playerBlob2
          ? [playerBlob.getCentroid(), playerBlob2.getCentroid()]
          : [playerBlob.getCentroid()];
        camera.followTargets(followTargets, canW, canH);
      }
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
      render(ctx, world, camera, playerBlobs, npcBlobs, state.canvasWidth, state.canvasHeight, renderOptions, modeOverlay, playerData, [...softPlatforms, ...pointShapes], allChains, lavaKillPlaneY(levelData, mapBounds));

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

      // Per-blob hull-area % overlay — the live "underlying data" the crush
      // detector reads (current hull area / unexpanded rest area). Red once it
      // dips under the crush threshold so you can see exactly when it should die.
      if (showAreaRef.current) {
        const baseAreas = baseAreasRef.current;
        const crushPct = 20; // mirrors INTEGRITY_CRUSH_AREA_RATIO (0.2)
        ctx.save();
        ctx.font = 'bold 13px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        const toScreenX = (wx: number) => state.canvasWidth / 2 + (wx - camera.position.x) * camera.zoom;
        const toScreenY = (wy: number) => state.canvasHeight / 2 + (wy - camera.position.y) * camera.zoom;
        for (const blob of [...playerBlobs, ...npcBlobs]) {
          const hull = blob.getHullPolygon();
          const area = polygonArea(hull);
          let base = baseAreas.get(blob.blobId);
          if (base === undefined || base <= 0) { base = area; baseAreas.set(blob.blobId, area); }
          const pct = base > 0 ? (area / base) * 100 : 100;
          const c = blob.getCentroid();

          // Per-hull-point contact, ordered to match getHullPolygon(). Two
          // bitmaps: ANY contact (static or another blob) and STATIC-only (the
          // kind the crush/sandwich check counts). Dot color:
          //   red    = touching STATIC geometry
          //   orange = touching only another blob/softbody
          //   faint  = free
          const contacts = world.getBlobParticleContacts(blob.blobId);
          const staticContacts = world.getBlobParticleStaticContacts(blob.blobId);
          let contactCount = 0, staticCount = 0;
          for (let i = 0; i < hull.length; i++) {
            const anyTouch = i < contacts.length && contacts[i] !== 0;
            const stat = i < staticContacts.length && staticContacts[i] !== 0;
            if (anyTouch) contactCount++;
            if (stat) staticCount++;
            ctx.beginPath();
            ctx.arc(toScreenX(hull[i].x), toScreenY(hull[i].y), 3.5, 0, Math.PI * 2);
            ctx.fillStyle = stat ? '#ff3b3b' : anyTouch ? '#ffaa33' : 'rgba(120,200,255,0.45)';
            ctx.strokeStyle = 'rgba(0,0,0,0.85)';
            ctx.lineWidth = 1.5;
            ctx.fill();
            ctx.stroke();
          }

          // Collision + crush-check state read straight from the engine.
          const sticky = world.getBlobStickyContact(blob.blobId);
          const ground = world.getBlobGroundContacts(blob.blobId);
          const pinned = (blob as { isPinned?: boolean }).isPinned ?? false;
          const dbg = world.getBlobCrushDebug(blob.blobId);

          // Sit the label block just under the blob's lowest hull point, clear of the face.
          let maxY = -Infinity;
          for (const pt of hull) if (pt.y > maxY) maxY = pt.y;
          const sx = toScreenX(c.x);
          let sy = toScreenY(maxY) + 12;

          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          const drawLine = (text: string, color: string) => {
            ctx.fillStyle = color;
            ctx.strokeText(text, sx, sy);
            ctx.fillText(text, sx, sy);
            sy += 15;
          };
          drawLine(`${pct.toFixed(0)}%`, pct <= crushPct ? '#ff5555' : pct <= 50 ? '#ffcc55' : '#ffffff');
          drawLine(`Pinned: ${pinned ? 'True' : 'False'}`, pinned ? '#ff5555' : '#9fe6a0');
          drawLine(`Contacts: ${contactCount}/${hull.length}  Static: ${staticCount}`, staticCount > 0 ? '#ffcc55' : '#ffffff');
          drawLine(`Sticky: ${sticky.count}  Ground: ${ground}`, sticky.count > 0 ? '#ffcc55' : '#ffffff');
          // The crush detector's own verdict: it needs Sand AND Comp to kill.
          drawLine(
            `Sand: ${dbg.sandwiched ? 'T' : 'F'}  Comp: ${dbg.compressed ? 'T' : 'F'}  Viol: ${dbg.violations}`,
            dbg.sandwiched && dbg.compressed ? '#ff5555' : dbg.sandwiched || dbg.compressed ? '#ffcc55' : '#9fe6a0',
          );
          drawLine(`minDot: ${dbg.minDot.toFixed(2)} (crush < -0.50)`, dbg.minDot < -0.5 ? '#ff5555' : '#ffffff');
          // The engine's OWN area ratio — what Comp thresholds (< 20%). May differ
          // from the % above (that uses the first-seen area as its base).
          drawLine(`engArea: ${(dbg.areaRatio * 100).toFixed(0)}% (crush < 20%)`, dbg.areaRatio < 0.2 ? '#ff5555' : '#ffffff');
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

  // Debug keys: "." advances one tick, "," steps back one tick, "p" toggles
  // pause. (None are player-input keys, so they don't collide with WASD/Space/arrows.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '.') { e.preventDefault(); stepOnce(); }
      else if (e.key === ',') { e.preventDefault(); stepBack(); }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePause(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepOnce, stepBack, togglePause]);

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
  useEffect(() => {
    if (stateRef.current) {
      stateRef.current.renderOptions.showHull = showHull;
    }
  }, [showHull]);

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
            <button className="bb-hover-btn" style={paperBtnSm}>← Back to Editor</button>
          </Link>
        ) : (
          <Link to="/">
            <button className="bb-hover-btn" style={paperBtnSm}>Home</button>
          </Link>
        )}
        <button
          style={showPoints ? actionBtnSm(COLORS.blue) : paperBtnSm}
          onClick={() => setShowPoints(p => !p)}
        >
          Points: {showPoints ? 'ON' : 'OFF'}
        </button>
        <button
          style={showTargets ? actionBtnSm(COLORS.blue) : paperBtnSm}
          onClick={() => setShowTargets(p => !p)}
          title="Draw the shape-match rest hull (dashed cyan), the frame centroid (magenta cross), and the center particle (yellow dot) for every blob"
        >
          Targets: {showTargets ? 'ON' : 'OFF'}
        </button>
        <button
          style={showHull ? actionBtnSm(COLORS.blue) : paperBtnSm}
          onClick={() => setShowHull(p => !p)}
          title="Draw each blob's hull perimeter polygon (green) and its hull points; the first hull point is yellow to show winding direction"
        >
          Hull: {showHull ? 'ON' : 'OFF'}
        </button>
        <button
          style={showArea ? actionBtnSm(COLORS.blue) : paperBtnSm}
          onClick={() => setShowArea(p => !p)}
          title="Draw each blob's live hull area as a % of its rest size — the value the crush detector reads (red below the ~20% crush threshold)"
        >
          Area %: {showArea ? 'ON' : 'OFF'}
        </button>
        {fromEditor && (
          <button
            style={playersChained
              ? { ...actionBtnSm(COLORS.blue), cursor: 'default', opacity: 0.7 }
              : paperBtnSm}
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
          style={paperBtnSm}
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
      {/* Time controls — slow-mo / pause / single-step for frame-by-frame debugging */}
      <div style={{
        position: 'absolute',
        bottom: 14,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        background: 'rgba(15, 22, 41, 0.82)',
        padding: '6px 10px',
        borderRadius: 10,
      }}>
        <span style={{ color: '#9fb3d1', fontSize: 12, marginRight: 2 }}>Speed</span>
        {[1, 0.5, 0.25, 0.1, 0.05].map(s => (
          <button
            key={s}
            style={timeScale === s ? actionBtnSm(COLORS.blue) : paperBtnSm}
            onClick={() => setSpeed(s)}
            title={`Run the sim at ${s}× speed`}
          >
            {s === 1 ? '1×' : `${s}×`}
          </button>
        ))}
        <div style={{ width: 1, height: 22, background: '#3a4a66', margin: '0 4px', opacity: 0.6 }} />
        <button
          style={paused ? actionBtnSm(COLORS.blue) : paperBtnSm}
          onClick={togglePause}
          title="Pause / resume the simulation (rendering keeps running)"
        >
          {paused ? '▶ Play' : '⏸ Pause'}
        </button>
        <button
          style={paused ? paperBtnSm : { ...paperBtnSm, opacity: 0.4, cursor: 'default' }}
          disabled={!paused}
          onClick={stepBack}
          title="Rewind one logic tick (1/60s) — pause first. Key: ,"
        >
          ⏮ Back
        </button>
        <button
          style={paused ? paperBtnSm : { ...paperBtnSm, opacity: 0.4, cursor: 'default' }}
          disabled={!paused}
          onClick={stepOnce}
          title="Advance exactly one logic tick (1/60s) — pause first. Key: ."
        >
          ⏭ Step
        </button>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
