// Prediction drift across JS engines: the authoritative Match + MatchHost run in Node (the server's engine); one human
// client runs the real ClientMatch in Node, Chromium or WebKit behind a simulated-latency pipe on a simulated clock, so
// the only difference between engines is the client's own math. Prints the reconcile corrections it saw.
//   npx tsx tools/prediction-drift/drift.mts [node|chromium|webkit] [seed] [secs] [rtt ms] [--drive] [--perturb=ULPS]
//   --drive: the client takes the wheel of a tuk-tuk (the server walks it up to the nearest one)
//   --perturb: every sin/cos/atan2/exp/pow in the client is off by ULPS units in the last place (positive control)
import fs from "node:fs";
import { build } from "esbuild";
import { Terrain } from "../../shared/world/terrain";
import { decodeTerrainFile } from "../../shared/world/terrain-gen";
import { buildStaticWorld } from "../../shared/sim/static-world";
import { Match } from "../../shared/sim/match";
import { MatchHost, matchInfo, type HostPeer } from "../../shared/net/host";
import { DT } from "../../shared/sim/const";
import { PS } from "../../shared/sim/player";
import { VKind, VS } from "../../shared/sim/vehicle";
let teleports = 0, rideTicks = 0;

const drivingMode = process.argv.includes("--drive");
const perturbUlps = Number(process.argv.find((a) => a.startsWith("--perturb="))?.slice(10) ?? 0);
const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const engine = argv[0] ?? "node", seed = Number(argv[1] ?? 7), secs = Number(argv[2] ?? 150), rtt = Number(argv[3] ?? 80);
const island = fs.readFileSync(new URL("../../public/assets/terrain/island.bin", import.meta.url));
const td = decodeTerrainFile(island.buffer.slice(island.byteOffset, island.byteOffset + island.byteLength));
const { world } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);

type Op = [number, 0 | 1 | 2, unknown?];
interface Client { init(): Promise<void>; run(ops: Op[]): Promise<Array<[number, number[]]>>; stats(): Promise<Record<string, unknown> & { corrections: Array<[number, number, number]> }>; close(): Promise<void>; version: string }
async function makeClient(): Promise<Client> {
  if (engine === "node") {
    const c = await import("./client.ts");
    return { init: () => c.init(new Uint8Array(island), drivingMode, perturbUlps), run: async (ops) => c.run(ops as never), stats: async () => c.stats() as never, close: async () => {}, version: process.version };
  }
  const pw = await import("playwright");
  const bt = engine === "webkit" ? pw.webkit : pw.chromium;
  const bundle = await build({ entryPoints: [new URL("./client.ts", import.meta.url).pathname], bundle: true, format: "iife", globalName: "drift", platform: "browser", write: false, logLevel: "error" });
  const browser = await bt.launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return {
    version: `${engine} ${browser.version()}`,
    init: () => page.evaluate(async (a) => { const s = atob(a.b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); await (globalThis as any).drift.init(u, a.drive, a.perturb); }, { b64: island.toString("base64"), drive: drivingMode, perturb: perturbUlps }),
    run: (ops) => page.evaluate((o) => (globalThis as any).drift.run(o), ops),
    stats: () => page.evaluate(() => (globalThis as any).drift.stats()),
    close: () => browser.close(),
  };
}

const client = await makeClient();
const t0 = Date.now();
await client.init();
const m = new Match({ seed, mode: "trios", world, humans: [{ id: 0, name: "Probe", team: 0 }] });
const host = new MatchHost(m);
const ow = rtt / 2;
const down: Array<[number, 0 | 1, unknown]> = [], upQ: Array<[number, number[]]> = [];
const peer: HostPeer = { pid: 0, invSeq: 0, send: (u8) => { down.push([now + ow, 1, Array.from(u8)]); } };
host.peers.push(peer);
let now = 0;
down.push([ow, 0, JSON.parse(JSON.stringify({ ...matchInfo(m, seed, { 1: 0 }), myUid: 1 }))]);
m.startNow();
let nextFrame = 0;
const endMs = secs * 1000;
for (let tick = 0; now < endMs; tick++) {
  now = tick * DT * 1000;
  while (upQ.length && upQ[0][0] <= now) host.receive(peer, Uint8Array.from(upQ.shift()![1]), (r) => down.push([now + ow, 1, Array.from(r)]));
  const me = m.players[0];
  if (drivingMode && me.st === PS.Ground && me.hp > 0 && m.phase === 2 && tick % 300 === 0) {
    let best = null, bd = Infinity;
    for (const v of m.vehs.list) { if (!v.live || v.st !== VS.Ok || v.kind !== VKind.Tuk || v.seats[0] >= 0) continue; const dd = Math.hypot(v.x - me.x, v.z - me.z); if (dd < bd) { bd = dd; best = v; } }
    if (best && bd > 2) { me.x = best.x + Math.cos(best.yaw) * 1.9; me.z = best.z - Math.sin(best.yaw) * 1.9; me.y = best.y + 0.3; me.vx = me.vy = me.vz = 0; teleports++; }
  }
  if (me.st === PS.Ride) rideTicks++;
  host.tick();
  const until = (tick + 1) * DT * 1000;
  const ops: Op[] = [];
  let di = 0;
  while (true) {
    const dAt = di < down.length && down[di][0] < until ? down[di][0] : Infinity;
    const fAt = nextFrame < until ? nextFrame : Infinity;
    if (dAt === Infinity && fAt === Infinity) break;
    if (dAt <= fAt) { ops.push([dAt, down[di][1], down[di][2]]); di++; }
    else { ops.push([fAt, 2]); nextFrame += 1000 / 144; }
  }
  down.splice(0, di);
  for (const [at, u8] of await client.run(ops)) upQ.push([at + ow, u8]);
}
const s = await client.stats();
await client.close();
const c = s.corrections.filter((x) => !x[2] && x[1] <= 30), errs = c.map((x) => x[1]).sort((a, b) => a - b);
const q = (p: number) => errs.length ? errs[Math.min(errs.length - 1, Math.floor(p * errs.length))] : 0;
const mm = (v: number) => Math.round(v * 1e6) / 1e3;
console.log(JSON.stringify({ engine: client.version, seed, secs, rtt, wallS: Math.round((Date.now() - t0) / 100) / 10, serverTicks: m.tick, drive: drivingMode, perturbUlps, teleports, rideS: Math.round(rideTicks * DT), alive: m.players[0].hp > 0, st: m.players[0].st, at: [Math.round(m.players[0].x), Math.round(m.players[0].z)],
  snapshots: s.snapshots, corrections: s.corrections.length, moveCorrections: s.moveCorrections, stateCorrections: s.stateCorrections,
  over1cm: s.corrOver1cm, over2cm: s.corrOver2cm, over10cm: s.corrOver10cm, maxMm: mm(Number(s.corrMax)), p50Mm: mm(q(0.5)), p99Mm: mm(q(0.99)),
  firstMoveCorrections: c.slice(0, 5).map(([t, e]) => [Math.round(t), mm(e)]) }));
