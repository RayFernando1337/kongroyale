// POI PEEL HARBOR — container port (SE). Layout + colliders: shared/pois/peel-harbor.ts. Parts: ./parts.ts.
// Everything is built in the HARBOR-LOCAL frame (berth toward local +X) inside one group that carries the frame
// transform (FRAME: berth → world south, the inlet). View camera poi-01-peel-harbor: over the inlet SW of the port,
// looking NE: berth receding right with the ship (bow toward the camera), cranes centre, stacked yard, warehouses +
// tanks left/back, the headland's jungle bottom-left, the east beach far right.
// Dev: `?harborOnly=crane,ship` builds only those parts (plus the apron) for isolated captures; wip-harbor-* views.
import * as THREE from "three";
import type { WorldModule } from "../../module";
import type { CamSpec } from "../../../engine/views";
import { APRON_Y, CONTAINERS, FRAME, INTERIOR_ROOMS, ROOM_LAYOUTS, SHIP_CONTAINERS, WAREHOUSES, toWorld, whToWorld } from "../../../../../shared/pois/peel-harbor";
import type { InteriorLayout, InteriorRoom } from "../../../../../shared/pois/interior-kit";
import { buildInteriors } from "../_kit/interior";
import { harborMatsAsync } from "../_kit/harbor-materials";
import { containerTexAsync } from "../_kit/containers-tex";
import { c1Caster, farBakeStandInAsync, freezeStatic } from "../_kit/harbor-geo";
import { ContainerKit } from "../_kit/containers";
import { prepareBananaSkin, useBananaRenderer } from "../_kit/harbor-bananas";
import { loadParts, type PartCtx } from "./parts";
import { dressBeach } from "./beach";
import { HarborLod } from "./lod";
import { setFinePre } from "./apron-fine";
import { workerPool } from "../../../engine/worker-pool";
import { flag } from "../../../flags";

/** a camera authored in harbor-local coordinates → world CamSpec */
const L = (pos: [number, number, number], target: [number, number, number], fov: number, note: string): CamSpec => {
  const [px, pz] = toWorld(pos[0], pos[2]), [tx, tz] = toWorld(target[0], target[2]);
  return { pos: [px, pos[1], pz], target: [tx, target[1], tz], fov, note };
};

const views: Record<string, CamSpec> = {
  // (close + low — the foreground stacks, the pallet field and the pier fill the lower left; from higher up the
  // yard reads as a carpet of small boxes)
  "poi-01-peel-harbor": L([955, 32, 482], [848, 10, 390], 54, "over the inlet SW of the port looking NE: pier + foreground stacks bottom-left, berth receding right with the ship, cranes centre, warehouses/tanks left"),
  // dev views (harbor-local)
  "wip-harbor-crane": L([919, 22, 440], [874, 26, 392], 55, "near crane from the near end, low"),
  "wip-harbor-crane-top": L([852, 36, 410], [880, 40, 392], 60, "girder walkway + A-frame"),
  "wip-harbor-yard": L([878, 6, 462], [810, 4, 400], 60, "yard from the pier approach"),
  "wip-harbor-ship": L([955, 18, 420], [903, 10, 340], 55, "ship bow + deck stacks"),
  "wip-harbor-wh": L([846, 9, 462], [800, 6, 442], 55, "yellow warehouse door wall"),
  "wip-harbor-wh-in": L([800, 5.4, 428], [800, 4.4, 454], 70, "yellow warehouse interior"),
  "wip-harbor-tanks": L([800, 16, 468], [752, 8, 455], 55, "tank farm"),
  "wip-harbor-pier": L([935, 7, 492], [890, 3, 458], 55, "pier + rocks"),
  "wip-harbor-lane": L([825, 1.8 + APRON_Y, 405], [825, 3 + APRON_Y, 300], 72, "kong eye in a yard lane"),
  "wip-harbor-container": L([882, 1.9 + APRON_Y, 459], [873, 1.5 + APRON_Y, 452], 60, "hero stack close-up (1 m detail)"),
  "wip-harbor-top": L([720, 560, 256], [720, 0, 255], 50, "layout overview from above"),
  "wip-harbor-aerial": L([690, 175, 720], [745, 0, 300], 52, "high oblique from over the headland: terminal wrapped in jungle"),
  "wip-harbor-cross": L([853, 1.8 + APRON_Y, 311], [700, 2.5 + APRON_Y, 309], 72, "kong eye in a staggered cross lane (stair towers, block ends)"),
  "wip-harbor-reefer": L([762, 6, 236], [780, 5, 290], 60, "reefer row + rack gantry from the south"),
  "wip-harbor-chassis": L([700, 7, 190], [640, 2, 260], 60, "chassis park + gate"),
  "wip-harbor-laydown": L([700, 9, 330], [620, 2, 410], 60, "fenced lay-down yard + jungle breaking in"),
  "wip-harbor-tower": L([852, 3.2 + APRON_Y, 297], [848, 6 + APRON_Y, 312], 64, "stair tower up the A2 block end"),
  "wip-harbor-forklift": L([876.5, 1.7 + APRON_Y, 436.2], [878.5, 1.0 + APRON_Y, 440.5], 55, "hero forklift at 3 m"),
};

// dev views: eye level (1.7 m) in a corner of a furnished room looking across it, + parity probes (world)
const roomCam = (id: string): CamSpec | null => {
  const r = INTERIOR_ROOMS.find((q) => q.id === id);
  if (!r) return null;
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw), P = (lx: number, lz: number): [number, number] => [r.x + lx * c + lz * s, r.z - lx * s + lz * c];
  const [px, pz] = P(-r.w / 2 + 0.5, -r.d / 2 + 0.5), [tx, tz] = P(r.w / 2, r.d / 2);
  return { pos: [px, r.y + 1.7, pz], target: [tx, r.y + 0.9, tz], fov: 75, note: `eye level in ${id}` };
};
for (const id of ["wy-office", "wr-bay-ne", "wg-bay-w", "pump-house", "scale-house", "ship-0pa", "ship-0sf", "ship-1sa", "ship-3pf", "ship-3sa", "ship-4p"]) { const v = roomCam(id); if (v) views[`wip-harbor-room-${id}`] = v; }
views["wip-harbor-pf-forklift"] = { pos: [557, 5.4, 195.5], target: [554.89, 4.6, 197.12], fov: 62, note: "parity probe: forklift collider" };
views["wip-harbor-pf-cage"] = { pos: [563, 5.4, 191], target: [562.66, 4.6, 193.63], fov: 62, note: "parity probe: lashing cage" };
views["wip-harbor-pf-palm"] = { pos: [593, 5.4, 194], target: [595.37, 4.6, 194.31], fov: 62, note: "parity probe: palm trunk" };
views["wip-harbor-pf-chassis"] = { pos: [635, 5.4, 294.5], target: [633.25, 4.6, 292.22], fov: 62, note: "parity probe: chassis" };
// eye level in every warehouse hall (warehouse-local from the aisle walkway (−4, −5.6) toward (+14, +1.5))
for (const w of WAREHOUSES) {
  const P = (lx: number, lz: number) => toWorld(...whToWorld(w, lx, lz));
  const [px, pz] = P(-4, -5.6), [tx, tz] = P(14, 1.5);
  views[`wip-harbor-hall-${w.id}`] = { pos: [px, APRON_Y + 1.75, pz], target: [tx, APRON_Y + 1.0, tz], fov: 72, note: `eye level in hall ${w.id}` };
}
// parity probes (world)
for (const [n, c] of Object.entries({ sill: "603.5,5.4,528.5,605.27,4.6,530.8", boom: "602,32.8,531.5,603.88,32,531.75", fence: "528.5,5.4,359,528.12,4.6,361.94", cstack: "678.5,5.4,276.5,680.31,4.6,278.85", rack: "758,5.4,314,758.55,4.6,314.07", whwall: "453.5,5.4,396.5,455,4.6,396.7", ctop: "677,7.99,306.5,676.68,7.19,308.96", post: "579.5,5.4,435.5,581.7,4.6,435.79" })) {
  const v = c.split(",").map(Number); views[`wip-harbor-pf-${n}`] = { pos: [v[0], v[1], v[2]], target: [v[3], v[4], v[5]], fov: 62, note: `parity probe: ${n}` };
}

const mod: WorldModule = {
  id: "poi:peel-harbor",
  views,
  async build(ctx) {
    const group = new THREE.Group();
    group.name = "peel-harbor";
    group.position.set(FRAME.x, 0, FRAME.z);
    group.rotation.y = FRAME.yaw;
    group.updateMatrixWorld(true);
    ctx.scene.add(group);
    performance.mark("peel-harbor:build:start");
    performance.mark("peel-harbor:part:mats");
    // (the harbor + container textures are painted in worker threads meanwhile — and the slab's fine detail tile)
    let fineJob: Promise<unknown> = Promise.resolve();
    if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
      try {
        const fp = workerPool(() => new Worker(new URL("../_kit/harbor-tex.worker.ts", import.meta.url), { type: "module" }), 1);
        fineJob = fp.run<{ pk: Uint8Array; nk: Uint8Array }>("fine").then(setFinePre, (e) => console.warn("[peel-harbor] fine tile worker failed", e)).finally(() => fp.close());
      } catch { /* painted live */ }
    }
    const [mats] = await Promise.all([harborMatsAsync(), containerTexAsync(), fineJob]);
    await ctx.yield();
    performance.mark("peel-harbor:part:kit");
    useBananaRenderer(ctx.renderer);
    await prepareBananaSkin(() => ctx.yield());
    const kit = new ContainerKit();
    const only = flag("harborOnly");
    if (!only || only.includes("yard")) kit.addMany(CONTAINERS);
    if (!only || only.includes("ship")) kit.addMany(SHIP_CONTAINERS);
    const lod = new HarborLod(group);
    const p: PartCtx = { ctx, mats, kit, group, apronY: APRON_Y, lod, c1: [] };
    const parts = await loadParts();
    await ctx.yield();
    for (const part of parts) {
      if (only && part.id !== "apron" && !only.includes(part.id)) continue;
      const t0 = performance.now();
      performance.mark(`peel-harbor:part:${part.id}`);
      try { await part.build(p); } catch (e) { console.error(`[peel-harbor] part ${part.id} failed`, e); }
      const ms = performance.now() - t0;
      if (ms > 250) console.warn(`[peel-harbor] part ${part.id} took ${ms.toFixed(0)} ms`);
      await ctx.yield();
    }
    performance.mark("peel-harbor:part:rooms");
    // the furnished rooms (shared interiors kit) — one build per building so each culls on its own distance
    if (!only || only.includes("rooms")) {
      const byBuilding = new Map<string, InteriorRoom[]>();
      // (the ship's 18 rooms in three calls by deck pairs: one call would furnish them in ~0.6 s main-thread chunks)
      for (const r of INTERIOR_ROOMS) { const id = r.id ?? "room", k = id.startsWith("ship-") ? `ship${Math.floor(Number(id[5]) / 2)}` : id.split("-")[0]; byBuilding.set(k, [...(byBuilding.get(k) ?? []), r]); }
      // (the bake's layouts — no furnishRoom on the main thread)
      const lay = ROOM_LAYOUTS(), at = new Map(INTERIOR_ROOMS.map((r, i) => [r, lay[i]]));
      for (const [k, rooms] of byBuilding) { await buildInteriors(ctx, rooms, { name: `peel-harbor-rooms-${k}`, maxDist: 80, layouts: rooms.map((r) => at.get(r)!) as InteriorLayout[] }); await ctx.yield(); }
    }
    performance.mark("peel-harbor:part:containers");
    // full model within 18 m (perf). ONE bucket per size (perf: per-96 m cells cost 34–48 draw calls a frame —
    // near + LOD box + caster per cell and size — for culling that saved a few thousand 30-tri boxes; the draw calls,
    // not the triangles, are what the harbor pays for on ANGLE/Metal)
    // (`?nocull` = the parity tool: full models everywhere, like the harbor's other detail tiers)
    const set = await kit.buildAsync({ name: "harbor-containers", lod: flag("nocull") ? 400 : flag("ctLod"), midLod: flag("ctMid"), cell: 4096, shadowDist: 60 }, () => ctx.yield());
    group.add(set);
    lod.containers(set);
    await ctx.yield();
    // (pop-proof: no 170 m swap of the whole yard + ship deck to ONE vertex-coloured box mesh — every
    // glide / drop would cross it and the stacks change shade in one go; the set's own LOD boxes are the far tier)
    lod.add(set, {});
    await ctx.yield();
    // (HLOD: each detail group — shed clusters, tank farm, lamps — pairs with its own far proxy in its part file)
    // perf: ONE cascade-1 caster for the crane / sheds / tanks / masts, from their coarse proxies (1 draw in c1 instead
    // of a detailed caster per group and 100 m cell; the far map + cascade 0 keep the detailed silhouettes)
    const c1 = c1Caster(p.c1, group, "harbor-c1");
    if (c1) group.add(c1);
    await ctx.yield();
    performance.mark("peel-harbor:part:beach+c1");
    if (!only || only.includes("beach")) await dressBeach(p);
    await ctx.yield();
    // every static caster goes into the far shadow map through ONE force-shown stand-in (LOD / off-screen culling
    // of the live groups can no longer drop parts of the POI from the far map)
    performance.mark("peel-harbor:part:farbake");
    await farBakeStandInAsync(group, () => ctx.yield());
    await ctx.yield();
    performance.mark("peel-harbor:part:finish");
    await lod.finishAsync(() => ctx.yield());
    // (perf: nothing in the port moves — bake every matrix once instead of recomposing ~380 objects a frame)
    freezeStatic(group);
    performance.mark("peel-harbor:build:end");
    ctx.onUpdate(() => lod.update(ctx.camera));
  },
};
export default mod;
