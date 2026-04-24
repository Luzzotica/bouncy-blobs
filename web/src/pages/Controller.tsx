import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { joinAsController, ControllerWebRTCManager, SignalingService } from '../lib/party';
import type { ControllerCallbacks } from '../lib/party';
import { partyConfig } from '../lib/partyConfig';
import { WebRTCMessage } from '../types/webrtc';

type ControllerPhase = 'joining' | 'waiting' | 'customizing' | 'connected' | 'error';
type ControllerMode = 'normal' | 'party_box' | 'placement';

interface PartyBoxItem {
  type: string;
  label: string;
  category?: string;
  desc?: string;
  width: number;
  height: number;
}

// ─── Color Palette ──────────────────────────────────────────────────────────

const COLOR_PALETTE = [
  '#e06070', '#e88a5a', '#e8c54a', '#6ecf6e',
  '#4ac8c8', '#5a8ae0', '#8a6ae0', '#d06eb0',
  '#f0f0f0', '#ff4444', '#44aaff', '#aa44ff',
];

// ─── Face Presets ────────────────────────────────────────────────────────────

const FACE_PRESETS = [
  { id: 'default', label: ':)' },
  { id: 'derp', label: 'xD' },
  { id: 'cool', label: 'B)' },
  { id: 'angry', label: '>:(' },
  { id: 'uwu', label: 'uwu' },
  { id: 'sleepy', label: '-_-' },
  { id: 'star', label: '*_*' },
  { id: 'cat', label: ':3' },
  { id: 'shock', label: 'O_O' },
  { id: 'wink', label: ';)' },
  { id: 'smug', label: '>.>' },
  { id: 'cry', label: 'T_T' },
  { id: 'skull', label: 'x_x' },
  { id: 'clown', label: '0w0' },
  { id: 'tired', label: 'u_u' },
  { id: 'monocle', label: 'o_Q' },
];

// ─── Joystick Component ──────────────────────────────────────────────────────

function Joystick({ onChange }: { onChange: (x: number, y: number) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [thumbPos, setThumbPos] = useState({ x: 0, y: 0 });
  const activeRef = useRef(false);

  const updateFromPosition = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = Math.min(rect.width, rect.height) / 2;

    let dx = (clientX - cx) / radius;
    let dy = (clientY - cy) / radius;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1) { dx /= dist; dy /= dist; }

    setThumbPos({ x: dx, y: dy });
    onChange(dx, dy);
  }, [onChange]);

  const reset = useCallback(() => {
    activeRef.current = false;
    setThumbPos({ x: 0, y: 0 });
    onChange(0, 0);
  }, [onChange]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    activeRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    updateFromPosition(e.clientX, e.clientY);
  }, [updateFromPosition]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!activeRef.current) return;
    updateFromPosition(e.clientX, e.clientY);
  }, [updateFromPosition]);

  const handlePointerUp = useCallback(() => { reset(); }, [reset]);

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        width: 160,
        height: 160,
        borderRadius: '50%',
        background: 'radial-gradient(circle, #2a3a5a 0%, #1a1a2e 100%)',
        border: '2px solid #3a4a6a',
        position: 'relative',
        touchAction: 'none',
        cursor: 'grab',
      }}
    >
      {/* Thumb */}
      <div style={{
        position: 'absolute',
        width: 52,
        height: 52,
        borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 35%, #a78bfa, #7c5cbf)',
        boxShadow: '0 2px 8px rgba(124, 92, 191, 0.4)',
        left: `calc(50% + ${thumbPos.x * 50}px - 26px)`,
        top: `calc(50% + ${thumbPos.y * 50}px - 26px)`,
        transition: activeRef.current ? 'none' : 'left 0.15s ease-out, top 0.15s ease-out',
        pointerEvents: 'none',
      }} />
      {/* Center indicator */}
      <div style={{
        position: 'absolute',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: '#4a5a7a',
        left: 'calc(50% - 4px)',
        top: 'calc(50% - 4px)',
        pointerEvents: 'none',
      }} />
    </div>
  );
}

// ─── Jelly Button Component ──────────────────────────────────────────────────

function JellyButton({
  pressed,
  onPress,
  onRelease,
}: {
  pressed: boolean;
  onPress: () => void;
  onRelease: () => void;
}) {
  const [jiggle, setJiggle] = useState(false);

  const handleDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setJiggle(true);
    onPress();
  }, [onPress]);

  const handleUp = useCallback(() => {
    setJiggle(false);
    onRelease();
  }, [onRelease]);

  return (
    <div
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      style={{
        width: 130,
        height: 130,
        borderRadius: '50%',
        background: pressed
          ? 'radial-gradient(circle at 40% 40%, #ff9faf, #e06070)'
          : 'radial-gradient(circle at 40% 40%, #ffb3c1, #e8788a)',
        boxShadow: pressed
          ? '0 2px 6px rgba(224, 96, 112, 0.5), inset 0 -2px 8px rgba(255, 200, 210, 0.3)'
          : '0 6px 16px rgba(224, 96, 112, 0.3), inset 0 -4px 12px rgba(255, 200, 210, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        touchAction: 'none',
        cursor: 'pointer',
        userSelect: 'none',
        transform: pressed
          ? 'scale(1.25)'
          : jiggle ? 'scale(1.0)' : 'scale(1.0)',
        transition: pressed
          ? 'transform 0.08s ease-out, background 0.08s, box-shadow 0.08s'
          : 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.2s, box-shadow 0.2s',
        animation: jiggle && !pressed ? 'jelly-release 0.5s ease' : undefined,
      }}
    >
      <span style={{
        fontSize: 16,
        fontWeight: 'bold',
        color: '#fff',
        textShadow: '0 1px 3px rgba(0,0,0,0.2)',
        pointerEvents: 'none',
        letterSpacing: 1,
      }}>
        EXPAND
      </span>
    </div>
  );
}

// ─── Normal Mode: Split-Screen Touch Zones ──────────────────────────────────

const JOYSTICK_RADIUS = 80; // virtual radius in px for normalizing drag distance

function NormalModeZones({
  onMove,
  expanding,
  onExpandPress,
  onExpandRelease,
}: {
  onMove: (x: number, y: number) => void;
  expanding: boolean;
  onExpandPress: () => void;
  onExpandRelease: () => void;
}) {
  // Left zone — dynamic joystick
  const [joystickOrigin, setJoystickOrigin] = useState<{ x: number; y: number } | null>(null);
  const [thumbOffset, setThumbOffset] = useState({ x: 0, y: 0 });
  const leftRef = useRef<HTMLDivElement>(null);

  const handleLeftDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setJoystickOrigin({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setThumbOffset({ x: 0, y: 0 });
    onMove(0, 0);
  }, [onMove]);

  const handleLeftMove = useCallback((e: React.PointerEvent) => {
    if (!joystickOrigin) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    let dx = (cx - joystickOrigin.x) / JOYSTICK_RADIUS;
    let dy = (cy - joystickOrigin.y) / JOYSTICK_RADIUS;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1) { dx /= dist; dy /= dist; }
    setThumbOffset({ x: dx, y: dy });
    onMove(dx, dy);
  }, [joystickOrigin, onMove]);

  const handleLeftUp = useCallback(() => {
    setJoystickOrigin(null);
    setThumbOffset({ x: 0, y: 0 });
    onMove(0, 0);
  }, [onMove]);

  // Right zone — expand
  const handleRightDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onExpandPress();
  }, [onExpandPress]);

  const handleRightUp = useCallback(() => {
    onExpandRelease();
  }, [onExpandRelease]);

  return (
    <div style={{ flex: 1, display: 'flex', position: 'relative' }}>
      {/* Left zone — dynamic joystick */}
      <div
        ref={leftRef}
        onPointerDown={handleLeftDown}
        onPointerMove={handleLeftMove}
        onPointerUp={handleLeftUp}
        onPointerCancel={handleLeftUp}
        style={{
          flex: 1,
          position: 'relative',
          touchAction: 'none',
          userSelect: 'none',
          borderRight: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {/* Hint label when not touching */}
        {!joystickOrigin && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <span style={{ color: '#334', fontSize: 13, fontWeight: 'bold', letterSpacing: 2 }}>MOVE</span>
          </div>
        )}
        {/* Dynamic joystick visual */}
        {joystickOrigin && (
          <>
            {/* Base ring */}
            <div style={{
              position: 'absolute',
              left: joystickOrigin.x - 50,
              top: joystickOrigin.y - 50,
              width: 100,
              height: 100,
              borderRadius: '50%',
              border: '2px solid rgba(167, 139, 250, 0.3)',
              background: 'rgba(42, 58, 90, 0.25)',
              pointerEvents: 'none',
            }} />
            {/* Thumb */}
            <div style={{
              position: 'absolute',
              left: joystickOrigin.x + thumbOffset.x * 40 - 22,
              top: joystickOrigin.y + thumbOffset.y * 40 - 22,
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: 'radial-gradient(circle at 35% 35%, #a78bfa, #7c5cbf)',
              boxShadow: '0 2px 8px rgba(124, 92, 191, 0.5)',
              pointerEvents: 'none',
            }} />
          </>
        )}
      </div>

      {/* Right zone — expand */}
      <div
        onPointerDown={handleRightDown}
        onPointerUp={handleRightUp}
        onPointerCancel={handleRightUp}
        style={{
          flex: 1,
          position: 'relative',
          touchAction: 'none',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: expanding
            ? 'radial-gradient(circle, rgba(224, 96, 112, 0.2) 0%, transparent 70%)'
            : 'transparent',
          transition: 'background 0.15s',
        }}
      >
        <span style={{
          fontSize: expanding ? 18 : 14,
          fontWeight: 'bold',
          color: expanding ? '#ffb3c1' : '#445',
          letterSpacing: 2,
          pointerEvents: 'none',
          transition: 'all 0.15s',
          textShadow: expanding ? '0 0 12px rgba(224, 96, 112, 0.6)' : 'none',
        }}>
          {expanding ? 'EXPANDING' : 'EXPAND'}
        </span>
      </div>
    </div>
  );
}

// ─── Main Controller Page ────────────────────────────────────────────────────

export default function Controller() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const [phase, setPhase] = useState<ControllerPhase>('joining');
  const [playerName, setPlayerName] = useState('');
  const [nameSubmitted, setNameSubmitted] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [expanding, setExpanding] = useState(false);
  const [selectedColor, setSelectedColor] = useState('');
  const [selectedFace, setSelectedFace] = useState('');
  const [takenColors, setTakenColors] = useState<string[]>([]);
  const [takenFaces, setTakenFaces] = useState<string[]>([]);
  const [controllerMode, setControllerMode] = useState<ControllerMode>('normal');
  const [partyBoxItems, setPartyBoxItems] = useState<PartyBoxItem[]>([]);
  const [highlightedItem, setHighlightedItem] = useState(0);
  const [itemSelected, setItemSelected] = useState(false);
  const [placementConfirmed, setPlacementConfirmed] = useState(false);

  const managerRef = useRef<ControllerWebRTCManager | null>(null);
  const signalingRef = useRef<SignalingService | null>(null);
  const playerIdRef = useRef<string>('');
  const inputRef = useRef({ moveX: 0, moveY: 0, expanding: false });
  const sendIntervalRef = useRef<ReturnType<typeof setInterval>>();

  // Debounce for party box navigation
  const lastNavRef = useRef(0);

  const handleJoystickChange = useCallback((x: number, y: number) => {
    inputRef.current.moveX = x;
    inputRef.current.moveY = y;

    // In party box mode, use joystick left/right to browse items
    if (controllerMode === 'party_box' && !itemSelected && partyBoxItems.length > 0) {
      const now = Date.now();
      if (now - lastNavRef.current < 300) return; // debounce
      if (x > 0.5) {
        lastNavRef.current = now;
        setHighlightedItem(prev => Math.min(prev + 1, partyBoxItems.length - 1));
      } else if (x < -0.5) {
        lastNavRef.current = now;
        setHighlightedItem(prev => Math.max(prev - 1, 0));
      }
    }
  }, [controllerMode, itemSelected, partyBoxItems.length]);

  const handleExpandPress = useCallback(() => {
    if (controllerMode === 'party_box' && !itemSelected) {
      // Select the highlighted item
      setItemSelected(true);
      managerRef.current?.send(JSON.stringify({
        type: 'item_select',
        value: { itemIndex: highlightedItem },
      }));
      return;
    }
    if (controllerMode === 'placement' && !placementConfirmed) {
      // Confirm placement
      setPlacementConfirmed(true);
      managerRef.current?.send(JSON.stringify({
        type: 'placement_confirm',
      }));
      return;
    }
    inputRef.current.expanding = true;
    setExpanding(true);
  }, [controllerMode, itemSelected, highlightedItem, placementConfirmed]);

  const handleExpandRelease = useCallback(() => {
    if (controllerMode !== 'normal') return;
    inputRef.current.expanding = false;
    setExpanding(false);
  }, [controllerMode]);

  const handleJoin = useCallback(async () => {
    if (!sessionId || !playerName.trim()) return;
    setNameSubmitted(true);

    try {
      const callbacks: ControllerCallbacks = {
        onConnected: () => {
          // Immediately join the game with default appearance — blob spawns right away
          managerRef.current?.send(JSON.stringify({
            type: 'player_join',
            player: {
              player_id: playerIdRef.current,
              name: playerName.trim(),
              session_id: sessionId,
              slot: 0,
              status: 'connected',
              controller_config: null,
              joined_at: new Date().toISOString(),
              color: '',
              faceId: 'default',
            },
          } satisfies WebRTCMessage));
          setPhase('customizing');
        },
        onMessage: (data) => {
          try {
            const message: WebRTCMessage = JSON.parse(data as string);
            if (message.type === 'customization_update' && message.value) {
              setTakenColors(message.value.takenColors ?? []);
              setTakenFaces(message.value.takenFaces ?? []);
            } else if (message.type === 'controller_config' && message.config) {
              // Could update controller layout here
            } else if (message.type === 'host_phase_update') {
              const { phase: newPhase, items } = message.value ?? {};
              if (newPhase === 'party_box' && items) {
                setControllerMode('party_box');
                setPartyBoxItems(items);
                setHighlightedItem(0);
                setItemSelected(false);
              } else if (newPhase === 'placement') {
                setControllerMode('placement');
                setPlacementConfirmed(false);
              } else {
                setControllerMode('normal');
              }
            }
          } catch (e) {
            console.error('Failed to parse message:', e);
          }
        },
        onDisconnected: () => {
          // Host closed — navigate back to lobby selector
          navigateRef.current('/join');
        },
        onError: (err) => {
          setErrorMsg(err.message);
          setPhase('error');
        },
      };

      const { result, manager, signaling } = await joinAsController(
        partyConfig,
        sessionId,
        playerName.trim(),
        callbacks,
      );

      playerIdRef.current = result.player_id;
      managerRef.current = manager;
      signalingRef.current = signaling;

      setPhase('waiting');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to join');
      setPhase('error');
    }
  }, [sessionId, playerName]);

  /** Send a live customization update to the host. */
  const sendCustomizationUpdate = useCallback((color: string, faceId: string) => {
    managerRef.current?.send(JSON.stringify({
      type: 'customization_update',
      value: { color, faceId },
    }));
  }, []);

  /** Confirm customization and move to controller UI. */
  const handleConfirmCustomization = useCallback(() => {
    setPhase('connected');
  }, []);

  // Send input at ~30Hz (active during both customizing and connected phases)
  useEffect(() => {
    if (phase !== 'connected' && phase !== 'customizing') return;

    sendIntervalRef.current = setInterval(() => {
      const manager = managerRef.current;
      if (!manager) return;

      const { moveX, moveY, expanding } = inputRef.current;

      if (controllerMode === 'placement') {
        // In placement mode, send cursor movement
        manager.send(JSON.stringify({
          type: 'cursor_move',
          value: { x: moveX, y: moveY },
        }));
      } else {
        // Normal mode + party box: send standard input
        manager.send(JSON.stringify({
          type: 'player_input_batch',
          timestamp: Date.now(),
          inputs: {
            joystick_left: { x: moveX, y: 0 },
            button_right: { pressed: expanding },
          },
        } satisfies WebRTCMessage));
      }
    }, 33);

    return () => {
      if (sendIntervalRef.current) clearInterval(sendIntervalRef.current);
    };
  }, [phase, controllerMode]);

  // Keyboard input (WASD + Space)
  useEffect(() => {
    if (phase !== 'connected') return;

    const keys = new Set<string>();

    const updateFromKeys = () => {
      let kx = 0;
      let ky = 0;
      if (keys.has('a') || keys.has('arrowleft'))  kx -= 1;
      if (keys.has('d') || keys.has('arrowright')) kx += 1;
      if (keys.has('w') || keys.has('arrowup'))    ky -= 1;
      if (keys.has('s') || keys.has('arrowdown'))  ky += 1;
      inputRef.current.moveX = kx;
      inputRef.current.moveY = ky;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (['a', 'd', 'w', 's', ' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
        e.preventDefault();
        keys.add(key);
        if (key === ' ') {
          inputRef.current.expanding = true;
          setExpanding(true);
        }
        updateFromKeys();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      keys.delete(key);
      if (key === ' ') {
        inputRef.current.expanding = false;
        setExpanding(false);
      }
      updateFromKeys();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [phase]);

  // Cleanup
  useEffect(() => {
    return () => {
      managerRef.current?.dispose();
      if (sendIntervalRef.current) clearInterval(sendIntervalRef.current);
    };
  }, []);

  if (!sessionId) {
    return (
      <div style={fullCenter}>
        <p style={{ color: '#f66' }}>Invalid session</p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div style={fullCenter}>
        <p style={{ color: '#f66', fontSize: 16 }}>{errorMsg}</p>
        <button onClick={() => window.location.reload()} style={btnStyle}>
          Retry
        </button>
      </div>
    );
  }

  if (phase === 'joining' && !nameSubmitted) {
    return (
      <div style={fullCenter}>
        <h2 style={{ color: '#c77dff', margin: '0 0 20px' }}>Join Game</h2>

        {/* Name input */}
        <input
          type="text"
          placeholder="Your name"
          value={playerName}
          onChange={e => setPlayerName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleJoin()}
          maxLength={20}
          style={{
            padding: '12px 16px',
            fontSize: 18,
            background: '#1a1a2e',
            border: '2px solid #444',
            borderRadius: 8,
            color: '#fff',
            textAlign: 'center',
            width: 200,
          }}
          autoFocus
        />

        <button
          onClick={handleJoin}
          disabled={!playerName.trim()}
          style={{
            ...btnStyle,
            marginTop: 16,
            background: playerName.trim() ? '#c77dff' : '#555',
            fontSize: 18,
            padding: '12px 32px',
          }}
        >
          Join
        </button>

        <button
          onClick={() => navigate('/join')}
          style={{
            ...btnStyle,
            marginTop: 12,
            background: 'transparent',
            color: '#888',
            fontSize: 14,
            padding: '8px 24px',
            border: '1px solid #444',
          }}
        >
          Back
        </button>
      </div>
    );
  }

  if (phase === 'waiting') {
    return (
      <div style={fullCenter}>
        <p style={{ color: '#aaa', fontSize: 16 }}>Connecting...</p>
      </div>
    );
  }

  if (phase === 'customizing') {
    const availableColors = COLOR_PALETTE.filter(c => !takenColors.includes(c));
    const availableFaces = FACE_PRESETS.filter(f => !takenFaces.includes(f.id));

    // Auto-select first available if current selection is empty or taken
    let autoColor = selectedColor;
    let autoFace = selectedFace;
    if (!selectedColor || takenColors.includes(selectedColor)) {
      const first = availableColors[0];
      if (first && first !== selectedColor) { setSelectedColor(first); autoColor = first; }
    }
    if (!selectedFace || takenFaces.includes(selectedFace)) {
      const first = availableFaces[0];
      if (first && first.id !== selectedFace) { setSelectedFace(first.id); autoFace = first.id; }
    }
    // Send initial auto-selected defaults so the blob gets a color immediately
    if (autoColor && autoFace && (autoColor !== selectedColor || autoFace !== selectedFace)) {
      sendCustomizationUpdate(autoColor, autoFace);
    }

    const canConfirm = selectedColor && selectedFace
      && !takenColors.includes(selectedColor)
      && !takenFaces.includes(selectedFace);

    return (
      <div style={{
        ...fullCenter,
        overflowY: 'auto',
        overflowX: 'hidden',
        justifyContent: 'flex-start',
        paddingTop: 24,
        paddingBottom: 24,
      }}>
        <h2 style={{ color: '#c77dff', margin: '0 0 4px' }}>Customize</h2>
        <p style={{ color: '#888', fontSize: 13, margin: '0 0 16px' }}>{playerName}</p>

        {/* Color picker */}
        <div>
          <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px', textAlign: 'center' }}>Color</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 280, margin: '0 auto' }}>
            {COLOR_PALETTE.map(color => {
              const taken = takenColors.includes(color);
              const selected = selectedColor === color;
              return (
                <div
                  key={color}
                  onClick={() => { if (!taken) { setSelectedColor(color); sendCustomizationUpdate(color, selectedFace); } }}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: color,
                    cursor: taken ? 'not-allowed' : 'pointer',
                    border: selected ? '3px solid #fff' : '3px solid transparent',
                    boxShadow: selected ? `0 0 8px ${color}` : 'none',
                    opacity: taken ? 0.2 : 1,
                    transition: 'border 0.1s, box-shadow 0.1s, opacity 0.2s',
                    position: 'relative',
                  }}
                >
                  {taken && (
                    <div style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 16,
                      color: '#fff',
                      fontWeight: 'bold',
                    }}>
                      X
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Face selector */}
        <div style={{ marginTop: 16 }}>
          <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px', textAlign: 'center' }}>Face</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 280, margin: '0 auto' }}>
            {FACE_PRESETS.map(face => {
              const taken = takenFaces.includes(face.id);
              const selected = selectedFace === face.id;
              return (
                <div
                  key={face.id}
                  onClick={() => { if (!taken) { setSelectedFace(face.id); sendCustomizationUpdate(selectedColor, face.id); } }}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 8,
                    background: selected ? '#3a4a6a' : '#1a1a2e',
                    border: selected ? '2px solid #c77dff' : '2px solid #333',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: taken ? 'not-allowed' : 'pointer',
                    opacity: taken ? 0.25 : 1,
                    transition: 'all 0.1s',
                  }}
                >
                  <span style={{ fontSize: 14, color: '#fff' }}>{face.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Preview blob */}
        <div style={{
          marginTop: 16,
          width: 64,
          height: 64,
          borderRadius: '50%',
          background: selectedColor || '#555',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: selectedColor ? `0 4px 16px ${selectedColor}44` : 'none',
        }}>
          <span style={{ fontSize: 20 }}>
            {FACE_PRESETS.find(f => f.id === selectedFace)?.label ?? ':)'}
          </span>
        </div>

        <button
          onClick={handleConfirmCustomization}
          disabled={!canConfirm}
          style={{
            ...btnStyle,
            marginTop: 16,
            background: canConfirm ? '#c77dff' : '#555',
            fontSize: 18,
            padding: '12px 32px',
          }}
        >
          Let's Go!
        </button>
      </div>
    );
  }

  // Connected — show controller UI based on mode
  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      touchAction: 'none',
      userSelect: 'none',
      overflow: 'hidden',
      background: '#0f0f1a',
    }}>
      {/* Jelly animation keyframes + prevent all text selection */}
      <style>{`
        @keyframes jelly-release {
          0% { transform: scale(1.25); }
          30% { transform: scale(0.9); }
          50% { transform: scale(1.06); }
          70% { transform: scale(0.97); }
          100% { transform: scale(1.0); }
        }
        * { -webkit-user-select: none; -webkit-touch-callout: none; }
      `}</style>

      <div style={{ padding: '8px 16px', textAlign: 'center', color: '#888', fontSize: 12, touchAction: 'none', userSelect: 'none', pointerEvents: 'none' }}>
        {playerName}
        {controllerMode !== 'normal' && (
          <span style={{ marginLeft: 8, color: '#c77dff', fontWeight: 'bold' }}>
            {controllerMode === 'party_box' ? 'PICK AN ITEM' : 'PLACE YOUR ITEM'}
          </span>
        )}
      </div>

      {/* Party Box Mode */}
      {controllerMode === 'party_box' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '0 16px' }}>
          {itemSelected ? (
            <div style={{ textAlign: 'center' }}>
              <p style={{ color: '#4ae04a', fontSize: 18, fontWeight: 'bold' }}>Item Selected!</p>
              <p style={{ color: '#888', fontSize: 14 }}>{partyBoxItems[highlightedItem]?.label}</p>
              <p style={{ color: '#666', fontSize: 12 }}>Waiting for other players...</p>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                {partyBoxItems.map((item, i) => {
                  const catColors: Record<string, string> = {
                    platform: '#4a9eff', trap: '#ff4444', launcher: '#ff8800',
                    zone: '#aa55ff', hazard: '#ff3366',
                  };
                  const catColor = catColors[item.category ?? ''] ?? '#888';
                  return (
                    <div key={i} onClick={() => { setHighlightedItem(i); }} style={{
                      padding: '10px 14px',
                      background: i === highlightedItem ? '#3a2a6a' : '#1a2240',
                      border: i === highlightedItem ? `2px solid ${catColor}` : '2px solid #2a3a5a',
                      borderRadius: 8,
                      color: i === highlightedItem ? '#fff' : '#888',
                      textAlign: 'center',
                      minWidth: 90,
                      transition: 'all 0.15s',
                    }}>
                      <div style={{ fontSize: 9, color: catColor, fontWeight: 'bold', marginBottom: 2 }}>
                        {(item.category ?? '').toUpperCase()}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 'bold' }}>{item.label}</div>
                      {item.desc && (
                        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2 }}>{item.desc}</div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <Joystick onChange={handleJoystickChange} />
                <JellyButton pressed={false} onPress={handleExpandPress} onRelease={handleExpandRelease} />
              </div>
              <p style={{ color: '#666', fontSize: 11 }}>Joystick to browse, button to select</p>
            </>
          )}
        </div>
      )}

      {/* Placement Mode */}
      {controllerMode === 'placement' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          {placementConfirmed ? (
            <div style={{ textAlign: 'center' }}>
              <p style={{ color: '#4ae04a', fontSize: 18, fontWeight: 'bold' }}>Placed!</p>
              <p style={{ color: '#666', fontSize: 12 }}>Waiting for other players...</p>
            </div>
          ) : (
            <>
              <p style={{ color: '#aaa', fontSize: 16 }}>Move cursor to place your item</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <Joystick onChange={handleJoystickChange} />
                <JellyButton pressed={false} onPress={handleExpandPress} onRelease={handleExpandRelease} />
              </div>
              <p style={{ color: '#666', fontSize: 11 }}>Joystick to move, button to confirm</p>
            </>
          )}
        </div>
      )}

      {/* Normal Mode — Split-screen touch zones */}
      {controllerMode === 'normal' && (
        <NormalModeZones
          onMove={(x, y) => { inputRef.current.moveX = x; inputRef.current.moveY = y; }}
          expanding={expanding}
          onExpandPress={handleExpandPress}
          onExpandRelease={handleExpandRelease}
        />
      )}
    </div>
  );
}

const fullCenter: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
};

const btnStyle: React.CSSProperties = {
  padding: '8px 16px',
  fontSize: 14,
  cursor: 'pointer',
};
