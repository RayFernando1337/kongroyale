// POI ripe-peak — the volcano's built features: a colossal gorilla-totem ring on the crater crest, the terraced fan of
// black columnar basalt on the SSW flank (sunlit, faces the lookout) with a zig-zag stair to the crest, lava seams either
// side pooling at the foot, a smoke plume from the crater, and the lookout crag (butte) the poi-03 camera stands on.
// Layout: shared/pois/jungle-layout.ts (PEAK) resolved ONCE into shared/pois/jungle-baked.json; the visuals below and
// the server colliders (shared/pois/ripe-peak.ts) are built from that same baked data.
import * as THREE from "three";
import { rockProtos } from "../_kit/jungle-rocks";
import { sliceMeter } from "../banana-temple/slices";
import type { WorldModule } from "../../module";
import type { CamSpec } from "../../../engine/views";
import type { VegApi, PlantKind } from "../../veg/api";
import { PEAK, PEAK_C, mulberry, resolvePeak, peakSurface } from "../../../../../shared/pois/jungle-layout";
import { layout as R } from "../../../../../shared/pois/ripe-peak";
import { peakMaterials, buildFan, buildTotems, buildLava, buildSmoke, buildCrag, buildRim, buildRocks, buildSummit, buildTrails } from "./peak";
import { distanceSwitch, noCast, type LodItem } from "../_kit/jungle-lod";
import { flag } from "../../../flags";

const C = PEAK_C, F = PEAK.fan;
/** a LOD cut measured to the object's world box (0 inside it) */
const boxCut = (o: THREE.Object3D, far: number): LodItem => { o.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(o, true); return { o, test: (cam) => b.distanceToPoint(cam) < far }; };
const V = (pos: CamSpec["pos"], target: CamSpec["target"], o: Partial<CamSpec> = {}): CamSpec => ({ pos, target, fov: 50, ...o });
const pol = (a: number, r: number, y: number): [number, number, number] => [C.x + Math.cos(a) * r, y, C.z + Math.sin(a) * r];
const toCone = Math.atan2(C.z - R.crag.z, C.x - R.crag.x);

const mod: WorldModule = {
  id: "poi:ripe-peak",
  views: {
    // a high vantage over the lookout crag (camera ~50 m above its top, behind it), looking DOWN across the
    // flank: the cone upper-centre-right with the totem crown + terraced fan + lava seams, the sea and the island's west
    // coast in the left third, the crag's foreground totems / crate / plants at the bottom
    // a wide-angle camera just above + behind the lookout crag, the foreground totems / palms at the bottom, the cone
    // with its totem crown + lava seams + smoke upper-centre-right, the sea on the left
    "poi-03-ripe-peak": (() => { const f = [Math.cos(toCone), Math.sin(toCone)], P = [R.crag.x - f[0] * 14, R.crag.top + 18, R.crag.z - f[1] * 14], a = toCone - 0.12, p = 4 * Math.PI / 180;
      return V(P as [number, number, number], [P[0] + Math.cos(a) * Math.cos(p) * 100, P[1] + Math.sin(p) * 100, P[2] + Math.sin(a) * Math.cos(p) * 100], { fov: 72, note: "wide lens over the lookout crag's totems at the cone" }); })(),
    "peak-rim-walk": V(pol(1.0, 62, 262), pol(0.55, 66, 258), { fov: 62, note: "dev: on the rim plateau, along the totem ring" }),
    "peak-crater-view": V(pol(1.3, 40, R.summit.y1 + 14), pol(1.3, 0, R.summit.floor), { fov: 62, note: "dev: into the summit crater" }),
    "peak-summit": V(pol(F.c, 150, 265), pol(F.c, 0, 280), { fov: 55, note: "dev: the summit cone over the crown" }),
    "peak-fan": V(pol(F.c, 205, 150), pol(F.c, 100, 190), { fov: 60, note: "dev: the terraced fan + stair" }),
    "peak-rim": V(pol(F.c + 0.1, 92, 236), pol(F.c - 0.9, 64, 250), { fov: 62, note: "dev: crest totems" }),
    "peak-rocklab": V([2100, 304, 26], [2100, 300, 0], { fov: 50, stage: "peak-rocklab", note: "dev: peak rock prototypes (old lava / cleft / cleftout) in the sky" }),
    "peak-crag": V([R.crag.x + Math.cos(toCone + 1.9) * 70, R.crag.top - 10, R.crag.z + Math.sin(toCone + 1.9) * 70], [R.crag.x, R.crag.top - 30, R.crag.z], { fov: 55, note: "dev: the lookout crag from the side" }),
  },
  async stage(ctx, stage) {
    if (stage !== "peak-rocklab") return;
    const { rockProtos, rockInstances } = await import("../_kit/jungle-rocks");
    const g = new THREE.Group(); g.name = "peak-rocklab"; ctx.scene.add(g);
    const mats = peakMaterials(ctx);
    (["lava", "cleft", "cleftout"] as const).forEach((f, row) => {
      const protos = rockProtos(f, 6, 16);
      g.add(rockInstances(protos, protos.map((_, i) => ({ x: 2100 - 15 + i * 6, y: 300 + (1 - row) * 5.5, z: 0, sx: 2.4, sy: 2.4, sz: 2.4, ry: 0.6, proto: i })), mats.rock, "peak-rocklab-" + f));
    });
  },
  async build(ctx) {
    const endSlices = sliceMeter("ripe-peak");
    const root = new THREE.Group(); root.name = "ripe-peak"; ctx.scene.add(root);
    const h = (x: number, z: number) => ctx.terrain.height(x, z);
    if (flag("jungleCheck")) { // dev: is the baked layout still current with this terrain?
      const L = resolvePeak(h); let d = 0; L.totems.forEach((t, i) => { d = Math.max(d, Math.abs(t.y - (R.totems[i]?.y ?? 0))); });
      console.warn(`[poi-jungle] ripe-peak baked vs live: max totem Δy ${d.toFixed(2)} m`);
    }
    // time-sliced: a yield between the big pieces (streamed build, no main-thread task > 50 ms)
    const mats = peakMaterials(ctx), lods: LodItem[] = [];
    await ctx.yield();
    buildRim(mats, root, R); await ctx.yield();
    // sculpt each rock prototype set in its own slice before the fields instance them
    // one prototype set per family (the faceted cleft rocks are the same at every res: buildRocks draws one level)
    for (const [fam, res] of [["cleft", 7], ["cleftout", 7]] as Array<["cleft" | "cleftout", number]>) { rockProtos(fam, 6, res); await ctx.yield(); }
    const casters = buildRocks(mats, root, R, lods); await ctx.yield();
    { const boxes = casters.map((c) => { if (!c.boundingBox) c.computeBoundingBox(); return c.boundingBox!.clone(); }); let f = 0;
      const cast = () => { const p = ctx.camera.position; casters.forEach((c, i) => { const on = boxes[i].distanceToPoint(p) < 90; if (c.castShadow !== on) c.castShadow = on; }); };
      cast(); ctx.onUpdate(() => { if (++f % 10 === 0) cast(); }); }
    buildFan(ctx, mats, root, R); await ctx.yield();
    const trailLods = buildTrails(mats, root, R); await ctx.yield();
    buildLava(ctx, mats, root, R); await ctx.yield();
    buildSummit(ctx, root, R); await ctx.yield();
    buildSmoke(root, R);
    buildCrag(ctx, mats, root, R); await ctx.yield();
    await buildTotems(ctx, mats, root, R); await ctx.yield();
    // small stuff doesn't cast (rubble, vines, steps' own shadows are tiny) and vanishes with distance
    noCast(root, /^peak-rocks-\d|^peak-outcrops-\d|^peak-crag-blocks-\d|peak-plinths|peak-totem|hero:totem|peak-crag-top|peak-rim-plateau/);
    // the dressing's cuts at 420 / 520 m (at 320 / 420 m the stairs, plinths and crag steps popped in on every approach;
    // 650 m measured +0.25 M triangles from 500 m out)
    // the cuts are measured to each merged mesh's BOX, not its bounding-sphere centre: the fan's
    // stairs are 155 m across, so a centre cut at 520 m would let the near end appear ~365 m away; nothing here appears
    // nearer than its cut distance
    for (const o of root.children) if (/jungle-vines|peak-fan-rubble|peak-crag-rocks|peak-bananas|peak-crag-fissure/.test(o.name)) lods.push(boxCut(o, 420));
    for (const o of root.children) if (/peak-fan-stairs|peak-crag-steps|peak-plinths|peak-crag-top/.test(o.name)) lods.push(boxCut(o, 700));
    // the stone trails: hi cells near, a resident plain-box lo copy everywhere else (peak.ts buildTrails) — never a pop
    lods.push(...trailLods);
    distanceSwitch(ctx, lods);

    // ?jungleNoVeg: skip the POI-planted vegetation (perf isolation)
    const veg = flag("jungleNoVeg") ? undefined : ctx.shared.get("veg") as VegApi | undefined;
    if (veg) {
      const rnd = mulberry(7070);
      const P: Partial<Record<PlantKind, THREE.Matrix4[]>> = {};
      // never on a steep face: a ground-seated plant (no y given) whose footing slopes > 35° is dropped — the
      // flank / outcrop loops would stick ~450 leaf cards flat against the 40–55° black rock, visible from the open field 500 m away
      const steep = (x: number, z: number) => { const e = 0.9, S = (u: number, v: number) => peakSurface(R, h, u, v); return Math.hypot(S(x + e, z) - S(x - e, z), S(x, z + e) - S(x, z - e)) / (2 * e) > 0.7; };
      let dropped = 0;
      const add = (k: PlantKind, x: number, z: number, s = 1, y?: number) => { const ry = rnd() * 6.28; if (y === undefined && steep(x, z)) { dropped++; return; } (P[k] ??= []).push(new THREE.Matrix4().compose(new THREE.Vector3(x, y !== undefined ? y - 0.12 : peakSurface(R, h, x, z) - 0.05, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(s, s, s))); };
      // bench tops: palms, bushes, ferns (keep the stair strip on the fan axis clear)
      for (const b of R.benches) for (let j = 1; j < b.a.length - 1; j++) {
        const a = b.a[j], depth = b.rout[j] - b.rin[j], rm = (b.rin[j] + b.rout[j]) / 2;
        if (Math.abs(a - F.c) * rm < 8.5 || depth < 4.2) continue;
        // the terraces are LUSH: palm groves, jungle trees and bushes on every bench top (2 plants per sample)
        // mixed, clumped planting (never rows of identical palms): a few palms / trees in groves, undergrowth between,
        // bare rock patches (black basalt terraces with pockets of green)
        const grove = Math.sin(a * 23 + b.k * 1.7) > 0.35;
        for (let n = 0; n < 2; n++) {
          const q = rnd(), da = (rnd() - 0.5) * 1.3 / Math.max(20, (b.rin[j] + b.rout[j]) / 2), r = b.rin[j] + 1.2 + rnd() * Math.max(0.3, depth - 3.6), x = C.x + Math.cos(a + da) * r, z = C.z + Math.sin(a + da) * r;
          // ~half the bench trees: the fan is the climb's fight lane — sight lines up / down the zig-zag, not a canopy
          if (q < (grove ? 0.11 : 0.03)) add(rnd() < 0.6 ? "palm" : "palm-leaning", x, z, 0.65 + rnd() * 0.6, b.y);
          else if (q < (grove ? 0.16 : 0.045)) add("jungle-tree", x, z, 0.55 + rnd() * 0.3, b.y);
          else if (q < 0.34) add("bush", x, z, 0.5 + rnd() * 0.6, b.y);
          else if (q < 0.5) add("fern", x, z, 0.6 + rnd() * 0.6, b.y);
          else if (q < 0.56) add("banana-plant", x, z, 0.7 + rnd() * 0.35, b.y);
          else if (q < 0.62) add("flowers", x, z, 1.0 + rnd() * 0.3, b.y);
        }
      }
      // rim plateau: palms + bushes between the totems (the crown), ferns + rubble plants on both edges
      { const P = R.rim, n = P.a.length;
        for (let i = 0; i < n; i += 3) {
          const a = P.a[i], near = R.totems.some((t) => t.plinth && Math.hypot(t.x - (C.x + Math.cos(a) * P.rout[i]), t.z - (C.z + Math.sin(a) * P.rout[i])) < t.plinth[0] + 3.5);
          if (near || Math.abs(Math.atan2(Math.sin(a - F.c), Math.cos(a - F.c))) * P.cr[i] < 4) continue;
          const q = rnd(), rr = P.rout[i] - 1.2 - rnd() * 1.5, x = C.x + Math.cos(a) * rr, z = C.z + Math.sin(a) * rr;
          if (q < 0.2) add(rnd() < 0.7 ? "palm" : "palm-leaning", x, z, 0.8 + rnd() * 0.3, P.y[i]);
          else if (q < 0.42) add("bush", x, z, 0.6 + rnd() * 0.35, P.y[i]);
          else if (q < 0.62) add("fern", x, z, 0.7 + rnd() * 0.4, P.y[i]);
          if (rnd() < 0.3) { const ri = P.rin[i] + 3.2 + rnd() * 1.5; add(rnd() < 0.6 ? "fern" : "bush", C.x + Math.cos(a) * ri, C.z + Math.sin(a) * ri, 0.6 + rnd() * 0.3, P.y[i]); }
        } }
      // the crag (the foreground): plants at the plateau's front rim either side of the camera, and on the ledge
      // round the foreground totems — palm + bamboo right, banana + bromeliads + monstera left, ferns everywhere
      const cg = R.crag, L = cg.ledge, cam = new THREE.Vector3(...R.cam), fwd = new THREE.Vector3(Math.cos(toCone), 0, Math.sin(toCone)), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const at = (f: number, r: number): [number, number] => [cam.x + fwd.x * f + right.x * r, cam.z + fwd.z * f + right.z * r];
      const onTop = (x: number, z: number) => Math.hypot(x - cg.x, z - cg.z) < cg.rTop - 0.9;
      const onLedge = (x: number, z: number) => Math.hypot(x - L.x, z - L.z) < L.r - 0.9 && !onTop(x, z);
      for (const [f, r, k, s] of [[0.6, 4.2, "monstera", 1.2], [0.2, -4.0, "flowers", 1.4], [1.0, -2.6, "flowers", 1.2], [-0.4, -5.8, "banana-plant", 1.1], [0.4, 6.4, "fern", 1.3], [1.2, -6.8, "fern", 1.2], [1.2, 9.6, "palm", 1.1], [0.2, 8.6, "bamboo", 1.0]] as Array<[number, number, PlantKind, number]>) {
        const [x, z] = at(f, r); if (onTop(x, z)) add(k, x, z, s, cg.top);
      }
      for (const [f, r, k, s] of [[8.5, 7.2, "palm", 1.1], [7.5, 8.6, "bamboo", 1.0], [9.8, 8.8, "bamboo", 0.9], [7.2, -6.8, "banana-plant", 1.05], [8.6, -4.8, "flowers", 1.3], [11.5, 2.2, "flowers", 1.2], [12.5, -2.8, "fern", 1.2], [9.0, 3.8, "fern", 1.1], [13.0, 5.5, "monstera", 1.1], [7.4, 1.4, "fern", 1.0]] as Array<[number, number, PlantKind, number]>) {
        const [x, z] = at(f, r); if (onLedge(x, z)) add(k, x, z, s, L.y);
      }
      for (let i = 0; i < 10; i++) { const a = rnd() * 6.28, d = 3 + rnd() * (cg.rTop - 4), x = cg.x + Math.cos(a) * d, z = cg.z + Math.sin(a) * d; if (Math.hypot(x - cam.x, z - cam.z) < 5) continue; add(rnd() < 0.6 ? "fern" : "bush", x, z, 0.6 + rnd() * 0.5, cg.top); }
      // the cone's lower flank below + beside the fan (palm groves climbing the slope)
      // half the plants and a third of the trees: the flank is the climb's long lane, it must read clean
      for (let i = 0; i < 210; i++) {
        const a = F.c + (rnd() - 0.47) * 1.9, r = 85 + Math.sqrt(rnd()) * 165, x = C.x + Math.cos(a) * r, z = C.z + Math.sin(a) * r;
        if (Math.hypot(x - R.crag.x, z - R.crag.z) < R.crag.rBase + 16 || peakSurface(R, h, x, z) > h(x, z) + 0.5) continue;
        if (R.seams.some((sm) => sm.pts.some((p) => Math.hypot(p[0] - x, p[2] - z) < sm.w + 3))) continue;
        const q = rnd(); add(q < 0.16 ? "palm" : q < 0.21 ? "palm-leaning" : q < 0.27 ? "jungle-tree" : q < 0.7 ? "bush" : q < 0.88 ? "fern" : "banana-plant", x, z, 0.8 + rnd() * 0.45);
      }
      // at the feet of the flank outcrops: ferns, bushes, the odd palm (plants clinging between the rocks)
      for (const rk of R.rocks) { if (rk.kind !== 1 || rnd() < 0.45) continue; const a = rnd() * 6.28, d = Math.max(rk.sx, rk.sz) * 0.9 + 0.8, x = rk.x + Math.cos(a) * d, z = rk.z + Math.sin(a) * d; const q = rnd(); add(q < 0.45 ? "fern" : q < 0.8 ? "bush" : q < 0.92 ? "palm" : "flowers", x, z, 0.7 + rnd() * 0.4); }
      // under the fan's foot (the steep ribs between the fan and the crag): bushes + ferns + small trees
      for (let i = 0; i < 70; i++) {
        const a = F.c + (rnd() - 0.5) * 0.9, r = 128 + rnd() * 70, x = C.x + Math.cos(a) * r, z = C.z + Math.sin(a) * r;
        if (peakSurface(R, h, x, z) > h(x, z) + 0.5 || R.seams.some((sm) => sm.pts.some((p) => Math.hypot(p[0] - x, p[2] - z) < sm.w + 2.5))) continue;
        const q = rnd(); add(q < 0.55 ? "bush" : q < 0.86 ? "fern" : q < 0.94 ? "palm" : "jungle-tree", x, z, 0.75 + rnd() * 0.4);
      }
      // the crag's tier rings: bushes, ferns, a few small palms (not on the stair side)
      { const back = Math.atan2(cg.z - C.z, cg.x - C.x);
        cg.tiers.forEach(([rr, yTop], i) => { if (i === cg.tiers.length - 1) return; const rIn = cg.tiers[i + 1][0];
          for (let k = 0; k < 16; k++) { const a = rnd() * 6.28; if (Math.abs(Math.atan2(Math.sin(a - back), Math.cos(a - back))) < 0.8) continue; const d = rIn + 1 + rnd() * (rr - rIn - 2); const q = rnd();
            add(q < 0.45 ? "bush" : q < 0.8 ? "fern" : q < 0.9 ? "flowers" : "banana-plant", cg.x + Math.cos(a) * d, cg.z + Math.sin(a) * d, 0.6 + rnd() * 0.35, yTop); } }); }
      // round the crag foot + along the lava pools: palms and bushes on the lower flank
      for (let i = 0; i < 22; i++) { const a = rnd() * 6.28, d = cg.rBase + 5 + rnd() * 18, x = cg.x + Math.cos(a) * d, z = cg.z + Math.sin(a) * d; add(rnd() < 0.2 ? "palm" : "bush", x, z, 0.8 + rnd() * 0.4); }
      for (const [k, list] of Object.entries(P)) veg.plant(k as PlantKind, list!);
      if (dropped && flag("vegdbg").length > 0) console.log(`[poi-jungle] ripe-peak: ${dropped} plants dropped off steep faces, ${Object.values(P).reduce((n, l) => n + l!.length, 0)} kept`);
    }
    endSlices();
  },
};
export default mod;
