// EVENT LOBBY, the player side: what a player link `<site>/?e=CODE` opens instead of the title
// lobby. The same LobbyScreen as ui/lobby.ts (game/index.ts swaps one for the other), in the same Toon look: the live
// title scene behind a deep-navy fade, the KONG ROYALE lockup, one left column.
//   LOADING   GET api/event/CODE (public: name, mode, count / cap) while "Finding the lobby…"
//   JOIN      the lobby's name, Your name (validated live), ONE yellow JOIN GAME. Nothing else.
//   NOT FOUND "This lobby isn't open" + Retry (also: can't reach the server)
//   ROOM      name, mode, n / cap, the status; TRIOS: team cards (join / leave a team, the admin's moves show at once) and
//             the players with no team yet; SOLO: one grid of players. Leave lobby (back to JOIN).
//   ENDED     kicked (no way back from here) · closed · replaced (Back to JOIN)
// The player has no host powers here: every change is a request the server checks (shared/net/event.ts).
// Names are hostile input (the link is public, the screen may be broadcast): every name is set with textContent only.
import type { LobbyActions, LobbyScreen, LobbyState } from "./api";
import type { EventEndReason, EventPlayer, EventPublicInfo, EventRoom } from "../../../shared/net/event";
import { EVENT_TEAM_SIZE } from "../../../shared/net/event";
import { injectStyles } from "./styles";
import { injectMenuStyles } from "./menu-styles";
import { injectLobbyStyles } from "./lobby-styles";
import { injectEventLobbyStyles } from "./event-lobby-styles";
import { checkCallsign } from "./lobby";
import { TOON_LOGO, keycap } from "./toon";
import { ICON } from "./lobby-icons";
import { glyphFamily, onLabelsChange, pauseText } from "../settings/labels";
import { glyph, PB } from "../settings/pad";
import { device } from "../settings/device";
import { flag } from "../flags";

const NAME_KEY = "kr-callsign", NAME_MAX = 14;
const store = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private */ } } };
const INFO_POLL_MS = 10000, INFO_TIMEOUT_MS = 8000;

// static icons (trusted markup)
const svg = (vb: string, body: string, cls = "") => `<svg class="tn-play-ico${cls ? " " + cls : ""}" viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;
const EV_ICON = {
  lock: svg("0 0 24 24", `<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/></g>`),
  door: svg("0 0 24 24", `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4.5A1.5 1.5 0 016.5 3h11A1.5 1.5 0 0119 4.5V21M3 21h18"/><path d="M14.5 12.5v.5"/></g>`),
  swap: svg("0 0 24 24", `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M8 21h8M12 17v4"/></g>`),
} as const;

type View = "loading" | "join" | "notfound" | "room" | "ended";
/** what game/index.ts adds to the LobbyState for this screen: the link dropped and the game is getting back
 *  in by itself (the room stays up, saying so) */
export interface EventLobbyState { reconnecting?: boolean }
type Info = Extract<EventPublicInfo, { ok: true }>;

/** api/event/CODE beside the page (or beside a ?ws= override, the way game/index.ts connects) */
function infoUrl(code: string): string {
  try {
    const ws = flag("ws");
    if (ws && /^wss?:\/\/[^\s]+$/.test(ws)) { const u = new URL(ws); u.protocol = u.protocol === "wss:" ? "https:" : "http:"; u.pathname = `/api/event/${code}`; u.search = ""; return u.href; }
  } catch { /* fall through */ }
  return `${import.meta.env.BASE_URL}api/event/${code}`;
}
/** the public info, checked field by field (null = no such lobby; throws = no answer) */
async function fetchInfo(code: string): Promise<Info | null> {
  const ctl = new AbortController(), kill = window.setTimeout(() => ctl.abort(), INFO_TIMEOUT_MS);
  try {
    const r = await fetch(infoUrl(code), { cache: "no-store", signal: ctl.signal, headers: { accept: "application/json" } });
    if (!(r.headers.get("content-type") || "").includes("json")) throw new Error("no game server");
    const j = await r.json() as Record<string, unknown>;
    if (j.ok !== true) { if (j.error === "not-found" || r.status === 404) return null; throw new Error("bad answer"); }
    const num = (v: unknown, d: number) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : d;
    return { ok: true, code, name: typeof j.name === "string" ? j.name.slice(0, 40) : "", mode: j.mode === "trios" ? "trios" : "solo",
      count: num(j.count, 0), cap: num(j.cap, 0), locked: j.locked === true, inMatch: j.inMatch === true };
  } finally { clearTimeout(kill); }
}

/** a server refusal in words for this screen */
function friendly(raw: string): string {
  const m = raw.trim();
  if (/lock/i.test(m) && !/team/i.test(m)) return "This lobby is locked.";
  if (/full/i.test(m) && !/team/i.test(m)) return "This lobby is full.";
  if (/no server/i.test(m)) return "Can't reach the game server. Try again in a moment.";
  if (/reload|updated/i.test(m)) return "The game was updated. Reload the page to join.";
  const s = m.charAt(0).toUpperCase() + m.slice(1).toLowerCase();
  return /[.!?]$/.test(s) ? s : s + ".";
}
const isGone = (raw: string) => /no such|not found|doesn.?t exist|no lobby|closed/i.test(raw);
/** why the room was left, for the JOIN screen (a dropped link / a reconnect that gave up, else the server's words) */
const leftMsg = (raw: string) => /reconnect/i.test(raw) ? "Lost the connection and couldn't get back in for a minute. Check your connection, then join again."
  : /clos|lost|disconnect|timeout/i.test(raw) ? "Lost the connection. Join again to get back in." : friendly(raw);

const ENDED: Record<EventEndReason, { title: string; body: string; back: boolean }> = {
  kicked: { title: "You were removed from this lobby", body: "The host removed you from this event.", back: false },
  closed: { title: "This lobby was closed", body: "The host closed the lobby. Thanks for playing!", back: true },
  replaced: { title: "You're in this lobby in another window", body: "This lobby was opened again from another tab or device, so this one stepped out.", back: true },
};

/** a short name gets the lobby display size; longer ones step down so the column holds them */
const nameSize = (n: string) => n.length <= 10 ? "" : n.length <= 18 ? "is-md" : "is-lg";

export function createEventLobby(actions: LobbyActions, code: string): LobbyScreen {
  injectStyles(); injectMenuStyles(); injectLobbyStyles(); injectEventLobbyStyles();
  const root = h("div", "kr-lobby tn-play tn-ev", null);
  h("div", "tn-play-shade tn-ev-shade", root);
  const brand = h("img", "tn-logo tn-play-brand", root);
  brand.src = TOON_LOGO.lockup; brand.alt = "Kong Royale"; brand.draggable = false;

  // ---------------- top right: who I am (in the room) + Settings
  const id = h("div", "tn-play-id tn-ev-id", root);
  const cs = h("div", "tn-play-cs tn-ev-cs", id);
  h("small", "", cs).textContent = "Playing as";
  const csName = h("b", "", cs);
  const idDiv = h("span", "tn-play-div", id);
  const btnSettings = h("button", "tn-pill tn-ev-settings", id); btnSettings.type = "button"; btnSettings.textContent = "Settings";
  btnSettings.addEventListener("click", () => openSettings());
  const toast = h("div", "tn-toast tn-ev-toast", root); toast.setAttribute("role", "status");

  // ---------------- left column: the views share the eyebrow + the name
  const main = h("div", "tn-ev-main", root);
  const eyebrow = h("div", "tn-eyebrow tn-play-eyebrow", main);
  const title = h("h1", "tn-lobby-display tn-ev-name", main);

  // LOADING
  const loading = h("div", "tn-ev-loading", main); loading.setAttribute("role", "status");
  h("span", "tn-play-spin", loading); h("span", "", loading).textContent = "Finding the lobby…";

  // JOIN
  const join = h("form", "tn-ev-join", main); join.noValidate = true; join.setAttribute("aria-label", "Join the lobby");
  const meta = h("p", "tn-play-modeline tn-ev-meta", join);
  const notes = h("div", "tn-ev-notes", join);
  const nameLabel = h("label", "tn-play-plabel tn-ev-label", join); nameLabel.textContent = "Your name"; nameLabel.htmlFor = "kr-ev-name";
  const input = h("input", "tn-play-input tn-ev-input", join);
  input.id = "kr-ev-name"; input.maxLength = NAME_MAX; input.spellcheck = false; input.autocomplete = "off"; input.placeholder = "KONG";
  input.setAttribute("aria-describedby", "kr-ev-name-help"); input.enterKeyHint = "go";
  const help = h("div", "tn-play-help tn-ev-help", join); help.id = "kr-ev-name-help";
  const HELP = "1–14 letters or numbers. Everyone in the lobby sees it.";
  // the one primary: .kr-btn.play = the controller's first focus (game/index.ts padLayer)
  const cta = h("button", "tn-play-cta kr-btn play tn-ev-cta", join); cta.type = "submit";
  const ctaLabel = h("span", "lbl", cta);
  h("span", "tn-play-spin", cta);
  cta.insertAdjacentHTML("beforeend", ICON.arrow);
  const err = h("div", "tn-play-err tn-ev-err", join); err.setAttribute("role", "alert");

  // NOT FOUND (or: no answer from the server)
  const nf = h("div", "tn-ev-nf", main);
  const nfBody = h("p", "tn-ev-body", nf);
  const nfCode = h("p", "tn-ev-code", nf);
  const nfRetry = h("button", "tn-play-cta kr-btn play tn-ev-cta", nf); nfRetry.type = "button";
  h("span", "lbl", nfRetry).textContent = "Retry";
  nfRetry.insertAdjacentHTML("beforeend", ICON.arrow);

  // ROOM (left column)
  const room = h("div", "tn-ev-room", main);
  const chips = h("div", "tn-ev-chips", room);
  const modeChip = h("span", "tn-chip tn-ev-chip", chips);
  const countChip = h("span", "tn-chip tn-ev-chip", chips);
  const status = h("div", "tn-ev-status", room); status.setAttribute("role", "status");
  const statusText = h("span", "", status);
  const lockNote = h("div", "tn-ev-note", room); lockNote.innerHTML = `${EV_ICON.lock}<span>Teams are locked by the host</span>`;
  const loose = h("section", "tn-ev-loose", room); loose.setAttribute("aria-label", "No team yet");
  const looseHead = h("div", "tn-ev-loose-head", loose);
  h("b", "", looseHead).textContent = "No team yet";
  const looseN = h("span", "n", looseHead);
  const looseList = h("div", "tn-ev-loose-list", loose);
  const looseHelp = h("p", "tn-ev-loose-help", loose);
  const leaveBar = h("div", "tn-ev-leave", root);
  const btnLeave = h("button", "tn-play-link", leaveBar); btnLeave.type = "button"; btnLeave.innerHTML = `${ICON.leave}<span>Leave lobby</span>`;
  btnLeave.addEventListener("click", () => actions.leave());

  // ROOM (right: teams / players)
  const board = h("section", "tn-ev-board", root);
  const boardHead = h("div", "tn-ev-board-head", board);
  const boardTitle = h("div", "tn-eyebrow tn-ev-board-title", boardHead);
  const boardHint = h("div", "tn-ev-board-hint", boardHead);
  const teamsEl = h("div", "tn-ev-teams", board);
  const soloEl = h("div", "tn-ev-solo", board);

  // ENDED
  const end = h("div", "tn-ev-end tn-panel", main); end.setAttribute("role", "alert");
  const endIcon = h("div", "tn-ev-end-ico", end);
  const endTitle = h("h2", "tn-heading tn-ev-end-title", end);
  const endBody = h("p", "tn-ev-body", end);
  const endBack = h("button", "tn-btn tn-ev-end-back", end); endBack.type = "button"; endBack.textContent = "Back";

  // ---------------- footer: keycap hints, the game's full-screen toggle is adopted into it
  const foot = h("div", "tn-play-foot", root);
  const hintEnter = h("span", "tn-play-hint", foot), hintEsc = h("span", "tn-play-hint", foot);
  const adopt = () => { const fs = root.querySelector<HTMLElement>(":scope > .kr-fs-btn"); if (fs) { foot.appendChild(fs); fs.style.removeProperty("right"); fs.style.removeProperty("top"); fs.style.removeProperty("height"); } };
  new MutationObserver(adopt).observe(root, { childList: true });

  // ================================================================ state
  let view: View = "loading", info: Info | null = null, infoMissing = false, offline = false;
  let last: LobbyState | null = null, joining = false, joinErr: string | null = null, nameErr: string | null = null;
  let endedSeen: LobbyState["ended"] = null, lastToastErr: string | null = null, visible = true;
  let infoSeq = 0, pollTimer = 0;

  const storedName = () => (store.get(NAME_KEY) || "").toUpperCase().slice(0, NAME_MAX);
  input.value = storedName();

  function openSettings() { root.querySelector<HTMLButtonElement>(".kr-video-gear")?.click(); }

  // ---------------- public info: on open, on Retry, and every 10 s while the join screen shows
  async function loadInfo(showSpinner: boolean) {
    clearTimeout(pollTimer);
    if (!code) { info = null; infoMissing = true; offline = false; if (view === "loading" || view === "join") view = "notfound"; paint(); return; }
    const mine = ++infoSeq;
    if (showSpinner) { view = "loading"; paint(); }
    let next: Info | null = null, failed = false;
    // (the first ask runs while the game boots and the main thread is busy: a miss is retried a few times on the spinner)
    for (let tries = view === "loading" ? 4 : 1; tries > 0; tries--) {
      failed = false;
      try { next = await fetchInfo(code); break; } catch { failed = true; }
      if (mine !== infoSeq) return;
      if (tries > 1) await new Promise((r) => setTimeout(r, 2500));
    }
    if (mine !== infoSeq) return;
    if (view === "loading" || view === "join" || view === "notfound") {
      if (failed) {
        // a background refresh that missed keeps the screen; a first load or Retry says the server isn't answering
        if (view !== "join") { offline = true; infoMissing = false; view = "notfound"; }
      } else if (!next) { info = null; infoMissing = true; offline = false; if (!joining) view = "notfound"; }
      else { info = next; infoMissing = false; offline = false; if (view !== "join") { view = "join"; requestAnimationFrame(focusJoin); } }
      paint();
    }
    schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (visible && view === "join" && !joining) pollTimer = window.setTimeout(() => void loadInfo(false), INFO_POLL_MS);
  }
  const focusJoin = () => { if (view !== "join" || !visible || root.contains(document.activeElement) || device.pad) return; (input.value ? cta : input).focus({ preventScroll: true }); };

  // ---------------- join
  function setNameError(msg: string | null) {
    nameErr = msg;
    input.setAttribute("aria-invalid", String(!!msg));
    help.classList.toggle("is-error", !!msg);
    if (msg) { help.innerHTML = `${ICON.alert}<span></span>`; help.querySelector("span")!.textContent = msg; }
    else help.textContent = HELP;
  }
  const nameCheck = (raw: string) => { const r = checkCallsign(raw); return r.ok ? r : { ok: false as const, error: r.error.replace(/callsign/i, "name") }; };
  input.addEventListener("input", () => {
    // uppercase as typed (the caret stays put), validated live
    const pos = input.selectionStart; const up = input.value.toUpperCase();
    if (up !== input.value) { input.value = up; if (pos != null) input.setSelectionRange(pos, pos); }
    const r = nameCheck(input.value);
    setNameError(input.value.trim() === "" ? null : r.ok ? null : r.error);
    if (joinErr && !joining) { joinErr = null; paint(); }
  });
  function doJoin() {
    if (view !== "join" || joining || last?.busy) return;
    const r = nameCheck(input.value);
    if (!r.ok) { setNameError(r.error); input.focus(); return; }
    store.set(NAME_KEY, r.value); input.value = r.value; setNameError(null);
    joining = true; joinErr = null; clearTimeout(pollTimer); paint();
    actions.setName(r.value); actions.join(code);
  }
  join.addEventListener("submit", (ev) => { ev.preventDefault(); doJoin(); });
  nfRetry.addEventListener("click", () => void loadInfo(true));
  endBack.addEventListener("click", () => back());
  function back() {
    if (view !== "ended" || !last?.ended || !ENDED[last.ended.why]?.back) return;
    endedSeen = last.ended; view = "loading"; void loadInfo(true);
  }

  // ---------------- keyboard: Enter joins (or retries), Esc leaves the name field / goes Back / opens Settings
  addEventListener("keydown", (ev) => {
    if (root.classList.contains("kr-hide") || ev.defaultPrevented || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key !== "Enter" && ev.key !== "Escape") return;
    if (document.querySelector(".kr-video.on")) return;
    const t = ev.target as HTMLElement | null;
    if (t && t !== document.body && !root.contains(t)) return;   // another overlay owns it
    if (ev.key === "Escape") {
      ev.preventDefault();
      if (t === input) { input.blur(); return; }
      if (view === "ended" && !endBack.hidden) back(); else openSettings();
      return;
    }
    if (t && t.closest("button, input, a, summary")) return;    // a focused control keeps its own Enter
    ev.preventDefault();
    if (view === "join") doJoin(); else if (view === "notfound") void loadInfo(true);
  });

  // ---------------- hints (current bindings, current device)
  function paintHints() {
    const pad = device.pad, f = glyphFamily();
    if (pad) hintEnter.replaceChildren(keycap(glyph(PB.A, f), "accent"), document.createTextNode("Select"));
    else hintEnter.replaceChildren(keycap("Enter", "accent"), document.createTextNode(view === "notfound" ? "Retry" : ctaLabel.textContent || "Join game"));
    hintEnter.hidden = !pad && !(view === "join" && !joining) && view !== "notfound";
    const escBack = view === "ended" && !endBack.hidden;
    hintEsc.replaceChildren(keycap(pad ? pauseText() : "Esc", "accent"), document.createTextNode(escBack ? "Back" : "Settings"));
    hintEsc.hidden = pad;
  }
  onLabelsChange(paintHints);

  // ================================================================ state → screen
  // the game mutates ONE state object, so the previous error is remembered by value: comparing with `last`
  // (that same object) never saw a new error — a dropped link landed on the JOIN screen with no message at all
  let lastErr: string | null = null;
  function update(s: LobbyState) {
    const prevErr = lastErr; last = s; lastErr = s.error;
    const inRoom = s.code != null && !s.offline;
    if (s.ended && s.ended !== endedSeen) { view = "ended"; joining = false; joinErr = null; clearTimeout(pollTimer); }
    else if (inRoom) {
      if (view !== "room") { view = "room"; joining = false; joinErr = null; lastToastErr = s.error; clearTimeout(pollTimer); }
      else if (s.error && s.error !== lastToastErr) showToast(friendly(s.error));
      lastToastErr = s.error;
    } else if (view === "room") {
      // out of the room: Leave lobby, or the connection dropped (the game says why in s.error)
      view = "join"; joining = false;
      joinErr = s.error ? leftMsg(s.error) : null;
      void loadInfo(false);
    } else if (joining && s.error && !s.busy) {
      joining = false;
      if (isGone(s.error)) { infoMissing = true; info = null; view = "notfound"; }
      else joinErr = friendly(s.error);
      schedulePoll();
    } else if (view === "join" && s.error && s.error !== prevErr && !s.busy) joinErr = leftMsg(s.error);
    paint();
  }

  function paint() {
    root.dataset.view = view;
    const s = last;
    loading.hidden = view !== "loading"; join.hidden = view !== "join"; nf.hidden = view !== "notfound"; room.hidden = view !== "room";
    end.hidden = view !== "ended"; board.hidden = view !== "room"; leaveBar.hidden = view !== "room";
    const ev = s?.event ?? null;
    const lobbyName = (view === "room" && ev?.name) || info?.name || "";
    // eyebrow + the big name
    eyebrow.textContent = view === "join" ? "You're invited" : view === "ended" ? (lobbyName || "Event lobby") : "Event lobby";
    if (view === "notfound") title.textContent = offline ? "Can't reach the game" : "This lobby isn't open";
    else if (view === "loading") title.textContent = "";
    else title.textContent = lobbyName || "Event lobby";
    title.hidden = view === "loading" || view === "ended";
    title.className = "tn-lobby-display tn-ev-name " + (view === "notfound" ? "is-lg" : nameSize(title.textContent));

    if (view === "join") paintJoin();
    else if (view === "notfound") {
      nfBody.textContent = offline ? "The game server isn't answering right now. Try again in a moment." : "Check the link with your host.";
      nfCode.textContent = code ? `Lobby code ${code}` : "This link has no lobby code in it.";
    } else if (view === "room" && s) paintRoom(s, ev);
    else if (view === "ended" && s?.ended) {
      const e = ENDED[s.ended.why] ?? { title: "You left this lobby", body: s.ended.msg || "", back: true };
      endTitle.textContent = e.title; endBody.textContent = e.body; endBack.hidden = !e.back;
      end.dataset.why = s.ended.why;
      endIcon.innerHTML = s.ended.why === "kicked" ? EV_ICON.door : s.ended.why === "replaced" ? EV_ICON.swap : EV_ICON.lock;
    }
    // identity top right: only in the room (on the join screen the name field is the identity)
    const me = view === "room" && s ? (ev?.players.find((p) => p.id === s.meId)?.name || s.players.find((p) => p.id === s.meId)?.name || storedName()) : "";
    cs.hidden = idDiv.hidden = !me; csName.textContent = me;
    paintHints();
  }

  function paintJoin() {
    const s = last;
    const busy = joining || !!s?.busy;
    if (info) {
      const mode = info.mode === "trios" ? "Trios" : "Solo";
      meta.replaceChildren(document.createTextNode(`${mode} · `), b(String(info.count)), document.createTextNode(` / ${info.cap} players`));
    } else meta.textContent = "";
    // honest notes before joining: a running match, a locked or full lobby (known players can still get back in)
    const n: string[] = [];
    if (info?.inMatch) n.push("A match is running. You'll play the next round.");
    if (info?.locked) n.push("The host locked this lobby. Only players already in it can get back in.");
    else if (info && info.cap > 0 && info.count >= info.cap) n.push("This lobby is full right now.");
    notes.replaceChildren(...n.map((t) => { const d = document.createElement("div"); d.className = "tn-ev-note"; d.innerHTML = info?.locked && t.startsWith("The host") ? EV_ICON.lock : `<i class="tn-ev-dot"></i>`; d.append(span(t)); return d; }));
    notes.hidden = !n.length;
    ctaLabel.textContent = busy ? "Joining…" : joinErr && /locked|full/i.test(joinErr) ? "Retry" : "Join game";
    cta.disabled = busy; cta.classList.toggle("is-spin", busy); cta.setAttribute("aria-label", ctaLabel.textContent);
    input.readOnly = busy;
    err.hidden = !joinErr;
    if (joinErr) { err.innerHTML = `${ICON.alert}<span></span>`; err.querySelector("span")!.textContent = joinErr; }
    if (!nameErr) setNameError(null);
  }

  // ---------------- the room: persistent team cards (a repaint never steals the focus from a team's button)
  interface Card { el: HTMLElement; count: HTMLElement; slots: Array<{ el: HTMLElement; nm: HTMLElement; you: HTMLElement }>; btn: HTMLButtonElement; team: number }
  const cards: Card[] = [];
  function card(team: number): Card {
    const el = h("div", "tn-ev-team", teamsEl);
    el.setAttribute("role", "group"); el.setAttribute("aria-label", `Team ${team + 1}`);
    const head = h("div", "tn-ev-team-head", el);
    h("b", "", head).textContent = `Team ${team + 1}`;
    const count = h("span", "n", head);
    const list = h("ol", "tn-ev-slots", el);
    const slots = Array.from({ length: EVENT_TEAM_SIZE }, () => { const li = h("li", "tn-ev-slot", list); const nm = h("span", "nm", li); const you = h("span", "tn-badge tn-badge--accent tn-ev-you", li); you.textContent = "You"; return { el: li, nm, you }; });
    const btn = h("button", "tn-btn tn-ev-teambtn", el); btn.type = "button";
    const c: Card = { el, count, slots, btn, team };
    btn.addEventListener("click", () => {
      if (btn.disabled || !last?.event) return;
      const mine = myTeam(last) === c.team;
      actions.pickTeam?.(mine ? -1 : c.team);
    });
    return c;
  }
  const myTeam = (s: LobbyState) => s.event?.players.find((p) => p.id === s.meId)?.team ?? -1;
  let soloSig = "", looseSig = "";

  function paintRoom(s: LobbyState, ev: EventRoom | null) {
    const trios = s.mode === "trios" && !!ev && ev.teams > 0;
    const players: EventPlayer[] = ev?.players ?? s.players.map((p) => ({ id: p.id, name: p.name, team: -1 }));
    const cap = ev?.cap ?? s.capacity ?? players.length;
    root.classList.toggle("is-trios", trios);
    modeChip.textContent = trios ? "Trios" : "Solo";
    countChip.replaceChildren(b(String(players.length)), document.createTextNode(` / ${cap} players`));
    const reconnecting = !!(s as LobbyState & EventLobbyState).reconnecting;
    status.classList.toggle("is-running", !!s.matchRunning && !reconnecting); status.classList.toggle("is-reconnecting", reconnecting);
    statusText.textContent = reconnecting ? "Connection lost. Reconnecting…" : s.matchRunning ? "Match in progress. You'll play the next round." : "Waiting for the host to start";
    const teamsLocked = !!ev?.teamsLocked;
    lockNote.hidden = !trios || !teamsLocked;
    boardTitle.textContent = trios ? "Teams" : "Players";
    boardHint.textContent = !trios ? "" : teamsLocked ? "The host sets the teams" : s.matchRunning ? "Teams change between matches" : "Pick a team, or let the host place you";
    teamsEl.hidden = !trios; soloEl.hidden = trios;

    if (trios && ev) {
      while (cards.length < ev.teams) cards.push(card(cards.length));
      while (cards.length > ev.teams) { const c = cards.pop()!; c.el.remove(); }
      const mine = myTeam(s);
      for (const c of cards) {
        const members = players.filter((p) => p.team === c.team);
        const isMine = mine === c.team, full = members.length >= EVENT_TEAM_SIZE;
        c.el.classList.toggle("is-mine", isMine);
        c.el.classList.toggle("is-full", full && !isMine);
        c.count.textContent = `${Math.min(members.length, EVENT_TEAM_SIZE)} / ${EVENT_TEAM_SIZE}`;
        c.slots.forEach((slot, i) => {
          const p = members[i];
          const me = !!p && p.id === s.meId;
          slot.el.classList.toggle("is-open", !p); slot.el.classList.toggle("is-me", me);
          const label = p ? (p.name || "KONG") : "Open";
          if (slot.nm.textContent !== label) slot.nm.textContent = label;
          slot.you.hidden = !me;
          slot.el.title = p ? label : "";
        });
        let label: string, enabled: boolean, cls = "";
        // (the server takes team picks only between matches, and never while the host locked the teams)
        const frozen = teamsLocked || !!s.matchRunning;
        if (isMine) { label = frozen ? "Your team" : "Leave team"; enabled = !frozen; cls = "is-leave"; }
        else if (teamsLocked) { label = "Locked"; enabled = false; }
        else if (s.matchRunning) { label = full ? "Full" : "Next round"; enabled = false; }
        else if (full) { label = "Full"; enabled = false; }
        else { label = mine >= 0 ? "Switch here" : "Join"; enabled = true; }
        if (c.btn.textContent !== label) c.btn.textContent = label;
        c.btn.disabled = !enabled || !!s.busy;
        c.btn.className = "tn-btn tn-ev-teambtn" + (cls ? " " + cls : "");
        c.btn.setAttribute("aria-label", `${label}: team ${c.team + 1}`);
      }
      // players with no team yet
      const loosePs = players.filter((p) => p.team < 0 || p.team >= ev.teams);
      loose.hidden = !loosePs.length;
      looseHelp.textContent = s.matchRunning ? "You'll be placed in a team when the next match starts." : "You'll be placed in a team when the match starts.";
      const sig = JSON.stringify([s.meId, loosePs.map((p) => [p.id, p.name])]);
      if (sig !== looseSig) { looseSig = sig; looseN.textContent = String(loosePs.length); looseList.replaceChildren(...loosePs.map((p) => chip(p, p.id === s.meId))); }
    } else {
      loose.hidden = true; looseSig = "";
      // SOLO: one grid of players, then the open seats (quiet, dashed)
      const seats = Math.max(players.length, Math.min(cap, 50));
      const sig = JSON.stringify([s.meId, seats, players.map((p) => [p.id, p.name])]);
      if (sig !== soloSig) {
        soloSig = sig;
        const list: HTMLElement[] = players.map((p) => chip(p, p.id === s.meId));
        for (let i = players.length; i < seats; i++) { const d = document.createElement("div"); d.className = "tn-play-chip tn-ev-pchip is-bot"; d.append(span("Open")); list.push(d); }
        soloEl.replaceChildren(...list);
      }
    }
  }
  function chip(p: EventPlayer, me: boolean) {
    const d = document.createElement("div");
    d.className = "tn-play-chip tn-ev-pchip" + (me ? " is-me" : "");
    const nm = span(p.name || "KONG"); nm.className = "nm"; d.append(nm);
    if (me) { const y = span("You"); y.className = "tn-badge tn-badge--accent tn-ev-you"; d.append(y); }
    d.title = p.name || "KONG";
    return d;
  }

  // ---------------- a toast (the room's refusals: TEAM 3 IS FULL, TEAMS ARE LOCKED …)
  let toastTimer = 0;
  function showToast(msg: string) {
    toast.replaceChildren(span(msg));
    toast.classList.remove("on"); void toast.offsetWidth; toast.classList.add("on");
    clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.classList.remove("on"), 2600);
  }

  // ---------------- controller: first focus + B
  function padFirst(): HTMLElement | null {
    const en = (e: HTMLButtonElement | null | undefined) => e && !e.disabled && !e.closest("[hidden]") ? e : null;
    if (view === "join") return en(cta);
    if (view === "notfound") return en(nfRetry);
    if (view === "ended") return en(endBack) ?? btnSettings;
    if (view === "room" && last) {
      const mine = myTeam(last);
      const own = cards.find((c) => c.team === mine)?.btn;
      return en(own) ?? cards.map((c) => en(c.btn)).find(Boolean) ?? btnSettings;
    }
    return null;
  }

  paint();
  void loadInfo(true);

  return {
    el: root,
    update,
    setVisible(v: boolean) {
      const was = visible; visible = v;
      root.classList.toggle("kr-hide", !v);
      if (v && !was) { if (view === "join") void loadInfo(false); }
      else if (!v) clearTimeout(pollTimer);
    },
    get name() { return storedName() || "KONG"; },
    padFirst,
    padBack() { if (view === "ended") back(); },
  };
}

function b(text: string) { const e = document.createElement("b"); e.textContent = text; return e; }
function span(text: string) { const e = document.createElement("span"); e.textContent = text; return e; }
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement | null): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}
