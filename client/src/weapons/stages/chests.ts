// loot-01-crate-closed, loot-02-crate-open, loot-03-rarity-lineup (+ wpn-chest-world: the REAL kit path — instanced
// batches, pooled burst — on Peel Strip at eye height, so studio and game can be compared). One look: the stages show
// the in-game PBR crate under the studio key light; no toon / outline pass.
import * as THREE from "three";
import { RARITIES } from "../../../../shared/world/map";
import { createChestView } from "../chest";
import { createWeaponsKit } from "../index";
import { CRATE_LIGHT, CRATE1_LIGHT, stageCam, type StageDef, type StageFile } from "../studio";
import { flag } from "../../flags";

const stages: Record<string, StageDef> = {
  "loot-closed": {
    origin: "studio",
    light: CRATE1_LIGHT,
    build(ctx, root, onUpdate) {
      const c = createChestView(ctx, "legendary", { studio: true, aura: false });
      c.object.rotation.y = 0;
      root.add(c.object);
      onUpdate((dt, t) => c.update(dt, t));
    },
  },
  "loot-open": {
    origin: "studio",
    light: CRATE_LIGHT,
    build(ctx, root, onUpdate) {
      const c = createChestView(ctx, "legendary", { studio: true, dressed: true, style: "supply", hold: true, aura: false });
      c.object.rotation.y = -0.1;
      root.add(c.object);
      c.open();
      c.update(0.7, 12);
      onUpdate((dt, t) => c.update(dt, t));
    },
  },
  "loot-lineup": {
    origin: "studio",
    light: CRATE_LIGHT,
    build(ctx, root, onUpdate) {
      RARITIES.forEach((r, i) => {
        const c = createChestView(ctx, r, { studio: true, tall: true });
        c.object.position.set((i - 2) * 1.2, 0, 0);
        c.object.rotation.y = -0.95;
        root.add(c.object);
        onUpdate((dt, t) => c.update(dt, t));
      });
    },
  },
  // the in-game path: kit.createChest (batched) + kit.createLoot, placed on the Peel Strip apron
  "chest-world": {
    origin: new THREE.Vector3(-452, 0, 30),
    async build(ctx, root) {
      const kit = createWeaponsKit(ctx);
      const y = (x: number, z: number) => ctx.terrain.height(root.position.x + x, root.position.z + z);
      const views: Array<{ open(): void; object: THREE.Object3D }> = [];
      const autoOpen = !flag("noopen");
      for (let i = 0; i < 12; i++) {
        const v = await kit.createChest(RARITIES[i % 5]);
        const x = ((i % 5) - 2) * 2.2 + (i >= 5 ? 1.1 : 0), z = -3 - Math.floor(i / 5) * 3.2 - (i % 2) * 0.6;
        v.object.position.set(x, y(x, z), z); v.object.rotation.y = 0.35 - i * 0.15;
        root.add(v.object);
        views.push(v);
        if (i === 4 && autoOpen) setTimeout(() => v.open(), 400);
      }
      (window as unknown as { __wpnChests: unknown }).__wpnChests = views;
    },
  },
  // perf stress (the in-game path): 60 crates + 80 floor loot spread 4…110 m round the camera, one crate opening;
  // &nostress builds nothing (A/B with --bench)
  "stress": {
    origin: new THREE.Vector3(-452, 0, 30),
    async build(ctx, root) {
      if (flag("nostress")) return;
      const kit = createWeaponsKit(ctx);
      const y = (x: number, z: number) => ctx.terrain.height(root.position.x + x, root.position.z + z);
      let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const items = ["pistol", "smg", "ar", "shotgun", "sniper", "rocket", "leaf-bundle", "smoothie", "golden-banana", "ammo"] as const;
      for (let i = 0; i < (flag("nochests") ? 0 : 60); i++) {
        const a = rnd() * Math.PI * 2, d = 4 + Math.pow(rnd(), 1.4) * 106, x = Math.cos(a) * d, z = Math.sin(a) * d - 20;
        const v = await kit.createChest(RARITIES[i % 5]);
        v.object.position.set(x, y(x, z), z); v.object.rotation.y = rnd() * 6.28; root.add(v.object);
        if (i === 3) v.open();
      }
      for (let i = 0; i < (flag("noloot") ? 0 : 80); i++) {
        const a = rnd() * Math.PI * 2, d = 3 + Math.pow(rnd(), 1.4) * 107, x = Math.cos(a) * d, z = Math.sin(a) * d - 20;
        const v = await kit.createLoot(items[i % items.length], RARITIES[i % 5]);
        v.object.position.set(x, y(x, z), z); root.add(v.object);
        ctx.onUpdate((dt, t) => v.update(dt, t));
      }
    },
  },
};

const file: StageFile = {
  stages,
  views: {
    // loot-01: the crate fills the square target art (compare = its centre 16:9 band): ¾ from front-left, a little above
    // solved by a camera-fit script on 5 target-art landmarks (near post seam / foot, left + right post seams, near
    // cap top: rms 14 px) — the target art sees the crate at 45° from its front-right corner, ~22° above, overflowing the band
    "loot-01-crate-closed": stageCam([2.48, 1.845, 2.524], [0.057, 0.478, 0.076], 16, "loot-closed"),
    // ¾ from the front-left, ~20° above (the target art sees the front face nearly square-on and the lid's lit underside)
    // ~32° left of the front face, ~26° down into the heap (the target art's "¾ view slightly above, facing right")
    // framing: the target art's band shows the glowing lid, the heap in the upper half, the rim at ~half
    // height and the upper two thirds of the front face (medallion + decals), the crate ~65 % of the frame width
    // solved by the camera-fit script on 6 crate-body landmarks of the target art (rim corners, medallion, foot corners: rms 95 px)
    // — the target art looks ~14° down from ~30° left of the front face, the crate low in the band, lid + heap filling the top
    "loot-02-crate-open": stageCam([-1.573, 1.524, 2.702], [-0.025, 0.732, 0.052], 22, "loot-open"),
    // the target art looks DOWN on the row at ~30° (tops clearly visible)
    "loot-03-rarity-lineup": stageCam([-0.12, 0.6 + 12.7 * Math.sin(0.52), 12.7 * Math.cos(0.52)], [0.0, 0.6, 0], 16, "loot-lineup"),
    "wpn-stress": { pos: [-452, 1.7, 30 + 6], target: [-452, 0.8, 30 - 20], fov: 70, stage: "stress", t: 12, rel: true } as never,
    // eye level at the legendary crates (closed #9 + the opened #4) on grass / sand (the in-world colour check: no olive-khaki)
    "wpn-chest-world-gold": { pos: [-452 + 8.2, 1.6, 30 + 0.8], target: [-452 + 4.6, 0.45, 30 - 4.8], fov: 55, stage: "chest-world", t: 12, rel: true } as never,
    "wpn-chest-world": { pos: [-452 - 1.5, 1.7, 30 + 4.2], target: [-452, 0.6, 30 - 3], fov: 60, stage: "chest-world", t: 12, rel: true } as never,
  },
};
export default file;
