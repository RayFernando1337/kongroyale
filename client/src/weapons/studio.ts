// Shared studio plumbing for the weapons area's showcase stages (showcase.ts).
// Every stage file in ./stages/ exports `stages` (id → StageDef) and `views` (view id / dev id → CamSpec); showcase.ts
// loads each stage file independently (one broken file cannot take down the other stages).
import * as THREE from "three";
import type { WorldCtx } from "../engine/engine";
import type { CamSpec } from "../engine/views";
import { toonMaterial } from "./lib/toon";
import { GLINT } from "./lib/mats";
import { flag } from "../flags";

/** studio origin (world). Sky above the lobby islet: nothing else is up here. */
export const STUDIO = new THREE.Vector3(0, 900, 1020);
/** the studio is built 8× life size: the post pipeline's GTAO radius (2.6 m) and aerial haze are WORLD-space, so at
 *  1× they smother 30 cm props in dark blotches. Screen-space effects (outline, bloom, SMAA) are unaffected. */
export const STUDIO_SCALE = 8;
/** the stilt-hut set sits on the sea south of the lobby islet (doorway looks north at the islet + island) */
export const HUT = new THREE.Vector3(0, 2.4, 1260);

/** a camera authored in stage-local metres (studio: life-size metres, scaled by STUDIO_SCALE for you) */
export function stageCam(p: [number, number, number], t: [number, number, number], fov: number, stage: string, origin: THREE.Vector3 = STUDIO): CamSpec {
  const k = origin === STUDIO ? STUDIO_SCALE : 1;
  return { pos: [origin.x + p[0] * k, origin.y + p[1] * k, origin.z + p[2] * k], target: [origin.x + t[0] * k, origin.y + t[1] * k, origin.z + t[2] * k], fov, stage, t: 12 };
}

export type OnUpdate = (fn: (dt: number, t: number) => void) => void;
export interface StageDef {
  /** "studio" = white cyc in the sky, root scaled ×STUDIO_SCALE (author in life-size metres); a Vector3 = world origin, 1× */
  origin: "studio" | THREE.Vector3;
  /** studio stages: key / fill / grade overrides for this shot */
  light?: Partial<StudioLight>;
  /** build the stage under `root` (already placed + scaled). Apply toonize/addOutlines yourself if you want them. */
  build(ctx: WorldCtx, root: THREE.Group, onUpdate: OnUpdate): void | Promise<void>;
}
export interface StageFile { stages: Record<string, StageDef>; views: Record<string, CamSpec> }

let studio: THREE.Group | null = null;
/** product-sheet light: ONE look for studio and game — the stages show the real in-game PBR materials
 *  under a studio key (atmos sun turned to upper-left-front of the studio cameras), a pale neutral irradiance fill,
 *  warm bounce, a rim, soft AO. No toon pass, no ink outlines. */
// a warm #ece0c4 / #ead09a fill + a 4.2 key push every lit banana over the tone
// curve's shoulder (desaturated toward white → #feca73, hue 37°). So: a NEUTRAL-white key at about half the power and a
// cool-neutral fill: a lit lemon albedo lands at display E ≈ 0.9 (grade.ts sim: #ffe135 → #f2d54b, hue 50°) and the
// shade side keeps a real 2-2.5× lit/shade ratio (cel-like form instead of flat clay).
// The gun / heal sheets keep the frontal key (their sides face the camera); crates get a higher key per stage.
export const STUDIO_LIGHT = { sunElev: 38, sunAz: 205, sunColor: "#fffaf2", sunIntensity: 2.6, envZenith: "#dfe2e8", envHorizon: "#e9eaec", groundHorizon: "#d8d4cc", groundNadir: "#aaa49a", envIntensity: 0.56, envGlow: 0.1, cyc: 1.3, warmBounce: 0.3, saturation: 1.36, bloom: 0.3 };
export type StudioLight = typeof STUDIO_LIGHT;
/** crate product shots: a HIGHER key from the upper left (tops bright, sides a real step darker like the target art), a
 *  weaker neutral-warm fill (a cool fill turns yellow shade olive / grey) and more grade saturation. Measured on loot-01:
 *  lit metal #f7c643 / shade #d6a935 (target art #fdd639 / #c08703). */
export const CRATE_LIGHT: Partial<StudioLight> = { sunElev: 50, sunAz: 215, sunIntensity: 3.2, envZenith: "#ece4d6", envHorizon: "#efe7da", groundHorizon: "#ddd0bb", groundNadir: "#b0a48e", envIntensity: 0.36, saturation: 1.42 };
/** loot-01: the target art's key comes from the upper RIGHT (the rope face is lit #edac06, the front face half-shade
 *  #bb8705, the cap tops brightest #f9bf17) with a soft fill that keeps the shaded front planks chocolate (#6d4631), not
 *  black. Measured: side plate #e7ad36 / front plate #ac7c25 / cap top #fec75b. */
export const CRATE1_LIGHT: Partial<StudioLight> = { ...CRATE_LIGHT, sunAz: 110, sunElev: 50, envIntensity: 0.5 };
/** the white cyc + product-sheet grade (atmos sun as the key light, bloom on, haze / fog / cloud shadow off) */
export function buildStudio(ctx: WorldCtx, light: Partial<StudioLight> = {}): THREE.Group {
  GLINT.value = 1.0;
  applyStudioLight(ctx, light);
  if (studio) return studio;
  studio = new THREE.Group(); studio.name = "weapons-studio";
  // seamless white cyc: an enclosed sphere (back faces) so no sky/sea can leak past a backdrop edge at any camera.
  // Unlit (ShaderMaterials are skipped by the atmos patcher → no haze / cloud-shadow tint); bright enough that the tone
  // curve lands on white, dim enough that coloured halos blended over it still read.
  const white = toonMaterial({ color: new THREE.Color(STUDIO_LIGHT.cyc, STUDIO_LIGHT.cyc, STUDIO_LIGHT.cyc), unlit: true, side: THREE.BackSide });
  const cyc = new THREE.Mesh(new THREE.SphereGeometry(60 * STUDIO_SCALE, 32, 16), white);
  cyc.userData.castShadow = false; cyc.userData.receiveShadow = false; cyc.name = "weapons-studio-cyc"; cyc.userData.noOutline = true;
  cyc.castShadow = false; cyc.receiveShadow = false;
  cyc.frustumCulled = false;
  studio.add(cyc);
  studio.position.copy(STUDIO);
  ctx.scene.add(studio);
  return studio;
}

/** the studio key / fill / grade (+ per-stage overrides, + ?studio=k:v,... dev overrides) */
export function applyStudioLight(ctx: WorldCtx, light: Partial<StudioLight> = {}) {
  const atmos = ctx.shared.get("atmos") as { state: { preset: Record<string, unknown>; apply(p: unknown): void } } | undefined;
  // without the atmos module (?modules=weapons-showcase) there is no post pipeline: tone-map like it would (Neutral)
  if (!atmos) ctx.renderer.toneMapping = THREE.NeutralToneMapping;
  // the world is still drawn behind the cyc (and into the sun's shadow cascades): pull the far plane in to the cyc so
  // the studio frame costs a few ms, not the whole island seen through an 8° lens
  ctx.camera.far = 60 * STUDIO_SCALE * 1.3; ctx.camera.updateProjectionMatrix();
  const L = { ...STUDIO_LIGHT, ...light };
  // dev: ?studio=sunIntensity:3,envIntensity:0.3,sunElev:50 overrides (light tuning without a rebuild)
  try { const q = flag("studio"); if (q) for (const kv of q.split(",")) { const [k, v] = kv.split(":"); (L as Record<string, unknown>)[k] = isNaN(+v) ? v : +v; } } catch { /* no location */ }
  if (atmos) atmos.state.apply({ ...atmos.state.preset, sunElev: L.sunElev, sunAz: L.sunAz, sunColor: L.sunColor, sunIntensity: L.sunIntensity,
    envZenith: L.envZenith, envHorizon: L.envHorizon, groundHorizon: L.groundHorizon, groundNadir: L.groundNadir, envIntensity: L.envIntensity, envGlow: L.envGlow,
    bloom: L.bloom, vignette: 0, saturation: L.saturation, contrast: 1.1, warmth: 0.0, shadeWarmth: 0.0, exposure: 1.0, cloudShadow: 0, hazeDensity: 0, fogDensity: 0, rimLight: 0.35, ao: 0.85, toe: 0,
    // the world preset's grade (warm multi-bounce 1.2, pivot 0.68, knee 0.985) turned every studio banana apricot
    // (pistol body p50 #efb941 hue 41°): the studio keeps its own tone — no warm bounce (a whisper for the shade),
    // its own pivot / knee. Measured: pistol body mid #f7d54d hue 48° (target art lit #fee55d, mid #f7c109)
    warmBounce: L.warmBounce, pivot: 0.55, knee: 0.96 });
}

const _v = new THREE.Vector3();
/** screen box (u0, v0, u1, v1; v down, 0..1) of every vertex under root */
export function screenBox(root: THREE.Object3D, cam: THREE.Camera): [number, number, number, number] {
  root.updateMatrixWorld(true);
  let u0 = 1e9, v0 = 1e9, u1 = -1e9, v1 = -1e9;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.outline || !m.visible) return;
    const p = m.geometry.attributes.position as THREE.BufferAttribute;
    const step = Math.max(1, Math.floor(p.count / 4000));
    for (let i = 0; i < p.count; i += step) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).project(cam);
      const u = (_v.x + 1) / 2, v = (1 - _v.y) / 2;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
  });
  return [u0, v0, u1, v1];
}

/** place `holder` (must have a parent) so its projected box FITS inside `box` (scale by the limiting axis —
 *  a √area fit lets long guns overshoot their box — then centre) */
export function fitToBox(holder: THREE.Object3D, cam: THREE.PerspectiveCamera, box: [number, number, number, number]) {
  for (let it = 0; it < 6; it++) {
    const [u0, v0, u1, v1] = screenBox(holder, cam);
    const k = Math.min((box[2] - box[0]) / (u1 - u0), (box[3] - box[1]) / (v1 - v0));
    holder.scale.multiplyScalar(k);
    const [a0, b0, a1, b1] = screenBox(holder, cam);
    const du = (box[0] + box[2]) / 2 - (a0 + a1) / 2, dv = (box[1] + box[3]) / 2 - (b0 + b1) / 2;
    const p = holder.getWorldPosition(new THREE.Vector3()).project(cam);
    p.x += du * 2; p.y -= dv * 2;
    const w = p.unproject(cam);
    holder.parent!.worldToLocal(w);
    holder.position.copy(w);
    holder.updateMatrixWorld(true);
  }
}

/** a square target-art image (2880²) is shown by the compare sheet as its centre 16:9 band (y 630…2250): map art px
 *  boxes into the 16:9 frame's 0..1 coordinates */
export const squareBox = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] =>
  [x0 / 2880, (y0 - 630) / 1620, x1 / 2880, (y1 - 630) / 1620];
