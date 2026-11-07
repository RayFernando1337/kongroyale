// Admin console (bundle dist-admin/console.js: the server serves it ONLY to a request with a valid admin session).
// A remote control: every action goes to the server over /admin/ws and the server decides
// (shared/net/event.ts). The screen shows only what the state messages carry: lobby + player names, teams, ping,
// phase. No keys, tokens, cookies or addresses exist on this page. Player-controlled strings are set with textContent.
import type { AdminLobby, AdminServerMsg } from "../../../shared/net/event";
import { EVENT_CAP_DEFAULT, EVENT_CAP_MAX, EVENT_CAP_MIN, EVENT_NAME_MAX } from "../../../shared/net/event";
import { TOON_LOGO } from "../ui/toon";
import { addStyle, adminChip, adminUrl, ensureToon, h, icon, safeNote, setBusy, setOff, spinner } from "./common";
import { confirmBox, modal } from "./dialog";
import { Roster } from "./roster";
import type { Ack, ActBody, Ctx } from "./ctx";
import { CONSOLE_CSS } from "./console-styles";
import { qrSvg } from "./qr";
import { ReportsView } from "./reports";

const PHASES = ["Warm-up", "In the plane", "In play", "Results"];
const ACK_TIMEOUT_MS = 10_000;
const mmss = (s: number) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, "0")}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
/** the public player link for a lobby code: `…/admin` → `…/?e=CODE` */
const playerLink = (code: string) => adminUrl("./?e=" + encodeURIComponent(code));

// ==================================================================== connection + actions
type Conn = "connecting" | "live" | "reconnecting";
interface Pending { key: string; resolve: (a: Ack) => void; timer: number }

class Net implements Ctx {
  ws: WebSocket | null = null;
  conn: Conn = "connecting";
  private nextId = 1;
  private tries = 0;
  private pending = new Map<number, Pending>();
  private keys = new Map<string, number>();

  constructor(private app: App) {}

  connect(): void {
    const u = new URL(adminUrl("admin/ws"));
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    let opened = false;
    let ws: WebSocket;
    try { ws = new WebSocket(u.href); } catch { this.retry(); return; }
    this.ws = ws;
    ws.onopen = () => { opened = true; this.tries = 0; this.setConn("live"); };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data.length > 4_000_000) return;
      let m: AdminServerMsg;
      try { m = JSON.parse(e.data); } catch { return; }
      this.onMsg(m);
    };
    ws.onclose = (e) => {
      if (this.ws === ws) this.ws = null;
      this.failAll("Lost the connection before the server answered. Check the screen once it's live again.");
      if (e.code === 4401) { location.reload(); return; }
      if (!opened) {
        // refused at the upgrade: an ended session gets the login, anything else retries
        fetch(adminUrl("admin/api/session"), { credentials: "same-origin", cache: "no-store" })
          .then((r) => { if (r.status === 401) location.reload(); else this.retry(); }, () => this.retry());
        this.setConn("reconnecting");
        return;
      }
      this.retry();
    };
  }
  private retry(): void {
    this.setConn("reconnecting");
    const wait = Math.min(5000, 1000 * 2 ** this.tries++);
    setTimeout(() => this.connect(), wait);
  }
  private setConn(c: Conn): void { if (this.conn !== c) { this.conn = c; this.app.renderConn(); } }

  private onMsg(m: AdminServerMsg): void {
    if (!m || typeof m !== "object") return;
    if (m.t === "state" && Array.isArray(m.lobbies)) this.app.onState(m.lobbies, !!m.eventMode);
    else if (m.t === "ack" && typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.settle(m.id, { ok: !!m.ok, msg: typeof m.msg === "string" ? m.msg : "", code: typeof m.code === "string" ? m.code : undefined });
    } else if (m.t === "bye") location.reload();
  }
  private settle(id: number, a: Ack): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (this.keys.get(p.key) === id) this.keys.delete(p.key);
    if (a.msg) this.toast(a.msg, a.ok ? "ok" : "err");
    else if (!a.ok) this.toast("The server refused that.", "err");
    p.resolve(a);
    this.app.render();
  }
  private failAll(msg: string): void {
    const ids = [...this.pending.keys()];
    if (ids.length) this.toast(msg, "err");
    for (const id of ids) {
      const p = this.pending.get(id)!;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ ok: false, msg });
    }
    this.keys.clear();
    if (ids.length) this.app.render();
  }

  act(key: string, body: ActBody): Promise<Ack> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.toast("Not connected. Try again when the console shows Live.", "err");
      return Promise.resolve({ ok: false, msg: "not connected" });
    }
    if (this.keys.has(key)) return Promise.resolve({ ok: false, msg: "busy" });
    const id = this.nextId++;
    return new Promise<Ack>((resolve) => {
      const timer = window.setTimeout(() => this.settle(id, { ok: false, msg: "No answer from the server. Check the screen before trying again." }), ACK_TIMEOUT_MS);
      this.pending.set(id, { key, resolve, timer });
      this.keys.set(key, id);
      this.ws!.send(JSON.stringify({ t: "act", id, ...body }));
      this.app.render();
    });
  }
  busy(key: string): boolean { return this.keys.has(key); }
  toast(msg: string, tone: "ok" | "err" = "ok"): void { this.app.toast(msg, tone); }
}

// ==================================================================== small controls
function seg(labels: Array<[string, string]>, onPick: (v: string) => void): { el: HTMLElement; set: (v: string, off: boolean) => void } {
  const el = h("div", "tn-seg tn-adm-seg");
  el.setAttribute("role", "group");
  const btns = labels.map(([v, text]) => {
    const b = h("button", "", text);
    b.type = "button"; b.dataset.v = v;
    b.addEventListener("click", () => { if (b.getAttribute("aria-pressed") !== "true") onPick(v); });
    el.append(b);
    return b;
  });
  return { el, set: (v, off) => { for (const b of btns) { b.setAttribute("aria-pressed", String(b.dataset.v === v)); b.disabled = off; } } };
}

function sw(label: string, help: string, onFlip: (on: boolean) => void) {
  const row = h("div", "tn-tile tn-adm-row");
  const txt = h("div", "tn-adm-rowtxt");
  const lab = h("span", "tn-label", label);
  const sup = h("span", "tn-support", help);
  txt.append(lab, sup);
  const b = h("button", "tn-switch tn-adm-sw");
  b.type = "button";
  b.setAttribute("role", "switch");
  const id = "tn-adm-sw-" + Math.random().toString(36).slice(2, 8);
  lab.id = id;
  b.setAttribute("aria-labelledby", id);
  const state = h("span", "tn-adm-swtxt");
  b.append(spinner(), h("span", "sw"), state);
  b.addEventListener("click", () => onFlip(b.getAttribute("aria-checked") !== "true"));
  row.append(txt, b);
  return {
    row, sup,
    set(on: boolean, busy: boolean, off = false) {
      b.setAttribute("aria-checked", String(on));
      state.textContent = on ? "On" : "Off";
      setBusy(b, busy);
      setOff(b, off);
      row.classList.toggle("is-disabled", off);
    },
  };
}

// ==================================================================== create a lobby
class CreateView {
  readonly el = h("section", "tn-panel tn-adm-create");
  private name = h("input", "tn-adm-input");
  private mode: "trios" | "solo" = "trios";
  private cap = EVENT_CAP_DEFAULT;
  private capV = h("span", "v tn-num");
  private modeSeg;
  private go = h("button", "tn-btn tn-btn--primary tn-btn--big tn-adm-go");
  private cancel = h("button", "tn-btn tn-btn--tertiary", "Cancel");
  private eyebrow = h("p", "tn-eyebrow", "No lobby yet");

  constructor(private ctx: Ctx, private onDone: (code: string | null) => void) {
    const title = h("h2", "tn-adm-bigtitle", "Create a lobby");
    const intro = h("p", "tn-body tn-adm-cintro", "Make a lobby, copy its link and send it to your players. You control the teams and when the game starts.");
    // name
    const nRow = h("div", "tn-tile tn-adm-row tn-adm-row--stack");
    const nLab = h("label", "tn-label", "Lobby name");
    this.name.id = "tn-adm-cname"; nLab.htmlFor = this.name.id;
    this.name.maxLength = EVENT_NAME_MAX; this.name.placeholder = "Kong Royale Event"; this.name.autocomplete = "off"; this.name.spellcheck = false;
    nRow.append(nLab, this.name);
    // mode
    const mRow = h("div", "tn-tile tn-adm-row");
    const mLab = h("span", "tn-label", "Mode");
    this.modeSeg = seg([["trios", "Trios"], ["solo", "Solo"]], (v) => { this.mode = v as "trios" | "solo"; this.paint(); });
    this.modeSeg.el.setAttribute("aria-label", "Mode");
    mRow.append(mLab, this.modeSeg.el);
    // cap
    const cRow = h("div", "tn-tile tn-adm-row");
    const cLab = h("span", "tn-label", "Player cap");
    const cyc = this.cycle((d) => { this.cap = Math.max(EVENT_CAP_MIN, Math.min(EVENT_CAP_MAX, this.cap + d)); this.paint(); }, this.capV, "Player cap");
    cRow.append(cLab, cyc);
    const bots = h("p", "tn-support tn-adm-note");
    bots.append(icon("user"), h("span", "", "Bots fill the empty seats."));

    this.go.type = "button";
    this.go.append(h("span", "", "Create lobby"), spinner());
    this.go.addEventListener("click", () => void this.submit());
    this.name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void this.submit(); } });
    this.cancel.type = "button";
    this.cancel.addEventListener("click", () => this.onDone(null));
    const acts = h("div", "tn-adm-cacts");
    acts.append(this.cancel, this.go);
    this.el.append(this.eyebrow, title, intro, nRow, mRow, cRow, bots, acts);
    this.paint();
  }

  cycle(step: (d: number) => void, v: HTMLElement, label: string): HTMLElement {
    const c = h("div", "tn-cycle tn-adm-cycle");
    c.setAttribute("role", "group");
    c.setAttribute("aria-label", label);
    const dn = h("button", "", "‹"), up = h("button", "", "›");
    dn.type = up.type = "button";
    dn.setAttribute("aria-label", "Fewer"); up.setAttribute("aria-label", "More");
    dn.addEventListener("click", () => step(-1));
    up.addEventListener("click", () => step(1));
    c.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); step(-1); }
      if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); step(1); }
    });
    c.append(dn, v, up);
    return c;
  }

  reset(hasLobbies: boolean): void {
    this.name.value = ""; this.mode = "trios"; this.cap = EVENT_CAP_DEFAULT;
    this.cancel.hidden = !hasLobbies;
    this.eyebrow.textContent = hasLobbies ? "New lobby" : "No lobby yet";
    this.paint();
  }
  setHasLobbies(has: boolean): void { this.cancel.hidden = !has; this.eyebrow.textContent = has ? "New lobby" : "No lobby yet"; }
  focus(): void { this.name.focus(); }
  paint(): void {
    this.modeSeg.set(this.mode, false);
    this.capV.textContent = `${this.cap} players`;
    setBusy(this.go, this.ctx.busy("create"));
  }
  private async submit(): Promise<void> {
    if (this.ctx.busy("create")) return;
    const name = this.name.value.trim().slice(0, EVENT_NAME_MAX) || this.name.placeholder;
    const a = await this.ctx.act("create", { a: "create", name, mode: this.mode, cap: this.cap });
    if (a.ok) this.onDone(a.code ?? null);
  }
}

// ==================================================================== one lobby
class LobbyView {
  readonly el = h("div", "tn-adm-lobby");
  private l!: AdminLobby;
  private roster: Roster;
  // link
  private linkText = h("span", "tn-adm-link");
  private codeChip = h("span", "tn-key tn-key--accent tn-adm-code");
  private copyBtn = h("button", "tn-btn tn-adm-copy");
  private copyLbl = h("span", "", "Copy link");
  private qrBtn = h("button", "tn-btn");
  private openA = h("a", "tn-btn");
  // match
  private phase = h("span", "tn-badge tn-adm-phase");
  private status = h("span", "tn-label tn-adm-status");
  private startBtn = h("button", "tn-btn tn-btn--primary tn-btn--big tn-adm-start");
  private launchBtn = h("button", "tn-btn tn-btn--primary tn-btn--big tn-adm-start tn-adm-launch");
  private endBtn = h("button", "tn-btn tn-btn--danger tn-adm-end");
  private clock = { time: 0, at: 0, run: false };
  // settings
  private nameIn = h("input", "tn-adm-input tn-adm-lname");
  private nameHint = h("span", "tn-support tn-adm-namehint");
  private modeSeg;
  private modeWhy = h("span", "tn-support");
  private capV = h("span", "v tn-num");
  private capDraft: number | null = null;
  private capTimer = 0;
  private lockSw; private teamSw; private castSw;
  private closeBtn = h("button", "tn-btn tn-btn--tertiary tn-adm-close");

  constructor(readonly code: string, private ctx: Ctx, private onCopy: (text: string) => Promise<boolean>) {
    // ---------------- link card
    const link = h("section", "tn-panel tn-adm-card tn-adm-linkcard");
    const lTop = h("div", "tn-adm-ctop");
    this.copyBtn.type = this.qrBtn.type = "button";
    this.copyBtn.append(icon("copy", "cico"), icon("check", "cok"), this.copyLbl);
    this.qrBtn.append(icon("qr"), h("span", "", "QR code"));
    this.qrBtn.setAttribute("aria-pressed", "false");
    this.openA.append(icon("open"), h("span", "", "Open as player"));
    this.openA.target = "_blank";
    this.openA.rel = "noopener noreferrer";
    this.qrBtn.classList.add("tn-adm-sm", "tn-adm-qrbtn"); this.openA.classList.add("tn-adm-sm");
    const btns = h("div", "tn-adm-linkbtns");
    btns.append(this.qrBtn, this.openA);
    lTop.append(h("span", "tn-eyebrow", "Player link"), h("span", "tn-support tn-adm-ctopnote", "Send this to your players"), this.codeChip, btns);
    const lRow = h("div", "tn-adm-linkrow");
    lRow.append(this.linkText, this.copyBtn);
    link.append(lTop, lRow);
    this.copyBtn.addEventListener("click", async () => {
      const ok = await this.onCopy(playerLink(this.l.code));
      if (!ok) return;
      this.copyBtn.classList.add("is-done");
      this.copyLbl.textContent = "Copied!";
      setTimeout(() => { this.copyBtn.classList.remove("is-done"); this.copyLbl.textContent = "Copy link"; }, 2000);
    });
    this.qrBtn.addEventListener("click", () => this.showQr());

    // ---------------- match card
    const match = h("section", "tn-panel tn-adm-card tn-adm-matchcard");
    const mTop = h("div", "tn-adm-ctop");
    mTop.append(h("span", "tn-eyebrow", "Match"), this.phase, this.status);
    const mRow = h("div", "tn-adm-matchrow");
    this.startBtn.type = this.launchBtn.type = this.endBtn.type = "button";
    this.startBtn.append(h("span", "", "Start game"), spinner());
    this.launchBtn.append(h("span", "", "Launch plane now"), spinner());
    this.endBtn.append(icon("x"), h("span", "", "End game"), spinner());
    mRow.append(this.startBtn, this.launchBtn, this.endBtn);
    match.append(mTop, mRow);
    this.startBtn.addEventListener("click", () => void ctx.act(`${this.code}:start`, { a: "start", code: this.code }));
    this.launchBtn.addEventListener("click", () => void ctx.act(`${this.code}:launch`, { a: "launch", code: this.code }));
    this.endBtn.addEventListener("click", async () => {
      const ok = await confirmBox({ title: "End the match?", body: "Everyone returns to the lobby. Teams are kept.", ok: "End game", danger: true });
      if (ok) void ctx.act(`${this.code}:end`, { a: "end", code: this.code });
    });

    // ---------------- settings card
    const set = h("section", "tn-panel tn-adm-card tn-adm-settings");
    set.append(h("h2", "tn-eyebrow tn-adm-shead", "Lobby settings"));
    const nRow = h("div", "tn-tile tn-adm-row tn-adm-row--stack");
    const nLab = h("label", "tn-label", "Lobby name");
    this.nameIn.id = `tn-adm-lname-${code}`; nLab.htmlFor = this.nameIn.id;
    this.nameIn.maxLength = EVENT_NAME_MAX; this.nameIn.autocomplete = "off"; this.nameIn.spellcheck = false;
    const nTop = h("div", "tn-adm-rowtop");
    nTop.append(nLab, this.nameHint);
    nRow.append(nTop, this.nameIn);
    const saveName = () => {
      const v = this.nameIn.value.trim().slice(0, EVENT_NAME_MAX);
      if (!v || v === this.l.name) { this.nameIn.value = this.l.name; this.paintNameHint(); return; }
      void ctx.act(`${this.code}:name`, { a: "name", code: this.code, name: v });
    };
    this.nameIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveName(); }
      if (e.key === "Escape") { e.preventDefault(); this.nameIn.value = this.l.name; this.paintNameHint(); }
    });
    this.nameIn.addEventListener("blur", saveName);
    this.nameIn.addEventListener("input", () => this.paintNameHint());

    const mdRow = h("div", "tn-tile tn-adm-row");
    const mdTxt = h("div", "tn-adm-rowtxt");
    mdTxt.append(h("span", "tn-label", "Mode"), this.modeWhy);
    this.modeSeg = seg([["trios", "Trios"], ["solo", "Solo"]], (v) => void ctx.act(`${this.code}:mode`, { a: "mode", code: this.code, mode: v as "trios" | "solo" }));
    this.modeSeg.el.setAttribute("aria-label", "Mode");
    mdRow.append(mdTxt, this.modeSeg.el);

    const cRow = h("div", "tn-tile tn-adm-row");
    const cyc = h("div", "tn-cycle tn-adm-cycle");
    cyc.setAttribute("role", "group"); cyc.setAttribute("aria-label", "Player cap");
    const dn = h("button", "", "‹"), up = h("button", "", "›");
    dn.type = up.type = "button";
    dn.setAttribute("aria-label", "Fewer"); up.setAttribute("aria-label", "More");
    const step = (d: number) => {
      const base = this.capDraft ?? this.l.cap;
      this.capDraft = Math.max(EVENT_CAP_MIN, Math.min(EVENT_CAP_MAX, base + d));
      this.paintCap();
      clearTimeout(this.capTimer);
      this.capTimer = window.setTimeout(async () => {
        const cap = this.capDraft;
        if (cap === null || cap === this.l.cap) { this.capDraft = null; this.paintCap(); return; }
        await ctx.act(`${this.code}:cap`, { a: "cap", code: this.code, cap });
        if (this.capDraft === cap) this.capDraft = null;
        this.paintCap();
      }, 700);
    };
    dn.addEventListener("click", () => step(-1));
    up.addEventListener("click", () => step(1));
    cyc.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); step(-1); }
      if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); step(1); }
    });
    cyc.append(dn, this.capV, spinner(), up);
    const cTxt = h("div", "tn-adm-rowtxt");
    cTxt.append(h("span", "tn-label", "Player cap"), h("span", "tn-support", "Bots fill the rest"));
    cRow.append(cTxt, cyc);

    this.lockSw = sw("Lock lobby", "No new players can join", (on) => void ctx.act(`${this.code}:lock`, { a: "lock", code: this.code, on }));
    this.teamSw = sw("Lock teams", "Players can't switch teams", (on) => void ctx.act(`${this.code}:teamlock`, { a: "teamlock", code: this.code, on }));
    this.castSw = sw("Caster seats", "Commentators can join", (on) => void ctx.act(`${this.code}:casters`, { a: "casters", code: this.code, on }));

    this.closeBtn.type = "button";
    this.closeBtn.append(icon("x"), h("span", "", "Close lobby"), spinner());
    this.closeBtn.addEventListener("click", async () => {
      const ok = await confirmBox({ title: "Close the lobby?", body: "Everyone is sent away and the link stops working.", ok: "Close lobby", danger: true });
      if (ok) void ctx.act(`${this.code}:close`, { a: "close", code: this.code });
    });
    set.append(nRow, mdRow, cRow, this.lockSw.row, this.teamSw.row, this.castSw.row, this.closeBtn);

    this.roster = new Roster(ctx);
    const top = h("div", "tn-adm-toprow");
    top.append(link, match);
    const bottom = h("div", "tn-adm-botrow");
    bottom.append(set, this.roster.el);
    this.el.append(top, bottom);
  }

  destroy(): void { this.roster.destroy(); clearTimeout(this.capTimer); }

  private paintNameHint(): void {
    const dirty = this.nameIn.value.trim() !== this.l.name && document.activeElement === this.nameIn;
    const busy = this.ctx.busy(`${this.code}:name`);
    this.nameHint.textContent = busy ? "Saving…" : dirty ? "Enter to save · Esc to undo" : "";
  }
  private paintCap(): void {
    const v = this.capDraft ?? this.l.cap;
    this.capV.textContent = `${v} players`;
    const busy = this.ctx.busy(`${this.code}:cap`);
    this.capV.parentElement?.classList.toggle("is-busy", busy);
    this.capV.classList.toggle("is-draft", this.capDraft !== null);
  }

  private showQr(): void {
    const link = playerLink(this.l.code);
    this.qrBtn.setAttribute("aria-pressed", "true");
    const m = modal({ title: "Scan to join", wide: true, onClose: () => this.qrBtn.setAttribute("aria-pressed", "false") });
    const box = h("div", "tn-adm-qr");
    box.innerHTML = qrSvg(link, { dark: "currentColor", light: "transparent", margin: 1 }); // our own link, never player data
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", "QR code of the player link");
    const txt = h("p", "tn-adm-qrlink", link);
    m.body.append(box, txt);
    const done = h("button", "tn-btn tn-btn--primary", "Done");
    done.type = "button";
    done.addEventListener("click", () => m.close());
    m.actions.append(done);
    done.focus();
  }

  tick(): void {
    if (!this.clock.run || !this.l?.match) return;
    const t = this.clock.time + (performance.now() - this.clock.at) / 1000;
    this.status.textContent = this.statusText(this.l, t);
  }
  private statusText(l: AdminLobby, t: number): string {
    const m = l.match;
    if (!m) {
      const n = l.players.length;
      return `${n} player${n === 1 ? "" : "s"} in the lobby${l.round ? ` · ${l.round} played` : ""}`;
    }
    const parts = [`${m.alive} alive`];
    if (l.mode === "trios") parts.push(`${m.squads} squads`);
    parts.push(mmss(t), `Round ${Math.max(1, l.round)}`);
    return parts.join(" · ");
  }

  update(l: AdminLobby): void {
    const prev = this.l;
    this.l = l;
    const code = l.code;
    const link = playerLink(code);
    if (this.linkText.textContent !== link) this.linkText.textContent = link;
    this.openA.href = link;
    this.codeChip.textContent = code;
    this.codeChip.title = "Lobby code";

    // match
    const m = l.match;
    this.phase.textContent = m ? PHASES[m.phase] ?? "Match" : l.locked ? "Locked" : "Lobby open";
    this.phase.className = "tn-badge tn-adm-phase " + (m ? `ph-${m.phase}` : "ph-idle");
    if (m) {
      if (!prev?.match || prev.match.time !== m.time || prev.match.phase !== m.phase) this.clock = { time: m.time, at: performance.now(), run: m.phase === 1 || m.phase === 2 };
    } else this.clock.run = false;
    this.status.textContent = this.statusText(l, m ? this.clock.time + (this.clock.run ? (performance.now() - this.clock.at) / 1000 : 0) : 0);
    this.startBtn.hidden = !!m;
    this.launchBtn.hidden = !m || m.phase !== 0;
    this.endBtn.hidden = !m;
    setBusy(this.startBtn, this.ctx.busy(`${code}:start`));
    setBusy(this.launchBtn, this.ctx.busy(`${code}:launch`));
    setBusy(this.endBtn, this.ctx.busy(`${code}:end`));
    this.endBtn.classList.toggle("is-wide", !!m && m.phase !== 0);

    // settings
    if (document.activeElement !== this.nameIn && !this.ctx.busy(`${code}:name`)) { if (this.nameIn.value !== l.name) this.nameIn.value = l.name; }
    this.nameIn.disabled = this.ctx.busy(`${code}:name`);
    this.paintNameHint();
    this.modeSeg.set(l.mode, !!m || this.ctx.busy(`${code}:mode`));
    this.modeSeg.el.classList.toggle("is-busy", this.ctx.busy(`${code}:mode`));
    this.modeWhy.textContent = m ? "Locked during a match" : l.mode === "trios" ? "Squads of 3" : "Every player alone";
    this.paintCap();
    this.lockSw.set(l.locked, this.ctx.busy(`${code}:lock`));
    this.teamSw.set(l.teamsLocked, this.ctx.busy(`${code}:teamlock`), l.mode !== "trios");
    this.teamSw.sup.textContent = l.mode === "trios" ? "Players can't switch teams" : "Trios only";
    this.castSw.set(l.casters, this.ctx.busy(`${code}:casters`));
    this.castSw.sup.textContent = l.casters ? `Open · ${l.casterCount} caster${l.casterCount === 1 ? "" : "s"} in` : "Commentators can't join";
    setBusy(this.closeBtn, this.ctx.busy(`${code}:close`));

    this.roster.update(l);
  }
}

// ==================================================================== the app
class App {
  readonly net = new Net(this);
  private root: HTMLElement;
  private connChip = h("span", "tn-chip tn-adm-conn");
  private pills = h("nav", "tn-pills tn-adm-pills");
  private pillMap = new Map<string, HTMLButtonElement>();
  private newPill = h("button", "tn-pill tn-adm-newpill");
  private reportsPill = h("button", "tn-pill tn-adm-reportspill");
  private reporting = false;
  private reports: ReportsView;
  private main = h("main", "tn-adm-main");
  private evNote = h("p", "tn-support tn-adm-evnote");
  private toasts = h("div", "tn-adm-toasts");
  private loading = h("div", "tn-adm-loading");
  private lobbies: AdminLobby[] | null = null;
  private eventMode = true;
  private sel: string | null = null;
  private creating = false;
  private view: LobbyView | null = null;
  private create: CreateView;

  constructor() {
    this.root = document.getElementById("kr-admin") ?? document.body.appendChild(h("div"));
    this.root.id = "kr-admin";
    const app = h("div", "tn-adm-app");

    const bar = h("header", "tn-adm-bar");
    const brand = h("div", "tn-adm-brand");
    const brow = h("img", "tn-logo tn-adm-brow");
    brow.src = TOON_LOGO.brow; brow.alt = ""; brow.draggable = false;
    brand.append(brow, h("h1", "tn-heading tn-adm-title", "Admin console"), adminChip());
    const right = h("div", "tn-adm-barright");
    const out = h("button", "tn-btn tn-btn--tertiary tn-adm-logout");
    out.type = "button";
    out.append(icon("logout"), h("span", "", "Log out"), spinner());
    out.addEventListener("click", () => this.logout(out));
    right.append(this.connChip, out);
    bar.append(brand, right);

    this.newPill.type = "button";
    this.newPill.append(icon("plus"), h("span", "", "New lobby"));
    this.newPill.addEventListener("click", () => { this.creating = true; this.reporting = false; this.create.reset(true); this.render(); this.create.focus(); });
    this.reportsPill.type = "button";
    this.reportsPill.addEventListener("click", () => { this.reporting = true; this.creating = false; this.render(); });
    this.reports = new ReportsView((m, tone) => this.toast(m, tone), () => this.paintReportsPill());
    this.paintReportsPill();
    this.reports.start();
    this.pills.setAttribute("aria-label", "Lobbies");

    this.create = new CreateView(this.net, (code) => {
      this.creating = false;
      if (code) this.sel = code;
      this.render();
    });
    this.loading.append(spinner(), h("p", "tn-body", "Connecting to the server…"));
    this.loading.classList.add("is-busy");

    const foot = h("footer", "tn-adm-foot");
    foot.append(safeNote(), this.evNote);
    this.toasts.setAttribute("aria-live", "polite");
    app.append(bar, this.pills, this.main, foot);
    this.root.replaceChildren(app, this.toasts);

    addEventListener("keydown", (e) => {
      // Esc on the create card (with lobbies) goes back one layer
      if (e.key === "Escape" && this.creating && this.lobbies?.length && !e.defaultPrevented && !document.querySelector(".tn-adm-scrim, .tn-adm-menu")) {
        this.creating = false; this.render();
      }
    });
    setInterval(() => this.view?.tick(), 500);
    this.renderConn();
    this.render();
    this.net.connect();
  }

  onState(lobbies: AdminLobby[], eventMode: boolean): void {
    const first = this.lobbies === null;
    this.lobbies = lobbies;
    this.eventMode = eventMode;
    if (this.sel && !lobbies.some((l) => l.code === this.sel)) this.sel = null;
    if (!this.sel && lobbies.length) this.sel = lobbies[0].code;
    this.render();
    if (first && !lobbies.length) this.create.focus();
  }

  renderConn(): void {
    const c = this.net.conn;
    this.connChip.className = "tn-chip tn-adm-conn is-" + c;
    this.connChip.replaceChildren(c === "reconnecting" || c === "connecting" ? spinner() : h("i", "dot"),
      h("span", "", c === "live" ? "Live" : c === "reconnecting" ? "Reconnecting…" : "Connecting…"));
    this.connChip.classList.toggle("is-busy", c !== "live");
  }

  render(): void {
    // footer note
    this.evNote.textContent = this.eventMode ? "Event mode on · Players join by link only" : "Event mode off · Players can also make their own lobbies";
    this.evNote.classList.toggle("is-warn", !this.eventMode);

    const ls = this.lobbies;
    // lobby pills
    this.pills.hidden = !ls;
    if (ls) {
      const kids: HTMLElement[] = [];
      for (const l of ls) {
        let b = this.pillMap.get(l.code);
        if (!b) {
          b = h("button", "tn-pill tn-adm-lpill");
          b.type = "button";
          const code = l.code;
          b.addEventListener("click", () => { this.sel = code; this.creating = false; this.reporting = false; this.render(); });
          this.pillMap.set(l.code, b);
        }
        const nm = h("span", "nm", l.name);
        const ct = h("small", "", `${l.players.length}/${l.cap}`);
        const sig = `${l.name}|${l.players.length}|${l.cap}|${l.match ? 1 : 0}`;
        if (b.dataset.sig !== sig) {
          b.dataset.sig = sig;
          b.replaceChildren(...(l.match ? [h("i", "live")] : []), nm, ct);
          b.title = l.name;
        }
        b.setAttribute("aria-pressed", String(!this.creating && !this.reporting && l.code === this.sel));
        kids.push(b);
      }
      for (const [code, b] of this.pillMap) if (!ls.some((l) => l.code === code)) { b.remove(); this.pillMap.delete(code); }
      this.newPill.setAttribute("aria-pressed", String(this.creating && !this.reporting));
      kids.push(this.newPill);
      this.reportsPill.setAttribute("aria-pressed", String(this.reporting));
      kids.push(this.reportsPill);
      const cur = this.pills.children;
      if (cur.length !== kids.length || !kids.every((k, i) => cur[i] === k)) this.pills.replaceChildren(...kids);
    }

    // main
    let want: HTMLElement;
    if (!ls) want = this.loading;
    else if (this.reporting) want = this.reports.el;
    else if (this.creating || !ls.length) {
      if (!ls.length) this.creating = false;
      this.create.setHasLobbies(ls.length > 0);
      this.create.paint();
      want = this.create.el;
      if (this.view) { this.view.destroy(); this.view = null; }
    } else {
      const l = ls.find((x) => x.code === this.sel) ?? ls[0];
      this.sel = l.code;
      if (!this.view || this.view.code !== l.code) {
        this.view?.destroy();
        this.view = new LobbyView(l.code, this.net, (t) => this.copy(t));
      }
      this.view.update(l);
      want = this.view.el;
    }
    if (this.main.firstChild !== want || this.main.childNodes.length !== 1) this.main.replaceChildren(want);
    this.main.dataset.view = want === this.create.el ? "create" : want === this.loading ? "loading" : want === this.reports.el ? "reports" : "lobby";
    if (this.reports.shown !== (want === this.reports.el)) this.reports.show(want === this.reports.el);
  }

  private paintReportsPill(): void {
    const n = this.reports?.unseen ?? 0;
    this.reportsPill.replaceChildren(icon("alert"), h("span", "", "Reports"), ...(n ? [h("small", "", n > 99 ? "99+" : n)] : []));
  }

  toast(msg: string, tone: "ok" | "err"): void {
    const t = h("div", "tn-toast tn-adm-toast" + (tone === "err" ? " is-err" : ""));
    t.setAttribute("role", tone === "err" ? "alert" : "status");
    t.append(icon(tone === "err" ? "alert" : "check"), h("span", "", msg));
    this.toasts.append(t);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild!.remove();
    setTimeout(() => { t.classList.add("is-out"); setTimeout(() => t.remove(), 300); }, tone === "err" ? 6000 : 3200);
  }

  async copy(text: string): Promise<boolean> {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall back below */ }
    if (!ok) {
      const ta = h("textarea", "tn-adm-sr");
      ta.value = text;
      ta.setAttribute("readonly", "");
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    this.toast(ok ? "Link copied. Paste it to your players." : "Couldn't copy. Select the link and copy it by hand.", ok ? "ok" : "err");
    return ok;
  }

  private async logout(btn: HTMLButtonElement): Promise<void> {
    setBusy(btn, true);
    try {
      await fetch(adminUrl("admin/api/logout"), { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: "{}" });
    } catch { /* reload shows the truth either way */ }
    location.reload();
  }
}

function boot(): void {
  ensureToon();
  addStyle("kr-admin-console", CONSOLE_CSS);
  document.body.classList.add("kr-admin");
  new App();
}
boot();
