#!/usr/bin/env node
// Red-team the admin lobby: starts its OWN game server on a spare port with a throwaway
// admin key (random, in memory, never printed) and proves every attack below FAILS. Exit code 0 = every check held.
//   node tools/admin-lobby/redteam.mjs [--port 5479] [--md <file>] [--procs N]
// --procs N runs the server as a front with N match processes (KR_PROCS), so the same attacks cover the multi-process path.
// Needs no browser and never touches the real key (.admin-key).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 5479)), B = `http://127.0.0.1:${PORT}`, WSB = `ws://127.0.0.1:${PORT}`;
const PROCS = opt("--procs", "");
const mdOut = opt("--md", "docs/admin-lobby/redteam-results.md");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => crypto.randomBytes(16).toString("hex");

// ---- the throwaway key (never printed)
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const KEY = Array.from({ length: 30 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join("").match(/.{5}/g).join("-");
const HASH = crypto.createHash("sha256").update(KEY.replace(/[^A-Z0-9]/g, "")).digest("hex");
const SESSION_S = 10;   // short, for RT-03 — so every check logs in afresh (adm())

// (a port someone else uses would make us test THEIR server)
try { await fetch(B + "/health"); console.error(`port ${PORT} is taken — pick another with --port`); process.exit(2); } catch { /* free */ }
// ---- the server under test (KR_TRUST_PROXY=1: each check speaks from its own "address" via X-Forwarded-For)
const logFile = path.join(process.env.HOME || "/tmp", "kr-logs", `redteam-${PORT}.log`);
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const log = fs.openSync(logFile, "w");
const srv = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
  cwd: root, stdio: ["ignore", log, log],
  env: { ...process.env, KR_PORT: String(PORT), KR_HOST: "127.0.0.1", KR_EVENT_MODE: "1", KR_TRUST_PROXY: "1", KR_ADMIN_KEY_SHA256: HASH, KR_ADMIN_SESSION_S: String(SESSION_S), KR_ADMIN_KEY: "", KR_SERVE: "0", KR_PROCS: PROCS },
});
const cleanup = () => { try { srv.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", cleanup); process.on("SIGINT", () => { cleanup(); process.exit(130); });
for (let i = 0; ; i++) { try { if ((await fetch(B + "/health")).ok) break; } catch { /* booting */ } if (i > 240) { console.error("server did not start; see " + logFile); process.exit(2); } await sleep(500); }

// ---- helpers
let addrSeq = 10;
const addr = () => `198.51.100.${addrSeq++}`;
const ORIGIN = B;
async function http(p, { method = "GET", headers = {}, body, from = addr() } = {}) {
  const r = await fetch(B + p, { method, headers: { "x-forwarded-for": from, ...headers }, body, redirect: "manual" });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, text, json };
}
const login = (key, from, extra = {}) => http("/admin/api/login", { method: "POST", from, headers: { origin: ORIGIN, "content-type": "application/json", ...extra }, body: JSON.stringify({ key }) });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
/** try a websocket; resolves { open, status, ws, msgs, closed: Promise<code> } */
function wsTry(p, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WSB + p, { headers: { "x-forwarded-for": headers["x-forwarded-for"] || addr(), ...headers } });
    const msgs = []; let closeCode = null; const closeWait = [];
    ws.on("message", (d, bin) => { if (!bin) { try { msgs.push(JSON.parse(String(d))); } catch { /* */ } } });
    ws.on("close", (c) => { closeCode = c; for (const f of closeWait) f(c); });
    const closed = () => closeCode !== null ? Promise.resolve(closeCode) : new Promise((r) => closeWait.push(r));
    ws.on("unexpected-response", (_req, res) => resolve({ open: false, status: res.statusCode, ws, msgs, closed }));
    ws.on("error", () => resolve({ open: false, status: 0, ws, msgs, closed }));
    ws.on("open", () => resolve({ open: true, status: 101, ws, msgs, closed, get closeCode() { return closeCode; } }));
  });
}
async function adminSession() {
  const from = addr(); const r = await login(KEY, from); const cookie = cookieOf(r);
  if (r.status !== 200 || !cookie) throw new Error("admin login failed: " + r.status);
  const s = await wsTry("/admin/ws", { cookie, origin: ORIGIN, "x-forwarded-for": from });
  if (!s.open) throw new Error("admin ws refused: " + s.status);
  let id = 0;
  const act = async (o) => { const i = ++id; s.ws.send(JSON.stringify({ t: "act", id: i, ...o })); for (let k = 0; k < 100; k++) { const a = s.msgs.find((m) => m.t === "ack" && m.id === i); if (a) return a; await sleep(20); } return null; };
  /** the newest state push (`until`: wait ≤ 2.5 s for one that satisfies it) */
  const state = async (until) => { await sleep(250); for (let i = 0; i < 45; i++) { const st = s.msgs.filter((m) => m.t === "state").pop(); if (!until || (st && until(st))) return st; await sleep(50); } return s.msgs.filter((m) => m.t === "state").pop(); };
  return { cookie, from, s, act, state };
}
async function player(code, { name = "PLAYER", tok = rnd(), from = addr() } = {}) {
  const p = await wsTry(code ? "/ws?room=" + code : "/ws", { "x-forwarded-for": from });
  p.tok = tok; p.from = from;
  p.ws.send(JSON.stringify({ t: "hello", name }));
  if (code) p.ws.send(JSON.stringify({ t: "join", code, tok }));
  await sleep(250);
  return p;
}
const lastLobby = (p) => p.msgs.filter((m) => m.t === "lobby").pop();

// ---- checks
const results = [];
async function check(id, attack, fn) {
  let ok = false, detail = "";
  try { const r = await fn(); ok = r.ok; detail = r.detail; } catch (e) { ok = false; detail = "threw: " + String(e).slice(0, 200); }
  results.push({ id, attack, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${attack} — ${detail}`);
}

let admin = null;
/** a live admin session (sessions here live SESSION_S seconds: a fresh one per check) */
async function adm() { if (!admin || Date.now() - admin.at > 2000) { try { admin?.s.ws.close(); } catch { /* */ } admin = await adminSession(); admin.at = Date.now(); } return admin; }
const made = await (await adm()).act({ a: "create", name: "Red Team", mode: "trios", cap: 12 });
const CODE = made?.code;

await check("RT-01", "Admin API with NO cookie", async () => {
  const A = await adm();
  const s = await http("/admin/api/session"), c = await http("/admin/console.js"), w = await wsTry("/admin/ws", { origin: ORIGIN });
  return { ok: s.status === 401 && c.status === 401 && !w.open && w.status === 401, detail: `session ${s.status}, console.js ${c.status}, ws ${w.status}` };
});
await check("RT-02", "Admin API with a FORGED cookie", async () => {
  const A = await adm();
  const forged = [`kr_admin=${crypto.randomBytes(32).toString("base64url")}`, "kr_admin=admin", "kr_admin=" + "A".repeat(500), "kr_admin=../../x; kr_admin=1"];
  const out = [];
  for (const cookie of forged) {
    const s = await http("/admin/api/session", { headers: { cookie } }), c = await http("/admin/console.js", { headers: { cookie } }), w = await wsTry("/admin/ws", { cookie, origin: ORIGIN });
    out.push(`${s.status}/${c.status}/${w.status}`);
  }
  return { ok: out.every((x) => x === "401/401/401"), detail: `${forged.length} forged cookies → session/console/ws: ${[...new Set(out)].join(", ")}` };
});
await check("RT-03", "Admin API with an EXPIRED cookie (and an open socket past expiry)", async () => {
  const A = await adm();
  const from = addr(), r = await login(KEY, from), cookie = cookieOf(r);
  const w = await wsTry("/admin/ws", { cookie, origin: ORIGIN, "x-forwarded-for": from });
  const live = (await http("/admin/api/session", { headers: { cookie } })).status;
  await sleep(SESSION_S * 1000 + 2500);
  const s = await http("/admin/api/session", { headers: { cookie } }), c = await http("/admin/console.js", { headers: { cookie } }), w2 = await wsTry("/admin/ws", { cookie, origin: ORIGIN });
  const code = await Promise.race([w.closed(), sleep(2000).then(() => "still open")]);
  return { ok: live === 200 && s.status === 401 && c.status === 401 && w2.status === 401 && code === 4401, detail: `live ${live} → after ${SESSION_S}s: session ${s.status}, console.js ${c.status}, new ws ${w2.status}, open ws closed ${code}` };
});
await check("RT-04", "Cookie replay after LOGOUT", async () => {
  const A = await adm();
  const from = addr(), r = await login(KEY, from), cookie = cookieOf(r);
  const w = await wsTry("/admin/ws", { cookie, origin: ORIGIN, "x-forwarded-for": from });
  const out = await http("/admin/api/logout", { method: "POST", from, headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
  const s = await http("/admin/api/session", { headers: { cookie } }), w2 = await wsTry("/admin/ws", { cookie, origin: ORIGIN });
  const code = await Promise.race([w.closed(), sleep(1500).then(() => "still open")]);
  return { ok: out.status === 200 && s.status === 401 && w2.status === 401 && code === 4401, detail: `logout ${out.status}; replay: session ${s.status}, ws ${w2.status}; the open socket closed ${code}` };
});
await check("RT-05", "A PLAYER socket sends every admin message type", async () => {
  const A = await adm();
  const victim = await player(CODE, { name: "VICTIM" }), bad = await player(CODE, { name: "ATTACKER" });
  const before = await A.state(), lb = before.lobbies.find((l) => l.code === CODE), vid = lb.players.find((p) => p.name === "VICTIM").id;
  const kinds = ["create", "mode", "cap", "name", "lock", "teamlock", "casters", "move", "balance", "shuffle", "kick", "unkick", "rename", "start", "launch", "end", "close"];
  const payload = { code: CODE, uid: vid, team: 0, mode: "solo", cap: 2, name: "PWNED", on: true, kid: "x" };
  for (const a of kinds) { bad.ws.send(JSON.stringify({ t: "act", id: 1, a, ...payload })); bad.ws.send(JSON.stringify({ t: a, a, ...payload })); bad.ws.send(JSON.stringify({ t: "admin", a, ...payload })); bad.ws.send(JSON.stringify({ t: "hub-admin", a, ...payload })); }
  bad.ws.send(JSON.stringify({ t: "castopt", auto: true })); bad.ws.send(JSON.stringify({ t: "castprog", seat: 0 }));
  const code = await Promise.race([bad.closed(), sleep(3000).then(() => "still open")]);
  const after = (await A.state()).lobbies.find((l) => l.code === CODE);
  const unchanged = after && after.mode === "trios" && after.cap === 12 && !after.match && !after.locked && after.name === "Red Team" && after.players.some((p) => p.id === vid && p.name === "VICTIM") && after.kicked.length === 0;
  const vOpen = victim.ws.readyState === WebSocket.OPEN;
  victim.ws.close();
  return { ok: unchanged && vOpen && code === 1008, detail: `${kinds.length * 4 + 2} admin-shaped frames: lobby unchanged ${unchanged}, victim still connected ${vOpen}, attacker socket closed ${code}` };
});
await check("RT-06", "CROSS-ORIGIN / CSRF on admin POSTs and the admin socket", async () => {
  const A = await adm();
  const evil = "https://evil.example";
  const r1 = await login(KEY, addr(), { origin: evil });
  const r2 = await http("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: KEY }) });   // no Origin
  const r3 = await http("/admin/api/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: JSON.stringify({ key: KEY }) });
  const r4 = await login(KEY, addr(), { "sec-fetch-site": "cross-site" });
  const r5 = await login(KEY, addr(), { origin: "null" });
  const lo = await http("/admin/api/logout", { method: "POST", headers: { cookie: A.cookie, origin: evil, "content-type": "application/json" }, body: "{}" });
  const stillIn = (await http("/admin/api/session", { headers: { cookie: A.cookie } })).status;
  const w1 = await wsTry("/admin/ws", { cookie: A.cookie, origin: evil }), w2 = await wsTry("/admin/ws", { cookie: A.cookie }), w3 = await wsTry("/admin/ws", { cookie: A.cookie, origin: ORIGIN, "sec-fetch-site": "cross-site" });
  const setCookies = [r1, r2, r3, r4, r5].filter((r) => r.headers.get("set-cookie")).length;
  const ok = [r1, r2, r3, r4, r5, lo].every((r) => r.status === 403) && setCookies === 0 && stillIn === 200 && [w1, w2, w3].every((w) => !w.open && w.status === 403);
  return { ok, detail: `login evil/none/text-plain/cross-site/null: ${[r1, r2, r3, r4, r5].map((r) => r.status).join("/")} (cookies set: ${setCookies}); cross-site logout ${lo.status} (session kept ${stillIn}); ws evil/none/cross-site: ${[w1, w2, w3].map((w) => w.status).join("/")}` };
});
await check("RT-07", "HTML / script in names (player, lobby, admin rename)", async () => {
  const A = await adm();
  const hostile = [`<img src=x onerror=alert(1)>`, `"><svg/onload=alert(1)>`, `</script><script>alert(1)</script>`, `{{7*7}}\${7*7}`, "‮NIMDA​"];
  const ps = []; for (const n of hostile) ps.push(await player(CODE, { name: n }));
  const lob = await A.act({ a: "create", name: `<script>alert('x')</script>`, mode: "solo", cap: 4 });
  const st = await A.state(), lb = st.lobbies.find((l) => l.code === CODE);
  const target = lb.players.find((p) => !["VICTIM", "ATTACKER"].includes(p.name));
  await A.act({ a: "rename", code: CODE, uid: target.id, name: `<b onmouseover=alert(1)>X</b>` });
  const st2 = await A.state(), frame = JSON.stringify(lastLobby(ps[ps.length - 1])), adminJson = JSON.stringify(st2);
  const names = st2.lobbies.flatMap((l) => [l.name, ...l.players.map((p) => p.name)]);
  const clean = names.every((n) => /^[A-Za-z0-9 _.,!?'&:#()+-]*$/.test(n)) && !/[<>"]/.test(names.join("")) && !frame.includes("<") && !frame.includes("‮");
  for (const p of ps) p.ws.close();
  if (lob?.code) await A.act({ a: "close", code: lob.code });
  return { ok: clean, detail: `names after cleaning: ${names.slice(0, 8).map((n) => JSON.stringify(n)).join(" ")} — no < > " or bidi chars anywhere (admin state ${adminJson.length} B, room frame checked)` };
});
await check("RT-08", "A KICKED player rejoins (same token, fresh token, same address)", async () => {
  const A = await adm();
  const from = addr();
  const k = await player(CODE, { name: "KICKME", from }), friend = await player(CODE, { name: "FRIEND", from });
  const lb = (await A.state()).lobbies.find((l) => l.code === CODE), uid = lb.players.find((p) => p.name === "KICKME").id;
  const r = await A.act({ a: "kick", code: CODE, uid });
  const gotEnd = await Promise.race([k.closed(), sleep(1500).then(() => "open")]);
  const same = await player(CODE, { name: "KICKME", tok: k.tok, from }), fresh = await player(CODE, { name: "NEWME", from });
  const ended = (p) => p.msgs.some((m) => m.t === "evend" && m.why === "kicked");
  // the friend on the same network reconnects with its own (known) token: still welcome
  friend.ws.close(); await sleep(200);
  const back = await player(CODE, { name: "FRIEND", tok: friend.tok, from });
  const inAfter = (await A.state((st) => st.lobbies.find((l) => l.code === CODE)?.players.some((p) => p.name === "FRIEND"))).lobbies.find((l) => l.code === CODE).players.map((p) => p.name);
  const ok = r?.ok && gotEnd === 4001 && ended(same) && ended(fresh) && !inAfter.includes("KICKME") && !inAfter.includes("NEWME") && inAfter.includes("FRIEND");
  back.ws.close();
  return { ok, detail: `kick ack ${r?.ok}, kicked socket closed ${gotEnd}; rejoin same token → ${ended(same) ? "refused" : "ALLOWED"}, fresh token same address → ${ended(fresh) ? "refused" : "ALLOWED"}; a known friend on that address reconnects: ${inAfter.includes("FRIEND")}` };
});
await check("RT-09", "A player CREATES a lobby / exhibition / caster seat in event mode", async () => {
  const A = await adm();
  const before = (await http("/health")).json.lobbies;
  const p = await player(null, { name: "MAKER" });
  p.ws.send(JSON.stringify({ t: "create", mode: "trios" })); p.ws.send(JSON.stringify({ t: "exhibit", mode: "solo", auto: true })); p.ws.send(JSON.stringify({ t: "cast", code: CODE }));
  await sleep(400);
  const after = (await http("/health")).json.lobbies, errs = p.msgs.filter((m) => m.t === "error").map((m) => m.msg);
  const lb = (await A.state()).lobbies.find((l) => l.code === CODE);
  p.ws.close();
  return { ok: after === before && errs.length === 3 && lb.casterCount === 0, detail: `lobbies ${before} → ${after}; refusals: ${errs.join(" | ")}` };
});
await check("RT-10", "OVERSIZED and MALFORMED payloads", async () => {
  const A = await adm();
  const out = [];
  const p1 = await player(null); p1.ws.send("x".repeat(20000)); out.push(["ws 20 KB frame", await Promise.race([p1.closed(), sleep(2000).then(() => "open")]), 1009]);
  const w = await wsTry("/admin/ws", { cookie: A.cookie, origin: ORIGIN, "x-forwarded-for": A.from }); w.ws.send(JSON.stringify({ t: "act", id: 1, a: "name", code: CODE, name: "x".repeat(6000) }));
  out.push(["admin ws 6 KB frame", await Promise.race([w.closed(), sleep(2000).then(() => "open")]), 1009]);
  const big = await http("/admin/api/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ key: KEY, pad: "x".repeat(10000) }) });
  out.push(["login 10 KB body", big.status, 403]);
  const p2 = await player(null); for (let i = 0; i < 420; i++) p2.ws.send(i % 2 ? "{" : "[1,2");
  out.push(["420 malformed JSON frames", await Promise.race([p2.closed(), sleep(3000).then(() => "open")]), 1008]);
  const p3 = await player(CODE, { name: "BADTEAM" });
  for (let k = 0; k < 2; k++) for (const team of ["1", 1.5, 999, -2, null, NaN]) p3.ws.send(JSON.stringify({ t: "team", team }));
  out.push(["12 bad team indices", await Promise.race([p3.closed(), sleep(2000).then(() => "open")]), 1008]);
  const p4 = await player(null); p4.ws.send(JSON.stringify({ t: "join", code: CODE, tok: "../../etc/passwd" })); p4.ws.send(JSON.stringify({ t: "join", code: { $gt: "" }, tok: rnd() }));
  await sleep(300); out.push(["bad token / object code", p4.msgs.filter((m) => m.t === "error").length, 2]);
  const ev = await http("/api/event/..%2F..%2Fetc%2Fpasswd"); out.push(["/api/event path junk", ev.status, 404]);
  const aux = await wsTry("/ws?aux=deadbeef"); out.push(["?aux= token in URL", await Promise.race([aux.closed(), sleep(1500).then(() => "open")]), 1008]);
  const proto = await player(null); proto.ws.send(JSON.stringify({ t: "__proto__", __proto__: { polluted: 1 }, constructor: { prototype: { x: 1 } } })); await sleep(200);
  const health = await http("/health"); out.push(["prototype-pollution frame (server alive)", health.status, 200]);
  for (const p of [p3, p4, proto]) p.ws.close();
  const ok = out.every(([, got, want]) => got === want);
  return { ok, detail: out.map(([k, got, want]) => `${k}: ${got}${got === want ? "" : ` (want ${want})`}`).join("; ") };
});
await check("RT-11", "OWNER TRANSFER when people leave / the admin disconnects", async () => {
  const A = await adm();
  const l2 = await A.act({ a: "create", name: "Owner Test", mode: "trios", cap: 6 }), code = l2.code;
  const p1 = await player(code, { name: "FIRST" }), p2 = await player(code, { name: "SECOND" });
  const host0 = [lastLobby(p1)?.host, lastLobby(p2)?.host];
  p1.ws.close(); p2.ws.close(); await sleep(400);
  const empty = await http(`/api/event/${code}`);
  A.s.ws.close(); await sleep(300);   // the admin goes away
  const p3 = await player(code, { name: "THIRD" });
  p3.ws.send(JSON.stringify({ t: "start" })); p3.ws.send(JSON.stringify({ t: "mode", mode: "solo" })); await sleep(400);
  admin = null; const B2 = await adm(), lb = (await B2.state()).lobbies.find((l) => l.code === code);
  const ok = host0.every((h) => h === 0) && empty.status === 200 && lastLobby(p3)?.host === 0 && !lb.match && lb.mode === "trios";
  p3.ws.close(); await B2.act({ a: "close", code });
  return { ok, detail: `host field ${host0.join(",")}; lobby alive when empty: ${empty.status}; after the admin left, the first joiner is host? ${lastLobby(p3)?.host !== 0}; its START/MODE → match ${lb.match ? "STARTED" : "none"}, mode ${lb.mode}` };
});
await check("RT-12", "Secrets hygiene: cookie flags, headers, no key / IP / token in any response or log", async () => {
  const A = await adm();
  const from = addr(), r = await login(KEY, from, { "x-forwarded-proto": "https" });
  const sc = r.headers.get("set-cookie") || "";
  const flags = /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Path=\/admin/.test(sc) && /Secure/.test(sc);
  const page = await http("/admin"), csp = page.headers.get("content-security-policy") || "";
  const hdr = /frame-ancestors 'none'/.test(csp) && /script-src 'self'/.test(csp) && !/unsafe-eval/.test(csp) && page.headers.get("x-frame-options") === "DENY" && /no-store/.test(page.headers.get("cache-control") || "");
  const st = JSON.stringify(await A.state()), pub = JSON.stringify((await http(`/api/event/${CODE}`)).json);
  const logText = fs.readFileSync(logFile, "utf8"), norm = KEY.replace(/[^A-Z0-9]/g, "");
  const leaks = [st, pub, logText].filter((t) => t.includes(norm) || t.includes(KEY) || /198\.51\.100\./.test(t) || (t !== logText && /127\.0\.0\.1/.test(t)) || t.includes(HASH)).length;
  const tokLeak = st.includes(cookieOf(r).split("=")[1]);
  return { ok: flags && hdr && leaks === 0 && !tokLeak, detail: `cookie HttpOnly+SameSite=Strict+Path=/admin+Secure(https): ${flags}; page CSP/XFO/no-store: ${hdr}; key/IP/hash in admin state, public info or server log: ${leaks}; session token in state: ${tokLeak}` };
});
await check("RT-13", "KEY BRUTE FORCE: per-address lockout, no oracle while locked, address rotation hits the global limit", async () => {
  const A = await adm();
  const from = addr(), codes = [];
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) codes.push((await login("WRONG-" + rnd(), from)).status);
  const slow = (Date.now() - t0) / 5;
  const right = await login(KEY, from);   // the RIGHT key while locked: still refused, no cookie
  const other = await login(KEY, addr());  // another address is not punished
  // rotation: a fresh "address" per guess (X-Forwarded-For spoofing behind the proxy) → the global limit
  let firstGlobal = -1;
  for (let i = 0; i < 40; i++) { const s = (await login("WRONG-" + rnd(), addr())).status; if (s === 429 && firstGlobal < 0) firstGlobal = i; }
  const rightAfter = await login(KEY, addr());
  // …but the admin who already logged in from their address this run still gets in (the global brake
  // must not let an audience lock the real admin out)
  const adminBack = await login(KEY, admin.from);
  const ok = adminBack.status === 200 && codes.slice(0, 4).every((c) => c === 403) && codes[4] === 429 && right.status === 429 && !right.headers.get("set-cookie") && other.status === 200
    && firstGlobal >= 0 && rightAfter.status === 429 && !rightAfter.headers.get("set-cookie") && slow >= 380;
  return { ok, detail: `5 wrong from one address: ${codes.join(",")} (${Math.round(slow)} ms each); right key while locked: ${right.status}; right key from another address: ${other.status}; rotating addresses: global limit after ${firstGlobal} more guesses; right key during it from a new address: ${rightAfter.status}; from the admin's known address: ${adminBack.status}` };
});

// ---- report
const pass = results.filter((r) => r.ok).length;
const md = [`# Red-team results (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC, \`node tools/admin-lobby/redteam.mjs\`)`, "",
  `**${pass}/${results.length} attacks held.**`, "", "| id | attack | result | evidence |", "|---|---|---|---|",
  ...results.map((r) => `| ${r.id} | ${r.attack} | ${r.ok ? "**HELD**" : "**FAILED**"} | ${r.detail.replace(/\|/g, "\\|")} |`), ""].join("\n");
// the table goes to --md, or to the default path when its folder exists
const mdPath = path.resolve(root, mdOut);
if (process.argv.includes("--md") || fs.existsSync(path.dirname(mdPath))) { fs.writeFileSync(mdPath, md); console.log(`\n${pass}/${results.length} held — table: ${mdOut}`); }
else console.log(`\n${pass}/${results.length} held`);
cleanup();
process.exit(pass === results.length ? 0 : 1);
