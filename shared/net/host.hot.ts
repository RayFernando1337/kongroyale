import type { Match } from "../sim/match";
import { PS, alive } from "../sim/player";
import { BULLET_RANGE, SNAP_EVERY } from "../sim/const";
import { Writer, writePlayer, writeSelf, writeSnapHeader, writeVehicle } from "./proto";
import { VF, VS } from "../sim/vehicle";
import type { SnapshotBatch } from "./host";

const head = { tick: 0, time: 0, phase: 0, alive: 0, squads: 0, flags: 0, lastSeq: 0, count: 0 };
/** players nearer than this to the viewer ride every snapshot; farther ones (never hittable: BULLET_RANGE 320) 1 in 3 */
export const NEAR_R = 380;
/** players this close carry exact hp/shield (anyone the recipient could shoot this snapshot interval) */
const HP_R = BULLET_RANGE + 40;
/** one snapshot for player `pid`: header, the recipient's exact state (SelfState), then remote entries (interest-managed) */
export function writeSnapshotFor(w: Writer, m: Match, pid: number, batch?: SnapshotBatch): Writer {
  const me = m.players[pid];
  w.reset();
  const far = (m.tick / SNAP_EVERY) % 3;
  head.tick = m.tick; head.time = m.time; head.phase = m.phase; head.alive = batch ? batch.alive : m.aliveCount(); head.squads = batch ? batch.squads : m.squadsLeft(); head.flags = batch ? batch.flags : m.headerFlags(); head.lastSeq = me.lastSeq; head.count = 0;
  writeSnapHeader(w, head);
  const countPos = w.o - 1; let count = 0;
  writeSelf(w, me, me.st === PS.Ride ? m.vehs.list[me.veh] ?? null : null);
  const view = (me.st === PS.Dead && me.spectate >= 0) ? (m.players[me.spectate] ?? me) : me;
  const now = m.phase === 0 ? m.phaseT : m.time;
  for (const p of m.players) {
    if (p === me) continue;
    // (a body still falling — killed high in the air — keeps being sent until it lands, ≤ 12 s)
    if (!alive(p) && !(p.st === PS.Dead && (now - p.deadAt < 4 || (!p.grounded && now - p.deadAt < 12)))) continue;
    const mate = p.team === me.team;
    if (p.st === PS.Plane && !mate) continue;            // enemies riding the plane are never drawn
    const dx = p.x - view.x, dz = p.z - view.z, d2 = dx * dx + dz * dz;
    const near = d2 < NEAR_R * NEAR_R || p.st === PS.Freefall || p.st === PS.Glide || mate;
    if (!near && (p.id % 3) !== far) continue;
    // firing range: every target carries its exact health + shield (the range draws their bars)
    if (batch) batch.player(w, p, mate || p === view || m.range, d2 < HP_R * HP_R);
    else writePlayer(w, p, mate || p === view || m.range, d2 < HP_R * HP_R);
    if (++count >= 255) break;
  }
  w.dv.setUint8(countPos, count);
  // tuk-tuks: the one you ride and every one that is doing something near you ride each snapshot; parked or far ones
  // are refreshed now and then (the client holds what it last heard — every frame is still decodable on its own)
  const vPos = w.o; w.u8(0); let vn = 0;
  const sn = (m.tick / SNAP_EVERY) | 0;
  for (const v of m.vehs.list) {
    if (!v.live) continue;
    const dx = v.x - view.x, dz = v.z - view.z, near = dx * dx + dz * dz < VEH_NEAR_R * VEH_NEAR_R;
    const busy = (v.flags & VF.AWAKE) !== 0 && v.st !== VS.Gone;
    const every = me.veh === v.id || m.tick - v.touch < 24 ? 1 : near ? (busy ? 1 : 12) : busy ? 6 : 60;
    if (every > 1 && (sn + v.id * 5) % every !== 0) continue;
    if (batch) batch.vehicle(w, v); else writeVehicle(w, v); vn++;
  }
  w.dv.setUint8(vPos, vn);
  return w;
}
/** tuk-tuks nearer than this to the viewer ride every snapshot while they move */
const VEH_NEAR_R = 320;
