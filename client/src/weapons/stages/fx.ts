// FX dev views (the real kit FX in world light on the Peel Strip grass): every stage runs a short deterministic script
// (emit → advance the FX clock) and then FREEZES the FX clock, so a capture always shows the effect mid-flight.
// Add &fxlive to the URL to let it loop in real time instead (humans, &fly).
//   wpn-fx-impacts   one hit on each surface sample (wood crate, metal plate, stone, concrete, glass, fabric) + ground
//                    hits (sand, grass) + banana tracers flying in
//   wpn-fx-muzzle    3P muzzle flashes of all six guns (held models, big) + tracers
//   wpn-fx-explosion rocket explosion on the grass at 0.18 s + the rocket view with its trail
//   wpn-fx-hits      kong hit sparkles (body / headshot) + flesh impacts
import * as THREE from "three";
import type { WorldCtx } from "../../engine/engine";
import type { WeaponId } from "../../../../shared/world/map";
import type { Surface } from "../../../../shared/world/colliders";
import { createWeaponsKit, type FxEx } from "../index";
import { gunSpec } from "../guns/index";
import type { StageDef, StageFile, OnUpdate } from "../studio";
import { flag } from "../../flags";

// the Peel Strip road became jungle (palms + ferns blocked the dev cameras): an open sand beach on the south coast,
// jungle behind, the camera standing at the water line
const O = new THREE.Vector3(150, 0, 524);
const live = () => { try { return flag("fxlive"); } catch { return false; } };

async function fxOf(ctx: WorldCtx): Promise<FxEx> {
  const kit = createWeaponsKit(ctx);
  await kit.createRocket(); // resolves once the fx piece is loaded
  return kit.createFx() as FxEx;
}
/** run `script` (which emits + advances via step(dt)), then keep the FX frozen (or looping when live) */
function runScript(fx: FxEx, onUpdate: OnUpdate, script: (step: (dt: number) => void) => void, period = 2.5) {
  const step = (dt: number) => { const n = Math.max(1, Math.round(dt / 0.02)); for (let i = 0; i < n; i++) fx.update(dt / n); };
  script(step);
  if (live()) { let t = 0; onUpdate((dt) => { t += dt; if (t > period) { t = 0; script(() => {}); } fx.update(dt); }); }
  else onUpdate(() => fx.update(0));
}
const yAt = (ctx: WorldCtx, x: number, z: number) => ctx.terrain.height(O.x + x, O.z + z);

function block(root: THREE.Group, ctx: WorldCtx, x: number, z: number, w: number, h: number, d: number, color: string, rough = 0.8, metal = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  m.position.set(x, yAt(ctx, x, z) + h / 2, z); m.castShadow = true; m.receiveShadow = true;
  root.add(m);
  return m;
}

const stages: Record<string, StageDef> = {
  "fx-impacts": {
    origin: O,
    async build(ctx, root, onUpdate) {
      const fx = await fxOf(ctx);
      const samples: Array<[Surface, string, number, number, number]> = [
        ["wood", "#9a6a3c", 0.85, 0], ["metal", "#8c949c", 0.35, 0.9], ["stone", "#8a8278", 0.9, 0], ["concrete", "#b8b4ac", 0.85, 0], ["glass", "#bcd8e8", 0.1, 0], ["fabric", "#c9b48a", 0.95, 0],
      ].map(([s, c, r, m], i) => [s as Surface, c as string, r as number, m as number, (i - 2.5) * 1.3]);
      const faces: Array<[Surface, THREE.Vector3]> = [];
      for (const [s, c, r, m, x] of samples) {
        const b = block(root, ctx, x, -2.5, 1.0, 1.4, 0.3, c, r, m);
        faces.push([s, new THREE.Vector3(x, b.position.y + 0.1, -2.5 + 0.151)]);
      }
      const P = new THREE.Vector3(), N = new THREE.Vector3(0, 0, 1), W = new THREE.Vector3(), from = new THREE.Vector3();
      root.updateMatrixWorld(true);
      runScript(fx, onUpdate, (step) => {
        // older hits first (their decals stay), then the fresh volley that is captured mid-flight
        for (let k = 0; k < 3; k++) {
          for (const [s, p] of faces) { P.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.9, 0)); fx.impact(root.localToWorld(W.copy(P)), N, s); }
          for (const [s, x] of [["sand", -1.6], ["grass", 1.6]] as Array<[Surface, number]>) { P.set(x + (Math.random() - 0.5), yAt(ctx, x, -0.6) + 0.01, -0.6); fx.impact(root.localToWorld(W.copy(P)), new THREE.Vector3(0, 1, 0), s); }
          step(k < 2 ? 0.8 : 0.1);
        }
        for (const [, p] of faces) { from.set(p.x * 0.3, 1.5 + yAt(ctx, 0, 4), 4); fx.tracer(root.localToWorld(from.clone()), root.localToWorld(p.clone()), "ar"); }
        step(0.012);
      });
    },
  },
  "fx-muzzle": {
    origin: O,
    async build(ctx, root, onUpdate) {
      const kit = createWeaponsKit(ctx);
      const fx = await fxOf(ctx);
      const ids: WeaponId[] = ["pistol", "smg", "ar", "shotgun", "sniper", "rocket"];
      const muzzles: Array<[WeaponId, THREE.Vector3, THREE.Vector3]> = [];
      for (let i = 0; i < ids.length; i++) {
        const g = await kit.createHeldWeapon(ids[i], "rare");
        const holder = new THREE.Group(); holder.add(g);
        // life size (the held models are already ×1.4) and turned ~50° toward the camera — at ×1.6 side-on the six
        // guns overlapped end to end and every flash hid inside the next gun
        const x = (i - 2.5) * 1.3;
        holder.position.set(x, yAt(ctx, x, -1.5) + 1.3, -1.5); holder.rotation.y = Math.PI / 2 + 0.45; holder.scale.setScalar(1.15);
        root.add(holder);
        root.updateMatrixWorld(true);
        const spec = gunSpec(ids[i]);
        const mz = spec.muzzle.clone().sub(spec.gripAnchor).applyMatrix4(holder.matrixWorld);
        muzzles.push([ids[i], mz, new THREE.Vector3(0, 0, -1).transformDirection(holder.matrixWorld)]);
      }
      runScript(fx, onUpdate, (step) => {
        for (const [id, p, d] of muzzles) fx.tracer(p, p.clone().addScaledVector(d, 30), id);
        step(0.018);
      }, 0.4);
    },
  },
  "fx-explosion": {
    origin: O,
    async build(ctx, root, onUpdate) {
      const kit = createWeaponsKit(ctx);
      const fx = await fxOf(ctx);
      const rv = await kit.createRocket();
      const P = root.localToWorld(new THREE.Vector3(0, yAt(ctx, 0, -3) + 0.4, -3));
      if (rv) { rv.object.position.copy(root.localToWorld(new THREE.Vector3(-3, yAt(ctx, -3, -1) + 1.6, -1))); rv.object.lookAt(P); ctx.scene.add(rv.object); }
      runScript(fx, onUpdate, (step) => {
        if (rv) {
          // fly the rocket in from the left for 0.4 s so the trail exists
          const a = root.localToWorld(new THREE.Vector3(-9, yAt(ctx, -9, 1) + 2.2, 1)), b = rv.object.position.clone();
          for (let i = 0; i <= 20; i++) { rv.object.position.lerpVectors(a, b, i / 20); rv.update(0.02); step(0.02); }
        }
        fx.explosion(P.clone().add(new THREE.Vector3(3.5, 0, 0)), 3.5);
        // ?fxt=0.7 freezes later in the timeline (fire → soot → smoke column)
        step((() => { try { return parseFloat(flag("fxt") ?? "0.2"); } catch { return 0.2; } })());
      }, 3);
    },
  },
  "fx-hits": {
    origin: O,
    async build(ctx, root, onUpdate) {
      const fx = await fxOf(ctx);
      runScript(fx, onUpdate, (step) => {
        for (let i = 0; i < 4; i++) {
          const x = (i - 1.5) * 1.1;
          const p = root.localToWorld(new THREE.Vector3(x, yAt(ctx, x, -2) + 1.2 + (i % 2) * 0.4, -2));
          if (i % 2) fx.hitSparkle?.(p, i === 3); else fx.impact(p, new THREE.Vector3(0, 0, 1), "flesh");
        }
        step(0.07);
      }, 0.8);
    },
  },
};

const cam = (p: [number, number, number], t: [number, number, number], fov: number, stage: string) => ({ pos: [O.x + p[0], p[1], O.z + p[2]] as [number, number, number], target: [O.x + t[0], t[1], O.z + t[2]] as [number, number, number], fov, stage, rel: true, t: 12 });
const file: StageFile = {
  stages,
  views: {
    "wpn-fx-impacts": cam([0.2, 1.3, 1.6], [0, 0.75, -2.4], 64, "fx-impacts"),
    "wpn-fx-muzzle": cam([0.2, 1.5, 2.6], [0, 1.25, -1.5], 64, "fx-muzzle"),
    "wpn-fx-explosion": cam([-1, 2.2, 9], [0.5, 1.6, -3], 58, "fx-explosion"),
    "wpn-fx-hits": cam([0, 1.5, 1.6], [0, 1.35, -2], 52, "fx-hits"),
  },
};
export default file;
