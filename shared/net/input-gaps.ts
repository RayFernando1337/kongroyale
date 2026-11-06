// The server's input-pacing report (KONG-78 F0): how often a live human's input queue ran dry, so that player froze on
// the server for a tick, and how big the catch-up bursts after it were (the warp everyone else sees). One shape for
// /health, netlab and bench:server. It counts through Match.inputProbe, so the client bundle, which runs Match
// offline, carries one call site and none of this.
import { INPUT_STARVE_TICKS, MAX_PLAYERS } from "../sim/const";
import type { Match } from "../sim/match";

/** what trackInputGaps reports: liveTicks = human ticks whose link was live (it has run an input, and its queue has been
 *  empty for at most INPUT_STARVE_TICKS); inputGapTicks = live ticks with an empty queue, as a share over every human
 *  and for the worst one; catchupBursts / catchupBurstMax = ticks that ran more than one queued input, and the most */
export interface InputGapReport { liveTicks: number; inputGapTicks: number; inputGapTicksPct: number; worstPlayerGapPct: number; catchupBursts: number; catchupBurstMax: number }

/** count input gaps on match `m` from now on; report() reads the totals so far */
export function trackInputGaps(m: Match): { report(): InputGapReport } {
  const live = new Int32Array(MAX_PLAYERS), gap = new Int32Array(MAX_PLAYERS), ran = new Uint8Array(MAX_PLAYERS);
  let liveTicks = 0, inputGapTicks = 0, catchupBursts = 0, catchupBurstMax = 0;
  m.inputProbe = (id, n, starve) => {
    if (n > 0) ran[id] = 1;
    if (n > 1) { catchupBursts++; if (n > catchupBurstMax) catchupBurstMax = n; }
    if (!ran[id] || starve > INPUT_STARVE_TICKS) return;
    liveTicks++; live[id]++;
    if (n === 0) { inputGapTicks++; gap[id]++; }
  };
  return {
    report() {
      let worstPlayerGapPct = 0;
      for (let id = 0; id < MAX_PLAYERS; id++) if (live[id] > 0) worstPlayerGapPct = Math.max(worstPlayerGapPct, (100 * gap[id]) / live[id]);
      return { liveTicks, inputGapTicks, inputGapTicksPct: liveTicks ? (100 * inputGapTicks) / liveTicks : 0, worstPlayerGapPct, catchupBursts, catchupBurstMax };
    },
  };
}
