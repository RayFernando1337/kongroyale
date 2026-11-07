// ONE PROCESS PER CORE — the front (server/front.ts) and its match processes against a real server on loopback, two
// processes, no browser, about 30 s.
//   npx tsx tools/net/procs.test.mts
// Checks: KR_PROCS unset is the single process it always was (no "proc" in welcome, no "procs" in /health); with
// KR_PROCS=2 both processes come up and /health sums them; a room's code belongs to the process that made it
// (procOf), a player who dials ?room=CODE lands on that process and joins the room, and its aux socket attaches with
// ?p= its process but is refused on the other one; rooms made in a burst spread over both processes; the per-address
// cap (KR_MAX_PER_IP) counts sockets across processes at the front; a match process that dies is started again and its
// players' sockets are freed.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { procOf } from "../../server/procs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };
async function waitFor(f: () => boolean | Promise<boolean>, ms: number) { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) return false; await sleep(50); } return true; }
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

interface Health { lobbies: number; clients: number; sockets: number; procs?: { proc: number; pid: number; up: boolean; lobbies: number; sockets: number }[] }
const health = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Health;

async function startServer(env: Record<string, string>): Promise<{ port: number; proc: ChildProcess }> {
  const port = await freePort(); let out = "";
  const proc = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], { cwd: root, env: { ...process.env, KR_HOST: "127.0.0.1", KR_PORT: String(port), KR_EVENT_MODE: "0", KR_PLAYTEST_BUNDLES: "0", KR_WT: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (d) => { out += d; }); proc.stderr!.on("data", (d) => { out += d; });
  if (!(await waitFor(() => /KONG ROYALE server on/.test(out), 90_000))) throw new Error("server did not start:\n" + out);
  return { port, proc };
}

/** a socket to the server: its JSON messages, and whether and how it closed */
async function dial(port: number, query = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`); const json: Record<string, unknown>[] = [];
  let closed: number | null = null, refused = false;
  ws.on("message", (d: Buffer, isBin: boolean) => { if (!isBin) json.push(JSON.parse(String(d))); });
  ws.on("close", (code: number) => { closed = code; });
  ws.on("unexpected-response", () => { refused = true; });
  ws.on("error", () => { refused = true; });
  await waitFor(() => refused || ws.readyState === WebSocket.OPEN, 5000);
  const last = (t: string) => [...json].reverse().find((m) => m.t === t);
  return { ws, json, last, refused: () => refused, closed: () => closed, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}
async function player(port: number, query = "") {
  const c = await dial(port, query);
  await waitFor(() => !!c.last("welcome"), 5000);
  c.send({ t: "hello", name: "PROCS" });
  return c;
}

// ---- 1. one process by default
{
  const s = await startServer({});
  try {
    const c = await player(s.port), h = await health(s.port);
    check(c.last("welcome") !== undefined && !("proc" in c.last("welcome")!), "KR_PROCS unset: welcome has no proc");
    check(!("procs" in h), "KR_PROCS unset: /health has no procs");
    c.ws.close();
  } finally { s.proc.kill("SIGTERM"); }
}

// ---- 2. a front and two match processes
{
  const s = await startServer({ KR_PROCS: "2", KR_MAX_PER_IP: "12" });
  try {
    const h0 = await health(s.port);
    check(h0.procs?.length === 2 && h0.procs.every((p) => p.up), `KR_PROCS=2: two match processes up (${JSON.stringify(h0.procs?.map((p) => p.up))})`);

    const a = await player(s.port);
    const procA = a.last("welcome")!.proc as number;
    a.send({ t: "create", mode: "trios" });
    await waitFor(() => !!a.last("lobby"), 5000);
    const code = a.last("lobby")!.code as string;
    check(typeof procA === "number" && procOf(code, 2) === procA, `a room's code belongs to the process that made it (${code} on ${procA})`);

    const b = await player(s.port, `?room=${code}`);
    check(b.last("welcome")!.proc === procA, "?room=CODE dials the room's process");
    b.send({ t: "join", code });
    await waitFor(() => (a.last("lobby")?.players as unknown[] | undefined)?.length === 2, 5000);
    check((a.last("lobby")?.players as unknown[] | undefined)?.length === 2, "the player joins the room there");

    const aux = await dial(s.port, `?attach=1&p=${procA}`);
    aux.send({ t: "aux", token: a.last("welcome")!.aux });
    const wrong = await dial(s.port, `?attach=1&p=${1 - procA}`);
    wrong.send({ t: "aux", token: b.last("welcome")!.aux });
    await sleep(1000);
    check(aux.closed() === null && aux.ws.readyState === WebSocket.OPEN, "an aux socket with ?p= its process attaches");
    check(wrong.closed() === 1008, `on the other process its token is unknown: refused (${wrong.closed()})`);

    // rooms made in a burst, before either process reports them: they spread
    const burst = await Promise.all(Array.from({ length: 6 }, () => player(s.port)));
    for (const c of burst) c.send({ t: "create", mode: "solo" });
    await waitFor(() => burst.every((c) => !!c.last("lobby")), 5000);
    const on = [0, 0]; for (const c of burst) on[c.last("welcome")!.proc as number]++;
    check(on[0] === 3 && on[1] === 3, `six rooms made at once: three on each process (${on.join("/")})`);
    await waitFor(async () => (await health(s.port)).lobbies === 7, 3000);
    const h1 = await health(s.port);
    check(h1.lobbies === 7 && h1.procs!.reduce((n, p) => n + p.lobbies, 0) === 7, `/health sums the processes' lobbies (${h1.lobbies}: ${h1.procs!.map((p) => p.lobbies).join(" + ")})`);

    // 2 players + 1 aux + 6 rooms = 9 sockets from 127.0.0.1 open on the two processes; KR_MAX_PER_IP=12 counts them all
    const more: Awaited<ReturnType<typeof dial>>[] = [];
    for (let i = 0; i < 6; i++) { const c = await dial(s.port); more.push(c); if (c.refused()) break; }
    check(more.length === 4 && more[3].refused(), `the per-address cap counts sockets on every process: three more get in, the 13th from 127.0.0.1 is refused (${more.filter((c) => !c.refused()).length} got in)`);
    for (const c of more) c.ws.close();

    // a match process dies: its sockets close, the front starts it again
    const victim = h1.procs!.find((p) => p.proc === procA)!;
    process.kill(victim.pid, "SIGKILL");
    await waitFor(() => a.closed() !== null, 5000);
    check(a.closed() !== null, "a dead process's players' sockets close");
    const back = await waitFor(async () => { const h = await health(s.port); return !!h.procs?.every((p) => p.up) && h.procs[procA].pid !== victim.pid; }, 60_000);
    check(back, "the front starts the process again");
    const c2 = await player(s.port);
    check(!c2.refused() && !!c2.last("welcome"), "players get in after it: the dead process's sockets no longer count");
    for (const c of [b, aux, wrong, c2, ...burst]) c.ws.close();
  } finally { s.proc.kill("SIGTERM"); }
}

if (failed) { console.log(`procs: ${failed} check(s) failed`); process.exit(1); }
console.log("procs: all checks passed");
process.exit(0);
