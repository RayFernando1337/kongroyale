#!/usr/bin/env node
// Load profiler for Kong Royale: times one page load from navigation to the playable title (window.__kr.ready) and on
// to a started practice match, in Google Chrome or Microsoft Edge (CDP trace + CPU profile), real Safari (safaridriver /
// WebDriver) and Playwright WebKit (an automated stand-in that is NOT Safari), and writes one kong-perf-result file (schema.ts) per
// run, so runs compare with compare.mts. The method, what every number means and how to rank wins:
// .agents/skills/profile-kongroyale-load/SKILL.md. Run from the repository root with Node 22.12+:
//
//   npx tsx tools/performance/load-profile.mts run --url http://127.0.0.1:3140 --browsers chrome,safari --runs 3
//   npx tsx tools/performance/load-profile.mts table shots/load-profile/<stamp>/*/result.json
//
// A run is one fresh browser profile: a COLD load (empty HTTP cache, IndexedDB and shader caches), its practice match,
// then a WARM load in the same profile and its match. Every load goes through a local probe proxy that forwards to the
// server you started and injects the same measuring script into index.html in every browser (stage timeline, main
// thread blocks, frame times, blocking WebGL calls), and logs every request it forwards (bytes and timing per asset).
// Only local servers: the proxy refuses any host but 127.0.0.1 / localhost (AGENTS.md rule 7).
//
// run options: --url [label=]URL (repeat it for A/B; the URL may carry game flags)  --browsers chrome,edge,safari,webkit
//   --runs N (3)  --starts cold,warm  --match-secs N (15; 30 or more also snapshots memory and assets in plane and 30 s in) | --no-match  --no-trace (Chrome, Edge)  --no-gl (no WebGL probe)
//   --inspect (Safari: Web Inspector Timelines recording)  --headed  --viewport 1600x900  --dpr 2  --seed 42
//   --net MBPS,RTT_MS (shape the proxy's link)  --cooldown S (10)  --out DIR  --root CHECKOUT  --safaridriver-port 4471
// table options: --metrics a,b (default: the headline metrics)
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { env, save, source } from "./common.mts";
import { RESULT_SCHEMA, RESULT_VERSION, parseResult, type CaseResult, type Gate, type Metric, type RunResult } from "./schema.ts";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";
const all = (k: string) => argv.flatMap((a, i) => (a === k && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
const opt = (k: string, d: string) => all(k).at(-1) ?? d;
const flag = (k: string) => argv.includes(k);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = ["chrome", "edge", "safari", "webkit"] as const;
type Browser = (typeof BROWSERS)[number];
type Start = "cold" | "warm";
/** the scenario version: bump it when what a load does (flags, the match drive, the windows) changes */
const SCENARIO_VERSION = 2;
const READY_TIMEOUT_MS = 240_000, MATCH_TIMEOUT_MS = 120_000, MATCH_SNAP_MS = 30_000, PLANE_PHASE = 1;
const SNAP_POINTS = ["title", "plane", "match30"] as const;
type SnapPoint = (typeof SNAP_POINTS)[number];
/** a main-thread block at least this long counts as a long task (the web's long-task threshold) */
const LONG_MS = 50;
const SAFARIDRIVER = ["/System/Cryptexes/App/usr/bin/safaridriver", "/usr/bin/safaridriver"].find((p) => fs.existsSync(p)) ?? "safaridriver";
const TRACE_CATEGORIES = ["-*", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "toplevel", "v8", "v8.execute", "blink.user_timing", "loading", "gpu", "disabled-by-default-v8.cpu_profiler"];
/** __kr fields copied into the result: the game's own boot instrumentation (client/src/main.ts, game/index.ts) */
const KR_FIELDS = ["stage", "readyAt", "terrainMs", "buildMs", "afterBuildMs", "preReady", "preReadyPlan", "bootFactor", "gameStageAt", "prewarmMs", "prefabWarmMs", "matchWarmMs", "viewModelMs", "warmAllMs", "settleHolds", "settleHoldsMs", "programsAfterTitleModules", "programsAtReady", "streamed", "streamedAt", "streamedMs", "streamMs", "streamTotal", "prepareMs", "warmupHeld", "terrainBuild", "atmosFarBake", "atmosCloudShadowMs", "integrateLog", "lootSpots", "bootError"];

// ---------------------------------------------------------------- the in-page probe
// Injected by the proxy right before </body>: after the loading screen's inline script (it owns the window.__kr
// setter, which this wraps) and before the deferred game modules run (so the WebGL wrappers are in place before the
// game creates its context). Plain ES5-style JS in a string: it runs unchanged in every browser.
const PROBE = `(function () {
  if (window.__krProbe) return;
  var now = function () { return performance.now(); };
  var P = window.__krProbe = { at: now(), set: [], gaps: [], frames: [], gl: {}, glSlow: [], marks: {}, longtasks: [], loaf: [], hidden: 0, entryTypes: [] };
  try { performance.setResourceTimingBufferSize(20000); } catch (e) {}
  try { performance.mark("kr:probe"); } catch (e) {}
  function mark(name) { if (P.marks[name] === undefined) { P.marks[name] = now(); try { performance.mark("kr:" + name); } catch (e) {} } }
  // every write of the boot's stage fields, timestamped: main.ts and game/index.ts set them right before each step
  function hook(kr) {
    ["stage", "gameStage", "streamStage", "ready"].forEach(function (key) {
      var d = Object.getOwnPropertyDescriptor(kr, key), v = kr[key];
      if (v !== undefined) P.set.push([Math.round(now() * 10) / 10, key, String(v)]);
      Object.defineProperty(kr, key, { configurable: true, enumerable: true,
        get: function () { return d && d.get ? d.get.call(kr) : v; },
        set: function (nv) { P.set.push([Math.round(now() * 10) / 10, key, String(nv)]); if (key === "ready" && nv === true) mark("ready"); if (d && d.set) d.set.call(kr, nv); else v = nv; } });
    });
  }
  var wd = Object.getOwnPropertyDescriptor(window, "__kr"), own = window.__kr;
  Object.defineProperty(window, "__kr", { configurable: true, enumerable: true,
    get: function () { return wd && wd.get ? wd.get.call(window) : own; },
    set: function (o) { mark("kr"); if (wd && wd.set) wd.set.call(window, o); else own = o; if (o && typeof o === "object") hook(o); } });
  // main-thread blocks in any browser: a 10 ms timer; a gap well over its period is a long task or a long frame
  var last = now();
  (function tick() { var t = now(); if (t - last > 30) P.gaps.push([Math.round(last), Math.round(t - last)]); last = t; if (document.visibilityState !== "visible") P.hidden++; setTimeout(tick, 10); })();
  // the Play click itself, in the capture phase on window: before the button's own handler (ui/lobby.ts) runs
  addEventListener("click", function (e) { var el = e.target; if (el && el.closest && el.closest("button.tn-play-cta")) mark("click"); }, true);
  requestAnimationFrame(function frame(t) { P.frames.push(Math.round(t * 10) / 10); var k = window.__kr; if (k && k.game && k.game.inMatch) mark("inMatch"); requestAnimationFrame(frame); });
  // the WebGL calls that can block the main thread, timed per window (boot = before ready, title, match)
  var B = { compileShader: "shaderCompile", shaderSource: "shaderCompile", linkProgram: "shaderLink",
    getProgramParameter: "shaderStatus", getShaderParameter: "shaderStatus", getProgramInfoLog: "shaderStatus", getShaderInfoLog: "shaderStatus",
    getUniformLocation: "shaderFirstUse", getActiveUniform: "shaderFirstUse", getActiveAttrib: "shaderFirstUse", getAttribLocation: "shaderFirstUse", getUniformBlockIndex: "shaderFirstUse",
    texImage2D: "texture", texImage3D: "texture", texSubImage2D: "texture", texSubImage3D: "texture", compressedTexImage2D: "texture", compressedTexSubImage2D: "texture",
    compressedTexImage3D: "texture", compressedTexSubImage3D: "texture", texStorage2D: "texture", texStorage3D: "texture", generateMipmap: "texture",
    bufferData: "buffer", bufferSubData: "buffer", readPixels: "readback", getBufferSubData: "readback", clientWaitSync: "readback", finish: "readback" };
  function win() { var k = window.__kr; return !k || !k.ready ? "boot" : k.game && k.game.inMatch ? "match" : "title"; }
  [window.WebGL2RenderingContext, window.WebGLRenderingContext].forEach(function (C) {
    if (!C || !@GL) return;
    Object.keys(B).forEach(function (name) {
      var f = C.prototype[name], bucket = B[name];
      if (typeof f !== "function") return;
      C.prototype[name] = function () {
        var t = now();
        try { return f.apply(this, arguments); } finally {
          var d = now() - t, key = win() + "." + bucket, s = P.gl[key] || (P.gl[key] = [0, 0, 0]);
          s[0]++; s[1] += d; if (d > s[2]) s[2] = d;
          if (d >= 8 && P.glSlow.length < 3000) P.glSlow.push([Math.round(t), name, Math.round(d)]);
        }
      };
    });
  });
  // the browser's own long-task and long-animation-frame entries where it has them (Chrome; not Safari)
  try {
    var types = (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes) || [];
    P.entryTypes = types.slice();
    if (types.indexOf("longtask") >= 0) new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { P.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]); }); }).observe({ type: "longtask", buffered: true });
    if (types.indexOf("long-animation-frame") >= 0) new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) {
      if (P.loaf.length >= 3000) return;
      P.loaf.push([Math.round(e.startTime), Math.round(e.duration), Math.round(e.blockingDuration || 0), (e.scripts || []).slice(0, 3).map(function (s) {
        return [Math.round(s.duration), String(s.invoker || "").slice(0, 80), String(s.sourceFunctionName || ""), String(s.sourceURL || "").replace(location.origin, "").slice(0, 120)]; })]); }); }).observe({ type: "long-animation-frame", buffered: true });
  } catch (e) {}
})();`;
const STATUS = `JSON.stringify({ ready: !!(window.__kr && window.__kr.ready), stage: window.__kr ? String(window.__kr.stage) : "none", inMatch: !!(window.__kr && window.__kr.game && window.__kr.game.inMatch), phase: window.__kr && window.__kr.game && window.__kr.game.cm ? window.__kr.game.cm.phase : -1, probe: !!window.__krProbe })`;
const HEAP = `JSON.stringify({ at: performance.now(), mb: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null })`;
const snapExpr = (point: SnapPoint) => `(function (point) {
  var k = window.__kr || {}, s = { point: point, at: performance.now(), jsHeapMB: null, uaWhy: null, info: null };
  if (performance.memory) s.jsHeapMB = performance.memory.usedJSHeapSize / 1e6;
  var M = window.__krMem = window.__krMem || {};
  if (!window.crossOriginIsolated) s.uaWhy = "performance.measureUserAgentSpecificMemory needs a cross-origin isolated page (COOP and COEP headers)";
  else if (typeof performance.measureUserAgentSpecificMemory !== "function") s.uaWhy = "performance.measureUserAgentSpecificMemory is not available in this browser";
  else { M[point] = { pending: true }; performance.measureUserAgentSpecificMemory().then(function (r) { M[point] = { bytes: r.bytes }; }, function (e) { M[point] = { error: String(e) }; }); }
  try { var r = k.engine && k.engine.renderer; if (r && r.info) s.info = { geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs ? r.info.programs.length : null }; } catch (e) {}
  return JSON.stringify(s);
})(${JSON.stringify(point)})`;
const COLLECT = `(function () {
  var k = window.__kr || {}, P = window.__krProbe || null, n = performance.getEntriesByType("navigation")[0];
  var nav = n ? { requestStart: n.requestStart, responseStart: n.responseStart, responseEnd: n.responseEnd, domInteractive: n.domInteractive, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd } : null;
  var res = performance.getEntriesByType("resource").map(function (e) { return [e.name.replace(location.origin, ""), Math.round(e.startTime), Math.round(e.responseEnd), e.transferSize === undefined ? -1 : e.transferSize, e.encodedBodySize === undefined ? -1 : e.encodedBodySize, e.decodedBodySize === undefined ? -1 : e.decodedBodySize]; });
  var gl = null;
  try { var r = k.engine && k.engine.renderer, c = r && r.getContext(); if (c) { var dbg = c.getExtension("WEBGL_debug_renderer_info");
    gl = { renderer: String(dbg ? c.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER)), version: String(c.getParameter(c.VERSION)), parallelCompile: !!c.getExtension("KHR_parallel_shader_compile"),
      timerQuery: !!c.getExtension("EXT_disjoint_timer_query_webgl2"), pixelRatio: r.getPixelRatio(), buffer: [c.drawingBufferWidth, c.drawingBufferHeight] }; } } catch (e) {}
  var pick = {}; @FIELDS.forEach(function (f) { try { var v = k[f]; if (v !== undefined && typeof v !== "function") pick[f] = JSON.parse(JSON.stringify(v)); } catch (e) {} });
  var splat = null; try { splat = JSON.parse(JSON.stringify(k.veg.splats.stats)); } catch (e) {}
  return JSON.stringify({ now: performance.now(), nav: nav, res: res, kr: pick, mem: window.__krMem || null, errors: (k.errors || []).slice(0, 20).map(function (s) { return String(s).slice(0, 400); }), probe: P, gl: gl, splat: splat,
    dpr: devicePixelRatio, inner: [innerWidth, innerHeight], ua: navigator.userAgent });
})()`.replace("@FIELDS", JSON.stringify(KR_FIELDS));

// ---------------------------------------------------------------- probe proxy
interface Hit { load: number; url: string; status: number; t0: number; t1: number; t2: number; bytes: number; enc: string }
interface Proxy { port: number; hits: Hit[]; close: () => void }
function startProxy(target: URL, shape: { mbps: number; rttMs: number } | null, probe: string): Promise<Proxy> {
  const hits: Hit[] = [];
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  let load = 0, linkFree = 0;
  // --net: one shared link for every response (bandwidth) plus one round trip before each response's first byte
  const pace = async (n: number) => {
    if (!shape) return;
    const t = performance.now();
    linkFree = Math.max(linkFree, t) + n / (shape.mbps * 125);
    if (linkFree - t > 1) await sleep(linkFree - t);
  };
  const server = http.createServer((req, res) => {
    const t0 = performance.now(), url = req.url ?? "/";
    const doc = /^\/(\?|index\.html|$)/.test(url) && String(req.headers.accept ?? "").includes("text/html");
    if (doc) load++;
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
    // the document always comes back whole and uncompressed, so the probe can go in
    if (doc) { headers["accept-encoding"] = "identity"; delete headers["if-none-match"]; delete headers["if-modified-since"]; }
    const up = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: url, headers, agent }, async (ur) => {
      if (shape) await sleep(shape.rttMs);
      const hit: Hit = { load, url, status: ur.statusCode ?? 0, t0, t1: performance.now(), t2: 0, bytes: 0, enc: String(ur.headers["content-encoding"] ?? "") };
      hits.push(hit);
      const out = { ...ur.headers };
      res.on("finish", () => { hit.t2 = performance.now(); });
      if (doc && ur.statusCode === 200 && /html/.test(String(ur.headers["content-type"]))) {
        const chunks: Buffer[] = [];
        ur.on("data", (c: Buffer) => chunks.push(c));
        ur.on("end", async () => {
          const html = Buffer.concat(chunks).toString("utf8"), i = html.lastIndexOf("</body>"), tag = "<script>" + probe + "</script>";
          const body = Buffer.from(i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag);
          delete out.etag; out["content-length"] = String(body.length); out["cache-control"] = "no-store";
          await pace(body.length);
          hit.bytes = body.length;
          res.writeHead(ur.statusCode ?? 200, out); res.end(body);
        });
        return;
      }
      res.writeHead(ur.statusCode ?? 502, out);
      if (!shape) { ur.on("data", (c: Buffer) => { hit.bytes += c.length; }); ur.pipe(res); return; }
      // every chunk waits for the one before it, and the response ends only after the last paced write
      let chain = Promise.resolve();
      ur.on("data", (c: Buffer) => {
        ur.pause();
        chain = chain.then(async () => {
          await pace(c.length); hit.bytes += c.length;
          if (!res.write(c)) await new Promise((r) => res.once("drain", r));
        }).finally(() => ur.resume());
      });
      ur.on("end", () => { chain = chain.then(() => { res.end(); }); });
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  // WebSockets (the game's /ws, Vite's client) pass through untouched
  server.on("upgrade", (req, sock, head) => {
    const up = net.connect(Number(target.port || 80), target.hostname, () => {
      const lines = [req.method + " " + req.url + " HTTP/1.1"];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(req.rawHeaders[i] + ": " + (/^host$/i.test(req.rawHeaders[i]) ? target.host : req.rawHeaders[i + 1]));
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, hits, close: () => { server.closeAllConnections(); server.close(); agent.destroy(); } }));
  });
}

// ---------------------------------------------------------------- browsers
interface Driver { browser: Browser; version: string; headless: boolean; open(url: string): Promise<void>; run(expr: string): Promise<string>; click(sel: string): Promise<void>; shot(base: string): Promise<string>; trace?: { start(): Promise<void>; stop(): Promise<Buffer> }; gc?(): Promise<void>; close(): Promise<void> }
interface Opts { viewport: [number, number]; dpr: number; headed: boolean; trace: boolean; inspect: boolean; sdPort: number }

async function playwrightDriver(kind: "chrome" | "edge" | "webkit", o: Opts): Promise<Driver> {
  const pw = await import("playwright");
  const angle = process.platform === "darwin" ? "metal" : process.platform === "win32" ? "d3d11" : "swiftshader";
  // a fresh on-disk profile per run: the cold load starts empty, and the warm load gets a real disk cache (an
  // incognito-style context keeps only a small in-memory cache, which a returning player does not have)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kr-load-profile-"));
  const common = { headless: !o.headed, viewport: { width: o.viewport[0], height: o.viewport[1] }, deviceScaleFactor: o.dpr, timeout: 120_000 };
  const ctx = kind !== "webkit"
    ? await pw.chromium.launchPersistentContext(dir, { ...common, channel: kind === "edge" ? "msedge" : "chrome", args: ["--use-angle=" + angle, "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info"] })
    : await pw.webkit.launchPersistentContext(dir, common);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const ua = String(await page.evaluate("navigator.userAgent"));
  const d: Driver = {
    browser: kind, version: (kind === "edge" ? /Edg\/([\d.]+)/ : kind === "chrome" ? /Chrome\/([\d.]+)/ : /Version\/([\d.]+)/).exec(ua)?.[1] ?? ua, headless: !o.headed,
    open: async (url) => { await page.goto(url, { waitUntil: "commit", timeout: 120_000 }); },
    run: (expr) => page.evaluate(expr) as Promise<string>,
    click: (sel) => page.locator(sel).click({ timeout: 30_000 }),
    shot: async (base) => { const file = base + ".jpg"; await page.screenshot({ path: file, type: "jpeg", quality: 70 }); return file; },
    close: async () => { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  if (kind !== "webkit") {
    const heap = await ctx.newCDPSession(page);
    d.gc = async () => { await heap.send("HeapProfiler.collectGarbage"); await heap.send("HeapProfiler.collectGarbage"); };
  }
  if (kind !== "webkit" && o.trace) {
    // CDP Tracing from the page's session: the trace is browser-wide (renderer, GPU process, workers)
    const cdp = await ctx.newCDPSession(page);
    d.trace = {
      start: async () => { await cdp.send("Tracing.start", { categories: TRACE_CATEGORIES.join(","), transferMode: "ReturnAsStream" }); },
      stop: async () => {
        const done = new Promise<string>((r) => cdp.once("Tracing.tracingComplete", (e) => r(String(e.stream))));
        await cdp.send("Tracing.end");
        const handle = await done, chunks: Buffer[] = [];
        for (;;) {
          const c = await cdp.send("IO.read", { handle, size: 4 << 20 });
          chunks.push(Buffer.from(c.data, c.base64Encoded ? "base64" : "utf8"));
          if (c.eof) break;
        }
        await cdp.send("IO.close", { handle });
        return Buffer.concat(chunks);
      },
    };
  }
  return d;
}

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
async function safariDriver(o: Opts): Promise<Driver> {
  const base = "http://127.0.0.1:" + o.sdPort;
  const proc = spawn(SAFARIDRIVER, ["-p", String(o.sdPort)], { stdio: "ignore" });
  const wd = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json()) as { value: { error?: string; message?: string } & Record<string, unknown> };
    if (j.value && j.value.error) throw new Error("safaridriver " + method + " " + p + ": " + j.value.error + ": " + j.value.message);
    return j.value as any;
  };
  for (let i = 0; i < 40; i++) { try { await wd("GET", "/status"); break; } catch { await sleep(250); } }
  let sid = "";
  try {
    // safari:automaticProfiling starts a Web Inspector Timelines recording with the session (the manual deep dive)
    const s = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari", "safari:automaticProfiling": o.inspect, "safari:automaticInspection": false } } });
    sid = "/session/" + s.sessionId;
    await wd("POST", sid + "/timeouts", { script: 120_000, pageLoad: 300_000, implicit: 0 });
    // size the window so the page's viewport matches the other browsers'
    let w = o.viewport[0], h = o.viewport[1] + 100;
    for (let i = 0; i < 3; i++) {
      await wd("POST", sid + "/window/rect", { x: 0, y: 0, width: w, height: h });
      const [iw, ih] = JSON.parse(await wd("POST", sid + "/execute/sync", { script: "return JSON.stringify([innerWidth, innerHeight])", args: [] })) as number[];
      if (iw === o.viewport[0] && ih === o.viewport[1]) break;
      w += o.viewport[0] - iw; h += o.viewport[1] - ih;
    }
    return {
      browser: "safari", version: String(s.capabilities?.browserVersion ?? "?"), headless: false,
      open: async (url) => { await wd("POST", sid + "/url", { url }); },
      run: async (expr) => String(await wd("POST", sid + "/execute/sync", { script: "return " + expr, args: [] })),
      click: async (sel) => { const el = await wd("POST", sid + "/element", { using: "css selector", value: sel }); await wd("POST", sid + "/element/" + el[ELEMENT] + "/click", {}); },
      shot: async (base) => { const file = base + ".png"; fs.writeFileSync(file, Buffer.from(String(await wd("GET", sid + "/screenshot")), "base64")); return file; },
      close: async () => { try { await wd("DELETE", sid); } catch { /* already gone */ } proc.kill(); },
    };
  } catch (e) {
    if (sid) await wd("DELETE", sid).catch(() => {});
    proc.kill();
    throw e;
  }
}
const launch = (b: Browser, o: Opts) => (b === "safari" ? safariDriver(o) : playwrightDriver(b, o));
/** macOS: a locked screen stops a headed Safari window's frames (its page still reports "visible"), so the boot stalls */
const screenLocked = () => process.platform === "darwin" && /CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(spawnSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8" }).stdout ?? "");
const LOCKED = "the screen is locked: a headed Safari window renders no frames then, so its load stalls. Unlock the Mac and keep it unlocked for the run (the run keeps the display awake with caffeinate)";

// ---------------------------------------------------------------- one load
interface Snap { now: number; nav: Record<string, number> | null; res: Array<[string, number, number, number, number, number]>; kr: Record<string, any>; mem: Record<string, { pending?: boolean; bytes?: number; error?: string }> | null; errors: string[]; probe: Probe | null; gl: Record<string, any> | null; splat: unknown; dpr: number; inner: number[]; ua: string }
interface Probe { at: number; set: Array<[number, string, string]>; gaps: Array<[number, number]>; frames: number[]; gl: Record<string, [number, number, number]>; glSlow: Array<[number, string, number]>; marks: Record<string, number>; longtasks: Array<[number, number]>; loaf: unknown[]; hidden: number; entryTypes: string[] }
interface PointSnap { point: SnapPoint; at: number; jsHeapMB: number | null; jsHeapGcMB?: number | null; gc?: [number, number]; uaWhy: string | null; info: { geometries: number; textures: number; programs: number | null } | null }
interface Load { start: Start; boot: Snap; fin: Snap; points: PointSnap[]; hits: Hit[]; trace: TraceSummary | null; artifacts: string[]; failure?: string }

interface Status { ready: boolean; stage: string; inMatch: boolean; phase: number }
async function poll(d: Driver, until: (s: Status) => boolean, ms: number): Promise<Status> {
  const t0 = Date.now();
  for (;;) {
    const s = JSON.parse(await d.run(STATUS));
    if (until(s) || Date.now() - t0 > ms) return s;
    await sleep(250);
  }
}

async function loadOnce(d: Driver, start: Start, url: string, out: string, proxy: Proxy, matchSecs: number): Promise<Load> {
  const artifacts: string[] = [];
  await d.open("about:blank");
  const before = proxy.hits.length;
  if (d.trace) await d.trace.start();
  let trace: Buffer | null = null, failure: string | undefined;
  await d.open(url);
  const s = await poll(d, (x) => x.ready || x.stage === "failed", READY_TIMEOUT_MS);
  const points: PointSnap[] = [];
  const snap = async (p: SnapPoint) => {
    const s = JSON.parse(await d.run(snapExpr(p))) as PointSnap;
    if (d.gc) {
      const before = JSON.parse(await d.run(HEAP)) as { at: number; mb: number | null };
      await d.gc();
      const after = JSON.parse(await d.run(HEAP)) as { at: number; mb: number | null };
      s.jsHeapGcMB = after.mb; s.gc = [before.at, after.at];
    }
    points.push(s);
  };
  if (s.ready) await snap("title");
  artifacts.push(await d.shot(path.join(out, "title-" + start)));
  const boot: Snap = JSON.parse(await d.run(COLLECT));
  if (!s.ready) failure = "the title never became ready (stage " + s.stage + ")";
  if (s.ready && matchSecs > 0) {
    await d.click("button.tn-play-cta");
    const m = await poll(d, (x) => x.inMatch, MATCH_TIMEOUT_MS);
    if (!m.inMatch) failure = "the practice match did not start within " + MATCH_TIMEOUT_MS / 1000 + " s";
    else {
      const t0 = Date.now();
      while (Date.now() - t0 < matchSecs * 1000 + 300) {
        const x: Status = JSON.parse(await d.run(STATUS));
        if (x.phase === PLANE_PHASE && !points.some((p) => p.point === "plane")) await snap("plane");
        if (Date.now() - t0 >= MATCH_SNAP_MS && !points.some((p) => p.point === "match30")) await snap("match30");
        await sleep(250);
      }
    }
    artifacts.push(await d.shot(path.join(out, "match-" + start)));
  }
  const fin: Snap = JSON.parse(await d.run(COLLECT));
  if (d.trace) trace = await d.trace.stop();
  let summary: TraceSummary | null = null;
  if (trace) {
    const tracePath = path.join(out, "trace-" + start + ".json.gz"), cpuPath = path.join(out, "cpu-" + start + ".cpuprofile");
    fs.writeFileSync(tracePath, zlib.gzipSync(trace)); artifacts.push(tracePath);
    try { summary = analyzeTrace(trace, fin, matchSecs, cpuPath); artifacts.push(cpuPath); } catch (e) { summary = { error: String((e as Error).message ?? e) } as TraceSummary; }
  }
  return { start, boot, fin, points, hits: proxy.hits.slice(before), trace: summary, artifacts, failure };
}

// ---------------------------------------------------------------- Chrome trace analysis
interface TraceSummary { error?: string; mainThread?: string; bootMs?: Record<string, number>; matchMs?: Record<string, number>; topEvents?: Array<[string, number]>; longTasks?: { n: number; ms: number; max: number; top: Array<{ atMs: number; ms: number; top: Array<[string, number]> }> }; gpuProcess?: { mainBusyMs: number; threads: Array<[string, number]> }; js?: { totalMs: number; programMs: number; gcMs: number; topFunctions: Array<[string, number]>; topUrls: Array<[string, number]> } }
interface Span { name: string; cat: string; ts: number; end: number; self: number; root: Span | null }
function classOf(s: Span) {
  if (/^(MajorGC|MinorGC|V8\.GC|BlinkGC|GCEvent|V8\.Scavenge|ThreadState::|CppGC)/.test(s.name) || /v8\.gc|\bgc\b/i.test(s.cat)) return "gc";
  if (/^(ParseHTML|ParseAuthorStyleSheet|UpdateLayoutTree|RecalculateStyles|Layout|PrePaint|Paint|Layerize|UpdateLayer|Commit|CompositeLayers|HitTest)$/.test(s.name)) return "styleLayoutPaint";
  if (/Decode Image|ImageDecode|Decode LazyPixelRef|DecodeImage|ImageFrameGenerator/.test(s.name)) return "decode";
  if (/compile|parse|produceCache|deserialize|CacheScript/i.test(s.name)) return "parseCompile";
  if (/gpu/i.test(s.cat) && /wait|finish|flush|synctoken/i.test(s.name)) return "gpuWait";
  if (/^(EvaluateScript|v8\.evaluateModule|v8\.run|FunctionCall|TimerFire|FireAnimationFrame|RunMicrotasks|V8\.Execute|EventDispatch|v8\.callFunction|v8\.execute|v8\.newInstance|V8\.RunMicrotasks|FireIdleCallback|XHRReadyStateChange)$/.test(s.name)) return "scripting";
  return "other";
}
function spansOf(evs: any[], pid: number, tid: number): Span[] {
  const list: Span[] = [], open: any[] = [];
  for (const e of evs) {
    if (e.pid !== pid || e.tid !== tid) continue;
    if (e.ph === "X" && typeof e.dur === "number") list.push({ name: e.name, cat: String(e.cat ?? ""), ts: e.ts, end: e.ts + e.dur, self: 0, root: null });
    else if (e.ph === "B") open.push(e);
    else if (e.ph === "E") { const b = open.pop(); if (b) list.push({ name: b.name, cat: String(b.cat ?? ""), ts: b.ts, end: e.ts, self: 0, root: null }); }
  }
  list.sort((a, b) => a.ts - b.ts || b.end - a.end);
  const stack: Span[] = [];
  for (const s of list) {
    while (stack.length && stack[stack.length - 1].end <= s.ts) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.self -= Math.min(s.end, parent.end) - s.ts;
    s.self = s.end - s.ts; s.root = stack.length ? stack[0] : null;
    stack.push(s);
  }
  return list;
}
function analyzeTrace(buf: Buffer, fin: Snap, matchSecs: number, cpuOut: string): TraceSummary {
  const data = JSON.parse(buf.toString("utf8"));
  const evs: any[] = Array.isArray(data) ? data : data.traceEvents ?? [];
  const P = fin.probe!, readyAt = Number(fin.kr.readyAt ?? 0), inMatch = P.marks.inMatch;
  const probe = evs.find((e) => e.name === "kr:probe" && String(e.cat).includes("blink.user_timing"));
  if (!probe) return { error: "no kr:probe mark in the trace" };
  const threadName = new Map<string, string>(), procName = new Map<number, string>();
  for (const e of evs) if (e.ph === "M") { if (e.name === "thread_name") threadName.set(e.pid + ":" + e.tid, e.args?.name); if (e.name === "process_name") procName.set(e.pid, e.args?.name); }
  // the page's clock: navigation start on the trace clock (us) from the probe's mark and its own performance.now()
  const nav0 = probe.ts - P.at * 1000, at = (ms: number) => nav0 + ms * 1000;
  const bootWin: [number, number] = [at(0), at(readyAt || P.marks.ready || 0)];
  const matchWin: [number, number] | null = inMatch ? [at(inMatch), at(inMatch + matchSecs * 1000)] : null;
  const spans = spansOf(evs, probe.pid, probe.tid);
  const inWin = (s: Span, w: [number, number]) => s.ts >= w[0] && s.ts < w[1];
  const byClass = (w: [number, number]) => {
    const out: Record<string, number> = {};
    for (const s of spans) if (inWin(s, w)) out[classOf(s)] = (out[classOf(s)] ?? 0) + s.self / 1000;
    for (const k in out) out[k] = Math.round(out[k]);
    return out;
  };
  const names = new Map<string, number>();
  for (const s of spans) if (inWin(s, bootWin)) names.set(s.name, (names.get(s.name) ?? 0) + s.self / 1000);
  const tops = spans.filter((s) => !s.root && inWin(s, bootWin) && s.end - s.ts >= LONG_MS * 1000);
  const inner = new Map<Span, Map<string, number>>();
  for (const s of spans) if (s.root && tops.includes(s.root)) { const m = inner.get(s.root) ?? new Map(); m.set(s.name, (m.get(s.name) ?? 0) + s.self / 1000); inner.set(s.root, m); }
  const longTasks = {
    n: tops.length, ms: Math.round(tops.reduce((a, s) => a + (s.end - s.ts) / 1000, 0)), max: Math.round(Math.max(0, ...tops.map((s) => (s.end - s.ts) / 1000))),
    top: [...tops].sort((a, b) => b.end - b.ts - (a.end - a.ts)).slice(0, 12).map((s) => ({ atMs: Math.round((s.ts - nav0) / 1000), ms: Math.round((s.end - s.ts) / 1000), top: [...(inner.get(s) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, v]) => [n, Math.round(v)] as [string, number]) })),
  };
  // the GPU process: ANGLE's shader translation and Metal compiles, texture uploads; the page waits on it in gpuWait
  const gpuPid = [...procName.entries()].find(([, n]) => /gpu/i.test(n))?.[0];
  let gpuProcess: TraceSummary["gpuProcess"];
  if (gpuPid !== undefined) {
    const busy = new Map<string, number>();
    for (const [key, name] of threadName) {
      const [p, t] = key.split(":").map(Number);
      if (p !== gpuPid) continue;
      const ms = spansOf(evs, p, t).filter((s) => !s.root && inWin(s, bootWin)).reduce((a, s) => a + (s.end - s.ts) / 1000, 0);
      if (ms > 0) busy.set(name, (busy.get(name) ?? 0) + ms);
    }
    gpuProcess = { mainBusyMs: Math.round(busy.get("CrGpuMain") ?? 0), threads: [...busy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, v]) => [n, Math.round(v)]) };
  }
  return { mainThread: threadName.get(probe.pid + ":" + probe.tid) ?? "?", bootMs: byClass(bootWin), matchMs: matchWin ? byClass(matchWin) : undefined,
    topEvents: [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, v]) => [n, Math.round(v)]), longTasks, gpuProcess, js: cpuProfile(evs, probe.pid, probe.tid, bootWin, cpuOut) };
}
/** the sampled CPU profile of the page's main thread, from the trace's ProfileChunk events: written as a .cpuprofile
 *  (DevTools Performance or JavaScript Profiler opens it) and summarised over the boot window */
function cpuProfile(evs: any[], pid: number, tid: number, w: [number, number], out: string): TraceSummary["js"] {
  const nodes = new Map<number, { id: number; callFrame: any; parent?: number; hitCount: number; children: number[] }>();
  const samples: number[] = [], deltas: number[] = [];
  // the Profile event sits on the sampled thread; its chunks come from V8's profiler thread under the same id
  const prof = evs.find((e) => e.name === "Profile" && e.pid === pid && e.tid === tid);
  if (!prof) return undefined;
  const startTime = Number(prof.args?.data?.startTime ?? prof.ts);
  for (const e of evs) {
    if (e.name !== "ProfileChunk" || e.pid !== pid || e.id !== prof.id) continue;
    const cp = e.args?.data?.cpuProfile ?? {};
    for (const n of cp.nodes ?? []) nodes.set(n.id, { id: n.id, callFrame: n.callFrame, parent: n.parent, hitCount: 0, children: [] });
    samples.push(...(cp.samples ?? [])); deltas.push(...(e.args?.data?.timeDeltas ?? []));
  }
  if (!samples.length) return undefined;
  for (const n of nodes.values()) if (n.parent !== undefined) nodes.get(n.parent)?.children.push(n.id);
  const fn = new Map<string, number>(), url = new Map<string, number>();
  let t = startTime, js = 0, program = 0, gc = 0;
  for (let i = 0; i < samples.length; i++) {
    t += deltas[i] ?? 0;
    const n = nodes.get(samples[i]);
    if (n) n.hitCount++;
    if (!n || t < w[0] || t >= w[1]) continue;
    const dt = Math.min(10_000, Math.max(0, deltas[i + 1] ?? 0)) / 1000, f = n.callFrame ?? {};
    if (f.functionName === "(idle)" || f.functionName === "(root)") continue;
    if (f.functionName === "(program)") { program += dt; continue; }
    if (f.functionName === "(garbage collector)") { gc += dt; continue; }
    js += dt;
    const where = String(f.url ?? "").replace(/^https?:\/\/[^/]+/, "") || "(native)";
    const k = (f.functionName || "(anonymous)") + " " + where + ":" + ((f.lineNumber ?? -1) + 1);
    fn.set(k, (fn.get(k) ?? 0) + dt); url.set(where, (url.get(where) ?? 0) + dt);
  }
  fs.writeFileSync(out, JSON.stringify({ nodes: [...nodes.values()], startTime, endTime: t, samples, timeDeltas: deltas }));
  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v)] as [string, number]);
  return { totalMs: Math.round(js), programMs: Math.round(program), gcMs: Math.round(gc), topFunctions: top(fn, 25), topUrls: top(url, 15) };
}

// ---------------------------------------------------------------- one load -> one case
const CLASSES: Array<[string, RegExp]> = [["html", /\.html?$|^\/$/], ["js", /\.(m?js|ts|tsx|css)$/], ["wasm", /\.wasm$/], ["model", /\.(glb|gltf)$/], ["texture", /\.(webp|png|jpe?g|ktx2|avif|hdr|exr|svg)$/], ["audio", /\.(ogg|m4a|mp3|flac|wav)$/], ["font", /\.(woff2?|ttf|otf)$/], ["data", /\.(bin|json|txt)$/]];
const classify = (u: string) => { const p = u.split("?")[0]; return CLASSES.find(([, re]) => re.test(p))?.[0] ?? "other"; };
const ms = (v: unknown): Metric => (typeof v === "number" && Number.isFinite(v) ? { status: "ok", unit: "ms", better: "lower", value: Math.round(v) } : { status: "invalid", unit: "ms", reason: "not reached in this run" });
const num = (v: number, unit: "count" | "MB"): Metric => ({ status: "ok", unit, better: "lower", value: unit === "MB" ? Math.round(v * 100) / 100 : v });
const unsupported = (unit: "ms" | "count" | "MB", reason: string): Metric => ({ status: "unsupported", unit, reason });
const notReached = (unit: "count" | "MB", reason: string): Metric => ({ status: "invalid", unit, reason });

/** the label of the boot step running at page time t, from the probe's stage timeline */
function labeller(set: Array<[number, string, string]>, marks: Record<string, number>) {
  const sorted = [...set].sort((a, b) => a[0] - b[0]);
  return (t: number) => {
    const cur: Record<string, string> = {};
    for (const [at, k, v] of sorted) { if (at > t) break; cur[k] = v; }
    if (marks.kr === undefined || t < marks.kr) return "html+main-script";
    if (marks.inMatch !== undefined && t >= marks.inMatch) return "match";
    if (marks.click !== undefined && t >= marks.click) return "match-start";
    if (cur.ready === "true") return "title:" + (cur.streamStage ?? "idle").replace(/:(compile|draw|first-use|textures)$/, ":integrate-$1").split(":").slice(0, 3).join(":");
    const st = cur.stage ?? "boot";
    if (st === "game") return "game:" + (cur.gameStage ?? "").replace(/:\d+$/, "");
    return st;
  };
}
/** coarse phase of a label (the per-phase table of SKILL.md) */
function phaseOf(label: string) {
  if (label === "html+main-script") return "mainScript";
  if (label === "boot") return "engineInit";
  if (label === "terrain") return "terrain";
  if (label.startsWith("build:poi:")) return "poiBuild";
  if (label.startsWith("build:")) return "worldBuild";
  if (label.startsWith("afterBuild")) return "afterBuild";
  if (label.startsWith("game:prewarm")) return "prewarm";
  if (label.startsWith("game")) return "gameKits";
  if (label === "settle") return "settle";
  return label.split(":")[0];
}

function toCase(L: Load, seed: number, matchSecs: number): CaseResult {
  const { boot, fin } = L, P = fin.probe, gates: Gate[] = [], metrics: Record<string, Metric> = {};
  const readyAt = typeof boot.kr.readyAt === "number" ? boot.kr.readyAt : undefined;
  gates.push({ id: "ready", pass: readyAt !== undefined, detail: readyAt !== undefined ? "title ready at " + readyAt + " ms" : L.failure ?? "stage " + boot.kr.stage });
  gates.push({ id: "noErrors", pass: fin.errors.length === 0, detail: fin.errors.length ? fin.errors[0].slice(0, 200) : "no __kr.errors" });
  const gpu = String(fin.gl?.renderer ?? "unknown");
  gates.push({ id: "hardwareGpu", pass: !/swiftshader|llvmpipe|basic render|software/i.test(gpu), detail: gpu });
  if (matchSecs > 0) gates.push({ id: "matchStarted", pass: P?.marks.inMatch !== undefined, detail: P?.marks.inMatch !== undefined ? "inMatch at " + Math.round(P.marks.inMatch) + " ms" : L.failure ?? "no match" });
  if (!P) return { scenario: { id: "load/" + L.start, version: SCENARIO_VERSION, seed, workload: "page-load" }, windows: {}, load: {}, metrics, gates: [...gates, { id: "probe", pass: false, detail: "the probe did not run (no __krProbe)" }], detail: { errors: fin.errors } };
  gates.push({ id: "visible", pass: P.hidden === 0, detail: P.hidden ? P.hidden + " probe ticks saw a hidden page: timers and frames were throttled" : "page visible throughout" });
  // a locked screen, a sleeping display or an occluded window stops frames and throttles timers in a headed browser
  // while document.visibilityState still says "visible": the probe's timer then stalls for many seconds at a time
  const maxGap = Math.max(0, ...P.gaps.map(([, d]) => d));
  gates.push({ id: "notThrottled", pass: maxGap < 15_000, detail: maxGap < 15_000 ? "longest main-thread gap " + maxGap + " ms" : "a " + Math.round(maxGap / 1000) + " s gap: the page was throttled (locked screen, sleeping display, occluded window) or hung; not a measurement until a run with the screen awake reproduces it" });
  const end = readyAt ?? fin.now;
  const label = labeller(P.set, P.marks);

  // ---- phases before ready: every interval between two stage writes, summed by phase
  const phases: Record<string, number> = { mainScript: P.marks.kr ?? end };
  const stamps = [...P.set].filter(([t, k]) => (k === "stage" || k === "gameStage") && t < end).map(([t]) => t).sort((a, b) => a - b);
  const cuts = [...new Set([P.marks.kr ?? 0, ...stamps.filter((t) => t >= (P.marks.kr ?? 0)), end])].sort((a, b) => a - b);
  for (let i = 0; i + 1 < cuts.length; i++) { const p = phaseOf(label(cuts[i])); phases[p] = (phases[p] ?? 0) + cuts[i + 1] - cuts[i]; }
  for (const p of ["mainScript", "engineInit", "terrain", "worldBuild", "poiBuild", "afterBuild", "gameKits", "prewarm", "settle"]) metrics["phase." + p + "Ms"] = ms(readyAt === undefined ? undefined : phases[p] ?? 0);
  metrics.readyMs = ms(readyAt);

  // ---- network: what the proxy forwarded for this load, aligned to the page clock through the document request
  const docHit = L.hits.find((h) => /^\/(\?|index\.html|$)/.test(h.url)) ?? L.hits[0];
  const off = docHit && fin.nav ? docHit.t0 - fin.nav.requestStart : 0;
  const pre = L.hits.filter((h) => h.t2 && h.t0 - off < end);
  const byClass: Record<string, { n: number; MB: number; lastByteMs: number }> = {};
  for (const h of pre) { const c = byClass[classify(h.url)] ??= { n: 0, MB: 0, lastByteMs: 0 }; c.n++; c.MB += h.bytes / 1e6; c.lastByteMs = Math.max(c.lastByteMs, h.t2 - off); }
  metrics["net.requests"] = num(pre.length, "count");
  metrics["net.MB"] = num(pre.reduce((a, h) => a + h.bytes, 0) / 1e6, "MB");
  metrics["net.lastByteMs"] = ms(pre.length ? Math.max(...pre.map((h) => h.t2 - off)) : 0);
  for (const [c] of CLASSES) { const v = byClass[c]; metrics["net." + c + ".MB"] = num(v?.MB ?? 0, "MB"); metrics["net." + c + ".lastByteMs"] = ms(v?.lastByteMs ?? 0); }
  const rtPre = fin.res.filter((r) => r[1] < end && !r[0].startsWith("data:") && !/^(blob:|https?:)/.test(r[0]));
  metrics["net.fromBrowserCache"] = num(Math.max(0, rtPre.length - pre.length), "count");

  const pointDetail: Record<string, unknown> = {};
  for (const p of SNAP_POINTS) {
    const s = L.points.find((x) => x.point === p);
    if (p !== "title" && !s && matchSecs * 1000 < MATCH_SNAP_MS) continue;
    const why = p === "title" ? "the title never became ready" : "not reached in this run";
    const ua = fin.mem?.[p];
    metrics["mem." + p + ".uaMB"] = !s ? notReached("MB", why) : typeof ua?.bytes === "number" ? num(ua.bytes / 1e6, "MB") : unsupported("MB", s.uaWhy ?? ua?.error ?? "the measurement had not resolved when the load ended");
    metrics["mem." + p + ".jsHeapMB"] = !s ? notReached("MB", why) : s.jsHeapMB !== null ? num(s.jsHeapMB, "MB") : unsupported("MB", "performance.memory is Chrome and Edge only");
    metrics["mem." + p + ".jsHeapGcMB"] = !s ? notReached("MB", why) : typeof s.jsHeapGcMB === "number" ? num(s.jsHeapGcMB, "MB") : unsupported("MB", "a forced GC needs a CDP session and performance.memory: Chrome and Edge only");
    for (const k of ["geometries", "textures", "programs"] as const) {
      const v = s?.info?.[k];
      metrics["three." + p + "." + k] = !s ? notReached("count", why) : typeof v === "number" ? num(v, "count") : unsupported("count", "window.__kr.engine.renderer.info is not exposed by this build");
    }
    const rt = s ? fin.res.filter((r) => r[2] <= s.at && !r[0].startsWith("data:") && !/^(blob:|https?:)/.test(r[0])) : [];
    const sized = rt.every((r) => r[3] >= 0);
    const byType: Record<string, { requests: number; MB: number }> = {};
    for (const r of rt) { const c = byType[classify(r[0])] ??= { requests: 0, MB: 0 }; c.requests++; c.MB += Math.max(0, r[3]) / 1e6; }
    const bytesMetric = (MB: number) => !s ? notReached("MB", why) : sized ? num(MB, "MB") : unsupported("MB", "Resource Timing transferSize is not exposed by this browser");
    metrics["assets." + p + ".requests"] = !s ? notReached("count", why) : num(rt.length, "count");
    metrics["assets." + p + ".MB"] = bytesMetric(rt.reduce((a, r) => a + Math.max(0, r[3]), 0) / 1e6);
    for (const [c] of CLASSES) {
      metrics["assets." + p + "." + c + ".requests"] = !s ? notReached("count", why) : num(byType[c]?.requests ?? 0, "count");
      metrics["assets." + p + "." + c + ".MB"] = bytesMetric(byType[c]?.MB ?? 0);
    }
    pointDetail[p] = s ? { atMs: Math.round(s.at), sinceMatchS: p !== "title" && P.marks.inMatch !== undefined ? +((s.at - P.marks.inMatch) / 1000).toFixed(1) : null, byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { requests: v.requests, MB: +v.MB.toFixed(2) }])) } : null;
  }

  // ---- main thread before ready: the probe's timer gaps (the same measure in every browser)
  const blocks = P.gaps.filter(([t, d]) => d >= LONG_MS && t < end);
  metrics["main.longTasks"] = num(blocks.length, "count");
  metrics["main.blockedMs"] = ms(blocks.reduce((a, [, d]) => a + d, 0));
  metrics["main.maxBlockMs"] = ms(Math.max(0, ...blocks.map(([, d]) => d)));
  const blockedBy: Record<string, number> = {};
  for (const [t, d] of blocks) { const l = phaseOf(label(t)); blockedBy[l] = (blockedBy[l] ?? 0) + d; }
  const gl = (w: string, ...b: string[]) => b.reduce((a, k) => a + (P.gl[w + "." + k]?.[1] ?? 0), 0);
  metrics["gl.shaderMs"] = ms(gl("boot", "shaderCompile", "shaderLink", "shaderStatus", "shaderFirstUse"));
  metrics["gl.textureMs"] = ms(gl("boot", "texture"));
  metrics["gl.bufferMs"] = ms(gl("boot", "buffer"));
  metrics["gl.readbackMs"] = ms(gl("boot", "readback"));
  metrics["gl.programs"] = num(Number(boot.kr.programsAtReady ?? 0), "count");

  // ---- Chrome trace (CDP): what the main thread did, by kind
  const why = "only the Chrome run records a CDP trace; in Safari use the Web Inspector Timelines recording (SKILL.md)";
  const tb = L.trace?.bootMs;
  for (const k of ["scripting", "parseCompile", "gc", "decode", "styleLayoutPaint", "gpuWait", "other"]) metrics["trace." + k + "Ms"] = tb ? ms(tb[k] ?? 0) : unsupported("ms", L.trace?.error ?? why);
  metrics["trace.jsSelfMs"] = L.trace?.js ? ms(L.trace.js.totalMs) : unsupported("ms", L.trace ? L.trace.error ?? "the trace has no CPU samples for the page's main thread" : why);
  metrics["trace.gpuMainBusyMs"] = L.trace?.gpuProcess ? ms(L.trace.gpuProcess.mainBusyMs) : unsupported("ms", L.trace?.error ?? why);
  metrics["trace.longTasks"] = L.trace?.longTasks ? num(L.trace.longTasks.n, "count") : unsupported("count", L.trace?.error ?? why);

  // ---- match start: click -> inMatch, then the first matchSecs of frames
  const click = P.marks.click, inMatch = P.marks.inMatch;
  if (matchSecs > 0) {
    metrics["match.startMs"] = ms(click !== undefined && inMatch !== undefined ? inMatch - click : undefined);
    metrics["match.prepareMs"] = ms(inMatch !== undefined ? Number(fin.kr.prepareMs ?? 0) : undefined);
    const w = inMatch !== undefined ? [inMatch, inMatch + matchSecs * 1000] : null;
    const gcs = L.points.flatMap((x) => (x.gc ? [x.gc] : []));
    const inGc = (a: number, b: number) => gcs.some(([s, e]) => a < e && b > s);
    const fr = w ? P.frames.filter((t) => t >= w[0] && t <= w[1]) : [];
    const dts = fr.slice(1).flatMap((t, i) => (inGc(fr[i], t) ? [] : [t - fr[i]])).sort((a, b) => a - b);
    metrics["match.frames"] = num(dts.length, "count");
    metrics["match.framesOver100"] = num(dts.filter((d) => d > 100).length, "count");
    metrics["match.p99FrameMs"] = ms(dts.length ? dts[Math.min(dts.length - 1, Math.ceil(dts.length * 0.99) - 1)] : undefined);
    metrics["match.maxFrameMs"] = ms(dts.length ? dts[dts.length - 1] : undefined);
    metrics["match.blockedMs"] = ms(w ? P.gaps.filter(([t, d]) => d >= LONG_MS && t >= w[0] && t < w[1] && !inGc(t, t + d)).reduce((a, [, d]) => a + d, 0) : undefined);
    metrics["match.shaderMs"] = ms(gl("match", "shaderCompile", "shaderLink", "shaderStatus", "shaderFirstUse"));
  }
  metrics.streamedMs = ms(typeof fin.kr.streamedAt === "number" ? fin.kr.streamedAt : undefined);

  const topBlocks = [...blocks].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t, d]) => ({ atMs: t, ms: d, step: label(t) }));
  const glSlow = [...P.glSlow].sort((a, b) => b[2] - a[2]).slice(0, 20).map(([t, n, d]) => ({ atMs: t, call: n, ms: d, step: label(t) }));
  const glBuckets = Object.fromEntries(Object.entries(P.gl).map(([k, [n, sum, max]]) => [k, { n, ms: Math.round(sum), maxMs: Math.round(max) }]));
  const biggest = [...pre].sort((a, b) => b.bytes - a.bytes).slice(0, 15).map((h) => ({ url: h.url.slice(0, 120), MB: +(h.bytes / 1e6).toFixed(2), ms: Math.round(h.t2 - h.t0), endMs: Math.round(h.t2 - off), enc: h.enc }));
  return {
    scenario: { id: "load/" + L.start, version: SCENARIO_VERSION, seed, workload: "page-load" },
    windows: { boot: "navigation start -> __kr.ready", match: matchSecs > 0 ? "click Play -> inMatch, then " + matchSecs + " s of frames" : "not driven" },
    load: { requests: pre.length, resourceEntries: rtPre.length },
    metrics, gates,
    detail: {
      points: pointDetail,
      gl: fin.gl, frames: { beforeReady: P.frames.filter((t) => t < end).length, total: P.frames.length }, dpr: fin.dpr, viewport: fin.inner, ua: fin.ua, entryTypes: P.entryTypes, phases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, Math.round(v)])), blockedByPhase: Object.fromEntries(Object.entries(blockedBy).map(([k, v]) => [k, Math.round(v)])),
      topBlocks, glSlow, glBuckets, httpStatus: pre.reduce((a, h) => ({ ...a, [h.status]: (a[h.status] ?? 0) + 1 }), {} as Record<number, number>), netByClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, { n: v.n, MB: +v.MB.toFixed(2), lastByteMs: Math.round(v.lastByteMs) }])), biggest,
      nav: fin.nav, stageTimeline: P.set, nativeLongTasks: P.longtasks.slice(0, 200), loaf: [...P.loaf as Array<[number, number]>].sort((a, b) => b[1] - a[1]).slice(0, 30), kr: boot.kr, krAtEnd: { streamedAt: fin.kr.streamedAt, prepareMs: fin.kr.prepareMs, streamMs: fin.kr.streamMs }, splat: fin.splat, trace: L.trace, errors: fin.errors, failure: L.failure,
    },
  };
}

// ---------------------------------------------------------------- run
async function run() {
  const urls = all("--url").map((u, i) => { const m = /^([\w.-]+)=(.+)$/.exec(u); return { label: m ? m[1] : all("--url").length > 1 ? "u" + (i + 1) : "run", url: new URL(m ? m[2] : u) }; });
  if (!urls.length) fail("pass --url http://127.0.0.1:PORT (a server you started: kr-verify up --prod, npm start, npm run dev)");
  for (const { url } of urls) if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) fail(url.hostname + " is not local: this tool only measures servers you run on this machine (AGENTS.md rule 7)");
  const browsers = opt("--browsers", "chrome").split(",") as Browser[];
  for (const b of browsers) if (!BROWSERS.includes(b)) fail("unknown browser " + b + " (chrome, edge, safari, webkit)");
  const runs = Number(opt("--runs", "3")), matchSecs = flag("--no-match") ? 0 : Number(opt("--match-secs", "15")), seed = Number(opt("--seed", "42"));
  const starts = opt("--starts", "cold,warm").split(",") as Start[];
  for (const s of starts) if (s !== "cold" && s !== "warm") fail("unknown start " + s + " (cold, warm)");
  // a profile is cold only on its first load: a cold start anywhere but first would measure a warm profile
  if (starts.indexOf("cold") > 0 || starts.filter((s) => s === "cold").length > 1) fail("--starts: cold can only come first (cold, cold,warm, warm or warm,warm)");
  const [vw, vh] = opt("--viewport", "1600x900").split("x").map(Number);
  const netOpt = opt("--net", ""), shape = netOpt ? { mbps: Number(netOpt.split(",")[0]), rttMs: Number(netOpt.split(",")[1] ?? 0) } : null;
  const o: Opts = { viewport: [vw, vh], dpr: Number(opt("--dpr", "2")), headed: flag("--headed"), trace: !flag("--no-trace"), inspect: flag("--inspect"), sdPort: Number(opt("--safaridriver-port", "4471")) };
  const cooldown = Number(opt("--cooldown", "10"));
  if (browsers.includes("safari") && screenLocked()) fail(LOCKED);
  const outRoot = path.resolve(opt("--out", path.join("shots", "load-profile", new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-"))));
  const root = path.resolve(opt("--root", process.cwd()));
  fs.mkdirSync(outRoot, { recursive: true });
  const order: string[] = [];
  let failed = 0;
  // ABBA order across rounds: the order inside a round flips every round, so warm-up drift does not favour one side
  for (let r = 1; r <= runs; r++) {
    const round = urls.flatMap((u) => browsers.map((b) => ({ ...u, browser: b })));
    if (r % 2 === 0) round.reverse();
    for (const { label, url, browser } of round) {
      const id = label + "-" + browser + "-r" + r, out = path.join(outRoot, id);
      fs.mkdirSync(out, { recursive: true });
      const startedAt = new Date().toISOString(), t0 = Date.now();
      const proxy = await startProxy(new URL(url.origin), shape, PROBE.replace("@GL", String(!flag("--no-gl"))));
      const pageUrl = new URL(url.pathname + url.search, "http://127.0.0.1:" + proxy.port);
      if (!pageUrl.searchParams.has("seed")) pageUrl.searchParams.set("seed", String(seed));
      const loads: Load[] = [], errors: string[] = [];
      let d: Driver | null = null;
      // a headed Safari window stops rendering when the display sleeps: keep it awake for the run (macOS)
      const awake = browser === "safari" && process.platform === "darwin" ? spawn("caffeinate", ["-d", "-i"], { stdio: "ignore" }) : null;
      try {
        if (browser === "safari" && screenLocked()) throw new Error(LOCKED);
        d = await launch(browser, o);
        // a warm-only run first fills the fresh profile's caches with one untimed load to the title
        if (starts[0] === "warm") { await d.open(pageUrl.href); await poll(d, (x) => x.ready || x.stage === "failed", READY_TIMEOUT_MS); }
        for (const s of starts) loads.push(await loadOnce(d, s, pageUrl.href, out, proxy, matchSecs));
      } catch (e) { errors.push(String((e as Error).stack ?? e).slice(0, 1200)); }
      finally { await d?.close().catch(() => {}); proxy.close(); awake?.kill(); }
      const cases = loads.map((L) => { const c = toCase(L, seed, matchSecs); (c.detail as Record<string, unknown>).label = label; (c.detail as Record<string, unknown>).url = url.href; return c; });
      const e = env();
      const result: RunResult = {
        schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: "load-profile", startedAt, durationMs: Date.now() - t0, source: source(root),
        environment: { platform: e.platform, arch: e.arch, release: e.release, node: e.node, cpu: e.cpu, cpus: e.cpus, memoryMB: e.memoryMB, loadAvg1: e.loadAvg1, gpu: (cases[0]?.detail as any)?.gl?.renderer ?? null },
        config: { browser, browserVersion: d?.version ?? "?", headless: d?.headless ?? !o.headed, viewport: o.viewport.join("x"), dpr: o.dpr, trace: (browser === "chrome" || browser === "edge") && o.trace, inspect: browser === "safari" && o.inspect, starts: starts.join(","), matchSecs, net: netOpt || "loopback", glProbe: !flag("--no-gl"),
          build: loads.some((L) => L.hits.some((h) => h.url.startsWith("/@vite/") || h.url.startsWith("/client/src/"))) ? "dev" : "prod" },
        cases, errors, artifacts: loads.flatMap((L) => L.artifacts),
      };
      save(path.join(out, "result.json"), result);
      const ok = !errors.length && cases.length === starts.length && cases.every((c) => c.gates.every((g) => g.pass));
      if (!ok) failed++;
      order.push(id);
      const line: Record<string, unknown> = { run: id, ok };
      for (const c of cases) line[c.scenario.id] = { readyMs: (c.metrics.readyMs as any)?.value, matchStartMs: (c.metrics["match.startMs"] as any)?.value, failed: c.gates.filter((g) => !g.pass).map((g) => g.id + ": " + g.detail.slice(0, 120)) };
      if (errors.length) line.error = errors[0].split("\n")[0];
      console.log(JSON.stringify(line));
      if (cooldown > 0) await sleep(cooldown * 1000);
    }
  }
  save(path.join(outRoot, "index.json"), { order, urls: urls.map((u) => ({ label: u.label, url: u.url.href })), browsers, runs });
  console.log(JSON.stringify({ ok: failed === 0, out: outRoot, next: "npx tsx tools/performance/load-profile.mts table " + path.relative(process.cwd(), outRoot) + "/*/result.json" }));
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- table: medians per label x browser
const HEADLINE = ["readyMs", "phase.mainScriptMs", "phase.engineInitMs", "phase.terrainMs", "phase.worldBuildMs", "phase.poiBuildMs", "phase.afterBuildMs", "phase.gameKitsMs", "phase.prewarmMs", "phase.settleMs",
  "net.MB", "net.requests", "net.fromBrowserCache", "net.lastByteMs", "main.blockedMs", "main.longTasks", "main.maxBlockMs", "gl.shaderMs", "gl.textureMs", "gl.readbackMs", "gl.programs",
  "trace.scriptingMs", "trace.parseCompileMs", "trace.gcMs", "trace.decodeMs", "trace.gpuWaitMs", "trace.gpuMainBusyMs", "match.startMs", "match.prepareMs", "match.framesOver100", "match.p99FrameMs", "match.maxFrameMs", "streamedMs"];
function table() {
  const files = argv.slice(1).filter((a) => !a.startsWith("--") && !all("--metrics").includes(a));
  if (!files.length) fail("pass result.json files");
  const runs = files.map((f) => parseResult(JSON.parse(fs.readFileSync(f, "utf8")), f));
  const want = all("--metrics").flatMap((m) => m.split(",")), metrics = want.length ? want : HEADLINE;
  const group = (r: RunResult) => String((r.cases[0]?.detail as any)?.label ?? "run") + " · " + r.config.browser;
  const groups = [...new Set(runs.map(group))];
  const med = (v: number[]) => { const a = [...v].sort((x, y) => x - y), n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; };
  const fmt = (v: number[]) => !v.length ? "—" : v.length === 1 ? String(v[0]) : med(v) + " [" + Math.min(...v) + "–" + Math.max(...v) + "]";
  for (const id of [...new Set(runs.flatMap((r) => r.cases.map((c) => c.scenario.id)))]) {
    console.log("\n### " + id + " (median [min–max] over runs; n per group: " + groups.map((g) => g + " " + runs.filter((r) => group(r) === g && r.cases.some((c) => c.scenario.id === id && c.gates.every((x) => x.pass))).length).join(", ") + ")\n");
    console.log("| metric | " + groups.join(" | ") + " |\n|---|" + groups.map(() => "---|").join(""));
    // a case with a failed gate is not a measurement: it is left out of every median and listed below the table
    const valid = (c: CaseResult) => c.gates.every((g) => g.pass);
    const vals = (g: string, f: (c: CaseResult) => number | undefined) => runs.filter((r) => group(r) === g).flatMap((r) => r.cases.filter((c) => c.scenario.id === id && valid(c))).map(f).filter((v): v is number => typeof v === "number");
    for (const m of metrics) {
      const cells = groups.map((g) => fmt(vals(g, (c) => { const x = c.metrics[m]; return x && x.status === "ok" && "value" in x ? x.value : undefined; })));
      if (cells.every((c) => c === "—")) continue;
      console.log("| " + m + " | " + cells.join(" | ") + " |");
    }
    const phases = [...new Set(runs.flatMap((r) => r.cases.filter((c) => c.scenario.id === id).flatMap((c) => Object.keys((c.detail as any)?.blockedByPhase ?? {}))))];
    for (const p of phases) console.log("| blocked in " + p + " (ms) | " + groups.map((g) => fmt(vals(g, (c) => (c.detail as any)?.blockedByPhase?.[p] ?? 0))).join(" | ") + " |");
    runs.forEach((r, i) => { for (const c of r.cases) if (c.scenario.id === id && !valid(c)) console.log("\nleft out: " + files[i] + " (" + group(r) + "): " + c.gates.filter((g) => !g.pass).map((g) => g.id + ": " + g.detail).join("; ")); });
  }
  return 0;
}

function fail(msg: string): never { console.error("load-profile: " + msg); process.exit(2); }
const code = cmd === "run" ? await run() : cmd === "table" ? table()
  : (console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith("//"))).join("\n")), cmd === "help" ? 0 : 2);
process.exit(code);
