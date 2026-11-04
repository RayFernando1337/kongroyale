// StaticWorld.raycast against a reference walk, on flat ground with made-up boxes (no island needed):
//  1. a ray that hits two boxes at exactly the same distance returns the box the full row-major walk of its grid-cell
//     rectangle meets first (the walk may skip cells, the answer may not change)
//  2. thousands of seeded random rays through boxes on whole-metre coordinates, where exact ties are common, return the
//     same hit, distance, box, surface and normal as the reference: every cell of the rectangle, row-major, strict <
//  usage: npx tsx tools/world/raycast-test.mts [--rays 20000]
import { Terrain } from "../../shared/world/terrain";
import { WORLD } from "../../shared/world/map";
import type { Box } from "../../shared/world/colliders";
import { StaticWorld, makeHit, type Hit } from "../../shared/sim/world";

const RAYS = process.argv.includes("--rays") ? Number(process.argv[process.argv.indexOf("--rays") + 1]) : 20000;
const res = Math.round((2 * WORLD.HALF) / WORLD.CELL) + 1;
const terrain = new Terrain(new Float32Array(res * res), new Uint8Array(res * res));
const ground = new StaticWorld(terrain, []);

/** the reference: terrain first, then every box of every cell in the ray's rectangle, row-major, first strictly nearer hit wins */
function reference(w: StaticWorld, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, out: Hit): Hit {
  ground.raycast(ox, oy, oz, dx, dy, dz, maxT, out, true);
  const W = w as any, ex = ox + dx * out.t, ez = oz + dz * out.t;
  const cx0 = W.cell(Math.min(ox, ex) - 1), cx1 = W.cell(Math.max(ox, ex) + 1), cz0 = W.cell(Math.min(oz, ez) - 1), cz1 = W.cell(Math.max(oz, ez) + 1);
  if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 64) throw Error("reference covers the rectangle walk only");
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
    const c = cz * W.gridN + cx;
    for (let k = W.cellStart[c]; k < W.cellStart[c + 1]; k++) { const i = W.cellItems[k]; if (!w.noShoot[i]) W.rayBox(i, ox, oy, oz, dx, dy, dz, out); }
  }
  return out;
}
const same = (a: Hit, b: Hit) => a.hit === b.hit && a.t === b.t && a.box === b.box && a.surf === b.surf && a.nx === b.nx && a.ny === b.ny && a.nz === b.nz;
const show = (h: Hit) => `hit ${h.hit} t ${h.t} box ${h.box} surf ${h.surf} n (${h.nx}, ${h.ny}, ${h.nz})`;
let failed = 0;
const fail = (msg: string) => { failed++; if (failed <= 10) console.log("FAIL " + msg); };

// 1. two boxes hit at t = 96: the metal one is met first by the full walk, through a cell the ray never enters
{
  const boxes: Box[] = [{ c: [65, 4, 32], h: [1, 4, 40], surf: "metal" }, { c: [50, 2, 50], h: [30, 2, 30], surf: "concrete" }];
  const w = new StaticWorld(terrain, boxes), a = makeHit(), b = makeHit();
  w.raycast(0, 36, 0, 2 / 3, -1 / 3, 2 / 3, 120, a, true);
  reference(w, 0, 36, 0, 2 / 3, -1 / 3, 2 / 3, 120, b);
  if (!(a.hit && a.t === 96 && a.box === 0 && a.nx === -1)) fail(`equal-distance tie: ${show(a)}, want the metal box 0 at t 96 with normal -X`);
  if (!same(a, b)) fail(`equal-distance tie differs from the reference: ${show(a)} vs ${show(b)}`);
}

// 2. seeded random scenes and rays
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
let ties = 0, rays = 0;
for (let scene = 0; scene < 20; scene++) {
  const boxes: Box[] = [];
  for (let n = 0; n < 80; n++) {
    const hy = int(1, 6);
    boxes.push({ c: [int(-60, 60), hy + int(0, 4), int(-60, 60)], h: [int(1, 20), hy, int(1, 20)], yaw: rnd() < 0.2 ? int(1, 3) * Math.PI / 8 : 0, surf: (["metal", "concrete", "wood"] as const)[n % 3] });
  }
  const w = new StaticWorld(terrain, boxes), a = makeHit(), b = makeHit(), all = makeHit();
  for (let k = 0; k < RAYS / 20; k++) {
    const ox = int(-70, 70), oy = int(1, 30), oz = int(-70, 70), tx = int(-70, 70), ty = int(0, 12), tz = int(-70, 70);
    w.raycast(ox, oy, oz, tx - ox, ty - oy, tz - oz, 1, a, true);
    reference(w, ox, oy, oz, tx - ox, ty - oy, tz - oz, 1, b);
    rays++;
    if (!same(a, b)) fail(`scene ${scene} ray (${ox}, ${oy}, ${oz}) -> (${tx}, ${ty}, ${tz}): ${show(a)} vs reference ${show(b)}`);
    // count rays where another box ties the winner, so the run proves it exercised the tie rule
    if (b.box >= 0) { let n = 0; for (let i = 0; i < w.n; i++) { all.t = 2; all.box = -1; (w as any).rayBox(i, ox, oy, oz, tx - ox, ty - oy, tz - oz, all); if (all.box === i && all.t === b.t) n++; } if (n > 1) ties++; }
  }
}
console.log(`${rays} random rays, ${ties} with an exact tie between boxes; ${failed} failed`);
if (ties < 50) { console.log("FAIL too few ties to test the tie rule"); failed++; }
process.exit(failed ? 1 : 0);
