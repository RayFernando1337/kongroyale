// Playability scanner — shared world loading + movement helpers (Node, no browser).
// Loads the EXACT static world the server builds (server/index.ts → shared/sim/static-world.ts buildStaticWorld):
// island.bin heightfield + every POI's colliders (in shared/pois/index.ts order) + veg trunk colliders + terrain rock
// colliders, and tags every box with its source so issues can be routed to the owning area.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Terrain } from "../../shared/world/terrain";
import { decodeTerrainFile, generateTerrain, terrainColliders, type TerrainData } from "../../shared/world/terrain-gen";
import { StaticWorld } from "../../shared/sim/world";

import { POIS, type Poi } from "../../shared/world/map";
import type { Box } from "../../shared/world/colliders";
import { B, PS, makeInput, makePlayer, stepPlayer, type Input, type Player } from "../../shared/sim/player";
import { CROUCH_H, DT, PLAYER_H, PLAYER_R, SLOPE_LIMIT, STEP_H, WATER_LEVEL } from "../../shared/sim/const";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export { B, PS, DT, PLAYER_H, PLAYER_R, CROUCH_H, STEP_H, SLOPE_LIMIT, WATER_LEVEL };

/** poi → owning area */
export const POI_AREA: Record<string, string> = {
  "mango-market": "poi-town", "stilt-town": "poi-town", "coconut-cove": "poi-town",
  "peel-harbor": "poi-harbor", "the-wreck": "poi-harbor",
  "banana-temple": "poi-jungle", "ripe-peak": "poi-jungle", "mist-falls": "poi-jungle",
  "lookout-point": "poi-coast", "peel-strip": "poi-coast", "the-plantation": "poi-coast",
  "the-murk": "poi-murk", "canopy-line": "poi-canopy", "coco-caves": "poi-caves", "wreck-bay": "poi-wreckbay",
  "cnvs-lab": "poi-lab", "lobby-islet": "actors",
};

/** source of box i: a POI id, "veg" (trunks) or "rock" (terrain colliders), or "test" (planted by --plant) */
export interface Loaded {
  terrain: Terrain; td: TerrainData; world: StaticWorld; boxes: Box[]; src: string[]; hash: number; ms: number;
  /** POI modules that threw on import (skipped) */
  failed: string[];
}

/** POI module ids in shared/pois/index.ts order (parsed, so a new POI is picked up automatically) */
function poiModuleOrder(): string[] {
  const src = fs.readFileSync(path.join(ROOT, "shared/pois/index.ts"), "utf8");
  const alias = new Map<string, string>();
  for (const m of src.matchAll(/import \* as (\w+) from "\.\/([\w-]+)"/g)) alias.set(m[1], m[2]);
  const all = /const ALL = \[([^\]]*)\]/s.exec(src);
  if (!all) throw new Error("scan: cannot parse ALL in shared/pois/index.ts");
  return all[1].split(",").map((s) => s.trim()).filter(Boolean).map((a) => {
    const id = alias.get(a); if (!id) throw new Error(`scan: unknown POI alias ${a}`); return id;
  });
}

export async function loadWorld(extra: Box[] = []): Promise<Loaded> {
  const t0 = performance.now();
  let td: TerrainData;
  try { const b = fs.readFileSync(path.join(ROOT, "public/assets/terrain/island.bin")); td = decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  catch { td = generateTerrain(); }
  // rock keep-outs = the live POI clearings, exactly as the server does (shared/sim/static-world.ts); a POI mid-edit that
  // throws on import leaves the file's snapshot
  try { (await import("../../shared/world/rock-keeps")).applyPoiRockKeeps(td); } catch { /* snapshot */ }
  const terrain = new Terrain(td.heights, td.biome);
  const boxes: Box[] = [], src: string[] = [];
  const failed: string[] = [], clearings: unknown[] = [];
  for (const id of poiModuleOrder()) {
    // another area may be mid-edit: a POI that throws on import is skipped (and reported), the rest still scans
    let mod: { colliders: Box[]; clearings: unknown[] };
    try { mod = await import(path.join(ROOT, "shared/pois", id + ".ts")) as typeof mod; }
    catch (e) { failed.push(`${id}: ${String(e).split("\n")[0].slice(0, 200)}`); continue; }
    for (const b of mod.colliders) { boxes.push(b); src.push(id); }
    clearings.push(...(mod.clearings ?? []));
  }
  // = shared/sim/veg-colliders.ts vegTrunkColliders(terrain, td), without importing shared/pois/index.ts (which throws
  // as a whole when one POI module is mid-edit)
  const veg = await import("../../shared/world/veg-scatter");
  const cl = clearings.filter((c): c is import("../../shared/world/veg-scatter").Clearing => !!c && typeof c === "object" && "x" in c);
  for (const b of veg.vegStaticColliders(terrain, td, cl)) { boxes.push(b); src.push("veg"); }
  for (const b of terrainColliders(td)) { boxes.push(b); src.push("rock"); }
  // the cliff-stair exits, in the server's order (shared/sim/static-world.ts: POIs, veg, rocks, exits)
  for (const b of (await import("../../shared/world/exits")).exitColliders()) { boxes.push(b); src.push("exits"); }
  // the server's hash function (shared/sim/static-world.ts) — imported lazily: that module statically imports EVERY POI,
  // so one POI mid-edit (throwing on import) would take the whole scanner down; the local copy is used then
  let hashFn = worldHashLocal;
  try { hashFn = (await import("../../shared/sim/static-world")).worldHash; } catch { /* a POI module throws: local copy */ }
  const hash = hashFn(td.hash ?? 0, boxes);
  for (const b of extra) { boxes.push(b); src.push("test"); }
  const world = new StaticWorld(terrain, boxes);
  return { terrain, td, world, boxes, src, hash, ms: performance.now() - t0, failed };
}

/** which POI circle contains (x,z) (closest centre-relative when several overlap) */
export function poiAt(x: number, z: number): Poi | null {
  let best: Poi | null = null, bd = Infinity;
  for (const p of POIS) { const d = Math.hypot(x - p.x, z - p.z) / p.r; if (d <= 1 && d < bd) { bd = d; best = p; } }
  return best;
}

// ---- box queries on the StaticWorld's SoA arrays (its spatial grid is private; we keep our own 4 m hash)
export class BoxIndex {
  readonly cell = 4; private map = new Map<number, number[]>();
  constructor(readonly w: StaticWorld) {
    for (let i = 0; i < w.n; i++) {
      const ex = Math.abs(w.cos[i]) * w.hx[i] + Math.abs(w.sin[i]) * w.hz[i];
      const ez = Math.abs(w.sin[i]) * w.hx[i] + Math.abs(w.cos[i]) * w.hz[i];
      const x0 = Math.floor((w.cx[i] - ex) / this.cell), x1 = Math.floor((w.cx[i] + ex) / this.cell);
      const z0 = Math.floor((w.cz[i] - ez) / this.cell), z1 = Math.floor((w.cz[i] + ez) / this.cell);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 40000) continue; // absurd box (never seen)
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const k = x * 100003 + z; let a = this.map.get(k); if (!a) this.map.set(k, a = []); a.push(i);
      }
    }
  }
  near(x: number, z: number): number[] { return this.map.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell)) ?? EMPTY; }
  /** does box i's footprint contain (x,z) (inflated by m) */
  contains(i: number, x: number, z: number, m = 0): boolean {
    const w = this.w, dx = x - w.cx[i], dz = z - w.cz[i];
    const lx = dx * w.cos[i] + dz * w.sin[i], lz = -dx * w.sin[i] + dz * w.cos[i];
    return Math.abs(lx) <= w.hx[i] + m && Math.abs(lz) <= w.hz[i] + m;
  }
  /** horizontal distance from (x,z) to box i's footprint */
  dist(i: number, x: number, z: number): number {
    const w = this.w, dx = x - w.cx[i], dz = z - w.cz[i];
    const lx = dx * w.cos[i] + dz * w.sin[i], lz = -dx * w.sin[i] + dz * w.cos[i];
    const qx = Math.max(0, Math.abs(lx) - w.hx[i]), qz = Math.max(0, Math.abs(lz) - w.hz[i]);
    return Math.hypot(qx, qz);
  }
  /** deepest penetration of a capsule (x,y,z,r,h) into any walk box: horizontal overlap depth (0 = clear) */
  penetration(x: number, y: number, z: number, r: number, h: number): { d: number; box: number } {
    const w = this.w; let best = 0, bi = -1;
    for (let cx = Math.floor((x - r) / this.cell); cx <= Math.floor((x + r) / this.cell); cx++)
      for (let cz = Math.floor((z - r) / this.cell); cz <= Math.floor((z + r) / this.cell); cz++) {
        const a = this.map.get(cx * 100003 + cz); if (!a) continue;
        for (const i of a) {
          if (w.noWalk[i]) continue;
          const top = w.cy[i] + w.hy[i], bot = w.cy[i] - w.hy[i];
          if (y >= top - 0.02 || y + h <= bot + 0.02) continue;
          const vy = Math.min(top - y, y + h - bot);
          const dd = this.dist(i, x, z);
          if (dd >= r) continue;
          const d = Math.min(r - dd + (dd === 0 ? insideDepth(w, i, x, z) : 0), vy);
          if (d > best) { best = d; bi = i; }
        }
      }
    return { d: best, box: bi };
  }
}
const EMPTY: number[] = [];
function insideDepth(w: StaticWorld, i: number, x: number, z: number) {
  const dx = x - w.cx[i], dz = z - w.cz[i];
  const lx = dx * w.cos[i] + dz * w.sin[i], lz = -dx * w.sin[i] + dz * w.cos[i];
  return Math.min(w.hx[i] - Math.abs(lx), w.hz[i] - Math.abs(lz));
}

// ---- movement sim
export interface Mover { p: Player; inp: Input }
export function makeMover(): Mover {
  const p = makePlayer(0, 0, "scan", false); p.hp = 1e9; p.shield = 0; p.st = PS.Ground;
  return { p, inp: makeInput() };
}
export function place(m: Mover, x: number, y: number, z: number, crouch: boolean, w?: StaticWorld) {
  const p = m.p;
  w?.unstickReset(p);
  p.x = x; p.y = y; p.z = z; p.vx = p.vy = p.vz = 0; p.st = PS.Ground; p.grounded = true; p.crouch = crouch; p.sprint = false;
  p.swim = false; p.slope = false; p.jumpBuf = 0; p.coyote = 0; p.airT = 0; p.fallV = 0; p.prevButtons = crouch ? B.CROUCH : 0; p.hp = 1e9;
  p.reloadT = 0; p.useT = 0; p.scoped = false;
}
/** ticks the jump button stays held per press (≈ 170 ms) */
export const JUMP_HOLD = 10;
export const enum Mode { Walk = 0, Sprint = 1, Jump = 2, Crouch = 3, JumpFwd = 4,
  /** sprint with a run-up, then jump every 25 ticks held JUMP_HOLD */
  RunJump = 5 }
/** set the input for a mode at tick t (yaw = facing; forward = (-sin yaw, -cos yaw)) */
export function setInput(m: Mover, mode: Mode, yaw: number, t: number) {
  const i = m.inp; i.yaw = yaw; i.pitch = 0; i.mx = 0; i.mz = 1; i.buttons = 0;
  if (mode === Mode.Sprint || mode === Mode.JumpFwd) i.buttons |= B.SPRINT;
  if (mode === Mode.Crouch) i.buttons |= B.CROUCH;
  // a real player holds space ~100-150 ms: held in the air it also triggers the mantle (ledges up to MANTLE_MAX) — a
  // one-tick press never mantles and made the scanner call mantle-able rock ledges 'stuck' (ripe-peak-5)
  if ((mode === Mode.Jump || mode === Mode.JumpFwd) && t % 30 < JUMP_HOLD) i.buttons |= B.JUMP;
  if (mode === Mode.RunJump) { i.buttons |= B.SPRINT; if (t >= 18 && (t - 18) % 25 < JUMP_HOLD) i.buttons |= B.JUMP; }
}
/** a new position is the player standing still at rest? */
export function airborne(p: Player) { return p.st !== PS.Ground || !p.grounded; }
export function step(m: Mover, w: StaticWorld) { m.inp.seq++; stepPlayer(m.p, m.inp, w, DT); if (m.p.st === PS.Glide || m.p.st === PS.Freefall) { /* opened a chute off a ledge: fine */ } }

// ---- share ONE loaded world with worker threads (SharedArrayBuffers): a worker attaches in ~0 ms and ~0 MB instead of
// rebuilding the whole island (1.8 s, ~250 MB each — 14 workers exhausted the 16 GB machine next to 3 Chromium sessions)
const SOA = ["cx", "cy", "cz", "hx", "hy", "hz", "cos", "sin", "bx0", "bx1", "bz0", "bz1", "gx0", "gz0", "surf", "noShoot", "noWalk", "cellStart", "cellItems"] as const;
export interface SharedWorld { heights: Float32Array; biome: Uint8Array; arrays: Record<string, ArrayLike<number>>; n: number; gridMin: number; gridN: number; srcCode: Uint8Array; srcNames: string[]; hash: number }
function toShared<T extends Float32Array | Uint8Array | Int32Array>(a: T): T {
  const C = a.constructor as { new (b: SharedArrayBuffer): T; BYTES_PER_ELEMENT: number };
  const out = new C(new SharedArrayBuffer(a.length * C.BYTES_PER_ELEMENT)); out.set(a as never); return out;
}
export function shareWorld(L: Loaded): SharedWorld {
  const w = L.world as unknown as Record<string, unknown>;
  const arrays: Record<string, ArrayLike<number>> = {};
  for (const k of SOA) arrays[k] = toShared(w[k] as Float32Array);
  const srcNames = [...new Set(L.src)]; const srcCode = new Uint8Array(new SharedArrayBuffer(L.src.length));
  L.src.forEach((s, i) => { srcCode[i] = srcNames.indexOf(s); });
  return { heights: toShared(L.terrain.heights), biome: toShared(L.terrain.biome), arrays, n: L.world.n, gridMin: w.gridMin as number, gridN: w.gridN as number, srcCode, srcNames, hash: L.hash };
}
export function attachWorld(S: SharedWorld): { terrain: Terrain; world: StaticWorld; src: string[] } {
  const terrain = new Terrain(S.heights, S.biome);
  // a real (empty) StaticWorld gets every field its constructor initialises; then the shared arrays replace its boxes
  const w = new StaticWorld(terrain, []) as unknown as Record<string, unknown>;
  Object.assign(w, S.arrays, { n: S.n, gridMin: S.gridMin, gridN: S.gridN });
  (w as unknown as StaticWorld).initScratch();
  const src = Array.from(S.srcCode, (c) => S.srcNames[c]);
  return { terrain, world: w as unknown as StaticWorld, src };
}

/** = shared/sim/static-world.ts worldHash (kept identical; used only when that module cannot load) */
function worldHashLocal(terrainHash: number, boxes: Box[]): number {
  const HASH_SCALE = 100 / Math.PI * 3, HASH_OFFSET = 1 / Math.PI;
  let h = 0x811c9dc5 ^ (terrainHash >>> 0);
  const mix = (v: number) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
  const q = (v: number) => Math.floor(v * HASH_SCALE + HASH_OFFSET) | 0;
  mix(boxes.length);
  for (const b of boxes) {
    mix(q(b.c[0])); mix(q(b.c[1])); mix(q(b.c[2])); mix(q(b.h[0])); mix(q(b.h[1])); mix(q(b.h[2]));
    mix(q(b.yaw ?? 0)); mix(q(b.pitch ?? 0));
    let s = 0; if (b.surf) for (let i = 0; i < b.surf.length; i++) s = (s * 31 + b.surf.charCodeAt(i)) | 0;
    mix(s ^ (b.noShoot ? 0x100000 : 0) ^ (b.noWalk ? 0x200000 : 0));
  }
  return h >>> 0;
}
