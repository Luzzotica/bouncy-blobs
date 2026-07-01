// Adapts the live BouncyBlobsGame to the headless SimDriver interface that
// NetPeer drives, so the real game runs the SAME proven symmetric rollback core
// exercised by netcodeConvergence.test.ts.
//
// The one subtlety: stepOne must NOT re-derive AI (runAI:false) — bot inputs are
// gathered by the session BEFORE advancing and scheduled like any player's input
// — and must NOT fire the host broadcast hook (runPreTick:false), since the
// session sends tagged inputs itself.

import type { BouncyBlobsGame } from '../bouncyBlobsGame';
import type { SimDriver, InputSet } from '../../lib/netcode/netPeer';
import { FIXED_DT } from '../gameLoop';
import { recordHash } from '../../lib/hashHistory';

export function makeBouncyBlobsSimDriver(
  game: BouncyBlobsGame,
  /** Optional per-instance hash sink. The global hash ring is a singleton (no
   *  good for multi-instance harnesses), so callers that run several sims in one
   *  process pass this to capture THIS sim's per-tick hash separately. */
  onHash?: (tick: number, hash: string) => void,
): SimDriver {
  const engineFor = () => {
    const w = game.getWorld();
    if (!w) throw new Error('makeBouncyBlobsSimDriver: world not ready');
    return w;
  };
  return {
    get engine() { return engineFor(); },
    playerIds: () => game.getPlayerManager()?.getAllPlayers().map((p) => p.playerId) ?? [],
    applyInputs: (set: InputSet) => {
      const pm = game.getPlayerManager();
      if (!pm) return;
      for (const [pid, inp] of Object.entries(set)) {
        const mp = pm.getPlayer(pid);
        if (!mp) continue;
        mp.moveX = inp.moveX; mp.moveY = inp.moveY; mp.expanding = inp.expanding;
      }
    },
    stepOne: () => {
      game.stepOneTick(FIXED_DT, { runPreTick: false, runAI: false });
      // Record the hash on EVERY step — including rollback replays, which run
      // outside onLogic — so the per-tick hash ring (the cross-tab determinism
      // diagnostic) reflects the latest POST-rollback state, not a stale
      // prediction. Keyed by tick, so later corrections overwrite earlier ones.
      const w = game.getWorld();
      if (w) {
        const h = w.stateHash();
        recordHash(w.tick, h);
        onHash?.(w.tick, h);
      }
    },
    snapshotGameState: () => game.snapshotGameState(),
    restoreGameState: (snap) => game.restoreGameState(snap as ReturnType<BouncyBlobsGame['snapshotGameState']>),
  };
}
