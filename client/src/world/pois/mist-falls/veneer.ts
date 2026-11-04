// MIST FALLS — rock veneer: a terrain-conforming skin of wet slate rock over every steep face of the bowl + gorge, so no
// brown terrain ever shows between the sculpted blocks (the walls are rock top to bottom). Built on the terrain's
// own 2 m grid with the same triangle diagonals, lifted 0.25 m along the normal; coverage by slope with an alpha-tested
// noisy edge; the sculpted blocks stand proud of it. One draw, no shadow casting (receives).
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import { WORLD } from "../../../../../shared/world/map";
import { FALLS } from "../../../../../shared/pois/jungle-falls";
import { noise3 } from "../_kit/jungle-geo";
import { flag } from "../../../flags";

export function buildVeneer(ctx: WorldCtx, root: THREE.Group, mat: THREE.MeshStandardMaterial) {
  const t = ctx.terrain, CELL = WORLD.CELL, HALF = WORLD.HALF, S = FALLS.skin;
  const R = S.r1 + 10, cx = S.x, cz = S.z;
  const j0 = Math.floor((cx - R + HALF) / CELL), j1 = Math.ceil((cx + R + HALF) / CELL), i0 = Math.floor((cz - R + HALF) / CELL), i1 = Math.ceil((cz + R + HALF) / CELL);
  const W = j1 - j0 + 1, cov = new Float32Array(W * (i1 - i0 + 1));
  const slopeAt = (x: number, z: number) => Math.hypot(t.height(x + 1.5, z) - t.height(x - 1.5, z), t.height(x, z + 1.5) - t.height(x, z - 1.5)) / 3;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const x = -HALF + j * CELL, z = -HALF + i * CELL, d = Math.hypot(x - cx, (z - cz) * 1.05);
    if (d > R) continue;
    const y = t.height(x, z), sl = slopeAt(x, z);
    let a = Math.min(1, Math.max(0, (sl - 0.5) / 0.3)) * (1 - Math.min(1, Math.max(0, (d - (R - 12)) / 12)));
    if (y < FALLS.pool.level + 0.4) a *= Math.max(0, (y - FALLS.pool.level + 0.6) / 1.0);   // never in the pool
    if (x > -128 && Math.abs(z + 402) < 13) a = 0;                                          // the river outlet floor
    cov[(i - i0) * W + (j - j0)] = a;
  }
  const pos: number[] = [], col: number[] = [], idx: number[] = [], vid = new Map<number, number>();
  const n = new THREE.Vector3();
  const vert = (i: number, j: number) => {
    const k = i * 8192 + j; let v = vid.get(k); if (v !== undefined) return v;
    const x = -HALF + j * CELL, z = -HALF + i * CELL, y = t.height(x, z);
    n.set(t.height(x - 1, z) - t.height(x + 1, z), 2, t.height(x, z - 1) - t.height(x, z + 1)).normalize();
    // lumpy, block-like relief (not a stretched smooth plane): chunky cellular bumps along the normal
    const bump = 0.28 + 0.55 * Math.max(-0.4, noise3(x * 0.16, y * 0.22, z * 0.16)) + 0.22 * noise3(x * 0.45, y * 0.5, z * 0.45);
    v = pos.length / 3; pos.push(x + n.x * bump, y + n.y * bump, z + n.z * bump);
    const a = cov[(i - i0) * W + (j - j0)] ?? 0; col.push(1, 1, 1, a); vid.set(k, v); return v;
  };
  for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
    const c = (ii: number, jj: number) => cov[(ii - i0) * W + (jj - j0)];
    if (Math.max(c(i, j), c(i, j + 1), c(i + 1, j), c(i + 1, j + 1)) <= 0) continue;
    const a00 = vert(i, j), a01 = vert(i, j + 1), a10 = vert(i + 1, j), a11 = vert(i + 1, j + 1);
    if (((i + j) & 1) === 0) idx.push(a00, a11, a01, a00, a10, a11); else idx.push(a00, a10, a01, a01, a10, a11);
  }
  if (!idx.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4)); g.setIndex(idx); g.computeVertexNormals();
  const nrm = g.attributes.normal as THREE.BufferAttribute; let up = 0; for (let q = 0; q < nrm.count; q++) up += nrm.getY(q);
  if (up < 0) { const ix = g.index!.array as Uint32Array; for (let q = 0; q < ix.length; q += 3) { const s = ix[q + 1]; ix[q + 1] = ix[q + 2]; ix[q + 2] = s; } g.computeVertexNormals(); }
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  // the veneer material (a dedicated stone material from the caller) + vertex alpha → noisy alpha-tested edge
  const m = mat;
  m.vertexColors = true; m.alphaTest = 0.5; m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2;
  const prev = mat.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace("#include <alphatest_fragment>", `diffuseColor.a = smoothstep(0.0, 1.0, diffuseColor.a * 1.6 - 0.3 + (jfbm(vJWorldPos * 0.35) - 0.5) * 0.9);
        { // dark wet streaks running DOWN the rock (noise constant along y) + mossy seams
          float st = texture2D(uJNoise, vec2(vJWorldPos.x * 0.07 + vJWorldPos.z * 0.05, vJWorldPos.y * 0.004)).g;
          diffuseColor.rgb *= 1.0 - 0.32 * smoothstep(0.55, 0.85, st); }
        ${STRATA_GLSL}
        #include <alphatest_fragment>`);
  };
  const key = mat.customProgramCacheKey.bind(mat); m.customProgramCacheKey = () => key() + "|veneer";
  // the veneer covers most of the gorge walls in view and every pixel of it was alpha-tested (discard:
  // no early depth, and on a tile-based GPU — the Mac — no hidden-surface removal for anything behind it). Its shader alpha
  // is smoothstep(a·1.6 − 0.3 + (jfbm − 0.5)·0.9) with jfbm ∈ [0, 1]: wherever the interpolated vertex alpha a ≥ 0.79 it is
  // ≥ 0.5 for every noise value, i.e. never discarded. Triangles whose three vertices have a ≥ 0.8 draw from an OPAQUE
  // copy of the material (no alpha test) — the same pixels; only the noisy edge band stays alpha-tested. 0 = one mesh (A/B).
  const ix = g.index!.array as ArrayLike<number>, A = g.attributes.color as THREE.BufferAttribute;
  const solid: number[] = [], edge: number[] = [];
  const split = flag("veneerSplit");
  for (let q = 0; q < ix.length; q += 3) { const a = Math.min(A.getW(ix[q]), A.getW(ix[q + 1]), A.getW(ix[q + 2])); (split && a >= 0.8 ? solid : edge).push(ix[q], ix[q + 1], ix[q + 2]); }
  const add = (index: number[], mm: THREE.Material, name: string) => {
    if (!index.length) return;
    const gg = new THREE.BufferGeometry(); for (const k of Object.keys(g.attributes)) gg.setAttribute(k, g.attributes[k]); gg.setIndex(index); gg.computeBoundingSphere(); gg.computeBoundingBox();
    const mesh = new THREE.Mesh(gg, mm); mesh.name = name; mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.userData.castShadow = false; mesh.userData.farShadow = false; mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    root.add(mesh);
  };
  if (solid.length) {
    const o = m.clone(); o.alphaTest = 0; o.onBeforeCompile = m.onBeforeCompile; o.customProgramCacheKey = () => key() + "|veneer-solid";
    add(solid, o, "falls-veneer-solid");
  }
  add(edge, m, "falls-veneer");
}

/** LAYERED wet cliff strata on the steep faces: wavy horizontal beds 1.6–2.8 m thick, a dark
 *  shadowed seam under each bed's lip, a lighter weathered lip on top, moss creeping along the lips — the gorge walls read
 *  as one bedded cliff instead of boulders on a flat wall. Needs stoneMaterial's vJWorldPos / vJWorldNormal / jfbm. */
export const STRATA_GLSL = `
        { vec3 sn = normalize(vJWorldNormal); float sd = 1.0 - smoothstep(0.55, 0.85, abs(sn.y));
          if (sd > 0.01) {
            float wy = vJWorldPos.y + (jfbm(vJWorldPos * 0.06) - 0.5) * 4.0, th = 2.2 + 0.6 * sin(vJWorldPos.x * 0.05 + vJWorldPos.z * 0.04);
            float band = fract(wy / th), seam = smoothstep(0.0, 0.07, band), lip = smoothstep(0.78, 0.97, band);
            float under = 1.0 - smoothstep(0.0, 0.35, band);
            vec3 strat = diffuseColor.rgb * mix(0.42, 1.0, seam) * (1.0 - 0.22 * under) * (0.92 + 0.22 * lip);
            float mz = lip * smoothstep(0.45, 0.7, jfbm(vJWorldPos * 0.21 + 3.0));
            strat = mix(strat, vec3(0.2, 0.36, 0.08), mz * 0.7);
            diffuseColor.rgb = mix(diffuseColor.rgb, strat, sd);
          } }`;
/** the strata on any stone material (the sculpted cliff blocks: they read as the same bedded rock as the veneer) */
export function strataPatch(m: THREE.MeshStandardMaterial) {
  const prev = m.onBeforeCompile, key = m.customProgramCacheKey?.bind(m);
  m.onBeforeCompile = (sh, r) => { prev.call(m, sh, r); sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" + STRATA_GLSL); };
  m.customProgramCacheKey = () => (key ? key() : "") + "|strata"; m.needsUpdate = true;
}
