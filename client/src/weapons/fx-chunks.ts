// Lit 3D debris for the weapons FX: ejected banana casings + shotgun hulls, wood splinters,
// stone chips, glass shards, dirt clods and banana-peel confetti. One InstancedMesh per shape, all on one shared vertex
// buffer (each shape's geometry is a draw range of it) and one material: an instance runs only its own shape's
// vertices. (Every shape in one instanced draw, the unused ones collapsed in the vertex shader, ran all 2388 vertices
// for every chunk: a full pool of 384 was 306 k triangles, RAY-288.) A shape with no live chunk draws nothing (cull.ts
// skips empty instanced meshes). Each pool is dense (swap-remove on death) so update() and the matrix upload are
// O(live); the cap counts every shape together. PBR (MeshStandard) so debris is lit, shadowed (receives) and hazed like
// the world around it.
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

export const K = { CASING: 0, HULL: 1, SPLINTER: 2, CHIP: 3, SHARD: 4, PEEL: 5, CLOD: 6 } as const;

const col = (hex: string) => new THREE.Color(hex);
const YEL = col("#ffd21f"), YEL_D = col("#e0a400"), BROWN = col("#5a3218"), BROWN_D = col("#2e1a0c"), CREAM = col("#f6e7bd");
const GREEN = col("#6f9f2a"), GREEN_D = col("#44701a"), BRASS = col("#e9b233"), BRASS_D = col("#a77414"), WHITE = col("#ffffff");

function paint(g: THREE.BufferGeometry, f: (x: number, y: number, z: number, out: THREE.Color) => void) {
  const p = g.attributes.position as THREE.BufferAttribute, c = new Float32Array(p.count * 3), t = new THREE.Color();
  for (let i = 0; i < p.count; i++) { f(p.getX(i), p.getY(i), p.getZ(i), t.set(1, 1, 1)); c[i * 3] = t.r; c[i * 3 + 1] = t.g; c[i * 3 + 2] = t.b; }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return g;
}
function tidy(g: THREE.BufferGeometry, flat = false): THREE.BufferGeometry {
  let o = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(o.attributes)) if (k !== "position" && k !== "normal") o.deleteAttribute(k);
  if (flat) { o.computeVertexNormals(); return o; }
  o = mergeVertices(o, 1e-5); o.computeVertexNormals();
  return o;
}
/** long axis +Z, centred */
function latheZ(prof: Array<[number, number]>, seg: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  g.rotateX(Math.PI / 2);
  g.computeBoundingBox(); const c = g.boundingBox!.getCenter(new THREE.Vector3()); g.translate(-c.x, -c.y, -c.z);
  return g;
}
function rngf(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** every shape's vertices in one non-indexed geometry (shape by shape, in K order) and each shape's [first, count] */
function buildShapes(): { geo: THREE.BufferGeometry; ranges: Array<[number, number]> } {
  const parts: THREE.BufferGeometry[] = [];
  const tag = (g: THREE.BufferGeometry, shape: number) => { g.setAttribute("aShape", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(shape), 1)); parts.push(g); };

  // banana casing: brass-yellow body, brown rim + primer, dark open mouth (long axis Z; base at -Z)
  const L = 0.03;
  let g = tidy(latheZ([[0, 0], [0.0064, 0], [0.0066, 0.0012], [0.0064, 0.0024], [0.0053, 0.003], [0.0053, 0.0042], [0.006, 0.0048], [0.006, 0.021], [0.0048, 0.025], [0.0046, L], [0.0036, L], [0.0036, L - 0.004]], 12));
  paint(g, (_x, _y, z, o) => { const u = z / L + 0.5; if (u < 0.17) o.copy(BROWN); else if (u > 0.97) o.copy(BROWN_D); else o.copy(YEL).lerp(YEL_D, Math.max(0, (u - 0.7) * 2.5)); });
  tag(g, K.CASING);

  // shotgun hull: green hull, brass head, darker crimp
  const H = 0.052;
  g = tidy(latheZ([[0, 0], [0.0118, 0], [0.012, 0.0016], [0.0112, 0.003], [0.0112, 0.014], [0.0106, 0.0145], [0.0106, H - 0.004], [0.0092, H], [0.004, H - 0.002], [0, H - 0.003]], 14));
  paint(g, (x, y, z, o) => { const u = z / H + 0.5; if (u < 0.28) o.copy(BRASS).lerp(BRASS_D, u < 0.06 ? 0.6 : 0); else if (u > 0.93) o.copy(GREEN_D); else o.copy(GREEN).multiplyScalar(0.9 + 0.1 * Math.sign(x + y)); });
  tag(g, K.HULL);

  // wood splinter: tapered, slightly bent sliver with a jagged broken end
  {
    const r = rngf(7), n = 7, pos: number[] = [];
    const ring: THREE.Vector3[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, z = -0.04 + t * 0.08, w = 0.0075 * (1 - t * 0.85) * (i === 0 ? 1.15 : 1), h = 0.0042 * (1 - t * 0.7), bend = 0.006 * Math.sin(t * Math.PI);
      const jag = i === 0 ? 0.004 : 0;
      ring.push([[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y], j) => new THREE.Vector3(x, y + bend, z - (j % 2 ? jag * r() : 0))));
    }
    const q = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) { const a = ring[i][j], b = ring[i][(j + 1) % 4], c = ring[i + 1][(j + 1) % 4], d = ring[i + 1][j]; q(a, b, c, d); }
    const e = ring[0]; q(e[3], e[2], e[1], e[0]);
    const tip = ring[n]; q(tip[0], tip[1], tip[2], tip[3]);
    g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
    paint(g, (_x, y, z, o) => o.setScalar(0.82 + 0.18 * Math.sin(z * 900 + y * 300)));
    tag(g, K.SPLINTER);
  }

  // stone chip: jittered icosahedron, faceted
  {
    const r = rngf(3);
    const ico = new THREE.IcosahedronGeometry(0.016, 0);
    const p = ico.attributes.position as THREE.BufferAttribute;
    const moved = new Map<string, [number, number, number]>();
    for (let i = 0; i < p.count; i++) {
      const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
      if (!moved.has(key)) moved.set(key, [0.7 + r() * 0.55, 0.55 + r() * 0.4, 0.8 + r() * 0.5]);
      const [a, b, c] = moved.get(key)!;
      p.setXYZ(i, p.getX(i) * a, p.getY(i) * b, p.getZ(i) * c);
    }
    g = tidy(ico, true);
    paint(g, (_x, y, _z, o) => o.setScalar(0.85 + 0.15 * Math.sign(y)));
    tag(g, K.CHIP);
  }

  // glass shard: thin sharp sliver
  {
    const a = new THREE.Vector2(0, 0.03), b = new THREE.Vector2(-0.011, -0.016), c = new THREE.Vector2(0.014, -0.01), d = new THREE.Vector2(0.002, -0.022);
    const shape = new THREE.Shape([a, b, d, c]);
    g = new THREE.ExtrudeGeometry(shape, { depth: 0.0025, bevelEnabled: false });
    g.translate(0, 0, -0.00125); g.rotateX(Math.PI / 2);
    g = tidy(g, true);
    paint(g, (_x, y, _z, o) => o.setScalar(y > 0 ? 1 : 0.8));
    tag(g, K.SHARD);
  }

  // banana-peel confetti: a curling strip of peel, yellow outside, cream inside, brown tip
  {
    const n = 9, m = 3, len = 0.12, wid = 0.036, th = 0.004, curl = 1.9;
    const pos: number[] = [], cols: number[] = [];
    const P = (i: number, j: number, s: number): [number, number, number] => {
      const t = i / n, a = (t - 0.3) * curl, R = len / curl;
      const w = wid * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05))) * (j / m - 0.5);
      const cup = 0.012 * Math.cos(Math.PI * (j / m - 0.5));
      const y = R * (1 - Math.cos(a)) + cup + s * th, z = R * Math.sin(a);
      return [w, y, z];
    };
    const C = (i: number, s: number): THREE.Color => { const t = i / n; if (t > 0.86) return BROWN; return s > 0 ? YEL.clone().lerp(YEL_D, t * 0.6) : CREAM; };
    for (const s of [1, -1]) for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const q = [P(i, j, s), P(i + 1, j, s), P(i + 1, j + 1, s), P(i, j + 1, s)];
      const idx = s > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const k of idx) { pos.push(...q[k]); const cc = C(k === 1 || k === 2 ? i + 1 : i, s); cols.push(cc.r, cc.g, cc.b); }
    }
    g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeBoundingBox(); const cc = g.boundingBox!.getCenter(new THREE.Vector3()); g.translate(-cc.x, -cc.y, -cc.z);
    g.computeVertexNormals();
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    tag(g, K.PEEL);
  }

  // dirt / sand clod: lumpy smooth rock
  {
    const r = rngf(11);
    const ico = new THREE.IcosahedronGeometry(0.024, 1);
    const merged = mergeVertices(ico, 1e-5);
    const p = merged.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) { const f = 0.75 + r() * 0.4; p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.8, p.getZ(i) * f); }
    g = tidy(merged);
    paint(g, (_x, y, _z, o) => o.setScalar(0.8 + 0.2 * (y > 0 ? 1 : 0)));
    tag(g, K.CLOD);
  }

  // merge (all non-indexed-safe: index everything consistently)
  const list = parts.map((p) => {
    const q = p.index ? p.toNonIndexed() : p;
    if (!q.attributes.color) paint(q, (_x, _y, _z, o) => o.copy(WHITE));
    for (const k of Object.keys(q.attributes)) if (!["position", "normal", "color", "aShape"].includes(k)) q.deleteAttribute(k);
    return q;
  });
  list.sort((a, b) => a.attributes.aShape.getX(0) - b.attributes.aShape.getX(0));
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "color"]) {
    const size = list[0].attributes[name].itemSize;
    const total = list.reduce((s, x) => s + x.attributes[name].count, 0);
    const arr = new Float32Array(total * size);
    let off = 0;
    for (const x of list) { arr.set((x.attributes[name] as THREE.BufferAttribute).array as Float32Array, off); off += x.attributes[name].count * size; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  const ranges: Array<[number, number]> = [];
  let first = 0;
  for (const x of list) { const n = x.attributes.position.count; ranges[x.attributes.aShape.getX(0)] = [first, n]; first += n; }
  return { geo: out, ranges };
}

export interface ChunkParams {
  shape: number; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  life: number; scale: number; len: number; r: number; g: number; b: number;
  floor: number; rest: number; flutter: number; spin: number; grav: number;
}
const DEF: ChunkParams = { shape: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 2, scale: 1, len: 1, r: 1, g: 1, b: 1, floor: -1e9, rest: 0.35, flutter: 0, spin: 12, grav: 1 };

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();

/** one shape's live chunks: F holds 20 floats per chunk, dense (swap-remove on death) */
interface Pool { mesh: THREE.InstancedMesh; F: Float32Array; count: number; colorDirty: boolean }

export class Chunks {
  /** the debris root: one InstancedMesh per shape */
  readonly mesh = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly p: ChunkParams = { ...DEF };
  /** live chunks, every shape together (never more than cap) */
  count = 0;
  private readonly pools: Pool[] = [];
  private rnd = rngf(99);
  constructor(readonly cap: number) {
    const { geo, ranges } = buildShapes();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05, envMapIntensity: 0.8, side: THREE.DoubleSide });
    mat.name = "fx-chunks";
    this.material = mat;
    this.mesh.name = "fx-chunks";
    for (let s = 0; s < ranges.length; s++) {
      const g = new THREE.BufferGeometry();
      for (const name of ["position", "normal", "color"]) g.setAttribute(name, geo.attributes[name]);
      g.setDrawRange(ranges[s][0], ranges[s][1]);
      const mesh = new THREE.InstancedMesh(g, mat, cap);
      mesh.name = "fx-chunks:" + s;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false; mesh.receiveShadow = true;
      mesh.userData.castShadow = false; mesh.userData.noOutline = true;
      mesh.visible = false;
      this.mesh.add(mesh);
      this.pools.push({ mesh, F: new Float32Array(cap * 20), count: 0, colorDirty: false });
    }
  }

  emit() {
    const p = this.p, pool = this.pools[p.shape];
    if (this.count >= this.cap || !pool) { Object.assign(p, DEF); return; }
    this.count++;
    const i = pool.count++, o = i * 20, F = pool.F, R = this.rnd;
    F[o] = p.x; F[o + 1] = p.y; F[o + 2] = p.z; F[o + 3] = p.vx; F[o + 4] = p.vy; F[o + 5] = p.vz;
    F[o + 6] = R() * 6.28; F[o + 7] = R() * 6.28; F[o + 8] = R() * 6.28;
    F[o + 9] = (R() - 0.5) * 2 * p.spin; F[o + 10] = (R() - 0.5) * 2 * p.spin; F[o + 11] = (R() - 0.5) * 2 * p.spin;
    F[o + 12] = p.scale; F[o + 13] = p.len; F[o + 14] = 0; F[o + 15] = p.life; F[o + 16] = p.floor;
    F[o + 17] = p.rest; F[o + 18] = p.flutter; F[o + 19] = p.grav;
    const c = pool.mesh.instanceColor!.array as Float32Array; c[i * 3] = p.r; c[i * 3 + 1] = p.g; c[i * 3 + 2] = p.b;
    pool.colorDirty = true;
    Object.assign(p, DEF);
  }

  private kill(pool: Pool, i: number) {
    const last = --pool.count;
    this.count--;
    if (i !== last) {
      pool.F.copyWithin(i * 20, last * 20, last * 20 + 20);
      const c = pool.mesh.instanceColor!.array as Float32Array; c[i * 3] = c[last * 3]; c[i * 3 + 1] = c[last * 3 + 1]; c[i * 3 + 2] = c[last * 3 + 2];
      pool.colorDirty = true;
    }
  }

  update(dt: number) {
    for (let k = 0; k < this.pools.length; k++) this.step(this.pools[k], dt);
  }

  private step(pool: Pool, dt: number) {
    const F = pool.F, arr = pool.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < pool.count; i++) {
      const o = i * 20;
      const age = (F[o + 14] += dt), life = F[o + 15];
      if (age >= life) { this.kill(pool, i); i--; continue; }
      let vx = F[o + 3], vy = F[o + 4], vz = F[o + 5];
      const flutter = F[o + 18];
      const resting = F[o + 17] < 0;
      if (!resting) {
        vy -= 9.8 * F[o + 19] * dt;
        if (flutter > 0) {
          const d = Math.exp(-flutter * dt); vx *= d; vz *= d; vy = vy > -1.6 ? vy : vy * d;
          vx += Math.sin(age * 9 + o) * flutter * 0.35 * dt; vz += Math.cos(age * 7.3 + o) * flutter * 0.35 * dt;
        }
        if (F[o + 1] < 0 && F[o + 16] < 0) { const d = Math.exp(-7 * dt); vx *= d; vy *= d; vz *= d; }
        F[o] += vx * dt; F[o + 1] += vy * dt; F[o + 2] += vz * dt;
        F[o + 6] += F[o + 9] * dt; F[o + 7] += F[o + 10] * dt; F[o + 8] += F[o + 11] * dt;
        const floor = F[o + 16] + 0.006 * F[o + 12];
        if (F[o + 1] < floor) {
          F[o + 1] = floor;
          if (vy < -1.1) {
            vy = -vy * F[o + 17]; vx *= 0.55; vz *= 0.55;
            F[o + 9] *= 0.5; F[o + 10] *= 0.5; F[o + 11] *= 0.5;
            if (flutter > 0) { vy *= 0.3; }
          } else {
            vx = vy = vz = 0; F[o + 17] = -1;
            // settle lying down: long axis flat, keep the spin around Y
            F[o + 6] = Math.PI / 2 * Math.round(F[o + 6] / (Math.PI / 2)) ; F[o + 8] = 0;
          }
        }
        F[o + 3] = vx; F[o + 4] = vy; F[o + 5] = vz;
      }
      const pop = Math.min(1, age / 0.04), fin = Math.min(1, (life - age) / 0.3);
      const s = F[o + 12] * pop * fin * fin;
      _e.set(F[o + 6], F[o + 7], F[o + 8]);
      _q.setFromEuler(_e);
      _p.set(F[o], F[o + 1], F[o + 2]);
      _s.set(s, s, s * F[o + 13]);
      _m.compose(_p, _q, _s);
      _m.toArray(arr, i * 16);
    }
    const n = pool.count, mesh = pool.mesh;
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, n * 16); mesh.instanceMatrix.needsUpdate = true;
      if (pool.colorDirty) {
        const c = mesh.instanceColor!; c.clearUpdateRanges(); c.addUpdateRange(0, n * 3); c.needsUpdate = true;
        pool.colorDirty = false;
      }
    }
  }
}
