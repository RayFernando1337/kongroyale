// POI coco-caves — COCO CAVES: a sea-cave / lava-tube system inside a POI-owned rock massif.
// Layout + colliders: shared/pois/coco-caves.ts (the server collides with exactly these boxes). Visuals:
//   rock.ts    the massif (baked SDF surface of the collider boxes) — hi / far LOD
//   light.ts   the baked light volume (sky / sun visibility + occluded lamp light) patched into every POI material
//   ground.ts  the cave floor skin + the tidal pool
//   timber.ts  decks, stairs, the den + mine office, the hoist tower + headframe, props
//   fx.ts      crystals, the lava fall, god rays + motes, creepers
// Greenery goes through the veg area's API (palms / monstera / ferns in the skylight's light, bushes + palms on top).
import * as THREE from "three";
import type { WorldModule } from "../../module";
import type { WorldCtx } from "../../../engine/engine";
import type { CamSpec } from "../../../engine/views";
import type { VegApi, PlantKind } from "../../veg/api";
import { POIS } from "../../../../../shared/world/map";
import { ROCKS, bakeHash, roofBottom, VIEW, INTERIOR_ROOMS, DEN, TOWER, SKY, GALLERY, OFFICE, TUNNELS, HALL_C, groundAt, floorAt, insidePoly, POOL, topAt, hutToWorld, galleryW, WATER_Y, hallDist } from "../../../../../shared/pois/coco-caves";
import { loadCaveLight } from "./light";
import { rockMaterial, loadRock, LOD_FAR } from "./rock";
import { buildFloor, buildPool } from "./ground";
import { timberMats, buildTimber } from "./timber";
import { buildFx } from "./fx";
import { mulberry } from "../_kit/jungle-mat";
import { buildInteriors } from "../_kit/interior";
import { buildSculpted } from "./sculpt";
import { cavePatch } from "./light";
import { flag } from "../../../flags";

type V3 = [number, number, number];
const eye = (x: number, z: number, y?: number): V3 => [x, (y ?? floorAt(x, z)) + 1.8, z];
const views: Record<string, CamSpec> = {
  "poi-14-coco-caves": { pos: VIEW.pos, target: VIEW.target, fov: VIEW.fov, t: 12, note: "establishing view: jetty root, looking north over the pool at the skylight" },
  "caves-aerial": { pos: [-628, 150, -214], target: [-721, 52, -318], fov: 50, t: 12 },
  "caves-ext-south": { pos: [-706, 54, -258], target: [-720, 55, -284], fov: 60, t: 12 },
  "caves-plane": { pos: [-700, 430, -120], target: [-721, 50, -318], fov: 50, t: 12 },
  "caves-eye-mouth": { pos: eye(-690.5, -281.5), target: [-712, 50, -312], fov: 72, t: 12, note: "outside the SE mine mouth, looking in" },
  "caves-eye-hall": { pos: eye(-707.5, -296.5), target: [-735, 52, -334], fov: 72, t: 12 },
  "caves-eye-den": { pos: (() => { const [x, z] = hutToWorld(DEN, 3.6, 2.6); return [x, DEN.y + 1.75, z] as V3; })(), target: (() => { const [x, z] = hutToWorld(DEN, -4, -2.5); return [x, DEN.y + 1.2, z] as V3; })(), fov: 75, t: 12 },
  "caves-eye-gallery": { pos: (() => { const [x, z] = galleryW(4.5, 0.5); return eye(x, z, GALLERY.y); })(), target: [-712, 47, -310], fov: 72, t: 12 },
  "caves-eye-tower": { pos: eye(TOWER.x + 0.6, TOWER.z - 2, TOWER.yb + TOWER.flights * TOWER.rise), target: [-705, 46, -304], fov: 72, t: 12 },
  "caves-eye-west": { pos: eye(-768, -316.5), target: [-725, 50, -318], fov: 72, t: 12 },
  "caves-eye-lava": { pos: eye(-705.5, -347), target: [-699.5, 50, -359], fov: 72, t: 12 },
  "caves-eye-roof": { pos: eye(-744, -318, topAt(-744, -318)), target: [-700, 66, -330], fov: 72, t: 12 },
  "caves-eye-office": { pos: (() => { const [x, z] = hutToWorld(OFFICE, 1.6, 1.3); return [x, OFFICE.y + 1.7, z] as V3; })(), target: (() => { const [x, z] = hutToWorld(OFFICE, -2, -1.5); return [x, OFFICE.y + 1.0, z] as V3; })(), fov: 78, t: 12 },
};

function plantAll(ctx: WorldCtx) {
  const veg = ctx.shared.get("veg") as VegApi | undefined; if (!veg) return;
  const rnd = mulberry(2024), P: Partial<Record<PlantKind, THREE.Matrix4[]>> = {};
  const add = (k: PlantKind, x: number, z: number, s = 1, y?: number, yaw?: number) => { if (y === undefined && insidePoly(POOL, x, z) && floorAt(x, z) < WATER_Y + 0.2) return; (P[k] ??= []).push(new THREE.Matrix4().compose(new THREE.Vector3(x, y ?? floorAt(x, z), z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw ?? rnd() * 6.28, 0)), new THREE.Vector3(s, s, s))); };
  // inside, where the skylight / mouths give them light: the palm by the pool, monstera + ferns on the banks
  // (the regraded basin is all pool — the greenery stands on the north beach, the west shelf, the south-east bank)
  add("palm-leaning", -737.6, -320.6, 1.05, undefined, 2.4);
  // (the hall's monstera / ferns are the POI's own 3D clumps (PROPS "monstera" / "fern", timber.ts); veg adds the banana
  //  plants and flowers)
  for (const [x, z, k] of [[-711.8, -298.6, "banana-plant"], [-723.0, -337.9, "flowers"], [-710.0, -340.4, "banana-plant"], [-738.6, -330.2, "banana-plant"], [-700.2, -308.4, "flowers"]] as Array<[number, number, PlantKind]>) add(k, x, z, 0.9 + rnd() * 0.3);
  // mouths: ferns + monstera spilling in
  for (const t of TUNNELS) for (let i = 0; i < 6; i++) { const u = 0.7 + rnd() * 0.5, s = (rnd() - 0.5) * t.width * 0.9; const x = t.a[0] + (t.b[0] - t.a[0]) * u + s * 0.3, z = t.a[1] + (t.b[1] - t.a[1]) * u + s; add(rnd() < 0.6 ? "fern" : "monstera", x, z, 0.8 + rnd() * 0.4); }
  // the plateau top: palms, jungle trees at the edge, bushes + ferns (cover), ferns hanging at the skylight rim
  for (let i = 0; i < 420; i++) {
    const x = -762 + rnd() * 88, z = -358 + rnd() * 82;
    if (hallDist(x, z) < -6 || Math.hypot(x - SKY.x, z - SKY.z) < SKY.r + 1.5 || Math.hypot(x + 749, z + 340) < 10) continue;
    add(rnd() < 0.55 ? "grass" : "groundcover", x, z, 0.9 + rnd() * 0.6, topAt(x, z) - 0.05);
  }
  for (let i = 0; i < 110; i++) {
    const x = -760 + rnd() * 84, z = -356 + rnd() * 78, y = topAt(x, z);
    if (hallDist(x, z) < -7 || Math.hypot(x - SKY.x, z - SKY.z) < SKY.r + 1.8) continue;
    if (Math.hypot(x - TOWER.x, z - TOWER.z) < 5) continue;
    const nearSky = Math.hypot(x - SKY.x, z - SKY.z) < SKY.r + 18;   // keep the skylight + headframe readable from the air
    const q = rnd(); if (nearSky && q < 0.55) continue;   // only low ferns / banana plants near the hole
    // (no crowns within 38 m — the skylight + crown read from the plane)
    if (q < 0.2 && Math.hypot(x - SKY.x, z - SKY.z) < SKY.r + 30) continue;
    add(q < 0.2 ? "palm" : q < 0.55 ? "bush" : q < 0.85 ? "fern" : "banana-plant", x, z, 0.7 + rnd() * 0.5, y - 0.1);
  }
  for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2 + 0.3, r = SKY.r + 1.2 + rnd(); add("fern", SKY.x + Math.cos(a) * r, SKY.z + Math.sin(a) * r, 1.0 + rnd() * 0.3, SKY.y1 - 0.1); }
  // every EXTERIOR tier ledge under the plateau (walls,
  //  buttresses, tunnel walls outside the hall) is overgrown — bushes, ferns, banana plants (no colliders) — so the stepped
  //  shoulders read as jungle-covered cliff shelves, not cut terraces
  const solid = ROCKS.filter((r) => !r.ghost && r.tag !== "bed");
  const inRock = (x: number, y: number, z: number) => solid.some((r) => { if (Math.abs(y - r.c[1]) > r.h[1] || Math.abs(x - r.c[0]) > 14 || Math.abs(z - r.c[2]) > 14) return false; const c = Math.cos(r.yaw), s = Math.sin(r.yaw), dx = x - r.c[0], dz = z - r.c[2]; return Math.abs(dx * c - dz * s) < r.h[0] && Math.abs(dx * s + dz * c) < r.h[2]; });
  for (const r of ROCKS) {
    if (r.tag !== "wall" && r.tag !== "buttress" && r.tag !== "tunnel") continue;
    const top = r.c[1] + r.h[1];
    if (top > topAt(r.c[0], r.c[2]) - 1.2 || top < groundAt(r.c[0], r.c[2]) + 2.5 || hallDist(r.c[0], r.c[2]) > -3) continue;
    const c = Math.cos(r.yaw), s = Math.sin(r.yaw), n = Math.max(2, Math.round(r.h[0] * r.h[2] * 4 / 6));
    for (let i = 0; i < n; i++) {
      const lx = (rnd() * 2 - 1) * Math.max(0.2, r.h[0] - 0.5), lz = (rnd() * 2 - 1) * Math.max(0.2, r.h[2] - 0.5), x = r.c[0] + lx * c + lz * s, z = r.c[2] - lx * s + lz * c;
      if (inRock(x, top + 0.6, z) || hallDist(x, z) > -2) continue;
      const q = rnd(); add(q < 0.45 ? "bush" : q < 0.8 ? "fern" : "banana-plant", x, z, 0.75 + rnd() * 0.45, top - 0.08);
    }
  }
  for (const [k, list] of Object.entries(P)) veg.plant(k as PlantKind, list!);
}

const mod: WorldModule = {
  id: "poi:coco-caves",
  views,
  async build(ctx: WorldCtx) {
    const t0 = performance.now();
    const group = new THREE.Group(); group.name = "coco-caves"; ctx.scene.add(group);
    loadCaveLight(ctx);
    const rock = new THREE.Group(); rock.name = "caves-rock"; group.add(rock);
    const detail = new THREE.Group(); detail.name = "caves-detail"; group.add(detail);
    const rmat = rockMaterial(ctx);
    // time-sliced (no main-thread task > 50 ms while the title is up)
    // the boulder clusters + plateau outcrops: chiselled rocks round their collider boxes (not in the bake)
    // (streamed after the build like rock.bin and the kit rooms: ~80 ms of geometry work in ≤ 15 ms slices; readiness waits)
    { const release = ctx.hold("coco-caves:sculpt");
      void buildSculpted(rmat, () => ctx.yield()).then((sc) => { if (sc.low) detail.add(sc.low); if (sc.high) rock.add(sc.high); })
        .catch((e) => console.warn("[coco-caves] sculpted rocks failed", e)).finally(release); }
    // per-phase CPU ms (the console line at the end; yields excluded)
    const ph: Record<string, number> = {}; let tp = performance.now(); const mark = (k: string) => { const n = performance.now(); ph[k] = Math.round(n - tp); }; const go = () => { tp = performance.now(); };
    buildFloor(ctx, detail); mark("floor"); await ctx.yield(); go();
    buildPool(ctx, detail); mark("pool"); await ctx.yield(); go();
    const mats = timberMats(ctx);
    const tb = await buildTimber(ctx, detail, mats); mark("timber"); await ctx.yield(); go();
    buildFx(ctx, group); mark("fx"); await ctx.yield(); go();
    plantAll(ctx); mark("plants"); await ctx.yield(); go();
    // the den + mine office rooms: the shared interiors kit (its materials are global — each mesh takes a cave-lit clone)
    // (the rooms are only ever seen through a door or a window — drawn within 30 m, ~45 draws × 2 passes saved
    //  from the rest of the hall; the huts' own plank walls close them beyond)
    void buildInteriors(ctx, INTERIOR_ROOMS, { parent: detail, name: "caves-interiors", maxDist: 30 }).then((ib) => {
      const done = new Map<THREE.Material, THREE.Material>();
      // no sun patch through a window under the vault: drop the kit's window-light decals (removed, not hidden — the kit's
      // distance toggle would switch them back on)
      // (the kit's lamp light pools on floors / ceilings (":fx") read as white blotches under the
      //  vault — the cave's baked lamp light lights these rooms; removed with the window patches)
      ib.group.children.filter((o) => /:fx(win|wash)?$/.test(o.name)).forEach((o) => o.removeFromParent());
      // (the kit's plank ceiling is the panel walls' board texture with a
      //  WHITE vertex colour (walls take the room's brown) — under the vault it read 1.5× the walls' luma. Its down-facing
      //  board vertices take the wall tone here, in this POI's own room meshes only)
      ib.group.traverse((o) => {
        const m = o as THREE.Mesh, g = m.isMesh ? m.geometry : null, mat = m.isMesh ? (m.material as THREE.Material) : null;
        if (!g || !mat || Array.isArray(m.material) || !/fl-boards/.test(mat.name)) return;
        const col = g.getAttribute("color") as THREE.BufferAttribute | undefined, nor = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
        if (!col || !nor) return;
        for (let i = 0; i < col.count; i++) if (nor.getY(i) < -0.9 && col.getX(i) > 0.9 && col.getY(i) > 0.9) col.setXYZ(i, col.getX(i) * 0.72, col.getY(i) * 0.6, col.getZ(i) * 0.48);
        col.needsUpdate = true;
      });
      ib.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || Array.isArray(m.material) || !(m.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;   // (glow / fx are unlit basics)
        let c = done.get(m.material);
        if (!c) { const src = m.material; c = src.clone(); c.onBeforeCompile = src.onBeforeCompile; const k = src.customProgramCacheKey.bind(src); c.customProgramCacheKey = k; cavePatch(c); done.set(src, c); }
        m.material = c;
      });
    }).catch((e) => console.warn("[coco-caves] interiors failed", e));
    // LOD: the hi rock + all the interior detail within LOD_FAR of the hall; the 1.6 m rock beyond (crystals and
    // halos stay: the landmark's glow)
    const C = new THREE.Vector3(HALL_C[0], 55, HALL_C[1]);
    let far: boolean | null = null, rocks: { hi: THREE.Mesh[]; lo: THREE.Mesh[]; shadow?: THREE.Mesh } | null = null;
    // the interior detail (timber, floor, pool, props) is only ever seen through the openings: gone beyond DETAIL_FAR
    const DETAIL_FAR = 190;
    const apply = () => { if (!rocks) return; for (const m of rocks.hi) m.visible = !far; for (const m of rocks.lo) m.visible = !!far; };
    let dFar: boolean | null = null;
    ctx.onUpdate(() => { const f = ctx.camera.position.distanceTo(C) > DETAIL_FAR; if (f !== dFar) { dFar = f; detail.visible = !f; } });
    loadRock(ctx, rock, rmat, (r) => {
      rocks = r; apply();
      if (r.hash !== bakeHash()) console.warn(`[coco-caves] rock/light bake is stale for this layout (bin ${r.hash}, layout ${bakeHash()}) — re-bake: node --import tsx tools/caves/bake-rock.mts`);
      console.info(`[coco-caves] rock ${r.hi.length} hi chunks, ${Math.round(r.tris / 1000)} k tris`);
    });
    ctx.onUpdate(() => { const f = ctx.camera.position.distanceTo(C) > LOD_FAR; if (f !== far) { far = f; apply(); } });
    // INSIDE the hall (under the vault, walls all round) no other POI can be seen — the only openings look at the jungle
    // next door, the sea or straight up — so their roots switch off (their far proxies follow, hlod.ts) while we are in
    // here (the banana-temple vault does the same). ~1–1.5 M triangles and 200–350 draws off at eye level in the den.
    { const others = new Set(POIS.map((p) => p.id).filter((id) => id !== "coco-caves"));
      let inside = false, hidden: THREE.Object3D[] = [];
      ctx.onUpdate(() => {
        const c = ctx.camera.position, now = hallDist(c.x, c.z) > 1.0 && c.y < roofBottom(c.x, c.z) - 0.5 && c.y > groundAt(c.x, c.z) - 1;
        if (now === inside) return; inside = now;
        if (now) { hidden = ctx.scene.children.filter((o) => o.visible && others.has(o.name.replace(/^poi:/, "") as never)); for (const o of hidden) o.visible = false; }
        else { for (const o of hidden) o.visible = true; hidden = []; }
        if (rocks?.shadow) rocks.shadow.visible = !now;
        // (under the vault the sun only reaches the skylight's patch, which is baked — no shadow-map draws for the
        //  timber / interiors / props while inside; outside (plateau, headframe) they cast again)
        detail.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (m.userData.cs === undefined) m.userData.cs = m.castShadow; m.castShadow = now ? false : m.userData.cs; } });
      }); }
    // ablation hook: ?cavesHide=rock,water,timber,… hides the POI's named parts for A/B GPU timing
    { const hide = flag("cavesHide");
      if (hide.length) ctx.onUpdate(() => { group.traverse((o) => { if (hide.some((h) => o.name.includes(h))) o.visible = false; }); }); }
    mark("tail");
    console.info(`[coco-caves] build ${Math.round(performance.now() - t0)} ms (cpu ${JSON.stringify(ph)}), ${tb.draws} timber draws, water ${WATER_Y}`);
  },
};
export default mod;
