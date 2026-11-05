// Player diagnostics (?diag, RAY-162): what a stream player's report needs beyond the per-second metrics ring.
//   events     the moments that explain a hitch, newest 500: long animation frames with the script that ran longest
//              (Chrome and Edge; plain long tasks where only those exist), match phase changes, world modules streamed in
//              or evicted, shader-program jumps, 3D-resolution steps, a heap drop over 50 MB (a collection), WebGL context
//              loss, visibility, fullscreen and uncaught errors. Modules come from __kr.streamMs: what streams in after the
//              title (the builds a player can feel; ?nostream has none) with its build ms, failed builds, and lowmem
//              evictions and rebuilds (residency from __kr.modules).
//   path       the player's position and view once a second in a match (up to an hour): the route a camera-path bench
//              replays on another GPU
//   heartbeat  a small record in localStorage every 5 s, marked clean on pagehide. A session that never marked clean and
//              stopped beating while visible died (tab killed, browser crashed); the next load keeps its last record as
//              `prev`. A hidden tab's timers may be throttled or frozen, so a beat written while hidden never counts.
// snapshot() is __kr.diag.snapshot(); a report sends it as ctx.diag, which the server cleans and stores as it is.
import type { Engine } from "../engine/engine";
import { BUILD } from "../build";
import { POIS } from "../../../shared/world/map";
import { ring } from "./metrics.hot";

const MAX_EVENTS = 500, PATH_S = 3600, PATH_W = 7, LONG_MS = 100, GC_DROP_MB = 50, BEAT_S = 5, DEAD_AFTER_MS = 12_000, KEEP_MS = 7 * 86_400_000;
const BEAT_KEY = "kr.diag.hb.";
const PATH_FIELDS = ["t", "x", "y", "z", "yawDeg", "pitchDeg", "phase"] as const;

/** [page seconds, kind, number, text] */
export type DiagEvent = [number, string, number, string];
interface Beat { v: 1; sid: string; sha: string; at: number; upS: number; phase: number; poi: string | null; heapMB: number; textures: number; geometries: number; fps: number; hidden: boolean; clean: boolean }
interface KrGame { inMatch?: boolean; cm?: { pred?: { x: number; y: number; z: number } } | null; input?: { yaw: number; pitch: number } }
/** main.ts: streamMs = build ms of each module streamed in after the title, once integrated (a failed build too);
 *  modules = the modules resident now (a lowmem eviction removes one) */
type Kr = Record<string, unknown> & { ready?: boolean; game?: KrGame; streamMs?: Record<string, number>; modules?: string[] };
const kr = () => (window as unknown as { __kr: Kr }).__kr;

const events: DiagEvent[] = [];
const path = new Float32Array(PATH_S * PATH_W);
const pathCursor = { rows: 0 };
const sid = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
let prev: Beat | null = null;
let loafKind: string | null = null;

const pageS = () => Math.round(performance.now() / 10) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
function push(kind: string, n: number, text = "", t = pageS()): void {
  events.push([t, kind, n, text.slice(0, 200)]);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

interface LoafScript { duration: number; invoker?: string; sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number }
function script(s: LoafScript): string {
  const file = (s.sourceURL ?? "").split(/[?#]/)[0].split("/").pop() || "?";
  return `${s.invoker ?? "?"} ${s.sourceFunctionName || "anonymous"}@${file}:${s.sourceCharPosition ?? -1} ${Math.round(s.duration)} ms`;
}
function observeLongFrames(): void {
  const types = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes ?? [];
  loafKind = types.includes("long-animation-frame") ? "long-animation-frame" : types.includes("longtask") ? "longtask" : null;
  if (!loafKind) return;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration < LONG_MS) continue;
      const scripts = (e as unknown as { scripts?: LoafScript[] }).scripts ?? [];
      let top: LoafScript | null = null;
      for (const s of scripts) if (!top || s.duration > top.duration) top = s;
      push(loafKind === "longtask" ? "longtask" : "loaf", Math.round(e.duration), top ? script(top) : "", Math.round(e.startTime / 10) / 100);
    }
  }).observe({ type: loafKind, buffered: true });
}

function writeBeat(b: Beat): void {
  try { localStorage.setItem(BEAT_KEY + b.sid, JSON.stringify(b)); } catch { /* storage full or blocked: no crash evidence */ }
}
function readBeats(): Beat[] {
  const out: Beat[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(BEAT_KEY) || k === BEAT_KEY + sid) continue;
      const b = JSON.parse(localStorage.getItem(k) ?? "null") as Beat | null;
      if (b && typeof b.at === "number") out.push(b);
    }
  } catch { /* blocked storage */ }
  return out;
}
/** another tab's session is alive while it keeps beating; one that stopped without marking clean died */
function findDeadSession(): void {
  const now = Date.now(), first = readBeats();
  for (const b of first) if (b.clean || now - b.at > KEEP_MS) localStorage.removeItem(BEAT_KEY + b.sid);
  const open = first.filter((b) => !b.clean && !b.hidden && now - b.at <= KEEP_MS);
  if (!open.length) return;
  setTimeout(() => {
    const later = new Map(readBeats().map((b) => [b.sid, b]));
    for (const b of open) {
      if ((later.get(b.sid)?.at ?? b.at) !== b.at) continue;
      if (!prev || b.at > prev.at) prev = b;
      localStorage.removeItem(BEAT_KEY + b.sid);
    }
    if (prev) push("prev-session", Math.round((Date.now() - prev.at) / 1000), prev.phase >= 0 ? "died in a match" : "died outside a match");
  }, DEAD_AFTER_MS);
}

/** the POI whose edge is nearest (kongbot/context.ts nearestPoi, kept here so this lazy chunk doesn't make the entry export it) */
function poiAt(x: number, z: number): string | null {
  let best: string | null = null, edge = Infinity;
  for (const p of POIS) {
    const d = Math.hypot(x - p.x, z - p.z) - p.r;
    if (d < edge) { edge = d; best = p.id; }
  }
  return best;
}

/** start sampling; returns the per-second hook for the recorder (it gets the new row's offset in the metrics ring) */
export function installDiag(engine: Engine): (at: number) => void {
  observeLongFrames();
  findDeadSession();
  const canvas = engine.renderer.domElement;
  canvas.addEventListener("webglcontextlost", () => push("context-lost", 0));
  canvas.addEventListener("webglcontextrestored", () => push("context-restored", 0));
  addEventListener("fullscreenchange", () => push("fullscreen", document.fullscreenElement ? 1 : 0));
  addEventListener("error", (e) => push("error", 0, e.message || String(e.error)));
  addEventListener("unhandledrejection", (e) => push("rejection", 0, String((e.reason as Error | undefined)?.message ?? e.reason)));

  const resident = new Set<string>(), failed = new Set<string>();
  const last = { phase: -2, programs: -1, scale: -1, heap: -1 };
  let beat: Beat = { v: 1, sid, sha: BUILD.sha, at: Date.now(), upS: 0, phase: -1, poi: null, heapMB: -1, textures: 0, geometries: 0, fps: 0, hidden: false, clean: false };
  addEventListener("pagehide", () => { beat.clean = true; beat.at = Date.now(); writeBeat(beat); });
  addEventListener("pageshow", (e) => { if (e.persisted) { beat.clean = false; writeBeat(beat); } });
  addEventListener("visibilitychange", () => {
    push("visibility", document.visibilityState === "visible" ? 1 : 0, document.visibilityState);
    beat.hidden = document.visibilityState === "hidden"; beat.at = Date.now(); writeBeat(beat);
  });
  let seconds = 0;

  return (at) => {
    const K = kr(), g = K.game, p = g?.inMatch ? g.cm?.pred ?? null : null;
    const phase = ring[at + 15], programs = ring[at + 13], scale = ring[at + 14], heap = ring[at + 10];
    if (phase !== last.phase && last.phase !== -2) push("phase", phase);
    if (K.ready && last.programs >= 0 && programs > last.programs) push("programs", programs - last.programs);
    if (last.scale >= 0 && scale !== last.scale) push("scale", r1(scale * 100) / 100);
    if (last.heap >= 0 && heap >= 0 && last.heap - heap > GC_DROP_MB) push("gc", Math.round(last.heap - heap));
    last.phase = phase; last.programs = programs; last.scale = scale; last.heap = heap;
    const streamed = K.streamMs ?? {}, modules = K.modules ?? [];
    for (const id in streamed) {
      if (resident.has(id) || failed.has(id)) continue;
      if (modules.includes(id)) { resident.add(id); push("module-built", streamed[id], id); }
      else { failed.add(id); push("module-failed", streamed[id], id); }
    }
    for (const id of resident) if (!modules.includes(id)) { resident.delete(id); push("module-dropped", 0, id); }
    if (p && g?.input) {
      const row = (pathCursor.rows % PATH_S) * PATH_W;
      path[row] = ring[at]; path[row + 1] = p.x; path[row + 2] = p.y; path[row + 3] = p.z;
      path[row + 4] = (g.input.yaw * 180) / Math.PI; path[row + 5] = (g.input.pitch * 180) / Math.PI; path[row + 6] = phase;
      pathCursor.rows++;
    }
    if (++seconds % BEAT_S === 0) {
      beat = { ...beat, at: Date.now(), upS: Math.round(ring[at]), phase, poi: p ? poiAt(p.x, p.z) : null, heapMB: Math.round(heap), textures: ring[at + 11], geometries: ring[at + 12], fps: Math.round(ring[at + 1]), hidden: document.visibilityState === "hidden" };
      writeBeat(beat);
    }
  };
}

/** what a report carries as ctx.diag */
export function snapshot() {
  const kept = Math.min(pathCursor.rows, PATH_S), rows: number[][] = [];
  for (let r = pathCursor.rows - kept; r < pathCursor.rows; r++) {
    const at = (r % PATH_S) * PATH_W;
    rows.push([r1(path[at]), r1(path[at + 1]), r1(path[at + 2]), r1(path[at + 3]), Math.round(path[at + 4]), Math.round(path[at + 5]), path[at + 6]]);
  }
  return { v: 1, sid, longFrames: loafKind, events: events.slice(), path: { fields: PATH_FIELDS, rows }, prev };
}
