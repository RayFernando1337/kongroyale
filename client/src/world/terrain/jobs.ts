// Terrain build jobs OFF the main thread: 6 splat row bands + a finisher, the rock list and the
// layer textures, all in terrain.worker.ts. load.ts starts them the moment island.bin is decoded (boot), index.ts
// build() awaits them; any failure → null → the in-thread path.
import type { RockInstance, TerrainData } from "../../../../shared/world/terrain-gen";
import { assetUrl } from "../../engine/assets";
import { layerSources } from "./textures";

let JOBS: { gpuJob: ReturnType<typeof gpuInWorkers>; rockJob: Promise<({ hash: number; rocks: RockInstance[] } & { ms: number }) | null>; texJob: Promise<({ alb: Uint8Array; nor: Uint8Array } & { ms: number }) | null> } | null = null;
/** start the terrain workers (idempotent): load.ts calls it the moment island.bin is decoded, so the splat
 * bands, the rock list and the layer textures are ready (or nearly) when the module's build() runs */
export function startTerrainJobs(t: TerrainData) {
  if (JOBS) return JOBS;
  const url = new URL(assetUrl("assets/terrain/island.bin"), location.href).href;
  // the rock list and the layer textures are the build's critical path (the rock meshes wait for them): start them first
  const rockJob = runWorker<{ hash: number; rocks: RockInstance[] }>({ kind: "rocks", url, keep: t.keep });
  const texJob = runWorker<{ alb: Uint8Array; nor: Uint8Array }>({ kind: "tex", ...layerSources() });
  JOBS = { gpuJob: gpuInWorkers(url, t.res), rockJob, texJob };
  return JOBS;
}

export function releaseTerrainJobs() { JOBS = null; }

/** the splat data in 6 row bands + a finisher (terrain.worker.ts); null (→ in-thread) on any failure or hash mismatch */
async function gpuInWorkers(url: string, res: number): Promise<{ hash: number; dat: Uint8Array; w: Uint8Array; res: number; ms: number } | null> {
  const T0 = performance.now();
  let fin: Worker;
  try { fin = new Worker(new URL("./terrain.worker.ts", import.meta.url), { type: "module" }); } catch (e) { console.warn("[terrain] no worker:", e); return null; }
  fin.postMessage({ kind: "finish", url });
  const cuts = [0, 0.2, 0.33, 0.45, 0.58, 0.74, 1].map((f) => Math.round(res * f));   // 6 bands, balanced by measured cost
  const bands = await Promise.all(cuts.slice(0, -1).map((i0, b) => runWorker<{ hash: number; i0: number; i1: number; data: Uint8Array; info: Uint8Array; W: Float32Array[] }>({ kind: "band", url, i0, i1: cuts[b + 1] })));
  if (bands.some((b) => !b) || new Set(bands.map((b) => b!.hash)).size !== 1) { fin.terminate(); return null; }
  return new Promise((resolve) => {
    fin.onmessage = (ev) => { const d = ev.data; if (!d.ok) console.warn("[terrain] finisher failed:", d.error); resolve(d.ok ? { ...d, ms: Math.round(performance.now() - T0) } : null); fin.terminate(); };
    fin.onerror = (e) => { console.warn("[terrain] finisher error:", e.message); resolve(null); fin.terminate(); };
    const bs = bands.map((b) => ({ i0: b!.i0, i1: b!.i1, data: b!.data, info: b!.info, W: b!.W }));
    fin.postMessage({ kind: "bands", bands: bs }, bs.flatMap((b) => [b.data.buffer, b.info.buffer, ...b.W.map((a) => a.buffer)]));
  });
}

/** run one terrain.worker.ts job; null (→ the in-thread fallback) on any failure */
function runWorker<T>(msg: unknown): Promise<(T & { ms: number }) | null> {
  return new Promise((resolve) => {
    try {
      const w = new Worker(new URL("./terrain.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<{ ok: boolean; error?: string } & T & { ms: number }>) => {
        if (!ev.data.ok) console.warn("[terrain] worker failed, building in-thread:", ev.data.error);
        resolve(ev.data.ok ? ev.data : null); w.terminate();
      };
      w.onerror = (e) => { console.warn("[terrain] worker error, building in-thread:", e.message); resolve(null); w.terminate(); };
      w.postMessage(msg);
    } catch (e) { console.warn("[terrain] no worker:", e); resolve(null); }
  });
}

