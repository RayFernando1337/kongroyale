import { chromium } from "playwright";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.lastIndexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const urlArg = opt("--url", "");
if (!urlArg) throw Error("pass --url http://127.0.0.1:PORT/... (a server you started: kr-verify up --prod)");
const url = new URL(urlArg);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error(`refusing ${url.hostname}: only servers you run (AGENTS.md rule 7)`);
if (!url.searchParams.has("seed")) url.searchParams.set("seed", "42");
if (!url.searchParams.has("vegsplat")) url.searchParams.set("vegsplat", "0");
const WAIT_S = Number(opt("--wait-secs", "900")), AFTER_S = Number(opt("--after-secs", "20"));
const GL_NOISE = /WebGL|GL_INVALID|THREE\./;

type Kr = { ready?: boolean; errors?: string[]; game?: { inMatch?: boolean; cm?: { phase?: number } }; engine: { restores: number; contextLost: boolean; time: number; renderer: { getContext(): WebGL2RenderingContext } } };
const kr = () => (window as unknown as { __kr: Kr }).__kr;

const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const failures: string[] = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  await ctx.addInitScript("globalThis.kr = () => window.__kr;");
  const page = await ctx.newPage();
  const log: string[] = [];
  page.on("pageerror", (e) => log.push(`pageerror: ${String(e.message).slice(0, 300)}`));
  page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && GL_NOISE.test(m.text())) log.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  let navigations = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations++; });
  const until = async (what: string, fn: () => boolean, secs: number) => {
    const end = Date.now() + secs * 1000;
    while (Date.now() < end) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(2000); }
    failures.push(`timed out after ${secs} s waiting for ${what}`);
    return false;
  };
  console.log(`context loss: ${url}`);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
  if (!await until("the title (__kr.ready)", () => !!kr()?.ready, WAIT_S)) throw Error("no title");
  await page.locator("button.tn-play-cta").click({ timeout: 120_000, force: true });
  if (!await until("the match (inMatch)", () => !!kr().game?.inMatch, WAIT_S)) throw Error("no match");
  await page.waitForTimeout(8000);
  const before = await page.evaluate(() => {
    (window as unknown as { __lossMarker: number }).__lossMarker = 1;
    const k = kr(), gl = k.engine.renderer.getContext(), ext = gl.getExtension("WEBGL_lose_context")!;
    (window as unknown as { __lose: WEBGL_lose_context }).__lose = ext;
    const out = { restores: k.engine.restores, phase: k.game?.cm?.phase ?? -1, navigations: 0 };
    ext.loseContext();
    return out;
  });
  const navBefore = navigations, logBefore = log.length;
  console.log(`lost the context in phase ${before.phase}`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext());
  const restored = await until("engine.restores to go up", () => (window as unknown as { __lossMarker?: number }).__lossMarker !== 1 || kr().engine.restores > 0, 300);
  const t0 = await page.evaluate(() => kr().engine.time).catch(() => -1);
  await page.waitForTimeout(AFTER_S * 1000);
  const after = await page.evaluate(() => ({ marker: (window as unknown as { __lossMarker?: number }).__lossMarker ?? 0, restores: kr().engine.restores, lost: kr().engine.contextLost, time: kr().engine.time, errors: (kr().errors ?? []).map((e) => String(e).slice(0, 300)) }));
  if (navigations > navBefore || after.marker !== 1) failures.push("the page reloaded instead of restoring in place");
  else if (restored && after.restores <= before.restores) failures.push(`engine.restores is ${after.restores}, not above ${before.restores}`);
  if (after.lost) failures.push("the engine still reports the context as lost");
  if (!(after.time > t0)) failures.push(`the frame loop did not resume (engine.time ${t0} -> ${after.time})`);
  for (const e of after.errors) failures.push(`__kr.errors: ${e}`);
  for (const l of log.slice(logBefore)) failures.push(l);
  console.log(`restores ${before.restores} -> ${after.restores}, engine.time ${t0} -> ${after.time}`);
} catch (e) {
  failures.push(String((e as Error).message ?? e).slice(0, 400));
} finally {
  await browser.close();
}
const unique = [...new Set(failures)];
console.log(unique.length ? `FAIL\n  ${unique.slice(0, 40).join("\n  ")}` : "ok: restored in place, no reload, no WebGL or page errors");
process.exit(unique.length ? 1 : 0);
