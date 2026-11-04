// CNVS LAB — the rock masses behind the compound (big rounded mossy rocks) + the boulders on the approaches.
// Every massif is a cluster of rounded rock LOBES and every boulder one lobe (shared/pois/cnvs-lab.ts rockLobes /
// lobeShape): a lobed ring per shared row, closed by a superellipse dome. This file draws exactly those rings (the
// colliders are the boxes on the same ring chords — lobeBoxes), so the drawn facets lie on the collider faces; the look
// comes from the faceted-but-smooth-shaded mass, vertex colour (foot AO, strata bands, crevices between lobes, a wet
// streak under each fall) and the jungle stone shader (triplanar rock + moss on every up-facing surface).
// LOD: near mesh (every row) within ROCK_NEAR m of the lab, a coarse copy (every 2nd ring vertex, rows thinned) beyond
// it — the far copy never casts shadows.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import { CX, CZ, rockLobes, lobeShape, MASSIF_FALLS, type LobeShape } from "../../../../../shared/pois/cnvs-lab";
import { pbr, stoneMaterial, bindJungleCtx } from "../_kit/jungle-mat";
import { buildHangingVines, type VineSpot } from "../_kit/jungle-vines";
import { flag } from "../../../flags";

function hash(x: number, y: number, z: number, s: number) { let h = (x * 374761393 + y * 668265263 + z * 1274126177 + s * 97531) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function vnoise(x: number, y: number, z: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (i: number, j: number, k: number) => hash(xi + i, yi + j, zi + k, s);
  return L(L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v), L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w) * 2 - 1;
}

interface Buf { P: number[]; C: number[]; U: number[]; I: number[]; seams: Array<[number, number]> }
/** append one lobe: rows × ring vertices (+ an apex). The ring is closed by a duplicated seam column (its own UV u, the
 *  normals averaged after the merge). UVs are cylindrical (u = arc length on the lobe's mean radius, v = height) so the
 *  stone shader runs its cheap UV path, not triplanar. `step` 1 = full (near), 2 = coarse (far LOD). Rows a kong
 *  can never be within reach of (shape.exact false) are thinned while the ring stays within 0.12 m of the dropped ones;
 *  the coarse copy also drops every 2nd vertex and rows that change < 0.25 m. */
function lobeMesh(b: Buf, sh: LobeShape, step: number, wet: Array<{ x: number; z: number; top: number }>) {
  const { L, phi, rows, R } = sh, N = L.N;
  const js: number[] = []; for (let j = 0; j < N; j += step) js.push(j);
  const keep: number[] = [0];
  const tolV = step === 1 ? 0.12 : 0.25;
  for (let i = 1; i < rows.length - 1; i++) {
    if (step === 1 && sh.exact[i]) { keep.push(i); continue; }
    const last = keep[keep.length - 1], nx = i + 1;
    // would dropping row i (interpolating last → i+1) leave any ring vertex more than tolV off?
    let dev = 0;
    for (let k = last + 1; k <= i; k++) { const f = (rows[k] - rows[last]) / (rows[nx] - rows[last]); for (const j of js) dev = Math.max(dev, Math.abs(R[k * N + j] - (R[last * N + j] + (R[nx * N + j] - R[last * N + j]) * f))); }
    if (dev > tolV || rows[nx] - rows[last] > (step === 1 ? 3 : 5)) keep.push(i);
  }
  keep.push(rows.length - 1);
  const ringRows = keep.slice(0, -1), M = js.length, base = b.P.length / 3, top = rows[rows.length - 1], H = Math.max(1, top - L.foot);
  let rm = 0; for (let j = 0; j < N; j++) rm += R[N + j]; rm /= N;
  const col = new THREE.Color();
  for (const i of ringRows) {
    const y = rows[i];
    for (let jj = 0; jj <= M; jj++) {
      const j = js[jj % M], r = R[i * N + j], x = CX + L.u + r * Math.cos(phi[j]), z = CZ + L.v + r * Math.sin(phi[j]);
      b.P.push(x, y, z); b.U.push((jj / M) * Math.PI * 2 * rm, y);
      // tone: darker foot (AO under the jungle), strata bands, the lobe's crevices (vertices pulled in by the lobing),
      // a dark wet streak under every fall lip
      const t = Math.min(1, Math.max(0, (y - L.foot) / H));
      const lobing = r / Math.max(0.01, (R[i * N + (j + N - 1) % N] + R[i * N + (j + 1) % N]) / 2) - 1;
      let k = (0.66 + 0.34 * Math.min(1, (y - L.foot + 0.3) / (L.k < 0 ? 1.2 : 3.5))) * (0.94 + 0.12 * Math.sin(y * 1.9 + L.seed) * Math.sin(y * 0.7 + L.seed * 2.1));
      k *= 1 + Math.max(-0.12, Math.min(0.1, lobing * 2.2)) + 0.06 * vnoise(x * 0.35, y * 0.35, z * 0.35, L.seed);
      for (const w of wet) { const d = Math.hypot(x - w.x, z - w.z); if (d < 2.2 && y < w.top) k *= 0.62 + 0.38 * Math.min(1, d / 2.2); }
      const warm = 0.03 * (1 - t);
      col.setRGB(k * (1 + warm), k * (0.985 + warm * 0.4), k * 0.95);
      b.C.push(col.r, col.g, col.b);
    }
    b.seams.push([base + (b.P.length / 3 - base) - (M + 1), base + (b.P.length / 3 - base) - 1]);
  }
  // apex
  b.P.push(CX + L.u, top, CZ + L.v); b.U.push(Math.PI * rm, top + 0.5); b.C.push(1.05, 1.03, 1.0);
  const W = M + 1, apex = base + ringRows.length * W;
  for (let r = 0; r < ringRows.length - 1; r++) for (let jj = 0; jj < M; jj++) {
    const a = base + r * W + jj, c = a + W, bb = a + 1, d = bb + W;
    b.I.push(a, c, bb, bb, c, d);
  }
  const lr = base + (ringRows.length - 1) * W;
  for (let jj = 0; jj < M; jj++) b.I.push(lr + jj, apex, lr + jj + 1);
}

/** ?elevlod=0 = the old LOD distances (for A/B comparisons) */
export const ELEV_LOD = flag("elevlod");
/** distance (from the lab centre) beyond which the coarse rock copy shows */
export const ROCK_NEAR = ELEV_LOD ? 240 : 120;   // (240, not 120, so the coarse copy never swaps in while you walk the compound's edge)

export async function buildRocks(ctx: WorldCtx, root: THREE.Object3D) {
  bindJungleCtx(ctx);
  // (the UV path of the jungle stone shader — cylindrical UVs on every lobe — instead of triplanar)
  const mat = stoneMaterial(pbr(ctx, "boulder"), { scale: 5, triplanar: false, moss: 1.9, mossCover: 0.7, mossColor: "#5f9f2c", color: "#c4bdae", variation: 0.6, normalScale: 1.5, lift: 0.6, vertexColors: true, roughness: 0.95, detail: 0.8 }, pbr(ctx, "moss"));
  mat.name = "lab:rock";
  const mk0 = (): Buf => ({ P: [], C: [], U: [], I: [], seams: [] });
  const massif = mk0(), boulders = mk0(), far = mk0();
  const lobes = rockLobes();
  const wet = MASSIF_FALLS.map((f) => ({ x: CX + f.u, z: CZ + f.v, top: f.top }));
  const spots: VineSpot[] = [];
  let n = 0;
  for (const L of lobes) {
    if (++n % 4 === 0) await ctx.yield();
    const sh = lobeShape(L);
    lobeMesh(L.k < 0 ? boulders : massif, sh, 1, wet);
    lobeMesh(far, sh, 2, wet);
    // vines: off the shoulder of every massif lobe on the side that looks at the compound (soft, never a collider)
    if (L.k >= 0) {
      const N = L.N, rows = sh.rows, toC = Math.atan2(-L.v, -L.u);
      // the shoulder row: the highest row whose ring is still ≥ 92 % of the wall ring
      let si = 1; for (let i = 1; i < rows.length; i++) { let ok = true; for (let j = 0; j < N; j += 3) if (sh.R[i * N + j] < sh.R[N + j] * 0.92) ok = false; if (ok) si = i; }
      for (let j = 0; j < N; j += 2) {
        const q = sh.phi[j], dq = Math.abs(Math.atan2(Math.sin(q - toC), Math.cos(q - toC)));
        if (dq > 1.1 || hash(j, L.seed, 5, 2) < 0.6) continue;   // (perf: ~half the vine curtains)
        if (L.falls?.some((f) => Math.abs(Math.atan2(Math.sin(q - f), Math.cos(q - f))) < 0.45)) continue;
        const r = sh.R[si * N + j] + 0.12, H = rows[si] - L.footHi;
        if (H < 3) continue;
        spots.push({ x: CX + L.u + r * Math.cos(q), y: rows[si] - 0.1, z: CZ + L.v + r * Math.sin(q), w: 1.4 + hash(j, L.seed, 6, 1) * 1.6, len: Math.min(H * 0.8, 2.5 + H * 0.45 * hash(j, L.seed, 7, 3)), ry: Math.atan2(Math.cos(q), Math.sin(q)) });
      }
    }
  }
  const mk = (b: Buf, name: string, cast: boolean) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(b.P, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(b.C, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(b.U, 2));
    g.setIndex(b.I);
    g.computeVertexNormals();
    // close the seams: both columns get the average normal
    const nrm = g.attributes.normal as THREE.BufferAttribute, v = new THREE.Vector3(), w = new THREE.Vector3();
    for (const [a, c] of b.seams) { v.fromBufferAttribute(nrm, a); w.fromBufferAttribute(nrm, c); v.add(w).normalize(); nrm.setXYZ(a, v.x, v.y, v.z); nrm.setXYZ(c, v.x, v.y, v.z); }
    g.computeBoundingSphere(); g.computeBoundingBox();
    const m = new THREE.Mesh(g, mat);
    m.name = name; m.castShadow = cast; m.receiveShadow = true; m.userData.castShadow = cast; m.matrixAutoUpdate = false;
    return m;
  };
    // (no rock casts into the sun shadow map — the massifs stand north of the compound, their shadows fall away from it;
  //  their forms read from the vertex AO, the lobing crevices and the moss)
  const nearMesh = mk(massif, "lab:rock", false), boulderMesh = mk(boulders, "lab:rock-boulders", false);
  await ctx.yield();
  const farMesh = mk(far, "lab:rock-far", false); farMesh.visible = false;
  const nearG = new THREE.Group(); nearG.name = "lab:rock-near"; nearG.add(nearMesh, boulderMesh);
  root.add(nearG, farMesh);
  await ctx.yield();
  buildHangingVines(ctx, root, spots, 1.7, { oneSided: true, push: 0.25, out: 0.3 });
  return { tris: (massif.I.length + boulders.I.length) / 3, farTris: far.I.length / 3, near: nearG, far: farMesh };
}
