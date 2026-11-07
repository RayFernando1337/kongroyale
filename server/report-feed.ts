// The live report feed behind the admin console's Reports view (RAY-162 slice 2, the moderator page). server/kongbot.ts
// adds each stored report; server/admin/http.ts streams the feed to a logged-in admin (GET /admin/api/reports, server-sent
// events) and hands out one report's text on request (POST /admin/api/reports/text), so free text a player typed reaches
// a screen only when a moderator asks for it. A feed item holds structured fields only: the report id, its kind and
// symptom chip, where it was sent from, the browser and OS family, and the client build. No callsign, no install or
// session id, no address. The feed lives in memory and keeps the newest MAX_ITEMS; a restart starts it empty.
import type { Bundle } from "./playtest-bundles";

const MAX_ITEMS = 200;
/** what a POI or chip name may hold on the way to a moderator's screen */
const LABEL = /[^A-Za-z0-9 '.,:()-]/g;

export interface FeedItem {
  /** a number the feed gives each report, for asking for its text */
  seq: number;
  /** when the server received it (ISO) */
  at: string;
  /** KB-<n>, or LOCAL-<receipt> while MongoDB is unavailable */
  id: string;
  /** the ?diag sheet's crash, report or diagnostics; kongbot for the chat command */
  kind: "crash" | "report" | "diagnostics" | "kongbot";
  chip: string | null;
  poi: string | null;
  browser: string;
  os: string;
  /** the client build's short sha */
  build: string | null;
  /** the report carries text a moderator can reveal */
  hasText: boolean;
}

export interface StoredReport { id: string; at: Date; message: string; ua: string | null; ctx: unknown; bundle: Bundle | null }

const label = (v: unknown, n: number) => (typeof v === "string" ? v.replace(LABEL, "").trim().slice(0, n) || null : null);

/** the browser and OS family from a user-agent string: a coarse label, never the string itself */
export function family(ua: string | null): { browser: string; os: string } {
  const u = ua ?? "";
  const browser = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /(Chrome|CriOS)\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "Other";
  const os = /iPhone|iPad|iPod/.test(u) ? "iOS" : /Android/.test(u) ? "Android" : /CrOS/.test(u) ? "ChromeOS" : /Windows/.test(u) ? "Windows" : /Mac OS X|Macintosh/.test(u) ? "macOS" : /Linux/.test(u) ? "Linux" : "Other";
  return { browser, os };
}

export function reportFeed() {
  const items: FeedItem[] = [];
  const texts = new Map<number, string>();
  const listeners = new Set<(item: FeedItem) => void>();
  let seq = 0;

  function add(r: StoredReport): FeedItem {
    const diag = r.bundle?.diag ?? null;
    const kind = (diag?.kind ?? "kongbot") as FeedItem["kind"];
    const poi = (r.ctx as { game?: { player?: { poi?: { name?: unknown } } } } | null)?.game?.player?.poi?.name;
    // a diagnostics send carries the sheet's own words ("Diagnostics from play at 7:42, Banana Temple"), never a player's
    const hasText = kind !== "diagnostics" && r.message.length > 0;
    const item: FeedItem = { seq: ++seq, at: r.at.toISOString(), id: r.id, kind, chip: label(diag?.chip, 24), poi: label(poi, 40), ...family(r.ua), build: r.bundle?.build?.sha.slice(0, 7) ?? null, hasText };
    items.push(item);
    if (hasText) texts.set(item.seq, r.message);
    while (items.length > MAX_ITEMS) texts.delete(items.shift()!.seq);
    for (const fn of listeners) { try { fn(item); } catch { /* a closed stream */ } }
    return item;
  }

  return {
    add,
    /** the newest items, oldest first */
    recent: (): FeedItem[] => items.slice(),
    /** a report's text, while it is still in the feed */
    text: (n: number): { id: string; text: string } | null => {
      const item = items.find((i) => i.seq === n), text = texts.get(n);
      return item && text !== undefined ? { id: item.id, text } : null;
    },
    /** calls fn with each new item until the returned function is called */
    subscribe: (fn: (item: FeedItem) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
export type ReportFeed = ReturnType<typeof reportFeed>;
