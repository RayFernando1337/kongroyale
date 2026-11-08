// Per-preset GPU work census at fixed poses (RAY-288): what each video preset (Auto, Low, Medium, High, Epic) actually
// submits per frame where a player stands, split by pass (the main scene, each shadow-map render, every auxiliary
// render: post-chain quads, water / cloud / storm bakes) and by world module, with the pixels each pass writes. It
// answers "what does Low fail to cut" in counts; on SwiftShader it says nothing about timing, so a timing claim needs
// gpu-match.mts on real hardware. One fresh Chromium per preset (the world-module build tier is chosen at boot from
// the saved preset, engine/display.ts bootQuality), a seeded practice match, then each pose in turn: the plane (phase 1,
// once the plane is over the island centre), then the ground poses (phase 2, the player teleported on the
// in-page host, as pose-hold.mts does). The browser only loads the production server this script starts on 127.0.0.1
// (AGENTS.md rule 7).
//
//   npx tsx tools/performance/preset-census.mts run --software --out reports/census/base
//   npx tsx tools/performance/preset-census.mts run --software --presets epic --live low --out reports/census/epic-to-low
//   npx tsx tools/performance/preset-census.mts table reports/census/base/*.json
//
// run options: --presets auto,low,medium,high,epic; --poses plane,plantation,temple (names from POSES below, or
// name=x,z,yawDeg,pitchDeg); --viewport 1528x732 --dpr 1.25 (CSS px and device pixel ratio: TAREXEN's Radeon 740M
// laptop, report #7); --gpu "<renderer string>" (the ?gpu= spoof Auto classifies; default the 740M's); --live <preset>
// (boot with each --presets entry, then switch to this preset the menu's way, display.set, before the match: the
// in-session switch report #7 made); --frames 8 (measured frames per pose; even, so a half-rate shadow refresh counts
// fairly); --settle-s 25 --settle-frames 30 (after a teleport: these seconds, then these frames, before measuring; a
// jump of the camera makes the water's obstacle bake, water/obstacles.ts, re-check every frame for 12 frames); --plane-r 450 (the
// plane pose is measured once the plane is within this many metres of the island centre); --stream-timeout-s 1200
// (the practice starts once the island has streamed in, __kr.streamed, as for a player who has been on the title a while);
// --software (SwiftShader); --angle vulkan|metal|d3d11 (a hardware GPU instead); --query "a=1" (extra URL flags);
// --root <checkout> (serve its dist/, build first); --port 3033; --seed 42; --ready-timeout-s 600.
// Writes <out>/<preset>[-to-<live>].json (a kong-perf-result, one case per pose) and <out>/<name>-<pose>.png.
//
// What a frame counts. renderer.info is not reset between the frame's render() calls (the post chain makes many), so
// calls / triangles / points are the whole frame's; renderer.render, renderer.shadowMap.render and
// renderer.renderBufferDirect are wrapped, and each draw's counts go to the innermost pass open when it ran (a shadow
// map rendered inside the scene's render is its own pass) and to its world module (the scene child it sits under).
// "scene" is the main view; "scene:override:cam" and "scene:cam" are the same scene through another camera (the water's
// obstacle bake, probes), counted apart in otherScene*.
// A pass's Mpx is the size of the target it writes times its calls (a fill proxy: overdraw and blending not counted).
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { arg, env, save, source } from "./common.mts";
import { RESULT_SCHEMA, RESULT_VERSION, type CaseResult, type Metric, type RunResult } from "./schema.ts";

const SCENARIO_VERSION = 1;
const POSES: Record<string, [number, number, number, number] | "plane"> = {
  plane: "plane",
  // report #6 (TAREXEN, Epic, 2026-11-08 07:04): looking east over the plantation from the ridge
  plantation: [-39.98, 109.13, -91.46, 20.17],
  // report #7 (TAREXEN, Low, 2026-11-08 07:19): inside Banana Temple, 3.61 M triangles
  temple: [-5.75, -236.08, 154.54, -16.05],
};
const PRESETS: Record<string, Record<string, unknown>> = {
  low: { aa: "fxaa", shadows: "low", ao: false, post: "low", viewDist: "low", foliage: "low", effects: "low" },
  medium: { aa: "taa", shadows: "medium", ao: true, post: "medium", viewDist: "medium", foliage: "medium", effects: "medium" },
  high: { aa: "taa", shadows: "high", ao: true, post: "high", viewDist: "high", foliage: "high", effects: "high" },
  epic: { aa: "taa", shadows: "epic", ao: true, post: "epic", viewDist: "epic", foliage: "epic", effects: "epic" },
};
const GPU_740M = "ANGLE (AMD, AMD Radeon 740M Graphics (0x00001901) Direct3D11 vs_5_0 ps_5_0, D3D11)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- page scripts
const STATUS = `(() => { const k = window.__kr; if (!k) return { ready: false, stage: "" }; const g = k.game, cm = g && g.cm;
  return { ready: !!k.ready, stage: String(k.stage || ""), inMatch: !!(g && g.inMatch), phase: cm ? cm.phase : -1, st: cm && cm.pred ? cm.pred.st : -1,
    x: cm && cm.pred ? cm.pred.x : 0, z: cm && cm.pred ? cm.pred.z : 0, frames: k.censusC ? k.censusC.frame : 0, streamed: !!k.streamed }; })()`;
const INSTALL = `(() => {
  const k = window.__kr, e = k.engine, r = e.renderer, info = r.info, gl = r.getContext();
  const c = { on: false, frames: 0, frame: 0, passes: {}, mods: {}, objs: new Map(), stack: [], tot: { calls: 0, tris: 0, points: 0 } };
  k.censusC = c;
  const modOf = (o) => { let p = o; while (p.parent && p.parent !== e.scene) p = p.parent; return p.parent === e.scene ? (p.name || p.type) : "(" + (p.name || p.type) + ")"; };
  const px = () => { const t = r.getRenderTarget(); return t ? t.width * t.height : gl.drawingBufferWidth * gl.drawingBufferHeight; };
  const pass = (key) => c.passes[key] || (c.passes[key] = { n: 0, calls: 0, tris: 0, points: 0, mpx: 0 });
  const render = r.render.bind(r);
  r.render = function (scene, camera) {
    if (!c.on) return render(scene, camera);
    const ch = scene.children[0], mat = ch && ch.material;
    const key = scene === e.scene ? "scene" + (scene.overrideMaterial ? ":override" : "") + (camera === e.camera ? "" : ":cam")
      : "aux:" + (scene.name || (ch && ch.name) || (mat && (mat.name || mat.type)) || scene.type);
    const p = pass(key); p.n++; p.mpx += px() / 1e6;
    c.stack.push(key);
    try { return render(scene, camera); } finally { c.stack.pop(); }
  };
  const sm = r.shadowMap, smRender = sm.render.bind(sm);
  sm.render = function (lights, scene, camera) {
    if (!c.on || !sm.enabled || (sm.autoUpdate === false && sm.needsUpdate === false)) return smRender(lights, scene, camera);
    const names = [];
    for (const l of lights) if (l.castShadow && l.shadow && (l.shadow.autoUpdate !== false || l.shadow.needsUpdate)) names.push((l.name || l.type) + " " + l.shadow.mapSize.x + "x" + l.shadow.mapSize.y);
    if (!names.length) return smRender(lights, scene, camera);
    const key = "shadow:" + names.join("+");
    pass(key).n += names.length;
    c.stack.push(key);
    try { return smRender(lights, scene, camera); } finally { c.stack.pop(); }
  };
  const rbd = r.renderBufferDirect.bind(r);
  r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (!c.on) return rbd(camera, scene, geometry, material, object, group);
    const a0 = info.render.calls, a1 = info.render.triangles, a2 = info.render.points;
    try { return rbd(camera, scene, geometry, material, object, group); } finally {
      const key = c.stack[c.stack.length - 1] || "(none)", p = pass(key);
      const dc = info.render.calls - a0, dt = info.render.triangles - a1, dp = info.render.points - a2;
      p.calls += dc; p.tris += dt; p.points += dp;
      if (!key.startsWith("aux")) { const mk = key.replace(/^shadow:.*/, "shadow") + " | " + modOf(object), m = c.mods[mk] || (c.mods[mk] = { calls: 0, tris: 0, points: 0 }); m.calls += dc; m.tris += dt; m.points += dp;
        let ob = c.objs.get(object); if (!ob) c.objs.set(object, (ob = { key: mk + " / " + (object.name || object.type) + (object.isInstancedMesh ? " [inst " + object.count + "]" : ""), calls: 0, tris: 0, points: 0 })); ob.calls += dc; ob.tris += dt; ob.points += dp; }
    }
  };
  const step = e.step;
  e.step = function (dt) {
    c.frame++;
    if (!c.on) return step.call(this, dt);
    const ar = info.autoReset; info.autoReset = false; info.reset();
    try { return step.call(this, dt); } finally {
      c.tot.calls += info.render.calls; c.tot.tris += info.render.triangles; c.tot.points += info.render.points;
      info.autoReset = ar; c.frames++;
    }
  };
  return "ok";
})()`;
const ARM = "(() => { const c = window.__kr.censusC; c.on = true; c.frames = 0; c.passes = {}; c.mods = {}; c.objs = new Map(); c.tot = { calls: 0, tris: 0, points: 0 }; return 'ok'; })()";
const DISARM = "(() => { window.__kr.censusC.on = false; return 'ok'; })()";
const READ = `(() => {
  const k = window.__kr, c = k.censusC, e = k.engine, r = e.renderer, n = Math.max(1, c.frames), d = k.display;
  const per = (o) => Object.fromEntries(Object.entries(o).map(([kk, v]) => [kk, Object.fromEntries(Object.entries(v).map(([f, x]) => [f, +(x / n).toFixed(f === "mpx" ? 3 : 1)]))]));
  const cam = e.camera, g = k.game, cm = g && g.cm;
  return { frames: c.frames, calls: c.tot.calls / n, tris: c.tot.tris / n, points: c.tot.points / n,
    passes: per(c.passes), mods: per(c.mods),
    objects: [...c.objs.values()].sort((a, b) => b.tris - a.tris).slice(0, 60).map((o) => ({ key: o.key, calls: +(o.calls / n).toFixed(1), tris: Math.round(o.tris / n), points: Math.round(o.points / n) })),
    programs: (r.info.programs || []).length, textures: r.info.memory.textures, geometries: r.info.memory.geometries,
    renderScale: e.renderScale, dynamicRes: e.dynamicRes, canvas: [r.domElement.width, r.domElement.height], dprBase: e.dprBase, quality: e.quality,
    video: d ? d.settings : null, gpuLevel: d ? d.gpuLevel : null, veg: d ? d.vegState : null, cull: e.cull && e.cull.info ? e.cull.info() : null,
    cam: [cam.position.x, cam.position.y, cam.position.z].map((v) => +v.toFixed(1)), phase: cm ? cm.phase : -1, st: cm && cm.pred ? cm.pred.st : -1,
    errors: (k.errors || []).slice(0, 10).map(String) };
})()`;
const PLACE = (x: number, z: number, yaw: number, pitch: number) => `(() => {
  const g = window.__kr.game, l = g.link; if (!l || !l.hostTool || !g.cm) return "no host";
  l.hostTool({ op: "place", pid: g.cm.me, x: ${x}, z: ${z}, yaw: ${yaw} });
  g.input.yaw = ${yaw}; g.input.pitch = ${pitch};
  return "ok";
})()`;
const KEEP = (yaw: number, pitch: number) => "(() => { const g = window.__kr.game, l = g.link; if (!l || !l.hostTool || !g.cm) return 'no host'; if (g.cm.pred.hp < 90) l.hostTool({ op: 'heal', pid: g.cm.me, hp: 90 }); g.input.yaw = " + yaw + "; g.input.pitch = " + pitch + "; return 'ok'; })()";

async function run() {
  const root = path.resolve(arg("--root", "."));
  const outDir = path.resolve(arg("--out", "reports/census"));
  const PORT = Number(arg("--port", "3033"));
  const [VW, VH] = arg("--viewport", "1528x732").split("x").map(Number);
  const DPR = Number(arg("--dpr", "1.25"));
  const presets = arg("--presets", "auto,low,medium,high,epic").split(",");
  const LIVE = arg("--live", "");
  const poses = arg("--poses", "plane,plantation,temple").split(",").map((p) => {
    const [name, spec] = p.split("=");
    if (spec) { const v = spec.split(",").map(Number); if (v.length !== 4 || !v.every(Number.isFinite)) throw Error("--poses " + p + ": name=x,z,yawDeg,pitchDeg"); return { name, at: v as [number, number, number, number] }; }
    if (!POSES[name]) throw Error("--poses " + name + ": one of " + Object.keys(POSES).join(", ") + ", or name=x,z,yawDeg,pitchDeg");
    return { name, at: POSES[name] };
  });
  const FRAMES = Number(arg("--frames", "8")), SETTLE_S = Number(arg("--settle-s", "25")), PLANE_R = Number(arg("--plane-r", "450")), STREAM_S = Number(arg("--stream-timeout-s", "1200")), SETTLE_FRAMES = Number(arg("--settle-frames", "30"));
  const SOFTWARE = process.argv.includes("--software");
  const ANGLE = arg("--angle", SOFTWARE ? "swiftshader" : process.platform === "darwin" ? "metal" : process.platform === "win32" ? "d3d11" : "vulkan");
  const GPU = arg("--gpu", GPU_740M), EXTRA = arg("--query", ""), SEED = Number(arg("--seed", "42")), READY_S = Number(arg("--ready-timeout-s", "600"));
  for (const p of [...presets, ...(LIVE ? [LIVE] : [])]) if (p !== "auto" && !PRESETS[p]) throw Error("preset " + p + ": one of auto, " + Object.keys(PRESETS).join(", "));
  const ORIGIN = "http://127.0.0.1:" + PORT;
  const up = async () => { try { return (await fetch(ORIGIN + "/", { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
  if (await up()) throw Error("something already answers on " + ORIGIN + "; pick another --port");
  const server: ChildProcess = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: root, env: { ...process.env, KR_SERVE: "1", KR_PORT: String(PORT), KR_HOST: "127.0.0.1", KR_PLAYTEST_BUNDLES: "0" }, stdio: "ignore", windowsHide: true });
  process.on("exit", () => { if (server.exitCode === null) server.kill(); });
  for (let i = 0; !(await up()); i++) { if (server.exitCode !== null || i > 120) throw Error("the server did not come up"); await sleep(500); }
  const pw = await import("playwright");
  let failed = false;
  try {
    for (const preset of presets) {
      const name = preset + (LIVE ? "-to-" + LIVE : "");
      const t0 = Date.now(), log = (s: string) => console.log("[census " + name + " " + ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + " s] " + s);
      const video = preset === "auto" ? null : { v: 2, preset, auto: preset, res3d: 1, dynres: false, fpsCap: -1, fov: 72, showFps: false, ...PRESETS[preset] };
      const query = "seed=" + SEED + "&gpu=" + encodeURIComponent(GPU) + (EXTRA ? "&" + EXTRA : "");
      const b = await pw.chromium.launch({ headless: true, args: ["--use-angle=" + ANGLE, "--enable-gpu", "--ignore-gpu-blocklist", ...(SOFTWARE ? ["--enable-unsafe-swiftshader"] : []), "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
      const errors: string[] = [], cases: CaseResult[] = [], artifacts: string[] = [];
      let first: any = null;
      const marks: Record<string, number> = {};
      try {
        const ctx = await b.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR });
        const page = await ctx.newPage();
        const ev = <T,>(x: string) => page.evaluate(x) as Promise<T>;
        await page.goto(ORIGIN + "/__census-blank");
        await ev("(() => { localStorage.clear(); " + (video ? "localStorage.setItem('kr-video', " + JSON.stringify(JSON.stringify(video)) + "); localStorage.setItem('kr-fov-moved', '1'); " : "") + "return 'ok'; })()");
        await page.goto(ORIGIN + "/?" + query, { waitUntil: "commit", timeout: 120_000 });
        const status = () => ev<any>(STATUS);
        for (let s = await status(); !s.ready; s = await status()) { if (s.stage === "failed") throw Error("boot failed"); if (Date.now() - t0 > READY_S * 1000) throw Error("not ready after " + READY_S + " s (" + s.stage + ")"); await sleep(1000); }
        log("ready");
        for (let s = await status(); !s.streamed; s = await status()) { if (Date.now() - t0 > (READY_S + STREAM_S) * 1000) { errors.push("the island had not streamed in after " + STREAM_S + " s"); break; } await sleep(2000); }
        marks.streamedS = Math.round((Date.now() - t0) / 1000); log("streamed");
        await ev(INSTALL);
        if (LIVE) { await ev("(() => { window.__kr.display.set({ preset: " + JSON.stringify(LIVE) + " }); return 'ok'; })()"); log("switched to " + LIVE + " the menu's way"); }
        await ev("(() => { window.__kr.game.practice('solo'); return 'ok'; })()");
        const play0 = Date.now();
        const frames = async (n: number, keep?: () => Promise<unknown>) => { const f0 = (await status()).frames; for (let s = await status(); s.frames - f0 < n; s = await status()) { if (keep) await keep(); await sleep(500); } };
        const measure = async (pose: string, keep?: () => Promise<unknown>) => {
          await ev(ARM); await frames(FRAMES, keep); await ev(DISARM);
          const r = await ev<any>(READ);
          const shot = path.join(outDir, name + "-" + pose + ".png");
          fs.mkdirSync(outDir, { recursive: true });
          await page.screenshot({ path: shot }).then(() => artifacts.push(shot), () => { /* best effort */ });
          first ??= r;
          const v = (value: number, unit = "count"): Metric => ({ status: "ok", unit, better: "lower", value });
          const sum = (f: (k: string) => boolean, field: "n" | "calls" | "tris" | "points" | "mpx") => Object.entries(r.passes as Record<string, Record<string, number>>).filter(([k]) => f(k)).reduce((a, [, p]) => a + p[field], 0);
          const shadow = (k: string) => k.startsWith("shadow"), scene = (k: string) => k === "scene", other = (k: string) => k.startsWith("scene:"), aux = (k: string) => k.startsWith("aux");
          cases.push({
            scenario: { id: "census/" + pose, version: SCENARIO_VERSION, seed: SEED, workload: "real-play" },
            windows: { frames: r.frames, definition: pose === "plane" ? "riding the plane within " + PLANE_R + " m of the island centre" : "standing still at the pose, " + SETTLE_S + " s after the teleport" },
            load: { frames: r.frames },
            metrics: {
              drawCalls: v(r.calls), triangles: v(r.tris), points: v(r.points), programs: v(r.programs), textures: v(r.textures), geometries: v(r.geometries),
              shadowPasses: v(sum(shadow, "n")), shadowCalls: v(sum(shadow, "calls")), shadowTriangles: v(sum(shadow, "tris")),
              sceneCalls: v(sum(scene, "calls")), sceneTriangles: v(sum(scene, "tris")), scenePoints: v(sum(scene, "points")), sceneMpx: v(sum(scene, "mpx"), "Mpx"),
              otherScenePasses: v(sum(other, "n")), otherSceneCalls: v(sum(other, "calls")), otherSceneTriangles: v(sum(other, "tris")),
              auxPasses: v(sum(aux, "n")), auxCalls: v(sum(aux, "calls")), auxMpx: v(sum(aux, "mpx"), "Mpx"),
              renderScale: { status: "ok", unit: "x", better: "lower", value: r.renderScale },
            },
            gates: [
              { id: "frames", pass: r.frames >= FRAMES, detail: String(r.frames) },
              { id: "noErrors", pass: !r.errors.length, detail: r.errors.slice(0, 3).join(" | ") || "none" },
              { id: "phase", pass: pose === "plane" ? r.phase === 1 : r.phase === 2, detail: "phase " + r.phase + ", st " + r.st },
            ],
            detail: { cam: r.cam, passes: r.passes, mods: r.mods, objects: r.objects, video: r.video, veg: r.veg, cull: r.cull, quality: r.quality, canvas: r.canvas, dynamicRes: r.dynamicRes },
          } as CaseResult);
          log(pose + ": " + Math.round(r.calls) + " calls, " + (r.tris / 1e6).toFixed(2) + " M tris, " + (r.points / 1e6).toFixed(2) + " M points, " + r.programs + " programs, " + r.textures + " textures, scale " + r.renderScale + " at " + r.cam.join(","));
        };
        for (const p of poses) {
          if (p.at === "plane") {
            for (let s = await status(); !(s.inMatch && s.phase >= 1); s = await status()) { if (Date.now() - play0 > 900_000) throw Error("no plane phase 900 s after the practice started"); await sleep(500); }
            if ((await status()).phase !== 1) { errors.push("plane: the match was past phase 1"); continue; }
            for (let s = await status(); Math.hypot(s.x, s.z) > PLANE_R; s = await status()) { if (s.phase !== 1) throw Error("the plane never came within " + PLANE_R + " m of the centre"); await sleep(250); }
            await measure(p.name);
            continue;
          }
          const [x, z, yd, pd] = p.at, yaw = (yd * Math.PI) / 180, pitch = (pd * Math.PI) / 180;
          for (let s = await status(); !(s.inMatch && s.phase >= 2); s = await status()) { if (Date.now() - play0 > 1_800_000) throw Error("no play phase 1800 s after the practice started"); await sleep(500); }
          await ev(PLACE(x, z, yaw, pitch));
          const set0 = Date.now(); while (Date.now() - set0 < SETTLE_S * 1000) { await ev(KEEP(yaw, pitch)); await sleep(500); }
          await frames(SETTLE_FRAMES, () => ev(KEEP(yaw, pitch)));
          await measure(p.name, () => ev(KEEP(yaw, pitch)));
        }
      } catch (e) {
        errors.push("harness: " + (e instanceof Error ? e.message.split("\n")[0] : String(e)));
      } finally { await b.close().catch(() => { /* gone */ }); }
      const result: RunResult = {
        schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: "tools/performance/preset-census.mts", startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0,
        source: source(root), environment: { ...env(), gpu: SOFTWARE ? "swiftshader" : ANGLE },
        config: { browser: "chromium " + b.version(), viewport: VW + "x" + VH, dpr: DPR, preset, live: LIVE || "none", gpuSpoof: GPU, query, frames: FRAMES, settleS: SETTLE_S, planeR: PLANE_R, streamedAtS: marks.streamedS ?? null, software: SOFTWARE, quality: first?.quality ?? null, video: first?.video ?? null },
        cases, errors, artifacts,
      };
      save(path.join(outDir, name + ".json"), result);
      log("wrote " + path.join(outDir, name + ".json") + (errors.length ? " with errors: " + errors.join("; ") : ""));
      failed ||= !!errors.length || cases.some((c) => c.gates.some((g) => !g.pass));
    }
  } finally { server.kill(); }
  process.exit(failed ? 1 : 0);
}

// ---- table: one row per preset per pose, then the modules over 30 k triangles in any preset
function table(files: string[]) {
  const runs = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as RunResult & { cases: Array<CaseResult & { detail: any }> });
  const val = (m: Metric | undefined) => (m && "value" in m ? m.value : NaN);
  const M = (x: number) => (x / 1e6).toFixed(2), I = (x: number) => String(Math.round(x));
  const label = (r: RunResult) => String(r.config.preset) + (r.config.live && r.config.live !== "none" ? "→" + r.config.live : "");
  const poses = [...new Set(runs.flatMap((r) => r.cases.map((c) => c.scenario.id.replace("census/", ""))))];
  const out: string[] = [];
  for (const pose of poses) {
    const at = (r: (typeof runs)[number]) => r.cases.find((x) => x.scenario.id === "census/" + pose);
    out.push("### " + pose, "", "| Preset | Build tier | Calls | Tris M | Points M | Main calls | Main tris M | Shadow passes | Shadow calls | Shadow tris M | Other scene passes | Other scene tris M | Aux passes | Aux Mpx | Main Mpx | Programs | Textures | Scale | Veg |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of runs) {
      const c = at(r); if (!c) continue;
      const m = c.metrics, d = c.detail;
      out.push("| " + [label(r), d.quality, I(val(m.drawCalls)), M(val(m.triangles)), M(val(m.points)), I(val(m.sceneCalls)), M(val(m.sceneTriangles)), val(m.shadowPasses).toFixed(1), I(val(m.shadowCalls)), M(val(m.shadowTriangles)), val(m.otherScenePasses).toFixed(1), M(val(m.otherSceneTriangles)), val(m.auxPasses).toFixed(0), val(m.auxMpx).toFixed(1), val(m.sceneMpx).toFixed(1), I(val(m.programs)), I(val(m.textures)), val(m.renderScale).toFixed(2), d.veg ? d.veg.tier + " d" + d.veg.dist + " n" + d.veg.density + " sh:" + d.veg.shadows : "-"].join(" | ") + " |");
    }
    out.push("");
    const keys = new Set<string>();
    for (const r of runs) { const c = at(r); if (c) for (const [k, v] of Object.entries(c.detail.mods as Record<string, { tris: number }>)) if (v.tris > 30_000 && !k.startsWith("scene:")) keys.add(k); }
    out.push("| Module (pass): M tris / calls | " + runs.map(label).join(" | ") + " |", "|---|" + runs.map(() => "---|").join(""));
    for (const k of [...keys].sort()) out.push("| " + k + " | " + runs.map((r) => { const v = at(r)?.detail.mods[k]; return v ? M(v.tris) + " / " + I(v.calls) : "-"; }).join(" | ") + " |");
    out.push("");
  }
  console.log(out.join("\n"));
}

const cmd = process.argv[2];
if (cmd === "run") await run();
else if (cmd === "table") table(process.argv.slice(3).filter((a) => a.endsWith(".json")));
else { console.error("usage: preset-census.mts run [options] | table <file.json>..."); process.exit(2); }
