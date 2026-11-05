import * as THREE from "three";
import type { Poi } from "../../shared/world/map";
import { Phase } from "../../shared/sim/match";
import type { Engine } from "./engine/engine";
import type { StaticCache } from "./engine/static-cache";
import type { WorldModule } from "./world/module";
import type { Scope } from "./engine/res/scope";
import { flag } from "./flags";

export function lowMemoryDevice(forced: string | null, fullPrepare: boolean): boolean {
  const ua = navigator.userAgent;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const on = !fullPrepare && (forced !== null ? forced === "1" : (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) || (mem !== undefined && mem < 8));
  const kr = (globalThis as unknown as { __kr?: { lowMem?: boolean; streamed?: boolean } }).__kr;
  if (kr) { kr.lowMem = on; if (on) kr.streamed = true; }
  return on;
}

type Session = { game?: { inMatch?: boolean; cm?: { phase: number } | null }; caster?: { casting?: boolean } };

const VIEW_HALF_H_M = 150;
const OFFSCREEN_RANK_M = 1e6;
let viewBuilds = 0, pickedByView = false;
const view = new THREE.Frustum(), viewProj = new THREE.Matrix4(), poiSphere = new THREE.Sphere();
const LOOKAHEAD_S = 5, AHEAD_MIN_M = 0.01, SAMPLE_MS = 200, STALE_MS = 1000, TELEPORT_MPS = 150, FAST_MPS = 12, FAST_BUILD_GAP_MS = 8000;
const motion = { x: 0, z: 0, at: 0, vx: 0, vz: 0, known: false, builtAt: -Infinity };

function track(camera: THREE.Camera): boolean {
  const e = camera.matrixWorld.elements, now = performance.now(), dt = (now - motion.at) / 1000;
  if (dt * 1000 < SAMPLE_MS) return motion.known;
  const vx = (e[12] - motion.x) / dt, vz = (e[14] - motion.z) / dt;
  const jump = dt * 1000 > STALE_MS || Math.hypot(vx, vz) > TELEPORT_MPS;
  motion.known = !jump;
  motion.vx = jump ? 0 : (motion.vx + vx) / 2;
  motion.vz = jump ? 0 : (motion.vz + vz) / 2;
  motion.x = e[12]; motion.z = e[14]; motion.at = now;
  return motion.known;
}

function distM(camera: THREE.Camera, p: Poi): number {
  const e = camera.matrixWorld.elements;
  const here = Math.hypot(e[12] - p.x, e[14] - p.z) - p.r;
  return here <= 0 ? here : Math.max(AHEAD_MIN_M, Math.hypot(e[12] + motion.vx * LOOKAHEAD_S - p.x, e[14] + motion.vz * LOOKAHEAD_S - p.z) - p.r);
}

function nearModule(pending: string[], camera: THREE.Camera, pois: readonly Poi[], radiusM: number, viewCap: number): string | null {
  const kr = (globalThis as unknown as { __kr?: Session }).__kr;
  const casting = !!kr?.caster?.casting;
  if (!kr?.game?.inMatch && !casting) return null;
  const phase = kr?.game?.cm?.phase ?? Phase.Play;
  const airborne = !casting && phase <= Phase.Plane;
  if (phase !== Phase.Plane) viewBuilds = 0;
  const overview = !casting && phase === Phase.Plane && viewBuilds < viewCap;
  if (overview) view.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const e = camera.matrixWorld.elements;
  if (!track(camera)) return null;
  if (Math.hypot(motion.vx, motion.vz) > FAST_MPS && performance.now() - motion.builtAt < FAST_BUILD_GAP_MS) return null;
  let best: string | null = null, bestD = Infinity;
  const resident = residents?.() ?? [];
  pickedByView = false;
  for (const id of pending) {
    const p = pois.find((x) => `poi:${x.id}` === id);
    if (!p) { pickedByView = false; return id; }
    const d = distM(camera, p);
    if (d >= buildLimitM(resident, id)) continue;
    const near = (airborne ? Math.hypot(d, e[13] - (p.padY ?? 0)) : d) < radiusM;
    const seen = overview && view.intersectsSphere(poiSphere.set(poiSphere.center.set(p.x, (p.padY ?? 0) + VIEW_HALF_H_M, p.z), Math.hypot(p.r, VIEW_HALF_H_M)));
    if (!seen && !near) continue;
    const rank = overview && !seen ? d + OFFSCREEN_RANK_M : d;
    if (rank < bestD) { best = id; bestD = rank; pickedByView = !near; }
  }
  return best;
}

export async function nextNearModule(pending: string[], camera: THREE.Camera, pois: readonly Poi[], radiusM: number, viewCap: number): Promise<string> {
  for (;;) {
    const id = nearModule(pending, camera, pois, radiusM, viewCap);
    if (id) { if (pickedByView) viewBuilds++; pending.splice(pending.indexOf(id), 1); return id; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

type Hook = (dt: number, t: number) => void;
type StaticEntry = Parameters<StaticCache["unfreeze"]>[0];
const hooksOf = new Map<string, Hook[]>(), ctxOf = new Map<string, Engine>(), evicted = new Set<string>();

export function moduleCtx(engine: Engine, w: World, id: string): Engine {
  (globalThis as unknown as { __kr: { rebuildModule?: (id: string) => Promise<void> } }).__kr.rebuildModule ??= async (x) => { await evictStreamed(engine, w, x); await (await w.build(x)).integrated; };
  engine.rebuilding = evicted.has(id);
  const known = ctxOf.get(id);
  if (known) return known;
  const hooks: Hook[] = [], bound = new Map<PropertyKey, unknown>();
  const onUpdate = (fn: Hook) => { engine.onUpdate(fn); hooks.push(fn); };
  const ctx = new Proxy(engine, {
    get(t, k) {
      if (k === "onUpdate") return onUpdate;
      const v = Reflect.get(t, k);
      if (typeof v !== "function") return v;
      let b = bound.get(k);
      if (!b) bound.set(k, (b = (v as (...a: unknown[]) => unknown).bind(t)));
      return b;
    },
  });
  hooksOf.set(id, hooks);
  ctxOf.set(id, ctx);
  return ctx;
}

type World = {
  modOf: Map<string, WorldModule>; scopeOf: Map<string, Scope>; rootsOf: Map<string, THREE.Object3D[]>;
  loaded: WorldModule[]; roots: (id: string) => THREE.Object3D[]; report: (where: string, e: unknown) => void; build: (id: string) => Promise<{ integrated: Promise<void> }>;
};

export async function evictStreamed(engine: Engine, w: World, id: string) {
  const m = w.modOf.get(id)!, roots = w.roots(id);
  const hooks = new Set(hooksOf.get(id)), u = engine.updates;
  for (let i = u.length - 1; i >= 0; i--) if (hooks.has(u[i])) { u.splice(i, 1); engine.updLabels.splice(i, 1); }
  engine.occlusion.unregister(id);
  const far = engine.far.pois.find((q) => q.id === id);
  if (far?.state === "built") Object.assign(far, { roots: [], sources: [], near: -Infinity, moved: () => true, late: () => false });
  else if (far) engine.far.drop(far);
  const statics = engine.statics;
  for (const r of roots) {
    const e = (r as unknown as Record<string, StaticEntry | undefined>)[statics.rootKey];
    if (e) { statics.unfreeze(e); delete (r as unknown as Record<string, unknown>)[statics.rootKey]; statics.entries.splice(statics.entries.indexOf(e), 1); }
    const cull = engine.cull;
    if (cull.roots.includes(r)) { cull.drop(r); cull.stale.delete(r); cull.touchedAt.delete(r); cull.staleSince.delete(r); }
    r.removeFromParent();
  }
  try { await m.release?.(engine); } catch (e) { w.report(`release:${id}`, e); }
  const freed = disposeUnused(roots, engine.scene);
  try { w.scopeOf.get(id)?.dispose(); } catch (e) { w.report(`release:${id}`, e); }
  for (const map of [w.modOf, w.scopeOf, w.rootsOf, hooksOf, ctxOf]) map.delete(id);
  w.loaded.splice(w.loaded.indexOf(m), 1);
  evicted.add(id);
  const kr = (globalThis as unknown as { __kr: { modules: string[]; evictions?: unknown[] } }).__kr;
  kr.modules = w.loaded.map((x) => x.id);
  (kr.evictions ??= []).push({ id, at: Math.round(performance.now()), ...freed });
}

type Resident = { id: string; d: number; mb: number };
const costOf = new Map<string, number>();
let residents: (() => Resident[]) | null = null;

function costMB(roots: readonly THREE.Object3D[]): number {
  const bufs = new Set<object>(), tex = new Set<THREE.Texture>();
  for (const r of roots) r.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) for (const b of buffersOf(m.geometry)) bufs.add(b);
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) texturesOf(x, tex);
  });
  let bytes = 0;
  for (const b of bufs) bytes += (b as { array?: ArrayBufferView }).array?.byteLength ?? 0;
  for (const t of tex) { const im = t.image as { width?: number; height?: number } | null; if (im?.width && im.height) bytes += im.width * im.height * 4 * (t.generateMipmaps ? 4 / 3 : 1); }
  return bytes / 1e6;
}

const UNKNOWN_POI_MB = 400;

function over(list: Resident[], incoming: string | null): boolean {
  const extra = incoming === null ? 0 : costOf.get(incoming) ?? UNKNOWN_POI_MB;
  return list.length + (incoming === null ? 0 : 1) > flag("lowmemcap") || list.reduce((a, r) => a + r.mb, extra) > flag("lowmembudget");
}

function victimOf(list: Resident[], incoming: string | null): Resident | null {
  const v = list[list.length - 1];
  return v && v.d > 0 && (incoming !== null || list.length > 1) ? v : null;
}

function buildLimitM(list: Resident[], id: string): number {
  if (!over(list, id)) return Infinity;
  const v = victimOf(list, id);
  return v ? v.d - flag("lowmemhyst") : -Infinity;
}

let trimming = Promise.resolve();

export function trimStreamed(engine: Engine, w: World, incoming: string | null, pending: string[], streamMs: Record<string, number>, pois: readonly Poi[]) {
  residents ??= () => {
    const list: Resident[] = [];
    for (const id of w.modOf.keys()) {
      if (!id.startsWith("poi:") || streamMs[id] === undefined) continue;
      const p = pois.find((x) => `poi:${x.id}` === id);
      let mb = costOf.get(id);
      if (mb === undefined) costOf.set(id, (mb = costMB(w.roots(id))));
      list.push({ id, d: p ? distM(engine.camera, p) : 0, mb });
    }
    return list.sort((a, b) => a.d - b.d);
  };
  return (trimming = trimming.then(async () => {
    for (;;) {
      const list = residents!();
      const victim = over(list, incoming) ? victimOf(list, incoming) : null;
      if (!victim) break;
      await evictStreamed(engine, w, victim.id);
      pending.push(victim.id);
      delete streamMs[victim.id];
    }
    if (incoming) motion.builtAt = performance.now();
  }).catch((e) => w.report("lowmem-trim", e)));
}

type Disposable = { dispose(): void };
type Geo = THREE.BufferGeometry;

function texturesOf(m: THREE.Material, out: Set<THREE.Texture>) {
  for (const v of Object.values(m)) if ((v as THREE.Texture | null)?.isTexture) out.add(v as THREE.Texture);
  const u = (m as THREE.ShaderMaterial).uniforms;
  if (u) for (const k in u) { const v = u[k]?.value as THREE.Texture | null; if (v?.isTexture) out.add(v); }
}

function buffersOf(g: Geo): Array<object> {
  const out: object[] = [];
  for (const a of Object.values(g.attributes)) out.push((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data : a);
  if (g.index) out.push(g.index);
  return out;
}

export function disposeUnused(roots: readonly THREE.Object3D[], scene: THREE.Object3D): { geometries: number; materials: number; textures: number } {
  const geos = new Set<Geo>(), mats = new Set<THREE.Material>(), owners: Disposable[] = [];
  for (const r of roots) r.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((o as THREE.InstancedMesh).isInstancedMesh || (o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) owners.push(o as unknown as Disposable);
    if (m.geometry && !(o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) geos.add(m.geometry);
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
  });
  const keepBuf = new Set<object>(), keepMat = new Set<THREE.Material>(), keepTex = new Set<THREE.Texture>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) for (const b of buffersOf(m.geometry)) keepBuf.add(b);
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) keepMat.add(x);
  });
  for (const m of keepMat) texturesOf(m, keepTex);
  for (const o of owners) o.dispose();
  let geometries = owners.length, materials = 0, textures = 0;
  for (const g of geos) if (!buffersOf(g).some((b) => keepBuf.has(b))) { g.dispose(); geometries++; }
  const tex = new Set<THREE.Texture>();
  for (const m of mats) if (!keepMat.has(m)) { texturesOf(m, tex); m.dispose(); materials++; }
  for (const t of tex) if (!keepTex.has(t) && t.source.data !== null && (t.source.data as { data?: unknown }).data !== null) { t.dispose(); textures++; }
  return { geometries, materials, textures };
}
