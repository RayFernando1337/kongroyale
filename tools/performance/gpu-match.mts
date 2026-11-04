// Real-GPU, in-match frame timing: one seeded practice match (trios vs bots, seed 42) in Chrome on the machine's own
// GPU, measured with the game's normal requestAnimationFrame loop at a pinned video preset. Writes one
// kong-perf-result (schema.ts) per run; compare runs with compare.mts. The browser only loads the production server
// this script starts on 127.0.0.1 (AGENTS.md rule 7).
//
//   npx tsx tools/performance/gpu-match.mts --out reports/performance/gpu-base-1.json
//   npx tsx tools/performance/gpu-match.mts --root ../kong-cand --out reports/performance/gpu-cand-1.json
//
// Options: --root <checkout> (serve that checkout's dist/; build it first), --port 3031, --w 1920 --h 1080,
// --preset low|medium|high|epic (default high), --mode trios|solo, --pan-s 15 (seconds of scripted camera pan on the
// ground), --timeout-s 420 (whole match), --headed, --chrome <path> (else the installed Chrome channel),
// --angle d3d11|metal|vulkan|default (default: d3d11 on Windows, metal on macOS, vulkan on Linux),
// --shots <dir> (a screenshot per window), --trace <file> (a Chrome performance trace of the first --trace-s 30 s of
// the match), --query "a=1&b=2" (extra URL flags, e.g. an A/B switch). --query, --trace and --shots are recorded in
// config, so runs that differ in them never mix. A software renderer (SwiftShader, llvmpipe, ...) fails the run.
//
// Interleave baseline and candidate runs yourself (base, cand, base, cand ...), five or more a side, one at a time:
// a GPU runs ONE timed job at a time.
//
// What is measured. A wrapper around Engine.step (the whole frame: update hooks, culling, the post chain) records, per
// frame: the rAF interval, the main-thread step time, and an EXT_disjoint_timer_query_webgl2 TIME_ELAPSED query around
// the frame's GL work. Results are read asynchronously (never a blocking read); every query that was in flight when
// GPU_DISJOINT_EXT reports a disjoint event is discarded, and a frame without a valid sample stays unmeasured, never 0.
// The engine's own timer (dynamic resolution) is off (?dynres=0), so queries never nest.
//
// The route. Nothing moves the player but the match itself, so every run follows the same path: warm-up on the lobby
// islet (its first 15 s are the "slow start" window), the plane's chase camera across the island, the forced drop
// (freefall + glide), then a scripted constant-rate camera pan where the player lands. The only scripted inputs are
// JUMP, held from the moment the plane passes closest to the first safe circle, and the pan. Each becomes one case:
//   gpu/match/warmup-15s   the first 15 s after the match starts (island still streaming in)
//   gpu/match/plane        riding the plane once the island has streamed in (chase camera, ~720 m up)
//   gpu/match/descent      freefall + glide down to the ground
//   gpu/match/ground-pan   --pan-s seconds of a 0.6 rad/s yaw pan at eye height after landing
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { arg, env, save, source, stats } from "./common.mts";
import { pathToFileURL } from "node:url";
import { RESULT_SCHEMA, RESULT_VERSION, type CaseResult, type Metric, type RunResult } from "./schema.ts";

const root = path.resolve(arg("--root", "."));
const out = path.resolve(arg("--out", "reports/performance/gpu-match.json"));
const PORT = Number(arg("--port", "3031")), ORIGIN = "http://127.0.0.1:" + PORT;
const W = Number(arg("--w", "1920")), H = Number(arg("--h", "1080"));
const PRESET = arg("--preset", "high") as "low" | "medium" | "high" | "epic";
const MODE = arg("--mode", "trios") === "solo" ? "solo" : "trios";
const PAN_S = Number(arg("--pan-s", "15")), TIMEOUT_S = Number(arg("--timeout-s", "420"));
const PAN_RATE = 0.6, PAN_PITCH = -0.08, SEED = 42, WARM_WINDOW_S = 15;
const HEADED = process.argv.includes("--headed");
const SHOTS = arg("--shots", ""), TRACE = arg("--trace", ""), TRACE_S = Number(arg("--trace-s", "30"));
const EXTRA = arg("--query", "");
const ANGLE = arg("--angle", process.platform === "win32" ? "d3d11" : process.platform === "darwin" ? "metal" : "vulkan");
const CHROME = arg("--chrome", process.env.KR_CHROME ?? "");
const { PLANE_SPEED } = await import(pathToFileURL(path.join(root, "shared/sim/const.ts")).href) as { PLANE_SPEED: number };
if (!["low", "medium", "high", "epic"].includes(PRESET)) throw Error("--preset " + PRESET + ": one of low, medium, high, epic");
if (!fs.existsSync(path.join(root, "dist/index.html"))) throw Error(root + "/dist is missing: run npm run build in that checkout first");

const t0 = Date.now();
const { at: _at, ...base } = env();
const log = (m: string) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s  " + m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FLAGS = [
  ...(ANGLE === "default" ? [] : ["--use-angle=" + ANGLE]), "--enable-gpu", "--ignore-gpu-blocklist",
  "--autoplay-policy=no-user-gesture-required",
  // a covered or unfocused window must not throttle rAF or timers mid-run
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
];
// the video settings the game reads at boot (engine/display.ts, localStorage "kr-video"): an explicit preset at 100 %
// 3D resolution, no dynamic resolution, uncapped (every display refresh), so every run renders the same work
const PRESETS = {
  low: { aa: "fxaa", shadows: "low", ao: false, post: "low", viewDist: "low", foliage: "low", effects: "low" },
  medium: { aa: "taa", shadows: "medium", ao: true, post: "medium", viewDist: "medium", foliage: "medium", effects: "medium" },
  high: { aa: "taa", shadows: "high", ao: true, post: "high", viewDist: "high", foliage: "high", effects: "high" },
  epic: { aa: "taa", shadows: "epic", ao: true, post: "epic", viewDist: "epic", foliage: "epic", effects: "epic" },
};
const VIDEO = { v: 2, preset: PRESET, auto: PRESET, res3d: 1, resUser: true, dynres: false, fpsCap: 0, fov: 72, showFps: false, ...PRESETS[PRESET] };
const QUERY = "seed=" + SEED + "&dynres=0&dpr=1" + (EXTRA ? "&" + EXTRA : "");

// ---- server: the measured checkout's production entry point, loopback only
async function up() { try { return (await fetch(ORIGIN + "/", { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }
if (await up()) throw Error("something already answers on " + ORIGIN + "; pick another --port");
const serverLog: string[] = [];
const server: ChildProcess = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  cwd: root, env: { ...process.env, KR_SERVE: "1", KR_PORT: String(PORT), KR_HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
for (const s of [server.stdout!, server.stderr!]) s.on("data", (d: Buffer) => serverLog.push(...d.toString().split("\n").filter(Boolean)));
const stopServer = () => { if (server.exitCode === null) server.kill(); };
process.on("exit", stopServer);
for (let i = 0; !(await up()); i++) {
  if (server.exitCode !== null || i > 120) throw Error("the server did not come up:\n" + serverLog.slice(-20).join("\n"));
  await sleep(500);
}
log("server up on " + ORIGIN + " (" + root + ")");

// ---- the in-page collector: typed arrays sized up front, so recording allocates nothing per frame
function install(cfg: { maxFrames: number; panRate: number; panPitch: number; planeSpeed: number }) {
  type GL2 = WebGL2RenderingContext;
  const kr = (window as unknown as { __kr: Record<string, any> }).__kr, e = kr.engine;
  const gl = e.renderer.getContext() as GL2;
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const N = cfg.maxFrames;
  const c = { on: false, pan: false, n: 0, invalid: 0, disjoints: 0, timer: !!ext, jumping: false, jumpAt: null as null | Record<string, number>, T: new Float64Array(N), CPU: new Float32Array(N), GPU: new Float32Array(N).fill(-1), PH: new Int8Array(N).fill(-1), ST: new Int8Array(N).fill(-1), SR: new Int8Array(N) };
  // pending queries and the frame each one timed (-1 = discard: a disjoint event happened while it was in flight)
  const pq: WebGLQuery[] = [], pi: number[] = [], free: WebGLQuery[] = [];
  const step = e.step;
  e.step = function (dt: number) {
    const g = kr.game, cm = g?.cm;
    if (c.pan && cm && cm.pred.st === 0) { g.input.yaw += cfg.panRate * Math.min(dt, 0.1); g.input.pitch = cfg.panPitch; }
    // the drop: hold JUMP from the plane time at which its line passes closest to the first safe circle's centre (the
    // door opens at 6 s and the game ignores JUMP before that) until the player is out, so every run lands in the same
    // spot inside the circle
    if (c.on && cm && cm.pred.st === 4) {
      const pl = cm.plane, tStar = ((cm.storm.cx - pl.x0) * pl.dx + (cm.storm.cz - pl.z0) * pl.dz) / cfg.planeSpeed;
      if (!c.jumping && cm.planeT() >= tStar) {
        const pp = { x: 0, z: 0 }; cm.planePos(pp);
        c.jumping = true; c.jumpAt = { x: Math.round(pp.x), z: Math.round(pp.z), cx: Math.round(cm.storm.cx), cz: Math.round(cm.storm.cz), tStar: +tStar.toFixed(2), planeT: +cm.planeT().toFixed(2) };
        dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " " }));
      }
    } else if (c.jumping && cm) { c.jumping = false; dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " " })); }
    if (ext && pq.length) {
      let avail = 0;
      while (avail < pq.length && gl.getQueryParameter(pq[avail], gl.QUERY_RESULT_AVAILABLE)) avail++;
      if (avail) {
        if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { c.disjoints++; for (let k = 0; k < pi.length; k++) pi[k] = -1; }
        for (let k = 0; k < avail; k++) {
          const q = pq.shift()!, i = pi.shift()!;
          if (i >= 0) c.GPU[i] = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6; else c.invalid++;
          free.push(q);
        }
      }
    }
    if (!c.on || c.n >= N) return step.call(this, dt);
    const i = c.n++;
    const s0 = performance.now();
    c.T[i] = s0; c.PH[i] = cm?.phase ?? -1; c.ST[i] = cm?.pred.st ?? -1; c.SR[i] = kr.streamed ? 1 : 0;
    let q: WebGLQuery | null = null;
    if (ext && pq.length < 8) { q = free.pop() ?? gl.createQuery(); if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    try { step.call(this, dt); }
    finally {
      if (q && ext) { gl.endQuery(ext.TIME_ELAPSED_EXT); pq.push(q); pi.push(i); }
      c.CPU[i] = performance.now() - s0;
    }
  };
  kr.gpuCollector = c;
}

const browser: Browser = await chromium.launch({ executablePath: CHROME || undefined, channel: CHROME ? undefined : "chrome", headless: !HEADED, args: FLAGS, timeout: 120_000 });
const browserVersion = browser.version();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.addInitScript((v) => { try { localStorage.setItem("kr-video", v); localStorage.setItem("kr-fov-moved", "1"); } catch { /* private mode */ } }, JSON.stringify(VIDEO));
// tsx compiles the page functions below with esbuild's keepNames, which calls a __name helper the page doesn't have
await ctx.addInitScript("globalThis.__name = (f) => f;");
const page: Page = await ctx.newPage();
const pageErrors: string[] = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
const errors: string[] = [];
const artifacts: string[] = [];
const shot = async (name: string) => {
  if (!SHOTS) return;
  const f = path.resolve(SHOTS, path.basename(out, ".json") + "-" + name + ".png");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  await page.screenshot({ path: f }).then(() => artifacts.push(f), () => { /* best effort */ });
};

let exitCode = 0;
const marks: Record<string, number> = {};
const route: Record<string, unknown> = {};
let pageInfo: Record<string, unknown> = {};
let data: { n: number; invalid: number; disjoints: number; timer: boolean; T: number[]; CPU: number[]; GPU: number[]; PH: number[]; ST: number[]; SR: number[] } | null = null;
try {
  const load0 = Date.now();
  await page.goto(ORIGIN + "/?" + QUERY, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => (window as any).__kr?.ready === true || (window as any).__kr?.stage === "failed", null, { timeout: 300_000, polling: 250 });
  marks.readyWallMs = Date.now() - load0;
  pageInfo = await page.evaluate(() => {
    const kr = (window as any).__kr, r = kr.engine.renderer, gl = r.getContext() as WebGL2RenderingContext;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      stage: kr.stage, renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
      vendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
      timerQuery: !!gl.getExtension("EXT_disjoint_timer_query_webgl2"), video: kr.display?.settings ?? null,
      canvas: [r.domElement.width, r.domElement.height], dpr: devicePixelRatio, dprBase: kr.engine.dprBase, refreshHz: kr.engine.refreshHz, ua: navigator.userAgent,
    };
  });
  log("ready in " + (marks.readyWallMs / 1000).toFixed(1) + " s on " + pageInfo.renderer + "; timer query " + pageInfo.timerQuery);
  if (pageInfo.stage === "failed") throw Error("boot failed");
  if (/swiftshader|llvmpipe|softpipe|software|microsoft basic/i.test(String(pageInfo.renderer))) throw Error("software renderer " + pageInfo.renderer + ": not a real-GPU run");
  await page.evaluate(install, { maxFrames: Math.ceil(TIMEOUT_S * 250), panRate: PAN_RATE, panPitch: PAN_PITCH, planeSpeed: PLANE_SPEED });

  if (TRACE) await browser.startTracing(page, { path: TRACE, screenshots: false, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "v8.execute", "blink.user_timing", "gpu", "disabled-by-default-v8.gc"] });
  const click0 = Date.now();
  await page.evaluate((m) => { void (window as any).__kr.game.practice(m); }, MODE);
  await page.waitForFunction(() => (window as any).__kr.game?.inMatch === true, null, { timeout: 300_000, polling: 50 });
  await page.evaluate(() => { (window as any).__kr.gpuCollector.on = true; });
  marks.playToMatchMs = Date.now() - click0;
  log("in match " + (marks.playToMatchMs / 1000).toFixed(1) + " s after Play");

  const read = () => page.evaluate(() => { const cm = (window as any).__kr.game.cm; return cm ? { phase: cm.phase as number, st: cm.pred.st as number, alive: cm.alive as number, streamed: !!(window as any).__kr.streamed, x: Math.round(cm.pred.x), z: Math.round(cm.pred.z) } : null; });
  const m0 = Date.now();
  let tracing = !!TRACE, landedAt = 0, last = "";
  const seen = new Set<string>();
  for (;;) {
    const s = await read();
    const el = (Date.now() - m0) / 1000;
    if (tracing && el >= TRACE_S) { await browser.stopTracing(); tracing = false; artifacts.push(path.resolve(TRACE)); log("trace written " + TRACE); }
    if (s) {
      const tag = "phase " + s.phase + " st " + s.st;
      if (tag !== last) { last = tag; log(tag + " alive " + s.alive + " streamed " + s.streamed); }
      if (s.st === 4 && !seen.has("plane")) { seen.add("plane"); await sleep(8000); await shot("plane"); }
      if ((s.st === 1 || s.st === 2) && !seen.has("descent")) { seen.add("descent"); await sleep(3000); await shot("descent"); }
      if (s.phase >= 2 && s.st === 0 && !landedAt) {
        landedAt = Date.now(); route.landed = { x: s.x, z: s.z };
        route.jump = await page.evaluate(() => { const c = (window as any).__kr.gpuCollector; c.pan = true; return c.jumpAt; });
        log("landed at " + s.x + ", " + s.z + " (jumped at " + JSON.stringify(route.jump) + "): camera pan");
      }
      if (s.st === 3 || s.st === 5) { errors.push("the player died at " + el.toFixed(0) + " s; the ground window may be short"); break; }
    }
    if (landedAt && Date.now() - landedAt >= PAN_S * 1000) { await shot("ground-pan"); break; }
    if (el > TIMEOUT_S) { errors.push("timed out after " + TIMEOUT_S + " s (last " + last + ")"); break; }
    await sleep(250);
  }
  if (tracing) { await browser.stopTracing(); artifacts.push(path.resolve(TRACE)); }
  data = await page.evaluate(() => {
    const c = (window as any).__kr.gpuCollector; c.on = false; c.pan = false;
    const n = c.n, a = (x: ArrayLike<number>) => Array.from(x).slice(0, n);
    return { n, invalid: c.invalid, disjoints: c.disjoints, timer: c.timer, T: a(c.T), CPU: a(c.CPU), GPU: a(c.GPU), PH: a(c.PH), ST: a(c.ST), SR: a(c.SR) };
  });
  pageInfo.krErrors = await page.evaluate(() => (window as any).__kr.errors.slice(0, 20));
  pageInfo.renderScale = await page.evaluate(() => (window as any).__kr.engine.renderScale);
  pageInfo.streamedAt = await page.evaluate(() => (window as any).__kr.streamedAt ?? null);
  pageInfo.refreshHzEnd = await page.evaluate(() => (window as any).__kr.engine.refreshHz);
} catch (e) {
  errors.push("harness: " + (e instanceof Error ? e.message.split("\n")[0] : String(e)));
  exitCode = 1;
} finally {
  await browser.close().catch(() => { /* already gone */ });
  stopServer();
}

// ---- windows -> cases
const WINDOW_DEF: Record<string, string> = {
  "gpu/match/warmup-15s": "first " + WARM_WINDOW_S + " s after inMatch (lobby islet, island streaming)",
  "gpu/match/plane": "player state Plane (chase camera) once the island has finished streaming in",
  "gpu/match/descent": "player state Freefall or Glide",
  "gpu/match/ground-pan": "player state Ground in phase play, " + PAN_RATE + " rad/s yaw pan, " + PAN_S + " s",
};
const ms = (v: number[]): Metric => v.length ? { status: "ok", unit: "ms", better: "lower", summary: stats(v) } : { status: "invalid", unit: "ms", reason: "no frames in this window" };
function caseFor(id: string, idx: number[]): CaseResult {
  const d = data!, inWin = new Set(idx);
  const iv: number[] = [], gpu: number[] = [], cpu: number[] = [];
  for (const i of idx) { if (inWin.has(i - 1)) iv.push(d.T[i] - d.T[i - 1]); cpu.push(d.CPU[i]); if (d.GPU[i] >= 0) gpu.push(d.GPU[i]); }
  const secs = idx.length ? (d.T[idx[idx.length - 1]] - d.T[idx[0]]) / 1000 : 0;
  const coverage = idx.length ? gpu.length / idx.length : 0;
  const metrics: Record<string, Metric> = {
    frameIntervalMs: ms(iv),
    gpuFrameMs: !d.timer ? { status: "unsupported", unit: "ms", reason: "EXT_disjoint_timer_query_webgl2 is not exposed" } : gpu.length ? ms(gpu) : { status: "invalid", unit: "ms", reason: "no valid timer samples" },
    cpuStepMs: ms(cpu),
    fps: iv.length ? { status: "ok", unit: "1/s", better: "higher", value: iv.length / (iv.reduce((a, b) => a + b, 0) / 1000) } : { status: "invalid", unit: "1/s", reason: "no frames" },
    framesOver33ms: { status: "ok", unit: "count", better: "lower", value: iv.filter((x) => x > 1000 / 30).length },
    framesOver100ms: { status: "ok", unit: "count", better: "lower", value: iv.filter((x) => x > 100).length },
  };
  return {
    scenario: { id, version: 1, seed: SEED, workload: "real-play" },
    windows: { seconds: +secs.toFixed(2), frames: idx.length, definition: WINDOW_DEF[id] },
    load: { frames: idx.length, gpuSamples: gpu.length },
    metrics,
    gates: [
      { id: "gpuTimerCoverage", pass: !d.timer || coverage >= 0.5, detail: gpu.length + "/" + idx.length + " frames have a valid GPU sample (" + (coverage * 100).toFixed(0) + " %)" },
      { id: "windowLongEnough", pass: secs >= 5, detail: secs.toFixed(1) + " s" },
    ],
  };
}
const cases: CaseResult[] = [];
if (data && data.n) {
  const d = data, idx = (f: (i: number) => boolean) => { const r: number[] = []; for (let i = 0; i < d.n; i++) if (f(i)) r.push(i); return r; };
  cases.push(caseFor("gpu/match/warmup-15s", idx((i) => d.T[i] - d.T[0] <= WARM_WINDOW_S * 1000)));
  cases.push(caseFor("gpu/match/plane", idx((i) => d.ST[i] === 4 && d.SR[i] === 1)));
  cases.push(caseFor("gpu/match/descent", idx((i) => d.ST[i] === 1 || d.ST[i] === 2)));
  cases.push(caseFor("gpu/match/ground-pan", idx((i) => d.PH[i] >= 2 && d.ST[i] === 0)));
  const fmt = (m: Metric) => "summary" in m ? "p50 " + m.summary.p50.toFixed(2) + " p95 " + m.summary.p95.toFixed(2) + " p99 " + m.summary.p99.toFixed(2) : m.status;
  for (const c of cases) log(c.scenario.id + ": " + c.windows.seconds + " s, frame " + fmt(c.metrics.frameIntervalMs) + " | gpu " + fmt(c.metrics.gpuFrameMs) + " | " + c.gates.map((x) => x.id + " " + (x.pass ? "ok" : "FAIL")).join(", "));
}
const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }).trim(); } catch { return ""; } };
const winInfo = process.platform === "win32" ? {
  powerScheme: sh("powercfg", ["/getactivescheme"]).replace(/^.*\(([^)]+)\).*$/s, "$1"),
  gpuDriver: sh("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"]).split(/\r?\n/)[0] || null,
  onAC: sh("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Battery).BatteryStatus"]) === "2",
} : {};
const result: RunResult = {
  schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: "tools/performance/gpu-match.mts", startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0,
  source: source(root), environment: { ...base, gpu: data ? String(pageInfo.renderer) : null },
  config: { browser: "chrome " + browserVersion, flags: FLAGS.join(" "), headless: !HEADED, viewport: W + "x" + H, dpr: 1, preset: PRESET, res3d: 1, dynres: false, fpsCap: "display refresh", mode: MODE, seed: SEED, panS: PAN_S, query: QUERY, cache: "fresh browser profile per run", ...(TRACE ? { traceS: TRACE_S } : {}), ...(SHOTS ? { shots: true } : {}) },
  cases, errors: [...errors, ...pageErrors.map((e) => "pageerror: " + e), ...((pageInfo.krErrors as string[] | undefined) ?? []).map((e) => "__kr.errors: " + e.split("\n")[0])], artifacts,
};
(result as unknown as Record<string, unknown>).detail = {
  marks, route, page: pageInfo, host: { hostname: os.hostname(), ...winInfo }, timer: data ? { invalid: data.invalid, disjoints: data.disjoints, frames: data.n } : null,
  // the raw per-frame series (ms since the first recorded frame; gpu -1 = no valid sample), for re-windowing later
  frames: data ? { t: data.T.map((x) => +(x - data!.T[0]).toFixed(2)), cpu: data.CPU.map((x) => +x.toFixed(3)), gpu: data.GPU.map((x) => +x.toFixed(3)), phase: data.PH, st: data.ST, streamed: data.SR } : null,
};
save(out, result);
log("wrote " + out);
if (cases.some((c) => c.gates.some((g) => !g.pass)) || result.errors.length) exitCode = exitCode || 1;
process.exit(exitCode);
