// poi-coast texture painter. Every surface is painted in code on a canvas: an albedo canvas and a parallel HEIGHT
// canvas drawn with the same strokes; the normal map is derived from the height (Sobel) so relief and colour always
// line up. Most textures are painted near-neutral so one texture serves many colours via vertex-colour tint.
// Textures are cached per key for the page lifetime (shared by lookout-point, peel-strip, the-plantation).
import * as THREE from "three";
import { rng } from "../../../../../shared/pois/coast-kit";
import { flag } from "../../../flags";

export interface TexSet { map: THREE.Texture; normalMap?: THREE.Texture; roughnessMap?: THREE.Texture }

type G = CanvasRenderingContext2D;
const cache = new Map<string, TexSet>();
let maxAniso = 8;

function cv(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  return { c, g };
}

function tex(c: HTMLCanvasElement, srgb: boolean, repeat = true): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** height canvas (grey) → tangent-space normal map canvas (OpenGL convention, three.js default) */
function normalFrom(h: HTMLCanvasElement, strength: number, wrap = true): HTMLCanvasElement {
  const w = h.width, H = h.height;
  const src = h.getContext("2d")!.getImageData(0, 0, w, H).data;
  const { c, g } = cv(w, H);
  const out = g.createImageData(w, H);
  // (row offsets + wrapped neighbours precomputed — a per-sample closure with two modulos was the
  // biggest self-time entry of the whole cold boot)
  const d = out.data, cx = (x: number) => (wrap ? (x + w) % w : Math.min(w - 1, Math.max(0, x))), cy = (y: number) => (wrap ? (y + H) % H : Math.min(H - 1, Math.max(0, y)));
  const xm = new Int32Array(w), xp = new Int32Array(w);
  for (let x = 0; x < w; x++) { xm[x] = cx(x - 1) * 4; xp[x] = cx(x + 1) * 4; }
  const k = strength / 255;
  for (let y = 0; y < H; y++) {
    const r0 = cy(y - 1) * w * 4, r1 = y * w * 4, r2 = cy(y + 1) * w * 4;
    for (let x = 0; x < w; x++) {
      const a = xm[x], c2 = xp[x], x4 = x * 4;
      const dx = (src[r0 + c2] + 2 * src[r1 + c2] + src[r2 + c2]) - (src[r0 + a] + 2 * src[r1 + a] + src[r2 + a]);
      const dy = (src[r2 + a] + 2 * src[r2 + x4] + src[r2 + c2]) - (src[r0 + a] + 2 * src[r0 + x4] + src[r0 + c2]);
      let nx = -dx * k, ny = dy * k, nz = 1;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + 1); nx *= l; ny *= l; nz *= l;
      const i = r1 + x4;
      d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------------------------------------- noise
function valueNoise(seed: number, cells: number) {
  const r = rng(seed), grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = r();
  return (u: number, v: number) => { // u,v in [0,1) tileable (2 wraps per sample, not 8)
    const x = u * cells, y = v * cells, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const i0 = ((i % cells) + cells) % cells, j0 = ((j % cells) + cells) % cells, i1 = i0 + 1 === cells ? 0 : i0 + 1, j1 = (j0 + 1 === cells ? 0 : j0 + 1) * cells, jr = j0 * cells;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const g00 = grid[jr + i0], g10 = grid[jr + i1], g01 = grid[j1 + i0], g11 = grid[j1 + i1];
    const a = g00 + (g10 - g00) * sx, b = g01 + (g11 - g01) * sx;
    return a + (b - a) * sy;
  };
}
function fbm(seed: number, base: number, oct: number) {
  const ns = Array.from({ length: oct }, (_, k) => valueNoise(seed + k * 101, base << k));
  return (u: number, v: number) => { let s = 0, a = 0.5, n = 0; for (const f of ns) { s += f(u, v) * a; n += a; a *= 0.5; } return s / n; };
}

/** per-pixel pass over one or two canvases */
function pass(g: G, fn: (x: number, y: number, d: Uint8ClampedArray, i: number) => void) {
  const { width: w, height: h } = g.canvas;
  const img = g.getImageData(0, 0, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) fn(x, y, img.data, (y * w + x) * 4);
  g.putImageData(img, 0, 0);
}

/** a RAISED pebble on the albedo + height canvases (flat discs on the height map read as craters): soft
 *  contact shade offset down-right, a body lighter at the top-left, a small highlight, and a DOME in the height map.
 *  ry = rx × asp (non-square texel aspect). tone = body grey 0..1, warm = warmth of the stone. */
function pebble(A: G, H: G, x: number, y: number, rx: number, asp: number, tone: number, warm = 0.92, rot = 0) {
  const ry = rx * asp * 0.85;
  A.fillStyle = "rgba(40,28,18,0.28)"; A.beginPath(); A.ellipse(x + rx * 0.3, y + ry * 0.35, rx * 1.18, ry * 1.12, rot, 0, 7); A.fill();
  const c = 255 * tone, gr = A.createRadialGradient(x - rx * 0.35, y - ry * 0.4, 0, x, y, Math.max(rx, ry) * 1.05);
  gr.addColorStop(0, `rgb(${Math.min(255, c * 1.12)},${Math.min(255, c * 1.08 * warm)},${Math.min(255, c * 1.0 * warm * warm)})`);
  gr.addColorStop(0.7, `rgb(${c * 0.92},${c * 0.88 * warm},${c * 0.8 * warm * warm})`);
  gr.addColorStop(1, `rgb(${c * 0.7},${c * 0.66 * warm},${c * 0.6 * warm * warm})`);
  A.fillStyle = gr; A.beginPath(); A.ellipse(x, y, rx, ry, rot, 0, 7); A.fill();
  const hg = H.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
  hg.addColorStop(0, "rgba(255,255,255,0.95)"); hg.addColorStop(0.55, "rgba(235,235,235,0.7)"); hg.addColorStop(1, "rgba(200,200,200,0)");
  H.fillStyle = hg; H.beginPath(); H.ellipse(x, y, rx * 1.05, ry * 1.05, rot, 0, 7); H.fill();
}

const hex = (c: THREE.ColorRepresentation) => "#" + new THREE.Color(c).getHexString();
function shade(c: string, k: number) { const q = new THREE.Color(c); q.multiplyScalar(k); return "#" + q.getHexString(); }
function mix(a: string, b: string, t: number) { return "#" + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString(); }

/** every painted set is
 *  baked to webp files (public/assets/pois/coast/proc/ + manifest.json) and loaded by
 *  preloadBaked() before the POI builds — make() then returns the loaded set and never paints. Without the files (or
 *  with ?painttex) the painter runs live. */
const recorded = new Map<string, { a: HTMLCanvasElement; n?: HTMLCanvasElement; r?: HTMLCanvasElement; repeat: boolean }>();
let recording = false;
function make(key: string, build: () => { a: HTMLCanvasElement; h?: HTMLCanvasElement; ns?: number; r?: HTMLCanvasElement; repeat?: boolean }): TexSet {
  const hit = cache.get(key);
  if (hit) return hit;
  const o = build();
  const set: TexSet = { map: tex(o.a, true, o.repeat !== false) };
  const nc = o.h ? normalFrom(o.h, o.ns ?? 2, o.repeat !== false) : undefined;
  if (nc) set.normalMap = tex(nc, false, o.repeat !== false);
  if (o.r) set.roughnessMap = tex(o.r, false, o.repeat !== false);
  if (recording) recorded.set(key, { a: o.a, n: nc, r: o.r, repeat: o.repeat !== false });
  cache.set(key, set);
  return set;
}

/** every painted set the coast POIs use (with their arguments) — the bake list */
export function paintAll(): void {
  plaster(); siding(0.35); siding(1); deck(); wood(); corrugated(0.35); corrugated(1); clayTiles(); stone(); brick(); concrete(); pavers();
  paintedMetal(); rock(); asphalt(); dirtRoad(); sandyGround(); bananaLeaf(); bananaTrunk(); crinkle(); bananaLogo("flat"); bananaLogo("badge");
  bananaSingle(); screens(); crateSide(); wornPaint(); blob(); glow(); litWindow(); ivy(); lookoutYard(); plRoad(); plYard(); bagCrinkle();
}
/** bake support (an offline bake script): paint everything and hand back the canvases as data URLs */
export function bakeExport(type = "image/webp", q = 0.92): Array<{ key: string; repeat: boolean; a: string; n?: string; r?: string }> {
  cache.clear(); recorded.clear(); recording = true;
  try { paintAll(); } finally { recording = false; }
  return [...recorded].map(([key, o]) => ({ key, repeat: o.repeat, a: o.a.toDataURL(type, q), n: o.n?.toDataURL(type, q), r: o.r?.toDataURL(type, q) }));
}
/** load the baked sets into the cache (no painting at build time). `load(url, srgb, repeat)` = the engine's asset
 *  loader. Returns the number of sets loaded (0 = no bake on disk / disabled by ?painttex). */
let preloaded: Promise<number> | null = null;
export function preloadBaked(load: (url: string, srgb: boolean, repeat: boolean) => Promise<THREE.Texture>): Promise<number> {
  if (preloaded) return preloaded;
  if (flag("painttex")) return (preloaded = Promise.resolve(0));
  preloaded = (async () => {
    let man: Record<string, { repeat: boolean; n?: boolean; r?: boolean }>;
    try { const res = await fetch("assets/pois/coast/proc/manifest.json"); if (!res.ok) return 0; man = await res.json(); } catch { return 0; }
    const fin = (t: THREE.Texture, rep: boolean) => { if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true; return t; };
    const name = (k: string) => k.replace(/[^a-zA-Z0-9.-]/g, "_");
    await Promise.all(Object.entries(man).map(async ([key, m]) => {
      if (cache.has(key)) return;
      const base = `assets/pois/coast/proc/${name(key)}`;
      const [a, n, r] = await Promise.all([load(`${base}.webp`, true, m.repeat), m.n ? load(`${base}_n.webp`, false, m.repeat) : null, m.r ? load(`${base}_r.webp`, false, m.repeat) : null]);
      const set: TexSet = { map: fin(a, m.repeat) };
      if (n) set.normalMap = fin(n, m.repeat);
      if (r) set.roughnessMap = fin(r, m.repeat);
      cache.set(key, set);
    }));
    return Object.keys(man).length;
  })();
  return preloaded;
}

// ------------------------------------------------------------------------------------------------ neutral surfaces
/** smooth-ish painted plaster / render, near white (tint with vertex colours) */
export function plaster(): TexSet {
  return make("plaster", () => {
    const S = 512, A = cv(S, S), H = cv(S, S), n = fbm(11, 4, 5), n2 = fbm(12, 16, 3);
    pass(A.g, (x, y, d, i) => {
      const u = x / S, v = y / S, m = n(u, v), f = n2(u, v);
      const k = 0.86 + 0.1 * m + 0.05 * f;
      d[i] = 255 * k; d[i + 1] = 250 * k; d[i + 2] = 240 * k; d[i + 3] = 255;
    });
    pass(H.g, (x, y, d, i) => { const v = 128 + 40 * (n2(x / S, y / S) - 0.5) + 30 * (n(x / S * 2 % 1, y / S * 2 % 1) - 0.5); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; });
    // a few faint hairline cracks (no pits / chips — they read as bullet holes from a distance)
    const r = rng(5);
    for (let k = 0; k < 6; k++) {
      let x = r() * S, y = r() * S; A.g.strokeStyle = "rgba(120,108,95,0.22)"; H.g.strokeStyle = "#6a6a6a"; A.g.lineWidth = H.g.lineWidth = 1;
      A.g.beginPath(); H.g.beginPath(); A.g.moveTo(x, y); H.g.moveTo(x, y);
      for (let s2 = 0; s2 < 6; s2++) { x += (r() - 0.5) * 22; y += r() * 14; A.g.lineTo(x, y); H.g.lineTo(x, y); }
      A.g.stroke(); H.g.stroke();
    }
    return { a: A.c, h: H.c, ns: 1.2 };
  });
}

/** vertical board-and-batten siding, painted (near white → tint). `boards` per tile. */
export function siding(worn = 0.5): TexSet {
  return make(`siding:${worn}`, () => {
    const S = 512, A = cv(S, S), H = cv(S, S), r = rng(21), grain = fbm(22, 8, 4);
    const boards = 6, bw = S / boards;
    H.g.fillStyle = "#808080"; H.g.fillRect(0, 0, S, S);
    for (let b = 0; b < boards; b++) {
      const x0 = b * bw, tone = 0.84 + r() * 0.14;
      A.g.fillStyle = `rgb(${250 * tone},${246 * tone},${238 * tone})`; A.g.fillRect(x0, 0, bw, S);
      // board end joints at random heights
      const j = r() * S;
      A.g.fillStyle = "rgba(60,50,40,0.55)"; A.g.fillRect(x0, j, bw, 2); H.g.fillStyle = "#303030"; H.g.fillRect(x0, j, bw, 2);
      // slight cupping
      const gr = H.g.createLinearGradient(x0, 0, x0 + bw, 0);
      gr.addColorStop(0, "#6c6c6c"); gr.addColorStop(0.5, "#8c8c8c"); gr.addColorStop(1, "#6c6c6c");
      H.g.fillStyle = gr; H.g.fillRect(x0 + 2, 0, bw - 4, j); H.g.fillRect(x0 + 2, j + 2, bw - 4, S - j - 2);
    }
    // grain streaks
    pass(A.g, (x, y, d, i) => { const gv = grain((x / S * 3) % 1, (y / S * 0.25) % 1); const k = 0.9 + 0.2 * gv; d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; });
    for (let k = 0; k < 260; k++) { const x = r() * S, y = r() * S, l = 10 + r() * 60; A.g.fillStyle = `rgba(90,75,60,${0.08 + r() * 0.12})`; A.g.fillRect(x, y, 1, l); }
    // battens over the joints
    for (let b = 0; b <= boards; b++) {
      const x = b * bw - 7;
      A.g.fillStyle = "rgb(236,232,222)"; A.g.fillRect(x, 0, 14, S);
      A.g.fillStyle = "rgba(40,30,20,0.35)"; A.g.fillRect(x + 13, 0, 3, S); A.g.fillRect(x - 2, 0, 2, S);
      const gr = H.g.createLinearGradient(x, 0, x + 14, 0);
      gr.addColorStop(0, "#909090"); gr.addColorStop(0.3, "#d8d8d8"); gr.addColorStop(0.7, "#d8d8d8"); gr.addColorStop(1, "#909090");
      H.g.fillStyle = gr; H.g.fillRect(x, 0, 14, S);
      for (let y = 20; y < S; y += 128) { A.g.fillStyle = "rgba(60,50,45,0.7)"; A.g.fillRect(x + 6, y, 3, 3); }
    }
    // paint wear: chipped patches show dark wood (tinted dark)
    for (let k = 0; k < 90 * worn; k++) {
      const x = r() * S, y = r() * S, w = 3 + r() * 16, h = 2 + r() * 7;
      A.g.fillStyle = `rgba(95,75,55,${0.5 + r() * 0.4})`; A.g.beginPath(); A.g.ellipse(x, y, w, h, r() * 0.4, 0, 7); A.g.fill();
      H.g.fillStyle = "rgba(60,60,60,0.8)"; H.g.beginPath(); H.g.ellipse(x, y, w, h, 0, 0, 7); H.g.fill();
    }
    return { a: A.c, h: H.c, ns: 2.2 };
  });
}

/** horizontal plank deck / floor boards (natural wood, lightly tintable) */
export function deck(): TexSet {
  return make("deck", () => {
    const S = 512, A = cv(S, S), H = cv(S, S), r = rng(31), grain = fbm(32, 6, 4);
    const rows = 8, rh = S / rows;
    H.g.fillStyle = "#909090"; H.g.fillRect(0, 0, S, S);
    for (let q = 0; q < rows; q++) {
      const y0 = q * rh; let x = -r() * S * 0.5;
      while (x < S) {
        const L = S * (0.45 + r() * 0.5), tone = 0.78 + r() * 0.28;
        const c = `rgb(${196 * tone},${160 * tone},${118 * tone})`;
        A.g.fillStyle = c; A.g.fillRect(x, y0, L, rh);
        A.g.fillStyle = "rgba(40,28,18,0.7)"; A.g.fillRect(x, y0, 2, rh);
        H.g.fillStyle = "#3a3a3a"; H.g.fillRect(x, y0, 2, rh);
        for (const nx of [x + 8, x + L - 10]) { A.g.fillStyle = "rgba(50,40,35,0.8)"; A.g.fillRect(nx, y0 + rh * 0.25, 3, 3); A.g.fillRect(nx, y0 + rh * 0.7, 3, 3); }
        x += L;
      }
      A.g.fillStyle = "rgba(30,20,12,0.85)"; A.g.fillRect(0, y0, S, 3);
      H.g.fillStyle = "#202020"; H.g.fillRect(0, y0, S, 3);
      const gr = H.g.createLinearGradient(0, y0 + 3, 0, y0 + rh);
      gr.addColorStop(0, "#7a7a7a"); gr.addColorStop(0.5, "#9a9a9a"); gr.addColorStop(1, "#7a7a7a");
      H.g.fillStyle = gr; H.g.fillRect(0, y0 + 3, S, rh - 3);
    }
    pass(A.g, (x, y, d, i) => { const gv = grain((x / S * 0.3) % 1, (y / S * 4) % 1); const k = 0.86 + 0.26 * gv; d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; });
    return { a: A.c, h: H.c, ns: 2 };
  });
}

/** raw wood (posts, beams, crates' frames) — long grain along V */
export function wood(): TexSet {
  return make("wood", () => {
    const S = 256, A = cv(S, S), H = cv(S, S), grain = fbm(41, 4, 5), r = rng(42);
    pass(A.g, (x, y, d, i) => {
      const u = x / S, v = y / S, g = grain((u * 6) % 1, (v * 0.5) % 1), rings = 0.5 + 0.5 * Math.sin((u * 40 + g * 8) * Math.PI);
      const k = 0.72 + 0.2 * g + 0.1 * rings;
      d[i] = 200 * k; d[i + 1] = 158 * k; d[i + 2] = 112 * k; d[i + 3] = 255;
    });
    pass(H.g, (x, y, d, i) => { const g = grain(((x / S) * 6) % 1, ((y / S) * 0.5) % 1); d[i] = d[i + 1] = d[i + 2] = 100 + 80 * g; d[i + 3] = 255; });
    for (let k = 0; k < 50; k++) { const x = r() * S, y = r() * S; A.g.fillStyle = "rgba(60,40,25,0.35)"; A.g.fillRect(x, y, 1, 8 + r() * 40); H.g.fillStyle = "#404040"; H.g.fillRect(x, y, 1, 8 + r() * 40); }
    return { a: A.c, h: H.c, ns: 1.5 };
  });
}

/** corrugated metal sheet, ridges along V (run the sheet so V goes down the roof slope). Tintable, rust streaks. */
export function corrugated(rust = 0.5): TexSet {
  return make(`corr:${rust}`, () => {
    const S = 512, A = cv(S, S), H = cv(S, S), r = rng(51), n = fbm(52, 4, 5), ridges = 12;
    pass(A.g, (x, y, d, i) => {
      const s = Math.sin((x / S) * ridges * Math.PI * 2), m = n(x / S, y / S);
      const k = 0.8 + 0.1 * s + 0.12 * m;
      d[i] = 236 * k; d[i + 1] = 236 * k; d[i + 2] = 232 * k; d[i + 3] = 255;
    });
    pass(H.g, (x, y, d, i) => { const s = Math.sin((x / S) * ridges * Math.PI * 2); d[i] = d[i + 1] = d[i + 2] = 128 + 110 * s; d[i + 3] = 255; });
    // sheet overlaps (horizontal seams) + rivet rows
    for (const y of [0, S / 2]) {
      A.g.fillStyle = "rgba(40,35,30,0.5)"; A.g.fillRect(0, y, S, 3); H.g.fillStyle = "rgba(20,20,20,0.6)"; H.g.fillRect(0, y, S, 3);
      for (let x = S / ridges / 4; x < S; x += S / ridges) { A.g.fillStyle = "rgba(60,50,45,0.9)"; A.g.beginPath(); A.g.arc(x, y + 9, 2.2, 0, 7); A.g.fill(); }
    }
    // rust streaks running down the ridges
    for (let k = 0; k < 70 * rust; k++) {
      const x = r() * S, y = r() * S, L = 20 + r() * 140, w = 2 + r() * 6;
      const gr = A.g.createLinearGradient(0, y, 0, y + L);
      gr.addColorStop(0, `rgba(140,70,30,${0.45 + r() * 0.35})`); gr.addColorStop(1, "rgba(140,70,30,0)");
      A.g.fillStyle = gr; A.g.fillRect(x, y, w, L);
    }
    for (let k = 0; k < 18 * rust; k++) {
      const x = r() * S, y = r() * S, s = 6 + r() * 22;
      const gr = A.g.createRadialGradient(x, y, 0, x, y, s); gr.addColorStop(0, "rgba(120,60,25,0.7)"); gr.addColorStop(1, "rgba(120,60,25,0)");
      A.g.fillStyle = gr; A.g.fillRect(x - s, y - s, 2 * s, 2 * s);
    }
    // roughness: metal mid-rough, rust rough
    const R = cv(S, S);
    const ad = A.g.getImageData(0, 0, S, S).data;
    pass(R.g, (x, y, d, i) => { const red = ad[i] - ad[i + 2]; const v = 110 + Math.min(120, red * 1.6) + 20 * (n(x / S, y / S) - 0.5); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; });
    return { a: A.c, h: H.c, ns: 3, r: R.c };
  });
}

/** clay roof tiles (baked red, tint to vary). Rows run along U, tiles overlap downward (V). */
export function clayTiles(): TexSet {
  return make("clay", () => {
    const S = 512, A = cv(S, S), H = cv(S, S), r = rng(61), rows = 8, cols = 8, th = S / rows, tw = S / cols;
    A.g.fillStyle = "#5a1d16"; A.g.fillRect(0, 0, S, S); H.g.fillStyle = "#202020"; H.g.fillRect(0, 0, S, S);
    for (let q = rows; q >= -1; q--) {
      const off = (q % 2) * tw / 2;
      for (let c = -1; c <= cols; c++) {
        const x = c * tw + off, y = q * th, tone = 0.8 + r() * 0.3;
        const base = new THREE.Color().setRGB(0.72 * tone, 0.22 * tone + r() * 0.04, 0.16 * tone);
        const gr = A.g.createLinearGradient(0, y, 0, y + th * 1.15);
        gr.addColorStop(0, "#" + base.clone().multiplyScalar(0.75).getHexString()); gr.addColorStop(0.75, "#" + base.getHexString()); gr.addColorStop(1, "#" + base.clone().multiplyScalar(1.12).getHexString());
        A.g.fillStyle = gr;
        const path = (g: G) => { g.beginPath(); g.moveTo(x + 2, y); g.lineTo(x + tw - 2, y); g.lineTo(x + tw - 2, y + th * 0.85); g.quadraticCurveTo(x + tw - 2, y + th * 1.12, x + tw / 2, y + th * 1.12); g.quadraticCurveTo(x + 2, y + th * 1.12, x + 2, y + th * 0.85); g.closePath(); };
        path(A.g); A.g.fill();
        const hg = H.g.createLinearGradient(0, y, 0, y + th * 1.12);
        hg.addColorStop(0, "#606060"); hg.addColorStop(0.85, "#e0e0e0"); hg.addColorStop(1, "#b0b0b0");
        H.g.fillStyle = hg; path(H.g); H.g.fill();
        // edge shadow under each tile
        A.g.fillStyle = "rgba(30,8,5,0.35)"; A.g.fillRect(x + 2, y + th * 1.1, tw - 4, 3);
        if (r() < 0.12) { A.g.fillStyle = "rgba(90,110,60,0.35)"; A.g.beginPath(); A.g.arc(x + tw * r(), y + th * 0.9, 6 + r() * 6, 0, 7); A.g.fill(); } // lichen
      }
    }
    return { a: A.c, h: H.c, ns: 2.5 };
  });
}

/** irregular dressed stone blocks (foundations, quoins, steps) */
export function stone(): TexSet {
  return make("stone", () => {
    const S = 512, A = cv(S, S), H = cv(S, S), r = rng(71), n = fbm(72, 8, 4);
    A.g.fillStyle = "#4a443c"; A.g.fillRect(0, 0, S, S); H.g.fillStyle = "#101010"; H.g.fillRect(0, 0, S, S);
    const rows = 5, rh = S / rows;
    for (let q = 0; q < rows; q++) {
      let x = -r() * 60;
      while (x < S) {
        const w = 70 + r() * 90, y = q * rh, tone = 0.75 + r() * 0.3;
        const c = new THREE.Color().setRGB(0.66 * tone, 0.62 * tone, 0.56 * tone);
        A.g.fillStyle = "#" + c.getHexString();
        const rr = 10;
        const box = (g: G, inset: number) => { g.beginPath(); (g as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(x + inset, y + inset, w - 2 * inset, rh - 2 * inset, rr); g.fill(); };
        box(A.g, 3);
        const hg = H.g.createRadialGradient(x + w / 2, y + rh / 2, 4, x + w / 2, y + rh / 2, w * 0.7);
        hg.addColorStop(0, "#f0f0f0"); hg.addColorStop(1, "#909090"); H.g.fillStyle = hg; box(H.g, 3);
        x += w;
      }
    }
    pass(A.g, (x, y, d, i) => { const k = 0.85 + 0.3 * (n(x / S, y / S) - 0.5); d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; });
    pass(H.g, (x, y, d, i) => { const k = n((x / S * 4) % 1, (y / S * 4) % 1); d[i] = Math.min(255, d[i] * (0.85 + 0.3 * k)); d[i + 1] = d[i + 2] = d[i]; });
    return { a: A.c, h: H.c, ns: 3 };
  });
}

/** red brick courses (chimneys) */
export function brick(): TexSet {
  return make("brick", () => {
    const S = 256, A = cv(S, S), H = cv(S, S), r = rng(81), rows = 8, cols = 4, bh = S / rows, bw = S / cols;
    A.g.fillStyle = "#b3aa98"; A.g.fillRect(0, 0, S, S); H.g.fillStyle = "#303030"; H.g.fillRect(0, 0, S, S);
    for (let q = 0; q < rows; q++) for (let c = -1; c <= cols; c++) {
      const x = c * bw + (q % 2) * bw / 2, y = q * bh, t = 0.75 + r() * 0.35;
      A.g.fillStyle = `rgb(${170 * t},${78 * t},${58 * t})`; A.g.fillRect(x + 3, y + 3, bw - 6, bh - 6);
      H.g.fillStyle = "#c8c8c8"; H.g.fillRect(x + 3, y + 3, bw - 6, bh - 6);
    }
    return { a: A.c, h: H.c, ns: 2.5 };
  });
}

/** poured concrete panels with seams, stains, pits (beige; tint) */
export function concrete(): TexSet {
  return make("concrete", () => {
    const S = 512, A = cv(S, S), H = cv(S, S), r = rng(91), n = fbm(92, 4, 5), n2 = fbm(93, 32, 2);
    pass(A.g, (x, y, d, i) => {
      const u = x / S, v = y / S, k = 0.82 + 0.16 * n(u, v) + 0.06 * n2(u, v);
      d[i] = 236 * k; d[i + 1] = 226 * k; d[i + 2] = 204 * k; d[i + 3] = 255;
    });
    pass(H.g, (x, y, d, i) => { d[i] = d[i + 1] = d[i + 2] = 140 + 40 * n2(x / S, y / S); d[i + 3] = 255; });
    // panel seams (2x2 panels per tile)
    for (const p of [0, S / 2]) {
      A.g.fillStyle = "rgba(70,60,50,0.55)"; A.g.fillRect(p, 0, 3, S); A.g.fillRect(0, p, S, 3);
      H.g.fillStyle = "#303030"; H.g.fillRect(p, 0, 3, S); H.g.fillRect(0, p, S, 3);
    }
    // water stains running down from the seams
    for (let k = 0; k < 26; k++) {
      const x = r() * S, y = (r() < 0.5 ? 0 : S / 2) + 3, L = 40 + r() * 160, w = 6 + r() * 30;
      const gr = A.g.createLinearGradient(0, y, 0, y + L); gr.addColorStop(0, "rgba(80,70,55,0.35)"); gr.addColorStop(1, "rgba(80,70,55,0)");
      A.g.fillStyle = gr; A.g.fillRect(x, y, w, L);
    }
    for (let k = 0; k < 120; k++) { const x = r() * S, y = r() * S, s = 1 + r() * 2.5; A.g.fillStyle = "rgba(60,55,45,0.6)"; A.g.beginPath(); A.g.arc(x, y, s, 0, 7); A.g.fill(); H.g.fillStyle = "#404040"; H.g.beginPath(); H.g.arc(x, y, s, 0, 7); H.g.fill(); }
    return { a: A.c, h: H.c, ns: 1.6 };
  });
}

/** square concrete pavers with grassy gaps */
export function pavers(): TexSet {
  return make("pavers", () => {
    const S = 512, A = cv(S, S), H = cv(S, S), r = rng(101), n = fbm(102, 8, 4), N = 4, p = S / N;
    A.g.fillStyle = "#5d6b3a"; A.g.fillRect(0, 0, S, S); H.g.fillStyle = "#000"; H.g.fillRect(0, 0, S, S);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const t = 0.8 + r() * 0.25, x = i * p, y = j * p;
      A.g.fillStyle = `rgb(${205 * t},${198 * t},${182 * t})`; A.g.fillRect(x + 4, y + 4, p - 8, p - 8);
      H.g.fillStyle = "#c0c0c0"; H.g.fillRect(x + 4, y + 4, p - 8, p - 8);
      if (r() < 0.3) { A.g.strokeStyle = "rgba(60,55,45,0.6)"; A.g.lineWidth = 1.5; A.g.beginPath(); A.g.moveTo(x + 4 + r() * p, y + 4); A.g.lineTo(x + r() * p, y + p - 4); A.g.stroke(); }
    }
    pass(A.g, (x, y, d, i) => { const k = 0.85 + 0.3 * (n(x / S, y / S) - 0.5); d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; });
    return { a: A.c, h: H.c, ns: 2.5 };
  });
}

/** painted metal with scratches + chips (near white → tint). For vehicles, drums, rails, tower cab. */
export function paintedMetal(): TexSet {
  return make("pmetal", () => {
    const S = 512, A = cv(S, S), H = cv(S, S), r = rng(111), n = fbm(112, 4, 4);
    pass(A.g, (x, y, d, i) => { const k = 0.9 + 0.1 * n(x / S, y / S); d[i] = 250 * k; d[i + 1] = 248 * k; d[i + 2] = 244 * k; d[i + 3] = 255; });
    H.g.fillStyle = "#808080"; H.g.fillRect(0, 0, S, S);
    for (let k = 0; k < 140; k++) {
      const x = r() * S, y = r() * S, a = r() * Math.PI, L = 6 + r() * 40;
      A.g.strokeStyle = `rgba(140,130,120,${0.15 + r() * 0.2})`; A.g.lineWidth = 0.8;
      A.g.beginPath(); A.g.moveTo(x, y); A.g.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); A.g.stroke();
    }
    // soft paint wear: faint lighter scuffs along scratch clusters (no dark pits)
    for (let k = 0; k < 18; k++) {
      const x = r() * S, y = r() * S, s = 10 + r() * 26;
      const gr = A.g.createRadialGradient(x, y, 0, x, y, s); gr.addColorStop(0, "rgba(150,140,128,0.18)"); gr.addColorStop(1, "rgba(150,140,128,0)");
      A.g.fillStyle = gr; A.g.fillRect(x - s, y - s, s * 2, s * 2);
    }
    const R = cv(S, S), ad = A.g.getImageData(0, 0, S, S).data;
    pass(R.g, (x, y, d, i) => { const dark = 255 - ad[i]; d[i] = d[i + 1] = d[i + 2] = 90 + dark * 0.8; d[i + 3] = 255; });
    return { a: A.c, h: H.c, ns: 1.2, r: R.c };
  });
}

/** coarse grey-brown rock with vertical joints, fractures, lichen. Box-projected on cliff columns / boulders. */
export function rock(): TexSet {
  return make("rock", () => {
    const S = 1024, A = cv(S, S), H = cv(S, S), r = rng(121), n = fbm(122, 4, 6), n2 = fbm(123, 16, 3);
    pass(A.g, (x, y, d, i) => {
      const u = x / S, v = y / S, m = n(u, v), f = n2(u, v), strata = 0.5 + 0.5 * Math.sin((v * 9 + m * 1.5) * Math.PI * 2);
      const k = 0.62 + 0.3 * m + 0.1 * f + 0.06 * strata;
      d[i] = 172 * k; d[i + 1] = 160 * k; d[i + 2] = 142 * k; d[i + 3] = 255;
    });
    pass(H.g, (x, y, d, i) => { const u = x / S, v = y / S; d[i] = d[i + 1] = d[i + 2] = 60 + 150 * n(u, v) + 40 * n2(u, v); d[i + 3] = 255; });
    // vertical joints + branching fractures
    for (let k = 0; k < 34; k++) {
      let x = r() * S, y = r() * S * 0.2; const L = S * (0.2 + r() * 0.8);
      A.g.strokeStyle = "rgba(35,30,25,0.75)"; H.g.strokeStyle = "#000"; A.g.lineWidth = H.g.lineWidth = 1.5 + r() * 3;
      A.g.beginPath(); H.g.beginPath(); A.g.moveTo(x, y); H.g.moveTo(x, y);
      for (let t = 0; t < L; t += 24) { x += (r() - 0.5) * 14; y += 24; A.g.lineTo(x, y); H.g.lineTo(x, y); }
      A.g.stroke(); H.g.stroke();
    }
    for (let k = 0; k < 60; k++) {
      let x = r() * S, y = r() * S;
      A.g.strokeStyle = "rgba(40,35,30,0.5)"; A.g.lineWidth = 1; H.g.strokeStyle = "#202020"; H.g.lineWidth = 1;
      A.g.beginPath(); H.g.beginPath(); A.g.moveTo(x, y); H.g.moveTo(x, y);
      for (let t = 0; t < 5; t++) { x += (r() - 0.5) * 50; y += (r() - 0.3) * 30; A.g.lineTo(x, y); H.g.lineTo(x, y); }
      A.g.stroke(); H.g.stroke();
    }
    // lichen + moss flecks
    for (let k = 0; k < 160; k++) {
      const x = r() * S, y = r() * S, s = 3 + r() * 14, moss = r() < 0.5;
      A.g.fillStyle = moss ? `rgba(92,120,52,${0.25 + r() * 0.3})` : `rgba(210,200,160,${0.2 + r() * 0.25})`;
      A.g.beginPath(); A.g.ellipse(x, y, s, s * 0.7, r() * 3, 0, 7); A.g.fill();
    }
    return { a: A.c, h: H.c, ns: 2.8 };
  });
}

/** dark asphalt: aggregate, tar patches, polygonal crack network with weeds (runway) */
export function asphalt(): TexSet {
  return make("asphalt", () => {
    const S = 1024, A = cv(S, S), H = cv(S, S), r = rng(131), n = fbm(132, 4, 5), n2 = fbm(133, 64, 2);
    pass(A.g, (x, y, d, i) => {
      const u = x / S, v = y / S, m = n(u, v), f = n2(u, v);
      const k = 0.5 + 0.35 * m + 0.25 * f;
      d[i] = 78 * k; d[i + 1] = 76 * k; d[i + 2] = 74 * k; d[i + 3] = 255;
    });
    pass(H.g, (x, y, d, i) => { d[i] = d[i + 1] = d[i + 2] = 150 + 70 * (n2(x / S, y / S) - 0.5); d[i + 3] = 255; });
    // light aggregate specks
    for (let k = 0; k < 9000; k++) { const x = r() * S, y = r() * S; A.g.fillStyle = `rgba(170,165,155,${0.15 + r() * 0.3})`; A.g.fillRect(x, y, 1 + r() * 1.5, 1 + r() * 1.5); }
    // tar repair patches
    for (let k = 0; k < 7; k++) { const x = r() * S, y = r() * S, w = 60 + r() * 200, h = 40 + r() * 120; A.g.fillStyle = "rgba(20,20,22,0.55)"; A.g.fillRect(x, y, w, h); }
    // crack network: jittered-grid cells joined by wobbly edges (wrapping)
    const N = 7, cell = S / N, pts: Array<[number, number]> = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) pts.push([(i + 0.2 + r() * 0.6) * cell, (j + 0.2 + r() * 0.6) * cell]);
    const P = (i: number, j: number) => { const ii = ((i % N) + N) % N, jj = ((j % N) + N) % N; const p = pts[jj * N + ii]; return [p[0] + Math.floor(i / N) * S, p[1] + Math.floor(j / N) * S]; };
    const crack = (a: number[], b: number[], w: number, weed: boolean) => {
      const segs = 6;
      for (const [g, col, lw] of [[A.g, "rgba(12,12,12,0.95)", w], [H.g, "#000", w + 1]] as Array<[G, string, number]>) {
        for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
          g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.moveTo(a[0] + ox, a[1] + oy);
          const rr = rng(Math.floor(a[0] * 7 + b[1] * 13));
          for (let s = 1; s < segs; s++) { const t = s / segs; g.lineTo(a[0] + (b[0] - a[0]) * t + (rr() - 0.5) * 16 + ox, a[1] + (b[1] - a[1]) * t + (rr() - 0.5) * 16 + oy); }
          g.lineTo(b[0] + ox, b[1] + oy); g.stroke();
        }
      }
      if (weed) {
        for (let s = 0; s < 14; s++) {
          const t = r(), x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
          for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
            A.g.fillStyle = `rgba(${150 + r() * 60},${150 + r() * 40},${40 + r() * 20},0.85)`;
            A.g.beginPath(); A.g.ellipse(x + ox + (r() - 0.5) * 6, y + oy + (r() - 0.5) * 6, 2 + r() * 4, 1.5 + r() * 3, r() * 3, 0, 7); A.g.fill();
          }
        }
      }
    };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const p = P(i, j);
      if (r() < 0.8) crack(p, P(i + 1, j), 1.5 + r() * 2, r() < 0.35);
      if (r() < 0.8) crack(p, P(i, j + 1), 1.5 + r() * 2, r() < 0.35);
      if (r() < 0.25) crack(p, P(i + 1, j + 1), 1 + r() * 1.5, false);
    }
    const R = cv(S, S);
    pass(R.g, (x, y, d, i) => { d[i] = d[i + 1] = d[i + 2] = 200 + 40 * (n2(x / S, y / S) - 0.5); d[i + 3] = 255; });
    return { a: A.c, h: H.c, ns: 2.2, r: R.c };
  });
}

/** orange-brown compacted dirt road; ruts run along V (road length). U spans the road width (0..1, edges feathered in alpha). */
export function dirtRoad(): TexSet {
  return make("dirtroad", () => {
    const W = 512, Hh = 1024, A = cv(W, Hh), H = cv(W, Hh), r = rng(141), n = fbm(142, 4, 5), n2 = fbm(143, 32, 3);
    pass(A.g, (x, y, d, i) => {
      const u = x / W, v = y / Hh, m = n(u, v), f = n2(u, v);
      // two worn tyre tracks (lighter, smoother) at u≈0.3 and 0.7
      const track = Math.exp(-(((u - 0.32) / 0.07) ** 2)) + Math.exp(-(((u - 0.68) / 0.07) ** 2));
      const k = 0.72 + 0.28 * m + 0.08 * f + 0.1 * track;
      let R = 196 * k, G = 128 * k, B = 78 * k;
      // edges darker/greener (grass creeping in)
      const e = Math.min(u, 1 - u);
      const g = Math.max(0, 1 - e / 0.12) * (0.6 + 0.4 * f);
      R = R * (1 - g) + 92 * g; G = G * (1 - g) + 110 * g; B = B * (1 - g) + 46 * g;
      d[i] = R; d[i + 1] = G; d[i + 2] = B;
      d[i + 3] = 255 * Math.min(1, Math.max(0, (e - 0.01 - 0.04 * m) / 0.08));
    });
    pass(H.g, (x, y, d, i) => {
      const u = x / W, v = y / Hh;
      const rut = -Math.exp(-(((u - 0.32) / 0.035) ** 2)) - Math.exp(-(((u - 0.68) / 0.035) ** 2));
      d[i] = d[i + 1] = d[i + 2] = 150 + 40 * rut + 50 * (n2(u, v) - 0.5); d[i + 3] = 255;
    });
    // tyre tread marks inside the ruts
    for (const cu of [0.32, 0.68]) for (let y = 0; y < Hh; y += 7) {
      const x = cu * W + (n(0.5, y / Hh) - 0.5) * 8;
      A.g.fillStyle = "rgba(100,60,35,0.35)"; A.g.fillRect(x - 12, y, 24, 2);
      H.g.fillStyle = "rgba(60,60,60,0.5)"; H.g.fillRect(x - 12, y, 24, 2);
    }
    // pebbles
    for (let k = 0; k < 700; k++) {
      const x = W * (0.06 + r() * 0.88), y = r() * Hh, s = 1 + r() * 4.5, t = 0.6 + r() * 0.5;
      A.g.fillStyle = `rgb(${190 * t},${170 * t},${150 * t})`; A.g.beginPath(); A.g.ellipse(x, y, s, s * 0.75, r() * 3, 0, 7); A.g.fill();
      A.g.fillStyle = "rgba(60,35,20,0.3)"; A.g.beginPath(); A.g.ellipse(x + s * 0.3, y + s * 0.4, s, s * 0.5, 0, 0, 7); A.g.fill();
      const hg = H.g.createRadialGradient(x, y, 0, x, y, s); hg.addColorStop(0, "#ffffff"); hg.addColorStop(1, "rgba(255,255,255,0)");
      H.g.fillStyle = hg; H.g.fillRect(x - s, y - s, 2 * s, 2 * s);
    }
    return { a: A.c, h: H.c, ns: 2.5 };
  });
}

/** compacted sandy ground with tufts (plateau, aprons) — alpha feathered by the mesh, tile */
export function sandyGround(): TexSet {
  return make("sandy", () => {
    const S = 512, A = cv(S, S), H = cv(S, S), r = rng(151), n = fbm(152, 4, 5), n2 = fbm(153, 32, 3);
    pass(A.g, (x, y, d, i) => {
      const u = x / S, v = y / S, m = n(u, v), f = n2(u, v);
      const k = 0.78 + 0.22 * m + 0.08 * f;
      d[i] = 196 * k; d[i + 1] = 180 * k; d[i + 2] = 142 * k; d[i + 3] = 255;
    });
    pass(H.g, (x, y, d, i) => { d[i] = d[i + 1] = d[i + 2] = 128 + 60 * (n2(x / S, y / S) - 0.5); d[i + 3] = 255; });
    for (let k = 0; k < 400; k++) {
      const x = r() * S, y = r() * S, s = 1 + r() * 3.5, t = 0.65 + r() * 0.5;
      A.g.fillStyle = `rgb(${200 * t},${188 * t},${170 * t})`; A.g.beginPath(); A.g.ellipse(x, y, s, s * 0.8, r() * 3, 0, 7); A.g.fill();
    }
    return { a: A.c, h: H.c, ns: 2 };
  });
}

// ------------------------------------------------------------------------------------------------ plants
/** banana leaf: V = along the leaf (0 = stalk base, 1 = tip), U across (0..1). Alpha-cut shape + torn slits. */
export function bananaLeaf(): TexSet {
  return make("bleaf", () => {
    const W = 256, Hh = 1024, A = cv(W, Hh), H = cv(W, Hh), r = rng(161), n = fbm(162, 4, 4);
    // canvas y=0 is V=1 (tip) because CanvasTexture flips Y
    const STALK = 0.2; // bottom 20% of V is petiole
    const halfW = (v: number) => {
      if (v < STALK) return 0.07 + 0.03 * (v / STALK);
      const t = (v - STALK) / (1 - STALK);
      return 0.1 + 0.4 * Math.pow(Math.sin(Math.min(1, t * 1.05) * Math.PI * 0.5 + 0.0001), 0.45) * (t > 0.82 ? Math.sqrt(Math.max(0, 1 - (t - 0.82) / 0.18)) : 1);
    };
    const tears: Array<[number, number, number]> = []; // v, side, depth
    for (let k = 0; k < 9; k++) tears.push([STALK + 0.1 + r() * 0.65, r() < 0.5 ? -1 : 1, 0.3 + r() * 0.65]);
    pass(A.g, (x, y, d, i) => {
      const u = x / W, v = 1 - y / Hh, hw = halfW(v), du = u - 0.5, ad = Math.abs(du);
      let alpha = ad < hw ? 1 : 0;
      for (const [tv, side, depth] of tears) if (Math.sign(du) === side && Math.abs(v - tv) < 0.0035 && ad > hw * (1 - depth)) alpha = 0;
      const t = Math.max(0, (v - STALK) / (1 - STALK));
      const rib = Math.exp(-((du / 0.018) ** 2));
      const vein = 0.5 + 0.5 * Math.sin((v * 150 + ad * 60) * Math.PI);  // lateral veins angled toward the tip
      const edge = ad / Math.max(0.01, hw);
      const m = n(u, v);
      // colour: yellow-green midrib, rich green blade, lighter near edges, yellow-brown dry edge sometimes
      let R = 70 + 30 * m, G = 150 + 50 * m, B = 38 + 16 * m;
      R += 18 * (1 - vein) * (1 - rib); G += 10 * (1 - vein);
      R = R * (1 - rib) + 200 * rib; G = G * (1 - rib) + 215 * rib; B = B * (1 - rib) + 110 * rib;
      if (v < STALK + 0.01) { R = 150; G = 180; B = 80; }
      const dry = edge > 0.93 && t > 0.2 ? 0.6 : 0;
      R = R * (1 - dry) + 170 * dry; G = G * (1 - dry) + 150 * dry; B = B * (1 - dry) + 60 * dry;
      const light = 0.85 + 0.25 * (1 - edge) * 0 + 0.15 * t;
      d[i] = R * light; d[i + 1] = G * light; d[i + 2] = B * light; d[i + 3] = alpha * 255;
    });
    pass(H.g, (x, y, d, i) => {
      const u = x / W, v = 1 - y / Hh, du = u - 0.5, rib = Math.exp(-((du / 0.03) ** 2));
      const vein = Math.sin((v * 150 + Math.abs(du) * 60) * Math.PI);
      d[i] = d[i + 1] = d[i + 2] = 128 + 90 * rib + 22 * vein; d[i + 3] = 255;
    });
    return { a: A.c, h: H.c, ns: 2, repeat: false };
  });
}

/** fibrous banana pseudostem (U around, V up) */
export function bananaTrunk(): TexSet {
  // SMOOTH overlapping leaf sheaths — long vertical fibre streaks + dry brown streak
  // patches, nothing horizontal (the tube repeats the texture every 1.2 m up the stem: any horizontal band = a ring);
  // the base darkening lives in the vertex AO
  return make("btrunk2", () => {
    const W = 256, Hh = 512, A = cv(W, Hh), H = cv(W, Hh), n = fbm(172, 4, 4), n2 = fbm(173, 16, 3);
    pass(A.g, (x, y, d, i) => {
      const u = x / W, v = y / Hh, m = n(u, v * 0.25 % 1), st = n2(u * 1, v * 0.12 % 1);
      const fib = 0.5 + 0.5 * Math.sin(u * 72 * Math.PI * 2 / 72 * 36 + m * 5);
      const dry = Math.max(0, Math.min(1, (st - 0.55) * 4));           // vertical dry streaks
      let R = 116 + 36 * m, G = 134 + 26 * m, B = 60 + 10 * m;
      R = R * (1 - dry) + 150 * dry; G = G * (1 - dry) + 118 * dry; B = B * (1 - dry) + 70 * dry;
      const k = 0.82 + 0.18 * fib;
      d[i] = R * k; d[i + 1] = G * k; d[i + 2] = B * k; d[i + 3] = 255;
    });
    pass(H.g, (x, y, d, i) => { const u = x / W, v = y / Hh; d[i] = d[i + 1] = d[i + 2] = 128 + 50 * Math.sin(u * 36 * Math.PI * 2 / 36 * 18 + n(u, v * 0.25 % 1) * 5); d[i + 3] = 255; });
    return { a: A.c, h: H.c, ns: 1.6 };
  });
}

/** crinkled plastic (fruit bags, tarps) — near white, tint blue via material colour */
export function crinkle(): TexSet {
  return make("crinkle", () => {
    const S = 256, A = cv(S, S), H = cv(S, S), r = rng(181), n = fbm(182, 4, 4);
    H.g.fillStyle = "#808080"; H.g.fillRect(0, 0, S, S);
    for (let k = 0; k < 110; k++) {
      const x = r() * S, y = r() * S, a = (r() - 0.5) * 0.9 + Math.PI / 2, L = 20 + r() * 90;
      const x2 = x + Math.cos(a) * L, y2 = y + Math.sin(a) * L;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const gr = H.g.createLinearGradient(x + ox - 4, 0, x + ox + 4, 0);
        H.g.strokeStyle = r() < 0.5 ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)"; H.g.lineWidth = 2 + r() * 5;
        H.g.beginPath(); H.g.moveTo(x + ox, y + oy); H.g.lineTo(x2 + ox, y2 + oy); H.g.stroke(); void gr;
      }
    }
    pass(A.g, (x, y, d, i) => { const k = 0.85 + 0.15 * n(x / S, y / S); d[i] = 255 * k; d[i + 1] = 255 * k; d[i + 2] = 255 * k; d[i + 3] = 255; });
    return { a: A.c, h: H.c, ns: 3 };
  });
}

// ------------------------------------------------------------------------------------------------ decals / signage
/** stylised banana emblem (yellow crescent + dark outline + stem), transparent background */
export function bananaLogo(style: "flat" | "badge" = "flat"): TexSet {
  return make(`logo:${style}`, () => {
    const S = 512, A = cv(S, S);
    const g = A.g;
    if (style === "badge") {
      g.fillStyle = "#2b2418"; g.beginPath(); g.arc(S / 2, S / 2, S * 0.48, 0, 7); g.fill();
      g.fillStyle = "#f2c230"; g.beginPath(); g.arc(S / 2, S / 2, S * 0.44, 0, 7); g.fill();
      g.fillStyle = "#3a8f3e"; g.beginPath(); g.arc(S / 2, S / 2, S * 0.36, 0, 7); g.fill();
      g.fillStyle = "#f7e9b8"; g.font = `900 ${S * 0.085}px "Arial Black", Impact, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
      g.save(); g.translate(S / 2, S / 2);
      const txt = "BANANA CO. • BANANA CO. • ";
      for (let i = 0; i < txt.length; i++) { g.save(); g.rotate((i / txt.length) * Math.PI * 2); g.fillStyle = "#2b2418"; g.fillText(txt[i], 0, -S * 0.4); g.restore(); }
      g.restore();
    }
    // a fat bunch of three bananas fanned from one brown crown (a thin outlined crescent + a cable above it reads
    // as a smiley face): chunky fingers, dark outline, a light highlight stripe, a warm shade band and dark tips
    const cx = S * 0.54, cy = S * 0.5, sc = style === "badge" ? 0.6 : 0.95;
    g.save(); g.translate(cx, cy); g.scale(sc, sc);
    const finger = (rot: number, len: number, fat: number, bend: number) => {
      g.save(); g.rotate(rot);
      const path = () => {
        g.beginPath();
        g.moveTo(-10, -18);
        g.bezierCurveTo(len * 0.25, -fat * 1.25 - bend, len * 0.75, -fat * 1.1 - bend * 0.4, len, -bend * 0.2 - 6);
        g.quadraticCurveTo(len + 14, 2 - bend * 0.2, len - 4, 12);
        g.bezierCurveTo(len * 0.7, fat * 0.55 - bend * 0.2, len * 0.3, fat * 0.8, -10, 18);
        g.closePath();
      };
      g.lineJoin = "round"; g.strokeStyle = "#2a2110"; g.lineWidth = 16; path(); g.stroke();
      g.fillStyle = "#f6cb2a"; path(); g.fill();
      g.save(); path(); g.clip();
      g.fillStyle = "rgba(205,140,20,0.55)"; g.beginPath(); g.ellipse(len * 0.5, fat * 0.75, len * 0.62, fat * 0.55, 0, 0, 7); g.fill();
      g.fillStyle = "rgba(255,248,190,0.85)"; g.beginPath(); g.ellipse(len * 0.45, -fat * 0.62 - bend * 0.6, len * 0.36, fat * 0.2, -0.05, 0, 7); g.fill();
      g.fillStyle = "#3b2d12"; g.beginPath(); g.ellipse(len + 2, 2 - bend * 0.2, 11, 12, 0, 0, 7); g.fill();
      g.restore(); g.restore();
    };
    finger(0.05, 235, 46, 38);
    finger(0.55, 215, 42, 32);
    finger(-0.45, 212, 42, 28);
    // the crown (stem) the fingers hang from
    g.fillStyle = "#2a2110"; g.beginPath(); g.ellipse(-12, 0, 46, 40, 0, 0, 7); g.fill();
    g.fillStyle = "#6a5220"; g.beginPath(); g.ellipse(-12, 0, 36, 30, 0, 0, 7); g.fill();
    g.fillStyle = "#8a7030"; g.beginPath(); g.ellipse(-20, -8, 16, 12, 0, 0, 7); g.fill();
    g.strokeStyle = "#2a2110"; g.lineWidth = 16; g.lineCap = "round"; g.beginPath(); g.moveTo(-40, -8); g.quadraticCurveTo(-95, -20, -118, -70); g.stroke();
    g.strokeStyle = "#6a5220"; g.lineWidth = 8; g.beginPath(); g.moveTo(-40, -8); g.quadraticCurveTo(-95, -20, -118, -70); g.stroke();
    g.restore();
    return { a: A.c, repeat: false };
  });
}

/** ONE chunky outlined banana (a fanned bunch reads as an insect from the deck) — the tower +
 *  hangar mural: a fat crescent lying on its back, dark outline, a light highlight band along the top, a warm shade
 *  band along the belly, a dark stem stub + tip. Transparent background. */
export function bananaSingle(): TexSet {
  return make("logo:single2", () => {
    const S = 512, A = cv(S, S), g = A.g;
    g.save(); g.translate(S / 2, S / 2); g.rotate(-0.62);
    const path = () => {
      g.beginPath();
      // outer (convex) edge from the stem end sweeping round to the tip, then the inner (concave) edge back
      g.moveTo(-200, -40);
      g.bezierCurveTo(-190, 150, 160, 190, 205, -10);
      g.quadraticCurveTo(215, -40, 188, -44);
      g.bezierCurveTo(140, 40, -100, 40, -150, -58);
      g.quadraticCurveTo(-170, -80, -200, -40);
      g.closePath();
    };
    g.lineJoin = "round"; g.strokeStyle = "#2b2310"; g.lineWidth = 26; path(); g.stroke();
    g.fillStyle = "#f7cf2c"; path(); g.fill();
    g.save(); path(); g.clip();
    // warm shade on the belly, light band along the ridge, faint ribs
    g.fillStyle = "rgba(214,150,18,0.6)"; g.beginPath(); g.ellipse(0, 125, 230, 70, 0, 0, 7); g.fill();
    g.fillStyle = "rgba(255,247,196,0.8)"; g.beginPath(); g.ellipse(10, 40, 170, 22, 0.02, 0, 7); g.fill();
    g.strokeStyle = "rgba(160,110,20,0.45)"; g.lineWidth = 6;
    g.beginPath(); g.moveTo(-170, 10); g.bezierCurveTo(-120, 120, 120, 140, 196, -18); g.stroke();
    g.restore();
    // stem stub + dark tip
    g.fillStyle = "#2b2310"; g.beginPath(); g.ellipse(198, -26, 22, 22, 0, 0, 7); g.fill();
    g.save(); g.translate(-196, -52); g.rotate(-0.5);
    g.fillStyle = "#2b2310"; g.fillRect(-26, -40, 52, 70);
    g.fillStyle = "#7a5a22"; g.fillRect(-16, -32, 32, 56);
    g.restore();
    g.restore();
    return { a: A.c, repeat: false };
  });
}

/** control-tower console screens: a green radar scope (range rings, sweep, blips) + a nav map (coastline, runway) */
export function screens(): TexSet {
  return make("screens", () => {
    const W = 512, Hh = 256, A = cv(W, Hh), g = A.g;
    g.fillStyle = "#061a10"; g.fillRect(0, 0, W, Hh);
    // radar (left half)
    const cx = 128, cy = 128;
    g.strokeStyle = "rgba(90,255,150,0.55)"; g.lineWidth = 2;
    for (const rr of [30, 60, 90, 116]) { g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.stroke(); }
    g.beginPath(); g.moveTo(cx - 118, cy); g.lineTo(cx + 118, cy); g.moveTo(cx, cy - 118); g.lineTo(cx, cy + 118); g.stroke();
    const sw = g.createRadialGradient(cx, cy, 0, cx, cy, 118); sw.addColorStop(0, "rgba(120,255,170,0.7)"); sw.addColorStop(1, "rgba(60,255,140,0.05)");
    g.fillStyle = sw; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, 118, -0.9, -0.2); g.closePath(); g.fill();
    g.fillStyle = "#c8ffd8"; for (const [bx, by] of [[170, 80], [90, 170], [200, 150], [70, 60]]) { g.beginPath(); g.arc(bx, by, 4, 0, 7); g.fill(); }
    // map (right half)
    g.fillStyle = "#0b2a3c"; g.fillRect(262, 10, 240, 236);
    g.fillStyle = "#2f7a3a"; g.beginPath(); g.moveTo(300, 60); g.bezierCurveTo(360, 20, 460, 40, 480, 110); g.bezierCurveTo(490, 190, 400, 230, 330, 210); g.bezierCurveTo(280, 190, 270, 110, 300, 60); g.fill();
    g.strokeStyle = "#e8d890"; g.lineWidth = 3; g.stroke();
    g.strokeStyle = "#f2f2f2"; g.lineWidth = 5; g.beginPath(); g.moveTo(340, 150); g.lineTo(400, 100); g.stroke();
    g.fillStyle = "#ffcc33"; g.font = "bold 22px monospace"; g.fillText("PEEL STRIP", 318, 236);
    g.fillStyle = "rgba(255,255,255,0.08)"; for (let y = 0; y < Hh; y += 4) g.fillRect(0, y, W, 1);
    return { a: A.c, repeat: false };
  });
}

/** "BANANA CO." stencil crate side: planks + frame + stamped text. U across the side, V up. */
export function crateSide(): TexSet {
  return make("crate", () => {
    const W = 512, Hh = 320, A = cv(W, Hh), H = cv(W, Hh), r = rng(191), grain = fbm(192, 6, 4);
    const planks = 4, ph = Hh / planks;
    H.g.fillStyle = "#606060"; H.g.fillRect(0, 0, W, Hh);
    for (let q = 0; q < planks; q++) {
      const t = 0.85 + r() * 0.2;
      A.g.fillStyle = `rgb(${205 * t},${165 * t},${112 * t})`; A.g.fillRect(0, q * ph, W, ph);
      A.g.fillStyle = "rgba(50,32,18,0.8)"; A.g.fillRect(0, q * ph, W, 3);
      H.g.fillStyle = "#909090"; H.g.fillRect(0, q * ph + 3, W, ph - 3);
    }
    pass(A.g, (x, y, d, i) => { const k = 0.85 + 0.25 * grain((x / W * 0.5) % 1, (y / Hh * 3) % 1); d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; });
    // frame boards
    const fb = 34;
    for (const [x, y, w, h] of [[0, 0, W, fb], [0, Hh - fb, W, fb], [0, 0, fb, Hh], [W - fb, 0, fb, Hh]] as Array<[number, number, number, number]>) {
      A.g.fillStyle = "rgb(178,138,92)"; A.g.fillRect(x, y, w, h);
      A.g.strokeStyle = "rgba(50,32,18,0.8)"; A.g.lineWidth = 3; A.g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
      H.g.fillStyle = "#e0e0e0"; H.g.fillRect(x + 3, y + 3, w - 6, h - 6);
      for (const [nx, ny] of [[x + 10, y + 10], [x + w - 14, y + 10], [x + 10, y + h - 14], [x + w - 14, y + h - 14]]) { A.g.fillStyle = "#3a3028"; A.g.fillRect(nx, ny, 4, 4); }
    }
    // stamped text, slightly worn
    A.g.save();
    A.g.fillStyle = "rgba(40,30,22,0.9)"; A.g.font = `900 64px "Arial Black", Impact, sans-serif`; A.g.textAlign = "center"; A.g.textBaseline = "middle";
    A.g.fillText("BANANA CO.", W / 2, Hh / 2 + 4);
    A.g.globalCompositeOperation = "destination-out";
    for (let k = 0; k < 260; k++) { A.g.fillStyle = `rgba(0,0,0,${0.1 + r() * 0.15})`; A.g.fillRect(W * 0.15 + r() * W * 0.7, Hh * 0.3 + r() * Hh * 0.4, 2 + r() * 5, 2 + r() * 3); }
    A.g.restore();
    // repaint wood under the erased text holes
    const B = cv(W, Hh); B.g.drawImage(A.c, 0, 0);
    A.g.fillStyle = "rgb(190,150,100)"; A.g.fillRect(0, 0, W, Hh); A.g.drawImage(B.c, 0, 0);
    return { a: A.c, h: H.c, ns: 2, repeat: false };
  });
}

/** worn white paint strip (runway dashes / edge lines): white with chipped alpha. U across, V along. */
export function wornPaint(): TexSet {
  return make("paint", () => {
    const S = 256, A = cv(S, S), n = fbm(201, 8, 4), n2 = fbm(202, 32, 2);
    pass(A.g, (x, y, d, i) => {
      const m = n(x / S, y / S), f = n2(x / S, y / S);
      d[i] = d[i + 1] = d[i + 2] = 240; d[i + 3] = 255 * Math.min(1, Math.max(0, (m * 0.7 + f * 0.5 - 0.3) * 4));
    });
    return { a: A.c };
  });
}

/** soft radial blob for contact shadows (black, alpha falloff) */
export function blob(): TexSet {
  return make("blob", () => {
    const S = 128, A = cv(S, S), gr = A.g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, "rgba(0,0,0,1)"); gr.addColorStop(0.45, "rgba(0,0,0,0.65)"); gr.addColorStop(1, "rgba(0,0,0,0)");
    A.g.fillStyle = gr; A.g.fillRect(0, 0, S, S);
    return { a: A.c, repeat: false };
  });
}

/** additive glow sprite */
export function glow(): TexSet {
  return make("glow", () => {
    const S = 128, A = cv(S, S), gr = A.g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.2, "rgba(255,240,200,0.6)"); gr.addColorStop(0.5, "rgba(255,210,140,0.18)"); gr.addColorStop(1, "rgba(255,200,120,0)");
    A.g.fillStyle = gr; A.g.fillRect(0, 0, S, S);
    return { a: A.c, repeat: false };
  });
}

/** warm lit window glass: bright core with soft falloff + curtain silhouettes (emissive map) */
export function litWindow(): TexSet {
  return make("litwin", () => {
    const S = 128, A = cv(S, S), gr = A.g.createRadialGradient(S / 2, S * 0.6, 4, S / 2, S * 0.6, S * 0.75);
    gr.addColorStop(0, "#fff1c4"); gr.addColorStop(0.5, "#ffc566"); gr.addColorStop(1, "#b0651e");
    A.g.fillStyle = gr; A.g.fillRect(0, 0, S, S);
    A.g.fillStyle = "rgba(120,50,20,0.45)"; A.g.fillRect(0, 0, S * 0.18, S); A.g.fillRect(S * 0.82, 0, S * 0.18, S);
    return { a: A.c, repeat: false };
  });
}

/** hanging ivy curtain (alpha card): dense glossy 3–5-lobed leaves at the top thinning into hanging strands; the
 *  texture tiles horizontally (u) — v = 1 is the top (the lip) */
export function ivy(): TexSet {
  return make("ivy", () => {
    const W = 512, Hh = 1024, A = cv(W, Hh), H = cv(W, Hh), r = rng(808);
    H.g.fillStyle = "#000"; H.g.fillRect(0, 0, W, Hh);
    const leaf = (x: number, y: number, s: number, a: number, col: string) => {
      for (const [g, fill] of [[A.g, col], [H.g, "#fff"]] as Array<[G, string]>) {
        g.save(); g.translate(x, y); g.rotate(a); g.scale(s, s);
        g.fillStyle = fill; g.beginPath();
        // ivy leaf: 5 rounded lobes around a heart base
        g.moveTo(0, 0.9);
        g.quadraticCurveTo(-0.55, 0.75, -0.95, 0.15); g.quadraticCurveTo(-0.7, -0.05, -0.62, -0.35);
        g.quadraticCurveTo(-0.35, -0.3, -0.25, -0.75); g.quadraticCurveTo(0, -1.05, 0.25, -0.75);
        g.quadraticCurveTo(0.35, -0.3, 0.62, -0.35); g.quadraticCurveTo(0.7, -0.05, 0.95, 0.15);
        g.quadraticCurveTo(0.55, 0.75, 0, 0.9); g.fill();
        if (g === A.g) { g.strokeStyle = "rgba(210,235,150,0.55)"; g.lineWidth = 0.06; g.beginPath(); g.moveTo(0, 0.85); g.lineTo(0, -0.7); g.moveTo(0, 0.2); g.lineTo(-0.6, -0.1); g.moveTo(0, 0.2); g.lineTo(0.6, -0.1); g.stroke(); }
        g.restore();
      }
    };
    const greens = ["#2f6b22", "#3d7d2a", "#4a8f31", "#5aa23a", "#356f25", "#6aad45"];
    // strands: each strand starts at the top and hangs a random length, leaves alternating along it
    for (let k = 0; k < 46; k++) {
      let x = r() * W, y = -10;
      const len = Hh * (0.25 + Math.pow(r(), 0.7) * 0.75), sway = (r() - 0.5) * 0.6;
      A.g.strokeStyle = "rgba(70,60,30,0.9)"; A.g.lineWidth = 2;
      A.g.beginPath(); A.g.moveTo(x, y);
      const pts: Array<[number, number]> = [];
      while (y < len) { y += 14 + r() * 10; x += Math.sin(y * 0.02 + k) * 3 + sway * 6; pts.push([((x % W) + W) % W, y]); A.g.lineTo(((x % W) + W) % W, y); }
      A.g.stroke();
      for (const [i, [px, py]] of pts.entries()) {
        const t = py / Hh, s = (13 + r() * 9) * (1 - t * 0.45);
        leaf(px + (i % 2 ? 1 : -1) * s * 0.6, py, s, (i % 2 ? 0.7 : -0.7) + (r() - 0.5) * 0.8, greens[Math.floor(r() * greens.length)]);
        // wrap across the tile edge
        if (px < 30) leaf(px + W + (i % 2 ? 1 : -1) * s * 0.6, py, s, 0.5, greens[k % greens.length]);
        if (px > W - 30) leaf(px - W + (i % 2 ? 1 : -1) * s * 0.6, py, s, -0.5, greens[k % greens.length]);
      }
    }
    // a dense mat at the very top (the rim)
    for (let k = 0; k < 520; k++) { const y = Math.pow(r(), 2.2) * Hh * 0.22, x = r() * W; leaf(x, y, 11 + r() * 12, r() * 6.28, greens[Math.floor(r() * greens.length)]); }
    // shade: darker deeper in the mat
    pass(A.g, (x, y, d, i) => { if (d[i + 3] === 0) return; const k = 0.78 + 0.22 * Math.min(1, y / (Hh * 0.3)); d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; });
    return { a: A.c, h: H.c, ns: 2.5 };
  });
}

/** LOOKOUT yard decal (non-tiling, 1024×512 = 34 × 17 m in the cottage frame: u → local x −24…+10, v = 1 at local
 *  z −2 (the buildings) → 0 at z 15 (the fence)): worn compacted earth with a crisp noise-broken edge + grass fringe,
 *  truck tyre tracks curving round the cottage's far end, a trodden lane to the stair head, pebbles */
export function lookoutYard(): TexSet {
  return make("lookoutYard", () => {
    const W = 1024, Hh = 512, A = cv(W, Hh), H = cv(W, Hh), r = rng(4242), n1 = fbm(61, 6, 5), n2 = fbm(62, 24, 3);
    const px = (lx: number) => ((lx + 24) / 34) * W, py = (lz: number) => ((lz + 2) / 17) * Hh, s = W / 34;
    // mask: the yard in front of the buildings + the lane to the stair head (x −24…−18), noise-broken edge
    const mask = (x: number, y: number) => {
      const lx = (x / W) * 34 - 24, lz = (y / Hh) * 17 - 2;
      const yard = Math.min(lx + 21.5, 9.5 - lx, lz - 1.2, 13.2 - lz);          // metres inside the yard rect
      const lane = Math.min(lx + 25.5, -15.5 - lx, lz + 2.5, 14.5 - lz);
      const d = Math.max(yard, lane) + (n1(x / W, y / Hh) - 0.5) * 3.2 + (n2(x / W, y / Hh) - 0.5) * 0.9;
      return d;
    };
    pass(A.g, (x, y, d, i) => {
      const m = mask(x, y), a = Math.max(0, Math.min(1, m / 0.35));
      const u = x / W, v = y / Hh, k = 0.84 + 0.2 * n1(u * 2 % 1, v * 2 % 1) + 0.08 * (n2(u, v) - 0.5);
      d[i] = 184 * k; d[i + 1] = 158 * k; d[i + 2] = 116 * k; d[i + 3] = 255 * a;
    });
    H.g.fillStyle = "#808080"; H.g.fillRect(0, 0, W, Hh);
    // tyre tracks: two ruts 1.6 m apart from the truck (−0.6, 9) round the cottage's far end
    const track = (off: number) => {
      A.g.strokeStyle = "rgba(112,88,60,0.55)"; H.g.strokeStyle = "#5a5a5a";
      for (const g of [A.g, H.g]) {
        g.lineWidth = 0.28 * s; g.lineCap = "round"; g.beginPath();
        g.moveTo(px(-3), py(9.6 + off)); g.bezierCurveTo(px(4), py(9.8 + off), px(9 + off), py(8.5), px(10.5 + off), py(1)); g.stroke();
      }
    };
    track(-0.8); track(0.8);
    // trodden footpath from the tower door (≈ −12, 7) to the lane (≈ −20, 8)
    A.g.strokeStyle = "rgba(150,122,86,0.45)"; A.g.lineWidth = 1.1 * s; A.g.lineCap = "round";
    A.g.beginPath(); A.g.moveTo(px(-12), py(6.5)); A.g.quadraticCurveTo(px(-16), py(8.5), px(-21), py(9.5)); A.g.stroke();
    // pebbles + small stones
    for (let k = 0; k < 900; k++) {
      const x = r() * W, y = r() * Hh; if (mask(x, y) < 0.3) continue;
      const rr = (0.6 + Math.pow(r(), 3) * 3.2) * s / 30;
      pebble(A.g, H.g, x, y, rr, 1, 0.58 + r() * 0.3, 0.9 + r() * 0.08, r() * 3);
    }
    // grass fringe: short green blades growing over the edge
    for (let k = 0; k < 5200; k++) {
      const x = r() * W, y = r() * Hh, m = mask(x, y);
      if (m < -0.1 || m > 0.9) continue;
      const len = (0.12 + r() * 0.22) * s, a = -Math.PI / 2 + (r() - 0.5) * 1.6, g = 110 + r() * 60;
      A.g.strokeStyle = `rgba(${70 + r() * 40},${g},${30 + r() * 20},0.9)`; A.g.lineWidth = 1 + r() * 1.5;
      A.g.beginPath(); A.g.moveTo(x, y); A.g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len * 0.6); A.g.stroke();
    }
    return { a: A.c, h: H.c, ns: 2.0, repeat: false };
  });
}

/** PLANTATION dirt road (tiles along the road, v = 8 m per repeat; u = 0..1 across the ~12 m ribbon incl. its soft
 *  edges → ~84 px/m across, 128 px/m along): orange-brown compacted clay with clumpy mottling, two narrow darker
 *  tyre ruts with tread, a lighter dusty crown, dry hairline cracks, round pebbles, and a jagged alpha edge with grass
 *  blades creeping over it */
export function plRoad(): TexSet {
  return make("plRoad", () => {
    const W = 1024, Hh = 1024, A = cv(W, Hh), H = cv(W, Hh), r = rng(4401), n = fbm(4402, 4, 5), n2 = fbm(4403, 32, 3), n3 = fbm(4404, 8, 4), n4 = fbm(4405, 64, 2);
    // two ruts 1.6 m apart — the ribbons are ~8.5–9 m wide incl. their soft edges
    // soft, shallow ruts (deep ones read as two continuous black stripes from the view camera)
    const rutU = [0.41, 0.59], rw = 0.034, ASP = 128 / 84; // px per metre along / across
    const edge = (u: number, v: number) => Math.min(u, 1 - u) - 0.1 - 0.05 * (n3(u, v) - 0.5) - 0.03 * (n2(u, v) - 0.5);
    pass(A.g, (x, y, d, i) => {
      const u = x / W, v = y / Hh, m = n(u, v), f = n2(u, v), g = n4(u, v);
      const rut = Math.exp(-(((u - rutU[0]) / rw) ** 2)) + Math.exp(-(((u - rutU[1]) / rw) ** 2));
      const worn = Math.exp(-(((u - rutU[0]) / (rw * 3)) ** 2)) + Math.exp(-(((u - rutU[1]) / (rw * 3)) ** 2));
      const crown = Math.exp(-(((u - 0.5) / 0.09) ** 2));
      const k = 0.78 + 0.24 * m + 0.12 * (f - 0.5) + 0.1 * (g - 0.5);
      let R = 192 * k, G = 142 * k, B = 92 * k; // lighter sun-baked ochre (target road ≈ #cc8d4b lit)
      R += crown * 12 + worn * 6; G += crown * 12 + worn * 5; B += crown * 10 + worn * 4;
      R *= 1 - 0.16 * rut; G *= 1 - 0.19 * rut; B *= 1 - 0.18 * rut;
      d[i] = R; d[i + 1] = G; d[i + 2] = B;
      d[i + 3] = 255 * Math.max(0, Math.min(1, edge(u, v) / 0.025));
    });
    pass(H.g, (x, y, d, i) => {
      const u = x / W, v = y / Hh;
      const rut = Math.exp(-(((u - rutU[0]) / (rw * 0.9)) ** 2)) + Math.exp(-(((u - rutU[1]) / (rw * 0.9)) ** 2));
      d[i] = d[i + 1] = d[i + 2] = 160 - 55 * rut + 40 * (n2(u, v) - 0.5) + 30 * (n4(u, v) - 0.5); d[i + 3] = 255;
    });
    // tread chevrons in the ruts (tile-safe along v)
    for (const cu of rutU) for (let y = 0; y < Hh; y += 11) {
      const x = cu * W;
      for (const [g, col] of [[A.g, "rgba(95,55,30,0.22)"], [H.g, "rgba(70,70,70,0.55)"]] as Array<[G, string]>) {
        g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(x - 14, y); g.lineTo(x, y + 5); g.lineTo(x + 14, y); g.stroke();
      }
    }
    // dry hairline cracks
    A.g.strokeStyle = "rgba(118,76,44,0.3)"; A.g.lineWidth = 1;
    for (let k = 0; k < 70; k++) {
      let x = W * (0.15 + r() * 0.7), y = r() * Hh; A.g.beginPath(); A.g.moveTo(x, y);
      for (let s2 = 0; s2 < 5; s2++) { x += (r() - 0.5) * 26; y += (r() - 0.5) * 36; A.g.lineTo(x, y); }
      A.g.stroke();
    }
    // pebbles: round in world space (ellipse ry = rx × ASP)
    for (let k = 0; k < 1600; k++) {
      const u = 0.09 + r() * 0.82, rut = Math.min(Math.abs(u - rutU[0]), Math.abs(u - rutU[1])) < rw * 1.5;
      if (rut && r() < 0.85) continue;
      const x = u * W, y = r() * Hh, sz = 0.9 + Math.pow(r(), 2.6) * 4.5, t = 0.62 + r() * 0.45;
      for (const oy of [-Hh, 0, Hh]) {
          pebble(A.g, H.g, x, y + oy, sz, ASP, t * 0.72, 0.9, 0);
      }
    }
    // grass blades over the edges
    for (let k = 0; k < 4200; k++) {
      const side = r() < 0.5, u = side ? 0.04 + r() * 0.1 : 0.86 + r() * 0.1, y = r() * Hh, x = u * W;
      const e = edge(u, y / Hh); if (e > 0.035 || e < -0.05) continue;
      const len = 8 + r() * 16, a = (side ? 0.15 : Math.PI - 0.15) + (r() - 0.5) * 1.4, gcol = 105 + r() * 60;
      A.g.strokeStyle = `rgba(${60 + r() * 40},${gcol},${24 + r() * 20},0.95)`; A.g.lineWidth = 1.2 + r() * 1.5;
      A.g.beginPath(); A.g.moveTo(x, y); A.g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len * ASP); A.g.stroke();
    }
    return { a: A.c, h: H.c, ns: 2.4 };
  });
}

/** PLANTATION yard in front of the packing house (non-tiling, barn-local x −30…+16 (46 m) → u, z −2…+22 (24 m) → v
 *  from 1 (the barn) to 0): compacted orange dirt, tyre tracks from the road hub to the dock + round the crates, a
 *  darker oily patch by the conveyor foot, pebbles, crisp noise-broken edge with a grass fringe */
export function plYard(): TexSet {
  return make("plYard", () => {
    const W = 2048, Hh = 1024, A = cv(W, Hh), H = cv(W, Hh), r = rng(4501), n1 = fbm(4502, 6, 5), n2 = fbm(4503, 48, 3), n4 = fbm(4504, 96, 2);
    const X0 = -30, X1 = 16, Z0 = -2, Z1 = 22, s = W / (X1 - X0);
    const px = (x: number) => ((x - X0) / (X1 - X0)) * W, py = (z: number) => ((z - Z0) / (Z1 - Z0)) * Hh;
    const mask = (x: number, y: number) => {
      const lx = X0 + (x / W) * (X1 - X0), lz = Z0 + (y / Hh) * (Z1 - Z0);
      // an L: the full width by the house, narrower toward the road (the rows come up to the hero road's verge)
      const main = Math.max(Math.min(lx + 26, 14 - lx, lz + 1, 8.5 - lz), Math.min(lx + 16.5, 14 - lx, lz + 1, 21 - lz));
      const d = main + (n1(x / W, y / Hh) - 0.5) * 3.4 + (n2(x / W, y / Hh) - 0.5) * 1.0;
      return d;
    };
    pass(A.g, (x, y, d, i) => {
      const m = mask(x, y), a = Math.max(0, Math.min(1, m / 0.3));
      const u = x / W, v = y / Hh, k = 0.8 + 0.24 * n1(u * 2 % 1, v * 2 % 1) + 0.12 * (n2(u, v) - 0.5) + 0.1 * (n4(u, v) - 0.5);
      d[i] = 178 * k; d[i + 1] = 134 * k; d[i + 2] = 90 * k; d[i + 3] = 255 * a;
    });
    H.g.fillStyle = "#909090"; H.g.fillRect(0, 0, W, Hh);
    const track = (pts: Array<[number, number]>, off: number, alpha = 0.45) => {
      for (const [g, col, lw] of [[A.g, `rgba(128,80,48,${alpha})`, 0.3], [H.g, "#5a5a5a", 0.26]] as Array<[G, string, number]>) {
        g.strokeStyle = col; g.lineWidth = lw * s; g.lineCap = "round"; g.beginPath();
        pts.forEach(([x, z], k) => { const X = px(x + off * 0.3), Z = py(z + off); if (k) g.lineTo(X, Z); else g.moveTo(X, Z); });
        g.stroke();
      }
    };
    // the road along the yard's front edge (z ≈ 22) → the dock (4.6, 6) and → the conveyor foot (−22, 4)
    for (const o of [-0.85, 0.85]) {
      track([[8, 23], [5.5, 16], [4.6, 11], [4.4, 7]], o);
      track([[-14, 23], [-17, 15], [-20, 10], [-22, 6.5]], o, 0.38);
    }
    // oily / wet patch at the conveyor foot + under the crate pallets
    for (const [x, z, rr] of [[-22, 3.5, 2.2], [-11, 5, 1.6], [2, 9, 1.4], [8.6, 6, 1.5]] as Array<[number, number, number]>) {
      const gr = A.g.createRadialGradient(px(x), py(z), 0, px(x), py(z), rr * s); gr.addColorStop(0, "rgba(90,55,32,0.4)"); gr.addColorStop(1, "rgba(90,55,32,0)");
      A.g.fillStyle = gr; A.g.fillRect(px(x) - rr * s, py(z) - rr * s, 2 * rr * s, 2 * rr * s);
    }
    for (let k = 0; k < 5200; k++) {
      const x = r() * W, y = r() * Hh; if (mask(x, y) < 0.2) continue;
      const rr = (0.5 + Math.pow(r(), 3) * 3.5) * s / 34;
      pebble(A.g, H.g, x, y, rr, 1, 0.56 + r() * 0.3, 0.88 + r() * 0.08, r() * 3);
    }
    for (let k = 0; k < 16000; k++) {
      const x = r() * W, y = r() * Hh, m = mask(x, y);
      if (m < -0.15 || m > 0.8) continue;
      const len = (0.12 + r() * 0.25) * s, a = -Math.PI / 2 + (r() - 0.5) * 1.8, g = 105 + r() * 60;
      A.g.strokeStyle = `rgba(${60 + r() * 40},${g},${24 + r() * 20},0.92)`; A.g.lineWidth = 1 + r() * 1.5;
      A.g.beginPath(); A.g.moveTo(x, y); A.g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len * 0.6); A.g.stroke();
    }
    return { a: A.c, h: H.c, ns: 2.0, repeat: false };
  });
}

/** crinkled translucent plastic (fruit bags): long soft vertical folds + a few creases, no hard strokes */
export function bagCrinkle(): TexSet {
  return make("bagCrinkle", () => {
    const S = 256, A = cv(S, S), H = cv(S, S), n = fbm(4601, 6, 4), n2 = fbm(4602, 16, 3), r = rng(4603);
    pass(H.g, (x, y, d, i) => {
      const u = x / S, v = y / S;
      const folds = Math.sin((u * 7 + n(u, v) * 1.6) * Math.PI * 2) * 0.5 + Math.sin((u * 13 + n2(u, v) * 0.8) * Math.PI * 2) * 0.22;
      d[i] = d[i + 1] = d[i + 2] = 128 + 60 * folds + 20 * (n2(u, v) - 0.5); d[i + 3] = 255;
    });
    for (let k = 0; k < 26; k++) {
      const x = r() * S, y = r() * S, a = (r() - 0.5) * 2.4, L = 10 + r() * 30;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { H.g.strokeStyle = "rgba(210,210,210,0.35)"; H.g.lineWidth = 1.5; H.g.beginPath(); H.g.moveTo(x + ox, y + oy); H.g.lineTo(x + ox + Math.cos(a) * L, y + oy + Math.sin(a) * L); H.g.stroke(); }
    }
    pass(A.g, (x, y, d, i) => { const k = 0.9 + 0.1 * n(x / S, y / S); d[i] = d[i + 1] = d[i + 2] = 255 * k; d[i + 3] = 255; });
    return { a: A.c, h: H.c, ns: 2.2 };
  });
}

export { hex, shade, mix };
