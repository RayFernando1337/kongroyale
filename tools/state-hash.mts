// The final-state hash of a Match, used by sim-smoke's golden hashes and the replay tools: FNV-1a over exact float bits
// of the tick and winner; the storm; every chest and every item still on the ground; each player's body, health,
// inventory, kills and damage; each vehicle's pose, health and seats. Equal hashes on one JS engine mean the same match.
import type { Match } from "../shared/sim/match";

export function stateHash(m: Match): string {
  const buf = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  const mix = (v: number) => { buf.setFloat64(0, v); for (let i = 0; i < 8; i++) h = Math.imul(h ^ buf.getUint8(i), 0x01000193) >>> 0; };
  mix(m.tick); mix(m.winnerTeam);
  const st = m.storm;
  for (const v of [st.cx, st.cz, st.r, st.tx, st.tz, st.tr, st.phase, +st.shrinking, st.timer, st.dps, +st.resurgence, +st.done]) mix(v);
  mix(m.chests.length); for (const c of m.chests) mix(+c.opened);
  mix(m.nextItemId); for (const it of m.items) if (!it.taken) { mix(it.id); mix(it.kind); mix(it.sub); mix(it.rarity); mix(it.count); mix(it.x); mix(it.y); mix(it.z); }
  for (const p of m.players) {
    mix(p.x); mix(p.y); mix(p.z); mix(p.st); mix(p.hp); mix(p.shield); mix(p.kills); mix(p.damage); mix(p.active);
    for (const s of p.slots) { mix(s.kind); mix(s.id); mix(s.rarity); mix(s.count); mix(s.mag); }
    for (const a of p.ammo) mix(a);
  }
  for (const v of m.vehs.list) { mix(+v.live); mix(v.st); mix(v.x); mix(v.y); mix(v.z); mix(v.yaw); mix(v.hp); for (const s of v.seats) mix(s); }
  return h.toString(16).padStart(8, "0");
}
