// Footsteps: WHAT the foot lands on (stepSurfaceAt) and WHEN (StepCadence).
//
// Surface: the step plays the material you SEE under the foot.
//  - a collider box under the feet → its `surf` tag (decks, floors, roofs, containers — shared/pois/*.ts)
//  - bare terrain → the terrain's VISIBLE splat layer at that point (client/src/world/terrain/data.ts weights, shared by
//    the terrain module as engine.shared "terrainTextures"), not the categorical biome: a dirt path through the meadow is
//    dirt, a rock face in the jungle is stone, the Murk's mud is mud, the beach under 10 cm of sea is a splash, the
//    Mist Falls river (a render-only water ribbon, shared/pois/jungle-falls.ts) is water.
// Verified by an offline audit (≥ 600 foot positions: played surface vs the rendered material under the foot).
//
// Cadence matches the first-person view-bob in client/src/game/render.ts (walk 2.7 steps/s, sprint 3.5, crouch 2.5),
// so feet land with the camera dip. Sprinting steps are heavier, crouched steps quieter (gameplay info: a crouch-walker
// is harder to hear).
import type { Surface } from "../../../shared/world/colliders";
import { Biome, WORLD } from "../../../shared/world/map";
import type { Terrain } from "../../../shared/world/terrain";
import { surfaceById, makeHit, type Hit } from "../../../shared/sim/world";
import { FALLS, resolveFalls, type FallsResolved } from "../../../shared/pois/jungle-falls";
import { LAYERS } from "../world/terrain/layers";

/** what a footstep can sound like: every collider Surface + two terrain-only grounds */
export type StepSurface = Surface | "dirt" | "mud";
export const STEP_SURFACES: StepSurface[] = ["wood", "metal", "concrete", "stone", "sand", "grass", "water", "foliage", "glass", "fabric", "dirt", "mud"];

/** terrain splat layer id → step surface (layers.ts order) */
const LAYER_STEP: Record<string, StepSurface> = {
  sand: "sand", grass: "grass", jungle: "grass", path: "dirt", cliff: "stone", rock: "stone", cinder: "dirt",
  farm: "dirt", lava: "stone", mud: "mud", reef: "water", basalt: "stone",
};
export const LAYER_STEPS: StepSurface[] = LAYERS.map((l) => LAYER_STEP[l.id] ?? "grass");
const PATH_LAYER = LAYERS.findIndex((l) => l.id === "path");

/** biome fallback (no splat data yet: offline renders, the server-less audition) */
const BIOME_STEP: StepSurface[] = [];
BIOME_STEP[Biome.DeepOcean] = "water"; BIOME_STEP[Biome.Reef] = "water"; BIOME_STEP[Biome.Beach] = "sand"; BIOME_STEP[Biome.Grass] = "grass";
BIOME_STEP[Biome.Jungle] = "grass"; BIOME_STEP[Biome.Rock] = "stone"; BIOME_STEP[Biome.Cinder] = "dirt"; BIOME_STEP[Biome.Path] = "dirt";
BIOME_STEP[Biome.Farmland] = "dirt"; BIOME_STEP[Biome.Paved] = "concrete"; BIOME_STEP[Biome.Lagoon] = "water";

/** the terrain module's footstep splat (client/src/world/terrain/data.ts stepSplatFrom): `w` = 3 × res² RGBA8 layers of
 * 12 layer weights, `path` = res² × (path coverage, signed path offset, path half-width) */
export interface Splat { w: ArrayLike<number>; path: ArrayLike<number>; res: number }

/** dominant visible splat layer at (x, z) (bilinear weights, argmax; the shader's height blend sharpens toward it) and
 * whether the crisp dirt-path ribbon covers the point */
export function splatAt(s: Splat, x: number, z: number): { layer: number; path: boolean } {
  const r = s.res, N = r * r, fx = (x + WORLD.HALF) / WORLD.CELL, fz = (z + WORLD.HALF) / WORLD.CELL;
  const j = Math.max(0, Math.min(r - 2, Math.floor(fx))), i = Math.max(0, Math.min(r - 2, Math.floor(fz)));
  const tx = Math.min(1, Math.max(0, fx - j)), tz = Math.min(1, Math.max(0, fz - i));
  const k00 = i * r + j, ks = [k00, k00 + 1, k00 + r, k00 + r + 1], ws = [(1 - tx) * (1 - tz), tx * (1 - tz), (1 - tx) * tz, tx * tz];
  let best = 0, bw = -1;
  for (let q = 0; q < 12; q++) {
    const base = (q >> 2) * N * 4 + (q & 3);
    let v = 0; for (let c = 0; c < 4; c++) v += s.w[base + ks[c] * 4] * ws[c];
    if (v > bw) { bw = v; best = q; }
  }
  // path ribbon (material.ts): coverage (dat0.b) gates it, |offset| < half-width draws it (± a 0.5 m noise edge)
  let cov = 0, off = 0, hw = 0;
  for (let c = 0; c < 4; c++) {
    const k = ks[c] * 3; cov += s.path[k] * ws[c]; off += s.path[k + 1] * ws[c]; hw += s.path[k + 2] * ws[c];
  }
  const pHW = (hw / 255) * 6.375, pOff = Math.abs((off / 255) * 12.75 - 6.4);
  const path = cov / 255 > 0.45 && pHW >= 0.1 && pOff < pHW;
  return { layer: path ? PATH_LAYER : best, path };
}

// ---- the Mist Falls river (render-only water: riverSurface over FALLS.river, half-width riverHalfW + 3)
let falls: FallsResolved | null = null;
const RIVER_BOX = { x0: -140, x1: 265, z0: -440, z1: -315 };
/** water surface level of the river at (x, z), or -Infinity when not over the river */
export function riverLevel(terrain: Terrain, x: number, z: number): number {
  if (x < RIVER_BOX.x0 || x > RIVER_BOX.x1 || z < RIVER_BOX.z0 || z > RIVER_BOX.z1) return -Infinity;
  falls ??= resolveFalls((a, b) => terrain.height(a, b));
  const P = FALLS.river; let best = Infinity, lv = -Infinity, hw = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    const ax = P[i][0], az = P[i][1], dx = P[i + 1][0] - ax, dz = P[i + 1][1] - az, L2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best) { best = d; lv = falls.riverLevel[i] + (falls.riverLevel[i + 1] - falls.riverLevel[i]) * t; hw = falls.riverHalfW[i] + (falls.riverHalfW[i + 1] - falls.riverHalfW[i]) * t + 3; }
  }
  return best < hw ? lv : -Infinity;
}

/** water deeper than this over the ground → the step splashes (ankle-deep shallows, not the wet sand at the waterline) */
export const SPLASH_DEPTH = 0.08;

/** step surface on bare terrain at (x, z) */
export function terrainStep(terrain: Terrain, x: number, z: number, splat: Splat | null, footY?: number): StepSurface {
  // (the water depth is taken at the FOOT when it stands above the heightfield — a sand bar / root / rock over the river edge
  // is dry even where the river ribbon's level is over the terrain under it)
  const g = footY !== undefined ? Math.max(terrain.height(x, z), footY) : terrain.height(x, z);
  if (WORLD.SEA_LEVEL - g > SPLASH_DEPTH) return "water";
  if (riverLevel(terrain, x, z) - g > SPLASH_DEPTH) return "water";
  if (!splat) return BIOME_STEP[terrain.biomeAt(x, z)] ?? "grass";
  return LAYER_STEPS[splatAt(splat, x, z).layer] ?? "grass";
}

// ---- the drawn-floor correction map (baked by the offline audit → public/assets/audio/kr/steps-floor.json):
// per POI a 1 m grid; a cell lists (floor y, surface) where the DRAWN floor differs from the collider tag / splat under
// it (plank floors in buildings tagged concrete, paving / gravel / sand / turf meshes laid over the terrain, container
// roofs, ship decks) and where the foot wades in drawn water (the Murk's swamp, pools, flooded decks).
/** a baked grid as row-indexed runs (no per-cell objects: decoding the whole island is a few ms and ~2 MB): the runs of
 * row j are k = row[j] .. row[j+1]-1, each covering cells i0[k] ≤ i < i1[k] at floor level y[k] with value v[k] */
interface RunGrid { x0: number; z0: number; nx: number; nz: number; step: number; row: Int32Array; i0: Uint16Array; i1: Uint16Array; y: Float32Array; v: Uint8Array }
export interface FloorMapFile { version: number; surfaces: StepSurface[]; pois: Record<string, { x0: number; z0: number; nx: number; nz: number; step: number; cells: string; lens?: string; ys: string; codes?: string; v?: string }> }
let floorGrids: RunGrid[] | null = null, floorAsked = false;
const b64 = (s: string): Uint8Array => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
/** runs (start cell, length, y cm, value) → row-indexed runs (a run crossing a row end is split); map() re-codes values */
function runGrid(g: FloorMapFile["pois"][string], vals: Uint8Array, map: (v: number) => number): RunGrid {
  const cb = b64(g.cells), yb = b64(g.ys), lb = g.lens ? b64(g.lens) : null;
  const cells = new Uint32Array(cb.buffer, cb.byteOffset, cb.byteLength >> 2), ys = new Int16Array(yb.buffer, yb.byteOffset, yb.byteLength >> 1);
  const lens = lb ? new Uint16Array(lb.buffer, lb.byteOffset, lb.byteLength >> 1) : null;
  const nx = g.nx, pieces: number[] = [];   // [row, i0, i1, y cm, v]
  for (let k = 0; k < cells.length; k++) {
    const v = map(vals[k]); if (v < 0) continue;
    let c = cells[k]; const e = c + (lens ? lens[k] : 1);
    while (c < e) { const j = Math.floor(c / nx), i = c - j * nx, n = Math.min(e - c, nx - i); pieces.push(j, i, i + n, ys[k], v); c += n; }
  }
  const n = pieces.length / 5, row = new Int32Array(g.nz + 1);
  for (let k = 0; k < n; k++) row[pieces[k * 5] + 1]++;
  for (let j = 0; j < g.nz; j++) row[j + 1] += row[j];
  const at = row.slice(0, g.nz), i0 = new Uint16Array(n), i1 = new Uint16Array(n), y = new Float32Array(n), vv = new Uint8Array(n);
  for (let k = 0; k < n; k++) { const q = at[pieces[k * 5]]++; i0[q] = pieces[k * 5 + 1]; i1[q] = pieces[k * 5 + 2]; y[q] = pieces[k * 5 + 3] / 100; vv[q] = pieces[k * 5 + 4]; }
  return { x0: g.x0, z0: g.z0, nx, nz: g.nz, step: g.step, row, i0, i1, y, v: vv };
}
export function setFloorMap(f: FloorMapFile | null) {
  if (!f) { floorGrids = null; return; }
  floorGrids = Object.values(f.pois).map((g) => runGrid(g, b64(g.codes ?? ""), (c) => STEP_SURFACES.indexOf(f.surfaces[c])));
}
/** the client fetches the map once, in the background (until it lands, steps use the tags / splat) */
export function loadFloorMap(base: string) {
  if (floorAsked || typeof fetch === "undefined") return;
  floorAsked = true;
  fetch(base + "steps-floor.json").then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) setFloorMap(j as FloorMapFile); }).catch(() => { /* optional data */ });
}
/** best run value in cell (i, j) of g whose level is within tol of y (nearest level wins); -1 = none */
function cellRun(g: RunGrid, i: number, j: number, y: number, tol: number): number {
  if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return -1;
  let best = -1, bd = tol;
  for (let k = g.row[j], e = g.row[j + 1]; k < e; k++) if (i >= g.i0[k] && i < g.i1[k]) { const d = Math.abs(g.y[k] - y); if (d < bd) { bd = d; best = g.v[k]; } }
  return best;
}
// ---- the rooms map (same bake, public/assets/audio/kr/rooms.json): 2 m cells × floor levels where the head is under a
// drawn roof, with the enclosure measured from drawn walls / terrain (1 room, 0.6 porch / shed, 0.15 just covered).
// The acoustic world (world.ts enclosure) takes the max of this and its collider probe: shacks, ship decks and the caves'
// rock halls — drawn, not boxed — are rooms too
let roomGrids: RunGrid[] | null = null, roomsAsked = false;
export function setRoomsMap(f: { pois: FloorMapFile["pois"] } | null) {
  if (!f) { roomGrids = null; return; }
  roomGrids = Object.values(f.pois).map((g) => runGrid(g, b64(g.v ?? ""), (v) => v));
  roomsVersion++;
}
/** bumps when the rooms map lands (caches of enclosure values drop then) */
export let roomsVersion = 0;
export function loadRoomsMap(base: string) {
  if (roomsAsked || typeof fetch === "undefined") return;
  roomsAsked = true;
  fetch(base + "rooms.json").then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) setRoomsMap(j); }).catch(() => { /* optional data */ });
}
/** enclosure 0..1 of a head at (x, feetY + 1.6, z) from the drawn rooms map (the nearest baked floor level within 1 m of
 * the feet, in the 2 × 2 cells around the point) */
export function roomAt(x: number, feetY: number, z: number): number {
  if (!roomGrids) return 0;
  let best = 0;
  for (const g of roomGrids) {
    // the NEAREST baked sample only (each 2 m cell was probed 0.5 m into it)
    // — the max over the 2 × 2 cells around the point put a room 1-2 m outside every wall (a step out of
    // a warehouse door onto the apron still rang like the hall)
    const i = Math.round((x - g.x0 - 0.5) / g.step), j = Math.round((z - g.z0 - 0.5) / g.step);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
    const v = cellRun(g, i, j, feetY, 1.0); if (v > best) best = v;
  }
  return best / 100;
}

/** the drawn floor's surface at (x, footY, z) when the map corrects it, else null */
export function floorSurface(x: number, y: number, z: number, tol = 0.4): StepSurface | null {
  if (!floorGrids) return null;
  for (const g of floorGrids) {
    const v = cellRun(g, Math.floor((x - g.x0) / g.step), Math.floor((z - g.z0) / g.step), y, tol);
    if (v >= 0) return STEP_SURFACES[v];
  }
  return null;
}

/** the step surface under a player: `surf` = the sim's ground surface id (Player.surf: a box's surface index, 255 =
 * terrain, 127 = terrain after the 7-bit wire mask); `y` = the feet (enables the drawn-floor map) */
export function stepSurfaceOf(terrain: Terrain, surf: number, x: number, z: number, splat: Splat | null, y?: number): StepSurface {
  // on bare terrain (surf 255) only a drawn floor AT ground level counts (paving, gravel, swamp water) — a deck edge
  // 0.3 m up in the same 1 m cell is not under this foot
  if (y !== undefined) { const f = floorSurface(x, y, z, surf === 255 || surf === 127 ? 0.2 : 0.3); if (f) return f; }
  if (surf !== 255 && surf !== 127) return surfaceById(surf);
  return terrainStep(terrain, x, z, splat, y);
}

// the live game's splat: engine.shared "terrainSteps" (the terrain module keeps these CPU arrays for the feet)
let splatLive: Splat | null = null;
function liveSplat(): Splat | null {
  if (splatLive) return splatLive;
  const eng = (globalThis as unknown as { __kr?: { engine?: { shared?: Map<string, unknown> } } }).__kr?.engine;
  const g = eng?.shared?.get?.("terrainSteps") as Splat | undefined;
  if (g && g.res && g.w.length >= g.res * g.res * 12 && g.path.length >= g.res * g.res * 3) splatLive = g;
  return splatLive;
}

/** the game's footstep surface (client): what the player with feet at (x, y, z) and sim ground `surf` stands on */
export function stepSurfaceAt(terrain: Terrain, surf: number, x: number, y: number, z: number): StepSurface {
  if (!floorAsked) loadFloorMap(`${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}assets/audio/kr/`);
  return stepSurfaceOf(terrain, surf, x, z, surf !== 255 && surf !== 127 ? null : liveSplat(), y);
}

/** the sim world's ray query (shared/sim/world.ts StaticWorld.raycast; bullets = false → the boxes you can stand on) */
export interface RayWorld { raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, out: Hit, bullets?: boolean): Hit }
const HIT = makeHit();
/** EVERY kong's step surface under a foot — yours (index.ts localGround: the
 * predicted feet) and the others' (their rig's planted foot) through this one function at (x, feetY, z), from the SAME world the
 * sim moves them in (every POI box, veg trunks, terrain rocks — client cm.world): the top of whatever you can stand on
 * within [-0.8, +0.45] m of the feet → that box's surface id, exactly what the mover would report as the player's `surf`,
 * then the same drawn-floor map / splat lookup as YOUR steps (stepSurfaceOf). So an enemy on the galleon deck plays
 * the deck, never "water" because the biome under the hull is sea. */
export function stepSurfaceUnder(w: RayWorld, terrain: Terrain, x: number, feetY: number, z: number, splat: Splat | null): StepSurface {
  // the centre ray + 4 at 0.3 m: the mover's capsule rests on the HIGHEST support under its footprint (a deck edge, a
  // box corner the centre misses) — the centre wins unless something under the footprint stands ≥ 5 cm higher
  let bs = 255, by = -Infinity, cy = -Infinity, cs = 255;
  for (let k = 0; k < 5; k++) {
    const ox = k === 1 ? 0.3 : k === 2 ? -0.3 : 0, oz = k === 3 ? 0.3 : k === 4 ? -0.3 : 0;
    w.raycast(x + ox, feetY + 0.45, z + oz, 0, -1, 0, 1.25, HIT, false);
    if (!HIT.hit) continue;
    if (k === 0) { cy = HIT.y; cs = HIT.surf; }
    if (HIT.y > by) { by = HIT.y; bs = HIT.surf; }
  }
  // (the centre wins when it lands on what the feet stand on — within 12 cm of them — or is no lower than the rest)
  const useC = cy > -Infinity && (Math.abs(cy - feetY) <= 0.12 || cy >= by - 0.05);
  const surf = useC ? cs : by > -Infinity ? bs : 255, y = useC ? cy : by > -Infinity ? by : terrain.height(x, z);
  // a foot among a tree's ROOTS / buttress blades: those veg boxes are noWalk (the mover walks
  // through them and rests on the ground), so the walk ray misses them; a drawn root whose top is at the foot (≤ 0.3 m over
  // it, ≥ 0.12 m under it) is what the foot lands on → wood
  if (surf === 255 || surf === 127 || Math.abs(y - feetY) > 0.2) {
    const nw = (w as { noWalk?: Uint8Array }).noWalk;
    if (nw) {
      w.raycast(x, feetY + 0.3, z, 0, -1, 0, 0.42, HIT, true);
      if (HIT.hit && HIT.box >= 0 && nw[HIT.box] && surfaceById(HIT.surf) === "wood" && HIT.y > y + 0.02) return "wood";
    }
  }
  return stepSurfaceOf(terrain, surf, x, z, surf === 255 || surf === 127 ? splat : null, y);
}
/** the live game's version (the client's splat) */
export function stepSurfaceUnderLive(w: RayWorld, terrain: Terrain, x: number, feetY: number, z: number): StepSurface {
  if (!floorAsked) loadFloorMap(`${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}assets/audio/kr/`);
  return stepSurfaceUnder(w, terrain, x, feetY, z, liveSplat());
}

/** steps per second at a horizontal speed (m/s): walk 5.4 → 2.7, sprint 7.4 → 3.5, crouch 2.8 → 2.5 */
export function stepRate(speed: number): number {
  return ((speed > 6.4 ? 11 : 8.5) * Math.min(1, speed / 3)) / Math.PI;
}

export class StepCadence {
  private phase = 0.55;
  private foot = 0;

  /** returns a step (with a per-foot volume) when a foot lands this frame, else null */
  tick(dt: number, speed: number, grounded: boolean, crouch = false): { volume: number; rate: number } | null {
    if (!grounded || speed < 0.9 || dt <= 0 || dt > 0.25) { this.phase = 0.55; return null; }
    this.phase += dt * stepRate(speed);
    if (this.phase < 1) return null;
    this.phase -= 1;
    this.foot ^= 1;
    const vol = (crouch ? 0.55 : speed > 6.4 ? 1.12 : 0.9) * (this.foot ? 1 : 0.9);
    return { volume: vol, rate: this.foot ? 1 : 0.985 };
  }
}
