// Event lobbies: lobbies the ADMIN runs. A core `Lobby` (server/index.ts) with `lobby.event` set:
// its owner is a stand-in nobody ever is (no player has host powers, ownership never moves to a player), it outlives its
// last player (only the admin closes it), and its teams are explicit — a player picks one (or the admin moves them),
// the unassigned are placed at START, and the picks survive END and reconnects (keyed by the player's session token).
// Kicks block that token and, for tokens this lobby has never seen, the address it came from (salted hash). Wire:
// shared/net/event.ts. Every admin action lands in adminAction() — server/admin/http.ts calls it only for a live session.
import crypto from "node:crypto";
import type { Client, Lobby } from "../lobby";
import { EVENT_CAP_DEFAULT, EVENT_CAP_MAX, EVENT_CAP_MIN, EVENT_CODE_RE, EVENT_NAME_MAX, EVENT_TEAM_SIZE, PLAYER_TOKEN_RE, eventTeamCount,
  type AdminLobby, type AdminPlayer, type EventEndReason, type EventPublicInfo, type EventRoom } from "../../shared/net/event";
import { cleanName } from "../names";
import { Phase } from "../../shared/sim/match";
import { PS } from "../../shared/sim/player";
import { ipHash } from "./auth";

type Mode = "solo" | "trios";
/** KR_EVENT_MODE (default ON in this build): players can't create lobbies or caster exhibitions — only join by link */
export const EVENT_MODE = process.env.KR_EVENT_MODE !== "0";
const MAX_EVENT_LOBBIES = 12;

/** Client.ev: a player inside an event lobby */
export interface EventMember { tok: string; team: number; joinedAt: number; renamed: boolean; teamAt: number }
/** Lobby.event */
export interface EventState {
  name: string; cap: number; locked: boolean; teamsLocked: boolean; casters: boolean; createdAt: number; round: number;
  /** every token that joined (and wasn't kicked): its team pick, and the admin's rename if any — a reconnect keeps both */
  known: Map<string, { team: number; name: string | null }>;
  /** removed players: tok / ip NEVER leave the server (the admin sees kid + name) */
  kicked: Array<{ kid: string; name: string; at: number; tok: string; ip: string }>;
  /** the CURRENT match's seats by token (tok → pid; one token per seat: whoever took it last), so a player
   *  whose link dropped gets their own seat back (server/index.ts Lobby.join). Cleared at every START and match end */
  seats: Map<string, number>;
}

/** what server/index.ts lends this module */
export interface EventHost {
  lobbies: Map<string, Lobby>;
  newLobby(code: string, mode: Mode): Lobby;
  newCode(len: number): string;
  send(c: Client, o: unknown): void;
  /** close the client's sockets after a beat (its last message goes out first) */
  drop(c: Client, code: number, why: string): void;
  log(...a: unknown[]): void;
}
let host: EventHost;
export function initEvents(h: EventHost) { host = h; }

// ---- the admin console listens for changes (coalesced there)
const dirtyFns = new Set<() => void>();
export const onEventsDirty = (fn: () => void) => { dirtyFns.add(fn); };
export const eventsDirty = () => { for (const fn of dirtyFns) fn(); };

export const cleanEventName = (v: unknown) => String(v ?? "").normalize("NFKC").replace(/[^A-Za-z0-9 _.,!?'&:#()+-]/g, "").replace(/\s+/g, " ").trim().slice(0, EVENT_NAME_MAX);
const clampCap = (v: unknown) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(EVENT_CAP_MIN, Math.min(EVENT_CAP_MAX, n)) : EVENT_CAP_DEFAULT; };
const teamsOf = (l: Lobby) => (l.mode === "trios" ? eventTeamCount(l.event!.cap) : 0);
const teamSize = (l: Lobby, team: number, except: Client | null = null) => { let n = 0; for (const c of l.clients) if (c !== except && c.ev?.team === team) n++; return n; };
const remember = (l: Lobby, c: Client) => { if (c.ev) l.event!.known.set(c.ev.tok, { team: c.ev.team, name: c.ev.renamed ? c.name : null }); };

// ------------------------------------------------------------------ players
/** a player asks to join an event lobby by its code. false = refused (the client was told why) */
export function eventJoin(l: Lobby, c: Client, tok: unknown): boolean {
  const ev = l.event!;
  if (typeof tok !== "string" || !PLAYER_TOKEN_RE.test(tok)) { host.send(c, { t: "error", msg: "RELOAD THE PAGE AND TRY AGAIN" }); return false; }
  const ip = ipHash(c.sock.ip), known = ev.known.get(tok);
  if (ev.kicked.some((k) => k.tok === tok) || (!known && ev.kicked.some((k) => k.ip === ip))) {
    host.log(`event ${l.code}: a removed player tried to rejoin (refused)`);
    end(c, "kicked"); return false;
  }
  if (!known) {
    if (ev.locked) { host.send(c, { t: "error", msg: "THIS LOBBY IS LOCKED" }); return false; }
    if (l.clients.length >= ev.cap) { host.send(c, { t: "error", msg: "THIS LOBBY IS FULL" }); return false; }
  }
  // the same person in a second tab / after a reload: the newest session wins, the old one is told why
  for (const q of [...l.clients]) if (q !== c && q.ev?.tok === tok) { l.leave(q); q.ev = null; end(q, "replaced"); }
  c.ev = { tok, team: known?.team ?? -1, joinedAt: Date.now(), renamed: !!known?.name, teamAt: 0 };
  if (known?.name) c.name = known.name;
  l.join(c);
  if (c.lobby !== l) { c.ev = null; return false; }   // the core refused (LOBBY FULL)
  remember(l, c);
  host.log(`event ${l.code}: ${c.name} joined (${l.clients.length}/${ev.cap})`);
  return true;
}
/** a player picks a team (−1 = none). null = done, else the refusal for the screen */
export function eventPickTeam(c: Client, team: number): string | null {
  const l = c.lobby;
  if (!l?.event || !c.ev) return "NOT IN AN EVENT LOBBY";
  if (l.mode !== "trios") return "THIS LOBBY IS SOLO";
  if (l.event.teamsLocked) return "TEAMS ARE LOCKED BY THE HOST";
  if (l.match) return "TEAMS CHANGE BETWEEN MATCHES";
  const now = Date.now(); if (now - c.ev.teamAt < 300) return null; c.ev.teamAt = now;   // (a click storm: one per 0.3 s)
  if (team === c.ev.team) return null;
  if (team >= 0 && teamSize(l, team, c) >= EVENT_TEAM_SIZE) return `TEAM ${team + 1} IS FULL`;
  c.ev.team = team; remember(l, c);
  l.assignSquads(); l.pushState();
  return null;
}
/** the seat this player's token held in the lobby's current match (−1 = none) */
export function eventSeatOf(l: Lobby, c: Client): number { return (c.ev && l.event?.seats.get(c.ev.tok)) ?? -1; }
/** this player now holds seat c.pid of the current match (any older claim on that seat is forgotten) */
export function eventSeated(l: Lobby, c: Client) {
  const ev = l.event; if (!ev || !c.ev || c.pid < 0) return;
  for (const [tok, pid] of ev.seats) if (pid === c.pid && tok !== c.ev.tok) ev.seats.delete(tok);
  ev.seats.set(c.ev.tok, c.pid);
}
/** out of the lobby for good: the reason, then the socket closes */
function end(c: Client, why: EventEndReason) {
  const msg = why === "kicked" ? "YOU WERE REMOVED FROM THIS LOBBY" : why === "closed" ? "THE HOST CLOSED THIS LOBBY" : "YOU OPENED THIS LOBBY IN ANOTHER TAB";
  host.send(c, { t: "evend", why, msg });
  host.drop(c, why === "kicked" ? 4001 : 4000, why);
}

/** the squads the core uses: picks in TRIOS (`final`: the unassigned are placed — at START), join order in SOLO */
export function assignEventSquads(l: Lobby, final: boolean) {
  if (l.mode === "solo") { l.clients.forEach((c, i) => { c.squad = i; }); return; }
  const T = teamsOf(l);
  for (const c of l.clients) if (c.ev && c.ev.team >= T) { c.ev.team = -1; remember(l, c); }
  if (final) {
    const count = new Map<number, number>(); for (const c of l.clients) if (c.ev && c.ev.team >= 0) count.set(c.ev.team, (count.get(c.ev.team) ?? 0) + 1);
    for (const c of l.clients) {
      if (!c.ev || c.ev.team >= 0) continue;
      // a team that already has people and room first (nobody plays with bots when a human slot is free), then the
      // lowest empty team, then (more players than cards: returning players past the cap) teams past the cards
      let best = -1, bestN = 0;
      for (let t = 0; t < T; t++) { const n = count.get(t) ?? 0; if (n > 0 && n < EVENT_TEAM_SIZE && n > bestN) { best = t; bestN = n; } }
      if (best < 0) for (let t = 0; ; t++) if ((count.get(t) ?? 0) === 0) { best = t; break; }
      c.ev.team = best; count.set(best, (count.get(best) ?? 0) + 1); remember(l, c);
    }
  }
  for (const c of l.clients) c.squad = c.ev && c.ev.team >= 0 ? c.ev.team : 1000 + c.uid;
}
export function eventRoom(l: Lobby): EventRoom {
  const ev = l.event!, trios = l.mode === "trios";
  return { name: ev.name, cap: ev.cap, teams: teamsOf(l), locked: ev.locked, teamsLocked: ev.teamsLocked,
    players: l.clients.map((c) => ({ id: c.uid, name: c.name, team: trios ? c.ev?.team ?? -1 : -1 })) };
}
export function publicInfo(code: string): EventPublicInfo {
  const l = EVENT_CODE_RE.test(code) ? host.lobbies.get(code) : undefined;
  if (!l?.event) return { ok: false, error: "not-found" };
  return { ok: true, code, name: l.event.name, mode: l.mode, count: l.clients.length, cap: l.event.cap, locked: l.event.locked, inMatch: !!l.match };
}

// ------------------------------------------------------------------ the admin
const eventLobbies = () => [...host.lobbies.values()].filter((l) => !!l.event);
function playerState(l: Lobby, c: Client): AdminPlayer["state"] {
  const m = l.match; if (!m) return "room";
  if (c.pid < 0) return "waiting";
  const p = m.players[c.pid];
  return !p || p.eliminated || p.st === PS.Spectate || (p.st === PS.Dead && m.phase !== Phase.Warmup) ? "out" : "playing";
}
export function adminSnapshot(): AdminLobby[] {
  return eventLobbies().map((l) => {
    const ev = l.event!, m = l.match;
    let humans = 0; if (m) for (const p of m.players) if (!p.bot) humans++;
    return {
      code: l.code, name: ev.name, mode: l.mode, cap: ev.cap, teams: teamsOf(l), locked: ev.locked, teamsLocked: ev.teamsLocked,
      casters: ev.casters, casterCount: l.casters.length, createdAt: ev.createdAt, round: ev.round,
      match: m ? { phase: m.phase, alive: m.aliveCount(), squads: m.squadsLeft(), time: Math.round(m.time), humans } : null,
      players: l.clients.map((c) => ({ id: c.uid, name: c.name, team: l.mode === "trios" ? c.ev?.team ?? -1 : -1, state: playerState(l, c),
        ping: Math.round(c.sock.rtt), joinedAt: c.ev?.joinedAt ?? 0, renamed: !!c.ev?.renamed })),
      kicked: ev.kicked.map((k) => ({ kid: k.kid, name: k.name, at: k.at })),
    };
  });
}

type Res = { ok: boolean; msg: string; code?: string };
const ok = (msg: string, code?: string): Res => ({ ok: true, msg, code });
const no = (msg: string): Res => ({ ok: false, msg });
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isMode = (v: unknown): v is Mode => v === "solo" || v === "trios";

/** one admin action (already authenticated: server/admin/http.ts checks the session for every message) */
export function adminAction(act: Record<string, unknown>): Res {
  const a = act.a;
  if (a === "create") {
    if (eventLobbies().length >= MAX_EVENT_LOBBIES) return no(`AT MOST ${MAX_EVENT_LOBBIES} LOBBIES`);
    if (!isMode(act.mode)) return no("PICK SOLO OR TRIOS");
    const name = cleanEventName(act.name) || "KONG ROYALE EVENT";
    let code = ""; do code = host.newCode(6); while (host.lobbies.has(code));
    const l = host.newLobby(code, act.mode);
    l.event = { name, cap: clampCap(act.cap), locked: false, teamsLocked: false, casters: false, createdAt: Date.now(), round: 0, known: new Map(), kicked: [], seats: new Map() };
    host.lobbies.set(code, l);
    host.log(`event ${code}: created "${name}" (${l.mode}, cap ${l.event.cap})`);
    eventsDirty();
    return ok(`LOBBY ${code} CREATED`, code);
  }
  const code = typeof act.code === "string" && EVENT_CODE_RE.test(act.code) ? act.code : "";
  const l = code ? host.lobbies.get(code) : undefined;
  if (!l?.event) return no("NO SUCH LOBBY");
  const ev = l.event;
  const findPlayer = (uid: unknown) => (isInt(uid) ? l.clients.find((c) => c.uid === uid) ?? null : null);
  const changed = (msg: string): Res => { l.pushState(); eventsDirty(); return ok(msg, code); };
  switch (a) {
    case "mode": {
      if (!isMode(act.mode)) return no("PICK SOLO OR TRIOS");
      if (l.match) return no("END THE MATCH FIRST");
      l.mode = act.mode; l.assignSquads();
      return changed(`MODE: ${l.mode.toUpperCase()}`);
    }
    case "cap": {
      if (!isInt(act.cap)) return no("BAD CAP");
      ev.cap = clampCap(act.cap); if (!l.match) l.assignSquads();
      return changed(`CAP: ${ev.cap}`);
    }
    case "name": {
      const name = cleanEventName(act.name); if (!name) return no("GIVE THE LOBBY A NAME");
      ev.name = name; return changed("LOBBY RENAMED");
    }
    case "lock": ev.locked = act.on === true; return changed(ev.locked ? "LOBBY LOCKED: NO NEW PLAYERS" : "LOBBY OPEN");
    case "teamlock": ev.teamsLocked = act.on === true; return changed(ev.teamsLocked ? "TEAMS LOCKED" : "TEAMS UNLOCKED");
    case "casters": {
      ev.casters = act.on === true;
      if (!ev.casters) for (const c of [...l.casters]) { host.send(c, { t: "error", msg: "THE HOST CLOSED THE CASTER SEATS" }); l.castLeave(c); }
      return changed(ev.casters ? "CASTER SEATS OPEN" : "CASTER SEATS CLOSED");
    }
    case "move": {
      const c = findPlayer(act.uid); if (!c?.ev) return no("NO SUCH PLAYER");
      if (l.mode !== "trios") return no("SOLO HAS NO TEAMS");
      if (!isInt(act.team) || act.team < -1 || act.team >= teamsOf(l)) return no("NO SUCH TEAM");
      if (act.team >= 0 && act.team !== c.ev.team && teamSize(l, act.team, c) >= EVENT_TEAM_SIZE) return no(`TEAM ${act.team + 1} IS FULL`);
      c.ev.team = act.team; remember(l, c); if (!l.match) l.assignSquads();
      return changed(`${c.name} → ${act.team < 0 ? "NO TEAM" : `TEAM ${act.team + 1}`}${l.match ? " (NEXT MATCH)" : ""}`);
    }
    case "balance": case "shuffle": {
      if (l.mode !== "trios") return no("SOLO HAS NO TEAMS");
      regroup(l, a === "shuffle"); if (!l.match) l.assignSquads();
      return changed(a === "shuffle" ? "TEAMS SHUFFLED" : "TEAMS BALANCED");
    }
    case "kick": {
      const c = findPlayer(act.uid); if (!c?.ev) return no("NO SUCH PLAYER");
      ev.kicked.push({ kid: crypto.randomBytes(6).toString("hex"), name: c.name, at: Date.now(), tok: c.ev.tok, ip: ipHash(c.sock.ip) });
      if (ev.kicked.length > 200) ev.kicked.shift();
      ev.known.delete(c.ev.tok); ev.seats.delete(c.ev.tok);   // (a kicked token never gets its match seat back)
      const name = c.name;
      l.leave(c); c.ev = null; end(c, "kicked");
      host.log(`event ${code}: ${name} kicked`);
      return changed(`${name} KICKED`);
    }
    case "unkick": {
      const i = ev.kicked.findIndex((k) => k.kid === act.kid); if (i < 0) return no("NOT ON THE LIST");
      const [k] = ev.kicked.splice(i, 1);
      return changed(`${k.name} MAY JOIN AGAIN`);
    }
    case "rename": {
      const c = findPlayer(act.uid); if (!c?.ev) return no("NO SUCH PLAYER");
      if (typeof act.name !== "string" || !act.name.trim()) return no("TYPE A NAME");
      const name = cleanName(act.name), was = c.name;
      c.name = name; c.ev.renamed = true; remember(l, c);
      if (l.match && c.pid >= 0 && l.match.players[c.pid]) l.match.players[c.pid].name = name;
      return changed(`${was} IS NOW ${name}`);
    }
    case "start": {
      if (l.match) return no("A MATCH IS ALREADY RUNNING");
      if (!l.clients.length) return no("NOBODY HAS JOINED YET");
      ev.round++; l.start();
      host.log(`event ${code}: START round ${ev.round} (${l.clients.length} players, ${l.mode})`);
      eventsDirty(); return ok(`MATCH ${ev.round} STARTED`, code);
    }
    case "launch": {
      if (!l.match) return no("NO MATCH IS RUNNING");
      if (l.match.phase !== Phase.Warmup) return no("THE PLANE HAS ALREADY LEFT");
      l.match.startNow(); eventsDirty(); return ok("THE PLANE LEAVES NOW", code);
    }
    case "end": {
      if (!l.match) return no("NO MATCH IS RUNNING");
      l.endMatch(); host.log(`event ${code}: END (admin)`);
      eventsDirty(); return ok("MATCH ENDED: EVERYONE IS BACK IN THE LOBBY", code);
    }
    case "close": {
      for (const c of [...l.clients]) { l.leave(c); c.ev = null; end(c, "closed"); }
      for (const c of [...l.casters]) { l.castLeave(c); end(c, "closed"); }
      l.destroy(true);
      host.log(`event ${code}: closed by the admin`);
      eventsDirty(); return ok(`LOBBY ${code} CLOSED`);
    }
    default: return no("UNKNOWN ACTION");
  }
}

/** AUTO-BALANCE (keep friends together, even team sizes) / SHUFFLE (random): the fewest teams that hold everyone
 *  (sizes differ by ≤ 1), numbered from Team 1 */
function regroup(l: Lobby, shuffle: boolean) {
  const T = teamsOf(l), people = l.clients.filter((c) => c.ev);
  const n = Math.min(people.length, T * EVENT_TEAM_SIZE); if (!n) return;
  const k = Math.ceil(n / EVENT_TEAM_SIZE), base = Math.floor(n / k), extra = n % k;
  const size = Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
  const out: Client[][] = Array.from({ length: k }, () => []);
  let pool: Client[];
  if (shuffle) {
    pool = people.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  } else {
    // current groups, biggest first, each into the emptiest bucket that still fits it whole (else split)
    const groups = new Map<number, Client[]>(); pool = [];
    for (const c of people) { if (c.ev!.team >= 0) { const g = groups.get(c.ev!.team) ?? []; g.push(c); groups.set(c.ev!.team, g); } else pool.push(c); }
    for (const g of [...groups.values()].sort((x, y) => y.length - x.length)) {
      let b = -1; for (let i = 0; i < k; i++) if (!out[i].length && size[i] >= g.length && (b < 0 || size[i] < size[b])) b = i;
      if (b < 0) for (let i = 0; i < k; i++) if (size[i] - out[i].length > 0 && (b < 0 || size[i] - out[i].length > size[b] - out[b].length)) b = i;
      if (b < 0) { pool.push(...g); continue; }
      const room = size[b] - out[b].length; out[b].push(...g.slice(0, room)); pool.push(...g.slice(room));
    }
  }
  for (const c of pool) { const b = out.findIndex((o, i) => o.length < size[i]); if (b < 0) break; out[b].push(c); }
  const placed = new Set<Client>();
  out.forEach((o, i) => { for (const c of o) { c.ev!.team = i; placed.add(c); remember(l, c); } });
  for (const c of people) if (!placed.has(c)) { c.ev!.team = -1; remember(l, c); }
}
