// Drives the gpu-match tour route (tour.mts) on a headless seed-42 trios Match, one controls update per tick, and checks
// that every segment reaches its last waypoint without getting stuck. Run it after editing the route, or when a map
// change may have moved a wall onto it; it takes seconds and needs no browser or GPU.
//
//   npx tsx tools/performance/tour-check.mts [--trace] [--only id,id]
//
// --trace prints the player's position every 2 s of each measured segment (for laying out waypoints). Exit 1 when a
// segment fails. Timings differ from a browser run (one update per tick here, one per frame there), so this proves the
// route is drivable, not where every frame lands.
import fs from "node:fs";
import { Terrain } from "../../shared/world/terrain";
import { decodeTerrainFile } from "../../shared/world/terrain-gen";
import { buildStaticWorld } from "../../shared/sim/static-world";
import { Match, Phase } from "../../shared/sim/match";
import { B, PS, SK, makeInput, alive, ammoIndex } from "../../shared/sim/player";
import { DT, MAX_HP, PLAYER_H, PLAYER_R, WEAPON_DEFS } from "../../shared/sim/const";
import { VS } from "../../shared/sim/vehicle";
import { WEAPONS } from "../../shared/world/map";
import { TOUR, steer, tourRunner, type Segment, type TourApi } from "./tour.mts";
import { arg } from "./common.mts";

const TRACE = process.argv.includes("--trace");
const ONLY = arg("--only", "").split(",").filter(Boolean);
const segs: Segment[] = ONLY.length ? TOUR.filter((s) => ONLY.includes(s.id)) : TOUR;
const b = fs.readFileSync(new URL("../../public/assets/terrain/island.bin", import.meta.url));
const td = decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const { world } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);
const m = new Match({ seed: 42, mode: "trios", world, humans: [{ id: 0, name: "TOUR", team: 0 }], botDifficulty: "easy", botDamageToHumans: 1 });
const me = m.players[0];
const inp = makeInput();
const step = (buttons = 0) => { inp.seq++; inp.buttons = buttons; m.pushInput(0, inp); m.step(); m.ev.reset(); };

m.startNow();
while (m.phase !== Phase.Play) step();
while (me.st === PS.Plane) step(m.tick % 2 ? B.JUMP : 0);
for (let i = 0; me.st !== PS.Ground && i < 60 * 120; i++) step();
console.log("landed at " + me.x.toFixed(0) + ", " + me.z.toFixed(0) + " tick " + m.tick);

const api: TourApi = {
  pose() {
    const v = me.st === PS.Ride ? m.vehs.list[me.veh] : null;
    return { x: me.x, y: me.y, z: me.z, ground: world.ground(me.x, me.z), heading: v ? v.yaw : me.yaw, speed: v ? Math.hypot(v.vx, v.vz) : Math.hypot(me.vx, me.vz), riding: me.st === PS.Ride, onGround: me.st === PS.Ground };
  },
  teleport(x, z, yaw) {
    const h = Math.max(world.ground(x, z), 0);
    world.velY = 0; world.resolveCapsule(x, h + 0.05, z, PLAYER_R, PLAYER_H, false);
    me.x = world.P[0]; me.y = world.P[1]; me.z = world.P[2]; me.vx = me.vy = me.vz = 0; me.yaw = yaw; me.st = PS.Ground; me.grounded = true;
  },
  vehicle(kind, x, z) {
    let best = null as null | { x: number; y: number; z: number }, bd = Infinity;
    for (const v of m.vehs.list) if ((v.st === VS.Ok || v.st === VS.Tipped || v.st === VS.Righting) && v.kind === kind && v.seats.every((s) => s < 0)) { const d = Math.hypot(v.x - x, v.z - z); if (d < bd) { bd = d; best = { x: v.x, y: v.y, z: v.z }; } }
    return best;
  },
  bringBots(n, x, z, r0, r1) {
    const foes = m.players.filter((q) => q.bot && alive(q) && q.team !== me.team && q.st === PS.Ground).sort((a, c) => Math.hypot(a.x - x, a.z - z) - Math.hypot(c.x - x, c.z - z)).slice(0, n);
    foes.forEach((q, i) => {
      const a = (i / foes.length) * Math.PI * 2, r = r0 + ((r1 - r0) * i) / Math.max(1, foes.length - 1), bx = x + Math.sin(a) * r, bz = z + Math.cos(a) * r;
      world.velY = 0; world.resolveCapsule(bx, Math.max(world.ground(bx, bz), 0) + 0.05, bz, PLAYER_R, PLAYER_H, false);
      q.x = world.P[0]; q.y = world.P[1]; q.z = world.P[2]; q.vx = q.vy = q.vz = 0; q.grounded = true;
    });
    return foes.length;
  },
  enemy() {
    let best = null as null | { x: number; y: number; z: number }, bd = 60;
    for (const q of m.players) if (q.bot && alive(q) && q.team !== me.team) { const d = Math.hypot(q.x - me.x, q.z - me.z); if (d < bd) { bd = d; best = { x: q.x, y: q.y + 1.2, z: q.z }; } }
    return best;
  },
  heal() { me.hp = MAX_HP; },
  arm() {
    const w = WEAPONS.indexOf("ar"), def = WEAPON_DEFS.ar;
    const s = me.slots[0]; s.kind = SK.Weapon; s.id = w; s.rarity = 2; s.count = 1; s.mag = def.mag; me.active = 0;
    me.ammo[ammoIndex(def.ammo)] = 600;
  },
};
const run = tourRunner(segs, api, steer);
let lastSeg = -1, traceT = 0;
for (let i = 0; !run.done && i < 60 * 60 * 15; i++) {
  const c = run.update(DT);
  inp.mz = (c.fwd ? 1 : 0) - (c.back ? 1 : 0); inp.mx = (c.right ? 1 : 0) - (c.left ? 1 : 0);
  inp.yaw = c.yaw; inp.pitch = c.pitch;
  const riding = me.st === PS.Ride;
  step((c.sprint && !riding ? B.SPRINT : 0) | (c.jump ? B.JUMP : 0) | (c.down ? B.DESCEND : 0) | (c.use ? B.USE : 0) | (c.fire ? B.FIRE : 0));
  if (run.index !== lastSeg) { lastSeg = run.index; traceT = 0; }
  if (TRACE && (traceT += DT) >= (run.measuring ? 2 : 0.5)) {
    traceT = 0; const v = me.st === PS.Ride ? m.vehs.list[me.veh] : null;
    console.log("  " + segs[run.index]?.id + " " + run.phase + " t " + run.results[run.index]?.runS.toFixed(1) + " at " + me.x.toFixed(0) + ", " + me.z.toFixed(0) + " y " + me.y.toFixed(0) + " st " + me.st + (v ? " veh st " + v.st + " v " + Math.hypot(v.vx, v.vz).toFixed(1) + " yaw " + v.yaw.toFixed(2) + " tip " + v.tip.toFixed(2) : ""));
  }
}
for (const l of run.log) console.log("  " + l);
console.log("player kills " + me.kills + ", shots " + me.shotSeq);
let bad = 0;
for (const r of run.results) { if (!r.ok) bad++; console.log((r.ok ? "ok   " : "FAIL ") + r.id.padEnd(16) + " " + r.runS.toFixed(1) + " s, waypoints " + r.waypoints + "/" + r.of + ", stuck " + r.stuck + ", skipped " + r.skipped + (r.note ? ", " + r.note : "")); }
if (!run.done) { console.log("FAIL the route did not finish"); bad++; }
process.exit(bad ? 1 : 0);
