// First-person viewmodel dev views (kong arms + each weapon / heal).
// wpn-vm-<id>: the ui-01-hud beach camera with that item equipped and settled; wpn-vm-<id>-fire: mid-recoil;
// wpn-vm-<id>-reload: mid-reload; wpn-vm-sprint: the AR in the sprint carry pose.
import * as THREE from "three";
import type { CamSpec } from "../../engine/views";
import type { ConsumableId, WeaponId } from "../../../../shared/world/map";
import { createWeaponsKit } from "../index";
import type { StageDef, StageFile } from "../studio";
import { flag } from "../../flags";

// fov 72 = the game camera (settings.fov) — the holds are solved for it
const CAM = { pos: [135, 1.7, 530] as [number, number, number], target: [245, 20, 572] as [number, number, number], fov: 72, rel: true };
const IDS: Array<WeaponId | ConsumableId> = ["pistol", "smg", "ar", "shotgun", "sniper", "rocket", "leaf-bundle", "smoothie", "golden-banana"];
type Mode = "idle" | "fire" | "reload" | "use" | "sprint" | "ads";

function stage(id: WeaponId | ConsumableId, mode: Mode): StageDef {
  return {
    origin: new THREE.Vector3(0, 0, 0),
    async build(ctx, _root, onUpdate) {
      const kit = createWeaponsKit(ctx);
      const fx = kit.createFx();
      await kit.createRocket(); // the fx piece is loaded
      const vm = await kit.createViewModel();
      ctx.camera.add(vm.object);
      vm.equip(id, id === "ar" ? "epic" : "rare");
      const motion = { speed: 0, grounded: true, sprint: false, crouch: false, lookDX: 0, lookDY: 0 };
      if (mode === "sprint") { motion.speed = 7.4; motion.sprint = true; }
      // settle the equip animation deterministically, then trigger the action a fixed time before the capture
      for (let i = 0; i < 60; i++) vm.update(1 / 60, motion);
      // ?vmu=0.45 → the reload frozen at that fraction (default 0.33)
      const vmu = (() => { try { const v = flag("vmu"); return v ? Number(v) : 0.33; } catch { return 0.33; } })();
      if (mode === "reload") { vm.reload(2); const n = Math.round(vmu * 120); for (let i = 0; i < n; i++) vm.update(1 / 60, motion); }
      if (mode === "ads") { vm.setAds?.(true); for (let i = 0; i < 40; i++) vm.update(1 / 60, motion); }
      if (mode === "use") { vm.use(2); for (let i = 0; i < 40; i++) vm.update(1 / 60, motion); }
      const liveMode = (() => { try { return flag("fxlive"); } catch { return false; } })();
      if (mode === "fire" && !liveMode) {
        // one shot, captured 25 ms later: kick in progress, flash + casing in flight; then everything holds still
        ctx.camera.updateMatrixWorld(true);
        vm.fire(); vm.update(0.035, motion); fx.update(0.035);
        onUpdate(() => { vm.update(0, motion); fx.update(0); });
        return;
      }
      let n = 0;
      onUpdate((dt) => {
        n++;
        if (mode === "fire" && n % 12 === 1) vm.fire();
        if (mode === "sprint" || mode === "idle" || mode === "fire" || mode === "ads") vm.update(dt, motion);
        else vm.update(0, motion);
        fx.update(dt);
      });
    },
  };
}

const stages: Record<string, StageDef> = {};
const views: Record<string, CamSpec> = {};
for (const id of IDS) {
  const modes: Mode[] = (["pistol", "smg", "ar", "shotgun", "sniper", "rocket"] as string[]).includes(id) ? ["idle", "fire", "reload", "ads"] : ["idle", "use"];
  for (const mode of modes) {
    const key = mode === "idle" ? `vm-${id}` : `vm-${id}-${mode}`;
    stages[key] = stage(id, mode);
    views[`wpn-${key}`] = { ...CAM, stage: key };
  }
}
stages["vm-sprint"] = stage("ar", "sprint");
// debug: the 1P glove hands wrapped around grips of different sizes (translucent cylinders), front / side / top
stages["vm-hands"] = {
  origin: new THREE.Vector3(0, 0, 0),
  async build(ctx) {
    const { createHand } = await import("../hands");
    const g = new THREE.Group();
    const cyl = new THREE.MeshStandardMaterial({ color: "#e0c040", transparent: true, opacity: 0.55, roughness: 0.4 });
    const cases: Array<[number, number, number, "R" | "L", number, number]> = [
      [0.028, 0.02, 1, "R", 0, 0], [0.028, 0.02, 1, "R", Math.PI / 2, 0], [0.028, 0.02, 1, "R", Math.PI, 0], [0.028, 0.02, 1, "R", 0, Math.PI / 2],
      [0.035, 0.035, 1, "L", 0, 0], [0.035, 0.035, 1, "L", -Math.PI / 2, 0], [0.02, 0.05, 1, "R", -Math.PI / 2, 0], [0.03, 0.03, 0, "R", 0, 0],
    ];
    cases.forEach(([a, b, curl, side, ry, rx], i) => {
      const h = createHand(side);
      h.setGrip(a, b, curl);
      const holder = new THREE.Group(); holder.rotation.set(rx, ry, 0, "YXZ");
      holder.position.set(((i % 4) - 1.5) * 0.17, i < 4 ? 0.09 : -0.1, -0.62);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.16, 32), cyl); c.scale.set(a, 1, b);
      holder.add(c); holder.add(h.mesh);
      g.add(holder);
      holder.updateMatrixWorld(true);
      const tgt = new THREE.Vector3(side === "R" ? 0.1 : -0.1, -0.1, 0.4); h.mesh.localToWorld(tgt); h.aimForearm(tgt);
    });
    ctx.camera.add(g);
  },
};
views["wpn-vm-hands"] = { ...CAM, stage: "vm-hands" };
views["wpn-vm-sprint"] = { ...CAM, stage: "vm-sprint" };

const file: StageFile = { stages, views };
export default file;
