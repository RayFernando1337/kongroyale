// COCO CAVES lighting: the baked light volume (public/assets/pois/caves/light.bin) applied to
// every POI material through ONE shader patch — the engine has no occlusion-aware GI, so without it the sky IBL would
// light the cave like an open field. Per fragment (sampled 0.7 m off the surface along its normal):
//   • indirect (sky IBL diffuse + specular) × mix(amb, 1, sky visibility)   → dark vault, bright mouths / skylight
//   • direct sun × baked soft sun visibility                                  → the skylight's sun patch, no leaks
//   • + albedo × baked lamp irradiance (occluded crystals, lanterns, lava, the sun patch's warm bounce)
// Outside the volume (or before it loads) the patch is a no-op. Tuning: ?cavesAmb=0.14&cavesLamp=0.55&cavesSky=0.35.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import { assetUrl } from "../../../engine/assets";
import { flag } from "../../../flags";


export const caveU = {
  uCaveOn: { value: 0 },
  uCaveVol: { value: null as THREE.Data3DTexture | null },
  uCaveSun: { value: null as THREE.Data3DTexture | null },
  uCaveMin: { value: new THREE.Vector3() },
  uCaveSize: { value: new THREE.Vector3(1, 1, 1) },
  /** remaining sky IBL deep inside (never black) */
  uCaveAmb: { value: flag("cavesAmb") },
  /** sky visibility at which the exterior look is fully back */
  uCaveSkyK: { value: flag("cavesSky") },
  /** lamp irradiance gain */
  uCaveLamp: { value: flag("cavesLamp") },
  uCaveOff: { value: 0.7 },
  /** cool bias of the remaining cave ambient (the skylight's blue) */
  uCaveCool: { value: new THREE.Color(0.6, 0.88, 1.4) },
};
export let lightHash = 0;
/** the exterior rock albedo (set by rock.ts once the texture loads) */
export const caveRock2 = { value: null as THREE.Texture | null };

/** fetch + parse a caves .bin (u32 header length, JSON header, 4-aligned blobs) */
export async function loadBin(path: string): Promise<{ header: Record<string, unknown> & { blobs: number[][] }; buf: ArrayBuffer }> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer(), hl = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)).trim());
  return { header, buf: buf.slice(4 + hl) };
}

/** start loading the volume (the readiness hold waits for it); materials patched before it arrives just light up */
export function loadCaveLight(ctx: WorldCtx): Promise<void> {
  const release = ctx.hold("coco-caves:light");
  return loadBin("assets/pois/caves/light.bin").then(({ header, buf }) => {
    const V = header.vol as { x0: number; y0: number; z0: number; nx: number; ny: number; nz: number; res: number };
    const [a, b] = header.blobs;
    const vol = new THREE.Data3DTexture(new Uint8Array(buf, a[0], a[1]), V.nx, V.ny, V.nz);
    vol.format = THREE.RGBAFormat; vol.type = THREE.UnsignedByteType; vol.minFilter = vol.magFilter = THREE.LinearFilter; vol.unpackAlignment = 1; vol.needsUpdate = true;
    const sun = new THREE.Data3DTexture(new Uint8Array(buf, b[0], b[1]), V.nx, V.ny, V.nz);
    sun.format = THREE.RedFormat; sun.type = THREE.UnsignedByteType; sun.minFilter = sun.magFilter = THREE.LinearFilter; sun.unpackAlignment = 1; sun.needsUpdate = true;
    caveU.uCaveVol.value = vol; caveU.uCaveSun.value = sun;
    // texel centres: sample i sits at x0 + i·res → the volume spans [x0 − res/2, x0 + (n − ½)·res]
    caveU.uCaveMin.value.set(V.x0 - V.res / 2, V.y0 - V.res / 2, V.z0 - V.res / 2);
    caveU.uCaveSize.value.set(V.nx * V.res, V.ny * V.res, V.nz * V.res);
    caveU.uCaveOn.value = 1;
    lightHash = header.hash as number;
  }).catch((e) => { console.warn("[coco-caves] light volume unavailable — the cave is lit like the outdoors", e); }).finally(release);
}


export interface CaveOpts {
  /** the geometry carries a `caveAO` (normalized) attribute: baked rock AO */
  ao?: boolean;
  /** rock: shift the albedo toward the sunlit exterior tone where the sky is open */
  rockTone?: boolean;
  /** lamp gain multiplier for this material (water: low) */
  lamp?: number;
  /** keep this fraction of the sky specular regardless (glossy water / crystals) */
  spec?: number;
}
/** patch a MeshStandardMaterial (chains any existing onBeforeCompile) */
export function cavePatch<T extends THREE.Material>(m: T, o: CaveOpts = {}): T {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey?.bind(m);
  const lampK = { value: o.lamp ?? 1 };
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    Object.assign(sh.uniforms, caveU, { uCaveLampK: lampK });
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        varying vec3 vCaveW; varying vec3 vCaveN;
        ${o.ao ? "attribute float caveAO; varying float vCaveAO;" : ""}`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
        { vec4 cw = vec4(transformed, 1.0); vec3 cn = objectNormal;
          #ifdef USE_INSTANCING
            cw = instanceMatrix * cw; cn = mat3(instanceMatrix) * cn;
          #endif
          vCaveW = (modelMatrix * cw).xyz; vCaveN = normalize(mat3(modelMatrix) * cn); }
        ${o.ao ? "vCaveAO = caveAO;" : ""}`);
    // ONE fetch of each volume per fragment, at the top of main (the lighting and the rock tone both read it)
    const sample = /* glsl */ `
        vec3 cq = vCaveW + normalize(vCaveN) * uCaveOff; cCu = (cq - uCaveMin) / uCaveSize;
        vec3 ce = min(cCu, 1.0 - cCu); cCf = uCaveOn * smoothstep(0.0, 0.03, min(ce.x, min(ce.y, ce.z)));
        cCl = cCf > 0.0 ? texture(uCaveVol, clamp(cCu, 0.0, 1.0)) : vec4(0.0, 0.0, 0.0, 1.0);
        cCsun = cCf > 0.0 ? texture(uCaveSun, clamp(cCu, 0.0, 1.0)).r : 1.0;`;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vCaveW; varying vec3 vCaveN;
        ${o.ao ? "varying float vCaveAO;" : ""}
        uniform highp sampler3D uCaveVol; uniform highp sampler3D uCaveSun;
        uniform vec3 uCaveMin, uCaveSize, uCaveCool; uniform float uCaveOn, uCaveAmb, uCaveSkyK, uCaveLamp, uCaveOff, uCaveLampK;
        vec3 cCu; float cCf; vec4 cCl; float cCsun;`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
        { ${sample} }`)
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
        {
          vec4 cl = cCl; float cf = cCf, csun = cCsun;
          float csky = cl.a, amb = mix(uCaveAmb, 1.0, smoothstep(0.0, uCaveSkyK, csky));
          amb = mix(1.0, amb, cf); csun = mix(1.0, csun, cf);
          float cao = ${o.ao ? "vCaveAO" : "1.0"};
          vec3 ctint = mix(uCaveCool, vec3(1.0), smoothstep(0.0, uCaveSkyK, csky));
          reflectedLight.indirectDiffuse *= amb * cao * ctint;
          reflectedLight.indirectSpecular *= mix(amb, 1.0, ${(o.spec ?? 0).toFixed(3)}) * cao;
          reflectedLight.directDiffuse *= csun; reflectedLight.directSpecular *= csun;
          vec3 clamp3 = cl.rgb * cl.rgb * 12.0 * cf;
          reflectedLight.directDiffuse += material.diffuseColor * clamp3 * uCaveLamp * uCaveLampK * (0.35 + 0.65 * cao);
          reflectedLight.directSpecular += clamp3 * uCaveLamp * uCaveLampK * 0.06 * (1.0 - roughnessFactor) * cao;
        }`);
    if (o.rockTone) {
      // interior: the dark faceted slate (the stone material's own map, cooled); exterior (open sky): a second, pale
      // weathered stone (triplanar, warm) — blended on the baked sky visibility, BEFORE the moss / wetness layers
      sh.uniforms.uRock2 = caveRock2;
      sh.fragmentShader = sh.fragmentShader.replace("uniform highp sampler3D uCaveVol;", "uniform highp sampler3D uCaveVol; uniform sampler2D uRock2;")
        .replace("vec4 jc = jTri(map, jp, jw); diffuseColor *= jc; }", `vec4 jc = jTri(map, jp, jw);
          { float open = mix(1.0, smoothstep(0.03, uCaveSkyK * 1.5, cCl.a), cCf);
            // (outside, the stone is half desaturated toward a pale warm-grey
            //  limestone instead of the texture's brown)
            float jl = dot(jc.rgb, vec3(0.3, 0.55, 0.15));
            vec4 outside = vec4(mix(vec3(jl) * vec3(1.08, 1.03, 0.94), jc.rgb, 0.4) * 1.12, jc.a);
            // (sedimentary bedding on the steep outer faces — noise-warped bands ~4 m apart, warm ochre / pale grey,
            //  with thin dark bedding lines: a layered sea cliff, not one flat stone slab)
            { vec3 wq = vCaveW; float warp = sin(wq.x * 0.11 + wq.z * 0.07) * 2.2 + sin(wq.x * 0.37 - wq.z * 0.29) * 0.6;
              float band = sin(wq.y * 1.45 + warp), line = smoothstep(0.93, 0.99, fract(wq.y * 0.36 + warp * 0.16));
              vec3 strata = mix(vec3(0.9, 0.8, 0.66), vec3(1.05, 1.03, 1.0), smoothstep(-0.4, 0.7, band)) * (1.0 - 0.32 * line);
              float steep = 1.0 - smoothstep(0.45, 0.75, abs(normalize(vCaveN).y));
              outside.rgb *= mix(vec3(1.0), strata, steep); }
            jc = mix(jc * vec4(0.52, 0.66, 0.96, 1.0), outside, open); }
          diffuseColor *= jc; }`);
    }
  };
  m.customProgramCacheKey = () => `${prevKey ? prevKey() : ""}|cave${o.ao ? "a" : ""}${o.rockTone ? "t" : ""}${(o.spec ?? 0).toFixed(2)}`;
  m.needsUpdate = true;
  return m;
}
