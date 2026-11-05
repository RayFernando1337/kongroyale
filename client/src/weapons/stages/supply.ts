// loot-04-supply-drop: a BANANA CO. supply drop descending over the south-coast beach, yellow marker smoke
// rising from the landing point, kongs sprinting toward it — the REAL kit path (kit.createSupplyDrop + the kit FX).
// The stage pre-runs 6 s (smoke column built up), then freezes; &fxlive keeps it falling in real time.
import * as THREE from "three";
import { createWeaponsKit } from "../index";
import type { StageDef, StageFile } from "../studio";
import { flag } from "../../flags";

const O = new THREE.Vector3(150, 0, 524);
const live = () => { try { return flag("fxlive"); } catch { return false; } };

const stages: Record<string, StageDef> = {
  supply: {
    origin: O,
    async build(ctx, root, onUpdate) {
      const kit = createWeaponsKit(ctx);
      await kit.createRocket(); // the fx piece is loaded
      const fx = kit.createFx() as { update(dt: number): void };
      const drop = await kit.createSupplyDrop();
      const gy = (x: number, z: number) => Math.max(ctx.terrain.height(O.x + x, O.z + z), 0.2);
      const lx = 6, lz = -4;
      root.add(drop.object);
      drop.object.rotation.y = 0.5;
      // start high so after the pre-run the crate hangs ~10 m up
      drop.place(new THREE.Vector3(lx, gy(lx, lz) + 4.2 + 6 * drop.speed, lz), gy(lx, lz) - O.y);
      for (let i = 0; i < 300; i++) { drop.update(0.02); fx.update(0.02); }
      // kongs sprinting toward the drop (the actors' kong, read-only use of their public createKong)
      try {
        const { createKong } = await import("../../actors/kong");
        const spots: Array<[number, number, number, number]> = [[15.8, 2.2, 0, 1.64], [15.2, -2.4, 1, 1.5], [11.5, 0.8, 2, 1.6], [9.2, -3.2, 3, 1.52], [7.6, 1.8, 4, 1.58]];
        for (const [x, z, variant, yaw] of spots) {
          const k = await createKong(ctx, { variant, lod: "hi" });
          root.add(k.object);
          const pose = { x: O.x + x, y: gy(x, z), z: O.z + z, yaw, pitch: 0.05, vx: -7.4, vz: 0, vy: 0, state: "move" as const, crouch: false, sprint: true, weapon: (["pistol", "smg", "ar", "shotgun", "pistol"] as const)[variant], team: 0, friendly: false };
          k.object.parent?.remove(k.object); ctx.scene.add(k.object);
          for (let f = 0; f < 20 + variant * 7; f++) k.apply(pose, 1 / 60);
          if (live()) onUpdate((dt) => { pose.z -= 7.4 * dt * 0; k.apply(pose, dt); });
        }
      } catch (e) { console.warn("[weapons] supply stage: kongs unavailable", e); }
      if (live()) onUpdate((dt) => { drop.update(dt); fx.update(dt); });
      else onUpdate(() => fx.update(0));
    },
  },
};

const file: StageFile = {
  stages,
  views: {
    // low behind the running kongs, looking up at the canopy over the jungle line (the target art's wide midday shot)
    // looking WEST along the south beach: the sea on the left, the jungle on the right (the target art's layout)
    "loot-04-supply-drop": { pos: [O.x + 19.5, 1.9, O.z + 1.4], target: [O.x + 5, 5.6, O.z - 3], fov: 62, stage: "supply", t: 12, rel: true } as never,
  },
};
export default file;
