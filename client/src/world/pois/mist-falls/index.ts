// POI mist-falls — the waterfall gorge and the jungle river. Tall white falls pouring over a wall of
// sculpted blue-grey rock blocks into a turquoise plunge pool, spray + mist + rainbow, rope bridges across the gorge and
// the river, the thatched lookout, the north-bluff walkway and hoist, boulders, sandbars, a dugout canoe.
// Layout + colliders: shared/pois/jungle-falls.ts (FALLS) / shared/pois/mist-falls.ts. Everything adapts to the terrain.
import * as THREE from "three";
import { sliceMeter } from "../banana-temple/slices";
import type { WorldModule } from "../../module";
import type { CamSpec } from "../../../engine/views";
import type { VegApi, PlantKind } from "../../veg/api";
import { FALLS, resolveFalls, mulberry, LOOKOUT_STEP, type H } from "../../../../../shared/pois/jungle-falls";
import { LADDERS, LANDINGS } from "../../../../../shared/pois/ladders";
import { TRAIL_DIMS } from "../../../../../shared/pois/jungle-layout";
import { block, merge, staticMesh, type Geo } from "../_kit/jungle-geo";
import { layout as BAKED } from "../../../../../shared/pois/mist-falls";
import { stoneMaterial, pbr } from "../_kit/jungle-mat";
import { rockProtos, rockInstances, rockLOD3 } from "../_kit/jungle-rocks";
import { bindWaterTime } from "../_kit/jungle-water";
import { buildWater, buildSand, barHeight, RIVER_ROCK_RES, riverLevelAt } from "./water";
import { buildWood } from "./wood";
import { buildVeneer, strataPatch } from "./veneer";
import { distanceSwitch, noCast, type LodItem } from "../_kit/jungle-lod";
import { boundsLods } from "./rocklod";
import { ROCK_MERGE, mergedStoneMat, mergeRockLevel } from "./rockmerge";
import { flag } from "../../../flags";

const V = (pos: CamSpec["pos"], target: CamSpec["target"], o: Partial<CamSpec> = {}): CamSpec => ({ pos, target, fov: 50, ...o });

const root2 = (ctx: { scene: THREE.Scene }) => { let g = ctx.scene.getObjectByName("jungle-lab") as THREE.Group | undefined; if (!g) { g = new THREE.Group(); g.name = "jungle-lab"; ctx.scene.add(g); } return g; };
const mod: WorldModule = {
  id: "poi:mist-falls",
  views: {
    // from the lookout's bridge head on the south shoulder, across the gorge at the falls; bridge crossing
    // the frame, pool below, north bluff with walkway + hoist upper right
    // from beside the lookout deck — thatched lookout + flag in the left third, the gorge bridge sagging across
    // the lower middle, both falls centred and big, the walkway / hoist / high bridge top-right, the pool below
    "poi-09-mist-falls": V([-108, 40.2, -373.5], [-178, 38.5, -399], { fov: 58, note: "east of the lookout at eave height → the lookout left, the bridge across, the falls centred" }),
    // downstream on the right sandbar, looking upstream at the river bridge
    // standing on the cream sandbar at the waterline of the right (north) bank, looking upstream at the low
    // rope bridge ~28 m away (top third), the beached canoe right foreground, boulder clusters framing both banks
    "biome-06-river": V([-44, 18.0, -429.5], [-73, 14.8, -413.5], { fov: 58, note: "river: on the north sand terrace behind the canoe, upstream at the bridge" }),
    "falls-aerial": V([-90, 120, -330], [-160, 30, -405], { fov: 55, note: "dev: whole gorge from above" }),
    "falls-close": V([-150, 30, -392], [-178, 40, -397], { fov: 60, note: "dev: fall A close" }),
    "falls-pool": V([-140, 23.2, -385], [-180, 36, -405], { fov: 70, note: "dev: at the pool edge under the falls" }),
    "jungle-rocklab": V([2000, 306, 30], [2000, 300, 0], { fov: 50, stage: "jungle-rocklab", note: "dev: rock prototype lineup in the sky" }),
    "jungle-herolab": V([1996, 311, 128], [1995, 310, 100], { fov: 50, stage: "jungle-herolab", note: "dev: hero mesh lineup in the sky" }),
  },
  async stage(ctx, stage) {
    if (stage === "jungle-herolab") {
      const { hero } = await import("../_kit/jungle-hero");
      const g = root2(ctx);
      g.add(await hero(ctx, "gorilla-head", 1990, 298, 100, { height: 12, yaw: -Math.PI / 2 }));
      { const { heroStoneMaterial } = await import("../_kit/jungle-mat");
        g.add(await hero(ctx, "gorilla-head", 1990, 311, 100, { height: 12, yaw: -Math.PI / 2, material: (bm) => heroStoneMaterial(pbr(ctx, "temple-blocks"), bm.map, { scale: 8.5, bakeMix: 0.9, moss: 0.45, mossColor: "#7cbd3c", color: "#fff6e6", variation: 0.2, lift: 0.18 }, pbr(ctx, "moss")) })); }
      g.add(await hero(ctx, "totem", 2003, 298, 100, { height: 10, yaw: -Math.PI / 2 }));
      g.add(await hero(ctx, "guardian", 2011, 298, 100, { height: 9, yaw: -Math.PI / 2 }));
      g.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m && flag("dside")) m.side = THREE.DoubleSide; });
      { const { goldMaterial } = await import("../_kit/jungle-gold");   // gold swatches: roughness 0.15 / 0.25 / 0.35
        [0.15, 0.25, 0.35].forEach((r, i) => { const s2 = new THREE.Mesh(new THREE.SphereGeometry(1.4, 48, 24), goldMaterial(ctx.renderer, { roughness: r })); s2.position.set(1989 + i * 3.2, 313.5, 112); g.add(s2); }); }
      return;
    }
    if (stage !== "jungle-rocklab") return;
    const moss = pbr(ctx, "moss");
    const mat = stoneMaterial(pbr(ctx, "boulder"), { scale: 6.5, triplanar: true, moss: 0.95, mossColor: "#5fa62a", color: "#aab7c9", variation: 0.45, normalScale: 1.4, lift: 0.8, vertexColors: true }, moss);
    const fams = ["cliff", "boulder", "slab", "basalt"] as const;
    fams.forEach((f, row) => {
      const protos = rockProtos(f, 6, f === "cliff" ? 30 : 32);
      root2(ctx).add(rockInstances(protos, protos.map((_, i) => ({ x: 2000 - 15 + i * 6, y: 300 + (row - 1.5) * 5.5, z: 0, sx: 2.4, sy: 2.4, sz: 2.4, ry: 0.6, proto: i })), mat, "rocklab-" + f));
    });
  },
  async build(ctx) {
    const endSlices = sliceMeter("mist-falls");
    bindWaterTime(ctx);
    const h: H = (x, z) => ctx.terrain.height(x, z);
    // the BAKED resolved layout — the exact data the server colliders are built from (shared/pois/mist-falls.ts)
    const R = BAKED;
    if (flag("jungleCheck")) {
      const L = resolveFalls(h); let d = 0; L.cliff.forEach((c, i) => { const b = R.cliff[i]; if (b) d = Math.max(d, Math.abs(c.y - b.y) + Math.abs(c.x - b.x)); });
      console.warn(`[poi-jungle] mist-falls baked vs live: ${L.cliff.length}/${R.cliff.length} cliff blocks, max Δ ${d.toFixed(2)} m`);
    }
    const root = new THREE.Group(); root.name = "mist-falls"; ctx.scene.add(root);
    const moss = pbr(ctx, "moss");
    // wet slate-blue gorge rock (blue-grey rounded blocks, bright moss caps, darker + glossy near the water)
    // a neutral cool grey, not saturated blue: from the fly-in (250–300 m) the blue × the lift read as a
    // navy-black wall and a blue-purple boulder field, off the island's palette (poi-09's cliffs are grey under green)
    const mkCliff = () => { const m = stoneMaterial(pbr(ctx, "boulder"), { scale: 7.5, triplanar: true, moss: 1.0, mossCover: 0.7, mossColor: "#5da82a", variation: 0.4, wetY: FALLS.pool.level + 3, wetFade: 4, normalScale: 1.25, lift: 0.38, liftTop: "#c9cdd0", liftBottom: "#7f9a6c", wetDark: 0.7, vertexColors: true }, moss);
      m.color.setRGB(0.5, 0.53, 0.56);
      strataPatch(m); return m; };   // bedded strata: blocks + veneer read as one layered wet cliff
    // each rock material's merged-cell twin (rockmerge.ts) is made by the same factory right after it
    // (before anything else patches it; the next id: the opaque pass keeps drawing the rocks in the same material order)
    const merged = new Map<THREE.Material, THREE.Material>();
    const twin = <T extends THREE.MeshStandardMaterial>(mk: () => T) => { const m = mk(); if (ROCK_MERGE) merged.set(m, mergedStoneMat(mk())); return m; };
    const cliffMat = twin(mkCliff);
    const veneerMat = stoneMaterial(pbr(ctx, "boulder"), { scale: 9, triplanar: true, moss: 1.0, mossCover: 0.65, mossColor: "#5a9e2a", variation: 0.5, wetY: FALLS.pool.level + 3, wetFade: 4, normalScale: 1.5, lift: 0.34, liftTop: "#c9cdd0", liftBottom: "#7f9a6c", wetDark: 0.7, vertexColors: true }, moss);
    veneerMat.color.setRGB(0.46, 0.49, 0.52);
    await ctx.yield(); buildVeneer(ctx, root, veneerMat); await ctx.yield();
    const mkBoulder = () => { const m = stoneMaterial(pbr(ctx, "boulder"), { scale: 3.4, triplanar: true, moss: 0.75, mossColor: "#62a82c", variation: 0.35, wetY: FALLS.pool.level + 0.8, wetFade: 1.2, normalScale: 1.2, lift: 0.36, liftTop: "#c9cdd0", liftBottom: "#7f9a6c", wetDark: 0.72, vertexColors: true }, moss);
      m.color.setRGB(0.6, 0.6, 0.6); return m; };
    const boulderMat = twin(mkBoulder);
    // river boulders: warm grey-brown (biome-06)
    const mkRiverRock = () => { const m = stoneMaterial(pbr(ctx, "boulder"), { scale: 3.0, triplanar: true, moss: 0.35, mossCover: 0.35, mossColor: "#79b23a", variation: 0.3, normalScale: 1.1, lift: 0.4, vertexColors: true, wetDark: 0.62, wetLevels: FALLS.river.map(([x], i) => [x, R.riverLevel[i]] as [number, number]), detail: 0.7 }, moss);
      m.color.setRGB(0.6, 0.545, 0.49); return m; };   // grey-brown river boulders (darker, warmer than the pale granite)
    const riverRockMat = twin(mkRiverRock);
    // the PLUG blocks (seed 29000–29899: pocket fillers in the
    // falls wall; the top of the ladder out of the stream bed is one) collide as one box up to y + 0.95 sy, but the sculpted
    // slate's crown sits at only ~0.55–0.7 sy: a kong at the top of that ladder stood 2.3 m over the drawn rock. Their drawn
    // rock is stretched (foot kept) until its crown meets the box top, and a bevelled slate slab caps it flush with the box
    // top (the box's footprint): the drawn ledge is exactly the floor you stand on.
    const fitPlug = (r: typeof R.cliff[number]) => {
      if (r.seed < 29000 || r.seed >= 30000) return r;
      const g = rockProtos("slate", 5, 10)[r.seed % 5], P = g.attributes.position as THREE.BufferAttribute;
      let top = -Infinity, bot = Infinity;
      for (let i = 0; i < P.count; i++) { const y = P.getY(i); bot = Math.min(bot, y); if (Math.hypot(P.getX(i), P.getZ(i)) < 0.3) top = Math.max(top, y); }
      if (!(top > bot) || top >= 0.94) return r;
      const want = r.y + r.sy * 0.95 - 0.12, sy = (want - r.y - bot * r.sy) / (top - bot), y = r.y + bot * r.sy - bot * sy;
      return { ...r, y, sy };
    };
    const wall = R.cliff.filter((r) => r.seed < 30000).map(fitPlug), skin = R.cliff.filter((r) => r.seed >= 30000);
    const lods: LodItem[] = [];
    // three LODs per rock field: hi (res 12) near, mid (res 7), far (res 5, big cells); small / hidden sets drop out far
    const lodPair = (list: typeof R.cliff, fam: "slate" | "boulder", mat: THREE.Material, name: string, cast: boolean, split = 55, mid = 150, far = 1400, res: [number, number, number] = [10, 6, 4], supportMax = 0) => {
      const r = rockLOD3(fam, 5, list.map((rk) => ({ ...rk, proto: rk.seed })), mat, name, { res, split: [split, mid], cell: 72, farCell: 144, cast, farMax: far, supportMax });
      // one draw per cell
      const mm = merged.get(mat); if (mm) { mergeRockLevel(r.groups[0], mm, 144); mergeRockLevel(r.groups[1], mm, 144); }
      root.add(...r.groups); lods.push(...boundsLods(r.groups, split, mid, 144, far));   // hi near the kong: decided by cell bounds
    };
    await ctx.yield();   // time-sliced
    // sculpt every prototype set in its own slice (the sculpt is the long synchronous part of a rock field)
    for (const [fam, res] of [["slate", 10], ["slate", 6], ["slate", 4], ["boulder", 10], ["boulder", 6], ["boulder", 4], ...RIVER_ROCK_RES.map((r) => ["boulder", r])] as Array<["slate" | "boulder", number]>) { rockProtos(fam, 5, res); await ctx.yield(); }
    // nothing vanishes before 1.4 km (no cut at 420 m for the river rocks or 450 / 420 m for the boulders / skin without
    // their support horizon). The hi / mid splits stay at their budget: moving them out to 70–300 m cost +400–650k
    // triangles at the pool and the river (measured A/B); their scale fade is the engine's
    lodPair(wall, "slate", cliffMat, "falls-cliff", true, 40, 150, 1400); await ctx.yield();
    { const caps: Geo[] = [];
      for (const r of R.cliff) if (r.seed >= 29000 && r.seed < 30000) { const top = r.y + r.sy * 0.95, hw = r.sx * 0.85 * 0.97;
        caps.push(block(hw * 2, 1.3, hw * 2, r.x, top - 0.65, r.z, r.ry, { bevel: 0.14, uvScale: 1, tint: "#d9dbd5", var: 0.06 })); }
      const cm = staticMesh(merge(caps), cliffMat, "falls-plug-caps"); if (cm) root.add(cm); }
    // Both fields carry authored ledge plants below: retain existing low rocks to the gorge wall horizon.
    lodPair(skin, "slate", cliffMat, "falls-skin", false, 32, 130, 1400, [10, 6, 4], 1400); await ctx.yield();
    lodPair(R.boulders, "boulder", boulderMat, "falls-boulders", true, 36, 120, 1400, [10, 6, 4], 1400); await ctx.yield();
    // near: smooth rounded silhouettes (the biome-06 view camera is 3–30 m from them)
    lodPair(R.riverRocks, "boulder", riverRockMat, "river-rocks", true, 75, 200, 1400, RIVER_ROCK_RES); await ctx.yield();

    buildSand(ctx, root, R); await ctx.yield();
    buildWater(ctx, root, R); await ctx.yield();
    buildWood(ctx, root, R); await ctx.yield();
    // the stone trails: falls-ridge road → the lookout shelf, the shelf → the river bank (the same carved
    // treads + rubble footings as Ripe Peak's trails, in the gorge's grey stone; shared FallsResolved.trails collide)
    { const T = TRAIL_DIMS, rnd = mulberry(8282), treads: Geo[] = [], foot: Geo[] = [];
      for (const trail of R.trails ?? []) for (const s of trail) {
        const th = Math.min(0.32, s.y - s.base), dx = Math.cos(s.yaw), dz = -Math.sin(s.yaw);
        treads.push(block(T.len, th, T.width, s.x, s.y - th / 2, s.z, s.yaw + (rnd() - 0.5) * 0.02, { bevel: 0.06, uvScale: 1, tint: rnd() < 0.5 ? "#e8e2d6" : "#d8d0c2", var: 0.05 }));
        treads.push(block(0.1, 0.08, T.width - 0.1, s.x + dx * (T.len / 2 - 0.05), s.y - 0.04, s.z + dz * (T.len / 2 - 0.05), s.yaw, { bevel: 0.03, uvScale: 1, tint: "#f0eadf" }));
        if (s.y - th - s.base > 0.05) foot.push(block(T.len, s.y - th - s.base, T.width, s.x, (s.y - th + s.base) / 2, s.z, s.yaw, { bevel: 0.1, uvScale: 1, tint: rnd() < 0.5 ? "#9a9c98" : "#8a8c86", var: 0.08 }));
      }
      const tm = staticMesh(merge(treads), boulderMat, "falls-trail-treads"), fm = staticMesh(merge(foot), cliffMat, "falls-trail-footing");
      if (tm) root.add(tm); if (fm) root.add(fm); }
    await ctx.yield();
    // no creeper cards on the gorge boulders: they would hang from the middle of rounded rocks in a random direction
    // (half of them in mid-air in front of the face)
    // detail that vanishes with distance (the gorge is a landmark from the peak/air: rocks + water + falls stay)
    // (the mid sets too)
    noCast(root, /^falls-cliff-(mid-)?\d|^falls-boulders-(mid-)?\d|^river-rocks-(mid-)?\d|falls-wood|falls-log|falls-crate/);
    // only the mist banks keep a (far) cut: the bridges' ropes, the lookout's thatch / cloth popped in at 300 m
    for (const o of root.children) if (/jungle-puffs/.test(o.name)) lods.push({ o, far: 1000 });
    distanceSwitch(ctx, lods);

    // vegetation (veg area species): rims, ledges, the lookout, river banks
    // ?jungleNoVeg: skip the POI-planted vegetation (perf isolation)
    const veg = flag("jungleNoVeg") ? undefined : ctx.shared.get("veg") as VegApi | undefined;
    if (veg) {
      const rnd = mulberry(9090);
      // keep every view camera's sight line clear (FALLS.views: camera stand + first stretch toward the subject)
      const inView = (x: number, z: number) => FALLS.views.some(([cx, cz, tx, tz]) => { const dx = tx - cx, dz = tz - cz, L = Math.hypot(dx, dz), u = ((x - cx) * dx + (z - cz) * dz) / L; const d = Math.abs((x - cx) * dz - (z - cz) * dx) / L; return (u > -6 && u < L + 4 && d < 6 + u * 0.12) || Math.hypot(x - cx, z - cz) < 8; });
      const M = (x: number, z: number, s = 1, y?: number, tilt = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y ?? Math.max(h(x, z), barHeight(R, x, z)) - 0.1, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt * (rnd() - 0.5), rnd() * 6.28, tilt * (rnd() - 0.5))), new THREE.Vector3(s, s, s));
      const P: Partial<Record<PlantKind, THREE.Matrix4[]>> = {};
      // every walked surface keeps plants off: stone-trail treads, the lookout's back steps, the bridge decks, the
      // north walkway, the ladders' feet + tops and the timber landings. [x, z, r] discs; a plant keeps its own reach
      // clear of them (a buttress tree its roots, a bamboo clump its canes, a fern its fronds)
      const walk: Array<[number, number, number]> = [];
      { const T = TRAIL_DIMS, stepR = Math.hypot(T.len / 2, T.width / 2);
        for (const t of R.trails ?? []) for (const st of t) walk.push([st.x, st.z, stepR]);
        for (const [x, z] of R.lookoutSteps ?? []) walk.push([x, z, Math.hypot(LOOKOUT_STEP.tread / 2, LOOKOUT_STEP.width / 2)]);
        const line = (ax: number, az: number, bx: number, bz: number, r: number) => { const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.8)); for (let i = 0; i <= n; i++) walk.push([ax + (bx - ax) * i / n, az + (bz - az) * i / n, r]); };
        for (const b of R.bridges) line(b.a[0], b.a[2], b.b[0], b.b[2], b.width / 2 + 0.3);
        for (let i = 0; i + 1 < FALLS.walkway.length; i++) line(FALLS.walkway[i][0], FALLS.walkway[i][1], FALLS.walkway[i + 1][0], FALLS.walkway[i + 1][1], 1.1);
        for (const l of LADDERS) if (l.poi === "mist-falls") { const c = l.c; line(c.x + c.nx * 1.4, c.z + c.nz * 1.4, c.x - c.nx * 1.2, c.z - c.nz * 1.2, 0.9); }
        for (const l of LANDINGS) if (l.poi === "mist-falls") line(l.x, l.z - l.hz, l.x, l.z + l.hz, l.hx + 0.3); }
      const REACH: Partial<Record<PlantKind, number>> = { "jungle-tree": 3.6, palm: 1.2, "palm-leaning": 2.2, bamboo: 2.0, "banana-plant": 1.8, monstera: 1.4, bush: 1.3, fern: 0.8, flowers: 0.7, grass: 0.5, groundcover: 0.8 };
      const onWalk = (k: PlantKind, x: number, z: number, s: number) => { const r = (REACH[k] ?? 1) * (k === "jungle-tree" ? s : Math.max(1, s)); return walk.some(([wx, wz, wr]) => (x - wx) ** 2 + (z - wz) ** 2 < (wr + r) ** 2); };
      // authored framing plants step aside (up to 4 m, away from the nearest walked disc) instead of vanishing from the shot
      const nudge = (k: PlantKind, m: THREE.Matrix4): THREE.Matrix4 | null => {
        const e = m.elements, s = Math.hypot(e[0], e[1], e[2]); let x = e[12], z = e[14];
        for (let it = 0; it < 10 && onWalk(k, x, z, s); it++) { let bd = Infinity, bx = 0, bz = 0; for (const [wx, wz] of walk) { const d = (x - wx) ** 2 + (z - wz) ** 2; if (d < bd) { bd = d; bx = wx; bz = wz; } } const d = Math.sqrt(bd) || 1; x += (x - bx) / d * 0.5; z += (z - bz) / d * 0.5; }
        if (onWalk(k, x, z, s) || Math.hypot(x - e[12], z - e[14]) > 4) return null;
        if (x !== e[12] || z !== e[14]) { const y = Math.max(h(x, z), barHeight(R, x, z)) - 0.1; m.elements[12] = x; m.elements[13] = y; m.elements[14] = z; }
        return m;
      };
      const add = (k: PlantKind, m: THREE.Matrix4) => { const e = m.elements; if (inView(e[12], e[14]) || onWalk(k, e[12], e[14], Math.hypot(e[0], e[1], e[2]))) return; (P[k] ??= []).push(m); };
      // plants only on real LEDGES: near the rock's crown (its rounded mesh is lower toward the edges), on a gentle ground
      // slope, the rock top within 1.5 m of the ground there — never a palm growing out of a vertical face
      const ledge = (r: typeof R.cliff[number], f: number): [number, number] | null => {
        const x = r.x + (rnd() - 0.5) * r.sx * f, z = r.z + (rnd() - 0.5) * r.sz * f, g = h(x, z), sl = Math.hypot(h(x + 2, z) - h(x - 2, z), h(x, z + 2) - h(x, z - 2)) / 4, top = r.y + r.sy;
        return sl < 0.55 && Math.abs(top - g) < 1.5 ? [x, z] : null; };
      // cliff-top rims: palms + bushes + ferns on the rock tops
      for (const r of R.cliff) { const top = r.y + r.sy; if (top < 40 || rnd() < 0.55) continue; const p = ledge(r, 0.4), k = rnd(); if (p) add(k < 0.3 ? "palm" : k < 0.6 ? "bush" : k < 0.85 ? "fern" : "monstera", M(p[0], p[1], 0.7 + rnd() * 0.5, top - 0.45)); }
      // ferns + bushes on ledges (rock tops at any height, sparse)
      for (const r of R.cliff) { if (rnd() < 0.12) continue; const q = rnd(), p = ledge(r, 0.35); if (p) add(q < 0.5 ? "fern" : q < 0.8 ? "bush" : q < 0.92 ? "monstera" : "flowers", M(p[0], p[1], 0.7 + rnd() * 0.6, r.y + r.sy - 0.4));
        const p2 = r.sx > 5.5 && rnd() < 0.6 ? ledge(r, 0.45) : null; if (p2) add(rnd() < 0.6 ? "fern" : "bush", M(p2[0], p2[1], 0.6 + rnd() * 0.5, r.y + r.sy - 0.45)); }
      // the poi-09 view's own foreground (big monstera + red bromeliads bottom-left, ferns + flowers right)
      { const [cx, cz, tx, tz] = FALLS.views[0], fl = Math.hypot(tx - cx, tz - cz), fx = (tx - cx) / fl, fz = (tz - cz) / fl, rx = -fz, rz = fx;
        for (const [f, r, k, sc] of [[3.2, -1.6, "flowers", 1.5], [3.8, 2.2, "fern", 1.5], [4.4, 4.2, "flowers", 1.4], [5.6, 5.8, "monstera", 1.4], [3.0, 5.2, "fern", 1.3], [6.8, 3.4, "flowers", 1.3], [2.6, 0.6, "fern", 1.2]] as Array<[number, number, PlantKind, number]>) {
          const x = cx + fx * f + rx * r, z = cz + fz * f + rz * r; const m = nudge(k, M(x, z, sc)); if (m) (P[k] ??= []).push(m);
        } }
      // the poi-09 frame: a tall jungle tree + palm behind the lookout (the top-left canopy; they also screen the
      // terrain boulder on the south shoulder), big monstera / bromeliads / ferns along the shoulder ridge (bottom frame)
      for (const [x, z, k, sc] of [[-134, -366.5, "jungle-tree", 1.35], [-137, -372, "palm", 1.2], [-131.5, -362.5, "palm-leaning", 1.15], [-128, -364.5, "banana-plant", 1.3],
        [-116.5, -366.8, "monstera", 1.6], [-113, -367.2, "flowers", 1.6], [-119.5, -367.6, "fern", 1.5], [-110.5, -366.4, "fern", 1.4], [-104.5, -366.6, "monstera", 1.5], [-101.5, -368.8, "flowers", 1.5], [-122.5, -366.2, "flowers", 1.4]] as Array<[number, number, PlantKind, number]>) { const m = nudge(k, M(x, z, sc)); if (m) (P[k] ??= []).push(m); }
      // the biome-06 view: the right-hand frame (monstera, heliconia, bamboo, a leaning palm over the water,
      // ferns, banana plants behind the beached canoe) + the far bank's ferns / banana plants between the boulders
      { const [cx, cz, tx, tz] = FALLS.views[1], fl = Math.hypot(tx - cx, tz - cz), fx = (tx - cx) / fl, fz = (tz - cz) / fl, rx = -fz, rz = fx;
        for (const [f, r, k, sc] of [[6.5, 6.2, "monstera", 1.5], [4.2, 5.0, "flowers", 1.5], [7.8, 4.8, "flowers", 1.35], [10, 7.5, "bamboo", 1.2], [12.5, 6.5, "bamboo", 1.1], [8.5, 8.5, "palm-leaning", 1.25], [3.2, 4.2, "fern", 1.3], [11.5, 9.5, "banana-plant", 1.25], [14, 5.2, "fern", 1.2], [5.5, 8.2, "banana-plant", 1.3], [16, 4.5, "monstera", 1.2]] as Array<[number, number, PlantKind, number]>) {
          const x = cx + fx * f + rx * r, z = cz + fz * f + rz * r; if (h(x, z) < riverLevelAt(R, x, z) + 0.15 && barHeight(R, x, z) < riverLevelAt(R, x, z) + 0.15) continue;   // never in the water
          { const m = nudge(k, M(x, z, sc)); if (m) (P[k] ??= []).push(m); }
        }
        for (const [x, z, k, sc] of [[-56, -397.5, "banana-plant", 1.2], [-61, -397.8, "fern", 1.3], [-50.5, -398.2, "fern", 1.2], [-66.5, -399, "monstera", 1.3], [-46, -399.2, "flowers", 1.2], [-70, -398.5, "palm", 1.1]] as Array<[number, number, PlantKind, number]>) { const m = nudge(k, M(x, z, sc)); if (m) (P[k] ??= []).push(m); } }
      // the south bank slope behind the biome-06 far bank: jungle trees, bushes, banana plants, ferns
      // (the near left bank is boulders + ferns + banana plants + palms; the big buttressed trees stand further back)
      for (let i = 0; i < 46; i++) { const x = -86 + rnd() * 52, z = -398 + rnd() * 16; if (h(x, z) < 17) continue; const q = rnd(), sky = Math.abs(x + 70) < 17 && Math.abs(z + 392) < 9; add(q < 0.3 ? (sky ? "bush" : "palm") : q < 0.5 ? "bush" : q < 0.66 ? "banana-plant" : q < 0.82 ? "fern" : q < 0.92 ? (sky ? "banana-plant" : "palm") : "monstera", M(x, z, 0.85 + rnd() * 0.5)); }
      // around the lookout + the bridge head (the left foreground: monstera, red flowers, ferns)
      const lo = FALLS.lookout;
      for (let i = 0; i < 22; i++) { const a = rnd() * 6.28, d = 4 + rnd() * 9, x = lo.x + Math.cos(a) * d, z = lo.z + Math.sin(a) * d; const k = rnd(); add(k < 0.3 ? "monstera" : k < 0.55 ? "fern" : k < 0.75 ? "flowers" : k < 0.9 ? "banana-plant" : "palm", M(x, z, 0.8 + rnd() * 0.5)); }
      // gorge rims beyond the cliffs: jungle trees + palms (sky frame) — half: light tree cover, the rims are lanes
      for (let i = 0; i < 34; i++) { const a = rnd() * 6.28, d = 48 + rnd() * 40, x = FALLS.pool.x + Math.cos(a) * d, z = FALLS.pool.z + Math.sin(a) * d * 0.9; if (x > -120 && Math.abs(z + 404) < 22) continue; add(rnd() < 0.4 ? "palm" : rnd() < 0.7 ? "jungle-tree" : "bush", M(x, z, 0.8 + rnd() * 0.6)); }
      // river banks (biome-06): bamboo groves, palms with bananas, monstera, heliconia, ferns
      FALLS.river.forEach(([x, z], i) => {
        if (i < 1 || i > 10) return;
        const [nx0, nz0] = FALLS.river[i + 1] ?? FALLS.river[i]; const tx = nx0 - x, tz = nz0 - z, tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl, hw = R.riverHalfW[i];
        for (const s of [-1, 1]) for (let k = 0; k < (i <= 6 ? 9 : 4); k++) {   // ~55 %: open banks, readable river crossings
          const off = s * (hw + 1 + rnd() * 16), along = (rnd() - 0.5) * 16, px = x + nx * off + tx / tl * along, pz = z + nz * off + tz / tl * along;
          if (h(px, pz) < R.riverLevel[i] + 0.25) continue;   // never in the water
          const q = rnd(); add(q < 0.18 ? "bamboo" : q < 0.36 ? "palm" : q < 0.52 ? "monstera" : q < 0.66 ? "banana-plant" : q < 0.78 ? "flowers" : q < 0.9 ? "fern" : "jungle-tree", M(px, pz, 0.85 + rnd() * 0.5));
        }
      });
      // DENSE ledges: a second pass of ferns / bushes / monstera / heliconia on every ledge-capable
      // rock top, and the sand → forest-floor edge blended with ground cover, grass and ferns (no hard sand line)
      for (const r of [...R.cliff, ...R.boulders]) { for (let k = 0; k < 2; k++) { if (rnd() < 0.35) continue; const p = ledge(r, 0.5); if (!p) continue; const q = rnd(); add(q < 0.35 ? "fern" : q < 0.55 ? "bush" : q < 0.7 ? "groundcover" : q < 0.82 ? "monstera" : q < 0.92 ? "flowers" : "banana-plant", M(p[0], p[1], 0.65 + rnd() * 0.55, r.y + r.sy - 0.42)); } }
      for (const [x, z, rx, rz, yaw] of FALLS.sandbars) { const n = Math.round((rx + rz) * 1.6); for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + rnd() * 0.2, f = 1.0 + rnd() * 0.25, lx = Math.cos(a) * rx * f, lz = Math.sin(a) * rz * f, px = x + lx * Math.cos(yaw) - lz * Math.sin(yaw), pz = z + lx * Math.sin(yaw) + lz * Math.cos(yaw);
        if (h(px, pz) < riverLevelAt(R, px, pz) + 0.25) continue; const q = rnd(); add(q < 0.4 ? "groundcover" : q < 0.65 ? "grass" : q < 0.85 ? "fern" : "flowers", M(px, pz, 0.8 + rnd() * 0.5)); } }
      for (const [k, list] of Object.entries(P)) veg.plant(k as PlantKind, list!);
    }
    endSlices();
  },
};
export default mod;
