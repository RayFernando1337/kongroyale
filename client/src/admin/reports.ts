// The admin console's Reports view (RAY-162 slice 2, the moderator page): player reports as they arrive, from the
// server's report feed (GET admin/api/reports, server-sent events; server/report-feed.ts). A row shows structured fields
// only: time, report id, kind, symptom chip, place, browser and OS, and the build. A report's own text (a player's note)
// stays hidden until the moderator presses "Show text", which asks the server for it (POST admin/api/reports/text).
// Everything a player could have typed reaches the page through textContent (h()), never markup.
import { addStyle, adminUrl, h, setBusy, spinner } from "./common";

const MAX_ROWS = 200;
const KIND: Record<string, string> = { crash: "Crash", report: "Problem", diagnostics: "Diagnostics", kongbot: "KONGBOT" };
const CSS = `
.tn-adm-reports { display: grid; gap: 12px; }
.tn-adm-rhead { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.tn-adm-rlist { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.tn-adm-rrow { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 12px; align-items: center; padding: 10px 14px; }
.tn-adm-rrow .meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }
.tn-adm-rrow .text { grid-column: 1 / -1; margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.tn-adm-rrow.is-new { outline: 2px solid currentColor; outline-offset: -2px; }
`;

interface Item { seq: number; at: string; id: string; kind: string; chip: string | null; poi: string | null; browser: string; os: string; build: string | null; hasText: boolean }

const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
/** the parts of a feed message this page uses, or null for anything it doesn't recognise */
function item(data: string): Item | null {
  let v: Record<string, unknown>;
  try { v = JSON.parse(data); } catch { return null; }
  if (!v || typeof v !== "object" || typeof v.seq !== "number" || typeof v.id !== "string") return null;
  return { seq: v.seq, at: str(v.at, 40) ?? "", id: v.id.slice(0, 40), kind: str(v.kind, 16) ?? "", chip: str(v.chip, 24), poi: str(v.poi, 40),
    browser: str(v.browser, 16) ?? "", os: str(v.os, 16) ?? "", build: str(v.build, 12), hasText: v.hasText === true };
}

export class ReportsView {
  readonly el = h("section", "tn-panel tn-adm-card tn-adm-reports");
  private state = h("span", "tn-support");
  private list = h("ol", "tn-adm-rlist");
  private empty = h("p", "tn-body", "No reports yet. They appear here as players send them.");
  private source: EventSource | null = null;
  private rows = new Map<number, HTMLLIElement>();
  /** new reports since the view was last on screen */
  unseen = 0;
  shown = false;

  constructor(private toast: (msg: string, tone: "ok" | "err") => void, private onUnseen: () => void) {
    addStyle("kr-admin-reports", CSS);
    const head = h("div", "tn-adm-rhead");
    head.append(h("h2", "tn-adm-bigtitle", "Player reports"), this.state);
    const why = h("p", "tn-support", "Symptom, place, browser and build for each report. A player's own words stay hidden until you show them.");
    this.el.append(head, why, this.empty, this.list);
  }

  /** opens the feed; the browser reconnects on its own after a drop */
  start(): void {
    if (this.source) return;
    this.setState("Connecting…");
    const s = new EventSource(adminUrl("admin/api/reports"));
    this.source = s;
    s.onopen = () => this.setState("Live");
    s.onerror = () => {
      if (s.readyState === EventSource.CLOSED) { this.source = null; this.setState("Disconnected. Reload the page to reconnect."); }
      else this.setState("Reconnecting…");
    };
    s.onmessage = (e) => { const it = item(String(e.data)); if (it) this.add(it); };
  }

  show(on: boolean): void {
    this.shown = on;
    if (on) { this.unseen = 0; this.onUnseen(); }
    else for (const r of this.rows.values()) r.classList.remove("is-new");
  }

  private setState(t: string): void { this.state.textContent = t; }

  private add(it: Item): void {
    if (this.rows.has(it.seq)) return;
    const li = h("li", "tn-tile tn-adm-rrow");
    const time = new Date(it.at);
    const when = h("span", "tn-label tn-num", isNaN(+time) ? "" : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    const meta = h("div", "meta");
    meta.append(h("span", "tn-key", it.id), h("span", "tn-badge", KIND[it.kind] ?? it.kind));
    if (it.chip) meta.append(h("span", "tn-label", it.chip));
    meta.append(h("span", "tn-support", [it.poi ?? "no place", it.browser + " on " + it.os, it.build ? "build " + it.build : null].filter(Boolean).join(" · ")));
    li.append(when, meta);
    if (it.hasText) li.append(this.textButton(li, it));
    else li.append(h("span"));
    if (!this.shown) li.classList.add("is-new");
    this.list.prepend(li);
    this.rows.set(it.seq, li);
    while (this.rows.size > MAX_ROWS) { const [seq, old] = this.rows.entries().next().value!; old.remove(); this.rows.delete(seq); }
    this.empty.hidden = true;
    if (!this.shown) { this.unseen++; this.onUnseen(); }
  }

  private textButton(li: HTMLLIElement, it: Item): HTMLButtonElement {
    const b = h("button", "tn-btn tn-btn--tertiary");
    b.type = "button";
    const label = h("span", "", "Show text");
    b.append(label, spinner());
    let shown: HTMLParagraphElement | null = null;
    b.addEventListener("click", async () => {
      if (shown) { shown.remove(); shown = null; label.textContent = "Show text"; return; }
      setBusy(b, true);
      try {
        const r = await fetch(adminUrl("admin/api/reports/text"), { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ seq: it.seq }) });
        const j = (await r.json().catch(() => null)) as { ok?: boolean; text?: unknown; error?: unknown } | null;
        if (!r.ok || !j?.ok || typeof j.text !== "string") { this.toast(typeof j?.error === "string" ? j.error.slice(0, 120) : "Couldn't load the text (" + r.status + ")", "err"); return; }
        shown = h("p", "tn-body text", j.text.slice(0, 2000));
        li.append(shown);
        label.textContent = "Hide text";
      } catch { this.toast("Couldn't reach the server", "err"); }
      finally { setBusy(b, false); }
    });
    return b;
  }
}
