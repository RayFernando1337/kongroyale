import * as THREE from "three";
import type { Poi } from "../../shared/world/map";
import { Phase } from "../../shared/sim/match";
import type { Engine } from "./engine/engine";
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
  let best: string | null = null, bestD = Infinity;
  pickedByView = false;
  for (const id of pending) {
    const p = pois.find((x) => `poi:${x.id}` === id);
    if (!p) { pickedByView = false; return id; }
    const d = Math.hypot(e[12] - p.x, e[14] - p.z) - p.r;
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

type World = {
  modOf: Map<string, WorldModule>; scopeOf: Map<string, Scope>; rootsOf: Map<string, THREE.Object3D[]>;
  loaded: WorldModule[]; roots: (id: string) => THREE.Object3D[]; report: (where: string, e: unknown) => void;
};

export async function evictStreamed(engine: Engine, w: World, id: string) {
  const m = w.modOf.get(id)!, roots = w.roots(id);
  engine.removeUpdates(new Set(engine.hooksOf.get(id)));
  engine.occlusion.unregister(id);
  engine.far.evict(id);
  for (const r of roots) { engine.statics.unregister(r); engine.cull.unregister(r); r.removeFromParent(); }
  try { await m.release?.(engine); } catch (e) { w.report(`release:${id}`, e); }
  const freed = disposeUnused(roots, engine.scene);
  try { w.scopeOf.get(id)?.dispose(); } catch (e) { w.report(`release:${id}`, e); }
  for (const map of [w.modOf, w.scopeOf, w.rootsOf, engine.hooksOf]) map.delete(id);
  w.loaded.splice(w.loaded.indexOf(m), 1);
  engine.evicted.add(id);
  const kr = (globalThis as unknown as { __kr: { modules: string[]; evictions?: unknown[] } }).__kr;
  kr.modules = w.loaded.map((x) => x.id);
  (kr.evictions ??= []).push({ id, at: Math.round(performance.now()), ...freed });
}

let trimming = Promise.resolve();

export function trimStreamed(engine: Engine, w: World, room: number, pending: string[], streamMs: Record<string, number>, pois: readonly Poi[]) {
  return (trimming = trimming.then(async () => {
    const kr = (globalThis as unknown as { __kr?: Session }).__kr;
    if (kr?.game?.inMatch && (kr.game.cm?.phase ?? -1) < Phase.Play) return;
    for (;;) {
      const resident = [...w.modOf.keys()].filter((x) => x.startsWith("poi:") && streamMs[x] !== undefined);
      if (resident.length + room <= flag("lowmemcap")) return;
      const e = engine.camera.matrixWorld.elements;
      let victim: string | null = null, bestD = flag("lowmemr") + flag("lowmemhyst");
      for (const id of resident) {
        const p = pois.find((x) => `poi:${x.id}` === id);
        const d = p ? Math.hypot(e[12] - p.x, e[14] - p.z) - p.r : 0;
        if (d > bestD) { victim = id; bestD = d; }
      }
      if (!victim) return;
      await evictStreamed(engine, w, victim);
      pending.push(victim);
      delete streamMs[victim];
    }
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
    else if (m.geometry) geos.add(m.geometry);
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
