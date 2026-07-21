/**
 * Kids Mode v3 — toddlers/preschoolers (iPad-first, web-first).
 *
 *  - Bottom chrome: stick | color rail | puff (UI)
 *  - Alphabet / Music / Shape / Color picker (KidsModePicker)
 *  - Mode owns ALL playground taps + expand (letter | note | shape | color)
 *  - Color rail: always applies color; audio follows mode (color mode → name)
 *  - Side-tap/hold empty L/R canvas → move
 *  - Space / pad expand → ALL blobs puff + one mode lesson
 *  - Silence all kids audio on background / leave route
 *
 * Lessons fire on expand edge AND blob pick-up (mode-wide). See kidsAbc.ts.
 */

import React, { useRef, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { createSoftBodyEngine } from '../physics/engineSelector';
import { SlimeBlob, type HullPreset } from '../physics/slimeBlob';
import { Camera } from '../renderer/camera';
import { render, type RenderOptions } from '../renderer/canvasRenderer';
import { GameLoop } from '../game/gameLoop';
import { KeyboardInput } from '../game/keyboardInput';
import { TouchInput } from '../game/touchInput';
import { PlayerManager } from '../game/playerManager';
import { SpikeManager } from '../game/spikeManager';
import { SpringPadManager } from '../game/springPadManager';
import { TriggerManager } from '../game/triggerManager';
import { ActionManager } from '../game/actionManager';
import { PlatformMover } from '../game/platformMover';
import { loadLevel, type GetSpriteShape } from '../levels/levelLoader';
import { getSprite, preloadSprites } from '../assets/spriteRegistry';
import { preloadBackground } from '../renderer/backgroundRenderer';
import { loadBuiltinLevel } from '../levels/levelRegistry';
import type { LevelData } from '../levels/types';
import GameCanvas from '../components/GameCanvas';
import KidsBottomBar from '../components/KidsBottomBar';
import KidsLandscapeGate from '../components/KidsLandscapeGate';
import KidsModePicker, { type KidsLearnMode } from '../components/KidsModePicker';
import { EffectsBindings } from '../game/effectsBindings';
import { updateParticles, clearParticles, emitSparkle, emitPuff } from '../renderer/particles';
import { clearDecals, setDecalResolvers } from '../renderer/decals';
import { preloadAll, SFX_NAMES, resumeAudio } from '../utils/audio';
import {
  getPlayerColor, setPlayerColorSetting, getPlayerFaceId, onAudioSettingsChange,
} from '../utils/audioSettings';
import { computeMapAABB, FALL_KILL_MARGIN, lavaKillPlaneY } from '../game/mapBounds';
import { COLORS, PAPER_SHADOW, RADII, backBtn, tape } from '../theme/uiTheme';
import { paletteColorAt } from '../utils/colorNames';
import { KidsAbcProgress } from '../utils/kidsAbc';
import { KidsTwinkleProgress } from '../utils/kidsMusic';
import {
  playKidsColor, playKidsShape, preloadKidsVoice, stopAllKidsAudio,
} from '../utils/kidsVoice';
import { vec2 } from '../physics/vec2';

/** Floating letter / note / shape glyphs that pop on expand (DOM overlay). */
interface ExpandFloater {
  id: number;
  glyph: string;
  x: number;
  y: number;
  kind: 'letter' | 'note' | 'shape';
}

const LEARN_MODE_KEY = 'bb-kids-learn-mode';

/** Custom kids-safe arena — whole map framed by camera. */
const KIDS_LEVEL_ID = 'kids-playground';

/** Kid-facing shape cycle (matches hull presets + voice stems). */
const KIDS_SHAPES = ['star', 'square', 'triangle'] as const;
type KidsShape = (typeof KIDS_SHAPES)[number];
const SHAPE_GLYPH: Record<KidsShape, string> = { star: '★', square: '■', triangle: '▲' };

/** World radius (approx) for blob tap hit-tests — generous for small fingers. */
const TAP_HIT_R = 110;
/** How long a picked-up blob stays puffed after release. */
const PICK_PUFF_SEC = 0.95;
/** Ensure the field always feels full of friends. */
const MIN_FRIENDS = 8;

// Grab is a VELOCITY SERVO (same idea as menuBlobs) — never a hard teleport.
const FOLLOW_RATE = 16;       // 1/s — fraction of remaining gap closed per second
const MAX_PULL_SPEED = 2400;  // px/s — cap so springs to neighbours keep up
const FLING_CAP = 1600;       // px/s clamp on release throw
const PICK_SCALE_PEAK = 1.55; // rest-scale while held / shortly after

interface FriendBlob {
  blob: SlimeBlob;
  color: string;
  shape: KidsShape;
  /** Remaining seconds of expand puff after pick-up / release. */
  puffT: number;
  /** Wander: horizontal direction and time until flip. */
  wanderDir: number;
  wanderT: number;
  /** Countdown until next autonomous expand pulse. */
  selfExpandT: number;
  /** Remaining seconds of the current self-expand hold. */
  selfExpandHold: number;
}

/** Active grab — particle velocity servo toward the finger. */
interface GrabState {
  kind: 'player' | 'friend';
  friendIndex: number; // only when kind === 'friend'
  blobId: number;
  particleIdx: number;
  targetX: number;
  targetY: number;
  lastTX: number;
  lastTY: number;
  pvx: number;
  pvy: number;
  pointerId: number;
}

interface RunnerState {
  world: SoftBodyEngine;
  camera: Camera;
  playerManager: PlayerManager;
  playerBlob: SlimeBlob;
  friends: FriendBlob[];
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
  mapBounds: ReturnType<typeof computeMapAABB>;
  softPlatforms: ReturnType<typeof loadLevel>['softPlatforms'];
  pointShapes: ReturnType<typeof loadLevel>['pointShapes'];
  chains: ReturnType<typeof loadLevel>['chains'];
  levelData: LevelData;
  /** Previous frame expand state — rising edge drives ABC / music / shape. */
  wasExpanding: boolean;
  abc: KidsAbcProgress;
  music: KidsTwinkleProgress;
  /** Index into KIDS_SHAPES for expand lesson in shape mode. */
  shapeIndex: number;
  canvasEl: HTMLCanvasElement | null;
  grab: GrabState | null;
}

export default function KidsMode() {
  const [levelData, setLevelData] = useState<LevelData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [blobColor, setBlobColor] = useState(() => getPlayerColor());
  const [lastLetter, setLastLetter] = useState<string>('—');
  const [floaters, setFloaters] = useState<ExpandFloater[]>([]);
  const floaterIdRef = useRef(0);
  /** Alphabet / Music / Shape / Color — expand + tap rules are mode-dependent (eng). */
  const [learnMode, setLearnMode] = useState<KidsLearnMode>(() => {
    try {
      const v = localStorage.getItem(LEARN_MODE_KEY);
      if (v === 'music' || v === 'alphabet' || v === 'shape' || v === 'color') return v;
    } catch { /* ignore */ }
    return 'alphabet';
  });
  const learnModeRef = useRef(learnMode);
  learnModeRef.current = learnMode;

  const setLearnModePersist = useCallback((m: KidsLearnMode) => {
    setLearnMode(m);
    try { localStorage.setItem(LEARN_MODE_KEY, m); } catch { /* ignore */ }
  }, []);

  const stateRef = useRef<RunnerState | null>(null);
  const touchRef = useRef<TouchInput | null>(null);
  if (!touchRef.current) touchRef.current = new TouchInput();
  /** Side-tap hold: -1 left / +1 right / 0 none (empty canvas L/R). */
  const sideMoveRef = useRef(0);
  const sidePointerIdRef = useRef<number | null>(null);

  /** Mode-owned lesson audio + HUD (expand or blob tap). Returns true if something played. */
  const fireModeLesson = useCallback((opts?: {
    friendShape?: KidsShape;
    friendColor?: string;
    at?: { x: number; y: number };
  }): boolean => {
    const s = stateRef.current;
    if (!s) return false;
    const mode = learnModeRef.current;
    const c = opts?.at ?? s.playerBlob.getCentroid();
    const screen = s.camera.worldToScreen(c, s.canvasWidth, s.canvasHeight);
    const playerCol = s.playerManager.getPlayer('kids-player')?.color ?? getPlayerColor();

    if (mode === 'music') {
      const n = s.music.onExpand();
      if (n == null) return false;
      setLastLetter('♪');
      const NOTE_GLYPHS = ['♪', '♫', '♬', '♩'] as const;
      const NOTE_COLORS = [COLORS.lavender, COLORS.pink, COLORS.yellow, COLORS.green, COLORS.paper];
      const burst = 3 + Math.floor(Math.random() * 3);
      emitPuff(c, COLORS.lavender, 6);
      for (let k = 0; k < burst; k++) {
        const ang = Math.random() * Math.PI * 2;
        const rPx = 70 + Math.random() * 200;
        const ox = Math.cos(ang) * rPx;
        const oy = Math.sin(ang) * rPx - 20;
        const z = Math.max(0.2, s.camera.zoom);
        const colN = NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)];
        emitSparkle({ x: c.x + ox / z, y: c.y + oy / z }, colN, 8 + Math.floor(Math.random() * 12));
        const id = ++floaterIdRef.current;
        const glyph = NOTE_GLYPHS[Math.floor(Math.random() * NOTE_GLYPHS.length)];
        const fx = Math.max(36, Math.min(s.canvasWidth - 36, screen.x + ox));
        const fy = Math.max(48, Math.min(s.canvasHeight - 140, screen.y + oy));
        setFloaters((prev) => [...prev, { id, glyph, x: fx, y: fy, kind: 'note' }]);
        window.setTimeout(() => {
          setFloaters((prev) => prev.filter((f) => f.id !== id));
        }, 650 + Math.floor(Math.random() * 550));
      }
      return true;
    }

    if (mode === 'shape') {
      const shape = opts?.friendShape
        ?? KIDS_SHAPES[s.shapeIndex % KIDS_SHAPES.length];
      if (!opts?.friendShape) {
        s.shapeIndex = (s.shapeIndex + 1) % KIDS_SHAPES.length;
      }
      playKidsShape(shape);
      setLastLetter(SHAPE_GLYPH[shape]);
      emitSparkle(c, COLORS.green, 16);
      emitPuff(c, COLORS.paper, 6);
      const id = ++floaterIdRef.current;
      setFloaters((prev) => [...prev, {
        id, glyph: SHAPE_GLYPH[shape], x: screen.x, y: screen.y, kind: 'shape',
      }]);
      window.setTimeout(() => {
        setFloaters((prev) => prev.filter((f) => f.id !== id));
      }, 900);
      return true;
    }

    if (mode === 'color') {
      const col = opts?.friendColor ?? playerCol;
      playKidsColor(col);
      setLastLetter('⬤');
      emitSparkle(c, col, 16);
      emitPuff(c, COLORS.paper, 6);
      return true;
    }

    // alphabet (default)
    const letter = s.abc.onExpand();
    if (!letter) return false;
    setLastLetter(letter);
    emitSparkle(c, playerCol, 16);
    emitPuff(c, COLORS.paper, 6);
    const id = ++floaterIdRef.current;
    setFloaters((prev) => [...prev, {
      id, glyph: letter, x: screen.x, y: screen.y, kind: 'letter',
    }]);
    window.setTimeout(() => {
      setFloaters((prev) => prev.filter((f) => f.id !== id));
    }, 900);
    return true;
  }, []);

  const fireModeLessonRef = useRef(fireModeLesson);
  fireModeLessonRef.current = fireModeLesson;

  const chooseColor = useCallback((hex: string) => {
    resumeAudio();
    setBlobColor(hex);
    setPlayerColorSetting(hex);
    const s = stateRef.current;
    if (s) {
      const p = s.playerManager.getPlayer('kids-player');
      if (p) p.color = hex;
    }
    // Mode owns ALL taps including color rail (color / letter / shape / note).
    fireModeLessonRef.current({ friendColor: hex });
  }, []);

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
    clearParticles();
    clearDecals();
    stopAllKidsAudio();
    stateRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadBuiltinLevel(KIDS_LEVEL_ID)
      .then((data) => {
        if (cancelled) return;
        if (!data.name) data.name = 'Kids Playground';
        setLevelData(data);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Kids mode level load failed', err);
        setLoadError(String(err?.message ?? err));
      });
    return () => { cancelled = true; };
  }, []);

  // Silence voice + Twinkle when app backgrounds or route leaves.
  useEffect(() => {
    const silence = () => { stopAllKidsAudio(); };
    const onVis = () => {
      if (document.visibilityState === 'hidden') silence();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', silence);
    window.addEventListener('blur', silence);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', silence);
      window.removeEventListener('blur', silence);
      silence();
    };
  }, []);

  const clientToWorld = useCallback((clientX: number, clientY: number) => {
    const s = stateRef.current;
    if (!s) return null;
    const canvas = s.canvasEl ?? s.ctx.canvas;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return s.camera.screenToWorld({ x: sx, y: sy }, s.canvasWidth, s.canvasHeight);
  }, []);

  /** Nearest hull particle on a blob within TAP_HIT_R of world point. */
  const nearestParticle = useCallback((
    world: SoftBodyEngine,
    blob: { blobId: number; getCentroid: () => { x: number; y: number } },
    wx: number,
    wy: number,
  ): number | null => {
    const c = blob.getCentroid();
    if (Math.hypot(c.x - wx, c.y - wy) > TAP_HIT_R) return null;
    const range = world.getBlobRange(blob.blobId);
    if (!range) return null;
    const pos = world.getPositions();
    let bestIdx = range.hull[0] ?? null;
    let bestD = Infinity;
    for (const i of range.hull) {
      const p = pos[i];
      if (!p) continue;
      const d = Math.hypot(p.x - wx, p.y - wy);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }, []);

  const beginGrab = useCallback((
    clientX: number,
    clientY: number,
    pointerId: number,
  ): boolean => {
    const s = stateRef.current;
    if (!s || s.grab) return false;
    const worldPt = clientToWorld(clientX, clientY);
    if (!worldPt) return false;

    type Hit =
      | { kind: 'player'; idx: number; d: number }
      | { kind: 'friend'; i: number; idx: number; d: number };
    let best: Hit | null = null;

    const pIdx = nearestParticle(s.world, s.playerBlob, worldPt.x, worldPt.y);
    if (pIdx != null) {
      const c = s.playerBlob.getCentroid();
      best = { kind: 'player', idx: pIdx, d: Math.hypot(c.x - worldPt.x, c.y - worldPt.y) };
    }
    for (let i = 0; i < s.friends.length; i++) {
      const f = s.friends[i];
      if (f.blob.destroyed) continue;
      const idx = nearestParticle(s.world, f.blob, worldPt.x, worldPt.y);
      if (idx == null) continue;
      const c = f.blob.getCentroid();
      const d = Math.hypot(c.x - worldPt.x, c.y - worldPt.y);
      if (!best || d < best.d) best = { kind: 'friend', i, idx, d };
    }
    if (!best) return false;

    resumeAudio();

    const blobId = best.kind === 'player'
      ? s.playerBlob.blobId
      : s.friends[best.i].blob.blobId;

    s.grab = {
      kind: best.kind,
      friendIndex: best.kind === 'friend' ? best.i : -1,
      blobId,
      particleIdx: best.idx,
      targetX: worldPt.x,
      targetY: worldPt.y,
      lastTX: worldPt.x,
      lastTY: worldPt.y,
      pvx: 0,
      pvy: 0,
      pointerId,
    };

    // Mode owns ALL blob taps (ABC letter / music note / shape / color).
    if (best.kind === 'player') {
      touchRef.current?.setExpanding(true);
      const p = s.playerManager.getPlayer('kids-player');
      const col = p?.color ?? getPlayerColor();
      fireModeLessonRef.current({
        friendColor: col,
        at: s.playerBlob.getCentroid(),
      });
    } else {
      const friend = s.friends[best.i];
      friend.puffT = PICK_PUFF_SEC;
      fireModeLessonRef.current({
        friendShape: friend.shape,
        friendColor: friend.color,
        at: friend.blob.getCentroid(),
      });
    }
    return true;
  }, [clientToWorld, nearestParticle]);

  const moveGrab = useCallback((clientX: number, clientY: number, pointerId: number) => {
    const s = stateRef.current;
    if (!s?.grab || s.grab.pointerId !== pointerId) return;
    const worldPt = clientToWorld(clientX, clientY);
    if (!worldPt) return;
    s.grab.targetX = worldPt.x;
    s.grab.targetY = worldPt.y;
  }, [clientToWorld]);

  const endGrab = useCallback((pointerId: number) => {
    const s = stateRef.current;
    if (!s?.grab || s.grab.pointerId !== pointerId) return;
    const g = s.grab;
    // Fling with smoothed pointer velocity.
    const tx = Math.max(-FLING_CAP, Math.min(FLING_CAP, g.pvx));
    const ty = Math.max(-FLING_CAP, Math.min(FLING_CAP, g.pvy));
    s.world.applyBlobLinearVelocityDelta(g.blobId, vec2(tx, ty));
    if (g.kind === 'player') {
      touchRef.current?.setExpanding(false);
    } else if (g.friendIndex >= 0) {
      // Keep a short post-release puff so the pick-up feels bouncy.
      s.friends[g.friendIndex].puffT = Math.max(s.friends[g.friendIndex].puffT, 0.45);
    }
    s.grab = null;
  }, []);

  const onInit = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    if (!levelData) return;
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
    const managed = playerManager.addPlayer(
      'kids-player',
      'Kid',
      world,
      'circle16',
      getPlayerColor(),
      getPlayerFaceId(),
    );
    const playerBlob = managed.blob;
    const unsubColor = onAudioSettingsChange(() => {
      managed.color = getPlayerColor();
      managed.faceId = getPlayerFaceId();
    });
    world.teleportBlob(playerBlob.blobId, spawnPos);

    const shapeFor = (i: number, preset?: string): KidsShape => {
      if (preset === 'star' || preset === 'square' || preset === 'triangle') return preset;
      return KIDS_SHAPES[i % KIDS_SHAPES.length];
    };

    // Friend blobs = level NPCs (shaped + colored). playerControlled so we can
    // drive wander via setInput/update without PlayerManager.
    const friends: FriendBlob[] = npcBlobs.map((blob, i) => {
      // Re-enable control path for wander (NPCs load uncontrolled).
      (blob as { playerControlled: boolean }).playerControlled = true;
      return {
        blob,
        color: paletteColorAt(i),
        shape: shapeFor(i, (blob as { hullPreset?: string }).hullPreset),
        puffT: 0,
        wanderDir: i % 2 === 0 ? 1 : -1,
        wanderT: 1.2 + (i % 5) * 0.4,
        selfExpandT: 1.8 + (i % 6) * 0.55 + Math.random() * 0.8,
        selfExpandHold: 0,
      };
    });
    // Infer shape from level def by index (NPC blobs keep preset only in ctor).
    for (let i = 0; i < friends.length && i < (levelData.npcBlobs?.length ?? 0); i++) {
      const def = levelData.npcBlobs![i];
      friends[i].shape = shapeFor(i, def.hullPreset);
    }

    // Extra friends near spawn so the field always feels full.
    while (friends.length < MIN_FRIENDS) {
      const i = friends.length;
      const shape = KIDS_SHAPES[i % KIDS_SHAPES.length];
      const ox = spawnPos.x + ((i % 4) - 1.5) * 160;
      const oy = spawnPos.y - 20 - Math.floor(i / 4) * 50;
      const blob = new SlimeBlob(world, vec2(ox, oy), {
        playerControlled: true,
        hullPreset: shape as HullPreset,
        sortKey: `kids-friend:${i}`,
      });
      world.setBlobRole(blob.blobId, 2, 0);
      friends.push({
        blob, color: paletteColorAt(i + 3), shape, puffT: 0,
        wanderDir: i % 2 === 0 ? -1 : 1,
        wanderT: 1.5 + (i % 4) * 0.35,
        selfExpandT: 2.0 + (i % 5) * 0.5 + Math.random() * 1.2,
        selfExpandHold: 0,
      });
    }

    const mapBounds = computeMapAABB(
      world, levelData, platformSurfaces, softPlatforms, pointShapes, playerSpawnPoints,
    );

    // Soft fall-off respawn only — no spike drama for kids.
    let spikeManager: SpikeManager | null = null;
    if (levelData.bounds) {
      spikeManager = new SpikeManager();
      spikeManager.initialize(world, playerManager, [], friends.map((f) => f.blob));
      spikeManager.deathMode = 'instant';
      spikeManager.setKillBelowY(mapBounds.maxY + FALL_KILL_MARGIN);
    }
    const smForCrush = spikeManager;
    world.onBlobCrushed = (blobId) => { smForCrush?.killPlayerByBlobId(blobId); };

    let springPadManager: SpringPadManager | null = null;
    if (levelData.springPads && levelData.springPads.length > 0) {
      springPadManager = new SpringPadManager();
      springPadManager.initialize(world, levelData.springPads);
    }

    const effects = new EffectsBindings();
    const platformMover = new PlatformMover();
    platformMover.initialize(levelData.platforms, platformSurfaces, world);

    setDecalResolvers({
      getPlatformLivePos: (id) => platformMover.getLivePosition(id),
      getPlatformLivePoly: (id) => platformMover.getLivePoly(id),
      getParticlePos: (idx) => world.pos[idx] ?? null,
      getSpringLivePos: (id) => springPadManager?.getSpringLivePosition(id) ?? null,
    });

    const triggerManager = new TriggerManager();
    const friendIds = new Set(friends.map((f) => f.blob.blobId));
    triggerManager.initialize(
      world,
      levelData.triggers ?? [],
      triggerShapeIdxToId,
      (blobId) => friendIds.has(blobId),
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
    // Whole playground in view (static fit — kid sees entire space).
    // Extra padding + slightly lower maxZoom → free bottom chrome (stick|colors|puff)
    // so shapes aren't crowded against the rail.
    const CAM_PAD = 160;
    const CAM_MAX_Z = 0.72;
    camera.snapToBounds(
      mapBounds.minX, mapBounds.minY, mapBounds.maxX, mapBounds.maxY,
      width, height, CAM_PAD, CAM_MAX_Z,
    );

    const input = new KeyboardInput();
    input.attach();

    const renderOptions: RenderOptions = {
      showSprings: false,
      showShapeTargets: false,
      showPoints: false,
      showHull: false,
      // Sharp corners so star / square / triangle read as shapes (not soft blobs).
      cornerRoundness: 0.04,
    };

    const state: RunnerState = {
      world, camera, playerManager, playerBlob, friends, input,
      loop: null as unknown as GameLoop,
      ctx, canvasWidth: width, canvasHeight: height, renderOptions,
      spikeManager, springPadManager, triggerManager, actionManager, platformMover,
      effects, unsubColor, mapBounds, softPlatforms, pointShapes, chains, levelData,
      wasExpanding: false,
      abc: new KidsAbcProgress(),
      music: new KidsTwinkleProgress(),
      shapeIndex: 0,
      canvasEl: ctx.canvas,
      grab: null,
    };

    preloadKidsVoice();

    const loop = new GameLoop((dt) => {
      const safeDt = Math.max(dt, 1 / 240);
      const touch = touchRef.current!;
      const holdingPlayer = state.grab?.kind === 'player';

      // Merge pad + keyboard + side-tap hold. Grabbing player freezes move.
      const side = sideMoveRef.current;
      const moveX = holdingPlayer
        ? 0
        : Math.max(-1, Math.min(1, input.getMoveX(1) + touch.getMoveX() + side));
      const moveY = holdingPlayer
        ? 0
        : Math.max(-1, Math.min(1, input.getMoveY(1) + touch.getMoveY()));
      // Space / pad expand = group lesson expand (all blobs). Grab-hold puffs player only.
      const groupExpand = input.isExpanding(1) || touch.isExpanding();
      const expanding = holdingPlayer || groupExpand;

      // ── Group expand rising edge → one mode-owned lesson (not per-blob) ──
      if (groupExpand && !state.wasExpanding) {
        fireModeLessonRef.current();
      }
      state.wasExpanding = groupExpand;

      playerBlob.setInput(moveX, moveY, expanding);
      playerBlob.update(dt);

      const mag = Math.hypot(moveX, moveY);
      const tx = mag > 0.01 ? moveX / mag : 0;
      const ty = mag > 0.01 ? moveY / mag : 0;
      const a = 1 - Math.exp(-12 * dt);
      managed.gazeX += (tx - managed.gazeX) * a;
      managed.gazeY += (ty - managed.gazeY) * a;

      // Grab velocity servo (menuBlobs-style) — run before world.step.
      if (state.grab) {
        const g = state.grab;
        g.pvx = g.pvx * 0.55 + ((g.targetX - g.lastTX) / safeDt) * 0.45;
        g.pvy = g.pvy * 0.55 + ((g.targetY - g.lastTY) / safeDt) * 0.45;
        g.lastTX = g.targetX;
        g.lastTY = g.targetY;

        const pos = world.getPositions();
        const p = pos[g.particleIdx];
        if (p) {
          let sx = (g.targetX - p.x) * FOLLOW_RATE;
          let sy = (g.targetY - p.y) * FOLLOW_RATE;
          const sm = Math.hypot(sx, sy);
          if (sm > MAX_PULL_SPEED) {
            const s = MAX_PULL_SPEED / sm;
            sx *= s;
            sy *= s;
          }
          world.setParticleVel(g.particleIdx, sx, sy);
        }

        // Keep friend puffed while held.
        if (g.kind === 'friend' && g.friendIndex >= 0) {
          state.friends[g.friendIndex].puffT = Math.max(
            state.friends[g.friendIndex].puffT,
            0.2,
          );
        }
      }

      // Friend wander + puff: AI roam + self-expand; Space/pad expands ALL.
      for (const f of state.friends) {
        if (f.blob.destroyed) continue;
        const held = state.grab?.kind === 'friend'
          && state.friends[state.grab.friendIndex] === f;
        if (!held) {
          f.wanderT -= dt;
          if (f.wanderT <= 0) {
            f.wanderDir = -f.wanderDir;
            f.wanderT = 1.4 + Math.random() * 2.2;
          }
          if (f.selfExpandHold > 0) {
            f.selfExpandHold = Math.max(0, f.selfExpandHold - dt);
          } else {
            f.selfExpandT -= dt;
            if (f.selfExpandT <= 0) {
              // Visible puff like main-game AI expand pulses.
              f.selfExpandHold = 0.48;
              f.selfExpandT = 2.0 + Math.random() * 2.8;
              f.puffT = Math.max(f.puffT, 0.55);
            }
          }
          const selfExpand = f.selfExpandHold > 0;
          // Gentle horizontal roam; groupExpand or autonomous self-expand.
          f.blob.setInput(f.wanderDir * 0.55, 0, groupExpand || selfExpand);
          f.blob.update(dt);
        }
        if (f.puffT > 0) {
          f.puffT = Math.max(0, f.puffT - dt);
          const t = f.puffT / PICK_PUFF_SEC;
          const scale = 1 + (PICK_SCALE_PEAK - 1) * Math.min(1, t * 1.2);
          world.setBlobShapeMatchRestScale(f.blob.blobId, scale);
        } else {
          world.setBlobShapeMatchRestScale(f.blob.blobId, 1);
        }
      }

      world.step(dt);
      springPadManager?.update(dt);
      spikeManager?.update(dt);
      triggerManager.update(dt);
      actionManager.update(dt);
      effects.update(
        dt, playerManager, state.friends.map((f) => f.blob), world,
        [...softPlatforms, ...pointShapes], platformMover, undefined, springPadManager ?? undefined,
      );
      updateParticles(dt);
      // Whole kids map stays framed (static arena view; pad for bottom chrome).
      camera.watchBounds(
        mapBounds.minX, mapBounds.minY, mapBounds.maxX, mapBounds.maxY,
        state.canvasWidth, state.canvasHeight, 160, 0.72,
      );
      camera.update(dt);

      // Render friends as extra "players" so we get palette hex colors + faces.
      const friendBlobs = state.friends.filter((f) => !f.blob.destroyed).map((f) => f.blob);
      const playerData = [
        {
          name: '',
          color: managed.color,
          faceId: managed.faceId,
          expanding: playerBlob.isExpanding() || holdingPlayer,
          expandScale: playerBlob.getExpandScale(),
          gaze: { x: managed.gazeX, y: managed.gazeY },
        },
        ...state.friends.filter((f) => !f.blob.destroyed).map((f) => ({
          name: '',
          color: f.color,
          faceId: 'default' as const,
          expanding: f.puffT > 0 || groupExpand || f.blob.isExpanding(),
          expandScale: groupExpand
            ? f.blob.getExpandScale()
            : 1 + (PICK_SCALE_PEAK - 1) * Math.min(1, (f.puffT / PICK_PUFF_SEC) * 1.2),
          gaze: { x: 0, y: 0 },
        })),
      ];

      render(
        ctx, world, camera,
        [playerBlob, ...friendBlobs],
        [], // NPCs drawn as players with custom colors
        state.canvasWidth, state.canvasHeight, renderOptions, undefined,
        playerData, [...softPlatforms, ...pointShapes], chains,
        lavaKillPlaneY(levelData, mapBounds),
      );
    });

    state.loop = loop;
    stateRef.current = state;
    loop.start();
    // Silent start (Dia): first voice is color pick or expand letter — no welcome.
  }, [levelData, teardown]);

  const onResize = useCallback((w: number, h: number) => {
    if (stateRef.current) {
      stateRef.current.canvasWidth = w;
      stateRef.current.canvasHeight = h;
    }
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  // Pointer pick-up / drag on the canvas (touch + mouse).
  // Uses pointer capture so drag continues even if finger leaves the canvas.
  useEffect(() => {
    const isChrome = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el?.closest) return false;
      return !!(
        el.closest('[data-kids-pad]') ||
        el.closest('[data-kids-bottom-bar]') ||
        el.closest('[data-kids-color-rail]') ||
        el.closest('[data-kids-mode-picker]') ||
        el.closest('[data-kids-chrome]') ||
        el.closest('a,button')
      );
    };

    const onDown = (e: PointerEvent) => {
      if (!stateRef.current) return;
      if (isChrome(e.target)) return;
      // Only primary button / touch.
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const grabbed = beginGrab(e.clientX, e.clientY, e.pointerId);
      if (grabbed) {
        try {
          (e.target as Element)?.setPointerCapture?.(e.pointerId);
        } catch { /* ignore */ }
        e.preventDefault();
        return;
      }
      // Empty canvas: side-tap hold L/R for toddler move.
      const rect = (stateRef.current.canvasEl ?? stateRef.current.ctx.canvas)
        .getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      sideMoveRef.current = e.clientX < mid ? -1 : 1;
      sidePointerIdRef.current = e.pointerId;
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      if (stateRef.current?.grab?.pointerId === e.pointerId) {
        moveGrab(e.clientX, e.clientY, e.pointerId);
        e.preventDefault();
        return;
      }
      if (sidePointerIdRef.current === e.pointerId && stateRef.current) {
        const rect = (stateRef.current.canvasEl ?? stateRef.current.ctx.canvas)
          .getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        sideMoveRef.current = e.clientX < mid ? -1 : 1;
        e.preventDefault();
      }
    };

    const onUp = (e: PointerEvent) => {
      if (stateRef.current?.grab?.pointerId === e.pointerId) {
        endGrab(e.pointerId);
      }
      if (sidePointerIdRef.current === e.pointerId) {
        sideMoveRef.current = 0;
        sidePointerIdRef.current = null;
      }
    };

    window.addEventListener('pointerdown', onDown, { passive: false });
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [beginGrab, moveGrab, endGrab]);

  // Prime Web Audio on first gesture (iOS requires user activation).
  useEffect(() => {
    const prime = () => { resumeAudio(); };
    window.addEventListener('pointerdown', prime, { once: true, capture: true });
    return () => window.removeEventListener('pointerdown', prime, true);
  }, []);

  if (loadError) {
    return (
      <div style={shell}>
        <p style={{ color: COLORS.titleInk }}>Couldn't start Kids Mode.</p>
        <Link to="/"><button className="paper-btn" style={backBtn}>← Home</button></Link>
      </div>
    );
  }

  if (!levelData) {
    return (
      <div style={shell}>
        <span style={{ color: '#aaa' }}>Getting the blobs ready…</span>
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: '#0f1629',
        // Prevent iOS overscroll / selection while dragging blobs.
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        // iOS long-press callout while holding a finger on chrome / blobs.
        WebkitTouchCallout: 'none',
      } as React.CSSProperties}
    >
      <GameCanvas key="kids" onInit={onInit} onResize={onResize} />

      {/* Portrait → turn-device overlay (iPad plist also locks landscape). */}
      <KidsLandscapeGate />

      {/* Expand floaters — letter / note glyphs rise from the blob. */}
      {floaters.map((f) => (
        <div
          key={f.id}
          aria-hidden
          style={{
            ...floaterBase,
            left: f.x,
            top: f.y,
            color: f.kind === 'note' ? COLORS.lavender : COLORS.ink,
            textShadow: f.kind === 'note'
              ? `0 0 12px ${COLORS.lavender}, 2px 2px 0 #0a0612`
              : `0 0 10px ${COLORS.paper}, 2px 2px 0 #0a0612`,
          }}
        >
          {f.glyph}
        </div>
      ))}

      <KidsModePicker mode={learnMode} onChange={setLearnModePersist} />

      {/* Stick | colors | puff — true bottom row (fixes iPad push-up). */}
      <KidsBottomBar
        input={touchRef.current!}
        color={blobColor}
        onColor={chooseColor}
      />

      <div style={topLeft} data-kids-chrome>
        <Link to="/" style={{ textDecoration: 'none' }}>
          <button className="paper-btn" style={kidsBack} aria-label="Home">
            <span style={{ ...tape(COLORS.lavender), width: '70%', height: 14, top: -9 }} />
            ← Home
          </button>
        </Link>
      </div>

      <div style={letterBadge} aria-hidden="true" data-kids-chrome>
        <span
          style={{
            ...tape(
              learnMode === 'music'
                ? COLORS.lavender
                : learnMode === 'shape'
                  ? COLORS.green
                  : learnMode === 'color'
                    ? COLORS.yellow
                    : COLORS.pink,
            ),
            width: '55%',
            height: 12,
            top: -8,
          }}
        />
        {/* Mode glyph: A…Z | ♪ | shape glyph | ⬤ color */}
        <span style={letterGlyph}>
          {learnMode === 'music'
            ? '♪'
            : learnMode === 'color'
              ? (lastLetter === '—' ? '⬤' : lastLetter)
              : learnMode === 'shape' && lastLetter === '—'
                ? '★'
                : lastLetter}
        </span>
      </div>

      <style>{`
        @keyframes kids-floater-rise {
          0%   { opacity: 0; transform: translate(-50%, -40%) scale(0.5); }
          18%  { opacity: 1; transform: translate(-50%, -70%) scale(1.25); }
          100% { opacity: 0; transform: translate(-50%, -160%) scale(1); }
        }
      `}</style>
    </div>
  );
}

const shell: React.CSSProperties = {
  width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', gap: 16, background: '#0f1629',
};

const topLeft: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(14px + var(--safe-area-top, 0px))',
  left: 'calc(14px + var(--safe-area-left, 0px))',
  zIndex: 25,
};

/** Big cream sticky for parent exit — kid-safe hit target, brand tape. */
const kidsBack: React.CSSProperties = {
  ...backBtn,
  position: 'relative',
  fontSize: 20,
  padding: '16px 22px 14px',
  minHeight: 56,
  minWidth: 96,
  border: '4px solid #0a0612',
  boxShadow: PAPER_SHADOW,
  transform: 'rotate(-2deg)',
};

/** ABC letter on a cream sticky note — matches paper/tape brand, not a pill. */
const letterBadge: React.CSSProperties = {
  position: 'absolute',
  // Extra top inset so the tape strip + rotated corners stay on-screen.
  top: 'calc(20px + var(--safe-area-top, 0px))',
  right: 'calc(16px + var(--safe-area-right, 0px))',
  zIndex: 25,
  minWidth: 72,
  minHeight: 72,
  // Room for glyph + tape overhang; box-sizing so border doesn't steal height.
  boxSizing: 'border-box',
  padding: '14px 18px 12px',
  borderRadius: RADII.card,
  background: COLORS.paper,
  border: '4px solid #0a0612',
  color: COLORS.ink,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: PAPER_SHADOW,
  pointerEvents: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  // Don't clip the glyph or the tape strip.
  overflow: 'visible',
  transform: 'rotate(1.5deg)',
};

const letterGlyph: React.CSSProperties = {
  display: 'block',
  fontWeight: 900,
  fontSize: 34,
  lineHeight: 1,
  letterSpacing: 0,
  // Avoid font descender / leading clip inside the sticky.
  padding: '2px 0 0',
  overflow: 'visible',
};

const floaterBase: React.CSSProperties = {
  position: 'absolute',
  zIndex: 30,
  pointerEvents: 'none',
  fontWeight: 900,
  fontSize: 48,
  lineHeight: 1,
  userSelect: 'none',
  WebkitUserSelect: 'none',
  animation: 'kids-floater-rise 0.9s ease-out forwards',
};
