// The loot-spot worker: started by the boot at t = 0 next to the static-world worker; the game adopts
// its set for its own static world when the hashes match (see lootspots.worker.ts). Nothing else changes: without a
// result (worker error, hash mismatch, a click before it ends) the game's in-thread idle build runs.
import type { StaticWorld } from "../../../shared/sim/world";
import { adoptLootSpots, type SpotSet } from "../../../shared/sim/loot-spots";
import { assetUrl } from "./assets";
import { flag } from "../flags";

interface Result { ok: boolean; hash?: number; set?: SpotSet; worldMs?: number; spotsMs?: number; error?: string }
let job: Promise<Result> | null = null;

/** start the worker (idempotent; ?nolootworker = off) */
export function startLootSpotsWorker() {
  if (job || flag("nolootworker")) return;
  job = new Promise<Result>((resolve) => {
    try {
      const w = new Worker(new URL("./lootspots.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<Result>) => { resolve(ev.data); w.terminate(); };
      w.onerror = (e) => { resolve({ ok: false, error: String(e.message || e) }); w.terminate(); };
      w.postMessage({ url: new URL(assetUrl("assets/terrain/island.bin"), location.href).href });
    } catch (e) { resolve({ ok: false, error: String(e) }); }
  });
}

/** when the worker's set is for THIS world (same static-world hash), hand it to shared/sim/loot-spots (no in-thread build) */
export function adoptWorkerLootSpots(world: StaticWorld, worldHash: number) {
  if (!job) return;
  const kr = (globalThis as unknown as { __kr?: Record<string, unknown> }).__kr;
  void job.then((r) => {
    if (r.ok && r.set && r.hash === worldHash) { adoptLootSpots(world, r.set); if (kr) kr.lootWorker = { adopted: true, worldMs: r.worldMs, spotsMs: r.spotsMs, at: Math.round(performance.now()) }; }
    else { if (kr) kr.lootWorker = { adopted: false, why: r.ok ? `hash ${r.hash} != ${worldHash}` : r.error }; if (!r.ok) console.warn("[loot-spots worker]", r.error); }
  });
}
