// ONE PROCESS PER CORE — the front (server/front.ts) and its match processes against a real server on loopback, two
// processes, no browser, about 30 s.
//   npx tsx tools/net/procs.test.mts
// Checks: KR_PROCS unset is the single process it always was (no "proc" in welcome, no "procs" in /health); with
// KR_PROCS=2 both processes come up and /health sums them; a room's code belongs to the process that made it
// (procOf), a player who dials ?room=CODE lands on that process and joins the room, and its aux socket attaches with
// ?p= its process but is refused on the other one; rooms made in a burst spread over both processes; the per-address
// caps hold across processes: sockets (KR_MAX_PER_IP, counted at the front) and rooms (4 per address, each process told
// what the address owns on the others); a match process that dies is started again and its players' sockets are freed;
// while one is down /health answers 503; with KR_WT=1 each process listens for WebTransport on KR_WT_PORT + its index
// and tells its players so (and KR_WT_URL with the same port offset), and an address's sessions on a process stay
// within its WebSockets there plus a slack, so it can't fill every process's UDP port without sockets the front counted;
// admin event lobbies stop at MAX_EVENT_LOBBIES over both processes even when the creates arrive all at once; and the total and
// per-address caps count WebTransport sessions on every process (the front tells each process what the others hold).
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { MAX_EVENT_LOBBIES } from "../../server/admin/events";
import { procOf } from "../../server/procs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };
async function waitFor(f: () => boolean | Promise<boolean>, ms: number) { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) return false; await sleep(50); } return true; }
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

interface Health { ok: boolean; lobbies: number; clients: number; sockets: number; procs?: { proc: number; pid: number; up: boolean; lobbies: number; sockets: number }[] }
const health = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Health;
const healthStatus = async (port: number) => (await fetch(`http://127.0.0.1:${port}/health`)).status;

async function startServer(env: Record<string, string>): Promise<{ port: number; proc: ChildProcess }> {
  const port = await freePort(); let out = "";
  const proc = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], { cwd: root, env: { ...process.env, KR_HOST: "127.0.0.1", KR_PORT: String(port), KR_EVENT_MODE: "0", KR_PLAYTEST_BUNDLES: "0", KR_WT: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (d) => { out += d; }); proc.stderr!.on("data", (d) => { out += d; });
  if (!(await waitFor(() => /KONG ROYALE server on/.test(out), 90_000))) throw new Error("server did not start:\n" + out);
  return { port, proc };
}

/** a socket to the server: its JSON messages, and whether and how it closed */
async function dial(port: number, query = "", from = "127.0.0.1") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { localAddress: from }); const json: Record<string, unknown>[] = [];
  let closed: number | null = null, refused = false;
  ws.on("message", (d: Buffer, isBin: boolean) => { if (!isBin) json.push(JSON.parse(String(d))); });
  ws.on("close", (code: number) => { closed = code; });
  ws.on("unexpected-response", () => { refused = true; });
  ws.on("error", () => { refused = true; });
  await waitFor(() => refused || ws.readyState === WebSocket.OPEN, 5000);
  const last = (t: string) => [...json].reverse().find((m) => m.t === t);
  return { ws, json, last, refused: () => refused, closed: () => closed, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}
async function player(port: number, query = "", from?: string) {
  const c = await dial(port, query, from);
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
  const s = await startServer({ KR_PROCS: "2", KR_MAX_PER_IP: "6" });
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

    // rooms made in a burst (from six addresses), before either process reports them: they spread
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => player(s.port, "", `127.0.0.${i + 2}`)));
    for (const c of burst) c.send({ t: "create", mode: "solo" });
    await waitFor(() => burst.every((c) => !!c.last("lobby")), 5000);
    const on = [0, 0]; for (const c of burst) on[c.last("welcome")!.proc as number]++;
    check(on[0] === 3 && on[1] === 3, `six rooms made at once: three on each process (${on.join("/")})`);
    await waitFor(async () => (await health(s.port)).lobbies === 7, 3000);
    const h1 = await health(s.port);
    check(h1.lobbies === 7 && h1.procs!.reduce((n, p) => n + p.lobbies, 0) === 7, `/health sums the processes' lobbies (${h1.lobbies}: ${h1.procs!.map((p) => p.lobbies).join(" + ")})`);

    // two players and an aux socket from 127.0.0.1 on one process; new sockets spread over both; KR_MAX_PER_IP=6
    const more: Awaited<ReturnType<typeof dial>>[] = [];
    for (let i = 0; i < 6; i++) { const c = await dial(s.port); more.push(c); if (c.refused()) break; }
    check(more.length === 4 && more[3].refused(), `the per-address cap counts sockets on every process: three more get in, the 7th from 127.0.0.1 is refused (${more.filter((c) => !c.refused()).length} got in)`);
    for (const c of more) c.ws.close();

    // one address makes rooms one at a time, spread over both processes: the fifth is refused wherever it lands
    const maker = await Promise.all(Array.from({ length: 6 }, () => player(s.port, "", "127.0.0.9")));
    const madeOn = [0, 0];
    for (const c of maker) { c.send({ t: "create", mode: "solo" }); await waitFor(() => !!c.last("lobby") || !!c.last("error"), 3000); if (c.last("lobby")) madeOn[c.last("welcome")!.proc as number]++; await sleep(1200); }
    const refusedRooms = maker.filter((c) => /TOO MANY LOBBIES/.test(String(c.last("error")?.msg ?? ""))).length;
    check(madeOn[0] + madeOn[1] === 4 && madeOn[0] > 0 && madeOn[1] > 0 && refusedRooms === 2, `an address owns at most 4 rooms across both processes (${madeOn.join(" + ")} made, ${refusedRooms} refused)`);
    for (const c of maker) c.ws.close();

    // a match process dies: its sockets close, the front starts it again
    const victim = h1.procs!.find((p) => p.proc === procA)!;
    process.kill(victim.pid, "SIGKILL");
    await waitFor(() => a.closed() !== null, 5000);
    check(a.closed() !== null, "a dead process's players' sockets close");
    const down = await health(s.port);
    check(!down.ok && (await healthStatus(s.port)) === 503, "while it is down /health answers 503, ok false");
    const back = await waitFor(async () => { const h = await health(s.port); return !!h.procs?.every((p) => p.up) && h.procs[procA].pid !== victim.pid; }, 60_000);
    check(back && (await health(s.port)).ok && (await healthStatus(s.port)) === 200, "the front starts the process again, and /health is ok");
    const c2 = await player(s.port);
    check(!c2.refused() && !!c2.last("welcome"), "players get in after it: the dead process's sockets no longer count");
    for (const c of [b, aux, wrong, c2, ...burst]) c.ws.close();
  } finally { s.proc.kill("SIGTERM"); }
}

// ---- 3. WebTransport: each process on its own UDP port, named in its players' welcome
{
  const s = await startServer({ KR_PROCS: "2", KR_WT: "1", KR_WT_URL: "https://game.example:4000/wt" });
  try {
    const ps = [await player(s.port), await player(s.port)];
    const seen = ps.map((c) => { const w = c.last("welcome")!; return { proc: w.proc as number, port: (w.wt as { port?: number } | undefined)?.port }; });
    check(new Set(seen.map((x) => x.proc)).size === 2 && seen.every((x) => x.port === s.port + x.proc), `KR_WT=1: process i's players are told UDP KR_WT_PORT + i (${seen.map((x) => `${x.proc}:${x.port}`).join(", ")})`);
    // sessions that never show a token, on process 1's port, from an address with one WebSocket there: 1 + 4 slack
    type Lib = { WebTransport: new (url: string, o: unknown) => { ready: Promise<unknown>; close(): void } };
    let lib: Lib | null = null;
    try { await import("@fails-components/webtransport-transport-http3-quiche" as string); lib = await import("@fails-components/webtransport" as string) as Lib; await (lib as unknown as { quicheLoaded: Promise<unknown> }).quicheLoaded; } catch { console.log("SKIP  WebTransport admission: no QUIC module"); }
    if (lib) {
      const w1 = ps.find((c) => c.last("welcome")!.proc === 1)!.last("welcome")!.wt as { port: number; hashes: string[] };
      const hashes = w1.hashes.map((h) => ({ algorithm: "sha-256", value: new Uint8Array(Buffer.from(h, "base64")) }));
      const sessions: { ready: Promise<unknown>; close(): void }[] = [];
      for (let i = 0; i < 7; i++) { const t = new lib.WebTransport(`https://127.0.0.1:${w1.port}/wt`, { serverCertificateHashes: hashes }); sessions.push(t); await t.ready.catch(() => {}); await sleep(100); }
      const refused = async () => ((await health(s.port)) as unknown as { transports: { webtransport: { refused?: { limit?: number } } } }).transports.webtransport.refused?.limit ?? 0;
      await waitFor(async () => (await refused()) >= 2, 3000);
      check((await refused()) === 2, `an address's sessions on a process stay within its WebSockets there plus 4: of 7, 2 refused (${await refused()})`);
      for (const x of sessions) try { x.close(); } catch { /* refused */ }
    }
    const urls = ps.map((c) => { const w = c.last("welcome")!; return [w.proc as number, (w.wt as { url?: string } | undefined)?.url] as const; });
    check(urls.every(([i, u]) => u === `https://game.example:${4000 + i}/wt`), `with KR_WT_URL, process i's players get its port plus i (${urls.map(([i, u]) => `${i}: ${u}`).join(", ")})`);
    for (const c of ps) c.ws.close();
  } finally { s.proc.kill("SIGTERM"); }
}

// ---- 4. admin event lobbies: the cap is the processes' together, even for creates sent all at once
{
  const key = crypto.randomBytes(15).toString("hex").toUpperCase();
  const s = await startServer({ KR_PROCS: "2", KR_EVENT_MODE: "1", KR_ADMIN_KEY: "", KR_ADMIN_KEY_SHA256: crypto.createHash("sha256").update(key).digest("hex") });
  try {
    const origin = `http://127.0.0.1:${s.port}`;
    const login = await fetch(origin + "/admin/api/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ key }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/admin/ws`, { headers: { cookie, origin } }); const acks: { ok: boolean }[] = [];
    ws.on("message", (d: Buffer) => { const m = JSON.parse(String(d)); if (m.t === "ack") acks.push(m); });
    await waitFor(() => ws.readyState === WebSocket.OPEN, 5000);
    for (let i = 0; i < MAX_EVENT_LOBBIES + 4; i++) ws.send(JSON.stringify({ t: "act", id: i + 1, a: "create", name: "PROCS " + i, mode: "trios", cap: 12 }));
    await waitFor(() => acks.length === MAX_EVENT_LOBBIES + 4, 15_000);
    await waitFor(async () => (await health(s.port)).lobbies >= MAX_EVENT_LOBBIES, 3000);
    const made = acks.filter((a) => a.ok).length, h = await health(s.port);
    check(login.status === 200 && made === MAX_EVENT_LOBBIES && h.lobbies === MAX_EVENT_LOBBIES && (h.procs ?? []).every((p) => p.lobbies > 0), `${MAX_EVENT_LOBBIES + 4} event lobbies asked for at once: ${made} made over both processes (${(h.procs ?? []).map((p) => p.lobbies).join(" + ")}), the rest refused`);
    ws.close();
  } finally { s.proc.kill("SIGTERM"); }
}

// ---- 5. the total and per-address caps count WebTransport sessions on every process, as one process does
{
  const s = await startServer({ KR_PROCS: "2", KR_WT: "1", KR_MAX_PER_IP: "6" });
  try {
    type Lib = { WebTransport: new (url: string, o: unknown) => { ready: Promise<unknown>; close(): void } };
    let lib: Lib | null = null;
    try { await import("@fails-components/webtransport-transport-http3-quiche" as string); lib = await import("@fails-components/webtransport" as string) as Lib; await (lib as unknown as { quicheLoaded: Promise<unknown> }).quicheLoaded; } catch { console.log("SKIP  WebTransport caps: no QUIC module"); }
    if (lib) {
      const codes: string[] = [], keep: Awaited<ReturnType<typeof player>>[] = [];
      for (let i = 2; i < 10 && codes.length < 2; i++) {
        const m = await player(s.port, "", `127.0.0.${i}`); m.send({ t: "create", mode: "solo" });
        await waitFor(() => !!m.last("lobby"), 3000); keep.push(m);
        const code = m.last("lobby")?.code as string | undefined;
        if (code && !codes.some((c) => procOf(c, 2) === procOf(code, 2))) codes.push(code);
      }
      const mine = [];
      for (const code of codes) for (let i = 0; i < 3; i++) mine.push(await player(s.port, `?room=${code}`));
      await sleep(1200);
      const w = mine.find((c) => c.last("welcome")!.proc === 1)!.last("welcome")!.wt as { port: number; hashes: string[] };
      const hashes = w.hashes.map((h) => ({ algorithm: "sha-256", value: new Uint8Array(Buffer.from(h, "base64")) }));
      const sessions: { ready: Promise<unknown>; close(): void }[] = [];
      for (let i = 0; i < 3; i++) { const t = new lib.WebTransport(`https://127.0.0.1:${w.port}/wt`, { serverCertificateHashes: hashes }); sessions.push(t); await t.ready.catch(() => {}); await sleep(100); }
      const counts = async () => ((await health(s.port)) as unknown as { transports: { webtransport: { open?: number; refused?: { limit?: number } } } }).transports.webtransport;
      await waitFor(async () => ((await counts()).open ?? 0) + ((await counts()).refused?.limit ?? 0) >= 3, 3000);
      check(codes.length === 2 && mine.length === 6 && (await counts()).open === 0, `an address holding KR_MAX_PER_IP=6 WebSockets across two processes is refused every WebTransport session (${(await counts()).open} open)`);
      for (const x of sessions) try { x.close(); } catch { /* refused */ }
      for (const c of [...keep, ...mine]) c.ws.close();
    }
  } finally { s.proc.kill("SIGTERM"); }
}

if (failed) { console.log(`procs: ${failed} check(s) failed`); process.exit(1); }
console.log("procs: all checks passed");
process.exit(0);
