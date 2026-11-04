// SWIMMING sim checks: the real stepPlayer on the real terrain, in open deep water.
//   npx tsx tools/swim/simtest.mts        (prints PASS / FAIL per check, exits 1 on any failure)
import fs from "node:fs";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { Terrain } = await import(ROOT + "/shared/world/terrain.ts");
const { decodeTerrainFile } = await import(ROOT + "/shared/world/terrain-gen.ts");
const { StaticWorld } = await import(ROOT + "/shared/sim/world.ts");
const P = await import(ROOT + "/shared/sim/player.ts");
const C = await import(ROOT + "/shared/sim/const.ts");
const H = await import(ROOT + "/shared/sim/hitscan.ts");
const { WEAPONS } = await import(ROOT + "/shared/world/map.ts");
const b = fs.readFileSync(new URL("../../public/assets/terrain/island.bin", import.meta.url));
const td = decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const T = new Terrain(td.heights, td.biome);
const W = new StaticWorld(T, [] as never);
const { makePlayer, makeInput, stepPlayer, B } = P;
const DT = C.DT;

// a deep-water spot: ≥ 14 m of sea in a 30 m radius around it (no shore to bump into), nearest the island centre
let spot: [number, number] | null = null;
for (let r = 300; r < T.half - 40 && !spot; r += 20) for (let a = 0; a < 64 && !spot; a++) {
  const x = Math.cos(a / 64 * Math.PI * 2) * r, z = Math.sin(a / 64 * Math.PI * 2) * r;
  let deep = true; for (let k = 0; k < 12 && deep; k++) { const q = k / 12 * Math.PI * 2; if (T.height(x + Math.cos(q) * 30, z + Math.sin(q) * 30) > -14) deep = false; }
  if (deep && T.height(x, z) < -14) spot = [x, z];
}
if (!spot) throw new Error("no deep water found");
console.log(`deep water at ${spot[0].toFixed(1)}, ${spot[1].toFixed(1)} (bed ${T.height(spot[0], spot[1]).toFixed(1)} m)`);

let fails = 0;
const check = (name: string, ok: boolean, info = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  (${info})` : ""}`); if (!ok) fails++; };
const fresh = () => {
  const p = makePlayer(0, 0, "t", false); p.x = spot![0]; p.y = C.SWIM_FLOAT_Y; p.z = spot![1]; p.st = 0;
  const ar = WEAPONS.indexOf("ar"); p.slots[0].kind = 1; p.slots[0].id = ar; p.slots[0].mag = 30; p.slots[0].count = 1; p.ammo[0] = 90; p.ammo[1] = 90;
  return p;
};
const inp = makeInput();
let seq = 0;
const run = (p: ReturnType<typeof makePlayer>, s: number, set: (i: typeof inp, t: number) => void) => {
  const n = Math.round(s / DT);
  for (let i = 0; i < n; i++) { inp.mx = 0; inp.mz = 0; inp.buttons = 0; inp.yaw = 0; inp.pitch = 0; inp.slot = 0; set(inp, i * DT); inp.seq = ++seq; stepPlayer(p, inp, W, DT); }
};

// 1. surface swim: floats at the float line, swims at SWIM
{
  const p = fresh();
  run(p, 2, (i) => { i.mz = 1; });
  check("surface: swimming, not under", p.swim && !p.under, `y ${p.y.toFixed(2)}`);
  check("surface: feet at the float line", Math.abs(p.y - C.SWIM_FLOAT_Y) < 0.05, `y ${p.y.toFixed(3)}`);
  check("surface: stroke speed", Math.abs(Math.hypot(p.vx, p.vz) - C.SWIM) < 0.15, `${Math.hypot(p.vx, p.vz).toFixed(2)} m/s`);
  check("surface: gun stowed", p.swGun === 0);
}
// 2. the gun: stowed → fire draws it (nothing fires during the draw) → treading speed → stowed again after the hold
{
  const p = fresh();
  run(p, 0.5, () => {});
  const s0 = p.shotSeq;
  let firstShotT = -1;
  run(p, 1.0, (i, t) => { i.buttons = B.FIRE; if (firstShotT < 0 && p.shotSeq !== s0) firstShotT = t; });
  check("gun: drawn by fire", p.swGun > 0);
  check("gun: first shot only after the draw", firstShotT >= C.SWIM_DRAW_S - 2 * DT && firstShotT < C.SWIM_DRAW_S + 0.1, `first shot at ${firstShotT.toFixed(3)} s`);
  run(p, 1.0, (i) => { i.mz = 1; });
  check("gun: treading speed while it is up", Math.abs(Math.hypot(p.vx, p.vz) - C.SWIM_TREAD) < 0.2, `${Math.hypot(p.vx, p.vz).toFixed(2)} m/s`);
  run(p, 1.0, () => {});
  check("gun: stowed again after the hold", p.swGun === 0, `swGun ${p.swGun.toFixed(2)}`);
  run(p, 0.3, (i) => { i.buttons = B.SCOPE; });
  run(p, 0.3, (i) => { i.mz = 1; i.buttons = B.SPRINT; });
  check("gun: sprint-swimming stows it at once", p.swGun === 0);
}
// 3. duck-dive + under water
{
  const p = fresh();
  run(p, 0.3, () => {});
  run(p, 0.05, (i) => { i.buttons = B.CROUCH; });
  check("dive: crouch press goes under", p.under && p.vy < -1, `vy ${p.vy.toFixed(2)}`);
  run(p, 1.0, (i) => { i.mz = 1; });
  check("dive: below the surface after 1 s", p.y < C.SWIM_FLOAT_Y - 0.8, `y ${p.y.toFixed(2)}`);
  const y0 = p.y;
  run(p, 1.5, (i) => { i.mz = 1; i.pitch = -0.8; });
  check("under: W looking down swims down", p.y < y0 - 2.5, `${y0.toFixed(2)} → ${p.y.toFixed(2)}`);
  const sp = Math.hypot(p.vx, p.vy, p.vz);
  check("under: swim speed", Math.abs(sp - C.UW_SPEED) < 0.3, `${sp.toFixed(2)} m/s`);
  const s0 = p.shotSeq;
  run(p, 0.6, (i) => { i.buttons = B.FIRE | B.SCOPE; });
  check("under: nothing fires", p.shotSeq === s0 && p.swGun === 0);
  check("under: breath running down", p.breath < 1 - 3 / C.BREATH_S, `breath ${p.breath.toFixed(2)}`);
  const y1 = p.y;
  run(p, 1.0, (i) => { i.buttons = B.JUMP; });
  check("under: jump swims up", p.y > y1 + 1.5, `${y1.toFixed(2)} → ${p.y.toFixed(2)}`);
  const y2 = p.y;
  run(p, 1.0, (i) => { i.buttons = B.CROUCH; });
  check("under: crouch swims down", p.y < y2 - 1.5, `${y2.toFixed(2)} → ${p.y.toFixed(2)}`);
  // hold down until the air runs out: pushed back up to the surface, breath refills there
  let emptyAt = -1, surfacedAt = -1;
  run(p, C.BREATH_S + 8, (i, t) => { i.buttons = B.CROUCH; if (emptyAt < 0 && p.breath === 0) emptyAt = t; if (emptyAt >= 0 && surfacedAt < 0 && !p.under) surfacedAt = t; });
  check("breath: runs out holding down on the bed", emptyAt > 0, `empty after ${emptyAt.toFixed(2)} s`);
  check("breath: out of air → pushed back to the surface", surfacedAt > emptyAt && surfacedAt - emptyAt < 7, `surfaced ${(surfacedAt - emptyAt).toFixed(2)} s after the air ran out`);
  run(p, C.BREATH_REFILL_S + 0.2, () => {});
  check("breath: refilled on the surface", p.breath === 1);
}
// 4. idle under water drifts up and surfaces by itself
{
  const p = fresh();
  run(p, 0.2, () => {});
  run(p, 0.05, (i) => { i.buttons = B.CROUCH; });
  let t0 = -1; run(p, 12, (i, t) => { if (t0 < 0 && !p.under) t0 = t; });
  check("idle diver drifts back up", !p.under && t0 > 0.5, `surfaced after ${t0.toFixed(2)} s`);
  run(p, 0.5, () => {});
  check("idle diver floats at the float line again", Math.abs(p.y - C.SWIM_FLOAT_Y) < 0.08, `y ${p.y.toFixed(3)}`);
}
// 5. no dive in shallow water (wading or ≤ DIVE_MIN_DEPTH)
{
  let sx = 0, sz = 0, found = false;
  for (let r = 200; r < T.half && !found; r += 4) for (let a = 0; a < 128 && !found; a++) { const x = Math.cos(a / 128 * 6.283) * r, z = Math.sin(a / 128 * 6.283) * r, h = T.height(x, z); if (h < -1.6 && h > -2.2) { sx = x; sz = z; found = true; } }
  const p = fresh(); p.x = sx; p.z = sz;
  run(p, 0.3, () => {}); run(p, 0.05, (i) => { i.buttons = B.CROUCH; }); run(p, 0.3, () => {});
  check("no dive where the water is shallow", found && p.swim && !p.under, `bed ${T.height(sx, sz).toFixed(2)}`);
}
// 6. bullets stop at the water surface (open water), not over land
{
  const out = { t: 0, victim: -1, zone: 0, worldHit: false, surf: 0, cover: -1 };
  const tg = new Float64Array(5);
  const [x, z] = spot; const dy = -Math.sin(0.4), dh = Math.cos(0.4);
  H.traceShot(W, x, 1.6, z, dh, dy, 0, tg, 0, out);
  const wy = 1.6 + dy * out.t;
  check("shot into the sea stops at the surface", out.worldHit && Math.abs(wy) < 1e-6 && out.surf === 6, `t ${out.t.toFixed(2)} y ${wy.toFixed(3)} surf ${out.surf}`);
  // a diver 3 m down, straight below the line of fire, is not hit
  const tx = x + dh * (1.6 / -dy), tz = z;
  tg[0] = tx; tg[1] = -3; tg[2] = tz; tg[3] = C.PLAYER_H; tg[4] = 0;
  H.traceShot(W, x, 1.6, z, dh, dy, 0, tg, 1, out);
  check("a diver under the surface is out of reach", out.victim < 0);
  // a surface swimmer's head (above the water) is still hit — a swimmer is the crouched hitbox (poseFlags crouch || swim)
  tg[1] = C.SWIM_FLOAT_Y; tg[3] = C.CROUCH_H;
  const hx = x + 12, hz = z;
  tg[0] = hx; tg[2] = hz;
  const ey = C.SWIM_FLOAT_Y + 1.3, dir = [hx - x, ey - 1.6, 0]; const L = Math.hypot(dir[0], dir[1]);
  H.traceShot(W, x, 1.6, z, dir[0] / L, dir[1] / L, 0, tg, 1, out);
  check("a swimmer's head above the water is hit", out.victim === 0 && out.zone === 1, `victim ${out.victim} zone ${out.zone}`);
}
console.log(fails ? `\n${fails} FAILED` : "\nall swim checks pass");
process.exit(fails ? 1 : 0);
