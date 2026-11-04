// POI banana-temple — stepped stone pyramid crowned with a colossal carved gorilla head, mossy glyph-carved tiers, an
// arched door portal with the golden banana idol, carved towers with spiral stairs and walkable rope bridges, a flagstone
// plaza with planters and crates, and the legendary vault inside (dark, fire-lit). Layout + colliders:
// shared/pois/jungle-layout.ts (TEMPLE) / shared/pois/banana-temple.ts. Built in a LOCAL frame inside one Group at the
// POI centre rotated 180° (façade faces the atmos sun, NNW).
import * as THREE from "three";
import { sliceMeter } from "./slices";
import type { WorldModule } from "../../module";
import type { CamSpec } from "../../../engine/views";
import type { VegApi, PlantKind } from "../../veg/api";
import { TEMPLE, TEMPLE_C, templeToWorld, mulberry } from "../../../../../shared/pois/jungle-layout";
import { templeMaterials, buildPyramid, buildPortal, buildHead, buildTowers, buildIdol, buildVault, buildIvy } from "./temple";
import { buildPlaza } from "./plaza";
import { buildCover } from "./cover";
import { buildDungeon } from "./dungeon";
import { leafClusterTex } from "../_kit/jungle-mat";
import { prepareGoldEnv } from "../_kit/jungle-gold";
import { distanceSwitch, shadowProxy, noCast } from "../_kit/jungle-lod";
import { templeColliders } from "../../../../../shared/pois/jungle-layout";
import { merge, boxUVs, tint } from "../_kit/jungle-geo";
import { buildInteriors } from "../_kit/interior";
import { INTERIOR_ROOMS } from "../../../../../shared/pois/banana-temple";

const W = TEMPLE_C;
const V = (pos: CamSpec["pos"], target: CamSpec["target"], o: Partial<CamSpec> = {}): CamSpec => ({ pos, target, fov: 50, ...o });
/** local → world (180° frame) */
const L = (x: number, y: number, z: number): [number, number, number] => { const [wx, wz] = templeToWorld(x, z); return [wx, W.y + y, wz]; };

const mod: WorldModule = {
  id: "poi:banana-temple",
  views: {
    // the view camera: ~2.2 m up at the plaza's front, the door + idol centre, head top-centre, the big left tower at
    // the left edge, the right tower centre-right, crate/barrel/post dressing bottom-right, the planter bottom-left
    "poi-04-banana-temple": V(L(2.0, 2.1, 8.5), L(0.3, 20, -46), { fov: 64, note: "plaza establishing shot" }),
    "loot-06-golden-vault": V(L(0, TEMPLE.chamber.y0 + 2.7, TEMPLE.chamber.z1 - 0.3), L(0, TEMPLE.chamber.y0 + 1.9, TEMPLE.altar.z - 2), { fov: 68, note: "vault interior from the corridor" }),
    "temple-top": V(L(34, 44, 24), L(0, 32, -46), { fov: 50, note: "the head, close" }),
    "temple-side": V(L(-70, 20, 30), L(0, 14, -30), { fov: 55, note: "west side: side stairs, towers" }),
    "temple-door": V(L(0.5, 3.2, 2), L(0, 7, -25), { fov: 55, note: "the portal + idol" }),
  },
  async build(ctx) {
    const endSlices = sliceMeter("banana-temple");
    const root = new THREE.Group(); root.name = "banana-temple";
    root.position.set(W.x, W.y, W.z); root.rotation.y = Math.PI; root.updateMatrixWorld(true);
    ctx.scene.add(root);
    // time-sliced: a yield between the big pieces so the streamed build never holds the main thread > 50 ms
    await prepareGoldEnv(ctx.renderer, () => ctx.yield());
    const mats = templeMaterials(ctx);
    await ctx.yield();
    buildPyramid(ctx, mats, root); await ctx.yield();
    buildPortal(ctx, mats, root); await ctx.yield();
    const towerTops = buildTowers(ctx, mats, root); await ctx.yield();
    buildPlaza(ctx, mats, root); await ctx.yield();
    await buildCover(ctx, mats, root); await ctx.yield();
    buildIdol(ctx, mats, root);
    buildIvy(ctx, root, leafClusterTex("ivy")); await ctx.yield();
    const [, vault] = await Promise.all([buildHead(ctx, mats, root), buildVault(ctx, mats, root)]);
    await ctx.yield();
    // the furnished rooms (shared interiors kit, style "temple"): offering halls, galleries, shrine, every tower storey
    // shown within 200 m: switched on at 90 m, the furnished rooms (≈ 20 draws) visibly grew in through the tower windows / doors
    // (the engine fades a switch by scale); at 200 m the openings are dark specks
    await buildInteriors(ctx, INTERIOR_ROOMS, { name: "temple-interiors", maxDist: 200 });
    // the dungeon's own architecture + dressing (bays, lintels, braziers, rubble, idols, colonnade, floors, roots)
    const dungeon = await buildDungeon(ctx, mats, root); await ctx.yield();
    root.updateMatrixWorld(true);
    // shadows: the detailed blocks don't cast; a box proxy (the collider boxes + cornice slabs) casts for them. The head
    // keeps its own silhouette.
    noCast(root, /temple-head$|hero:gorilla-head/);
    const pb = templeColliders().filter((b) => b.surf !== "wood" && !b.noShoot && Math.max(b.h[0], b.h[2]) > 0.5);
    for (const t of TEMPLE.tiers.slice(0, 5)) { const y = W.y + t.y0 + t.h + 0.35, hl = t.half + 0.35; for (const [dx, dz, hx, hz] of [[0, hl, t.half + 0.7, 0.45], [0, -hl, t.half + 0.7, 0.45], [hl, 0, 0.45, t.half], [-hl, 0, 0.45, t.half]]) { const [x, z] = templeToWorld(TEMPLE.pyr.cx + dx, TEMPLE.pyr.cz + dz); pb.push({ c: [x, y, z], h: [hx, 0.35, hz], yaw: 0 }); } }
    // the head's heightfield columns (inside the head mesh, which casts its own shadow) never go into the proxies
    const inHead = (b: { c: number[] }) => b.c[1] > W.y + TEMPLE.head.y - 0.1 && Math.abs(W.x - b.c[0] - TEMPLE.pyr.cx) < 11 && Math.abs(W.z - b.c[2] - TEMPLE.pyr.cz) < 15.5;
    ctx.scene.add(shadowProxy(pb.filter((b) => !inHead(b)), "temple-shadow-proxy"));
    // INSIDE the vault (past the corridor's first 2.5 m, walls all round) nothing outside can be seen: the temple exterior
    // detail, the head and the other jungle POIs switch off (≈ 0.9 M resident triangles otherwise drawn behind the walls)
    // Position alone is not enough: 2.5 m past the door the doorway is still in view, and the golden idol, the portal, the
    // plaza dressing would blink out / in right in front of the player. So it also needs the DOORWAY out of view (angle from
    // the camera's forward > the half-diagonal fov + the doorway's angular radius + a margin for a fast turn): whatever
    // switches is never on screen.
    const IZ0 = mats.vault, [dwx, dwz] = templeToWorld(0, TEMPLE.door.z), dwy = W.y + TEMPLE.door.sill + TEMPLE.door.h / 2;
    const _fwd = new THREE.Vector3(), _toD = new THREE.Vector3();
    const doorInView = () => {
      const cam = ctx.camera as THREE.PerspectiveCamera;
      _toD.set(dwx - cam.position.x, dwy - cam.position.y, dwz - cam.position.z);
      const dist = _toD.length(); if (dist < 0.5) return true;
      cam.getWorldDirection(_fwd);
      const halfDiag = Math.atan(Math.tan(((cam.fov ?? 70) * Math.PI) / 360) * Math.sqrt(1 + (cam.aspect ?? 1.8) ** 2));
      return Math.acos(Math.min(1, Math.max(-1, _fwd.dot(_toD) / dist))) < halfDiag + Math.atan(4.6 / dist) + 0.6;
    };
    const IZ = IZ0, insideVault = (c: THREE.Vector3) => c.x > IZ.min.x && c.x < IZ.max.x && c.z > IZ.min.z && c.z < IZ.max.z && c.y < IZ.max.y && c.dot(IZ.axis) > IZ.door + 2.5 && !doorInView();
    // (the switch itself runs once per frame AFTER the distance switches below: it overrides their result while sealed and
    // restores the outside the same frame the doorway turns toward the view)
    const sealedHide: THREE.Object3D[] = root.children.filter((o) => /^temple-head/.test(o.name));
    // FAR PROXY: the collider massing (tiers, towers, portal, pedestals, planters…) as one box mesh in the stone material.
    // swaps at 400 m as a dither crossfade (a SCALE fade would shrink the whole pyramid to a
    // point while the massing grows in, on every fly-in). The massing matches the silhouette; the detail costs ≈ +0.6 M
    // triangles over it (measured at 450 m: 600 m was over the frame budget)
    const center = new THREE.Vector3(W.x - TEMPLE.pyr.cx, W.y + 12, W.z - TEMPLE.pyr.cz * 0.5), FAR = 400;
    { const geos: THREE.BufferGeometry[] = [], mm = new THREE.Matrix4(), qq = new THREE.Quaternion(), ee = new THREE.Euler();
      for (const b of templeColliders()) { if (b.surf === "wood" || b.noShoot || Math.max(b.h[0], b.h[1], b.h[2]) < 0.6 || inHead(b)) continue;
        const g = new THREE.BoxGeometry(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2); ee.set(0, -(b.yaw ?? 0), 0); qq.setFromEuler(ee); mm.compose(new THREE.Vector3(...b.c), qq, new THREE.Vector3(1, 1, 1)); g.applyMatrix4(mm); geos.push(g.toNonIndexed()); }
      const g = merge(geos)!; boxUVs(g, 4.2); tint(g, "#e8e0cc");
      const proxy = new THREE.Mesh(g, mats.stone); proxy.name = "temple-far-proxy"; proxy.castShadow = false; proxy.receiveShadow = true; proxy.userData.castShadow = false; proxy.matrixAutoUpdate = false;
      // (under its own scene group — a module ROOT carries the terrain-occlusion gate on `visible` and cannot
      // dissolve, so the far proxy would blink out while the detail dissolves in)
      // (no noCull: with the dither dissolve the massing and the detail crossfade at FAR = 400 m instead of cutting)
      { const pr = new THREE.Group(); pr.name = "temple-far-proxy-root"; pr.add(proxy); ctx.scene.add(pr); }
      const near260 = /plaza-(ropes|bananas|wood|glyphs)|temple-ivy|jungle-vines|temple-ropes|temple-bridge|temple-tower-windows|jungle-puffs/;
      const detail = root.children.filter((o) => /^(temple-(stone|frieze|towers|tower-friezes|portal|portal-frieze|head-collar|idol|idol-plinth|idol-glyph|idol-glow)|plaza-|door-dark)/.test(o.name) && !near260.test(o.name));
      const keepInside = /^temple-(stone|frieze)$/;   // the pyramid mass carries the vault's own walls
      sealedHide.push(...detail.filter((o) => !keepInside.test(o.name)));
      distanceSwitch(ctx, [{ o: proxy, center, near: FAR }, ...detail.map((o) => ({ o, center, test: (_c: THREE.Vector3, d: number) => d < FAR }))]); }
    // the vault only renders when the camera is inside it or close in front of the door (the door veil hides it otherwise)
    const ch = TEMPLE.chamber, [d0x, d0z] = templeToWorld(0, TEMPLE.door.z), [pcx, pcz] = templeToWorld(TEMPLE.pyr.cx, TEMPLE.pyr.cz);
    distanceSwitch(ctx, [
      // the vault dressing: whenever the camera is inside the pyramid's footprint (any room / door) or near the portal
      { o: vault, test: (c) => (Math.abs(c.x - pcx) < 23 && Math.abs(c.z - pcz) < 23 && c.y < W.y + ch.y1 + 12) || Math.hypot(c.x - d0x, c.z - d0z) < 16 },
      // the dungeon dressing: inside / beside the pyramid only (its doors are on the E / W faces and the tier ledges)
      { o: dungeon, test: (c) => Math.abs(c.x - pcx) < 34 && Math.abs(c.z - pcz) < 30 && c.y < W.y + 32 },
      // ropes, bridges, ivy, tower windows: 400 m with the massing (at 260 m the rope bridges popped in on the fly-in);
      // 20 m of hysteresis so walking along the ring does not flip them on and off
      ...root.children.filter((o) => /plaza-(ropes|bananas|wood|glyphs)|temple-ivy|jungle-vines|temple-ropes|temple-bridge|temple-tower-windows|jungle-puffs/.test(o.name)).map((o) => { sealedHide.push(o); return { o, test: (_c: THREE.Vector3, d: number) => d < (o.visible ? FAR + 20 : FAR) }; }),
    ]);
    { let sealed = false, others: THREE.Object3D[] | null = null;
      ctx.onUpdate(() => {
        const now = insideVault(ctx.camera.position);
        if (now) { others ??= ctx.scene.children.filter((o) => o.name === "ripe-peak" || o.name === "mist-falls"); for (const o of sealedHide) o.visible = false; for (const o of others) o.visible = false; }
        else if (sealed) { for (const o of sealedHide) o.visible = true; for (const o of others ?? []) o.visible = true; }   // (inside the vault every one of them is well within FAR)
        sealed = now;
      }); }

    // plants (veg species — no flat fern cards): banana plants + heliconia/bromeliads + ferns + monstera in the planters,
    // ferns along the stair and tier tops, monstera by the towers, bushes + palms on the tier tops and crowns, palms and
    // jungle trees ringing the plaza, a palm frame left
    // ?jungleNoVeg: skip the POI-planted vegetation (perf isolation)
    const veg = new URLSearchParams(location.search).has("jungleNoVeg") ? undefined : ctx.shared.get("veg") as VegApi | undefined;
    if (veg) {
      const rnd = mulberry(4040);
      const P: Partial<Record<PlantKind, THREE.Matrix4[]>> = {};
      const add = (k: PlantKind, lx: number, lz: number, s = 1, ly?: number) => { const [x, z] = templeToWorld(lx, lz); (P[k] ??= []).push(new THREE.Matrix4().compose(new THREE.Vector3(x, ly !== undefined ? W.y + ly : ctx.terrain.height(x, z), z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rnd() * 6.28, 0)), new THREE.Vector3(s, s, s))); };
      for (const p of TEMPLE.planters) {
        const w = p.x1 - p.x0, d = p.z1 - p.z0;
        add("banana-plant", p.x0 + w * 0.3, p.z0 + d * 0.45, 0.95, p.h - 0.2); add("banana-plant", p.x0 + w * 0.72, p.z0 + d * 0.6, 0.85, p.h - 0.2);
        for (let i = 0; i < 4; i++) add("flowers", p.x0 + 1 + rnd() * (w - 2), p.z0 + 1 + rnd() * (d - 2), 1.2 + rnd() * 0.3, p.h - 0.15);
        for (let i = 0; i < 5; i++) add("fern", p.x0 + 0.8 + rnd() * (w - 1.6), p.z0 + 0.8 + rnd() * (d - 1.6), 1.0 + rnd() * 0.4, p.h - 0.15);
        add("monstera", p.x0 + w * (rnd() < 0.5 ? 0.15 : 0.85), p.z0 + d * 0.5, 1.2, p.h - 0.2);
      }
      for (const [x, z, w] of TEMPLE.apron) { add("flowers", x - w * 0.25, z, 1.2, 1.15); add("fern", x + w * 0.25, z, 1.0, 1.15); add("flowers", x + w * 0.05, z + 0.1, 1.0, 1.15); }
      for (const [x, z] of [[-20, 8], [21, 6], [-31, -4], [30, -8], [-33, -38], [34, -24], [-36, 4], [38, 6], [-30, 22], [30, 24]]) add("banana-plant", x, z, 1 + rnd() * 0.4);
      for (const [x, z] of [[-19, -5], [19.5, -8], [18, 24], [-19, 26], [-31, -30], [32, -44], [-34, 20], [34, 22], [-23.5, -14], [10, -21]]) add("monstera", x, z, 1.1 + rnd() * 0.5);
      // ferns + bromeliads at the stair foot + along the stair sides + at the pedestals
      for (let i = 0; i < 16; i++) { const sx = rnd() < 0.5 ? -1 : 1; add(rnd() < 0.7 ? "fern" : "flowers", sx * (TEMPLE.stair.width / 2 + 0.6 + rnd() * 2.5), TEMPLE.stair.z0 + 2 - rnd() * 7, 0.8 + rnd() * 0.5, 0.1); }
      for (const [x, z] of TEMPLE.pedestals) { add("fern", x + 1.1, z + 0.5, 0.9, 0.1); if (rnd() < 0.5) add("flowers", x - 1, z + 0.8, 1.1, 0.1); }
      // tier tops: bushes + ferns + a few palms and banana plants (overgrown terraces)
      TEMPLE.tiers.slice(0, 5).forEach((t, i) => {
        const y = t.y0 + t.h, z1 = TEMPLE.pyr.cz + t.half - 1.8;
        for (let k = 0; k < 7; k++) { const x = -t.half + 2 + rnd() * (t.half * 2 - 4); if (Math.abs(x) < 7.5 && i <= 2) continue; const q = rnd(); add(q < 0.45 ? "fern" : q < 0.75 ? "bush" : q < 0.9 ? "banana-plant" : "palm", x, z1 - rnd() * 1.2, 0.7 + rnd() * 0.4, y); }
        for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) add(rnd() < 0.6 ? "fern" : "bush", sx * (t.half - 1.5), TEMPLE.pyr.cz + (rnd() - 0.5) * t.half * 1.6, 0.7 + rnd() * 0.4, y);
      });
      // tower crowns + around the tower feet
      TEMPLE.towers.forEach((tw, i) => { const top = towerTops[i]; add("bush", tw.x + 0.8, tw.z - 0.6, 0.7, top.y); add("fern", tw.x - 0.9, tw.z + 0.5, 0.8, top.y); if (i === 0 || i === 2) add("palm", tw.x - 0.4, tw.z - 1.2, 0.55, top.y); add("fern", tw.x + tw.w * 0.7, tw.z + tw.w * 0.6, 1.1); add("flowers", tw.x - tw.w * 0.7, tw.z + tw.w * 0.65, 1.1); });
      // plaza rim + beyond: palms, jungle trees, bushes, ferns, flowers — only a third of the trees, for
      // light tree cover and clean sight lines onto the plaza and the tiers (the ring outside is the approach fight)
      // (the skipped ones still draw their numbers: every plant after them — the hand-placed frame and vault plants — keeps its spot)
      for (let i = 0; i < 18; i++) { const a = rnd() * 6.28, r = 46 + rnd() * 30, sc = 0.9 + rnd() * 0.5; if (i % 2) { rnd(); continue; } add("palm", Math.cos(a) * r, Math.sin(a) * r, sc); }
      for (let i = 0; i < 30; i++) { const a = rnd() * 6.28, r = 50 + rnd() * 34, sc = 0.9 + rnd() * 0.6; if (i % 3) { rnd(); continue; } add("jungle-tree", Math.cos(a) * r, Math.sin(a) * r, sc); }
      for (let i = 0; i < 44; i++) { const a = rnd() * 6.28, r = TEMPLE.plazaR + 2 + rnd() * 30; add(rnd() < 0.6 ? "fern" : "bush", Math.cos(a) * r, Math.sin(a) * r, 0.8 + rnd() * 0.7); }
      for (let i = 0; i < 20; i++) { const a = rnd() * 6.28, r = TEMPLE.plazaR + 1 + rnd() * 16; add("flowers", Math.cos(a) * r, Math.sin(a) * r, 1); }
      // the view's left frame: a big palm + banana leaves near the camera (left of its axis)
      add("palm-leaning", -9.5, 5, 1.15); add("banana-plant", -7.5, 3.5, 1.25); add("fern", -3.6, -3.2, 1.2); add("flowers", -3.4, -1.4, 1.3);
      add("monstera", 8.8, 2.5, 1.35); add("fern", 7.2, 1.2, 1.1); add("banana-plant", 10.5, 4, 1.2);
      // inside the vault: ferns, a monstera and banana plants in the corners by the entrance
      const ch = TEMPLE.chamber, fy = ch.y0;
      for (const sx of [-1, 1]) { add("banana-plant", sx * (ch.x1 - 1.3), ch.z1 - 2.2, 1.15, fy); add("monstera", sx * (ch.x1 - 1.0), ch.z1 - 3.6, 1.1, fy); add("fern", sx * (ch.x1 - 1.6), ch.z1 - 1.2, 1.1, fy); add("monstera", sx * (ch.x1 - 0.9), TEMPLE.altar.z + 7, 0.9, fy); add("fern", sx * (ch.x1 - 1.2), TEMPLE.altar.z + 4.5, 0.9, fy); add("banana-plant", sx * (ch.x1 - 0.9), TEMPLE.altar.z + 2, 0.8, fy);
        // the vault walls are lined with monstera + ferns + banana plants between the statues and pillars
        for (const dz of [5.8, 8.6, 10.2, 18.6, 21.0]) add(rnd() < 0.5 ? "monstera" : "fern", sx * (ch.x1 - 0.8 - rnd() * 0.4), TEMPLE.altar.z + dz, 0.8 + rnd() * 0.3, fy);
        add("fern", sx * 3.4, TEMPLE.altar.z + 3.6, 0.7, fy + 0.4); add("monstera", sx * 3.9, TEMPLE.altar.z - 1.8, 0.75, fy + 1.2); }
      for (const [k, list] of Object.entries(P)) veg.plant(k as PlantKind, list!);
    }
    endSlices();
  },
};
export default mod;
