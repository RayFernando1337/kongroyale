// The admin area over HTTP + its websocket. Routes (all under the site's own prefix):
//   GET  /admin               the page shell: no data, no inline script, strict CSP; loads admin/login.js
//   GET  /admin/login.js      the login form bundle (public: it holds nothing but the form)
//   GET  /admin/console.js    the console bundle — ONLY for a live session (an admin UI's code
//                             and markup exist in a browser only after the server confirmed the session)
//   POST /admin/api/login     { key } → session cookie            POST /admin/api/logout
//   GET  /admin/api/session   200 / 401
//   WS   /admin/ws            state pushes + actions; same origin + live session at the upgrade AND on every message
//   GET  /admin/api/reports   live session: the player-report feed as server-sent events (server/report-feed.ts),
//                             structured fields only; the stream ends when the session does
//   POST /admin/api/reports/text { seq } → live session: one report's text, which a moderator reveals on purpose
//   GET  /api/event/CODE      public: what a player link's screen shows (name, mode, count) — never anything else
// Nothing here ever returns or logs the key, a session token or an IP address. The lobbies come from o.events: this
// process's own, or behind a front every match process's (server/front.ts).
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import * as auth from "./auth";
import { EVENT_MODE, localEvents, type AdminEvents, type Res } from "./events";
import type { AdminServerMsg } from "../../shared/net/event";
import { reportFeed, type FeedItem } from "../report-feed";

const MAX_BODY = 2048, MAX_ADMIN_SOCKETS = 8, WRONG_KEY_DELAY_MS = 400, MAX_REPORT_STREAMS = 8, REPORT_PING_MS = 25_000;
const BASE_HEADERS = {
  "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow", "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin",
};
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="dark">
<title>Kong Royale · ADMIN</title><link rel="icon" href="data:,"></head>
<body class="kr-admin"><div id="kr-admin"></div><noscript>The admin console needs JavaScript.</noscript><script src="admin/login.js"></script></body></html>
`;

export function createAdminHttp(o: { root: string; ipOf(req: http.IncomingMessage): string; log(...a: unknown[]): void; events?: AdminEvents }) {
  const ev = o.events ?? localEvents;
  const feed = reportFeed();
  const dir = path.join(o.root, "dist-admin");
  const files = new Map<string, { body: Buffer; mtime: number }>();
  function bundle(name: "login.js" | "console.js"): Buffer | null {
    try {
      const f = path.join(dir, name), st = fs.statSync(f), hit = files.get(name);
      if (hit && hit.mtime === st.mtimeMs) return hit.body;
      const body = fs.readFileSync(f); files.set(name, { body, mtime: st.mtimeMs }); return body;
    } catch { return null; }
  }
  const send = (res: http.ServerResponse, code: number, body: string | Buffer, type: string, extra: http.OutgoingHttpHeaders = {}) => {
    res.writeHead(code, { ...BASE_HEADERS, "content-type": type, ...extra }); res.end(body);
  };
  const json = (res: http.ServerResponse, code: number, o: unknown, extra: http.OutgoingHttpHeaders = {}) => send(res, code, JSON.stringify(o), "application/json", extra);
  /** a JSON POST from this site's own pages (CSRF: a cross-site form can't send JSON, and the Origin must be ours) */
  const goodPost = (req: http.IncomingMessage) => req.method === "POST" && auth.sameOrigin(req) && String(req.headers["content-type"] || "").split(";")[0].trim() === "application/json";
  /** a GET a page of this site made (when the browser says where it came from) */
  const goodGet = (req: http.IncomingMessage) => { const s = req.headers["sec-fetch-site"]; return s === undefined || s === "same-origin"; };
  function readBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      if (Number(req.headers["content-length"] || 0) > MAX_BODY) { resolve(null); req.resume(); return; }
      let n = 0, done = false; const parts: Buffer[] = [];
      const finish = (v: Record<string, unknown> | null) => { if (!done) { done = true; resolve(v); } };
      req.on("data", (d: Buffer) => { n += d.length; if (n > MAX_BODY) { finish(null); req.destroy(); } else parts.push(d); });
      req.on("end", () => { try { const v = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); finish(v && typeof v === "object" && !Array.isArray(v) ? v : null); } catch { finish(null); } });
      req.on("error", () => finish(null));
    });
  }
  const csp = (req: http.IncomingMessage) => {
    const host = String(req.headers.host || "").replace(/[^A-Za-z0-9.:[\]-]/g, "");
    return `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'${host ? ` ws://${host} wss://${host}` : ""}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  };

  // ---- public event info: a small per-address budget (it's cheap, but nobody needs 100 a second)
  const infoBudget = new Map<string, { t: number; at: number }>();
  setInterval(() => infoBudget.clear(), 60_000).unref();
  const infoAllowed = (who: string) => { const now = Date.now(), b = infoBudget.get(who) ?? { t: 20, at: now }; b.t = Math.min(20, b.t + (now - b.at) / 200); b.at = now; infoBudget.set(who, b); if (b.t < 1) return false; b.t -= 1; return true; };

  // ---- the report feed: one server-sent event per report, to live sessions only
  const streams = new Set<{ sid: string; end(): void }>();
  auth.onSessionEnd((sid) => { for (const s of [...streams]) if (s.sid === sid) s.end(); });
  function reportStream(req: http.IncomingMessage, res: http.ServerResponse, sid: string) {
    res.writeHead(200, { ...BASE_HEADERS, "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
    const write = (item: FeedItem) => { res.write(`data: ${JSON.stringify(item)}\n\n`); };
    res.write("retry: 5000\n\n");
    for (const item of feed.recent()) write(item);
    const unsubscribe = feed.subscribe(write);
    const ping = setInterval(() => { if (auth.sessionLive(sid)) res.write(": ping\n\n"); else s.end(); }, REPORT_PING_MS);
    const s = { sid, end: () => { if (!streams.delete(s)) return; unsubscribe(); clearInterval(ping); res.end(); } };
    streams.add(s);
    req.on("close", s.end);
  }

  /** true = handled */
  function handle(req: http.IncomingMessage, res: http.ServerResponse, url: string): boolean {
    if (url.startsWith("/api/event/")) {
      if (req.method !== "GET" && req.method !== "HEAD") { json(res, 405, { ok: false }); return true; }
      if (!infoAllowed(auth.ipHash(o.ipOf(req)))) { json(res, 429, { ok: false, error: "slow-down" }); return true; }
      const code = url.slice("/api/event/".length).toUpperCase().slice(0, 16);
      void ev.info(code).then((info) => json(res, info.ok ? 200 : 404, info)); return true;
    }
    if (url !== "/admin" && !url.startsWith("/admin/")) return false;
    if (url === "/admin") {
      if (req.method !== "GET" && req.method !== "HEAD") { json(res, 405, { ok: false }); return true; }
      send(res, 200, PAGE, "text/html; charset=utf-8", { "content-security-policy": csp(req) }); return true;
    }
    if (url === "/admin/") { res.writeHead(308, { ...BASE_HEADERS, location: "../admin" }); res.end(); return true; }
    if (url === "/admin/login.js" || url === "/admin/console.js") {
      if (req.method !== "GET" && req.method !== "HEAD") { json(res, 405, { ok: false }); return true; }
      if (url === "/admin/console.js" && (!goodGet(req) || !auth.sessionOf(req))) { json(res, 401, { ok: false }); return true; }
      const b = bundle(url === "/admin/login.js" ? "login.js" : "console.js");
      if (!b) { json(res, 503, { ok: false, error: "the admin console isn't built (npx vite build)" }); return true; }
      send(res, 200, b, "text/javascript; charset=utf-8"); return true;
    }
    if (url === "/admin/api/session") {
      const sid = goodGet(req) ? auth.sessionOf(req) : null;
      if (!sid) json(res, 401, { ok: false }); else json(res, 200, { ok: true, expiresAt: auth.sessionExp(sid) });
      return true;
    }
    if (url === "/admin/api/reports") {
      if (req.method !== "GET") { json(res, 405, { ok: false }); return true; }
      const sid = goodGet(req) ? auth.sessionOf(req) : null;
      if (!sid) { json(res, 401, { ok: false }); return true; }
      if (streams.size >= MAX_REPORT_STREAMS) { json(res, 503, { ok: false, error: "too many report streams" }); return true; }
      reportStream(req, res, sid); return true;
    }
    if (url === "/admin/api/reports/text") {
      if (!goodPost(req)) { json(res, 403, { ok: false, error: "refused" }); req.resume(); return true; }
      const sid = auth.sessionOf(req);
      if (!sid) { json(res, 401, { ok: false }); req.resume(); return true; }
      void readBody(req).then((b) => {
        if (!auth.sessionLive(sid)) { json(res, 401, { ok: false }); return; }
        const n = b?.seq;
        if (typeof n !== "number" || !Number.isInteger(n)) { json(res, 400, { ok: false, error: "seq must be a report's number" }); return; }
        const t = feed.text(n);
        if (!t) { json(res, 404, { ok: false, error: "that report has left the feed" }); return; }
        o.log(`admin: showed the text of report ${t.id}`);
        json(res, 200, { ok: true, text: t.text });
      });
      return true;
    }
    if (url === "/admin/api/login") {
      if (!goodPost(req)) { json(res, 403, { ok: false, error: "refused" }); return true; }
      const who = auth.ipHash(o.ipOf(req));
      const wait = auth.loginWait(who);
      if (wait > 0) { json(res, 429, { ok: false, error: "too many tries", retryS: Math.ceil(wait / 1000) }); req.resume(); return true; }
      void readBody(req).then((b) => {
        if (!auth.adminConfigured()) { json(res, 503, { ok: false, error: "no admin key is set on this server" }); return; }
        if (!b || !auth.adminKeyOk(b.key)) {
          const r = auth.noteBadKey(who);
          o.log(`admin: wrong key (address ${who}${r.locked ? ", now locked" : `, ${r.left} tries left`})`);
          setTimeout(() => json(res, r.locked ? 429 : 403, r.locked ? { ok: false, error: "too many tries", retryS: Math.ceil(auth.loginWait(who) / 1000) } : { ok: false, error: "wrong key" }), WRONG_KEY_DELAY_MS + Math.random() * 200);
          return;
        }
        auth.noteGoodKey(who);
        const s = auth.newSession();
        o.log(`admin: logged in (address ${who})`);
        json(res, 200, { ok: true, expiresAt: s.exp }, { "set-cookie": auth.sessionCookie(req, s.token, s.exp) });
      });
      return true;
    }
    if (url === "/admin/api/logout") {
      if (!goodPost(req)) { json(res, 403, { ok: false, error: "refused" }); return true; }
      const sid = auth.sessionOf(req); if (sid) auth.endSession(sid, "logout");
      req.resume();
      json(res, 200, { ok: true }, { "set-cookie": auth.clearCookie(req) }); return true;
    }
    json(res, 404, { ok: false }); return true;
  }

  // ---- the admin socket
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false, clientTracking: false });
  const admins = new Set<{ ws: WebSocket; sid: string; tokens: number; at: number; strikes: number }>();
  const out = (ws: WebSocket, m: AdminServerMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const stateMsg = async (): Promise<AdminServerMsg> => ({ t: "state", now: Date.now(), lobbies: await ev.snapshot(), eventMode: EVENT_MODE });
  let pushTimer: NodeJS.Timeout | null = null;
  async function pushNow() { pushTimer = null; if (!admins.size) return; const s = JSON.stringify(await stateMsg()); for (const a of admins) if (a.ws.readyState === WebSocket.OPEN) a.ws.send(s); }
  ev.onDirty(() => { if (!pushTimer && admins.size) pushTimer = setTimeout(() => void pushNow(), 120); });
  setInterval(() => { if (admins.size) void pushNow(); }, 2000).unref();
  auth.onSessionEnd((sid, why) => { for (const a of [...admins]) if (a.sid === sid) { out(a.ws, { t: "bye", why }); a.ws.close(4401, why); } });

  /** true = handled (or refused) */
  function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if ((req.url || "").split("?")[0] !== "/admin/ws") return false;
    const refuse = (code: number, text: string) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ } socket.destroy(); };
    if (!auth.sameOrigin(req)) { refuse(403, "Forbidden"); return true; }
    const sid = auth.sessionOf(req);
    if (!sid) { refuse(401, "Unauthorized"); return true; }
    if (admins.size >= MAX_ADMIN_SOCKETS) { refuse(503, "Service Unavailable"); return true; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const a = { ws, sid, tokens: 30, at: Date.now(), strikes: 0 };
      admins.add(a);
      ws.on("close", () => admins.delete(a));
      ws.on("error", () => { /* close follows */ });
      void stateMsg().then((m) => out(ws, m));
      ws.on("message", (data: RawData, isBinary: boolean) => {
        // per message: the session must still be live (logout / expiry closes it — this is the belt to that brace)
        if (!auth.sessionLive(sid)) { out(ws, { t: "bye", why: "expired" }); ws.close(4401, "expired"); return; }
        const now = Date.now(); a.tokens = Math.min(30, a.tokens + (now - a.at) / 100); a.at = now;
        const bad = () => { if (++a.strikes > 20) ws.close(1008, "bad messages"); };
        if (a.tokens < 1) { bad(); return; } a.tokens -= 1;
        if (isBinary) { bad(); return; }
        let msg: Record<string, unknown>;
        try { const v = JSON.parse(String(data)); if (!v || typeof v !== "object" || Array.isArray(v)) { bad(); return; } msg = v; } catch { bad(); return; }
        if (msg.t !== "act" || typeof msg.id !== "number" || !Number.isInteger(msg.id) || typeof msg.a !== "string") { bad(); return; }
        const act = msg;
        void ev.action(act).catch((e): Res => { o.log("admin action error", e); return { ok: false, msg: "SERVER ERROR" }; }).then((r) => {
          o.log(`admin: ${String(act.a).slice(0, 12)}${typeof act.code === "string" ? " " + act.code.slice(0, 8) : ""} → ${r.ok ? "ok" : "refused"}: ${r.msg}`);
          out(ws, { t: "ack", id: act.id as number, ok: r.ok, msg: r.msg, ...(r.code ? { code: r.code } : {}) });
          if (!pushTimer) pushTimer = setTimeout(() => void pushNow(), 30);
        });
      });
    });
    return true;
  }
  function shutdown() { for (const s of [...streams]) s.end(); for (const a of admins) { out(a.ws, { t: "bye", why: "restart" }); a.ws.close(1001, "restart"); } }
  return { handle, upgrade, shutdown, feed };
}
