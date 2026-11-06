import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { MeshoptSimplifier } from "meshoptimizer";
import { POIS } from "../../shared/world/map";
import { FAR_DIR, FAR_INDEX, poiSourceHash, type FarIndex } from "./far-hash.mts";

const USAGE = "npx tsx tools/world/bake-far.mts [--url http://127.0.0.1:3120] [--only id,id] [--tris 12000]";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv.includes("--help")) { console.log(USAGE); process.exit(0); }
const base = arg("--url") ?? "http://127.0.0.1:3120";
const target = Number(arg("--tris") ?? 12000);
const only = arg("--only")?.split(",");
const WELD_PER_M = 1000, ERROR_START = 0.001, ERROR_STEP = 1.25, ERROR_MAX = 0.005, COLOR_WEIGHTS = [0.5, 0.5, 0.5];
const VIEW_DIST_M = 800, VIEW_UP_M = 250, SETTLE_MS = 4000, BUILD_TIMEOUT_MS = 900000;
const ids = POIS.map((p) => p.id).filter((id) => id !== "lobby-islet" && (!only || only.includes(id)));

interface Extracted { pos: Float32Array; col: Float32Array; idx: Uint32Array; skipped: Record<string, number> }
interface Soup { pos: number[]; col: number[]; idx: number[]; tris: number; srcTris: number; error: number; skipped: Record<string, number> }

function extract(a: { id: string }): Extracted {
  const kr = (window as unknown as { __kr: { moduleRoots(id: string): unknown[] } }).__kr;
  type M = { isMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean; isSkinnedMesh?: boolean; visible: boolean; parent: M | null; children: M[]; layers: { mask: number }; matrixWorld: { elements: number[] }; geometry?: G; material?: Mat | Mat[]; count?: number; instanceMatrix?: { array: Float32Array }; instanceColor?: { array: Float32Array } | null; getGeometryIdAt?(i: number): number; getGeometryRangeAt?(g: number): { vertexStart: number; vertexCount: number; indexStart: number; indexCount: number }; getVisibleAt?(i: number): boolean; _instanceInfo?: Array<{ active: boolean }>; _matricesTexture?: { image: { data: Float32Array } }; _colorsTexture?: { image: { data: Float32Array } } | null; updateMatrixWorld(force: boolean): void };
  type A = { count: number; itemSize: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number; array: ArrayLike<number> | null };
  type G = { attributes: Record<string, A>; index: A | null; drawRange: { start: number; count: number } };
  type Mat = { visible: boolean; transparent: boolean; opacity: number; depthWrite: boolean; color?: { r: number; g: number; b: number }; map?: { uuid: string; image?: unknown } | null; vertexColors?: boolean; isShaderMaterial?: boolean; type: string; userData: { jungleUniforms?: { uMoss: { value: number }; uMossCover: { value: number }; uMossColor: { value: { r: number; g: number; b: number } | number }; uMossMap: { value: { uuid: string; image?: unknown } | null }; uJNoise?: { value?: { image?: { data?: ArrayLike<number> } } } } } };
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const texMean = new Map<string, number[]>();
  const meanOf = (t: { uuid: string; image?: unknown }): number[] => {
    const known = texMean.get(t.uuid); if (known) return known;
    let out = [1, 1, 1];
    const im = t.image as { width?: number; height?: number; data?: ArrayLike<number> } | null | undefined;
    try {
      if (im && im.data && im.width && im.height) {
        const d = im.data, n = im.width * im.height, step = Math.max(1, Math.floor(n / 4096)), s = [0, 0, 0]; let k = 0;
        const ch = d.length / n;
        for (let i = 0; i < n; i += step) { for (let c = 0; c < 3; c++) s[c] += d[i * ch + Math.min(c, ch - 1)]; k++; }
        const scale = d instanceof Uint8Array || d instanceof Uint8ClampedArray ? 255 : 1;
        out = s.map((v) => Math.pow(v / k / scale, 2.2));
      } else if (im && im.width && im.height) {
        const cv = document.createElement("canvas"); cv.width = 8; cv.height = 8;
        const g = cv.getContext("2d")!; g.drawImage(im as CanvasImageSource, 0, 0, 8, 8);
        const d = g.getImageData(0, 0, 8, 8).data, s = [0, 0, 0];
        for (let i = 0; i < 64; i++) for (let c = 0; c < 3; c++) s[c] += d[i * 4 + c];
        out = s.map((v) => Math.pow(v / 64 / 255, 2.2));
      }
    } catch { skip("texture-unreadable"); }
    texMean.set(t.uuid, out);
    return out;
  };
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const mul = (a: ArrayLike<number>, b: ArrayLike<number>, o: number[]) => { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; };
  const shown = (o: M, rootObj: M) => { for (let p: M | null = o; p && p !== rootObj; p = p.parent) if (!p.visible) return false; return (o.layers.mask & 1) !== 0; };
  const MOSS_GAIN = 1.7, WHITE = [1, 1, 1];
  const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  let moss: { top: number; side: number; c: number[] } | null = null;
  const steps = new Map<string, number>();
  const meanStep = (noise: ArrayLike<number>, a: number, b: number) => {
    const key = a + "," + b, known = steps.get(key); if (known !== undefined) return known;
    let s = 0; for (let i = 0; i < noise.length; i += 4) s += smooth(a, b, noise[i] / 255);
    steps.set(key, s / (noise.length / 4)); return s / (noise.length / 4);
  };
  const add = (g: G, m: number[], rgb: number[], tint: ArrayLike<number>, vColor: boolean, vStart: number, vCount: number, iStart: number, iCount: number) => {
    const P = g.attributes.position, C = vColor ? g.attributes.color : undefined, N = moss ? g.attributes.normal : undefined, base = pos.length / 3;
    if (!P || !P.array) { skip("no-position"); return; }
    for (let i = vStart; i < vStart + vCount; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      const c = [rgb[0], rgb[1], rgb[2]];
      if (moss && N) {
        const nx = N.getX(i), ny = N.getY(i), nz = N.getZ(i), wx = m[0] * nx + m[4] * ny + m[8] * nz, wy = m[1] * nx + m[5] * ny + m[9] * nz, wz = m[2] * nx + m[6] * ny + m[10] * nz;
        const up = wy / (Math.hypot(wx, wy, wz) || 1);
        const w = Math.min(1, Math.max(smooth(0.25, 0.85, up) * moss.top, moss.side * (1 - smooth(0.2, 0.6, Math.abs(up)))));
        for (let k = 0; k < 3; k++) c[k] += (moss.c[k] - c[k]) * w;
      }
      if (C) { c[0] *= C.getX(i); c[1] *= C.getY(i); c[2] *= C.getZ(i); }
      col.push(c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]);
    }
    if (g.index) for (let i = iStart; i < iStart + iCount; i++) idx.push(base + g.index.getX(i) - vStart);
    else for (let i = 0; i < vCount; i++) idx.push(base + i);
  };
  let jungleNoise: ArrayLike<number> | undefined;
  const findNoise = (o: M) => { for (const x of [o.material ?? []].flat()) jungleNoise ??= x.userData.jungleUniforms?.uJNoise?.value?.image?.data; o.children.forEach(findNoise); };
  for (const r of kr.moduleRoots("poi:" + a.id) as M[]) findNoise(r);
  const tmp: number[] = new Array(16).fill(0), im16 = { elements: new Array(16).fill(0) };
  for (const r of kr.moduleRoots("poi:" + a.id) as M[]) {
    r.updateMatrixWorld(true);
    const walk = (o: M) => {
      if (o !== r && !o.visible) return;
      for (const c of o.children) walk(c);
      if (!o.isMesh || !o.geometry) return;
      if (o.isSkinnedMesh) { skip("skinned"); return; }
      if (!shown(o, r)) { skip("hidden"); return; }
      const mat = (Array.isArray(o.material) ? o.material[0] : o.material) as Mat | undefined;
      if (!mat || !mat.visible) { skip("no-material"); return; }
      if ((mat.transparent && mat.opacity < 0.95) || !mat.depthWrite) { skip("transparent"); return; }
      if (mat.isShaderMaterial && !mat.color) { skip("shader"); return; }
      const rgb = [mat.color?.r ?? 0.6, mat.color?.g ?? 0.6, mat.color?.b ?? 0.6];
      if (mat.map) { const t = meanOf(mat.map); for (let c = 0; c < 3; c++) rgb[c] *= t[c]; }
      const ju = mat.userData.jungleUniforms;
      if (ju && ju.uMoss.value > 0) {
        const cover = ju.uMossCover.value, mv = ju.uMossColor.value, lin = (v: number) => Math.pow(v / 255, 2.2);
        const mc = typeof mv === "number" ? { r: lin((mv >> 16) & 255), g: lin((mv >> 8) & 255), b: lin(mv & 255) } : mv, mm = ju.uMossMap.value ? meanOf(ju.uMossMap.value) : [1, 1, 1];
        const noise = ju.uJNoise?.value?.image?.data ?? jungleNoise;
        if (!noise) { skip("moss-without-noise"); moss = null; } else
        moss = { top: ju.uMoss.value * meanStep(noise, 0.62 - cover * 0.6, 0.92 - cover * 0.6), side: ju.uMoss.value * 0.35 * meanStep(noise, 0.55, 0.8), c: [mc.r * mm[0] * MOSS_GAIN, mc.g * mm[1] * MOSS_GAIN, mc.b * mm[2] * MOSS_GAIN] };
      } else moss = null;
      const g = o.geometry, P = g.attributes.position;
      if (!P) { skip("no-position"); return; }
      const vColor = !!mat.vertexColors && !!g.attributes.color;
      const mw = o.matrixWorld.elements;
      const vAll = P.count, iAll = g.index ? Math.min(g.index.count, g.drawRange.count) : 0;
      if (o.isBatchedMesh) {
        const info = o._instanceInfo ?? [];
        for (let i = 0; i < info.length; i++) {
          if (!info[i].active || !o.getVisibleAt!(i)) continue;
          const gr = o.getGeometryRangeAt!(o.getGeometryIdAt!(i));
          const md = o._matricesTexture!.image.data;
          for (let k = 0; k < 16; k++) im16.elements[k] = md[i * 16 + k];
          const cd = o._colorsTexture?.image.data;
          add(g, mul(mw, im16.elements, tmp.slice()), rgb, cd ? [cd[i * 4], cd[i * 4 + 1], cd[i * 4 + 2]] : WHITE, vColor, gr.vertexStart, gr.vertexCount, gr.indexStart, gr.indexCount);
        }
        return;
      }
      if (o.isInstancedMesh) {
        const n = o.count ?? 0, arr = o.instanceMatrix!.array, ic = o.instanceColor?.array;
        for (let i = 0; i < n; i++) {
          add(g, mul(mw, Array.prototype.slice.call(arr, i * 16, i * 16 + 16), tmp.slice()), rgb, ic ? [ic[i * 3], ic[i * 3 + 1], ic[i * 3 + 2]] : WHITE, vColor, 0, vAll, 0, iAll);
        }
        return;
      }
      add(g, mw, rgb, WHITE, vColor, 0, vAll, 0, iAll);
    };
    walk(r);
  }
  return { pos: new Float32Array(pos), col: new Float32Array(col), idx: new Uint32Array(idx), skipped };
}

async function simplify(raw: Extracted, target: number): Promise<Soup> {
  const srcTris = raw.idx.length / 3;
  const keys = new Map<string, number>(), remap = new Uint32Array(raw.pos.length / 3), pos: number[] = [], col: number[] = [];
  for (let i = 0; i < remap.length; i++) {
    const k = Array.from(raw.pos.subarray(i * 3, i * 3 + 3), (v) => Math.round(v * WELD_PER_M)).join(",") + "|" + Array.from(raw.col.subarray(i * 3, i * 3 + 3), (v) => Math.round(v * 255)).join(",");
    let j = keys.get(k);
    if (j === undefined) { j = keys.size; keys.set(k, j); pos.push(raw.pos[i * 3], raw.pos[i * 3 + 1], raw.pos[i * 3 + 2]); col.push(raw.col[i * 3], raw.col[i * 3 + 1], raw.col[i * 3 + 2]); }
    remap[i] = j;
  }
  const P = new Float32Array(pos), C = new Float32Array(col), tri: number[] = [];
  for (let t = 0; t < raw.idx.length; t += 3) {
    const a = remap[raw.idx[t]], b = remap[raw.idx[t + 1]], c = remap[raw.idx[t + 2]];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  const welded = new Uint32Array(tri);
  await MeshoptSimplifier.ready;
  const run = (e: number) => MeshoptSimplifier.simplifyWithAttributes(welded, P, 3, C, 3, COLOR_WEIGHTS, null, Math.min(welded.length, target * 3), e, ["Permissive"])[0];
  let error = ERROR_START, out = run(error);
  while (out.length / 3 > target && error * ERROR_STEP <= ERROR_MAX) { error *= ERROR_STEP; out = run(error); }
  const used = new Map<number, number>(), p: number[] = [], c: number[] = [], ix: number[] = [];
  for (const v of out) {
    let n = used.get(v);
    if (n === undefined) { n = used.size; used.set(v, n); p.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); c.push(C[v * 3], C[v * 3 + 1], C[v * 3 + 2]); }
    ix.push(n);
  }
  return { pos: p, col: c, idx: ix, tris: ix.length / 3, srcTris, error, skipped: raw.skipped };
}

function encode(s: Soup): Buffer {
  const n = s.pos.length / 3, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], s.pos[i * 3 + c]); hi[c] = Math.max(hi[c], s.pos[i * 3 + c]); }
  const size = lo.map((v, c) => Math.max(hi[c] - v, 1e-3));
  const wide = n > 65535, head = 40, posB = n * 6, colOff = head + Math.ceil(posB / 4) * 4, idxOff = colOff + n * 4;
  const buf = Buffer.alloc(idxOff + s.idx.length * (wide ? 4 : 2));
  buf.write("KRFI", 0, "ascii"); buf.writeUInt32LE(1, 4); buf.writeUInt32LE(n, 8); buf.writeUInt32LE(s.idx.length, 12);
  for (let c = 0; c < 3; c++) { buf.writeFloatLE(lo[c], 16 + c * 4); buf.writeFloatLE(size[c], 28 + c * 4); }
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) buf.writeUInt16LE(Math.round(((s.pos[i * 3 + c] - lo[c]) / size[c]) * 65535), head + (i * 3 + c) * 2);
  const srgb = (v: number) => Math.round(Math.min(1, Math.max(0, Math.pow(Math.max(0, v), 1 / 2.2))) * 255);
  for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) buf.writeUInt8(srgb(s.col[i * 3 + c]), colOff + i * 4 + c); buf.writeUInt8(255, colOff + i * 4 + 3); }
  for (let i = 0; i < s.idx.length; i++) { if (wide) buf.writeUInt32LE(s.idx[i], idxOff + i * 4); else buf.writeUInt16LE(s.idx[i], idxOff + i * 2); }
  return buf;
}

const indexPath = path.join(root, FAR_INDEX);
const index: FarIndex = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : { version: 1, pois: {} };
fs.mkdirSync(path.join(root, FAR_DIR), { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failed = 0;
for (const id of ids) {
  const p = POIS.find((q) => q.id === id)!;
  const len = Math.hypot(p.x, p.z) || 1, dx = p.x / len, dz = p.z / len, y = p.padY ?? 0;
  const cam = [p.x + dx * VIEW_DIST_M, y + VIEW_UP_M, p.z + dz * VIEW_DIST_M, p.x, y + 20, p.z].map((v) => v.toFixed(1)).join(",");
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  await page.addInitScript("window.__name = (f) => f;");
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const t0 = Date.now();
  try {
    await page.goto(`${base}/?cam=${cam}&modules=atmos,terrain,poi:${id}&noocc&nohlod&texfree=0`);
    await page.waitForFunction((m) => { const k = (window as unknown as { __kr?: { ready?: boolean; modules?: string[]; engine?: { pendingHolds(): string[] } } }).__kr; return !!k?.ready && !!k.modules?.includes(m) && k.engine!.pendingHolds().length === 0; }, "poi:" + id, { timeout: BUILD_TIMEOUT_MS, polling: 1000 });
    const loadErrors = await page.evaluate(() => (window as unknown as { __kr: { errors?: unknown[] } }).__kr.errors ?? []);
    if (loadErrors.length) throw new Error("load errors " + JSON.stringify(loadErrors).slice(0, 400));
    await page.waitForTimeout(SETTLE_MS);
    const soup = await simplify(await page.evaluate(extract, { id }), target);
    if (!soup.tris) throw new Error("no geometry extracted " + JSON.stringify(soup.skipped));
    const bin = encode(soup);
    fs.writeFileSync(path.join(root, FAR_DIR, id + ".bin"), bin);
    index.pois[id] = { hash: poiSourceHash(root, id), tris: soup.tris, bytes: bin.length };
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
    console.log(`${id}: ${soup.srcTris} → ${soup.tris} tris (error ${soup.error.toFixed(4)}), ${(bin.length / 1024).toFixed(0)} KB, ${Math.round((Date.now() - t0) / 1000)} s, skipped ${JSON.stringify(soup.skipped)}${errors.length ? " page errors: " + errors.join(" | ") : ""}`);
  } catch (e) {
    failed++;
    console.error(`${id}: FAILED ${String(e).slice(0, 300)}`);
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
