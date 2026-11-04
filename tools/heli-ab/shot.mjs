import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";
const repo = process.argv[2], angle = process.argv[3] ?? "metal", out = process.argv[4] ?? "heli-ab-out";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { chromium } = await import(new URL("file://" + path.resolve(repo, "node_modules/playwright/index.mjs").replace(/\\/g, "/")).href);
fs.mkdirSync(out, { recursive: true });
const oldGlb = path.join(out, "old.glb");
if (!fs.existsSync(oldGlb)) fs.writeFileSync(oldGlb, execSync("git show 290a32b:public/assets/vehicles/heli/kong-air.glb", { cwd: repo, maxBuffer: 1 << 26 }));
const files = { "/index.html": path.join(here, "index.html"), "/old.glb": oldGlb, "/new.glb": path.resolve(repo, "public/assets/vehicles/heli/kong-air.glb") };
const srv = http.createServer((q, s) => { const u = q.url.split("?")[0]; const f = files[u] ?? (u.startsWith("/three/") ? path.resolve(repo, "node_modules", u.slice(1)) : null); if (!f || !fs.existsSync(f)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".html") ? "text/html" : "application/octet-stream" }); fs.createReadStream(f).pipe(s); }).listen(8766, "127.0.0.1");
const b = await chromium.launch({ channel: angle === "swiftshader" ? undefined : "chrome", args: angle === "swiftshader" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : ["--use-angle=" + angle, "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const views = { wide: "view=1,0.35,1&dist=0.9", close: "view=0.9,0.25,0.35&dist=0.28", side: "view=1,0.1,0&dist=0.33", gun: "view=-1,0.15,0.2&dist=0.22" };
for (const [vn, vq] of Object.entries(views)) for (const m of ["old", "new"]) {
  await p.goto("http://127.0.0.1:8766/index.html?glb=" + m + ".glb&" + vq);
  await p.waitForFunction(() => window.done, null, { timeout: 300000 });
  await p.screenshot({ path: path.join(out, vn + "-" + m + ".png") });
}
console.log(JSON.stringify({ ok: true, gpu: await p.evaluate(() => { const c = document.createElement("canvas").getContext("webgl2"); const e = c.getExtension("WEBGL_debug_renderer_info"); return c.getParameter(e.UNMASKED_RENDERER_WEBGL); }), out }));
await b.close(); srv.close();