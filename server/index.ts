// KONG ROYALE authoritative server: lobbies, 60 Hz match loops, binary snapshots with interest management.
//   npm run server   → ws on :3020 (vite proxies /ws → here), dev
//   npm run start    → production: serves the built client (dist/) + ws on ONE port (KR_PORT or PORT, default 3020)
// Hardening: every frame is size-checked and decoded through the sanitising readers (shared/net/proto.ts); per-socket
// token-bucket rate limit; ws heartbeat + idle timeouts; connection caps (total / per IP); one misbehaving lobby can never
// take the process down (tick errors are contained). Each client may attach ONE redundant "aux" socket (see net.ts), and
// with KR_WT=1 one WebTransport session (server/wt.ts), which then carries its binary frames.
import { addrKey } from "./addr";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { Terrain } from "../shared/world/terrain";
import { decodeTerrainFile, generateTerrain, type TerrainData } from "../shared/world/terrain-gen";
import { buildStaticWorld } from "../shared/sim/static-world";
import { lootSpots } from "../shared/sim/loot-spots";
import { alive } from "../shared/sim/player";
import { M, NET_VERSION } from "../shared/net/proto";
import { FALLBACK_REASONS, WT_ARMS, sendFrame, type FallbackReason, type Path, type WtArm } from "../shared/net/transport";
import { WsTransport } from "./transport-ws";
import type { WtTransport } from "./transport-wt";
import { startWt, type WtEndpoint } from "./wt";
import { makeBucket, struck, take } from "./limits";
import { kongbotDb } from "./kongbot";
import { annotationsApi } from "./annotations";
import { serveStatic } from "./static";
import { performanceMetrics } from "./perf";
// (voice) squad comms + caster listen-in: the WebRTC handshake relay (the audio is peer to peer)
import { onVoiceJSON } from "./voice";
// (admin lobby) event lobbies the admin runs from /admin + the admin's auth
import { playerName } from "./names";
import { EVENT_MODE, eventJoin, eventPickTeam, initEvents } from "./admin/events";
// lobbies, their clients and the list of open ones (server/lobby.ts)
import { Lobby, initLobbies, leaveLobby, lobbies, sendJSON, type Client, type Sock } from "./lobby";
import { createAdminHttp } from "./admin/http";

const PORT = Number(process.env.KR_PORT || process.env.PORT || 3020);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- limits
// bytes per ws message: the biggest legit frame is a voice handshake (a WebRTC offer / answer, ~3-6 KB of SDP, caster
// listen-in + squad comms); everything else is < 200 B
const MAX_PAYLOAD = 16384;
// per IP: every player holds 2 sockets (primary + redundant aux) — 120 lets a whole 50-player LAN party share one NAT
const MAX_CONNS = Number(process.env.KR_MAX_CONNS || 2000), MAX_CONNS_PER_IP = Number(process.env.KR_MAX_PER_IP || 120);
const MAX_LOBBIES = 400;
const MAX_LOBBIES_PER_IP = 4;             // lobbies / exhibitions one address may own at once (event mode off)
// frames per second and strikes per socket: server/limits.ts (shared with WebTransport sessions)
const HEARTBEAT_MS = 10_000;              // ws ping cadence (+ the silence check below)
// a socket is terminated only after this long with NOTHING from it — no message and no pong. ONE missed pong (10-20 s of
// silence, pongs only) is too strict: a few seconds of bad Wi-Fi / a TCP stall would cut players out of the
// room and out of matches. KR_HEARTBEAT_TIMEOUT_S overrides (seconds).
const SILENT_MAX_MS = (Number(process.env.KR_HEARTBEAT_TIMEOUT_S) > 0 ? Number(process.env.KR_HEARTBEAT_TIMEOUT_S) : 30) * 1000;
const IDLE_NO_LOBBY_MS = 10 * 60_000;     // connected but in no lobby and silent
const TRUST_PROXY = process.env.KR_TRUST_PROXY === "1";
// the proxies allowed to set the client-address headers: loopback (nginx on this machine) plus KR_PROXY_IPS (comma list)
const PROXY_IPS = new Set((process.env.KR_PROXY_IPS || "").split(",").map((s) => s.trim()).filter(Boolean));
const ORIGINS = (process.env.KR_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

// ---- world (identical to the client's)
const t0 = performance.now();
// the SAME bytes the client downloads (public/assets/terrain/island.bin); generating is the fallback (identical while
// the baked file matches the generator). The content hash rides in "welcome" so a stale client can tell.
let td: TerrainData;
try { const b = fs.readFileSync(path.join(root, "public/assets/terrain/island.bin")); td = decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
catch (e) { log("island.bin unavailable, generating:", String(e)); td = generateTerrain(); }
const terrain = new Terrain(td.heights, td.biome);
const { world, boxes, hash: worldHashV } = await buildStaticWorld(terrain, td);
log(`world ready: ${terrain.res}² heightfield, ${boxes.length} boxes, terrain hash ${td.hash}, world hash ${worldHashV}, ${Math.round(performance.now() - t0)} ms`);
// the loot generator's canonical spots (shared/sim/loot-spots.ts): built once here, not at the first START
{ const ls = lootSpots(world); log(`loot spots: ${ls.spots.length} canonical (${ls.buildings.filter((b) => b.enterable).length} enterable buildings), ${ls.ms} ms`); }

// Exclude world construction from runtime event-loop measurements.
const perf = performanceMetrics();
initLobbies({ world, log, perf });

// ---- sockets
const socks = new Set<Sock>();
const perIp = new Map<string, number>();
const addIp = (ip: string) => perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
const dropIp = (ip: string) => { const n = (perIp.get(ip) ?? 1) - 1; if (n > 0) perIp.set(ip, n); else perIp.delete(ip); };
/** the WebTransport endpoint (null: KR_WT unset, or its module could not load) */
let wt: WtEndpoint | null = null;
/** links that settled on WebTransport, and links that stayed on (or went back to) the WebSockets by reason, since the
 *  server started: what the clients said ({ t: "net" }), so fallbacks are counted across real players */
const settled = { wt: 0, ws: Object.fromEntries(FALLBACK_REASONS.map((r) => [r, 0])) as Record<FallbackReason, number> };
/** the share of sessions a WebTransport server (KR_WT=1) puts in the WebTransport arm of its A/B, 0..1 (default 1:
 *  everyone). "welcome" tells each session its arm; a tab keeps its first one (client/src/game/net.ts armOf) */
const WT_SHARE = Math.min(1, Math.max(0, Number(process.env.KR_WT_SHARE || 1) || 0));
/** the A/B per arm (shared/net/transport.ts WtArm): links that reported it, how they settled, and their inputs in running
 *  matches as the server queued them (seqs: how far their seqs advanced; lost; recovered from an input window) */
const arms = Object.fromEntries(WT_ARMS.map((a) => [a, { links: 0, settled: { wt: 0, ws: Object.fromEntries(FALLBACK_REASONS.map((r) => [r, 0])) as Record<FallbackReason, number> }, inputs: { seqs: 0, lost: 0, recovered: 0 } }])) as Record<WtArm, { links: number; settled: typeof settled; inputs: { seqs: number; lost: number; recovered: number } }>;
/** a client's last report and how many it sent: a link reports once per change, so a few is plenty */
const netSaid = new WeakMap<Client, { last: string; n: number }>();
const NET_REPORTS_MAX = 8;
/** /health: clients by transport, how links settled, the WebTransport endpoint's sessions (or why it is off), and the
 *  running matches' human inputs: lost (a seq never queued), recovered by an input window, dropped from a full queue */
function transportHealth() {
  const by: Record<string, number> = {}, inputs = { lost: 0, recovered: 0, dropped: 0 };
  for (const c of byToken.values()) by[c.bin.kind] = (by[c.bin.kind] ?? 0) + 1;
  for (const l of lobbies.values()) { const n = l.match?.netStats; if (n) { inputs.lost += n.inputsLost; inputs.recovered += n.inputsRecovered; inputs.dropped += n.inputsDropped; } }
  return { clients: by, settled, inputs, arms, webtransport: wt ? { port: wt.welcome().port, share: WT_SHARE, ...wt.counts } : { off: wtOff } };
}
function allow(s: Sock): boolean { if (take(s)) return true; strike(s, "rate"); return false; }
/** `weight`: a frame no honest client ever sends (a host-only or malformed event message) costs more than a rate blip */
function strike(s: Sock, why: string, weight = 1) { if (struck(s, weight)) { log(`closing a socket: ${why}`); s.closedBy ||= `strikes (${why})`; s.ws.close(1008, why); } }
/** (admin lobby) hostile-only messages: ~8 of them close the socket */
const HEAVY = 50;
const ADMIN_SHAPED = new Set(["act", "admin", "hub-admin", "hub-hello", "kick", "unkick", "ban", "move", "close", "end", "launch", "lock", "teamlock", "casters", "balance", "shuffle", "rename", "cap", "name"]);

// ---- clients + lobbies
const byToken = new Map<string, Client>();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = (len = 4) => { let c = ""; do { c = ""; for (let i = 0; i < len; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; } while (lobbies.has(c)); return c; };
// (names: server/names.ts — cleanName for what the admin types, playerName for what a player picks: never a staff name)
/** (admin lobby) the admin's stand-in owner of every event lobby: no client is ever it */
const EVENT_OWNER = { uid: 0, name: "HOST" } as unknown as Client;
initEvents({
  lobbies, newCode, log,
  newLobby: (code, mode) => new Lobby(code, EVENT_OWNER, mode),
  send: (c, o) => sendJSON(c.sock.ws, o),
  drop: (c, code, why) => { c.sock.closedBy ||= `server (${why})`; setTimeout(() => { try { c.sock.ws.close(code, why); } catch { /* gone */ } for (const a of c.aux) { a.closedBy ||= "primary closed"; try { a.ws.close(code, why); } catch { /* gone */ } } }, 60); },
});

// ---- http (health + static client)
const serve = process.env.KR_SERVE === "1" || process.argv.includes("--serve");
const dist = path.join(root, "dist");
// player bug reports (/kongbot in the game's chat bar) → MongoDB
const kongbot = kongbotDb(root);
// dev view notes (?dev=annotate) → .kongbot/annotations/*.jsonl (+ Mongo kongbot_annotations)
const annotations = annotationsApi(root);
const adminHttp = createAdminHttp({ root, ipOf: (req) => ipOf(req), log });
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  // (admin lobby) /admin, /admin/api/*, /api/event/CODE — before anything else (server/admin/http.ts)
  if (adminHttp.handle(req, res, url)) return;
  if (url === "/api/kongbot") {
    // a failed store always answers (the client shows "couldn't send"), never a hung request
    void kongbot.handle(req, res, ipOf(req)).catch((error) => {
      log("report request failed", error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: "could not store the report" }));
    });
    return;
  }
  if (url === "/api/annotations") {
    void annotations.handle(req, res, ipOf(req)).catch((error) => {
      log("annotation request failed", error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: "could not store the note" }));
    });
    return;
  }
  if (url === "/health") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ ok: true, feedback: kongbot.health(), lobbies: lobbies.size, clients: [...lobbies.values()].reduce((a, l) => a + l.clients.length, 0), sockets: socks.size, transports: transportHealth(), inputs: [...lobbies.values()].flatMap((l) => (l.match && l.inputGaps ? [l.inputGaps.report()] : [])), ...(perf ? { performance: perf.read() } : {}) })); return; }
  if (!serve || (req.method !== "GET" && req.method !== "HEAD")) { res.writeHead(404); res.end(); return; }
  void serveStatic(req, res, url, dist).catch((error) => { log("asset request failed", error); if (!res.headersSent) res.writeHead(500); res.end(); });
});
server.headersTimeout = 20_000; server.requestTimeout = 60_000;

// (admin lobby) behind the proxy, never the LEFT-most X-Forwarded-For entry: the client writes that
// one itself (rotating it would mint a fresh "address" per request and defeat every per-address limit). Cloudflare's
// CF-Connecting-IP, else nginx's X-Real-IP, else the right-most X-Forwarded-For entry (the one our proxy appended).
// Those headers are believed only when the connection itself comes from a trusted proxy (this machine, or KR_PROXY_IPS):
// a client reaching the port directly can't claim to be someone else (or 127.0.0.1).
const isLoop = (a: string) => a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
const ipOf = (req: http.IncomingMessage) => {
  const peer = req.socket.remoteAddress || "?";
  if (TRUST_PROXY && (isLoop(peer) || PROXY_IPS.has(peer.replace(/^::ffff:/i, "")))) {
    const one = (h: string) => { const v = req.headers[h]; return typeof v === "string" ? v.trim() : ""; };
    const xff = one("x-forwarded-for").split(",").map((s) => s.trim()).filter(Boolean);
    const ip = one("cf-connecting-ip") || one("x-real-ip") || xff[xff.length - 1];
    if (ip && ip.length <= 64) return addrKey(ip);
  }
  return addrKey(peer);
};
// (admin lobby) two socket servers on one port: /ws (players) and /admin/ws (server/admin/http.ts), routed here
const wss = new WebSocketServer({
  noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false,
  verifyClient: (info: { origin: string; req: http.IncomingMessage }) => {
    if (ORIGINS.length && !ORIGINS.includes(info.origin)) return false;
    if (socks.size + (wt?.counts.open ?? 0) >= MAX_CONNS) return false;
    return (perIp.get(ipOf(info.req)) ?? 0) < MAX_CONNS_PER_IP;
  },
});
server.on("upgrade", (req, socket, head) => {
  if (adminHttp.upgrade(req, socket, head)) return;
  if ((req.url || "").split("?")[0] === "/ws") { wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)); return; }
  try { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch { /* gone */ }
  socket.destroy();
});
let uidSeq = 1;
wss.on("connection", (ws, req) => {
  const ip = ipOf(req);
  const s: Sock = { ws, ip, ...makeBucket(), rtt: 0, openedAt: Date.now(), lastPong: Date.now(), closedBy: "" };
  socks.add(s); addIp(ip);
  ws.on("pong", (d: Buffer) => {
    s.lastPong = Date.now();
    // (admin lobby) the pings the server times (payload "h<ms>"): the admin console's ping column
    const t = d.length && d[0] === 104 ? Number(d.subarray(1).toString()) : NaN, rtt = Date.now() - t;
    if (Number.isFinite(rtt) && rtt >= 0 && rtt < 10_000) s.rtt = s.rtt ? s.rtt * 0.7 + rtt * 0.3 : rtt;
  });
  ws.on("error", () => { /* close follows */ });
  const params = new URL(req.url || "/", "http://x").searchParams;
  ws.on("close", () => { socks.delete(s); dropIp(ip); });

  // ---- a redundant binary channel for an existing client. (admin lobby) Its token is the FIRST
  // message (`{ t: "aux", token }` within 3 s), never in the URL — URLs end up in access logs. `?aux=` is refused.
  if (params.has("aux")) { ws.close(1008, "bad aux"); return; }
  if (params.get("attach") === "1") {
    const timer = setTimeout(() => ws.close(4008, "no token"), 3000);
    let c: Client | null = null;
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!allow(s)) return;
      if (c) { if (isBinary) c.ws.receive(s, data); return; }
      let m: { t?: unknown; token?: unknown } | null = null;
      try { m = isBinary ? null : JSON.parse(String(data)); } catch { /* below */ }
      const owner = m && m.t === "aux" && typeof m.token === "string" ? byToken.get(m.token) : undefined;
      clearTimeout(timer);
      if (!owner || owner.aux.length >= 1) { ws.close(1008, "bad aux"); return; }
      c = owner; owner.aux.push(s);
      ws.on("close", (code: number, reason: Buffer) => {
        const i = owner.aux.indexOf(s); if (i >= 0) owner.aux.splice(i, 1);
        if (s.closedBy !== "primary closed") logClose(owner, s, code, reason, true);
      });
    });
    ws.on("close", () => clearTimeout(timer));
    return;
  }

  const aux: Sock[] = [];
  const wsT = new WsTransport(s, aux, strike);
  const c: Client = { uid: uidSeq++, token: crypto.randomBytes(16).toString("hex"), name: "KONG", lobby: null, pid: -1, squad: 0, sock: s, aux, ws: wsT, wt: null, bin: wsT, lastInputAt: Date.now(), away: false, peer: null!, markAt: 0, seat: -1, camAt: 0, program: false, ev: null, arm: null };
  wsT.onMessage = (u8, _at, from) => onBinary(c, u8, from);
  c.peer = { pid: -1, invSeq: 0, send: (u8) => sendFrame(c.bin, u8), sendResult: (state) => sendJSON(c.sock.ws, { t: "result", state }) };
  byToken.set(c.token, c);
  sendJSON(ws, { t: "welcome", uid: c.uid, aux: c.token, terrain: td.hash, world: worldHashV, boxes: boxes.length, net: NET_VERSION, ...(wt ? { wt: { ...wt.welcome(), use: Math.random() < WT_SHARE } } : {}) });
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (!allow(s)) return;
    if (isBinary) { c.ws.receive(s, data); return; }
    let msg: { t?: unknown; [k: string]: unknown };
    try { msg = JSON.parse(String(data)); } catch { strike(s, "bad json"); return; }
    if (!msg || typeof msg !== "object") { strike(s, "bad json"); return; }
    try { onJSON(c, msg); } catch (e) { log("json handler error", e); strike(s, "handler"); }
  });
  ws.on("close", (code: number, reason: Buffer) => { logClose(c, s, code, reason, false); byToken.delete(c.token); leaveLobby(c); c.ws.close(); c.wt?.close("primary closed"); });
});

/** one line per player socket close: who, where (room / match phase, alive or not), the close code + reason,
 *  WHO closed it, how old it was and how long it had been silent. No address, no token. */
function logClose(c: Client, s: Sock, code: number, reason: Buffer, aux: boolean) {
  const now = Date.now(), l = c.lobby, m = l?.match, p = m && c.pid >= 0 ? m.players[c.pid] : undefined;
  const where = !l ? "no lobby" : `${l.event ? "event" : "lobby"} ${l.code} · ${c.seat >= 0 ? "caster seat" : !m ? "room" : !p ? `room (a match runs, phase ${m.phase})`
    : `match phase ${m.phase}, ${p.eliminated ? "eliminated" : alive(p) ? "alive" : "dead"}`}`;
  const by = s.closedBy || (code === 1006 ? "link lost (no close frame)" : "client");
  const why = String(reason ?? "").slice(0, 60), sec = (t: number) => `${((now - t) / 1000).toFixed(1)}s`;
  log(`disconnect${aux ? " (aux)" : ""}: ${c.name} · ${where} · code ${code}${why ? ` "${why}"` : ""} · by ${by} · up ${sec(s.openedAt)} · last msg ${sec(s.lastMsg)} ago, last pong ${sec(s.lastPong)} ago${aux ? "" : ` · aux ${c.aux.length ? "open" : "none"}`}`);
}

/** one binary frame from a client, on any of its transport's paths */
function onBinary(c: Client, u8: Uint8Array, from: Path) {
  const host = c.lobby?.host;
  if (!host) { if (u8[0] !== M.Input && u8[0] !== M.Inputs && u8[0] !== M.Ping && u8[0] !== M.InvOp) from.strike("bad frame"); return; }
  // a single input (WebSockets) or an input window (WebTransport): the player is here (lobby.ts housekeeping)
  const input = u8[0] === M.Input || u8[0] === M.Inputs;
  if (input) c.lastInputAt = Date.now();
  // (the WebTransport A/B) this player's inputs, counted under its arm: only its own pushes run inside receive
  const m = c.lobby?.match, pid = c.peer.pid, a = input && m && pid >= 0 && c.arm ? arms[c.arm].inputs : null;
  const s0 = a ? m!.lastSeq(pid) : 0, l0 = a ? m!.netStats.inputsLost : 0, r0 = a ? m!.netStats.inputsRecovered : 0;
  if (!host.receive(c.peer, u8, from.reply)) from.strike("bad frame");
  if (a) { a.seqs += Math.max(0, m!.lastSeq(pid) - s0); a.lost += m!.netStats.inputsLost - l0; a.recovered += m!.netStats.inputsRecovered - r0; }
}
const helloAt = new WeakMap<Client, number>(), helloLater = new WeakMap<Client, NodeJS.Timeout>();
const ownedLobbies = (ip: string) => { let n = 0; for (const l of lobbies.values()) if (!l.event && l.owner && l.owner.sock?.ip === ip) n++; return n; };
const lobbyCode = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
function onJSON(c: Client, msg: { t?: unknown; [k: string]: unknown }) {
  switch (msg.t) {
    // (admin lobby) in an event lobby a name is set before joining; afterwards only the admin renames
    case "hello": {
      if (c.lobby?.event) break;
      const name = playerName(msg.name); if (name === c.name) break;
      c.name = name;
      // a renamed player re-sends the whole room to everyone in it: at most once a second per socket
      // (a trailing send carries the last name typed inside that second)
      const wait = 1000 - (Date.now() - (helloAt.get(c) ?? 0));
      if (wait > 0) {
        if (!helloLater.has(c)) helloLater.set(c, setTimeout(() => { helloLater.delete(c); helloAt.set(c, Date.now()); c.lobby?.broadcastJSON(c.lobby.state()); }, wait));
        break;
      }
      helloAt.set(c, Date.now()); c.lobby?.broadcastJSON(c.lobby.state()); break;
    }
    case "create": {
      if (EVENT_MODE) { sendJSON(c.sock.ws, { t: "error", msg: "PRIVATE LOBBIES ARE OFF DURING THIS EVENT — USE YOUR HOST'S LINK" }); break; }
      if (lobbies.size >= MAX_LOBBIES) { sendJSON(c.sock.ws, { t: "error", msg: "SERVER FULL" }); break; }
      if (ownedLobbies(c.sock.ip) >= MAX_LOBBIES_PER_IP) { sendJSON(c.sock.ws, { t: "error", msg: "TOO MANY LOBBIES FROM YOUR NETWORK — CLOSE ONE FIRST" }); break; }
      leaveLobby(c); const l = new Lobby(newCode(), c, msg.mode === "trios" ? "trios" : "solo"); lobbies.set(l.code, l); l.join(c); log(`lobby ${l.code} created by ${c.name}`); break;
    }
    case "join": {
      const code = lobbyCode(msg.code);
      const l = lobbies.get(code); if (!l) { sendJSON(c.sock.ws, { t: "error", msg: "NO SUCH LOBBY" }); break; }
      if (l === c.lobby && c.seat < 0) break;
      if (l.event) { leaveLobby(c); eventJoin(l, c, msg.tok); break; }
      leaveLobby(c); l.join(c); break;
    }
    // (admin lobby) a player picks a TRIOS team in an event lobby (−1 = none)
    case "team": {
      const team = msg.team;
      if (!c.lobby?.event || !c.ev || typeof team !== "number" || !Number.isInteger(team) || team < -1 || team >= 64) { strike(c.sock, "bad team", HEAVY); break; }
      const err = eventPickTeam(c, team); if (err) sendJSON(c.sock.ws, { t: "error", msg: err });
      break;
    }
    // (caster) a commentator seat in an existing lobby (its code), or a new exhibition lobby to cast bots in
    case "cast": {
      const code = lobbyCode(msg.code);
      const l = lobbies.get(code); if (!l) { sendJSON(c.sock.ws, { t: "error", msg: "NO SUCH LOBBY" }); break; }
      if (l === c.lobby && c.seat >= 0) break;
      // (admin lobby) commentator seats in an event lobby only while the admin has opened them
      if (l.event && !l.event.casters) { sendJSON(c.sock.ws, { t: "error", msg: "CASTER SEATS ARE CLOSED IN THIS LOBBY" }); break; }
      leaveLobby(c); c.program = msg.program === true; l.castJoin(c); break;
    }
    case "exhibit": {
      if (EVENT_MODE) { sendJSON(c.sock.ws, { t: "error", msg: "EXHIBITIONS ARE OFF DURING THIS EVENT" }); break; }
      if (lobbies.size >= MAX_LOBBIES) { sendJSON(c.sock.ws, { t: "error", msg: "SERVER FULL" }); break; }
      if (ownedLobbies(c.sock.ip) >= MAX_LOBBIES_PER_IP) { sendJSON(c.sock.ws, { t: "error", msg: "TOO MANY LOBBIES FROM YOUR NETWORK — CLOSE ONE FIRST" }); break; }
      leaveLobby(c); const l = new Lobby(newCode(), c, msg.mode === "trios" ? "trios" : "solo"); l.exhibit = true; l.auto = msg.auto === true; lobbies.set(l.code, l);
      log(`lobby ${l.code}: exhibition (${l.mode}) opened by ${c.name}`); l.castJoin(c); break;
    }
    // (caster) the owner toggles AUTO (an exhibition starts its next match on its own)
    case "castopt": if (c.lobby?.event) { strike(c.sock, "not the host", HEAVY); break; } if (c.lobby && c.lobby.owner === c) { c.lobby.auto = msg.auto === true; c.lobby.broadcastJSON(c.lobby.state()); } break;
    // (caster) the PRODUCER (the lobby's owner) puts a seat's camera on air: every seat + PROGRAM window hears it
    case "castprog": {
      const l = c.lobby; if (!l || c.seat < 0 || l.owner !== c) break;
      const seat = Number(msg.seat); if (!l.casters.some((q) => q.seat === seat && !q.program)) break;
      l.onAir = seat; l.castJSON({ t: "castprog", seat, by: c.seat }); l.broadcastJSON(l.state());
      break;
    }
    // (caster) "look at this!": one seat's shot offered to the other seats (≤ 1 a second)
    case "castping": {
      const l = c.lobby; if (!l || c.seat < 0 || c.program) break;
      const now = Date.now(); if (now - c.markAt < 1000) break; c.markAt = now;
      const cam = msg.cam; if (!cam || typeof cam !== "object") break;
      const note = String(msg.note ?? "").slice(0, 80);
      if (JSON.stringify(cam).length > 600) break;
      l.castJSON({ t: "castping", seat: c.seat, name: c.name, cam, note }, c);
      break;
    }
    // (caster) my camera, for the other seats (follow / program feed). Small JSON, ≤ 12 a second, relayed as is with my seat
    case "castcam": {
      const l = c.lobby; if (!l || c.seat < 0) break;
      const now = Date.now(); if (now - c.camAt < 80) break; c.camAt = now;
      const cam = msg.cam; if (!cam || typeof cam !== "object") break;
      const out = JSON.stringify(cam); if (out.length > 600) break;
      l.castJSON({ t: "castcam", seat: c.seat, name: c.name, cam }, c);
      break;
    }
    // (admin lobby) in an event lobby only the admin changes the mode or starts: a player asking is refused (and struck)
    case "mode": if (c.lobby?.event) { strike(c.sock, "not the host", 10); break; } if (c.lobby && c.lobby.owner === c && !c.lobby.match) { c.lobby.mode = msg.mode === "trios" ? "trios" : "solo"; c.lobby.assignSquads(); c.lobby.broadcastJSON(c.lobby.state()); } break;
    case "start": if (c.lobby?.event) { strike(c.sock, "not the host", HEAVY); break; } c.lobby?.claimHost(c); if (c.lobby && c.lobby.owner === c) { if (!c.lobby.match) c.lobby.start(); else c.lobby.match.startNow(); } break;
    case "leave": leaveLobby(c); break;
    // which transport the link settled on and why (client/src/game/net.ts). Only counted when it matches what the
    // server sees (a "wt" claim needs an attached session), on a change, and a few times per client
    case "net": {
      const why = msg.why as FallbackReason, onWt = msg.transport === "wt";
      if (onWt ? !c.wt : !FALLBACK_REASONS.includes(why)) break;
      const key = onWt ? "wt" : why, said = netSaid.get(c) ?? { last: "", n: 0 };
      if (said.last === key || said.n >= NET_REPORTS_MAX) break;
      netSaid.set(c, { last: key, n: said.n + 1 });
      if (onWt) settled.wt++; else settled.ws[why]++;
      // its A/B arm: the first one it names (a link keeps its arm)
      if (!c.arm && WT_ARMS.includes(msg.arm as WtArm)) { c.arm = msg.arm as WtArm; arms[c.arm].links++; }
      if (c.arm) { if (onWt) arms[c.arm].settled.wt++; else arms[c.arm].settled.ws[why]++; }
      break;
    }
    // the client's island stream (the warm-up waits for it, ≤ 40 s: MatchHost.holdForStream)
    case "stream": c.peer.streamed = msg.done === true; break;
    // my map marker / ping → my squadmates only (solo: nobody). ≤ 6 per second per player; coordinates
    // checked against the island's bounds
    case "mark": {
      const l = c.lobby, m = l?.match; if (!l || !m || c.pid < 0) break;
      const now = Date.now(); if (now - c.markAt < 60) break; c.markAt = now;
      const clear = msg.clear === true, x = Number(msg.x), z = Number(msg.z);
      if (!clear && !(Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) < 4000 && Math.abs(z) < 4000)) break;
      const team = m.teamOf(c.pid), out = JSON.stringify(clear ? { t: "mark", pid: c.pid, clear: true } : { t: "mark", pid: c.pid, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 });
      for (const q of l.clients) if (q !== c && q.pid >= 0 && m.teamOf(q.pid) === team && q.sock.ws.readyState === WebSocket.OPEN) q.sock.ws.send(out);
      break;
    }
    // (voice) the comms handshake relay, mic state, caster listen-ins (server/voice.ts)
    case "rtc": case "voice": case "listen": onVoiceJSON(c, c.lobby, msg); break;
    // (admin lobby) admin actions never travel on a player socket: anything shaped like one is hostile
    default: strike(c.sock, "unknown msg", typeof msg.t === "string" && ADMIN_SHAPED.has(msg.t) ? HEAVY : 1);
  }
}

// heartbeat (dead links) + idle sockets that never joined anything
// a link is alive while ANYTHING arrives on it — a message (inputs: 60 a second in a match) or a pong (the
// pings below, + the 3 s timed pings of event-lobby players) — and dead after SILENT_MAX_MS of nothing at all
const hb = setInterval(() => {
  const now = Date.now();
  for (const s of socks) {
    if (now - Math.max(s.lastMsg, s.lastPong) > SILENT_MAX_MS) { s.closedBy ||= `heartbeat (silent > ${SILENT_MAX_MS / 1000}s)`; s.ws.terminate(); continue; }
    try { s.ws.ping(); } catch { /* closing */ }
  }
  for (const c of byToken.values()) if (!c.lobby && now - c.sock.lastMsg > IDLE_NO_LOBBY_MS) { c.sock.closedBy ||= "idle (in no lobby)"; c.sock.ws.close(1000, "idle"); }
}, HEARTBEAT_MS);
// (admin lobby) the admin console's ping column: event-lobby players get a timed ping every 3 s (browsers answer pings
// by protocol; the pong echoes the payload)
setInterval(() => {
  const h = Buffer.from("h" + Date.now());
  for (const l of lobbies.values()) if (l.event) for (const c of l.clients) if (c.sock.ws.readyState === WebSocket.OPEN) { try { c.sock.ws.ping(h); } catch { /* closing */ } }
}, 3000).unref();

function shutdown(sig: string) {
  log(`${sig}: shutting down`);
  clearInterval(hb);
  for (const l of [...lobbies.values()]) { l.broadcastJSON({ t: "error", msg: "SERVER RESTARTING" }); l.destroy(true); }
  adminHttp.shutdown();
  wt?.close();
  for (const s of socks) { s.closedBy ||= "server restart"; s.ws.close(1001, "restart"); }
  void kongbot.close(); void annotations.close();   // (stops its timers; an in-flight queue import finishes first)
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT")); process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => log("uncaught", e));
process.on("unhandledRejection", (e) => log("unhandled rejection", e));
const HOST = process.env.KR_HOST || (serve ? "0.0.0.0" : "127.0.0.1");
if (serve && !TRUST_PROXY) log("note: KR_TRUST_PROXY is off — behind nginx / Cloudflare every player shares one address (set KR_TRUST_PROXY=1)");
// ---- WebTransport (KR_WT=1): datagrams for the hot path, the WebSocket pair stays the fallback (server/wt.ts). Behind
// a proxy (KR_TRUST_PROXY=1) on loopback UDP still comes straight from players, so it listens on every address; any
// other KR_HOST is kept
const wtOwner = new WeakMap<WtTransport, Client>();
let wtOff = process.env.KR_WT === "1" ? "" : "off (KR_WT unset)";
if (!wtOff) {
  try {
    wt = await startWt({
      port: Number(process.env.KR_WT_PORT || PORT), host: process.env.KR_WT_HOST || (TRUST_PROXY && (isLoop(HOST) || HOST === "localhost") ? "0.0.0.0" : HOST), certFile: process.env.KR_WT_CERT, keyFile: process.env.KR_WT_KEY,
      url: process.env.KR_WT_URL, maxPayload: MAX_PAYLOAD, origins: ORIGINS, silentMaxMs: SILENT_MAX_MS,
    }, {
      admit: (ip) => socks.size + wt!.counts.open < MAX_CONNS && (perIp.get(ip) ?? 0) < MAX_CONNS_PER_IP,
      opened: addIp, closed: dropIp, log,
      attach: (token, t) => {
        const c = byToken.get(token); if (!c || c.wt) return false;
        c.wt = t; c.bin = t; wtOwner.set(t, c); t.onMessage = (u8, _at, from) => onBinary(c, u8, from);
        return true;
      },
      detach: (t) => { const c = wtOwner.get(t); if (c && c.wt === t) { c.wt = null; c.bin = c.ws; } },
    });
  } catch (e) { wtOff = (e as Error).message; log(`webtransport unavailable: ${wtOff}`); }
}
server.listen(PORT, HOST, () => log(`KONG ROYALE server on ${HOST}:${PORT} (${serve ? "serving dist/ + /ws" : "ws only"})${EVENT_MODE ? " · EVENT MODE (players join by link only)" : ""} · admin ${process.env.KR_ADMIN_KEY_SHA256 ? "key set" : "OFF (no KR_ADMIN_KEY_SHA256)"}`));
