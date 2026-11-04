// Gaussian-splat bake cache (IndexedDB): a species' splat levels are a pure function of its geometry, its materials'
// colours / textures and the bake options — a returning player skips the GPU capture and the clustering (~2–5 s of
// the first load). The key is a signature of all of those (+ SPLAT_BAKE_VERSION, bumped when the bake changes); any
// failure (private mode, quota, blocked storage) just means "no cache".
import * as THREE from "three";
import type { Species } from "./species/types";
import type { SplatBuildOutput } from "./splat-build";
import { VEG_DRY_V } from "./foliage-material";
import { flag } from "../../flags";

// v6: captures use physical atlas texels at every DPR. Discard v5 bakes corrupted on scaled displays.
export const SPLAT_BAKE_VERSION = 6;
const DB = "kr-veg-splats", STORE = "bake";
const OFF = !flag("splcache");

let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (OFF || typeof indexedDB === "undefined") return Promise.resolve(null);
  dbp ??= new Promise((res) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore(STORE); } catch { /* exists */ } };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}

export async function cacheGet(key: string): Promise<SplatBuildOutput | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((res) => {
    try {
      const q = d.transaction(STORE, "readonly").objectStore(STORE).get(key);
      q.onsuccess = () => { const v = q.result as SplatBuildOutput | undefined; res(v && v.data instanceof Float32Array ? v : null); };
      q.onerror = () => res(null);
    } catch { res(null); }
  });
}

export async function cachePut(key: string, out: SplatBuildOutput): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((res) => {
    try {
      const t = d.transaction(STORE, "readwrite");
      t.objectStore(STORE).put({ ...out, data: out.data.slice() }, key);
      t.oncomplete = () => res(); t.onerror = () => res(); t.onabort = () => res();
    } catch { res(); }
  });
}

const sigCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
/** a texture's identity: its source + an 8×8 thumbnail of its pixels */
function texSig(t: THREE.Texture | null | undefined): string {
  if (!t) return "-";
  const img = t.image as (HTMLImageElement & HTMLCanvasElement) | undefined;
  if (!img) return "noimg";
  let s = `${img.src ?? "canvas"}:${img.naturalWidth ?? img.width}x${img.naturalHeight ?? img.height}`;
  try {
    if (sigCanvas) {
      sigCanvas.width = sigCanvas.height = 8;
      const c = sigCanvas.getContext("2d", { willReadFrequently: true })!;
      c.clearRect(0, 0, 8, 8); c.drawImage(img, 0, 0, 8, 8);
      const d = c.getImageData(0, 0, 8, 8).data;
      let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) >>> 0;
      s += `:${h.toString(36)}`;
    }
  } catch { /* tainted / not decoded: source only */ }
  return s;
}

const geoSig = (g: THREE.BufferGeometry | undefined): string => {
  if (!g?.attributes.position) return "0";
  const p = g.attributes.position.array as ArrayLike<number>, c = g.attributes.color?.array as ArrayLike<number> | undefined;
  let h = 0;
  const step = Math.max(1, Math.floor(p.length / 512));
  for (let i = 0; i < p.length; i += step) h = (h * 31 + Math.round(p[i] * 1000)) >>> 0;
  if (c) for (let i = 0; i < c.length; i += step) h = (h * 31 + Math.round(c[i] * 1000)) >>> 0;
  return `${p.length}:${g.index?.count ?? 0}:${h.toString(36)}`;
};

/** the cache key of one species' bake */
export function splatKey(sp: Species, opts: unknown): string {
  const parts = sp.parts.map((pt) => {
    const m = pt.mats.mat;
    const u = m.userData.veg as Record<string, { value: unknown }> | undefined;
    const uv = u ? Object.keys(u).sort().map((k) => { const v = u[k].value; return typeof v === "number" ? v.toFixed(3) : (v as THREE.Color)?.getHexString?.() ?? ""; }).join(",") : "";
    // (the dry-margin bake shader's version, only on the materials that carry it)
    const dry = m.userData.vegSenesce ? `|dry${VEG_DRY_V}` : "";
    return `${pt.name}|${geoSig(pt.bake ?? pt.lod0)}|${geoSig(pt.lod1)}|${m.color.getHexString()}|${m.alphaTest}|${texSig(m.map)}|${uv}${dry}`;
  }).join(";");
  return `v${SPLAT_BAKE_VERSION}|${sp.id}|${JSON.stringify(opts)}|${sp.boundR.toFixed(3)}|${parts}`;
}
