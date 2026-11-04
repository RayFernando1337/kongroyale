// poi-town ASSET LAB: isolated test stages for the town kit's hero assets, so each asset can be built and inspected on
// its own (no dependence on the in-progress POI layouts). Every lab lives in its own slot in the shallow lagoon NE of
// the island (turquoise water, sandy floor), far from any POI. A lab is built by the mango-market module INSTEAD of the
// market when the page is opened with `?view=townlab-<name>` or with `?cam=` pointing into the lab region.
//
//   node tools/shot.mjs townlab-statue --modules atmos,water,poi:mango-market --out <dir>
//   node tools/shot.mjs --cam 506,3,-494,500,1.5,-500,45 --name statue-close --modules atmos,water,poi:mango-market --out ...
//   (add veg to --modules to get the real palms/monstera instead of the POI fallbacks)
//
// Contract for an asset file `client/src/world/pois/_kit/town-<name>.ts`:
//   export async function lab(env: LabEnv): Promise<void> | void   — place the asset (and variations) around the
//   slot origin using env.at(x, y, z, yaw) (metres relative to the slot; y = 0 is the slot floor top). Put geometry in
//   env.bins (merged, vertex-colour tinted), special-material meshes in env.extra. Optional:
//   export const labGround: "paving" | "sand" | "water" — default "paving" (a 36 x 36 m flagstone platform at y 0.6).
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import type { CamSpec } from "../../../engine/views";
import { mulberry } from "../../../../../shared/pois/town-kit";
import { townMats, makeBins, buildBins, type TownBins, type TownMats } from "./town-materials";
import { M, col, slabGeo, boxGeo } from "./town-geo";
import { TownVeg } from "./town-veg";
import { flag } from "../../../flags";

/** lab name → slot origin (world). Water labs sit in ~1–2 m of water; dry labs get a platform at y = 0.6 */
export const LAB_SLOTS: Record<string, [number, number]> = {
  statue: [500, -500], market: [550, -500], hut: [600, -500],
  resort: [500, -545], building: [550, -545], boat: [600, -545], fountain: [450, -500], props: [450, -545],
};
export const LAB_REGION = { x0: 400, x1: 650, z0: -590, z1: -455 };
const PLATFORM_Y = 0.6;

export interface LabEnv {
  ctx: WorldCtx;
  bins: TownBins;
  mats: TownMats;
  rng: () => number;
  /** meshes with their own materials (keep it to a handful) */
  extra: THREE.Object3D[];
  /** plants through the veg api (or POI fallbacks when veg is not loaded) */
  veg: TownVeg;
  /** slot origin (world) — y is the floor top (platform top, or 0 = sea level for water labs) */
  origin: THREE.Vector3;
  /** matrix at slot-relative (x, y, z) with yaw (radians, about +y) */
  at(x: number, y: number, z: number, yaw?: number): THREE.Matrix4;
  group: THREE.Group;
}

/** lab views: one hero 3/4 view per lab slot */
export function labViews(): Record<string, CamSpec> {
  const out: Record<string, CamSpec> = {};
  for (const [name, [x, z]] of Object.entries(LAB_SLOTS)) {
    out[`townlab-${name}`] = { pos: [x + 9, 4.2, z + 11], target: [x, 1.6, z], fov: 45, t: 12, stage: `townlab:${name}` };
    out[`townlab-${name}-top`] = { pos: [x + 14, 13, z + 14], target: [x, 0.5, z], fov: 45, t: 12, stage: `townlab:${name}` };
  }
  return out;
}

/** should this page build the lab instead of the POI? */
export function labRequested(): boolean {
  if (flag("view")?.startsWith("townlab-")) return true;
  const cam = flag("cam");
  if (cam) {
    const [x, , z] = cam.split(",").map(Number);
    return x >= LAB_REGION.x0 && x <= LAB_REGION.x1 && z >= LAB_REGION.z0 && z <= LAB_REGION.z1;
  }
  return false;
}

const loaders = import.meta.glob("./town-*.ts");

/** build every lab slot (each asset isolated in try/catch so one broken file never blocks the others) */
export async function buildLabs(ctx: WorldCtx): Promise<void> {
  const group = new THREE.Group();
  group.name = "town-lab";
  ctx.scene.add(group);
  const mats = townMats(ctx.renderer);
  for (const [name, [x, z]] of Object.entries(LAB_SLOTS)) {
    const key = `./town-${name}.ts`;
    const load = loaders[key];
    if (!load) continue;
    let mod: { lab?: (env: LabEnv) => unknown; labGround?: "paving" | "sand" | "water" };
    try { mod = (await load()) as typeof mod; } catch (e) { console.error(`[town-lab] ${name} failed to load`, e); continue; }
    if (typeof mod.lab !== "function") continue;
    const ground = mod.labGround ?? "paving";
    const y0 = ground === "water" ? 0 : PLATFORM_Y;
    const bins = makeBins(mats, `lab-${name}`);
    const rng = mulberry(1234);
    const extra: THREE.Object3D[] = [];
    const origin = new THREE.Vector3(x, y0, z);
    const env: LabEnv = {
      ctx, bins, mats, rng, extra, veg: new TownVeg(ctx, bins, rng), origin, group,
      at: (lx, ly, lz, yaw = 0) => M(x + lx, y0 + ly, z + lz, yaw),
    };
    if (ground !== "water") {
      // platform: flagstone (or sand) top, stone skirt down into the water
      const top = ground === "sand" ? bins.sand : bins.paving;
      top.add(slabGeo(36, 36, 1, 1), M(x, y0, z), col(ground === "sand" ? "#efe3c6" : "#d8c9ad"));
      bins.stone.add(boxGeo(36.4, 2.0, 36.4), M(x, y0 - 1.02, z), col("#b9ad94"));
    }
    try {
      await mod.lab(env);
      env.veg.flush();
    } catch (e) { console.error(`[town-lab] ${name} lab() threw`, e); }
    const sub = new THREE.Group(); sub.name = `town-lab:${name}`;
    buildBins(bins, sub);
    for (const e of extra) sub.add(e);
    group.add(sub);
  }
}
