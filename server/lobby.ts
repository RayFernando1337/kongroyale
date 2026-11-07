// Lobbies (rooms) on the game server: class Lobby, the Client it holds, and the server's list of open lobbies. Who is
// in which lobby as a player or a caster seat, who owns it, and who holds which match seat all change here.
// server/index.ts owns the sockets and the messages, and calls initLobbies once with the world it built; the
// verify-room-lifecycle model (tools/formal) and tools/lobby/membership.test.mts check the rules this file keeps.
import { WebSocket } from "ws";
import type { WsTransport } from "./transport-ws";
import type { WtTransport } from "./transport-wt";
import type { Transport, WtArm } from "../shared/net/transport";
import type { Bucket } from "./limits";
import type { StaticWorld } from "../shared/sim/world";
import { Match, Phase } from "../shared/sim/match";
import { alive } from "../shared/sim/player";
import { DT, MAX_PLAYERS, SQUAD_SIZE } from "../shared/sim/const";
import { MatchHost, matchInfo, type HostPeer } from "../shared/net/host";
import { trackInputGaps, type InputGapReport } from "../shared/net/input-gaps";
// (voice) squad comms + caster listen-in: the WebRTC handshake relay (the audio is peer to peer)
import { voiceReset, voiceRosters, voiceSeatLeft } from "./voice";
import { assignEventSquads, eventRoom, eventSeatOf, eventSeated, eventsDirty, type EventMember, type EventState } from "./admin/events";

/** commentator seats per lobby (client/src/caster) */
const MAX_SEATS = 8;
const AFK_IN_MATCH_MS = Number(process.env.KR_AFK_S) > 0 ? Number(process.env.KR_AFK_S) * 1000 : 180_000;   // seated in a running match without sending a single input (KR_AFK_S: test servers only)

/** what a lobby needs from the server around it (server/index.ts): the island its matches run on, the log, and the
 *  tick-time recorder (null when off) */
export interface LobbyHost { world: StaticWorld; log: (...a: unknown[]) => void; perf: { record(ms: number): void } | null }
let server: LobbyHost;
export function initLobbies(h: LobbyHost) { server = h; }

export interface Sock extends Bucket { ws: WebSocket; ip: string;
  /** (admin lobby) round trip of the server's own ws pings, ms (0 = none yet) */
  rtt: number;
  /** liveness + the disconnect log: when it opened, its last pong (Date.now ms), and who closed it when the
   *  SERVER did ("" = nobody yet: then the client did, or the link died) */
  openedAt: number; lastPong: number; closedBy: string }
export const sendJSON = (ws: WebSocket, o: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

export interface Client { uid: number; token: string; name: string; lobby: Lobby | null; pid: number; squad: number; sock: Sock; aux: Sock[];
  /** the binary transports: the WebSocket pair (always), the WebTransport session (KR_WT=1, when the client opened one)
   *  and the one that carries the hot path now (the session while it lives, else the pair) */
  ws: WsTransport; wt: WtTransport | null; bin: Transport; lastInputAt: number;
  /** removed from its match for inactivity and not seated since (housekeeping): a host role it holds goes to the first
   *  room member who presses START (Lobby.claimHost) */
  away: boolean; peer: HostPeer; /** last relayed map marker (ms) */ markAt: number;
  /** (caster) a commentator seat in its lobby (−1 = a player); the last relayed camera sync (ms) */
  seat: number; camAt: number;
  /** (caster) a PROGRAM output window (OBS): a seat that only mirrors the seat on air */
  program: boolean;
  /** (admin lobby) a player in an event lobby (server/admin/events.ts), else null */
  ev: EventMember | null;
  /** its WebTransport A/B arm, as its link reported it ({ t: "net" }); null until then */
  arm: WtArm | null }

export class Lobby {
  /** (admin lobby) an event lobby the admin runs (server/admin/events.ts): no player is ever its host, it stays open
   *  without players, its teams are explicit. null = a normal lobby */
  event: EventState | null = null;
  clients: Client[] = []; match: Match | null = null; host: MatchHost | null = null;
  /** the running match's input-pacing counters (/health) */
  inputGaps: { report(): InputGapReport } | null = null; timer: NodeJS.Timeout | null = null; acc = 0; last = 0; errors = 0;
  /** (caster) commentator seats: no player slot, any time (even mid-match), up to MAX_SEATS */
  casters: Client[] = [];
  /** (caster) an exhibition: made by a caster to watch bots (humans may still join it); `auto` = START again 12 s after
   *  each match while a seat is there */
  exhibit = false; auto = false; private autoTimer: NodeJS.Timeout | null = null;
  /** (caster) the seat whose camera is ON AIR — what every PROGRAM window shows (−1 = none: the producer's own) */
  onAir = -1;
  seed = (Math.random() * 2 ** 31) | 0;
  constructor(readonly code: string, public owner: Client, public mode: "solo" | "trios") {}
  broadcastJSON(o: unknown) { const s = JSON.stringify(o); for (const c of this.clients) if (c.sock.ws.readyState === WebSocket.OPEN) c.sock.ws.send(s); for (const c of this.casters) if (c.sock.ws.readyState === WebSocket.OPEN) c.sock.ws.send(s); }
  /** casters only (seat roster, camera sync) */
  castJSON(o: unknown, except: Client | null = null) { const s = JSON.stringify(o); for (const c of this.casters) if (c !== except && c.sock.ws.readyState === WebSocket.OPEN) c.sock.ws.send(s); }
  state() {
    return { t: "lobby", code: this.code, mode: this.mode, host: this.owner.uid, hostAway: this.owner.away, inMatch: !!this.match, phase: this.match?.phase ?? -1,
      players: this.clients.map((c) => ({ id: c.uid, name: c.name, squad: c.squad, pid: c.pid, host: c === this.owner })),
      casters: this.casters.map((c) => ({ id: c.uid, name: c.name, seat: c.seat, host: c === this.owner, program: c.program })), exhibit: this.exhibit, auto: this.auto, onAir: this.onAir,
      ...(this.event ? { ev: eventRoom(this) } : {}) };
  }
  /** the room to everyone. (admin lobby) An event lobby coalesces (≤ 10 / s: a join storm or a team-click storm must not
   *  be n² roster frames) and tells the admin console */
  private stateTimer: NodeJS.Timeout | null = null;
  pushState(now = false) {
    if (!this.event) { this.broadcastJSON(this.state()); return; }
    eventsDirty();
    if (now) { if (this.stateTimer) clearTimeout(this.stateTimer); this.stateTimer = null; this.broadcastJSON(this.state()); return; }
    if (!this.stateTimer) this.stateTimer = setTimeout(() => { this.stateTimer = null; if (lobbies.get(this.code) === this) this.broadcastJSON(this.state()); }, 100);
  }
  /** (caster) take a commentator seat: the match (if one runs) arrives at once, whatever its phase */
  castJoin(c: Client) {
    if (this.casters.includes(c)) return;
    if (this.casters.length >= MAX_SEATS) { sendJSON(c.sock.ws, { t: "error", msg: "ALL CASTER SEATS TAKEN" }); return; }
    const taken = new Set(this.casters.map((q) => q.seat)); let seat = 0; while (taken.has(seat)) seat++;
    this.casters.push(c); c.lobby = this; c.seat = seat; c.pid = -1; c.peer.pid = -1; c.peer.caster = true;
    if (this.match && this.host) { this.host.peers.push(c.peer); sendJSON(c.sock.ws, { ...matchInfo(this.match, this.seed, {}), caster: true, seat }); this.host.sendCastStats(c.peer); }
    server.log(`lobby ${this.code}: caster seat ${seat + 1} → ${c.name}`);
    this.pushState();
  }
  castLeave(c: Client) {
    const i = this.casters.indexOf(c); if (i < 0) return;
    if (this.onAir === c.seat) this.onAir = -1;
    voiceSeatLeft(this, c.seat);   // (voice) its listen-ins end
    this.casters.splice(i, 1); c.lobby = null; c.seat = -1; c.peer.caster = false;
    if (this.host) { const k = this.host.peers.indexOf(c.peer); if (k >= 0) this.host.peers.splice(k, 1); }
    if (!this.clients.length && !this.casters.length && !this.event) { this.destroy(); return; }
    // (admin lobby) an event lobby's owner is the admin's stand-in: it never passes to a player or a seat
    if (this.owner === c && !this.event) this.owner = this.clients[0] ?? this.casters[0];
    this.pushState();
  }
  /** `final` (START): an event lobby places its unassigned players */
  assignSquads(final = false) {
    if (this.event) { assignEventSquads(this, final); return; }
    const size = SQUAD_SIZE[this.mode]; this.clients.forEach((c, i) => { c.squad = Math.floor(i / size); });
  }
  start() {
    if (this.match) return;
    if (this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer = null; }
    this.assignSquads(true);
    if (this.event) this.pushState(true);   // (the room shows the final teams before the match frame lands)
    const seated = this.clients.slice(0, MAX_PLAYERS);
    const humans = seated.map((c, i) => ({ id: i, name: c.name, team: c.squad }));
    this.seed = (Math.random() * 2 ** 31) | 0;                  // a new island roll every match
    const m = this.match = new Match({ seed: this.seed, mode: this.mode, world: server.world, humans, botDifficulty: "easy" });   // bots on EASY online
    m.endAfterResults = true;
    if (Number(process.env.KR_WARMUP_S) > 0) m.warmupS = Number(process.env.KR_WARMUP_S);   // (test servers only)
    this.inputGaps = trackInputGaps(m);
    const h = this.host = new MatchHost(m); h.holdForStream();
    seated.forEach((c, i) => { c.pid = i; c.away = false; c.peer.pid = i; c.peer.opSeq = -1; c.lastInputAt = Date.now(); h.peers.push(c.peer); });
    if (this.event) { this.event.seats.clear(); for (const c of seated) eventSeated(this, c); }   // a dropped player's seat
    for (const c of this.casters) h.peers.push(c.peer);
    m.onPhase = (ph) => { this.broadcastJSON({ t: "phase", phase: ph, plane: m.plane, time: m.time, tick: m.tick, plan: m.plan }); if (this.event) eventsDirty(); };
    const info = matchInfo(m, this.seed, Object.fromEntries(seated.map((c) => [c.uid, c.pid])));
    { const s = JSON.stringify(info); for (const c of this.clients) if (c.sock.ws.readyState === WebSocket.OPEN) c.sock.ws.send(s); }
    for (const c of this.casters) sendJSON(c.sock.ws, { ...info, pids: {}, caster: true, seat: c.seat });
    for (const c of seated) h.sendInventory(c.peer);
    for (const c of this.casters) h.sendCastStats(c.peer);
    voiceRosters(this);   // (voice) each squad's comms roster for the new match
    this.last = performance.now(); this.acc = 0;
    this.timer = setInterval(() => this.pump(), 4);
    server.log(`lobby ${this.code}: match started (${seated.length} humans, ${this.casters.length} casters, ${this.mode}${this.exhibit ? ", exhibition" : ""})`);
  }
  pump() {
    const h = this.host; if (!h) return;
    try {
      const now = performance.now();
      this.acc += Math.min(0.25, (now - this.last) / 1000); this.last = now;
      let n = 0;
      while (this.acc >= DT && n++ < 6) {
        this.acc -= DT;
        const tickStart = server.perf ? performance.now() : 0;
        h.tick();
        if (server.perf) server.perf.record(performance.now() - tickStart);
        if (h.m.over) { server.log(`lobby ${this.code}: match over → room`); this.endMatch(); return; }
        if (h.m.tick % 600 === 0) this.housekeeping();
      }
      h.frac = this.acc / DT;
    } catch (e) {
      server.log(`lobby ${this.code}: tick error`, e);
      if (++this.errors > 5) { this.broadcastJSON({ t: "error", msg: "MATCH CRASHED — back to the lobby" }); this.endMatch(); }
    }
  }
  /** every 10 s: lobby roster refresh + AFK seats become bots */
  housekeeping() {
    this.pushState();
    const now = Date.now();
    for (const c of [...this.clients]) {
      if (c.pid < 0 || now - c.lastInputAt <= AFK_IN_MATCH_MS) continue;
      // only a seat still in play can be AFK. One that is out (dead, spectating, eliminated) has nothing
      // to steer — and its player may be back in the room already (BACK TO LOBBY stops the inputs)
      const p = this.match?.players[c.pid]; if (!p || p.eliminated || !alive(p)) continue;
      // the lobby keeps its player: a bot plays the seat on, and the player waits in the room for the next match (afk: the
      // client goes back to the room and keeps the reason on screen). A normal lobby's host role passes on, so the others
      // can START without them: at once to a seated player who is playing (an input in the AFK window), else the role stays
      // with the away host and the first room member to press START takes it (claimHost). Who else is idle is not known
      // here, so the sweep never guesses
      c.away = true;
      if (!this.event && this.owner === c) this.owner = this.clients.find((o) => o !== c && o.pid >= 0 && now - o.lastInputAt <= AFK_IN_MATCH_MS) ?? c;
      this.unseat(c); sendJSON(c.sock.ws, { t: "error", msg: "REMOVED FOR INACTIVITY", afk: true });
    }
  }
  /** (AFK) out of the match, still in the room: the seat becomes a bot (as when its player leaves) */
  private unseat(c: Client) {
    if (this.host) { const k = this.host.peers.indexOf(c.peer); if (k >= 0) this.host.peers.splice(k, 1); }
    if (this.match && c.pid >= 0) this.match.releaseHuman(c.pid);
    c.pid = -1; c.peer.pid = -1;
    server.log(`lobby ${this.code}: ${c.name} AFK in the match → a bot plays the seat, the player stays in the room`);
    voiceRosters(this); this.pushState();
  }
  /** (normal lobby) START from a room member while the host is away (removed for inactivity, not seated since): the role
   *  passes to that member, so an idle host never locks the room */
  claimHost(c: Client) {
    if (this.event || this.owner === c || !this.owner.away || !this.clients.includes(c)) return;
    this.owner = c; this.pushState();
  }
  join(c: Client) {
    if (this.clients.includes(c)) return;
    if (this.clients.length >= MAX_PLAYERS) { sendJSON(c.sock.ws, { t: "error", msg: "LOBBY FULL" }); return; }
    this.clients.push(c); c.lobby = this; c.pid = -1; c.away = false; c.peer.pid = -1;
    if (this.match && this.host) {
      const m = this.match;
      // back after a dropped link (event lobby, the SAME session token): your own seat again while it still
      // plays (a bot took it over, not dead, not eliminated, nobody else holds it) — any phase but the results
      const back = this.event ? eventSeatOf(this, c) : -1;
      if (back >= 0 && m.phase !== Phase.Results && !this.clients.some((q) => q !== c && q.pid === back) && m.reclaimHuman(back, c.name)) {
        c.pid = back; server.log(`event ${this.code}: ${c.name} is back in their match seat (phase ${m.phase})`);
      }
      // late joiner: take a bot seat (only while warming up / in plane)
      else if (m.phase === Phase.Warmup || m.phase === Phase.Plane) {
        const squadOf = this.clients.filter((q) => q !== c && q.pid >= 0).map((q) => m.teamOf(q.pid));
        const want = this.mode === "solo" ? -1 : (squadOf.find((t) => this.clients.filter((q) => q.pid >= 0 && m.teamOf(q.pid) === t).length < 3) ?? -1);
        c.pid = m.claimBot(c.name, want);
        if (c.pid < 0) sendJSON(c.sock.ws, { t: "error", msg: "MATCH FULL" });
      } else sendJSON(c.sock.ws, { t: "error", msg: "MATCH IN PROGRESS — wait for the next round" });
      if (c.pid >= 0) { c.peer.pid = c.pid; c.peer.invSeq = 0; c.peer.opSeq = -1; c.lastInputAt = Date.now(); this.host.peers.push(c.peer); sendJSON(c.sock.ws, matchInfo(m, this.seed, { [c.uid]: c.pid })); this.host.sendInventory(c.peer); voiceRosters(this); eventSeated(this, c); }
    } else this.assignSquads();
    // (the joiner sees the room at once; the others with the next coalesced roster)
    if (this.event) sendJSON(c.sock.ws, this.state());
    this.pushState();
  }
  leave(c: Client) {
    const i = this.clients.indexOf(c); if (i < 0) return;
    this.clients.splice(i, 1); c.lobby = null;
    if (this.host) { const k = this.host.peers.indexOf(c.peer); if (k >= 0) this.host.peers.splice(k, 1); }
    if (this.match && c.pid >= 0) this.match.releaseHuman(c.pid);
    c.pid = -1; c.peer.pid = -1;
    if (!this.clients.length && !this.casters.length && !this.event) { this.destroy(); return; }
    if (this.owner === c && !this.event) this.owner = this.clients[0] ?? this.casters[0];
    if (!this.match) this.assignSquads(); else voiceRosters(this);
    this.pushState();
  }
  /** stop the match loop but keep the lobby (crash recovery) */
  endMatch() {
    if (this.event) this.event.seats.clear();   // no match, no seat to come back to
    if (this.timer) clearInterval(this.timer); this.timer = null; this.match = null; this.host = null; for (const c of this.clients) { c.pid = -1; c.peer.pid = -1; c.peer.invSeq = 0; c.peer.opSeq = -1; } this.errors = 0; this.assignSquads(); this.pushState(true); voiceReset(this);
    // (caster) an exhibition on AUTO rolls the next match while a seat watches
    if (this.auto && this.casters.length) { if (this.autoTimer) clearTimeout(this.autoTimer); this.autoTimer = setTimeout(() => { this.autoTimer = null; if (lobbies.get(this.code) === this && this.casters.length && !this.match) this.start(); }, 12_000); }
  }
  /** an event lobby closes only when the admin says so (`force`) */
  destroy(force = false) { if (this.event && !force) return; if (this.stateTimer) clearTimeout(this.stateTimer); this.stateTimer = null; if (this.timer) clearInterval(this.timer); this.timer = null; if (this.autoTimer) clearTimeout(this.autoTimer); this.autoTimer = null; this.match = null; this.host = null; lobbies.delete(this.code); server.log(`lobby ${this.code} closed`); }
}
/** the open lobbies by code: a lobby is in here from its creation until destroy() */
export const lobbies = new Map<string, Lobby>();
/** out of whatever lobby the client is in, as a player or as a caster seat */
export function leaveLobby(c: Client) { if (c.seat >= 0) c.lobby?.castLeave(c); else c.lobby?.leave(c); }
