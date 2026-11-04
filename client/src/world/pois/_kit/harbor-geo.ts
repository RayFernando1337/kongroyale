// poi-harbor kit — procedural geometry helpers for the harbor + wreck (cranes, ship, warehouses, tanks, props).
// Everything is built as small non-indexed pieces (position/normal/uv) with UVs in METRES (1 uv = 1 m, planar by the
// dominant local normal axis) so the tiled harbor materials (harbor-materials.ts) keep a constant texel density, then
// merged into ONE mesh per material with `Builder.build()` — a whole crane is ~6 draw calls.
//
//   const b = new Builder();
//   b.box(mats.yellowPaint, [x, y, z], [w, h, d], { bevel: 0.05, rotY: 0.3 });
//   b.beam(mats.yellowPaint, [x0, y0, z0], [x1, y1, z1], 0.4, 0.4);          // member between two points
//   b.cyl(mats.steel, [x0, y0, z0], [x1, y1, z1], 0.1, 10);
//   group.add(b.build("crane"));
import * as THREE from "three";
import { Coplanar } from "./coplanar";
const IDM = new THREE.Matrix4();
const DEBUG_CO = flag("codebug");
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { exactIndex } from "../../../engine/exact-index";
import { flag } from "../../../flags";

export type V3 = [number, number, number];

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _m3 = new THREE.Matrix3();

/** planar metre UVs by the dominant normal axis (local space). `ox/oy/oz` offsets keep textures from lining up. */
export function uvByNormal(g: THREE.BufferGeometry, scale = 1, off: V3 = [0, 0, 0]): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  if (!g.attributes.normal) g.computeVertexNormals();
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i), ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const x = pos.getX(i) + off[0], y = pos.getY(i) + off[1], z = pos.getZ(i) + off[2];
    let u: number, v: number;
    if (ay >= ax && ay >= az) { u = x; v = ny > 0 ? -z : z; } else if (ax >= az) { u = nx > 0 ? -z : z; v = y; } else { u = nz > 0 ? x : -x; v = y; }
    uv[i * 2] = u * scale; uv[i * 2 + 1] = v * scale;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

/** strip a geometry down to non-indexed position/normal/uv (so every piece merges) */
export function normalise(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let out = g.index ? g.toNonIndexed() : g;
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) uvByNormal(out);
  for (const k of Object.keys(out.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") out.deleteAttribute(k);
  out.morphAttributes = {};
  if (out === g) out = g.clone();
  return out;
}

/**
 * Chamfered box centred at the origin: 6 faces + 12 edge chamfers + 8 corner tris, flat shaded — crisp edge
 * highlights for the "bevelled toy" look at ~44 tris. b = chamfer size (clamped).
 */
export function chamferBox(w: number, h: number, d: number, b: number): THREE.BufferGeometry {
  b = Math.max(0, Math.min(b, w * 0.45, h * 0.45, d * 0.45));
  if (b < 1e-4) return new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const X = w / 2, Y = h / 2, Z = d / 2;
  const pos: number[] = [];
  const tri = (a: V3, c: V3, e: V3) => pos.push(...a, ...c, ...e);
  const quad = (a: V3, c: V3, e: V3, f: V3) => { tri(a, c, e); tri(a, e, f); };
  // faces (each inset by b)
  quad([-X + b, -Y + b, Z], [X - b, -Y + b, Z], [X - b, Y - b, Z], [-X + b, Y - b, Z]);
  quad([X - b, -Y + b, -Z], [-X + b, -Y + b, -Z], [-X + b, Y - b, -Z], [X - b, Y - b, -Z]);
  quad([X, -Y + b, Z - b], [X, -Y + b, -Z + b], [X, Y - b, -Z + b], [X, Y - b, Z - b]);
  quad([-X, -Y + b, -Z + b], [-X, -Y + b, Z - b], [-X, Y - b, Z - b], [-X, Y - b, -Z + b]);
  quad([-X + b, Y, Z - b], [X - b, Y, Z - b], [X - b, Y, -Z + b], [-X + b, Y, -Z + b]);
  quad([-X + b, -Y, -Z + b], [X - b, -Y, -Z + b], [X - b, -Y, Z - b], [-X + b, -Y, Z - b]);
  // edge chamfers (12) + corners (8); winding is fixed afterwards (convex, centred → normals must point outward)
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) quad([-X + b, sy * Y, sz * (Z - b)], [X - b, sy * Y, sz * (Z - b)], [X - b, sy * (Y - b), sz * Z], [-X + b, sy * (Y - b), sz * Z]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) quad([sx * (X - b), -Y + b, sz * Z], [sx * X, -Y + b, sz * (Z - b)], [sx * X, Y - b, sz * (Z - b)], [sx * (X - b), Y - b, sz * Z]);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) quad([sx * X, sy * (Y - b), -Z + b], [sx * X, sy * (Y - b), Z - b], [sx * (X - b), sy * Y, Z - b], [sx * (X - b), sy * Y, -Z + b]);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) tri([sx * X, sy * (Y - b), sz * (Z - b)], [sx * (X - b), sy * Y, sz * (Z - b)], [sx * (X - b), sy * (Y - b), sz * Z]);
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2], bx = pos[i + 3] - ax, by = pos[i + 4] - ay, bz = pos[i + 5] - az, cx = pos[i + 6] - ax, cy = pos[i + 7] - ay, cz = pos[i + 8] - az;
    const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
    if (nx * (ax + bx / 3 + cx / 3) + ny * (ay + by / 3 + cy / 3) + nz * (az + bz / 3 + cz / 3) < 0) for (let k = 0; k < 3; k++) { const t = pos[i + 3 + k]; pos[i + 3 + k] = pos[i + 6 + k]; pos[i + 6 + k] = t; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals(); // non-indexed → flat normals
  return g;
}

/** matrix that maps local +Y onto the segment a→b (length along Y), `roll` about the axis; `up` hint for the local X */
export function segmentMatrix(a: V3, b: V3, roll = 0, out = new THREE.Matrix4()): { m: THREE.Matrix4; len: number } {
  const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = dir.length(); dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  if (roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), roll));
  // keep member faces aligned with world axes where possible: for near-horizontal members, pick the roll that
  // keeps local X horizontal
  out.compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1));
  return { m: out, len };
}

/** a matrix from position + Euler (YXZ-ish: yaw about Y, then pitch about X, then roll about Z) + scale */
export function trs(p: V3, rotY = 0, rotX = 0, rotZ = 0, s: V3 = [1, 1, 1]): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ, "YXZ"));
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), q, new THREE.Vector3(...s));
}

export interface BoxOpts { bevel?: number; rotY?: number; rotX?: number; rotZ?: number; m?: THREE.Matrix4; uvScale?: number }

/**
 * Collects geometry per material and merges into one mesh per material. All add* methods take world (or group-local)
 * placement; UVs are generated in the piece's LOCAL frame before transforming (textures follow the piece).
 */
export class Builder {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  /** optional parent transform applied to everything added after it is set */
  base: THREE.Matrix4 | null = null;
  /** `deferred` builders only RECORD each add (geometry + its final matrix); the per-piece work (non-indexing,
   *  metre UVs, transform) runs in `buildAsync` in time slices — callers must not mutate a geometry after adding it */
  private pending: Array<[THREE.Material, THREE.BufferGeometry, THREE.Matrix4 | null, boolean, number]> = [];
  private pendAt = 0;
  /** z-fight resolver over this builder's boxes (_kit/coplanar.ts): runs once, right before the merge; null = off */
  co: Coplanar | null = new Coplanar();
  constructor(readonly deferred = false) {}

  add(mat: THREE.Material, g: THREE.BufferGeometry, m?: THREE.Matrix4, uv = true, uvScale = 1): this {
    if (this.deferred) {
      const mm = m || this.base ? (m ? (this.base ? this.base.clone().multiply(m) : m.clone()) : this.base!.clone()) : null;
      this.pending.push([mat, g, mm, uv, uvScale]);
      return this;
    }
    const mm = m || this.base ? (m ? (this.base ? this.base.clone().multiply(m) : m) : this.base!) : null;
    this.process(mat, g, mm, uv, uvScale);
    return this;
  }
  private process(mat: THREE.Material, g: THREE.BufferGeometry, mm: THREE.Matrix4 | null, uv: boolean, uvScale: number) {
    const geo = normalise(g);
    if (uv) uvByNormal(geo, uvScale);
    if (mm) {
      geo.applyMatrix4(mm);
      if (mm.determinant() < 0) flipWinding(geo);
    }
    (this.parts.get(mat) ?? this.parts.set(mat, []).get(mat)!).push(geo);
    const dims = g.userData.coDims as V3 | undefined;
    if (dims && this.co) { const pa = geo.attributes.position; this.co.addMatrix(dims[0], dims[1], dims[2], (mm ?? IDM).elements, 0, () => pa.array as Float32Array, 0, pa.count); }
    else if (g.userData.coBox && this.co) { const pa = geo.attributes.position; this.co.addGeometry(g as never, mm ? mm.elements : null, 0, () => pa.array as Float32Array, 0, pa.count); }
  }
  /** resolve this builder's coplanar box faces (once, after every add is processed, before the merge) */
  private coResolve(name: string) {
    if (!this.co || !this.co.boxes.length) return;
    const r = this.co.resolve();
    if (r.moved && DEBUG_CO) console.info(`[${name}] coplanar: ${r.boxes} boxes, ${r.pairs} pairs, ${r.moved} faces moved (${r.ms} ms)`);
  }
  /** process recorded adds for up to `ms` (Infinity = all); true when none is left */
  flush(ms = Infinity): boolean {
    const t0 = performance.now();
    while (this.pendAt < this.pending.length) {
      const p = this.pending[this.pendAt++];
      this.process(p[0], p[1], p[2], p[3], p[4]);
      if ((this.pendAt & 15) === 0 && performance.now() - t0 > ms) break;
    }
    if (this.pendAt >= this.pending.length) { this.pending.length = 0; this.pendAt = 0; return true; }
    return false;
  }
  /** build() in time slices: the recorded adds and every per-material merge run between `yieldFn` calls (the module's
   *  ctx.yield) — no main-thread task over ~a slice for any part */
  async buildAsync(name: string, o: Parameters<Builder["build"]>[1] = {}, yieldFn: () => Promise<void>, sliceMs = 12): Promise<THREE.Group> {
    while (!this.flush(sliceMs)) await yieldFn();
    this.coResolve(name);
    await yieldFn();
    const group = new THREE.Group();
    group.name = name;
    if (o.palette) {
      const pal: THREE.BufferGeometry[] = [];
      for (const [mat, geos] of [...this.parts]) {
        if (!geos.length || (mat as THREE.Material).transparent || !o.palette(mat)) continue;
        const col = averageAlbedo(mat);
        for (const g of geos) {
          const n = g.attributes.position.count, c = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
          g.setAttribute("color", new THREE.BufferAttribute(c, 3));
          pal.push(g);
        }
        this.parts.delete(mat);
      }
      if (pal.length) {
        const merged = await mergeSliced(pal, yieldFn, sliceMs);
        if (merged) {
          const mesh = new THREE.Mesh(merged, o.paletteMaterial ?? paletteMaterial());
          mesh.name = `${name}:palette`;
          mesh.castShadow = o.cast ?? true; mesh.receiveShadow = o.receive ?? true; mesh.userData.castShadow = mesh.castShadow;
          group.add(mesh);
        }
      }
    }
    for (const [mat, geos] of this.parts) {
      if (!geos.length) continue;
      const merged = await mergeSliced(geos, yieldFn, sliceMs);
      if (!merged) { console.warn(`[harbor-geo] merge failed for ${name}/${mat.name}`); continue; }
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${name}:${mat.name || "mat"}`;
      mesh.castShadow = o.cast ?? true; mesh.receiveShadow = o.receive ?? true;
      mesh.userData.castShadow = mesh.castShadow;
      group.add(mesh);
    }
    this.parts.clear();
    return group;
  }

  /** add pre-UV'd geometry as-is (keeps its own uv) */
  addRaw(mat: THREE.Material, g: THREE.BufferGeometry, m?: THREE.Matrix4): this {
    return this.add(mat, g, m, false);
  }

  /** box centred at p (size s) — chamfered when bevel > 0 */
  box(mat: THREE.Material, p: V3, s: V3, o: BoxOpts = {}): this {
    const g = o.bevel ? chamferBox(s[0], s[1], s[2], o.bevel) : new THREE.BoxGeometry(s[0], s[1], s[2]);
    g.userData.coDims = s;   // a centred box: registers with the coplanar resolver when processed
    const m = o.m ? o.m.clone().multiply(trs(p, o.rotY ?? 0, o.rotX ?? 0, o.rotZ ?? 0)) : trs(p, o.rotY ?? 0, o.rotX ?? 0, o.rotZ ?? 0);
    return this.add(mat, g, m, true, o.uvScale ?? 1);
  }

  /** rectangular member from a to b, cross-section w (local X) × d (local Z); `roll` rotates the section */
  beam(mat: THREE.Material, a: V3, b: V3, w: number, d: number, o: { bevel?: number; roll?: number; ext?: number } = {}): this {
    const { m, len } = segmentMatrix(a, b, o.roll ?? 0);
    const L = len + 2 * (o.ext ?? 0);
    const g = o.bevel ? chamferBox(w, L, d, o.bevel) : new THREE.BoxGeometry(w, L, d);
    return this.add(mat, g, m);
  }

  /** cylinder from a to b */
  cyl(mat: THREE.Material, a: V3, b: V3, r: number, seg = 12, o: { r1?: number; caps?: boolean; ext?: number } = {}): this {
    const { m, len } = segmentMatrix(a, b);
    const g = new THREE.CylinderGeometry(o.r1 ?? r, r, len + 2 * (o.ext ?? 0), seg, 1, !(o.caps ?? true));
    cylUV(g, r);
    return this.add(mat, g, m, false);
  }

  /** polyline tube (pipes, cables, handrails) */
  tube(mat: THREE.Material, pts: V3[], r: number, seg = 8, o: { closed?: boolean; tension?: number; samples?: number } = {}): this {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), o.closed ?? false, "catmullrom", o.tension ?? 0.1);
    const g = new THREE.TubeGeometry(curve, o.samples ?? Math.max(2, pts.length * 4), r, seg, o.closed ?? false);
    return this.add(mat, g, undefined, false);
  }

  /** straight polyline of cylinders with ball joints (handrails without spline wobble) */
  rail(mat: THREE.Material, pts: V3[], r: number, seg = 6): this {
    for (let i = 0; i < pts.length - 1; i++) this.cyl(mat, pts[i], pts[i + 1], r, seg, { caps: false, ext: r * 0.5 });
    return this;
  }

  /** a lathe (profile [r, y] pairs) placed with m */
  lathe(mat: THREE.Material, profile: Array<[number, number]>, seg: number, m: THREE.Matrix4, phiStart = 0, phiLength = Math.PI * 2): this {
    const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg, phiStart, phiLength);
    latheUV(g, profile);
    return this.add(mat, g, m, false);
  }

  /** extrude a 2D shape (XY) along +Z by depth, placed with m */
  extrude(mat: THREE.Material, shape: THREE.Shape, depth: number, m: THREE.Matrix4, bevel = 0): this {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: 16, steps: 1 });
    return this.add(mat, g, m, true);
  }

  /** merge everything: one Mesh per material. `palette(mat)` → true: that material's pieces are merged into ONE
   *  vertex-coloured mesh (colour = the material's average albedo) under a shared weathered paint material — small
   *  painted props go from ~16 draws per cell to ~4 (the textured ones — wood, printed boxes — keep their own). */
  build(name: string, o: { cast?: boolean; receive?: boolean; palette?: (m: THREE.Material) => boolean; paletteMaterial?: THREE.Material } = {}): THREE.Group {
    this.flush();
    this.coResolve(name);
    const group = new THREE.Group();
    group.name = name;
    if (o.palette) {
      const pal: THREE.BufferGeometry[] = [];
      for (const [mat, geos] of [...this.parts]) {
        if (!geos.length || (mat as THREE.Material).transparent || !o.palette(mat)) continue;
        const col = averageAlbedo(mat);
        for (const g of geos) {
          const n = g.attributes.position.count, c = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
          g.setAttribute("color", new THREE.BufferAttribute(c, 3));
          pal.push(g);
        }
        this.parts.delete(mat);
      }
      if (pal.length) {
        const merged = mergeGeometries(pal, false);
        if (merged) {
          merged.computeBoundingBox(); merged.computeBoundingSphere();
          const mesh = new THREE.Mesh(merged, o.paletteMaterial ?? paletteMaterial());
          mesh.name = `${name}:palette`;
          mesh.castShadow = o.cast ?? true; mesh.receiveShadow = o.receive ?? true; mesh.userData.castShadow = mesh.castShadow;
          group.add(mesh);
        }
      }
    }
    for (const [mat, geos] of this.parts) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      if (!merged) { console.warn(`[harbor-geo] merge failed for ${name}/${mat.name}`); continue; }
      merged.computeBoundingBox(); merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${name}:${mat.name || "mat"}`;
      mesh.castShadow = o.cast ?? true; mesh.receiveShadow = o.receive ?? true;
      // atmos' afterBuild forces castShadow on every opaque mesh unless userData says otherwise — say it explicitly
      mesh.userData.castShadow = mesh.castShadow;
      group.add(mesh);
    }
    this.parts.clear();
    return group;
  }

  /** triangles collected so far (for budgets) */
  tris(): number {
    this.flush(); let n = 0; for (const gs of this.parts.values()) for (const g of gs) n += g.attributes.position.count / 3; return n; }
}

/** mergeGeometries for non-indexed pieces with the same attributes, as a generator that yields every ~`sliceMs`
 *  (falls back to three's merge for anything else) — drive it with mergeSliced (async) or `yield*` from a generator */
export function* mergeGen(geos: THREE.BufferGeometry[], sliceMs = 12): Generator<void, THREE.BufferGeometry | null, void> {
  if (!geos.length) return null;
  const names = Object.keys(geos[0].attributes);
  const same = geos.every((g) => !g.index && Object.keys(g.attributes).length === names.length && names.every((k) => g.attributes[k] && (g.attributes[k] as THREE.BufferAttribute).itemSize === (geos[0].attributes[k] as THREE.BufferAttribute).itemSize && !(g.attributes[k] as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute));
  if (!same) { const m = mergeGeometries(geos, false); if (m) { m.computeBoundingBox(); m.computeBoundingSphere(); } return m; }
  let total = 0; for (const g of geos) total += g.attributes.position.count;
  const out: Record<string, Float32Array> = {};
  for (const k of names) out[k] = new Float32Array(total * (geos[0].attributes[k] as THREE.BufferAttribute).itemSize);
  let at = 0, t0 = performance.now();
  for (let i = 0; i < geos.length; i++) {
    const g = geos[i], n = g.attributes.position.count;
    for (const k of names) { const a = g.attributes[k] as THREE.BufferAttribute; out[k].set(a.array as Float32Array, at * a.itemSize); }
    at += n;
    if ((i & 31) === 31 && performance.now() - t0 > sliceMs) { yield; t0 = performance.now(); }
  }
  const m = new THREE.BufferGeometry();
  for (const k of names) m.setAttribute(k, new THREE.BufferAttribute(out[k], (geos[0].attributes[k] as THREE.BufferAttribute).itemSize));
  m.computeBoundingBox(); m.computeBoundingSphere();
  return yield* exactIndex(m);
}
export async function mergeSliced(geos: THREE.BufferGeometry[], yieldFn: () => Promise<void>, sliceMs = 12): Promise<THREE.BufferGeometry | null> {
  const it = mergeGen(geos, sliceMs);
  let r = it.next();
  while (!r.done) { await yieldFn(); r = it.next(); }
  return r.value;
}

// ------------------------------------------------------------------------------------------------ palette merge
const albedoCache = new WeakMap<THREE.Material, THREE.Color>(), imgMean = new WeakMap<object, THREE.Color>();
/** an image's mean colour computed where it was painted (the texture worker) — sRGB 0..1 */
export function presetImageMean(img: object, rgb: [number, number, number]) { imgMean.set(img, new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)); }
/** a material's average albedo in LINEAR space (its colour × the mean of its map, sampled once via a 1×1 downscale) */
export function averageAlbedo(mat: THREE.Material): THREE.Color {
  const hit = albedoCache.get(mat);
  if (hit) return hit;
  const m = mat as THREE.MeshStandardMaterial;
  const out = (m.color ? m.color.clone() : new THREE.Color(1, 1, 1));
  const img = m.map?.image as CanvasImageSource | undefined;
  if (img && typeof document !== "undefined") {
    // (the mean of a map is cached per IMAGE — every tinted paint() material shares one neutral tile)
    let mean = imgMean.get(img as object);
    if (!mean) {
      try {
        const c = document.createElement("canvas"); c.width = c.height = 4;
        const g = c.getContext("2d")!; g.drawImage(img, 0, 0, 4, 4);
        const d = g.getImageData(0, 0, 4, 4).data; let r = 0, gg = 0, b = 0;
        for (let i = 0; i < 16; i++) { r += d[i * 4]; gg += d[i * 4 + 1]; b += d[i * 4 + 2]; }
        mean = new THREE.Color().setRGB(r / 16 / 255, gg / 16 / 255, b / 16 / 255, THREE.SRGBColorSpace);
        imgMean.set(img as object, mean);
      } catch { /* keep the base colour */ }
    }
    if (mean) out.multiply(mean);
  }
  if (m.emissive && m.emissiveIntensity > 0.01) out.add(m.emissive.clone().multiplyScalar(m.emissiveIntensity * 0.5));
  albedoCache.set(mat, out);
  return out;
}
let paletteMat: THREE.MeshStandardMaterial | null = null;
/** the shared vertex-coloured paint used by palette merges (set by harbor-materials with the weather layer) */
export function paletteMaterial(): THREE.MeshStandardMaterial {
  return (paletteMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05, name: "harbor-palette" }));
}
export function setPaletteMaterial(m: THREE.MeshStandardMaterial) { paletteMat = m; }

function flipWinding(g: THREE.BufferGeometry) {
  const idx = ["position", "normal", "uv"] as const;
  for (const k of idx) {
    const a = g.attributes[k] as THREE.BufferAttribute | undefined; if (!a) continue;
    const s = a.itemSize, arr = a.array as Float32Array;
    for (let i = 0; i < a.count; i += 3) for (let c = 0; c < s; c++) { const t = arr[(i + 1) * s + c]; arr[(i + 1) * s + c] = arr[(i + 2) * s + c]; arr[(i + 2) * s + c] = t; }
    a.needsUpdate = true;
  }
}

/** cylinder UVs in metres: u around the circumference, v along the height */
function cylUV(g: THREE.CylinderGeometry, r: number) {
  const uv = g.attributes.uv as THREE.BufferAttribute, pos = g.attributes.position as THREE.BufferAttribute;
  const circ = Math.PI * 2 * r;
  for (let i = 0; i < uv.count; i++) {
    const y = pos.getY(i);
    const nIsCap = Math.abs(pos.getX(i)) < 1e-6 && Math.abs(pos.getZ(i)) < 1e-6;
    uv.setXY(i, nIsCap ? 0 : uv.getX(i) * circ, y);
  }
}

function latheUV(g: THREE.LatheGeometry, profile: Array<[number, number]>) {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const rMax = Math.max(...profile.map((p) => p[0]));
  // arc length along the profile for v
  const acc: number[] = [0];
  for (let i = 1; i < profile.length; i++) acc.push(acc[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  // (LatheGeometry's own v is the profile point INDEX / (n − 1), not arc length: a profile with clustered points — tank
  // strakes, lips — squashed the texture into those clusters. Vertex order is [segment][profile point].)
  const np = profile.length;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * rMax, acc[i % np]);
}

/** deterministic hash noise 0..1 of an integer tuple */
export function hash(...n: number[]): number {
  let h = 2166136261 >>> 0;
  for (const v of n) { h ^= Math.floor(v * 1000) | 0; h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** reuse vector for callers */
export const tmp = { v: _v, n: _n, m3: _m3 };

// ------------------------------------------------------------------------------------------------ merged shadow casters
/** the material of a caster-only mesh: in the MAIN pass every vertex is thrown outside the clip volume (nothing is
 *  rasterised); the shadow passes draw it with three's own depth material (both faces: single-sided roofs / plates
 *  must cast whichever way they face the sun) */
let casterOnlyMat: THREE.ShaderMaterial | null = null;
export function casterOnlyMaterial(): THREE.ShaderMaterial {
  return (casterOnlyMat ??= Object.assign(new THREE.ShaderMaterial({
    vertexShader: "void main() { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); }",
    fragmentShader: "void main() { gl_FragColor = vec4( 0.0 ); }",
    colorWrite: false, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  }), { name: "harbor-caster-only" }));
}
/** make a mesh SHADOW-ONLY at zero main-pass cost: the main render sets its draw range to −1 (three returns from
 *  renderBufferDirect before binding anything — no draw, no vertex work), every shadow render (onBeforeShadow, also
 *  the static far-map bake) restores it. (The clip-away material alone still ran the vertex shader over every caster
 *  vertex in the main pass: 150–250 k vertices at kong eye.) */
export function shadowOnly<T extends THREE.Mesh>(m: T): T {
  const g = m.geometry as THREE.BufferGeometry;
  m.onBeforeRender = () => { g.drawRange.count = -1; };
  m.onBeforeShadow = () => { g.drawRange.count = Infinity; };
  return m;
}
/**
 * Perf: a static group built as one mesh per MATERIAL cast shadows with one draw per material per shadow pass — but
 * the shadow passes draw everything with the same depth material. This merges every casting (non-instanced) mesh under
 * `root` into ONE caster-only mesh (positions only, root-local) added to `root`, and turns the sources' casting off:
 * a 10-material shed cluster goes from 20 shadow draws (2 cascades) to 2 + one empty main-pass draw. The caster lives
 * inside `root`, so HarborLod's show / shadow distances keep driving it. `farShadow`: the static far-map policy for it
 * (default: atmos decides by size; false when an HLOD proxy already bakes the far map).
 */
export function mergeCasters(root: THREE.Object3D, o: { farShadow?: boolean | "force"; name?: string; cell?: number; c1?: boolean } = {}): THREE.Group | null {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), rel = new THREE.Matrix4();
  // triangles binned into `cell`-metre cells (root-local, by centroid): each cascade's frustum culls the cells it does
  // not cover (one crane-wide caster would draw into the 26 m contact cascade from 60 m away)
  const cell = o.cell ?? 100, bins = new Map<string, number[]>();
  const v = new THREE.Vector3();
  root.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || !m.castShadow || m.userData.castShadow === false) return;
    const mat = m.material as THREE.Material;
    if (!mat || mat.transparent) return;
    const src = m.geometry as THREE.BufferGeometry, pa = src.attributes.position as THREE.BufferAttribute, idx = src.index;
    rel.multiplyMatrices(inv, m.matrixWorld);
    const n = idx ? idx.count : pa.count, P = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(pa, idx ? idx.getX(i) : i).applyMatrix4(rel); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
    for (let t = 0; t + 8 < P.length; t += 9) {
      const cx = (P[t] + P[t + 3] + P[t + 6]) / 3, cz = (P[t + 2] + P[t + 5] + P[t + 8]) / 3;
      const k = `${Math.floor(cx / cell)}:${Math.floor(cz / cell)}`;
      const b = bins.get(k) ?? bins.set(k, []).get(k)!;
      for (let q = 0; q < 9; q++) b.push(P[t + q]);
    }
    m.castShadow = false; m.userData.castShadow = false;
  });
  if (!bins.size) return null;
  const grp = new THREE.Group(); grp.name = o.name ?? `${root.name}-caster`;
  for (const [k, arr] of bins) {
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    g.computeBoundingSphere(); g.computeBoundingBox();
    const caster = shadowOnly(new THREE.Mesh(g, casterOnlyMaterial()));
    caster.name = `${grp.name}-${k}`;
    caster.castShadow = true; caster.receiveShadow = false; caster.userData.castShadow = true;
    if (o.farShadow !== undefined) caster.userData.farShadow = o.farShadow;
    // (c1 false = the detailed silhouette casts into the near cascade only; a coarse c1Caster() stands in for it in
    // cascade 1 — the crane lattice was 89 k shadow tris in the 26–220 m cascade)
    if (o.c1 !== undefined) caster.userData.c1Shadow = o.c1;
    grp.add(caster);
  }
  root.add(grp);
  return grp;
}

/** atmos' cascade-1 caster layer (client/src/world/atmos/shadows.ts C1_LAYER — a published render-layer contract) */
export const C1_LAYER = 29;
/**
 * Perf: a CASCADE-1-ONLY caster from coarse stand-in geometry (the far proxies): it lives on the C1 layer alone, so
 * the main pass and cascade 0 never see it (no draw at all) and cascade 1 draws one coarse silhouette instead of the
 * detailed casters (which get `mergeCasters(…, { c1: false })`). Positions are taken relative to `into` (add it there).
 */
export function c1Caster(src: THREE.Object3D | THREE.Object3D[], into: THREE.Object3D, name: string): THREE.Mesh | null {
  into.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(into.matrixWorld).invert(), rel = new THREE.Matrix4(), v = new THREE.Vector3();
  const out: number[] = [];
  for (const s of Array.isArray(src) ? src : [src]) {
    s.updateMatrixWorld(true);
    s.traverse((x) => {
      const m = x as THREE.Mesh;
      if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return;
      const g = m.geometry as THREE.BufferGeometry, pa = g.attributes.position as THREE.BufferAttribute, idx = g.index;
      rel.multiplyMatrices(inv, m.matrixWorld);
      const n = idx ? idx.count : pa.count;
      for (let i = 0; i < n; i++) { v.fromBufferAttribute(pa, idx ? idx.getX(i) : i).applyMatrix4(rel); out.push(v.x, v.y, v.z); }
    });
  }
  if (!out.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  g.computeBoundingSphere(); g.computeBoundingBox();
  const mesh = new THREE.Mesh(g, casterOnlyMaterial());
  mesh.name = name;
  mesh.layers.set(C1_LAYER);
  mesh.castShadow = true; mesh.receiveShadow = false;
  mesh.userData.castShadow = true; mesh.userData.c1Shadow = true; mesh.userData.farShadow = false;
  return mesh;
}

/**
 * Perf: static instanced sets (rocks placed once, never moved) → ONE plain mesh per material: every instance baked
 * into the geometry. 4 rock prototypes × (main + 2 cascades) = 12 draws → 3. Returns a new group replacing `root`'s
 * InstancedMesh children (casting / receiving / userData copied from the first mesh of each material).
 */
export function mergeInstanced(root: THREE.Object3D, name = root.name, cell = 120): THREE.Group {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), rel = new THREE.Matrix4(), im4 = new THREE.Matrix4(), p = new THREE.Vector3();
  // one mesh per material per `cell`-metre cell (instances binned by position): the shadow cascades + the main frustum
  // cull what they do not see
  const byMat = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; like: THREE.Mesh }>();
  root.traverse((x) => {
    const m = x as THREE.InstancedMesh;
    if (!m.isInstancedMesh) return;
    const mat = m.material as THREE.Material;
    rel.multiplyMatrices(inv, m.matrixWorld);
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, im4);
      im4.premultiply(rel);
      p.setFromMatrixPosition(im4);
      const k = `${mat.uuid}|${Math.floor(p.x / cell)}:${Math.floor(p.z / cell)}`;
      const e = byMat.get(k) ?? byMat.set(k, { mat, geos: [], like: m }).get(k)!;
      const g = m.geometry.clone();
      g.applyMatrix4(im4);
      e.geos.push(g.index ? g.toNonIndexed() : g);
    }
  });
  const out = new THREE.Group(); out.name = name;
  for (const { mat, ...e } of byMat.values()) {
    const merged = mergeGeometries(e.geos, false);
    if (!merged) { console.warn(`[harbor-geo] mergeInstanced failed (${name})`); continue; }
    merged.computeBoundingSphere(); merged.computeBoundingBox();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = `${name}:${mat.name || "mat"}`;
    mesh.castShadow = e.like.castShadow; mesh.receiveShadow = e.like.receiveShadow; mesh.userData = { ...e.like.userData };
    out.add(mesh);
  }
  return out;
}

/**
 * Perf (CPU): a static POI subtree never moves after build — stop three from recomposing + re-multiplying every
 * object's matrices each frame (scene.updateMatrixWorld was the top JS cost at kong eye). Matrices are baked once here;
 * `keep` names subtrees that animate (gulls…) and keep their auto updates.
 */
export function freezeStatic(root: THREE.Object3D, keep: (o: THREE.Object3D) => boolean = () => false) {
  root.updateMatrixWorld(true);
  const walk = (o: THREE.Object3D) => {
    if (keep(o)) return;
    o.matrixAutoUpdate = false;
    o.matrixWorldNeedsUpdate = false;
    for (const c of o.children) walk(c);
  };
  for (const c of root.children) walk(c);
}

/**
 * ONE invisible far-shadow-map stand-in for every static caster under `root` whose far-map policy is left to atmos
 * (merged caster cells, rocks, pier…): their triangles (root-local) go into a caster-only mesh the far-map bake
 * FORCE-shows, and the sources are marked `farShadow: false`. The static far map then holds the whole POI whatever the
 * LOD / off-screen visibility of its groups at bake time (a detail group hidden by distance or by the off-screen cull
 * when the bake ran used to be missing from the far map for the rest of the match). Same size rule as atmos (> 0.8 m).
 */
export function farBakeStandIn(root: THREE.Object3D, name = `${root.name}-farbake`): THREE.Mesh | null {
  const it = farBakeSteps(root, name);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
/** farBakeStandIn in time slices (the root walk + per-vertex copy was one 250 ms task on the wreck) */
export async function farBakeStandInAsync(root: THREE.Object3D, yieldFn: () => Promise<void>, name = `${root.name}-farbake`): Promise<THREE.Mesh | null> {
  const it = farBakeSteps(root, name);
  let r = it.next();
  while (!r.done) { await yieldFn(); r = it.next(); }
  return r.value;
}
function* farBakeSteps(root: THREE.Object3D, name: string): Generator<void, THREE.Mesh | null, void> {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), rel = new THREE.Matrix4(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const list: THREE.Mesh[] = [];
  root.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || !m.castShadow) return;
    const ud = m.userData;
    if (ud.farShadow === false || ud.farShadow === "force" || ud.farShadow === true) return;
    if (/grass|fern|flower|weed|pebble|decal|gull/i.test(m.name)) return;
    list.push(m);
  });
  let total = 0;
  const keep: THREE.Mesh[] = [];
  for (const m of list) {
    const g = m.geometry as THREE.BufferGeometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    m.getWorldScale(s);
    m.userData.farShadow = false;
    if ((g.boundingSphere?.radius ?? 0) * Math.max(s.x, s.y, s.z) <= 0.8) continue;
    keep.push(m); total += g.index ? g.index.count : (g.attributes.position as THREE.BufferAttribute).count;
  }
  if (!total) return null;
  const out = new Float32Array(total * 3);
  let at = 0, t0 = performance.now();
  for (const m of keep) {
    const g = m.geometry as THREE.BufferGeometry, pa = g.attributes.position as THREE.BufferAttribute, idx = g.index;
    rel.multiplyMatrices(inv, m.matrixWorld);
    const e = rel.elements, n = idx ? idx.count : pa.count;
    for (let i = 0; i < n; i++) {
      const k = idx ? idx.getX(i) : i, x = pa.getX(k), y = pa.getY(k), z = pa.getZ(k);
      out[at++] = e[0] * x + e[4] * y + e[8] * z + e[12]; out[at++] = e[1] * x + e[5] * y + e[9] * z + e[13]; out[at++] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    if (performance.now() - t0 > 10) { yield; t0 = performance.now(); }
  }
  void v;
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(out, 3));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, casterOnlyMaterial());
  mesh.name = name; mesh.visible = false; mesh.castShadow = true; mesh.receiveShadow = false;
  mesh.userData.castShadow = true; mesh.userData.farShadow = "force"; mesh.userData.c1Shadow = false;
  root.add(mesh);
  return mesh;
}
