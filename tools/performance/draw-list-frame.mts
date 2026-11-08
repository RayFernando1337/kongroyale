// Draw list pixel gate (KONG-93 / RAY-237 option (c) step 2): does ?drawlist change a single pixel? A same-frame A/B, so
// nothing that moves between frames (TAA jitter, dither and AO frame counters, fades on performance.now) can differ:
// at each view, one main-scene render (engine.scene from engine.camera, the post chain's RenderPass) is drawn three
// times from the same starting buffer: list off, list on, list off again, after one discarded list-off render (a first
// re-render can still move per-render state: one lowmem view differed between the first and every later render with the
// list off throughout, and matched once that render was spent). The renders run back to back inside that
// render call, so the clock, the uniforms and the scene are the same for all three. The scene buffer's colour, depth and
// stencil are copied aside before the first render and copied back before the next two, and each result's colour
// attachments are read back in full (the buffer's own texel bits, not 8-bit screenshots). off vs off2 must match for the
// check to mean anything; on vs off is the gate. The frame then goes on with off2 in the buffer, as three drew it.
//
//   npx tsx tools/performance/draw-list-frame.mts --url "http://127.0.0.1:PORT/?drawlist=1&..." [--views a,b,c]
//     [--out result.json] [--gpu] [--chrome]
//
// The URL is a server you run (node tools/kr-verify.mjs up --prod). The tool adds shot=1, seed=42 and vegsplat=0 when
// they are missing, and drawlist=1 when no drawlist is set. Add lowmem=1&geofree=1&farimp=1 for the low-memory arm.
// --gpu launches Chrome on the hardware (Metal / D3D11); the default is Playwright's Chromium on SwiftShader (--chrome:
// the installed Chrome on SwiftShader). Exit 1 on any differing value, any
// GL error, a view where the list served no draw, or an off/off2 pair that differs.
import fs from "node:fs";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.lastIndexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const urlArg = opt("--url", "");
if (!urlArg) throw Error("pass --url http://127.0.0.1:PORT/?drawlist=1 (a server you started: node tools/kr-verify.mjs up --prod)");
const url = new URL(urlArg);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error(`refusing ${url.hostname}: only servers you run (AGENTS.md rule 7)`);
for (const [k, v] of [["shot", "1"], ["seed", "42"], ["vegsplat", "0"], ["drawlist", "1"]]) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
const views = opt("--views", "poi-12-mango-market,mango-plaza-ground,mango-street,mango-aerial,mango-stall-close,mango-int").split(",");
url.searchParams.set("view", views[0]);
const out = opt("--out", ""), gpu = argv.includes("--gpu");
const WAIT_S = Number(opt("--wait-secs", "900")), SETTLE_FRAMES = Number(opt("--settle-frames", "20"));

/** one view's result: values are colour channels over every attachment, lit the non-zero colour (not alpha) ones in the list-off render; maxAbs is in the units read back */
interface FrameResult { view: string; size: [number, number]; attachments: number; type: number; values: number; lit: number; onVsOff: number; offVsOff2: number; onVsOff2: number; maxAbs: number; lean: number; fallback: number; glErrors: string[] }

/** Page function: the same-frame A/B on the next main-scene render. Self-contained (Playwright serialises it). */
function sameFrame(): Promise<Omit<FrameResult, "view">> {
  const kr = (window as any).__kr, e = kr.engine, r = e.renderer, gl = r.getContext() as WebGL2RenderingContext, dl = kr.drawList;
  return new Promise((resolve, reject) => {
    const render = r.render;
    r.render = function (scene: unknown, cam: unknown) {
      if (scene !== e.scene || cam !== e.camera) return render.call(this, scene, cam);
      r.render = render;
      try {
        const rt = r.getRenderTarget();
        if (!rt) throw Error("the main scene render has no render target (post chain off?)");
        const w = rt.width, h = rt.height, n = rt.textures.length, type = rt.texture.type as number;
        const save = rt.clone();
        r.initRenderTarget(save);
        const fb = (t: unknown) => r.properties.get(t).__webglFramebuffer as WebGLFramebuffer;
        const extra = (rt.depthBuffer ? gl.DEPTH_BUFFER_BIT : 0) | (rt.stencilBuffer ? gl.STENCIL_BUFFER_BIT : 0);
        const all: number[] = []; for (let j = 0; j < n; j++) all.push(gl.COLOR_ATTACHMENT0 + j);
        // copy every colour attachment and the depth / stencil buffer of one target into the other
        const blit = (from: unknown, to: unknown) => {
          r.state.bindFramebuffer(gl.READ_FRAMEBUFFER, fb(from)); r.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb(to));
          for (let i = 0; i < n; i++) {
            gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
            gl.drawBuffers(all.map((a, j) => (j === i ? a : gl.NONE)));
            gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT | (i === 0 ? extra : 0), gl.NEAREST);
          }
          gl.drawBuffers(all); gl.readBuffer(gl.COLOR_ATTACHMENT0);
          r.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null); r.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
          r.setRenderTarget(rt);
        };
        // raw reads: RGBA / FLOAT is the one read every float colour buffer allows (EXT_color_buffer_float), the half-float
        // and R11F_G11F_B10F scene buffers included, where three's readRenderTargetPixels asks for the buffer's own format
        const byte = type === 1009;
        const read = () => {
          const px: ArrayLike<number>[] = [];
          r.state.bindFramebuffer(gl.READ_FRAMEBUFFER, fb(rt));
          for (let i = 0; i < n; i++) {
            const b = byte ? new Uint8Array(w * h * 4) : new Float32Array(w * h * 4);
            gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
            gl.readPixels(0, 0, w, h, gl.RGBA, byte ? gl.UNSIGNED_BYTE : gl.FLOAT, b);
            px.push(b);
          }
          gl.readBuffer(gl.COLOR_ATTACHMENT0);
          r.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          r.setRenderTarget(rt);
          return px;
        };
        const glErrors: string[] = [];
        const drain = (at: string) => { for (let x = gl.getError(), g = 0; x !== gl.NO_ERROR && g < 16; x = gl.getError(), g++) glErrors.push(at + ":" + x); };
        const pass = (on: boolean) => { const at = on ? "on" : "off"; dl.on = on; render.call(r, scene, cam); drain(at + " render"); const px = read(); drain(at + " read"); return px; };
        drain("before");
        const dlOn = dl.on;
        blit(rt, save); drain("save");
        pass(false);
        blit(save, rt); drain("warm");
        const off = pass(false);
        blit(save, rt); drain("restore");
        dl.reset();
        const on = pass(true);
        const { lean, fallback } = dl.counts();
        blit(save, rt);
        const off2 = pass(false);
        dl.on = dlOn;
        save.dispose();
        let values = 0, onVsOff = 0, offVsOff2 = 0, onVsOff2 = 0, maxAbs = 0, lit = 0;
        for (let i = 0; i < n; i++) {
          const a = off[i], b = on[i], c = off2[i];
          for (let k = 0; k < a.length; k++) {
            values++;
            if (a[k] !== 0 && (k & 3) !== 3) lit++;
            if (!Object.is(a[k], c[k])) offVsOff2++;
            if (!Object.is(b[k], c[k])) onVsOff2++;
            if (!Object.is(a[k], b[k])) { onVsOff++; const d = Math.abs(a[k] - b[k]); if (d > maxAbs) maxAbs = d; }
          }
        }
        resolve({ size: [w, h], attachments: n, type, values, lit, onVsOff, offVsOff2, onVsOff2, maxAbs, lean, fallback, glErrors });
      } catch (err) { reject(err); }
    };
  });
}

const browser = await chromium.launch(gpu
  ? { channel: "chrome", args: process.platform === "darwin" ? ["--use-angle=metal", "--enable-gpu"] : ["--enable-gpu", "--ignore-gpu-blocklist"] }
  : { headless: true, channel: argv.includes("--chrome") ? "chrome" : undefined, args: ["--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const results: FrameResult[] = [], failures: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 }, deviceScaleFactor: 1 });
  await page.addInitScript("globalThis.__name = (f) => f;");
  page.on("pageerror", (err) => failures.push(`pageerror: ${String(err.message).slice(0, 300)}`));
  console.log(`draw-list frame A/B: ${url}`);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => (window as any).__kr?.ready === true && !!(window as any).__kr.drawList, null, { timeout: WAIT_S * 1000, polling: 1000 });
  const off = await page.evaluate(() => (window as any).__kr.drawList.off as string);
  if (off) throw Error(`the draw list is not running: ${off}`);
  for (const view of views) {
    await page.evaluate(async (v) => { const kr = (window as any).__kr; kr.drawList.on = true; await kr.setView(v); }, view);
    const f0 = await page.evaluate(() => (window as any).__kr.engine.renderer.info.render.frame as number);
    await page.waitForFunction((f) => (window as any).__kr.engine.renderer.info.render.frame >= f, f0 + SETTLE_FRAMES, { timeout: 600_000, polling: 500 });
    const res = { view, ...await page.evaluate(sameFrame) };
    results.push(res);
    console.log(`${view.padEnd(22)} ${res.size.join("x")} x${res.attachments}  lit ${res.lit}/${res.values}  on≠off ${res.onVsOff} (max ${res.maxAbs})  off≠off2 ${res.offVsOff2}  on≠off2 ${res.onVsOff2}  lean ${res.lean} fallback ${res.fallback}  GL errors ${res.glErrors.length}`);
    if (res.offVsOff2) failures.push(`${view}: two renders with the list off differ in ${res.offVsOff2} values, so the A/B is not deterministic here`);
    if (res.onVsOff || res.onVsOff2) failures.push(`${view}: the list changes ${res.onVsOff} of ${res.values} values (max ${res.maxAbs})`);
    if (res.glErrors.length) failures.push(`${view}: GL errors ${res.glErrors.join(",")}`);
    if (res.lit < res.values / 8) failures.push(`${view}: only ${res.lit} of ${res.values} values are non-zero, so the readback saw no scene`);
    if (!res.lean) failures.push(`${view}: the list served no draw, so the frame proves nothing`);
  }
} catch (err) { failures.push(String(err)); }
finally { await browser.close(); }
if (out) fs.writeFileSync(out, JSON.stringify({ url: url.toString(), gpu, results, failures }, null, 1));
for (const f of failures) console.log(`FAIL ${f}`);
console.log(failures.length ? "draw-list frame A/B: FAILED" : "draw-list frame A/B: every view pixel-identical");
process.exit(failures.length ? 1 : 0);
