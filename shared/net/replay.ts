// Replay logs for a Match (off by default: a match records only when a tool or host sets match.rec). A log holds the
// match options and every call from outside that changes how the match plays: human inputs as pushed, inventory ops,
// seats changing hands, START NOW, and each answer the warm-up hold gave. Each entry is stamped with the tick it came at.
// replayMatch re-issues them at the same ticks on a fresh Match, which plays the match again bit for bit on the same JS
// engine. Bots need no log: they follow from the seed and the state. The wire format (proto.ts) is not involved.
import { Match, type MatchOpts } from "../sim/match";
import { makeInput, type Input } from "../sim/player";
import type { StaticWorld } from "../sim/world";

export const enum RE { Input = 1, Inv = 2, Claim = 3, Release = 4, Reclaim = 5, StartNow = 6, Hold = 7 }
/** [tick, RE, ...arguments]: Input [id, seq, mx, mz, yaw, pitch, buttons, slot, lerpA, lerpSpan, lerpF], Inv [pid, op, a, b],
 * Claim [name, team], Release [id], Reclaim [id, name], StartNow [], Hold [held 0 / 1] */
export type ReplayEvent = Array<number | string>;
export type ReplayOpts = Omit<MatchOpts, "world">;
export interface ReplayLog { version: 1; opts: ReplayOpts; warmupS: number; endAfterResults: boolean; ticks: number; events: ReplayEvent[] }

export class ReplayRecorder {
  readonly events: ReplayEvent[] = [];
  constructor(readonly opts: ReplayOpts) {}
  input(tick: number, id: number, i: Input) { this.events.push([tick, RE.Input, id, i.seq, i.mx, i.mz, i.yaw, i.pitch, i.buttons, i.slot, i.lerpA, i.lerpSpan, i.lerpF]); }
  inv(tick: number, pid: number, op: number, a: number, b: number) { this.events.push([tick, RE.Inv, pid, op, a, b]); }
  claim(tick: number, name: string, team: number) { this.events.push([tick, RE.Claim, name, team]); }
  release(tick: number, id: number) { this.events.push([tick, RE.Release, id]); }
  reclaim(tick: number, id: number, name: string) { this.events.push([tick, RE.Reclaim, id, name]); }
  startNow(tick: number) { this.events.push([tick, RE.StartNow]); }
  hold(tick: number, held: boolean) { this.events.push([tick, RE.Hold, held ? 1 : 0]); }
  /** a copy of the log so far: the match at its current tick, outside calls made since its last step included */
  log(m: Match): ReplayLog {
    return { version: 1, opts: this.opts, warmupS: m.warmupS, endAfterResults: m.endAfterResults, ticks: m.tick, events: this.events.slice() };
  }
}

/** play a log again on a fresh Match and return it at the log's last tick, with the calls made after that tick's step
 * applied (as when the log was taken). onTick sees each tick's events before they
 * are cleared. Throws where the replay stops matching the
 * log (a warm-up hold asked for at another tick), which means the sim or the log changed. */
export function replayMatch(log: ReplayLog, world: StaticWorld, onTick?: (m: Match) => void): Match {
  if (log.version !== 1) throw new Error(`replay log version ${log.version}, this build reads version 1`);
  const m = new Match({ ...log.opts, world });
  m.warmupS = log.warmupS; m.endAfterResults = log.endAfterResults;
  const ev = log.events, inp = makeInput(), n = (e: ReplayEvent, k: number) => e[k] as number;
  let k = 0;
  m.holdWarmup = () => {
    const e = ev[k];
    if (!e || e[1] !== RE.Hold || e[0] !== m.tick) throw new Error(`replay diverged at tick ${m.tick}: the warm-up hold was asked, the log has ${e ? JSON.stringify(e) : "nothing"} next`);
    k++;
    return e[2] === 1;
  };
  const playCalls = () => {
    for (; k < ev.length && ev[k][0] === m.tick && ev[k][1] !== RE.Hold; k++) {
      const e = ev[k];
      switch (e[1]) {
        case RE.Input:
          inp.seq = n(e, 3); inp.mx = n(e, 4); inp.mz = n(e, 5); inp.yaw = n(e, 6); inp.pitch = n(e, 7); inp.buttons = n(e, 8); inp.slot = n(e, 9); inp.lerpA = n(e, 10); inp.lerpSpan = n(e, 11); inp.lerpF = n(e, 12);
          m.pushInput(n(e, 2), inp); break;
        case RE.Inv: m.inventoryOp(n(e, 2), n(e, 3), n(e, 4), n(e, 5)); break;
        case RE.Claim: m.claimBot(e[2] as string, n(e, 3)); break;
        case RE.Release: m.releaseHuman(n(e, 2)); break;
        case RE.Reclaim: m.reclaimHuman(n(e, 2), e[3] as string); break;
        case RE.StartNow: m.startNow(); break;
        default: throw new Error(`replay log: unknown event ${JSON.stringify(e)}`);
      }
    }
  };
  while (m.tick < log.ticks) {
    playCalls();
    if (k < ev.length && (ev[k][0] as number) < m.tick) throw new Error(`replay diverged at tick ${m.tick}: ${JSON.stringify(ev[k])} was not played`);
    m.step();
    onTick?.(m);
    m.ev.reset();
  }
  playCalls();
  if (k !== ev.length) throw new Error(`replay ended at tick ${m.tick} with ${ev.length - k} log events not played`);
  return m;
}
