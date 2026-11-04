// LOBBY MEMBERSHIP TEST: drives the real Lobby class (server/lobby.ts) through seeded random sequences of what clients do
// (create, open an exhibition, join, take a caster seat, leave, start, the match ending) and checks the membership
// rules after every step. The verify-room-lifecycle TLA+ model checks the same rules on a small model; this checks
// the code itself.
//   npx tsx tools/lobby/membership.test.mts [--runs N] [--steps N] [--seed N]
// Rules (exit 1 on the first broken one, with the steps that led to it):
//   a client is in the lobby its lobby field names, once, in one list (clients or casters), and in no other lobby;
//   seat >= 0 exactly for casters; every client in a lobby is in a listed lobby; a listed lobby has members and its
//   owner is one of them; a match seat (pid) is held by one client, as a person, and every person's seat has its
//   client; the match host sends to exactly the seated players and the casters; no pid without a match.
import fs from "node:fs";
import { WebSocket } from "ws";
import { Terrain } from "../../shared/world/terrain";
import { decodeTerrainFile, generateTerrain } from "../../shared/world/terrain-gen";
import { buildStaticWorld } from "../../shared/sim/static-world";
import { Lobby, initLobbies, leaveLobby, lobbies, type Client, type Sock } from "../../server/lobby";

const FLAGS = ["--runs", "--steps", "--seed"];
for (const a of process.argv.slice(2)) if (a.startsWith("--") && !FLAGS.includes(a)) { console.error(`unknown flag ${a} (flags: ${FLAGS.join(", ")})`); process.exit(2); }
const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(name); if (i < 0) return def;
  const v = Number(process.argv[i + 1]);
  if (!Number.isInteger(v) || v <= 0) { console.error(`${name} needs a positive integer, got ${process.argv[i + 1]}`); process.exit(2); }
  return v;
};
const RUNS = arg("--runs", 100), STEPS = arg("--steps", 40), SEED = arg("--seed", 1);
const CLIENTS = 4;

const td = (() => { try { const b = fs.readFileSync(new URL("../../public/assets/terrain/island.bin", import.meta.url)); return decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { return generateTerrain(); } })();
const { world } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);
initLobbies({ world, log: () => {}, perf: null });

/** mulberry32: the same seed, the same steps */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

let uid = 1;
function client(name: string): Client {
  const ws = { readyState: WebSocket.OPEN, send() {}, close() {}, terminate() {}, ping() {}, bufferedAmount: 0 } as unknown as WebSocket;
  const sock: Sock = { ws, ip: "127.0.0.1", tokens: 0, refill: 0, strikes: 0, lastMsg: 0, rtt: 0, openedAt: 0, lastPong: 0, closedBy: "" };
  const c: Client = { uid: uid++, token: name, name, lobby: null, pid: -1, squad: 0, sock, aux: [], lastInputAt: 0, peer: null!, markAt: 0, seat: -1, camAt: 0, program: false, ev: null };
  c.peer = { pid: -1, invSeq: 0, send: () => {}, sendResult: () => {} };
  return c;
}

let codeSeq = 0;
const open = () => [...lobbies.values()];
type Pick = <T>(xs: T[]) => T | undefined;
/** what a client can do, with the Lobby calls the server's message handlers make (server/index.ts onJSON); a join or a
 *  caster seat goes to another listed lobby. null = no-op */
const ACTIONS: Array<[string, (c: Client, pick: Pick) => string | null]> = [
  ["creates", (c) => { leaveLobby(c); const l = new Lobby("T" + codeSeq++, c, "trios"); lobbies.set(l.code, l); l.join(c); return l.code; }],
  ["opens an exhibition", (c) => { leaveLobby(c); const l = new Lobby("T" + codeSeq++, c, "solo"); l.exhibit = true; lobbies.set(l.code, l); l.castJoin(c); return l.code; }],
  ["joins", (c, pick) => { const l = pick(open().filter((q) => q !== c.lobby)); if (!l) return null; leaveLobby(c); l.join(c); return l.code; }],
  ["casts in", (c, pick) => { const l = pick(open().filter((q) => q !== c.lobby)); if (!l) return null; leaveLobby(c); l.castJoin(c); return l.code; }],
  ["leaves", (c) => { const l = c.lobby; if (!l) return null; leaveLobby(c); return l.code; }],
  ["starts", (c) => { const l = c.lobby; if (!l || l.owner !== c || l.match) return null; l.start(); return l.code; }],
  ["sees the match end in", (_c, pick) => { const l = pick(open().filter((q) => q.match)); if (!l) return null; l.endMatch(); return l.code; }],
];

function broken(all: Client[]): string | null {
  for (const c of all) {
    const homes = open().filter((l) => l.clients.includes(c) || l.casters.includes(c));
    const l = c.lobby;
    if (!l) {
      if (homes.length) return `${c.name} has no lobby but is listed in ${homes[0].code}`;
      if (c.pid !== -1) return `${c.name} has no lobby but holds pid ${c.pid}`;
      continue;
    }
    if (lobbies.get(l.code) !== l) return `${c.name} is in lobby ${l.code}, which the server no longer lists`;
    if (homes.length !== 1 || homes[0] !== l) return `${c.name} is in ${homes.length} lobbies' lists; its lobby field says ${l.code}`;
    const asPlayer = l.clients.filter((q) => q === c).length, asCaster = l.casters.filter((q) => q === c).length;
    if (asPlayer + asCaster !== 1) return `${c.name} is listed ${asPlayer} times as a player and ${asCaster} as a caster in ${l.code}`;
    if ((c.seat >= 0) !== (asCaster === 1)) return `${c.name} has caster seat ${c.seat} but is ${asCaster ? "a caster" : "a player"} in ${l.code}`;
    if (c.peer.pid !== c.pid) return `${c.name} has pid ${c.pid} but its match peer has ${c.peer.pid}`;
  }
  for (const l of open()) {
    const members = [...l.clients, ...l.casters];
    if (!members.length) return `lobby ${l.code} is listed with no members`;
    if (!members.includes(l.owner)) return `lobby ${l.code} is owned by ${l.owner?.name}, who is not in it`;
    if (!l.match) { const p = l.clients.find((c) => c.pid !== -1); if (p) return `${p.name} holds pid ${p.pid} in ${l.code}, which has no match`; continue; }
    const m = l.match, seated = l.clients.filter((c) => c.pid >= 0);
    if (new Set(seated.map((c) => c.pid)).size !== seated.length) return `two clients hold one pid in ${l.code}`;
    for (const c of seated) if (m.players[c.pid].bot) return `${c.name} holds pid ${c.pid} in ${l.code}, which a bot plays`;
    for (const p of m.players) if (!p.bot && !seated.some((c) => c.pid === p.id)) return `pid ${p.id} in ${l.code} is played by a person who is not in the lobby`;
    const want = new Set([...seated, ...l.casters].map((c) => c.peer)), got = l.host!.peers;
    if (got.length !== want.size || got.some((p) => !want.has(p))) return `lobby ${l.code}'s match host sends to ${got.length} peers; want the ${want.size} seated players and casters`;
  }
  return null;
}

const t0 = performance.now();
let steps = 0;
for (let run = 0; run < RUNS; run++) {
  const r = rng(SEED * 100003 + run), all = Array.from({ length: CLIENTS }, (_, i) => client("c" + (i + 1)));
  const pick: Pick = (xs) => (xs.length ? xs[Math.floor(r() * xs.length)] : undefined);
  const trail: string[] = [];
  for (let s = 0; s < STEPS; s++) {
    const c = pick(all)!, [name, act] = pick(ACTIONS)!;
    const where = act(c, pick); if (where === null) continue;
    steps++; trail.push(`${c.name} ${name} ${where}`);
    const why = broken(all);
    if (why) { console.error(`FAIL run ${run} (seed ${SEED}): ${why}\nsteps:\n  ${trail.join("\n  ")}`); process.exit(1); }
  }
  for (const l of open()) l.destroy(true);
}
// fail closed: a run that did nothing proves nothing
if (steps < RUNS * 5) { console.error(`FAIL: only ${steps} steps ran in ${RUNS} runs`); process.exit(1); }
console.log(`lobby membership passed: ${RUNS} runs, ${steps} steps, ${CLIENTS} clients, seed ${SEED} (${Math.round(performance.now() - t0)} ms)`);
process.exit(0);
