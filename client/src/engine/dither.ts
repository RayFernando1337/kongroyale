// DITHER FADES: the engine's visibility / LOD fades dissolve instead of SCALING.
// Every engine fade (DetailCull's
// screen-size cut, a POI module's LOD / visibility switch through cull.ts) used to scale the mesh about its bounding
// centre over 0.3 s — invisible on a pebble, a growing / shrinking 50 m crane, ship or shed on a landmark: exactly a
// game "spawn-in effect". A dithered LOD transition (a stochastic crossfade) avoids that:
// a per-pixel discard against a noise threshold that changes every frame, so the TAA history
// turns it into a smooth translucency (Low's FXAA shows a short fine stipple instead).
//
// No extra shader variants, no per-object uniforms: three uploads exactly three per-object values (modelViewMatrix,
// normalMatrix, modelMatrix). The fade travels in the SCALE of the object's normalMatrix — the shaders normalise every
// normal (normal_vertex / normal_fragment_begin), so a uniformly scaled normalMatrix shades identically — and the
// vertex stage recovers it exactly: det(normalMatrix) · det(mat3(modelViewMatrix)) = k³ (1 for any untouched object,
// whatever its transform). k³ = 1 + 7·a while fading OUT (a = the dissolved amount, 0 = drawn, 1 = gone; a pixel goes
// when its noise n < a) and k³ = 9 + 7·a while fading IN (it is drawn while n < 1 − a): a detail / proxy pair switching
// together uses COMPLEMENTARY masks — every pixel shows exactly one of them, never both, never neither. The TAA jitter (projection
// [2][0], [2][1], Halton 8) seeds the noise, so the pattern moves every frame under TAA and stands still without it.
// The patch goes into three's shared chunks before the first compile: every built-in material (and every POI material
// built on one, incl. onBeforeCompile patches) carries it; depth / distance (shadow) programs are left out (a shadow
// switches at the end of the fade — see cull.ts). ?dither=0 = scale fades instead (A/B).
import * as THREE from "three";
import { flag } from "../flags";

export const DITHER = typeof location !== "undefined" && flag("dither");

const GUARD = "!defined( DEPTH_PACKING ) && !defined( DISTANCE ) && !defined( KR_NO_DITHER )";
let installed = false;
/** GLSL to add the per-frame noise seed inside an expression (other dithers: rock tiers, prop LO fades) */
export const SEED_GLSL = DITHER ? "\n#ifdef KR_DITH_DECL\n + vKrDith.y\n#endif\n" : "";
/** patch three's shared shader chunks (idempotent; must run before the first program compiles) */
export function installDitherChunks() {
  if (installed || !DITHER) return;
  installed = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  // (KR_DITH_DECL marks a shader stage that HAS the varying: a custom shader including project_vertex without the pars
  // chunk — the water's obstacle-coverage pass — must neither write nor read it)
  const decl = `\n#if ${GUARD}\n\tvarying vec2 vKrDith;\n\t#define KR_DITH_DECL\n#endif\n`;
  C.clipping_planes_pars_vertex += decl;
  C.clipping_planes_pars_fragment += decl;
  C.project_vertex += `\n#ifdef KR_DITH_DECL\n\t{\n\t\tfloat krK3 = determinant( normalMatrix ) * determinant( mat3( modelViewMatrix ) );\n\t\tfloat krV = krK3 - 1.0;\n\t\tvKrDith = vec2( krV < 7.5 ? clamp( krV * ( 1.0 / 7.0 ), 0.0, 1.0 ) : - clamp( ( krV - 8.0 ) * ( 1.0 / 7.0 ), 0.0, 1.0 ), fract( projectionMatrix[ 2 ][ 0 ] * 3197.0 + projectionMatrix[ 2 ][ 1 ] * 1931.0 ) );\n\t}\n#endif\n`;
  // (a dissolved amount under 1 % is float noise from the determinants of huge / tiny transforms: never discard there)
  C.clipping_planes_fragment = `#ifdef KR_DITH_DECL\n\tif ( abs( vKrDith.x ) > 0.01 ) {\n\t\tfloat krN = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) + vKrDith.y );\n\t\tif ( vKrDith.x > 0.0 ? krN < vKrDith.x : krN >= 1.0 + vKrDith.x ) discard;\n\t}\n#endif\n` + C.clipping_planes_fragment;
}

const MAIN_RE = /void\s+main\s*\(\s*(void)?\s*\)\s*\{/;
const VS_WRITE = `
  {
    float krK3 = determinant( normalMatrix ) * determinant( mat3( modelViewMatrix ) );
    float krV = krK3 - 1.0;
    vKrDith = vec2( krV < 7.5 ? clamp( krV * ( 1.0 / 7.0 ), 0.0, 1.0 ) : - clamp( ( krV - 8.0 ) * ( 1.0 / 7.0 ), 0.0, 1.0 ), fract( projectionMatrix[ 2 ][ 0 ] * 3197.0 + projectionMatrix[ 2 ][ 1 ] * 1931.0 ) );
  }
`;
const FS_TEST = `
  if ( abs( vKrDith.x ) > 0.01 ) {
    float krN = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) + vKrDith.y );
    if ( vKrDith.x > 0.0 ? krN < vKrDith.x : krN >= 1.0 + vKrDith.x ) discard;
  }
`;
/** give a POI's custom ShaderMaterial (contact shadows, flame cards, spray puffs — no three chunks) the same dissolve,
 *  BEFORE its first compile (engine/cull.ts register): its shader strings get the varying, the write at the end of the
 *  vertex main and the test at the start of the fragment main. false when it cannot (raw / already chunked / odd main) */
export function patchShaderDissolve(m: THREE.ShaderMaterial): boolean {
  if (!installed || m.userData.krDissolve) return !!m.userData.krDissolve;
  if ((m as THREE.Material).type === "RawShaderMaterial") return false;
  const vs = m.vertexShader, fs = m.fragmentShader;
  if (!vs || !fs || /clipping_planes|vKrDith/.test(vs + fs) || !MAIN_RE.test(vs) || !MAIN_RE.test(fs)) return false;
  // (main's own closing brace: helper functions may follow it)
  const mm = MAIN_RE.exec(vs)!;
  let end = -1;
  for (let i = mm.index + mm[0].length, depth = 1; i < vs.length; i++) { const c = vs[i]; if (c === "{") depth++; else if (c === "}" && --depth === 0) { end = i; break; } }
  if (end < 0) return false;
  m.vertexShader = "varying vec2 vKrDith;\n" + vs.slice(0, end) + VS_WRITE + vs.slice(end);
  m.fragmentShader = "varying vec2 vKrDith;\n" + fs.replace(MAIN_RE, (x) => x + FS_TEST);
  m.userData.krDissolve = true;
  return true;
}

/** can this mesh dissolve? (every material a built-in one or a material patched through onBeforeCompile — a custom
 *  ShaderMaterial may not include the chunks: it keeps the scale fade) */
export function ditherable(o: THREE.Object3D): boolean {
  if (!installed) return false;
  const m = (o as THREE.Mesh).material;
  if (!m) return false;
  const list = Array.isArray(m) ? m : [m];
  for (const x of list) {
    if (!x) return false;
    const s = x as THREE.ShaderMaterial;
    if ((s.isShaderMaterial || (x as THREE.Material).type === "RawShaderMaterial") && !x.userData.krDissolve) {
      if ((x as THREE.Material).type === "RawShaderMaterial") return false;
      if (!/clipping_planes_fragment/.test(s.fragmentShader ?? "") || !/project_vertex/.test(s.vertexShader ?? "") || !/clipping_planes_pars_vertex/.test(s.vertexShader ?? "")) return false;
    }
    if ((x as THREE.Material).type === "MeshDepthMaterial" || (x as THREE.Material).type === "MeshDistanceMaterial") return false;
  }
  return true;
}

const M3 = THREE.Matrix3.prototype.getNormalMatrix;
type DObj = THREE.Object3D & { __krDith?: { a: number; in: boolean } };
/** set the dissolved amount of a mesh (0 = drawn, 1 = gone; `fadingIn` picks the complementary mask; the hook stays
 *  until clearDither) */
export function setDither(o: THREE.Object3D, a: number, fadingIn = false) {
  const d = o as DObj;
  if (!d.__krDith) {
    const st = (d.__krDith = { a: 0, in: false });
    // (three computes object.normalMatrix right AFTER onBeforeRender, from modelViewMatrix: an own method on this
    // object's matrix instance scales the result — nothing else in the frame changes)
    (o.normalMatrix as THREE.Matrix3 & { getNormalMatrix: typeof M3 }).getNormalMatrix = function (this: THREE.Matrix3, m: THREE.Matrix4) {
      M3.call(this, m);
      if (st.a > 0.001) this.multiplyScalar(Math.cbrt((st.in ? 9 : 1) + 7 * Math.min(1, st.a)));
      return this;
    };
  }
  d.__krDith.a = a; d.__krDith.in = fadingIn;
}
/** remove the dissolve hook (the matrix is recomputed plainly: a shadow-only draw never sees a stale scale) */
export function clearDither(o: THREE.Object3D) {
  const d = o as DObj;
  if (!d.__krDith) return;
  delete d.__krDith;
  delete (o.normalMatrix as unknown as Record<string, unknown>).getNormalMatrix;
  M3.call(o.normalMatrix, o.modelViewMatrix);
}
