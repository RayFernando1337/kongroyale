// poi-town: the furnished interiors of a town POI, drawn by the shared interiors kit (buildInteriors) from
// the SAME rooms the server furnishes (shared/pois/town-kit buildingRooms → interior-kit furnishRoom → colliders + loot).
// Mango Market alone has ~600 rooms (~1.4 s of furnishing + ~15 draws a batch), so the rooms are grouped in cells and a
// cell is furnished only when the camera comes within `buildDist` (one cell at a time, time-sliced, nearest first) and
// hidden beyond `showDist` by the kit. Screenshot pages (?view / ?cam / ?shot) hold readiness until every cell near the
// camera is built; `?nocull` (the parity tool) builds every cell up front.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import type { InteriorRoom } from "../../../../../shared/pois/interior-kit";
import { buildInteriors } from "./interior";
import { flag } from "../../../flags";

export interface TownInteriorOpts { name: string; cell?: number; buildDist?: number; showDist?: number }

export function townInteriors(ctx: WorldCtx, parent: THREE.Object3D, rooms: InteriorRoom[], o: TownInteriorOpts): { cells: number } {
  // (perf: a furnished room is ~20–30 k tris; interiors are seen through doors / windows from close by only — the kit's
  //  maxDist is measured from the cell's bounding SPHERE, so 14 m ≈ inside or right next to the cell's buildings)
  const cell = o.cell ?? 18, buildDist = o.buildDist ?? 55, showDist = o.showDist ?? 14;
  const cells = new Map<string, { x: number; z: number; rooms: InteriorRoom[]; state: 0 | 1 | 2; g?: THREE.Group; top: number }>();
  for (const r of rooms) {
    const k = `${Math.floor(r.x / cell)},${Math.floor(r.z / cell)}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { x: 0, z: 0, rooms: [], state: 0, top: -1e9 }));
    c.top = Math.max(c.top, r.y + r.h);
    c.rooms.push(r);
  }
  for (const c of cells.values()) { c.x = c.rooms.reduce((a, r) => a + r.x, 0) / c.rooms.length; c.z = c.rooms.reduce((a, r) => a + r.z, 0) / c.rooms.length; }
  const list = [...cells.values()];
  const root = new THREE.Group(); root.name = `${o.name}:interiors`; parent.add(root);
  let busy = false;
  const eager = flag("nocull");
  const buildCell = async (c: (typeof list)[number]) => {
    c.state = 1;
    // (perf: each cell its own group, hidden while the camera is well ABOVE every ceiling in it — from a roof
    //  nobody sees into the rooms below; the poi-12 view camera has ~360 k tris of furniture under it)
    c.g = new THREE.Group(); c.g.name = `${o.name}:int-cell`; root.add(c.g);
    try { await buildInteriors(ctx, c.rooms, { parent: c.g, name: `${o.name}:int`, maxDist: showDist }); } catch (e) { console.warn(`[${o.name}] interiors failed`, e); }
    c.state = 2;
  };
  const pending = (maxD: number) => {
    const p = ctx.camera.position;
    return list.filter((c) => c.state === 0 && Math.hypot(c.x - p.x, c.z - p.z) < maxD).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
  };
  if (!eager) ctx.onUpdate(() => { const cy = ctx.camera.position.y; for (const c of list) if (c.g) c.g.visible = cy < c.top + 1.2; });
  if (eager) { void (async () => { const rel = ctx.hold(`${o.name}:interiors`); for (const c of list) await buildCell(c); rel(); })(); return { cells: list.length }; }
  // screenshot pages: hold until the cells around the (final) view camera are furnished
  let release: (() => void) | null = ctx.shotMode ? ctx.hold(`${o.name}:interiors`) : null;
  let frames = 0;
  ctx.onUpdate(() => {
    frames++;
    if (busy || (release && frames < 3)) return;
    const next = pending(buildDist)[0];
    if (!next) { if (release) { release(); release = null; } return; }
    busy = true;
    void buildCell(next).then(() => { busy = false; });
  });
  return { cells: list.length };
}
