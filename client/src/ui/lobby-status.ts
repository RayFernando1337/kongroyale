// The lobby's live server status line: real data only. It reads the game server's own /health (server/index.ts:
// `clients` = players in online lobbies and matches) while the lobby is on screen. No answer, or not the game server
// answering, means the line says so (bot matches still work; private lobbies need the server).
import { flag } from "../flags";

export type ServerStatus =
  | { state: "checking" }
  | { state: "online"; players: number }
  | { state: "offline" };

// (a miss is retried sooner a few times: the first ask runs while the game boots and the main thread is busy)
const POLL_MS = 15000, RETRY_MS = 3000, RETRIES = 3, TIMEOUT_MS = 8000;

/** the server's /health beside the page's own /ws (or beside a ?ws= override, the way game/index.ts connects) */
function healthUrl(): string {
  try {
    const ws = flag("ws");
    if (ws && /^wss?:\/\/[^\s]+$/.test(ws)) { const u = new URL(ws); u.protocol = u.protocol === "wss:" ? "https:" : "http:"; u.pathname = "/health"; u.search = ""; return u.href; }
  } catch { /* fall through */ }
  // (under a deploy base, e.g. /kong/: the game server's /health is /kong/health, like /kong/ws — the site root is not it)
  return `${location.origin}${import.meta.env.BASE_URL}health`;
}

export function createServerStatus(onChange: (s: ServerStatus) => void) {
  let timer = 0, running = false, seq = 0, last = "", misses = 0;
  const emit = (s: ServerStatus) => { const sig = JSON.stringify(s); if (sig === last) return; last = sig; onChange(s); };
  async function poll() {
    const mine = ++seq;
    const ctl = new AbortController(), kill = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let next: ServerStatus = { state: "offline" };
    try {
      const r = await fetch(healthUrl(), { cache: "no-store", signal: ctl.signal, headers: { accept: "application/json" } });
      if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
        const j = await r.json() as { ok?: unknown; clients?: unknown };
        if (j.ok === true && typeof j.clients === "number" && Number.isFinite(j.clients)) next = { state: "online", players: Math.max(0, Math.round(j.clients)) };
      }
    } catch { /* offline / timed out */ } finally { clearTimeout(kill); }
    if (mine !== seq || !running) return;
    misses = next.state === "online" ? 0 : misses + 1;
    // a first miss keeps "checking" (one slow answer during boot is not "offline"); the line says offline after two
    if (next.state === "online" || misses >= 2 || last !== JSON.stringify({ state: "checking" })) emit(next);
    // (offline for good: ask less often — every failed ask is a console line in dev)
    timer = window.setTimeout(() => void poll(), misses > 0 && misses <= RETRIES ? RETRY_MS : misses > RETRIES ? POLL_MS * 2 : POLL_MS);
  }
  return {
    /** poll while the lobby is on screen */
    start() { if (running) return; running = true; if (!last) emit({ state: "checking" }); void poll(); },
    stop() { running = false; seq++; clearTimeout(timer); },
    /** ask again now (after a lobby error) */
    refresh() { if (!running) return; clearTimeout(timer); void poll(); },
  };
}
