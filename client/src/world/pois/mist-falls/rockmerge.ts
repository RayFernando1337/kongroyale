// poi mist-falls — the rock fields' hi + mid sets MERGED
// per LOD cell. rockLOD3 builds one InstancedMesh per (prototype, 72 m cell): at the river bridge that was ~70 draws of
// 1–19 instances each (34 of them the gorge skin's mid set), ~0.6 ms of CPU per frame for the main pass alone, plus the
// cascade passes. Here every cell's prototypes are baked into ONE static mesh (same vertices, same triangles, same
// material program): one draw per cell and level instead of five.
//   • Exact LOD: a merged mesh is switched by the same cell bounds as the instanced sets it replaces — it keeps the
//     per-prototype world boxes (userData.lodBoxes, read by rocklod.ts) and merges only prototypes whose boxes fall in
//     the same far cell, so every hi / mid / far decision is the one the instanced sets made.
//   • Exact shading: the stone shader's triplanar / moss / strata world normal is normalize(mat3(instanceMatrix) · n)
//     (NOT the inverse transpose — the rocks are non-uniformly scaled), while three lights with the inverse-transpose
//     normal. Both are baked: `normal` = three's instanced normal (im · n / |im col|², pre-normalMatrix), `aJN` =
//     im · n for the stone's world normal (mergedStoneMat swaps the shader's `objectNormal` read there for `aJN`).
//   • The far sets (big cells, few draws, never cast) stay instanced. ?rockMerge=0 = the old instanced sets (A/B).
import * as THREE from "three";
import { flag } from "../../../flags";

export const ROCK_MERGE = flag("rockMerge");

/** turn a FRESH stone material (made by the same factory as the instanced sets' material, before anything else patched
 *  it) into the merged-geometry variant: identical shader except the stone's world normal comes from `aJN` */
export function mergedStoneMat<T extends THREE.MeshStandardMaterial>(m: T): T {
  const prev = m.onBeforeCompile, key = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    const vs = sh.vertexShader.replace("vec3 jwn = objectNormal;", "vec3 jwn = aJN;");
    if (vs === sh.vertexShader) console.warn("[mist-falls] rockmerge: stone world-normal hook not found (shading falls back to the lit normal)");
    sh.vertexShader = vs.replace("#include <common>", "#include <common>\nattribute vec3 aJN;");
  };
  m.customProgramCacheKey = () => key() + "|jmerge";
  m.name = (m.name ? m.name + "-" : "") + "rockmerge";
  return m;
}

const stats = { draws: 0, merged: 0, verts: 0, kept: 0, ms: 0 };
(globalThis as { __krRockMerge?: unknown }).__krRockMerge = stats;

/** merge a rockInstances group's per-(prototype, cell) InstancedMeshes into one Mesh per (cell, far cell) */
export function mergeRockLevel(g: THREE.Group, mat: THREE.Material, farCell: number) {
  const t0 = performance.now();
  const buckets = new Map<string, THREE.InstancedMesh[]>();
  const c = new THREE.Vector3();
  const boxOf = new Map<THREE.InstancedMesh, THREE.Box3>();
  for (const o of g.children) {
    const im = o as THREE.InstancedMesh, cell = im.name.split("|")[1];
    if (!im.isInstancedMesh || cell === undefined) continue;
    im.updateMatrixWorld(true); if (!im.boundingBox) im.computeBoundingBox();
    if (!im.matrixWorld.equals(IDENT)) continue;           // baked in world space: only for unmoved sets
    const b = im.boundingBox!.clone().applyMatrix4(im.matrixWorld); boxOf.set(im, b); b.getCenter(c);
    const k = `${cell}#${Math.floor(c.x / farCell)},${Math.floor(c.z / farCell)}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(im);
  }
  for (const list of buckets.values()) {
    stats.draws += list.length;
    if (list.length < 2 || !sameLayout(list)) { stats.kept += list.length; continue; }
    const mesh = bake(list, mat);
    const first = list[0], cell = first.name.split("|")[1];
    const protos = list.map((im) => im.name.split("|")[0].slice(g.name.length + 1)).join("");
    mesh.name = `${g.name}-${protos}|${cell}`;
    mesh.castShadow = first.castShadow; mesh.receiveShadow = first.receiveShadow;
    mesh.userData = { ...first.userData, lodBoxes: list.map((im) => boxOf.get(im)!) };
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    for (const im of list) g.remove(im);
    g.add(mesh);
    stats.merged++; stats.verts += mesh.geometry.attributes.position.count;
  }
  stats.ms += performance.now() - t0;
}

const IDENT = new THREE.Matrix4();

function sameLayout(list: THREE.InstancedMesh[]) {
  const sig = (geo: THREE.BufferGeometry) => Object.keys(geo.attributes).sort().map((k) => `${k}:${geo.attributes[k].itemSize}`).join(",") + (geo.index ? "|i" : "");
  const s0 = sig(list[0].geometry);
  const plain = (geo: THREE.BufferGeometry) => Object.values(geo.attributes).every((a) => !(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && (a as THREE.BufferAttribute).array.length === a.count * a.itemSize);
  return !!list[0].geometry.attributes.normal && !list[0].geometry.attributes.tangent && list.every((im) => plain(im.geometry)) && !list[0].geometry.morphAttributes.position
    && list.every((im) => sig(im.geometry) === s0 && !im.instanceColor && im.material === list[0].material);
}

function bake(list: THREE.InstancedMesh[], mat: THREE.Material): THREE.Mesh {
  let nv = 0, ni = 0;
  for (const im of list) { const geo = im.geometry; nv += geo.attributes.position.count * im.count; ni += (geo.index ? geo.index.count : geo.attributes.position.count) * im.count; }
  const names = Object.keys(list[0].geometry.attributes).filter((k) => k !== "position" && k !== "normal");
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), jn = new Float32Array(nv * 3);
  const extra = names.map((k) => { const a = list[0].geometry.attributes[k] as THREE.BufferAttribute; return { k, size: a.itemSize, norm: a.normalized, out: new (a.array.constructor as Float32ArrayConstructor)(nv * a.itemSize) }; });
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const m = new THREE.Matrix4();
  let vo = 0, io = 0;
  for (const im of list) {
    const geo = im.geometry, P = geo.attributes.position as THREE.BufferAttribute, N = geo.attributes.normal as THREE.BufferAttribute, n = P.count;
    const gi = geo.index;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m); const e = m.elements;
      // three's instanced normal (defaultnormal_vertex): im · (n / (|col0|², |col1|², |col2|²))
      const s0 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2], s1 = e[4] * e[4] + e[5] * e[5] + e[6] * e[6], s2 = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
      for (let v = 0; v < n; v++) {
        const x = P.getX(v), y = P.getY(v), z = P.getZ(v), o = (vo + v) * 3;
        pos[o] = e[0] * x + e[4] * y + e[8] * z + e[12]; pos[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; pos[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        const a = N.getX(v), b = N.getY(v), cc = N.getZ(v);
        jn[o] = e[0] * a + e[4] * b + e[8] * cc; jn[o + 1] = e[1] * a + e[5] * b + e[9] * cc; jn[o + 2] = e[2] * a + e[6] * b + e[10] * cc;
        const a2 = a / s0, b2 = b / s1, c2 = cc / s2;
        nrm[o] = e[0] * a2 + e[4] * b2 + e[8] * c2; nrm[o + 1] = e[1] * a2 + e[5] * b2 + e[9] * c2; nrm[o + 2] = e[2] * a2 + e[6] * b2 + e[10] * c2;
      }
      for (const x of extra) { const src = geo.attributes[x.k].array as ArrayLike<number>; x.out.set(src as Float32Array, vo * x.size); }
      if (gi) { const ia = gi.array; for (let q = 0; q < ia.length; q++) idx[io + q] = ia[q] + vo; io += ia.length; }
      else { for (let q = 0; q < n; q++) idx[io + q] = q + vo; io += n; }
      vo += n;
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  out.setAttribute("aJN", new THREE.BufferAttribute(jn, 3));
  for (const x of extra) out.setAttribute(x.k, new THREE.BufferAttribute(x.out, x.size, x.norm));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingBox(); out.computeBoundingSphere();
  return new THREE.Mesh(out, mat);
}
