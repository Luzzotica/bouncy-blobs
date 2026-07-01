// Shared rollback driver — the one place host AND guest get their per-tick
// prediction + reconciliation + display-smoothing logic, so the two pages
// "differ only in how they handle incoming netcode" (the GameSession/NetAdapter
// split owns the I/O; this owns the sim-side rollback machinery).
//
// It wraps the existing, well-tested primitives:
//   - RollbackController  — predict inputs, snapshot ring, restore+replay.
//   - DisplaySmoother     — post-rollback visual offset that decays so a
//                           correction eases in instead of snapping.
//
// The "Overwatch gate" (logicGate) is the unified advance rule both sides use:
// predict the upcoming tick's input set (real authoritative where we have it,
// each remote player's last-known otherwise), apply it, record it, and step —
// UNLESS we'd speculate more than MAX_PREDICT ticks past the last tick we have
// authoritative data for, in which case we hold (return false) so the sim can't
// run away from the network.
//
// applyInputs and stepOne are standardized here (write ManagedPlayer; drive
// bouncyBlobsGame.stepOneTick) so the pages no longer hand-roll them. Only
// readLocalInput stays page-supplied — it reads that page's local input source
// (keyboard / gamepad refs).

import type { SoftBodyEngine } from '../../physics/SoftBodyEngine';
import type { BouncyBlobsGame } from '../bouncyBlobsGame';
import { recordHash } from '../../lib/hashHistory';
import { RollbackController, type InputSet, type PlayerInput } from './RollbackController';
import { DisplaySmoother } from './displaySmoothing';

export type { InputSet, PlayerInput } from './RollbackController';

/** Hard cap on speculation: never advance more than this many ticks past the
 *  last tick we have authoritative inputs for. Bounds worst-case replay depth
 *  and stops a brief input-channel hiccup from racing the sim seconds ahead.
 *  Matches the plan's "rollback ≤ 7 frames". */
export const MAX_PREDICT = 7;

export interface RollbackDriverOpts {
  game: BouncyBlobsGame;
  /** Player id whose input is read live from the local input source. */
  localPlayerId: string;
  /** Read the local player's input NOW (keyboard/gamepad). Should return the
   *  QUANTIZED value (quantizeAxis) so the local sim uses the exact value that
   *  goes on the wire — see the determinism rule in inputProtocol.ts. */
  readLocalInput: () => PlayerInput;
  /** True on the host. Reserved for host-specific reconcile policy (the host
   *  reconciles against incoming guest inputs; guests against streamed state). */
  isHost: boolean;
  /** Highest tick we have authoritative input/state for. Drives the
   *  speculation cap. Return 0 when nothing is confirmed yet. */
  getConfirmedTick: () => number;
  /** When the local player's own input should NOT be overwritten by an
   *  incoming authoritative set (client-prediction lane). Defaults to false —
   *  apply every player's authoritative input, including local. */
  skipLocalOnApply?: () => boolean;
}

export class RollbackDriver {
  readonly rc: RollbackController;
  readonly smoother: DisplaySmoother;
  private readonly game: BouncyBlobsGame;
  private readonly localPlayerId: string;
  private readonly getConfirmedTick: () => number;
  private readonly skipLocalOnApply: () => boolean;

  constructor(opts: RollbackDriverOpts) {
    this.game = opts.game;
    this.localPlayerId = opts.localPlayerId;
    this.getConfirmedTick = opts.getConfirmedTick;
    this.skipLocalOnApply = opts.skipLocalOnApply ?? (() => false);

    this.rc = new RollbackController({
      localPlayerId: opts.localPlayerId,
      readLocalInput: opts.readLocalInput,
      applyInputs: (inputs) => this.applyInputs(inputs),
      stepOne: () => this.stepOne(),
    });
    this.smoother = new DisplaySmoother();
  }

  /** Write an InputSet onto the live PlayerManager. Standardized so callers
   *  (and replay) share one path. Honors skipLocalOnApply for the
   *  client-prediction lane. */
  private applyInputs(inputs: InputSet): void {
    const pm = this.game.getPlayerManager();
    if (!pm) return;
    const skipLocal = this.skipLocalOnApply();
    for (const [pid, inp] of Object.entries(inputs)) {
      if (skipLocal && pid === this.localPlayerId) continue;
      const mp = pm.getPlayer(pid);
      if (!mp) continue;
      mp.moveX = inp.moveX;
      mp.moveY = inp.moveY;
      mp.expanding = inp.expanding;
    }
  }

  /** Replay one tick through the SAME code path as the live loop. Bot inputs
   *  come from the controller's re-applied set (runAI:false) and no broadcast
   *  fires (runPreTick:false). Keeps the hash ring consistent for the
   *  cross-tab determinism diagnostic. */
  private stepOne(): void {
    const st = this.game.getSimState();
    if (!st) return;
    const dt = 1 / 60;
    this.game.stepOneTick(dt, { runPreTick: false, runAI: false });
    st.gameTime += dt;
    recordHash(st.world.tick, st.world.stateHash());
  }

  /** Unified Overwatch advance gate. Returns true to step this tick, false to
   *  hold (sim paused) when we'd speculate past the cap. Install via
   *  game.setLogicGate. */
  logicGate = (world: SoftBodyEngine): boolean => {
    const nextTick = world.tick + 1;
    const confirmed = this.getConfirmedTick();
    if (confirmed > 0 && nextTick > confirmed + MAX_PREDICT) {
      return false;
    }
    const inputs = this.rc.predictInputs();
    if (this.skipLocalOnApply()) delete inputs[this.localPlayerId];
    this.applyInputs(inputs);
    // world.tick === completed steps; the step about to run produces nextTick.
    this.rc.recordTick(nextTick, inputs, world, this.game);
    return true;
  };

  /** Authoritative remote inputs arrived for one or more past ticks. Reconcile
   *  (restore+replay on the earliest mismatch) and capture/apply the display
   *  offset so any correction eases in. Returns ticks rewound (0 if none). */
  onRemoteInputs(byTick: Map<number, InputSet>): number {
    const engine = this.game.getWorld();
    if (!engine) return 0;
    const pre = this.smoother.capturePreRollback(this.game);
    const rolled = this.rc.onAuthoritativeInputs(byTick, engine, this.game);
    if (rolled > 0) this.smoother.applyPostRollback(this.game, pre);
    return rolled;
  }

  /** Feed an authoritative input set into the controller's last-known map
   *  WITHOUT triggering a reconcile (used to seed predictions for ticks we
   *  haven't simulated yet). */
  noteAuthoritative(byTick: Map<number, InputSet>): void {
    // onAuthoritativeInputs already updates lastKnownInput; for ticks strictly
    // in the future (no history yet) it's a no-op rewind, which is fine.
    this.onRemoteInputs(byTick);
  }

  /** Decay the display-smoothing offsets one render frame. Call once per
   *  onRender. */
  tickSmoothing(): void {
    this.smoother.tick();
  }

  /** Per-node display offsets for a blob (post-rollback ease-in), or null. */
  getRenderNodeOffsets(blobId: number): { x: number; y: number }[] | null {
    return this.smoother.getNodeOffsets(blobId);
  }
}
