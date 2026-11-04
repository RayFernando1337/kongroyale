// Detail-cell generation (grass, ferns, flowers, ground cover) — pure TS, no three.js: runs in the detail worker
// (detail-worker.ts) during play, and on the main thread for view-camera screenshots / the first fill. One cell → one
// block per species variant: pre-composed instance matrices + tints, sorted by a random threshold (keeping the first k
// of a block = thinning by k/n; the rank is also encoded in the tint for the shader's per-plant shrink), plus the
// cell's vertical bounds for frustum culling.
import { detailCell, VARIANTS, jungleTreeShape, palmShape, type VegKind, type VegInstance, type Clearing, type ScatterEnv } from "../../../../shared/world/veg-scatter";
import type { Terrain } from "../../../../shared/world/terrain";
import { Simplex2 } from "../../../../shared/world/noise";
import { Biome, WORLD } from "../../../../shared/world/map";
import { flag } from "../../flags";

/** column-major world matrix for (position, yaw about +Y, uniform scale) — three.js makeRotationY convention */
export function writeMatrix(out: Float32Array, o: number, x: number, y: number, z: number, yaw: number, s: number) {
  const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s;
  out[o] = c; out[o + 1] = 0; out[o + 2] = -sn; out[o + 3] = 0;
  out[o + 4] = 0; out[o + 5] = s; out[o + 6] = 0; out[o + 7] = 0;
  out[o + 8] = sn; out[o + 9] = 0; out[o + 10] = c; out[o + 11] = 0;
  out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
}


/** writeMatrix whose model y = 0 plane follows the terrain slope (gx = dh/dx, gz = dh/dz) with the model's up axis kept
 * vertical — a shear: lawn cards stand upright and their feet lie ON a sloped ground instead of crossing it in
 * a straight line */
export function writeMatrixSheared(out: Float32Array, o: number, x: number, y: number, z: number, yaw: number, s: number, gx: number, gz: number) {
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  out[o] = c * s; out[o + 1] = (gx * c - gz * sn) * s; out[o + 2] = -sn * s; out[o + 3] = 0;
  out[o + 4] = 0; out[o + 5] = s; out[o + 6] = 0; out[o + 7] = 0;
  out[o + 8] = sn * s; out[o + 9] = (gx * sn + gz * c) * s; out[o + 10] = c * s; out[o + 11] = 0;
  out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
}

export const hash01 = (x: number, z: number) => { const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); };

/** per-kind tint amplitude (brightness, hue) — trees vary most so the canopy never reads as one flat green */
const TINT_AMP: Partial<Record<VegKind, [number, number]>> = {
  "jungle-tree": [1.9, 2.6], palm: [1.2, 1.3], "palm-leaning": [1.2, 1.3], bush: [1.4, 1.6], mangrove: [1.3, 1.4],
  "banana-plant": [1.1, 1.2], monstera: [1.1, 1.0], grass: [0.8, 0.9], groundcover: [0.9, 0.8], log: [0.6, 0.3],
};

/** per-plant banana tint families + the leaves' dry-edge ramp
 * (foliage-material VEG_SENESCE). `?bananatint=0` = the previous look (A/B) */
export const BANANA_TINT = flag("bananatint");

export class Tinter {
  private hue = new Simplex2(WORLD.SEED + 202);
  constructor(private terrain: Terrain) {}
  /** brightness + hue jitter, a low-frequency hue drift (canopy patches) and a biome cast */
  tint(kind: VegKind, x: number, z: number, out: Float32Array, o: number) {
    const [ab, ah] = TINT_AMP[kind] ?? [1, 1];
    const r1 = hash01(x, z), r2 = hash01(z, x);
    const drift = this.hue.fbm(x / 170, z / 170, 2);
    let b = 1 + (r1 - 0.45) * 0.24 * ab + drift * 0.06 * ab;
    let h = (r2 - 0.5) * 0.13 * ah + drift * 0.09 * ah;
    const bio = this.terrain.biomeAt(x, z);
    if (bio === Biome.Grass) { if (kind !== "grass") h += 0.05; b *= 1.03; } else if (bio === Biome.Beach) { h += 0.03; b *= 1.05; } else if (bio === Biome.Lagoon) { h -= 0.04; b *= 0.94; }
    // palms vary (no uniform lime carpet): a third of the palms
    // carry an older, deeper blue-green crown
    if ((kind === "palm" || kind === "palm-leaning") && hash01(x * 1.7 + 11.3, z * 0.9 - 4.1) < 0.33) { b *= 0.8; h -= 0.06; }
    // broadleaf crowns come in families so the hue varies tree to tree — a third
    // warmer olive-yellow, a fifth deeper blue-green, the rest the base green (5–10 % hue on top of the jitter)
    if (kind === "jungle-tree" || kind === "bush") { const f = hash01(x * 0.61 + 7.7, z * 1.3 - 2.9); if (f < 0.33) { h += 0.09; b *= 1.04; } else if (f > 0.8) { h -= 0.08; b *= 0.9; } }
    // a small random tint per plant stops the bananas all matching: banana plants come in
    // families too — a third sunnier yellow-green, a fifth deeper blue-green — plus their own value jitter; the tint
    // rides instanceColor into the mesh tiers AND the splat / impostor bank (same three floats), so far plants keep it
    if (kind === "banana-plant" && BANANA_TINT) {
      const f = hash01(x * 0.83 - 5.3, z * 1.21 + 9.7);
      if (f < 0.33) { h += 0.1; b *= 1.05; } else if (f > 0.78) { h -= 0.08; b *= 0.88; }
      h += (hash01(z * 1.37 + 2.1, x * 0.71 - 8.3) - 0.5) * 0.06;
      b *= 1 + (hash01(x * 1.91 + 0.7, z * 0.57 + 3.3) - 0.5) * 0.16;
    }
    b = Math.min(1.25, Math.max(0.72, b));
    out[o] = b * (1 + h); out[o + 1] = b * (1 + h * 0.25); out[o + 2] = b * (1 - h);
  }
}

/**
 * Canopy coverage on a 4 m grid (without it the jungle interior is lit like an open park): every crown adds a disc
 * of its opacity; a plant's ambient occlusion comes from the coverage above it (trees count only their neighbours).
 * Encoded into instanceColor.r as 8·(1 + round(occ·30)) (foliage-material V_COLOR decodes it; the shader scales the
 * plant's ambient / fill by 1 − occ, the sun term keeps its shadow-map dapples).
 */
export class CanopyGrid {
  static readonly C = 4;
  readonly n: number;
  readonly cov: Float32Array;
  constructor(cov?: Float32Array) { this.n = Math.ceil((2 * WORLD.HALF) / CanopyGrid.C); this.cov = cov ?? new Float32Array(this.n * this.n); }
  /** crown disc of a collidable plant (radius, opacity, centre offset) — null for kinds without a crown */
  static crown(p: VegInstance): { x: number; z: number; r: number; w: number } | null {
    const S = p.scale;
    if (p.kind === "jungle-tree") return { x: p.x, z: p.z, r: jungleTreeShape(p.variant % 5).rx * S * 0.95, w: 1 };
    if (p.kind === "mangrove") return { x: p.x, z: p.z, r: 3.2 * S, w: 0.8 };
    if (p.kind === "bamboo") return { x: p.x, z: p.z, r: 1.8 * S, w: 0.45 };
    if (p.kind === "palm" || p.kind === "palm-leaning") {
      const sh = palmShape(p.variant % 3, p.kind === "palm-leaning"), t = sh.pts[sh.pts.length - 1], c = Math.cos(p.yaw), sn = Math.sin(p.yaw);
      return { x: p.x + (t[0] * c + t[2] * sn) * S, z: p.z + (-t[0] * sn + t[2] * c) * S, r: 4.6 * S, w: 0.42 };
    }
    return null;
  }
  add(p: VegInstance, sign = 1) {
    const cr = CanopyGrid.crown(p); if (!cr) return;
    const C = CanopyGrid.C, H = WORLD.HALF, n = this.n;
    const i0 = Math.max(0, Math.floor((cr.z - cr.r + H) / C)), i1 = Math.min(n - 1, Math.floor((cr.z + cr.r + H) / C));
    const j0 = Math.max(0, Math.floor((cr.x - cr.r + H) / C)), j1 = Math.min(n - 1, Math.floor((cr.x + cr.r + H) / C));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const dx = -H + (j + 0.5) * C - cr.x, dz = -H + (i + 0.5) * C - cr.z, d2 = (dx * dx + dz * dz) / (cr.r * cr.r);
      if (d2 < 1) this.cov[i * n + j] += sign * cr.w * (1 - d2 * d2);
    }
  }
  at(x: number, z: number): number {
    const C = CanopyGrid.C, H = WORLD.HALF, n = this.n;
    const fx = (x + H) / C - 0.5, fz = (z + H) / C - 0.5;
    const j = Math.min(n - 2, Math.max(0, Math.floor(fx))), i = Math.min(n - 2, Math.max(0, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - j)), tz = Math.min(1, Math.max(0, fz - i)), c = this.cov;
    const a = c[i * n + j] + (c[i * n + j + 1] - c[i * n + j]) * tx, b = c[(i + 1) * n + j] + (c[(i + 1) * n + j + 1] - c[(i + 1) * n + j]) * tx;
    return a + (b - a) * tz;
  }
  /** ambient occlusion 0..0.7 for a plant at (x, z); a tree passes itself (its own crown does not shade its own leaves) */
  occ(x: number, z: number, self?: VegInstance): number {
    let c = this.at(x, z);
    if (self) { const cr = CanopyGrid.crown(self); if (cr) c -= cr.w * 0.85; }
    const t = Math.min(1, Math.max(0, (c - 0.3) / 1.3));
    return 0.7 * t * t * (3 - 2 * t);
  }
}
/** add the occlusion code to a tint's red channel */
export const encodeOcc = (r: number, occ: number) => r + 8 * (1 + Math.round(Math.min(1, Math.max(0, occ / 0.7)) * 30));

const NRM = [0, 1, 0];
/** max natural height (m) per detail kind — cell bounds only */
const HEIGHT: Partial<Record<VegKind, number>> = { grass: 0.75, flowers: 1.35, fern: 1.3, groundcover: 0.5 };

/**
 * Detail variants drawn by another variant's pool (instead of a LOD0 + LOD1 draw per variant): same
 * geometry family + material; `atlas` = 1 picks the other half of the material's 2-card atlas per instance
 * (instanceColor.g += 8, foliage-material V_ATLAS), `scale` keeps the variant's size.
 */
export const DETAIL_ALIAS: Record<string, { id: string; atlas: number; scale: number }> = {
  "grass:1": { id: "grass:0", atlas: 1, scale: 1 },
  "grass:3": { id: "grass:2", atlas: 1, scale: 1 },
  "fern:1": { id: "fern:0", atlas: 0, scale: 1.15 },
  "groundcover:1": { id: "groundcover:0", atlas: 0, scale: 1 },
};

export interface GenBlock { id: string; kind: VegKind; mats: Float32Array; cols: Float32Array; n: number }
export interface GenCell { cx: number; cz: number; y0: number; y1: number; blocks: GenBlock[] }

export class DetailGen {
  private noise = new Simplex2(WORLD.SEED + 101);
  private tinter: Tinter;
  constructor(private terrain: Terrain, private clearings: Clearing[], private env: ScatterEnv, private canopy?: CanopyGrid) {
    this.tinter = new Tinter(terrain);
    // the meadow floor under closed crowns grows jungle floor (veg-scatter runRule reads env.canopy)
    if (canopy) this.env = { ...env, canopy: (x, z) => canopy.at(x, z) };
  }

  cell(cx: number, cz: number): GenCell {
    const list = detailCell(this.terrain, this.clearings, cx, cz, undefined, this.noise, this.env);
    const groups = new Map<string, typeof list>();
    let y0 = 1e9, y1 = -1e9;
    for (const p of list) {
      const own = `${p.kind}:${p.variant % VARIANTS[p.kind]}`, al = DETAIL_ALIAS[own], id = al ? al.id : own;
      let g = groups.get(id); if (!g) { g = []; groups.set(id, g); } g.push(p);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y + (HEIGHT[p.kind] ?? 1) * p.scale);
    }
    const blocks: GenBlock[] = [];
    for (const [id, g] of groups) {
      const thr = g.map((p) => hash01(p.x * 0.37, p.z * 0.53));
      const order = g.map((_, i) => i).sort((a, b) => thr[a] - thr[b]);
      const mats = new Float32Array(g.length * 16), cols = new Float32Array(g.length * 3);
      order.forEach((i, k) => {
        const p = g[i], al = DETAIL_ALIAS[`${p.kind}:${p.variant % VARIANTS[p.kind]}`], sc = p.scale * (al?.scale ?? 1);
        if (p.kind === "grass" && p.variant % 4 < 2) { const n = this.terrain.normal(p.x, p.z, NRM), ny = Math.max(0.3, n[1]); writeMatrixSheared(mats, k * 16, p.x, p.y, p.z, p.yaw, sc, -n[0] / ny, -n[2] / ny); }
        else writeMatrix(mats, k * 16, p.x, p.y, p.z, p.yaw, sc);
        this.tinter.tint(p.kind, p.x, p.z, cols, k * 3);
        if (al?.atlas) cols[k * 3 + 1] += 8 * al.atlas;
        // thinning rank (1..31) rides on the blue tint: the shader shrinks rank r away at its own distance and the
        // veg system keeps the first ceil(n · frac) of the block (foliage-material V_COLOR / V_WIND, index.ts)
        cols[k * 3 + 2] += 8 * (1 + Math.floor((k / g.length) * 31));
        if (this.canopy) cols[k * 3] = encodeOcc(cols[k * 3], this.canopy.occ(p.x, p.z));
      });
      blocks.push({ id, kind: g[0].kind, mats, cols, n: g.length });
    }
    return { cx, cz, y0, y1, blocks };
  }
}
