import { Fragment, useEffect, useRef, useState } from "react";
import { getFrameProfile, type FrameSample } from "../game/gameLoop";
import { getNetSimConfig, setNetSimConfig, subscribeNetSim, type NetSimConfig } from "../lib/netSim";
import { getPacingConfig, setPacingConfig, subscribePacing, type PacingConfig } from "../lib/pacingConfig";
import type { CompareHashesResult } from "../lib/debugBridge";

// Overlay shown when the URL includes `?net=debug` (or after pressing
// backtick). Surfaces the metrics that distinguish "smooth lockstep"
// from "stutter": input-buffer depth, ticks-per-RAF distribution, gate
// stalls (real netcode jitter, not "RAF had no time accumulated"), and
// a rolling frame-time band. Refreshes ~4 Hz so the overlay's own
// render cost is negligible.
//
// `role` tailors the panel:
//   - 'guest' shows everything: telemetry, pacing controls, NetSim controls.
//   - 'host' shows host-only telemetry (no buffer/gap) and pacing.

const WINDOW_SAMPLES = 240; // ~4s at 60Hz
const SPARK_BUCKETS = 30;   // ~30s of 1s buckets
const SPARK_WIDTH = 180;
const SPARK_HEIGHT = 24;

interface NetDiag {
  bufferSize: number;
  latestHostTick: number;
  gap: number;
}

interface RollbackStats {
  rollbacksApplied: number;
  lastDepth: number;
  smoothingActive: number;
  ringInvalidations: number;
  failedRestores: number;
  avgReconcileMs?: number;
}

interface DebugBridgeShape {
  getNetDiag: () => NetDiag | null;
  getFrameProfile: () => FrameSample[];
  getTick: () => number;
  getRollbackStats: () => RollbackStats | null;
  /** Engine stateHash — FNV-1a over every particle pos+vel. Two clients
   *  with identical sim state at the same tick produce the same hash.
   *  THE definitive desync check: pause both tabs at the same tick
   *  number and compare. Match = sims agree (any visual difference is
   *  temporal offset only). Mismatch = real desync. */
  getStateHash: () => string | null;
  /** Cross-side compare (host only). Resolves null on guest tabs or
   *  before the host has finished wiring. */
  compareHashes: () => Promise<CompareHashesResult | null>;
  /** Sim-wide pause (host only). No-op on guests; their pause comes
   *  from the host's `set_paused` event. */
  togglePause: (paused: boolean) => void;
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

interface Snapshot {
  bufferSize: number;
  gap: number;
  tick: number;
  avgStepsPerFrame: number;
  gateStallsPct: number;
  burstFramesPct: number;
  p95FrameMs: number;
  p95LogicMs: number;
  /** Per-second stall counts, oldest first, len up to SPARK_BUCKETS. */
  stallSpark: number[];
  /** Cumulative rollbacks since session start. Shown on both host and
   *  guest (each has its own RollbackController). */
  rollbacks: number | null;
  /** Last rollback depth in ticks (0 if none). */
  lastRollbackDepth: number;
  /** engine.restoreState returned false this many times — smoking gun
   *  for "rollback fires but sims diverge anyway" because serializeState
   *  is missing required state. Any non-zero value is bad. */
  failedRestores: number;
  /** Snapshot ring invalidated this many times (e.g. blob count
   *  changed mid-session). High count = rollback effectively disabled. */
  ringInvalidations: number;
  /** Truncated stateHash (first 8 chars of hex). Compare host vs guest
   *  AT THE SAME tick number to test true sim agreement — visual
   *  differences at different wall-clock instants are normal temporal
   *  offset, NOT desync. */
  stateHash: string;
}

export default function NetDebugOverlay({ role = 'guest' }: { role?: 'guest' | 'host' }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  // Track per-tick arrival rate by sampling getTick over wall-clock time.
  const lastTickRef = useRef<{ tick: number; at: number } | null>(null);
  const tickRateRef = useRef<number>(0);

  // Spark buckets: count gate-stall RAFs in 1-second bins. Folded from
  // frame profile each refresh (we only need samples whose ts falls in
  // the current second window).
  const sparkRef = useRef<{ buckets: number[]; bucketStartMs: number }>({
    buckets: [],
    bucketStartMs: 0,
  });
  const seenTsRef = useRef<number>(0); // dedupe across refreshes

  useEffect(() => {
    const id = setInterval(() => {
      const bridge: DebugBridgeShape | undefined = (window as unknown as { __bbDebug?: DebugBridgeShape }).__bbDebug;
      if (!bridge) return;
      const diag: NetDiag | null = role === 'guest' ? bridge.getNetDiag() : null;
      const frames: FrameSample[] = bridge.getFrameProfile();
      const tick: number = bridge.getTick();

      const now = performance.now();
      const last = lastTickRef.current;
      if (last) {
        const dt = (now - last.at) / 1000;
        const dTicks = tick - last.tick;
        if (dt > 0.1) {
          tickRateRef.current = dTicks / dt;
          lastTickRef.current = { tick, at: now };
        }
      } else {
        lastTickRef.current = { tick, at: now };
      }

      const win: FrameSample[] = frames.slice(-WINDOW_SAMPLES);
      const steps: number[] = win.map((f: FrameSample) => f.logicSteps);
      const stepsAvg = steps.length ? steps.reduce((a: number, b: number) => a + b, 0) / steps.length : 0;
      const stalled = win.filter((f: FrameSample) => f.gated).length;
      const burst = steps.filter((s: number) => s >= 2).length;
      const frameMs: number[] = win.map((f: FrameSample) => f.frameMs);
      const logicMs: number[] = win.map((f: FrameSample) => f.logicMs);

      // ── Spark: fold new frame samples into 1-second buckets ─────────────
      const spark = sparkRef.current;
      if (spark.bucketStartMs === 0) spark.bucketStartMs = Math.floor(now / 1000) * 1000;
      // Advance buckets to "now" — push a 0 for each missed second.
      while (now - spark.bucketStartMs >= 1000) {
        spark.buckets.push(0);
        spark.bucketStartMs += 1000;
        if (spark.buckets.length > SPARK_BUCKETS) spark.buckets.shift();
      }
      if (spark.buckets.length === 0) spark.buckets.push(0);
      const lastSeen = seenTsRef.current;
      let maxTs = lastSeen;
      for (const f of frames) {
        if (f.ts <= lastSeen) continue;
        if (f.ts > maxTs) maxTs = f.ts;
        if (!f.gated) continue;
        // Add to the bucket the frame fell in (last bucket = current second).
        spark.buckets[spark.buckets.length - 1] += 1;
      }
      seenTsRef.current = maxTs;

      // Both host and guest have a RollbackController now (host's is for
      // late-input recovery, guest's for predict-on-stall). Show stats
      // for whichever role is running.
      const rb = bridge.getRollbackStats();
      setSnapshot({
        bufferSize: diag?.bufferSize ?? 0,
        gap: diag?.gap ?? 0,
        tick,
        avgStepsPerFrame: stepsAvg,
        gateStallsPct: win.length ? (stalled / win.length) * 100 : 0,
        burstFramesPct: win.length ? (burst / win.length) * 100 : 0,
        p95FrameMs: pct(frameMs, 0.95),
        p95LogicMs: pct(logicMs, 0.95),
        stallSpark: spark.buckets.slice(),
        rollbacks: rb?.rollbacksApplied ?? null,
        lastRollbackDepth: rb?.lastDepth ?? 0,
        failedRestores: rb?.failedRestores ?? 0,
        ringInvalidations: rb?.ringInvalidations ?? 0,
        stateHash: (bridge.getStateHash() ?? '').slice(0, 12),
      });
    }, 250);
    return () => clearInterval(id);
  }, [role]);

  if (!snapshot) {
    return <div style={overlayStyle}>net=debug: warming up…</div>;
  }

  const stallColor = snapshot.gateStallsPct < 1 ? '#7f7' : snapshot.gateStallsPct < 5 ? '#fa3' : '#f77';
  const burstColor = snapshot.burstFramesPct < 5 ? '#7f7' : '#fa3';
  const gapColor = snapshot.gap === 0 ? '#f77' : snapshot.gap > 8 ? '#fa3' : '#7f7';

  return (
    <div style={overlayStyle} data-testid="net-debug-overlay">
      <div style={titleStyle}>NET DEBUG · {role}</div>
      <Row label="tick" value={String(snapshot.tick)} />
      {role === 'guest' && (
        <>
          <Row label="buffer depth (gap)" value={String(snapshot.gap)} color={gapColor} />
          <Row label="buffered ticks" value={String(snapshot.bufferSize)} />
        </>
      )}
      <Row label="steps/RAF (avg)" value={snapshot.avgStepsPerFrame.toFixed(2)} />
      {role === 'guest' && (
        <Row label="gate stalls" value={snapshot.gateStallsPct.toFixed(1) + '%'} color={stallColor} />
      )}
      <Row label="bursts (frames %)" value={snapshot.burstFramesPct.toFixed(1) + '%'} color={burstColor} />
      <Row label="p95 frame ms" value={snapshot.p95FrameMs.toFixed(1)} />
      <Row label="p95 logic ms" value={snapshot.p95LogicMs.toFixed(1)} />
      <Row label="tick rate (Hz)" value={tickRateRef.current.toFixed(1)} />
      <Row label="stateHash @tick" value={`${snapshot.stateHash} @${snapshot.tick}`} />
      {snapshot.rollbacks !== null && (
        <>
          <Row label="rollbacks" value={String(snapshot.rollbacks)} color={snapshot.rollbacks > 5 ? '#fa3' : '#7f7'} />
          <Row label="last rollback (ticks)" value={String(snapshot.lastRollbackDepth)} />
          <Row
            label="failed restores"
            value={String(snapshot.failedRestores)}
            color={snapshot.failedRestores === 0 ? '#7f7' : '#f55'}
          />
          <Row
            label="ring invalidations"
            value={String(snapshot.ringInvalidations)}
            color={snapshot.ringInvalidations < 3 ? '#7f7' : '#fa3'}
          />
        </>
      )}
      {role === 'guest' && <StallSpark data={snapshot.stallSpark} />}
      <PacingControls />
      {role === 'guest' && <NetSimControls />}
      {role === 'host' && <CompareHashesPanel />}
    </div>
  );
}

// ─── Compare-hashes diagnostic (host only) ──────────────────────────────────
// Two buttons + a modal:
//   - Pause/Resume: toggles sim-paused on both sides (host broadcasts
//     to all guests).
//   - Compare: broadcasts request_hashes, waits 600ms, opens a modal
//     showing every recorded tick from host + every guest, with cells
//     coloured green if all peers agree at that tick or red otherwise.
//
// Pause both sides BEFORE pressing compare for the cleanest snapshot —
// otherwise the rings keep churning while the host's request is in
// flight and the latest few rows may have partial coverage.

function CompareHashesPanel() {
  const [paused, setPaused] = useState<boolean>(() => getPacingConfig().paused);
  useEffect(() => subscribePacing((c) => setPaused(c.paused)), []);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CompareHashesResult | null>(null);
  void result; // referenced below in {result && <CompareModal />}

  const onTogglePause = () => {
    const bridge: DebugBridgeShape | undefined = (window as unknown as { __bbDebug?: DebugBridgeShape }).__bbDebug;
    if (!bridge) {
      console.warn('[netDebug] __bbDebug bridge not installed');
      return;
    }
    bridge.togglePause(!paused);
  };
  const onCompare = async () => {
    const bridge: DebugBridgeShape | undefined = (window as unknown as { __bbDebug?: DebugBridgeShape }).__bbDebug;
    if (!bridge) {
      console.warn('[netDebug] __bbDebug bridge not installed');
      return;
    }
    setBusy(true);
    try {
      const r = await bridge.compareHashes();
      if (!r) console.warn('[netDebug] compareHashes returned null — host accessor not wired yet?');
      setResult(r);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={controlsStyle} onMouseDown={(e) => e.stopPropagation()}>
      <div style={controlsTitleStyle}>COMPARE</div>
      <div style={presetRowStyle}>
        <PresetButton label={paused ? 'resume' : 'pause both'} onClick={onTogglePause} />
        <PresetButton label={busy ? 'comparing…' : 'compare hashes'} onClick={busy ? () => {} : onCompare} />
      </div>
      {result && <CompareModal result={result} onClose={() => setResult(null)} />}
    </div>
  );
}

function CompareModal({ result, onClose }: { result: CompareHashesResult; onClose: () => void }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (tick: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tick)) next.delete(tick); else next.add(tick);
      return next;
    });
  };
  return (
    <div style={modalBackdropStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>Per-tick state hashes ({result.byTick.length} ticks · {result.peerIds.length} peers)</strong>
          <button onClick={onClose} style={presetButtonStyle}>close</button>
        </div>
        <div style={{ fontSize: 10, color: '#aaa', marginBottom: 6 }}>
          Click any row to expand a per-blob field diff. Red cells = peers disagree on that field at that tick.
        </div>
        {result.peerIds.length < 2 && (
          <div style={{ fontSize: 11, color: '#fa3', marginBottom: 8, padding: 6, background: '#3a2c1c', borderRadius: 4 }}>
            ⚠ Only one peer responded ({result.peerIds.join(', ')}). No guest is currently connected (or guest didn't reply within 5s). Cells show neutral — there's nothing to compare against.
          </div>
        )}
        <div style={{ overflow: 'auto', maxHeight: '70vh' }}>
          <table style={{ borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr>
                <th style={thStyle}>tick</th>
                {result.peerIds.map((pid) => (
                  <th key={pid} style={thStyle}>{pid.slice(0, 18)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.byTick.map(({ tick, hashes }) => {
                // Row coloring rules:
                //   - Only one peer has a hash for this tick → NEUTRAL
                //     (gray). No comparison possible. Avoids the false
                //     "red" cells the user sees when only the host
                //     responds.
                //   - Two+ peers, all hashes match → GREEN.
                //   - Two+ peers, any mismatch → RED.
                const nonNullHashes = result.peerIds.map((p) => hashes[p]?.hash).filter((h): h is string => !!h);
                const hasComparison = nonNullHashes.length >= 2;
                const allAgree = hasComparison && nonNullHashes.every((h) => h === nonNullHashes[0]);
                const cellColor = (h: string | null | undefined): string => {
                  if (h == null) return '#333';
                  if (!hasComparison) return '#2a2a2a';  // neutral: only one peer
                  return allAgree ? '#2c4d2c' : '#5d2c2c';
                };
                const isOpen = expanded.has(tick);
                return (
                  <Fragment key={tick}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => toggle(tick)}>
                      <td style={tdStyle}>{isOpen ? '▼' : '▶'} {tick}</td>
                      {result.peerIds.map((pid) => {
                        const h = hashes[pid]?.hash;
                        return (
                          <td key={pid} style={{ ...tdStyle, background: cellColor(h) }}>
                            {h ? h.slice(0, 12) : '—'}
                          </td>
                        );
                      })}
                    </tr>
                    {isOpen && <ExpandedDiffRow tick={tick} hashes={hashes} peerIds={result.peerIds} />}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** A second tbody row spanning all columns that renders a per-field
 *  diff of the structured TickSummary for the selected tick. Each
 *  scalar field becomes its own row; per-blob fields fan out by
 *  blob label. Cells are green when peers agree on that field,
 *  red when they disagree. */
function ExpandedDiffRow({
  tick, hashes, peerIds,
}: {
  tick: number;
  hashes: Record<string, { hash: string | null; summary?: import('../lib/hashHistory').TickSummary }>;
  peerIds: string[];
}) {
  // Build the union of all field rows across peers.
  type Row = { label: string; values: Array<string | null> };
  const rows: Row[] = [];

  const summaries = peerIds.map((pid) => hashes[pid]?.summary);
  const haveAny = summaries.some(Boolean);
  if (!haveAny) {
    return (
      <tr>
        <td colSpan={peerIds.length + 1} style={{ ...tdStyle, color: '#888', fontStyle: 'italic' }}>
          No structured summary recorded for tick {tick} (older entry — record more ticks and try again).
        </td>
      </tr>
    );
  }

  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : String(n));

  // Scalar globals
  rows.push({ label: 'rng',       values: summaries.map((s) => s ? String(s.rng) : null) });
  rows.push({ label: 'modePhase', values: summaries.map((s) => s ? s.modePhase : null) });
  rows.push({ label: 'modeTimer', values: summaries.map((s) => s ? fmt(s.modePhaseTimer) : null) });

  // Per-blob fields: union of blob labels across peers (preserve order).
  const blobLabels: string[] = [];
  const seen = new Set<string>();
  for (const s of summaries) {
    if (!s) continue;
    for (const b of s.blobs) if (!seen.has(b.label)) { seen.add(b.label); blobLabels.push(b.label); }
  }
  for (const label of blobLabels) {
    for (const field of ['cx', 'cy', 'vx', 'vy', 'expandScale'] as const) {
      rows.push({
        label: `${label}.${field}`,
        values: summaries.map((s) => {
          if (!s) return null;
          const b = s.blobs.find((x) => x.label === label);
          return b ? fmt(b[field]) : null;
        }),
      });
    }
  }

  return (
    <>
      {rows.map((row) => {
        const nonNull = row.values.filter((v): v is string => v != null);
        const agree = nonNull.length >= 2 && nonNull.every((v) => v === nonNull[0]);
        return (
          <tr key={row.label} style={{ background: '#0f0f0f' }}>
            <td style={{ ...tdStyle, paddingLeft: 24, color: '#aaa' }}>↳ {row.label}</td>
            {row.values.map((v, i) => {
              const bg = v == null ? '#333' : agree ? '#1c2c1c' : '#3c1c1c';
              return (
                <td key={i} style={{ ...tdStyle, background: bg, color: agree ? '#aaa' : '#fbb' }}>
                  {v ?? '—'}
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}

const modalBackdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
};
const modalStyle: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #555',
  borderRadius: 6,
  padding: 12,
  font: '11px/1.4 ui-monospace, Menlo, monospace',
  color: '#eee',
  maxWidth: '90vw',
  maxHeight: '90vh',
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '4px 8px',
  borderBottom: '1px solid #444',
  position: 'sticky',
  top: 0,
  background: '#1a1a1a',
};
const tdStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderBottom: '1px solid #2a2a2a',
};

// ─── Stall sparkline ────────────────────────────────────────────────────────
// 30 seconds of "gate stalls per second." Lets you eyeball whether stalls
// are bursty (network hiccup), periodic (keyframe HOL blocking), or just
// random background jitter. Heights normalize against the window's max so
// even small persistent stalls are visible.

function StallSpark({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const w = SPARK_WIDTH / SPARK_BUCKETS;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#aaa' }}>
        <span>stalls/sec (30s)</span>
        <span style={{ color: '#fff', fontVariantNumeric: 'tabular-nums' }}>max={max}</span>
      </div>
      <svg width={SPARK_WIDTH} height={SPARK_HEIGHT} style={{ display: 'block', background: 'rgba(255,255,255,0.04)' }}>
        {data.map((v, i) => {
          const h = (v / max) * SPARK_HEIGHT;
          const color = v === 0 ? '#3a3' : v < max * 0.3 ? '#fa3' : '#f55';
          return (
            <rect
              key={i}
              x={i * w}
              y={SPARK_HEIGHT - h}
              width={Math.max(1, w - 1)}
              height={h}
              fill={color}
            />
          );
        })}
      </svg>
    </div>
  );
}

// ─── Pacing controls ────────────────────────────────────────────────────────
// Live inputDelay (host) + bufferTarget (guest) + redundancy toggle (host).
// Mutations flow through the singleton, so the next tick (host) / next
// RAF (guest) picks them up. Sliders are deliberately wide-range so you
// can see the breakdown at the extremes.

function PacingControls() {
  const [cfg, setCfg] = useState<PacingConfig>(getPacingConfig());
  useEffect(() => subscribePacing(setCfg), []);
  const update = (patch: Partial<PacingConfig>) => setPacingConfig(patch);
  return (
    <div style={controlsStyle} onMouseDown={(e) => e.stopPropagation()}>
      <div style={controlsTitleStyle}>PACING</div>
      <Slider
        label="inputDelay (host)"
        value={cfg.inputDelayTicks}
        min={0}
        max={10}
        step={1}
        suffix="t"
        onChange={(v) => update({ inputDelayTicks: v })}
      />
      <Slider
        label="bufferTarget (guest)"
        value={cfg.bufferTarget}
        min={0}
        max={10}
        step={1}
        suffix="t"
        onChange={(v) => update({ bufferTarget: v })}
      />
      <Slider
        label="keyframe (host)"
        value={cfg.keyframeIntervalTicks}
        min={0}
        max={1800}
        step={30}
        suffix={cfg.keyframeIntervalTicks === 0 ? ' off' : 't'}
        onChange={(v) => update({ keyframeIntervalTicks: v })}
      />
      <Slider
        label="stallPredict (guest)"
        value={cfg.stallPredictThreshold}
        min={1}
        max={30}
        step={1}
        suffix="t"
        onChange={(v) => update({ stallPredictThreshold: v })}
      />
      <label style={toggleRowStyle}>
        <input
          type="checkbox"
          checked={cfg.clientPrediction}
          onChange={(e) => update({ clientPrediction: e.target.checked })}
        />
        <span style={{ marginLeft: 6 }}>client prediction (guest own player)</span>
      </label>
    </div>
  );
}

// ─── Network simulator controls ────────────────────────────────────────────
// Live sliders for the per-message latency / jitter / drop layer wired into
// the guest's send + receive paths. Editing here updates the singleton in
// real time; no remount, no reconnect. The "enabled" toggle is the master
// switch — when off, sends + receives run synchronously with zero overhead,
// matching the previous (no-sim) behavior exactly.

function NetSimControls() {
  const [cfg, setCfg] = useState<NetSimConfig>(getNetSimConfig());
  useEffect(() => subscribeNetSim(setCfg), []);
  const update = (patch: Partial<NetSimConfig>) => setNetSimConfig(patch);
  return (
    <div style={controlsStyle} onMouseDown={(e) => e.stopPropagation()}>
      <div style={controlsTitleStyle}>NET SIM</div>
      <label style={toggleRowStyle}>
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <span style={{ marginLeft: 6 }}>enabled</span>
      </label>
      <Slider
        label="latency"
        value={cfg.latencyMs}
        min={0}
        max={500}
        step={5}
        suffix="ms"
        onChange={(v) => update({ latencyMs: v })}
      />
      <Slider
        label="jitter"
        value={cfg.jitterMs}
        min={0}
        max={200}
        step={5}
        suffix="ms"
        onChange={(v) => update({ jitterMs: v })}
      />
      <Slider
        label="drop"
        value={cfg.dropPct}
        min={0}
        max={50}
        step={1}
        suffix="%"
        onChange={(v) => update({ dropPct: v })}
      />
      <div style={presetRowStyle}>
        <PresetButton label="off" onClick={() => update({ enabled: false, latencyMs: 0, jitterMs: 0, dropPct: 0 })} />
        <PresetButton label="LAN" onClick={() => update({ enabled: true, latencyMs: 20, jitterMs: 5, dropPct: 0 })} />
        <PresetButton label="wifi" onClick={() => update({ enabled: true, latencyMs: 60, jitterMs: 20, dropPct: 1 })} />
        <PresetButton label="bad" onClick={() => update({ enabled: true, latencyMs: 150, jitterMs: 60, dropPct: 4 })} />
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step, suffix, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  suffix: string; onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#aaa' }}>
        <span>{label}</span>
        <span style={{ color: '#fff', fontVariantNumeric: 'tabular-nums' }}>{value}{suffix}</span>
      </div>
      <input
        className="bb-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', '--range-fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
      />
    </div>
  );
}

function PresetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={presetButtonStyle}>{label}</button>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: '#aaa' }}>{label}</span>
      <span style={{ color: color ?? '#fff', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  zIndex: 10,
  padding: '8px 10px',
  background: 'rgba(0, 0, 0, 0.78)',
  color: '#fff',
  font: '11px/1.5 ui-monospace, Menlo, monospace',
  borderRadius: 4,
  minWidth: 240,
  maxHeight: 'calc(100vh - 16px)',
  overflowY: 'auto',
  pointerEvents: 'auto',
};

const titleStyle: React.CSSProperties = {
  fontWeight: 700,
  marginBottom: 4,
  color: '#fff',
  borderBottom: '1px solid #444',
  paddingBottom: 2,
};

const controlsStyle: React.CSSProperties = {
  marginTop: 8,
  paddingTop: 6,
  borderTop: '1px solid #444',
};

const controlsTitleStyle: React.CSSProperties = {
  fontWeight: 700,
  marginBottom: 2,
};

const toggleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  cursor: 'pointer',
  userSelect: 'none',
  marginTop: 4,
};

const presetRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  marginTop: 6,
};

const presetButtonStyle: React.CSSProperties = {
  flex: 1,
  background: '#222',
  border: '1px solid #555',
  color: '#fff',
  font: 'inherit',
  fontSize: 10,
  padding: '2px 4px',
  borderRadius: 3,
  cursor: 'pointer',
};
