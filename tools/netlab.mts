// NETLAB — hit registration under latency, measured with the REAL code paths: the authoritative Match + MatchHost (the
// same host loop the Node server runs) and two headless ClientMatch instances (the browser's prediction /
// interpolation / lag-comp input code), connected by FIFO latency pipes with jitter. Simulated clock (deterministic).
//
//   npx tsx tools/netlab.mts [rtt ms list, default 20,80,160,250,320] [--jitter 20] [--secs 20] [--weapon ar] [--kill] [--check]
//   --check: exit 1 when hit registration regresses. At every RTT up to CHECK_MAX_RTT_MS (250) the run must fire pellets and
//            have predicted hits, confirm at least CHECK_MIN_CONFIRM_PCT (99) of them and show 0 ghost hits. Longer RTTs are only
//            reported as KNOWN ISSUE lines, never failed: main shotgun at 320 ms RTT, 20 ms jitter confirms 89.7% with 3 ghost hits
//            because every pellet is clamped by the 350 ms rewind cap. Whole grid:
//              for w in pistol smg ar shotgun sniper; do npx tsx tools/netlab.mts --weapon $w --jitter 20 --check; done
//   --kill: B is KILLABLE (100 hp + 50 shield, respawns on the spot 3 s later, warm-up rules) — measures kill races: pellets
//           fired at a target our own in-flight bullets already killed must not show a (ghost) hit marker
//
// Shooter A (seat 0) aims at what it DRAWS for target B (seat 1) — B strafes / sprints / jumps under its own client —
// and fires. For every pellet we compare the client's prediction (ClientMatch.predictShot on the drawn hitboxes, what
// the HUD shows instantly) with the server's lag-compensated verdict (Match.shotProbe). Reports per RTT:
//   agree   = pellets where client and server name the same victim
//   confirm = predicted hits the server confirmed (what the player feels: "my hit marker was real")
//   ghost   = predicted hits the server rejected;  surprise = server hits the client predicted as misses
//   clamped = shots older than the rewind cap (MAX_REWIND_TICKS)
import { Terrain } from "../shared/world/terrain";
import { decodeTerrainFile, generateTerrain } from "../shared/world/terrain-gen";
import { buildStaticWorld } from "../shared/sim/static-world";
import fsTd from "node:fs";
import { Match } from "../shared/sim/match";
import { MatchHost, matchInfo, type HostPeer } from "../shared/net/host";
import { DT, MAX_REWIND_TICKS, WEAPON_DEFS } from "../shared/sim/const";
import { B, PS, SK } from "../shared/sim/player";
import { makeShotResult } from "../shared/sim/hitscan";
import { POIS, WEAPONS, type WeaponId } from "../shared/world/map";
import { ClientMatch } from "../client/src/game/client";
import type { Link } from "../client/src/game/net";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const rtts = (argv[0] && !argv[0].startsWith("--") ? argv[0] : "20,80,160,250,320").split(",").map(Number);
const jitter = Number(opt("--jitter", "0")), secs = Number(opt("--secs", "20")), weapon = opt("--weapon", "ar") as WeaponId, killable = argv.includes("--kill"), check = argv.includes("--check");

// ---- simulated clock drives performance.now() everywhere
let now = 0;
Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true });

const td = (() => { try { const b = fsTd.readFileSync(new URL("../public/assets/terrain/island.bin", import.meta.url)); return decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { return generateTerrain(); } })();
const terrain = new Terrain(td.heights, td.biome);
const { world } = await buildStaticWorld(terrain, td);

interface Pipe { q: Array<{ at: number; u8: Uint8Array; json?: unknown }>; oneWay: number; rnd: () => number }
function pipe(oneWay: number, seed: number): Pipe { let s = seed; return { q: [], oneWay, rnd: () => ((s = (Math.imul(s, 1664525) + 1013904223) | 0), ((s >>> 8) & 0xffff) / 65536) }; }
const send = (p: Pipe, u8: Uint8Array | null, json?: unknown) => {
  const j = jitter ? (p.rnd() - 0.5) * 2 * jitter / 2 : 0;
  const at = Math.max(p.q.length ? p.q[p.q.length - 1].at : 0, now + p.oneWay + j);   // FIFO (TCP never reorders)
  p.q.push({ at, u8: u8 ? u8.slice() : new Uint8Array(0), json });
};

async function run(rtt: number) {
  now = 0;
  const m = new Match({ seed: 7, mode: "solo", world, humans: [{ id: 0, name: "A", team: 0 }, { id: 1, name: "B", team: 1 }] });
  for (const p of m.players) if (p.bot) { m.brains[p.id] = null; p.x = 3000 + p.id * 10; p.z = 3000; p.st = PS.Dead; p.respawnAt = 1e9; }
  const host = new MatchHost(m);
  const islet = POIS.find((q) => q.id === "lobby-islet")!;
  const A = m.players[0], Bp = m.players[1];
  const place = () => {
    A.x = islet.x - 11; A.z = islet.z; A.y = Math.max(0, terrain.height(A.x, A.z)) + 0.05; A.vx = A.vz = 0;
    Bp.x = islet.x + 11; Bp.z = islet.z + 2; Bp.y = Math.max(0, terrain.height(Bp.x, Bp.z)) + 0.05;
    const w = WEAPONS.indexOf(weapon), s = A.slots[0]; s.kind = SK.Weapon; s.id = w; s.rarity = 0; s.mag = 999; s.count = 1; A.active = 0; A.ammo.fill(999);
    Bp.hp = killable ? 100 : 1e9; Bp.shield = killable ? 50 : 0;
  };
  place();
  // kill races: B respawns ON its spot (inside the tick, before history is recorded — exactly like a real respawn)
  let deaths = 0;
  if (killable) { const orig = m.spawnWarmup.bind(m); m.spawnWarmup = (p) => { if (p.id !== 1) return orig(p); deaths++; Bp.x = islet.x + 11; Bp.z = islet.z + 2; Bp.y = Math.max(0, terrain.height(Bp.x, Bp.z)) + 0.05; Bp.st = PS.Ground; Bp.grounded = true; Bp.vx = Bp.vy = Bp.vz = 0; Bp.shield = 50; }; }
  const clients: Array<{ cm: ClientMatch; up: Pipe; down: Pipe; peer: HostPeer; inp: { yaw: number; pitch: number; fire: boolean; mx: number; mz: number; buttons: number; dx: number; dy: number; poll: (o: { mx: number; mz: number; buttons: number; slot: number }, allowFire: boolean) => void } }> = [];
  for (let pid = 0; pid < 2; pid++) {
    const up = pipe(rtt / 2, 11 + pid), down = pipe(rtt / 2, 91 + pid);
    const link: Link = { offline: false, onJSON: () => {}, onBinary: () => {}, onClose: () => {}, sendJSON: () => {}, sendBinary: (u8) => send(up, u8), close: () => {} };
    const cm = new ClientMatch(world, link);
    const peer: HostPeer = { pid, invSeq: 0, send: (u8) => send(down, u8) };
    host.peers.push(peer);
    const inp = { yaw: 0, pitch: 0, fire: false, mx: 0, mz: 0, buttons: 0, dx: 0, dy: 0, poll(o: { mx: number; mz: number; buttons: number; slot: number }, allowFire: boolean) { o.mx = this.mx; o.mz = this.mz; o.buttons = this.buttons | (this.fire && allowFire ? B.FIRE : 0); o.slot = 0; } };
    clients.push({ cm, up, down, peer, inp });
    const info = { ...matchInfo(m, 7, { [pid + 1]: pid }), myUid: pid + 1 };
    send(down, null, JSON.parse(JSON.stringify(info)));
  }
  // ---- verdicts
  const pred: number[] = [], serv: number[] = []; let clampedN = 0;
  m.shotProbe = (sh, _inp, _k, _t, clamped, res) => { if (sh.id !== 0) return; serv.push(res.victim); if (clamped) clampedN++; };
  const R = makeShotResult();
  clients[0].cm.onTick = () => { const c = clients[0].cm; if (c.pred.fired > 0) for (let k = 0; k < c.pred.fired; k++) pred.push(c.predictShot(k, R).victim); };
  // ---- loop: server at 60 Hz, clients at 144 Hz
  const T = secs * 1000; let nextTick = 0, nextFrame = 0, t0 = -1;
  const rateMs = WEAPON_DEFS[weapon].auto ? 0 : 60000 / WEAPON_DEFS[weapon].rpm + 20;
  let lastSemi = 0;
  while (now < T + rtt + 500) {
    const step = Math.min(nextTick, nextFrame); now = step;
    for (const c of clients) {
      for (const pp of [c.up, c.down]) while (pp.q.length && pp.q[0].at <= now) {
        const msg = pp.q.shift()!;
        if (pp === c.up) host.receive(c.peer, msg.u8, (r) => send(c.down, r));
        else if (msg.json) c.cm.onJSON(msg.json as Record<string, unknown>); else c.cm.onBinary(msg.u8);
      }
    }
    if (now >= nextTick) {
      host.tick(); A.hp = 100; if (!killable) Bp.hp = 1e9; if (m.phase !== 0) m.phase = 0;
      // keep the warm-up going forever (respawn timers are on phaseT: shift them with it)
      if (!killable) m.phaseT = 0; else if (m.phaseT > 60) { m.phaseT -= 30; for (const q of m.players) if (q.respawnAt > 0) q.respawnAt -= 30; }
      nextTick += DT * 1000;
    }
    if (now >= nextFrame) {
      const dt = 1 / 144;
      // target B: strafe left/right every 0.7 s, sprint, hop now and then
      const b = clients[1].inp, ph = Math.floor(now / 700);
      b.mx = ph % 2 ? 1 : -1; b.mz = (ph % 5 === 0) ? 1 : 0; b.buttons = (ph % 3 === 0 ? B.SPRINT : 0) | ((Math.floor(now / 1900) % 2 === 0 && now % 1900 < 60) ? B.JUMP : 0);
      b.yaw = -Math.PI / 2;
      // shooter A: aim at the chest of what it draws for B (render interpolation) and fire
      const a = clients[0].inp, cm = clients[0].cm;
      cm.interpolate();
      const r = cm.remotes[1];
      if (r.n > 0 && cm.started) {
        const ex = cm.pred.x, ez = cm.pred.z, ey = cm.pred.y + 1.65;
        const dx = r.x - ex, dz = r.z - ez, dy = r.y + (r.crouch ? 0.8 : 1.2) - ey;
        a.yaw = Math.atan2(-dx, -dz); a.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        if (t0 < 0) t0 = now;
        const firing = now - t0 > 1500 && now < T;
        if (rateMs === 0) a.fire = firing; else if (firing && now - lastSemi > rateMs) { a.fire = !a.fire; lastSemi = now; } else if (!firing) a.fire = false;
      }
      for (const c of clients) { (c.inp as unknown as { yaw: number }).yaw = c.inp.yaw; c.cm.update(dt, c.inp as never, true); }
      nextFrame += 1000 / 144;
    }
  }
  const n = Math.min(pred.length, serv.length);
  let agree = 0, predHits = 0, confirmed = 0, ghost = 0, surprise = 0, servHits = 0;
  for (let i = 0; i < n; i++) {
    const p = pred[i], s = serv[i];
    if (p === s) agree++;
    if (p >= 0) { predHits++; if (s === p) confirmed++; else ghost++; }
    if (s >= 0) { servHits++; if (p < 0) surprise++; }
  }
  const pc = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return { rtt, jitter, weapon, ...(killable ? { kills: deaths } : {}), pellets: n, predMissing: pred.length - serv.length, agreePct: pc(agree, n), predHits, confirmPct: pc(confirmed, predHits), ghost, surprise, servHits, clamped: clampedN, rewindCapMs: Math.round(MAX_REWIND_TICKS * DT * 1000), corrections: clients[0].cm.netStats.moveCorrections, corrMaxMm: Math.round(clients[0].cm.netStats.corrMax * 1000) };
}

const CHECK_MAX_RTT_MS = 250, CHECK_MIN_CONFIRM_PCT = 99;
const failures: string[] = [];
for (const rtt of rtts) {
  const r = await run(rtt);
  console.log(JSON.stringify(r));
  if (!check) continue;
  const problems: string[] = [];
  if (r.pellets === 0 || r.predHits === 0) problems.push(`no data (${r.pellets} pellets, ${r.predHits} predicted hits)`);
  if (r.predMissing !== 0) problems.push(`${r.predMissing} predicted pellets have no server verdict`);
  if (r.confirmPct < CHECK_MIN_CONFIRM_PCT) problems.push(`confirm ${r.confirmPct}% < ${CHECK_MIN_CONFIRM_PCT}%`);
  if (r.ghost > 0) problems.push(`${r.ghost} ghost hits`);
  if (!problems.length) continue;
  const label = `${weapon} rtt=${rtt}ms jitter=${jitter}${killable ? " kill" : ""}: ${problems.join(", ")}`;
  if (rtt > CHECK_MAX_RTT_MS) console.log(`KNOWN ISSUE (not failed, rtt > ${CHECK_MAX_RTT_MS} ms): ${label}`);
  else failures.push(label);
}
if (check) {
  if (failures.length) { console.error("NETLAB CHECK FAILED:\n  " + failures.join("\n  ")); process.exit(1); }
  console.log("NETLAB CHECK PASSED");
}
