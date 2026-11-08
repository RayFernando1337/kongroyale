// poi-town: Coconut Cove serpentine hotel — VISUALS built from the shared layout (shared/pois/town-hotel.ts hotelLayout,
// the same data hotelColliders uses) into the town kit GeoBins (merged per material). The coconut-cove POI calls addHotel().
// Look: coral-pink plaster between chunky cream pilasters, rounded string
// courses at every floor and a big bullnose cornice (swept along the serpentine, mitred round the corners), a pink
// ground-floor arcade with cream archivolts + keystones, cream loggia arches with pink balustrade panels on the upper
// floors, cream-ringed PORTHOLES on the west wing and the end walls, roof parapet + thin railing, rooftop planters,
// a pink pavilion carrying a chunky yellow banana-bunch sculpture, draping vines, chipped plaster / drip streaks / moss
// (one alpha-decal mesh with its own canvas atlas → o.extra). Interiors: lobby with columns + furniture, rooms off a
// back corridor opening onto the loggias, dog-leg stair cores to every floor and the roof.
import * as THREE from "three";
import { type HotelSpec, type HotelLayout, type HWall, type Chord, type HotelPath, HOTEL, HS, hotelLayout, chordAt, wallChord, FRENCH_DEG, pavFrame, pavStair, BANANAS } from "../../../../../shared/pois/town-hotel";
import { mulberry } from "../../../../../shared/pois/town-kit";
import type { TownBins, TownMats } from "./town-materials";
import { M, col, cylGeo, latheGeo, prismGeo, GeoBin, groundAO, leafClumpGeo, type ColorFn } from "./town-geo";

export interface HotelOpts {
  /** world xz point the rooftop banana bunch turns its broad side toward (the view camera) */
  sculptureFace?: [number, number];
  /** meshes that need their own material (signs etc.) — pushed here, the POI adds them to its group */
  extra: THREE.Object3D[];
  rng: () => number;
  /** detail bins (furniture, lamps, pots, small dressing) — drawn only near the hotel (TownLod near level) */
  near?: TownBins;
}

type P2 = [number, number];
type Bin = GeoBin;
const PI = Math.PI;

// ---------------------------------------------------------------- geometry helpers
function flipGeo(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = g.getIndex();
  if (idx) { const a = idx.array; const out: number[] = []; for (let i = 0; i < a.length; i += 3) out.push(a[i], a[i + 2], a[i + 1]); g.setIndex(out); }
  const n = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

/** opening in a planar wall (local x along the wall, y up from the wall base, front face +z) */
type Op = { t: "arch"; cx: number; w: number; sp: number } | { t: "rect"; u: number; y: number; w: number; h: number } | { t: "circle"; cx: number; cy: number; r: number };

/** outline of an opening, CLOCKWISE seen from the front (left side up, over, right side down). Rect corners doubled. */
function opOutline(o: Op, seg: number): P2[] {
  if (o.t === "arch") {
    const r = o.w / 2, pts: P2[] = [[o.cx - r, 0], [o.cx - r, o.sp]];
    for (let i = 1; i < seg; i++) { const a = PI - PI * i / seg; pts.push([o.cx + Math.cos(a) * r, o.sp + Math.sin(a) * r]); }
    pts.push([o.cx + r, o.sp], [o.cx + r, 0]);
    return pts;
  }
  if (o.t === "rect") {
    const x0 = o.u, x1 = o.u + o.w, y0 = o.y, y1 = o.y + o.h;
    return o.y <= 0.001 ? [[x0, 0], [x0, y1], [x0, y1], [x1, y1], [x1, y1], [x1, 0]]
      : [[x0, y0], [x0, y1], [x0, y1], [x1, y1], [x1, y1], [x1, y0], [x1, y0], [x0, y0], [x0, y0], [x0, y1]].slice(0, 9).concat([[x0, y0]]) as P2[];
  }
  const pts: P2[] = [];
  for (let i = 0; i <= seg; i++) { const a = PI - TAU * i / seg; pts.push([o.cx + Math.cos(a) * o.r, o.cy + Math.sin(a) * o.r]); }
  return pts;
}
const TAU = PI * 2;
const touchesFloor = (o: Op) => o.t === "arch" || (o.t === "rect" && o.y <= 0.001);
const opLeft = (o: Op) => (o.t === "rect" ? o.u : o.t === "arch" ? o.cx - o.w / 2 : o.cx - o.r);

/** planar wall slab len × h, thickness T centred on z = 0 (front face z = +T/2), with openings. front/back faces + reveals */
function wallGeos(len: number, h: number, T: number, ops: Op[], seg = 16): { front: THREE.BufferGeometry; back: THREE.BufferGeometry; reveal: THREE.BufferGeometry | null } {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  const paths: P2[][] = [];
  for (const o of ops.filter(touchesFloor).sort((a, b) => opLeft(a) - opLeft(b))) {
    const pts = opOutline(o, seg);
    for (const p of pts) shape.lineTo(p[0], p[1]);
    paths.push(pts);
  }
  shape.lineTo(len, 0); shape.lineTo(len, h); shape.lineTo(0, h);
  for (const o of ops.filter((x) => !touchesFloor(x))) {
    const pts = opOutline(o, o.t === "circle" ? 28 : seg);
    const hole = new THREE.Path();
    hole.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) hole.lineTo(pts[i][0], pts[i][1]);
    shape.holes.push(hole);
    paths.push(pts);
  }
  const front = new THREE.ShapeGeometry(shape); front.translate(0, 0, T / 2);
  const back = flipGeo(new THREE.ShapeGeometry(shape)); back.translate(0, 0, -T / 2);
  return { front, back, reveal: paths.length ? revealGeo(paths, T) : null };
}
/** inner surfaces of openings: bands along the outlines from z = −T/2 to +T/2, normals into the opening */
function revealGeo(paths: P2[][], T: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (const pts of paths) {
    const base = pos.length / 3;
    let u = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) u += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      pos.push(pts[i][0], pts[i][1], -T / 2, pts[i][0], pts[i][1], T / 2);
      uv.push(u, 0, u, T);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2, b = a + 2, c = a + 1, d = a + 3;
      if (Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) < 1e-5) continue;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** generic sweep: profile [a, b] along frames (point p, profile axes a, b). Normal = tangent × profile direction. */
interface SF { p: THREE.Vector3; a: THREE.Vector3; b: THREE.Vector3; u: number }
function sweepGeo(profile: P2[], frames: SF[]): THREE.BufferGeometry {
  const np = profile.length, nf = frames.length;
  const pos = new Float32Array(np * nf * 3), uv = new Float32Array(np * nf * 2);
  const parc = [0];
  for (let j = 1; j < np; j++) parc.push(parc[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  for (let i = 0; i < nf; i++) {
    const f = frames[i];
    for (let j = 0; j < np; j++) {
      const k = i * np + j, [pa, pb] = profile[j];
      pos[k * 3] = f.p.x + f.a.x * pa + f.b.x * pb; pos[k * 3 + 1] = f.p.y + f.a.y * pa + f.b.y * pb; pos[k * 3 + 2] = f.p.z + f.a.z * pa + f.b.z * pb;
      uv[k * 2] = f.u; uv[k * 2 + 1] = parc[j];
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nf - 1; i++) for (let j = 0; j < np - 1; j++) {
    if (parc[j + 1] - parc[j] < 1e-6) continue;
    const a = i * np + j, b = (i + 1) * np + j, c = a + 1, d = b + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
const UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, 1);
/** frames for a straight run from (x0,z0) to (x1,z1) at height y with outward (ox,oz) (b = up); optional mitre vectors at the ends */
function lineFrames(x0: number, z0: number, x1: number, z1: number, y: number, o0: P2, o1: P2, u0 = 0): SF[] {
  const l = Math.hypot(x1 - x0, z1 - z0);
  return [{ p: new THREE.Vector3(x0, y, z0), a: new THREE.Vector3(o0[0], 0, o0[1]), b: UP, u: u0 }, { p: new THREE.Vector3(x1, y, z1), a: new THREE.Vector3(o1[0], 0, o1[1]), b: UP, u: u0 + l }];
}
/** mitre of two unit outward normals (scaled so offsets stay parallel to both faces) */
function mitre(a: P2, b: P2): P2 { let x = a[0] + b[0], z = a[1] + b[1]; const l = Math.hypot(x, z) || 1; x /= l; z /= l; const k = 1 / Math.max(0.3, x * a[0] + z * a[1]); return [x * k, z * k]; }
/** the building outline as 4 swept sides (facade, east end, back, west end), outward normals mitred at the corners */
function loopFrames(P: HotelPath, L: number, D: number, y: number, step = 1.0): SF[][] {
  const f0 = P.at(0), fL = P.at(L);
  const neg = (v: P2): P2 => [-v[0], -v[1]];
  const n = Math.max(2, Math.ceil(L / step));
  const fac: SF[] = [], back: SF[] = [];
  for (let i = 0; i <= n; i++) {
    const s = L * i / n, f = P.at(s);
    let o: P2 = neg(f.n);
    if (i === 0) o = mitre(neg(f0.n), neg(f0.d)); else if (i === n) o = mitre(neg(fL.n), fL.d);
    fac.push({ p: new THREE.Vector3(f.p[0], y, f.p[1]), a: new THREE.Vector3(o[0], 0, o[1]), b: UP, u: s });
  }
  let u = L;
  const e0 = P.pt(L, 0), e1 = P.pt(L, D);
  const east = lineFrames(e0[0], e0[1], e1[0], e1[1], y, mitre(fL.d, neg(fL.n)), mitre(fL.d, fL.n), u);
  u += D;
  let prev = P.pt(L, D);
  for (let i = 0; i <= n; i++) {
    const s = L - L * i / n, f = P.at(s), q = P.pt(s, D);
    u += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q;
    let o: P2 = f.n;
    if (i === 0) o = mitre(fL.n, fL.d); else if (i === n) o = mitre(f0.n, neg(f0.d));
    back.push({ p: new THREE.Vector3(q[0], y, q[1]), a: new THREE.Vector3(o[0], 0, o[1]), b: UP, u });
  }
  const w0 = P.pt(0, D), w1 = P.pt(0, 0);
  const west = lineFrames(w0[0], w0[1], w1[0], w1[1], y, mitre(neg(f0.d), f0.n), mitre(neg(f0.d), neg(f0.n)), u);
  return [fac, east, back, west];
}
/** chamfered box (vertical edges bevelled) centred at the origin */
function chamferBoxGeo(w: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const x = w / 2, z = d / 2;
  const g = prismGeo([[-x + c, -z], [x - c, -z], [x, -z + c], [x, z - c], [x - c, z], [-x + c, z], [-x, z - c], [-x, -z + c]], -h / 2, h / 2);
  g.computeVertexNormals();
  return g;
}
/** chamfered bar along x (long edges bevelled) */
function barGeo(len: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const g = chamferBoxGeo(h, len, d, c); g.rotateZ(-PI / 2); return g;
}
/** extruded 2D shape (XY) with depth along +z from 0 */
function extrudeGeo(pts: P2[], depth: number): THREE.BufferGeometry {
  const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, steps: 1 });
}
/** folded leaf: base at the origin, tip at +z (unit length), width 1 along x */
const LEAF_P = [[0, 0, 0], [-0.5, 0.14, 0.42], [0, 0, 1], [0.5, 0.14, 0.42]];

/** non-indexed triangle batch with per-vertex colours (one GeoBin.add at the end) */
class Batch {
  pos: number[] = []; col: number[] = []; uv: number[] = [];
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, cl: THREE.Color) {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < 3; i++) this.col.push(cl.r, cl.g, cl.b);
    this.uv.push(0, 0, 1, 0, 0.5, 1);
  }
  leaf(m: THREE.Matrix4, cl: THREE.Color) {
    const v = LEAF_P.map((p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m));
    this.tri(v[0], v[1], v[2], cl); this.tri(v[0], v[2], v[3], cl);
  }
  flush(bin: Bin) {
    if (!this.pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    const cols = this.col; let k = 0;
    bin.add(g, null, 0xffffff, (x, y, z, b, o) => { o.setRGB(cols[k * 3], cols[k * 3 + 1], cols[k * 3 + 2]); k++; });
    this.pos = []; this.col = []; this.uv = [];
  }
}

/** leaf-making basis: pointing along dir, random roll */
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();
function leafMatrix(p: THREE.Vector3, dir: THREE.Vector3, len: number, wid: number, roll: number): THREE.Matrix4 {
  _z.copy(dir).normalize();
  _x.set(0, 1, 0).cross(_z); if (_x.lengthSq() < 1e-4) _x.set(1, 0, 0); _x.normalize();
  _y.copy(_z).cross(_x).normalize();
  _x.applyAxisAngle(_z, roll); _y.applyAxisAngle(_z, roll);
  _m.makeBasis(_x.multiplyScalar(wid), _y.multiplyScalar(wid), _z.multiplyScalar(len)); _m.setPosition(p);
  return _m;
}

// ---------------------------------------------------------------- banana
/** a chunky 5-ridged banana along +x (length len), arc bulging +y, blossom end at the origin, stem at the far end */
function bananaGeo(len: number, r: number, bend: number, col0: THREE.Color): { body: THREE.BufferGeometry; tip: THREE.Vector3; tipDir: THREE.Vector3 } {
  const ns = 30, nr = 20, R = len / bend;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], cl: number[] = [], idx: number[] = [];
  const spine = (t: number) => { const a = (t - 0.5) * bend; return new THREE.Vector3(R * Math.sin(a) + R * Math.sin(bend / 2), R * Math.cos(a) - R * Math.cos(bend / 2), 0); };
  const tang = (t: number) => { const a = (t - 0.5) * bend; return new THREE.Vector3(Math.cos(a), -Math.sin(a), 0); };
  const radius = (t: number) => r * (0.2 + 0.8 * Math.pow(Math.sin(PI * Math.min(1, Math.max(0, t * 0.96 + 0.02))), 0.5));
  const yellow = col0, green = new THREE.Color("#a9b53a"), brown = new THREE.Color("#5b4424"), tmp = new THREE.Color();
  for (let i = 0; i <= ns; i++) {
    const t = i / ns, c = spine(t), T = tang(t), N = new THREE.Vector3(-T.y, T.x, 0), B = new THREE.Vector3(0, 0, 1), rr = radius(t);
    for (let j = 0; j <= nr; j++) {
      const th = TAU * j / nr, ridge = 1 + 0.09 * Math.cos(5 * th);
      const dirv = N.clone().multiplyScalar(Math.cos(th)).add(B.clone().multiplyScalar(Math.sin(th)));
      const p = c.clone().addScaledVector(dirv, rr * ridge);
      pos.push(p.x, p.y, p.z);
      nor.push(dirv.x, dirv.y, dirv.z);
      uv.push(th * rr, t * len);
      // colour: green-ish ends, yellow body, brown blossom tip, ridge highlights
      const ends = Math.max(0, 1 - t / 0.08, (t - 0.9) / 0.1);
      tmp.copy(yellow).lerp(green, Math.min(1, ends * 0.9));
      if (t < 0.035) tmp.lerp(brown, 0.8);
      tmp.multiplyScalar(0.93 + 0.1 * Math.max(0, Math.cos(5 * th)));
      cl.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let i = 0; i < ns; i++) for (let j = 0; j < nr; j++) { const a = i * (nr + 1) + j, b = a + nr + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  // end caps (fans)
  for (const e of [0, ns]) {
    const c = spine(e / ns), T = tang(e / ns).multiplyScalar(e === 0 ? -1 : 1), ci = pos.length / 3;
    pos.push(c.x + T.x * 0.05, c.y + T.y * 0.05, c.z); nor.push(T.x, T.y, T.z); uv.push(0, 0);
    const cc = e === 0 ? brown : green; cl.push(cc.r, cc.g, cc.b);
    for (let j = 0; j < nr; j++) { const a = e * (nr + 1) + j; if (e === 0) idx.push(ci, a + 1, a); else idx.push(ci, a, a + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(cl, 3));
  g.setIndex(idx);
  return { body: g, tip: spine(1), tipDir: tang(1) };
}

// ---------------------------------------------------------------- grime decal atlas (4 rows × 256 px, 1024 wide)
//  row 0 moss/grime base band (tiles in u) · row 1 drip streaks hanging from the top (tiles) · row 2 four chipped-plaster
//  patches (cells) · row 3 soft water stains + hairline cracks (tiles). Texture u: 1 tile = 4 m (rows 0,1,3).
function grimeTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const W = 1024, R = 256;
  const c = document.createElement("canvas"); c.width = W; c.height = W;
  const g = c.getContext("2d"); if (!g) return null;
  const rnd = mulberry(9127);
  const wrap = (x: number, fn: (x: number) => void) => { fn(x); if (x < 160) fn(x + W); if (x > W - 160) fn(x - W); };
  const per = (x: number, k: number, ph: number) => Math.sin((x / W) * TAU * k + ph);
  // row 0: moss / grime rising from the ground (row bottom = ground)
  for (let x = 0; x < W; x += 2) {
    const e = 120 + 38 * per(x, 3, 1) + 22 * per(x, 7, 2) + 12 * per(x, 17, 0.4) + 6 * per(x, 41, 3);
    const gr = g.createLinearGradient(0, R - e, 0, R);
    gr.addColorStop(0, "rgba(70,78,40,0)"); gr.addColorStop(0.45, "rgba(66,76,36,0.32)"); gr.addColorStop(0.8, "rgba(50,58,28,0.7)"); gr.addColorStop(1, "rgba(38,42,22,0.88)");
    g.fillStyle = gr; g.fillRect(x, R - e, 2, e);
  }
  for (let i = 0; i < 140; i++) {
    const x = rnd() * W, y = R - Math.pow(rnd(), 1.6) * 150, r = 5 + rnd() * 22, green = rnd() < 0.7;
    wrap(x, (xx) => { const rg = g.createRadialGradient(xx, y, 0, xx, y, r); rg.addColorStop(0, green ? "rgba(72,104,40,0.55)" : "rgba(60,52,38,0.45)"); rg.addColorStop(1, "rgba(72,104,40,0)"); g.fillStyle = rg; g.beginPath(); g.arc(xx, y, r, 0, TAU); g.fill(); });
  }
  // row 1: drips hanging from the top edge
  {
    const y0 = R;
    for (let x = 0; x < W; x += 2) {
      const e = 16 + 10 * per(x, 5, 0.7) + 6 * per(x, 13, 2);
      const gr = g.createLinearGradient(0, y0, 0, y0 + e);
      gr.addColorStop(0, "rgba(58,48,36,0.62)"); gr.addColorStop(1, "rgba(58,48,36,0)");
      g.fillStyle = gr; g.fillRect(x, y0, 2, e);
    }
    for (let i = 0; i < 70; i++) {
      const x = rnd() * W, w = 2 + rnd() * 11, l = 40 + Math.pow(rnd(), 0.8) * 205, a = 0.25 + rnd() * 0.4;
      wrap(x, (xx) => {
        const gr = g.createLinearGradient(0, y0, 0, y0 + l);
        gr.addColorStop(0, `rgba(52,42,32,${a})`); gr.addColorStop(0.7, `rgba(52,42,32,${a * 0.45})`); gr.addColorStop(1, "rgba(52,42,32,0)");
        g.fillStyle = gr; g.beginPath(); g.moveTo(xx - w / 2, y0); g.lineTo(xx + w / 2, y0); g.lineTo(xx + w * 0.25, y0 + l); g.lineTo(xx - w * 0.25, y0 + l); g.closePath(); g.fill();
      });
    }
  }
  // row 2: chipped plaster patches (4 cells)
  for (let k = 0; k < 4; k++) {
    const cx = k * R + R / 2, cy = 2 * R + R / 2;
    const blob = (rad: number, n: number, jit: number) => { const pts: P2[] = []; for (let i = 0; i < n; i++) { const a = TAU * i / n, rr = rad * (1 - jit + 2 * jit * rnd()); pts.push([cx + Math.cos(a) * rr * 1.25, cy + Math.sin(a) * rr * 0.85]); } return pts; };
    const path = (pts: P2[]) => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1]); g.closePath(); };
    const outer = blob(86, 22, 0.32);
    g.save(); g.translate(3, 4); path(outer); g.fillStyle = "rgba(60,40,30,0.45)"; g.fill(); g.restore();
    path(outer); g.fillStyle = "rgba(238,226,202,0.96)"; g.fill();
    g.lineWidth = 2.5; g.strokeStyle = "rgba(92,64,48,0.55)"; g.stroke();
    if (k % 2 === 0) { const inner = blob(40, 14, 0.35); path(inner); g.fillStyle = "rgba(176,104,78,0.85)"; g.fill(); g.lineWidth = 1.5; g.strokeStyle = "rgba(90,52,40,0.6)"; g.stroke(); }
    for (let i = 0; i < 18; i++) { g.fillStyle = `rgba(90,70,56,${0.2 + rnd() * 0.3})`; g.fillRect(cx - 90 + rnd() * 180, cy - 60 + rnd() * 120, 2 + rnd() * 3, 2 + rnd() * 3); }
  }
  // row 3: stains + cracks
  for (let i = 0; i < 26; i++) {
    const x = rnd() * W, y = 3 * R + 30 + rnd() * (R - 60), r = 25 + rnd() * 70;
    wrap(x, (xx) => { const rg = g.createRadialGradient(xx, y, 0, xx, y, r); rg.addColorStop(0, "rgba(96,78,58,0.26)"); rg.addColorStop(0.6, "rgba(96,78,58,0.12)"); rg.addColorStop(1, "rgba(96,78,58,0)"); g.fillStyle = rg; g.beginPath(); g.arc(xx, y, r, 0, TAU); g.fill(); });
  }
  g.lineCap = "round";
  for (let i = 0; i < 9; i++) {
    let x = 60 + rnd() * (W - 120), y = 3 * R + 20 + rnd() * 60;
    g.strokeStyle = "rgba(70,50,40,0.6)"; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 9; k++) { x += (rnd() - 0.5) * 30; y += 8 + rnd() * 18; if (y > 4 * R - 10) break; g.lineTo(x, y); }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 8;
  return t;
}
const rowV = (row: number, f: number) => 1 - (row + 1) / 4 + (0.03 + 0.94 * f) / 4;

// ---------------------------------------------------------------- the builder
class HotelBuilder {
  readonly P: HotelPath;
  readonly lv: number[];
  readonly D: number;
  readonly rnd: () => number;
  readonly grime: GeoBin | null;
  readonly vines = new Batch();
  readonly C: Record<string, THREE.Color>;
  readonly baseAO: ColorFn;
  /** detail bins (TownLod near level) — falls back to the main bins */
  readonly n: TownBins;
  constructor(readonly b: TownBins, readonly mats: TownMats, readonly h: HotelSpec, readonly lay: HotelLayout, readonly o: HotelOpts) {
    this.P = lay.P; this.lv = lay.lv; this.D = h.depth; this.n = o.near ?? b;
    this.rnd = mulberry(4242);
    const tex = grimeTexture();
    this.grime = tex ? new GeoBin("cove:hotel-grime", new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.95, metalness: 0, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, name: "cove:hotel-grime" })) : null;
    if (this.grime) { this.grime.castShadow = false; this.grime.receiveShadow = true; }
    this.C = {
      pink: col(h.wall), pinkIn: col("#efc8b4"), cream: col(h.trim), creamD: col(h.trim, 0.9), green: col(h.accent), ceil: col("#f2e8d6"),
      lobby: col("#e9dcc2"), loggia: col("#c98d6c"), wood: col("#b07c4e"), corridor: col("#dccbac"), roof: col("#b9ae9b"),
      stone: col("#cbbd9d"), step: col("#ddd0b6"), metal: col("#d7d3c5"), rail: col("#e4dfd0"), glassFrame: col("#2f4f3c"),
    };
    this.baseAO = groundAO(h.y, 2.2, 0.7);
  }
  r(a = 0, b = 1) { return a + (b - a) * this.rnd(); }
  chordM(c: Chord, y = 0) { return M(c.ax, y, c.az, c.yaw); }
  normalM(s: number, v: number, y = 0, yawAdd = 0) { const [x, z] = this.P.pt(s, v); return M(x, y, z, this.P.yaw(s) + yawAdd); }
  uvo(): [number, number] { return [this.r(0, 4), this.r(0, 4)]; }

  // ---------- decals (grime mesh)
  decal(m: THREE.Matrix4, w: number, hgt: number, row: number, opts: { u0?: number; cell?: number; tint?: THREE.Color | string } = {}) {
    if (!this.grime) return;
    const g = new THREE.PlaneGeometry(w, hgt);
    const uv = g.attributes.uv as THREE.BufferAttribute, pos = g.attributes.position as THREE.BufferAttribute;
    const u0 = opts.u0 ?? this.r(0, 4);
    for (let i = 0; i < uv.count; i++) {
      const fx = pos.getX(i) / w + 0.5, fy = pos.getY(i) / hgt + 0.5;
      const u = opts.cell !== undefined ? (opts.cell + 0.04 + 0.92 * fx) / 4 : u0 + fx * w / 4;
      uv.setXY(i, u, rowV(row, fy));
    }
    this.grime.add(g, m, opts.tint ?? 0xffffff);
  }

  // ---------- walls
  /** planar wall slab in a local frame m (x along, y up from base, front +z), with openings */
  planar(m: THREE.Matrix4, len: number, hh: number, T: number, ops: Op[], bin: Bin, c: THREE.Color, revealBin: Bin, revealC: THREE.Color, backC?: THREE.Color, fn?: ColorFn) {
    const g = wallGeos(len, hh, T, ops);
    const uo = this.uvo();
    for (const geo of [g.front, g.back]) { const uv = geo.attributes.uv as THREE.BufferAttribute; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + uo[0], uv.getY(i) + uo[1]); }
    bin.add(g.front, m, c, fn);
    bin.add(g.back, m, backC ?? c, fn);
    if (g.reveal) revealBin.add(g.reveal, m, revealC, fn);
  }
  /** a wall built from its collider pieces as boxes (interior / plain walls) */
  pieceBoxes(w: HWall, bin: Bin, c: THREE.Color, fn?: ColorFn) {
    const P = this.P;
    if (w.axis === "s") {
      const ch = wallChord(P, w), m0 = this.chordM(ch, w.y0), T = w.v1 - w.v0;
      for (const pc of piecesOf(ch.len, w)) bin.box(pc.w, pc.h, T, m0.clone().multiply(M(pc.u + pc.w / 2, pc.y + pc.h / 2, 0)), c, this.uvo(), fn);
    } else {
      const m0 = this.normalM(w.s0, w.v0, w.y0);
      for (const pc of piecesOf(w.v1 - w.v0, w)) bin.box(w.t, pc.h, pc.w, m0.clone().multiply(M(0, pc.y + pc.h / 2, -(pc.u + pc.w / 2))), c, this.uvo(), fn);
    }
  }

  async walls(y: () => Promise<void>) {
    const { lay, b, C } = this;
    for (const w of lay.walls) {
      await y();
      switch (w.kind) {
        case "arcade": this.arcadeWall(w); break;
        case "loggia": this.loggiaWall(w); break;
        case "porthole": this.portholeWall(w); break;
        case "end": this.endWall(w); break;
        case "back": this.backWall(w); break;
        case "roomFront": case "coreFront": this.roomFrontWall(w); break;
        case "corridor": this.corridorWall(w); break;
        case "partition": case "coreSide": case "spine": this.pieceBoxes(w, b.plaster, C.pinkIn); break;
        case "bulkhead": this.pieceBoxes(w, b.plaster, C.pink, this.baseAO); break;
        default: break;
      }
    }
  }

  arcadeWall(w: HWall) {
    const { b, C } = this, ch = wallChord(this.P, w), T = w.v1 - w.v0, op = w.openings[0], m = this.chordM(ch, w.y0);
    const r = op.w / 2, cx = op.u + r, sp = HS.gSpring;
    this.planar(m, ch.len, w.h, T, [{ t: "arch", cx, w: op.w, sp }], b.plaster, C.pink, b.trim, C.creamD, C.pinkIn, this.baseAO);
    this.archivolt(m, cx, op.w, sp, T / 2, 0.55, 0.3, 0.13);
    this.keystone(m, cx, sp + r, w.h + 0.02 - 0.42 + HS.slabT, T / 2);
    // plinth on both jambs + threshold + a step down to the pad
    for (const [u0, u1] of [[0, op.u], [op.u + op.w, ch.len]]) {
      b.stone.box(u1 - u0 + 0.02, 0.62, 0.24, m.clone().multiply(M((u0 + u1) / 2, 0.31 - HS.plinth, T / 2)), C.stone, this.uvo(), this.baseAO);
      this.decal(m.clone().multiply(M((u0 + u1) / 2, 0.3 - HS.plinth, T / 2 + 0.125)), u1 - u0 + 0.02, 0.6, 0, { tint: "#ffffff" });
    }
    b.stone.box(op.w, 0.06, T + 0.02, m.clone().multiply(M(cx, -0.02, 0)), C.step);
    b.stone.box(op.w + 0.3, HS.plinth, 0.55, m.clone().multiply(M(cx, -HS.plinth / 2, T / 2 + 0.27)), C.step, this.uvo(), this.baseAO);
    // spandrel wear: chips + stains above the haunches
    if (this.rnd() < 0.55) this.decal(m.clone().multiply(M(this.rnd() < 0.5 ? cx - r - 0.2 : cx + r + 0.2, sp + r * 0.7, T / 2 + 0.012)), this.r(0.35, 0.7), this.r(0.3, 0.5), 2, { cell: Math.floor(this.r(0, 4)) });
    if (this.rnd() < 0.5) this.decal(m.clone().multiply(M(this.r(0.6, ch.len - 0.6), w.h - 0.9, T / 2 + 0.012)), this.r(1.2, 2.4), 1.4, 3);
  }

  loggiaWall(w: HWall) {
    const { b, C } = this, ch = wallChord(this.P, w), T = w.v1 - w.v0, op = w.openings[0], m = this.chordM(ch, w.y0);
    const r = op.w / 2, cx = op.u + r, sp = HS.spring;
    // pink plaster spandrels (the dominant surface) with a cream archivolt + balustrade as the accents
    this.planar(m, ch.len, w.h, T, [{ t: "arch", cx, w: op.w, sp }], b.plaster, C.pink, b.trim, C.creamD, C.pinkIn, this.baseAO);
    this.archivolt(m, cx, op.w, sp, T / 2, 0.0, 0.2, 0.09);
    this.keystone(m, cx, sp + r, w.h + 0.02 - 0.42 + HS.slabT, T / 2);
    this.balustrade(m, op.u, op.u + op.w, 0);
    // loggia ceiling lamp + some dressing on the loggia floor
    const f = w.floor, rs = this.rnd();
    // lived-in, overgrown loggias (never mostly empty bays) — a bistro set or a big pot in most bays,
    // a second pot, and creepers spilling over most balustrades
    if (rs < 0.3) this.bistro(m, cx + this.r(-0.6, 0.6), -1.3);
    else if (rs < 0.8) this.pot(m.clone().multiply(M(cx + (this.rnd() < 0.5 ? -1 : 1) * this.r(0.9, 1.3), 0, -0.75)), this.r(0.32, 0.46), this.rnd() < 0.5);
    if (this.rnd() < 0.45) this.pot(m.clone().multiply(M(cx + this.r(-0.4, 0.4), 0, -0.55)), this.r(0.24, 0.32));
    if (this.rnd() < 0.62 && f > 0) this.vineCurtain(m, cx + this.r(-r * 0.7, r * 0.7), HS.rail + 0.08, 0.2, this.r(1.6, 4.2));
    // (break the grid — a beach towel drying over some balustrades, a striped canvas awning over some arches)
    if (f > 0 && this.rnd() < 0.3) {
      const tc = col(["#e8722a", "#2fb3a8", "#f1c232", "#d9483b", "#3a86c8"][Math.floor(this.r(0, 5))]), tx = cx + this.r(-r * 0.5, r * 0.5);
      b.fabric.box(0.55, 0.025, 0.42, m.clone().multiply(M(tx, HS.rail + 0.015, 0)), tc);
      b.fabric.box(0.55, 0.62, 0.02, m.clone().multiply(M(tx, HS.rail - 0.3, 0.22)), tc, [0, 0], (x, y, z, bb, o) => { if (Math.sin(y * 22) > 0.55) o.lerp(new THREE.Color("#f7f1e2"), 0.75); });
    }
    if (this.rnd() < 0.28) {
      const stripeA = new THREE.Color("#e8826a"), stripeB = new THREE.Color("#f6ecd4"), am = m.clone().multiply(M(cx, sp + r + 0.32, T / 2 + 0.42, 0, 0.36));
      b.fabric.box(op.w + 0.4, 0.035, 0.95, am, 0xffffff, [0, 0], (x, y, z, bb, o) => { const lp = new THREE.Vector3(x, y, z).applyMatrix4(am.clone().invert()); o.copy(Math.floor((lp.x + 5) / 0.3) % 2 ? stripeA : stripeB); });
      for (const sx of [-1, 1]) b.metal.add(cylGeo(0.015, 0.015, 0.9, 5), m.clone().multiply(M(cx + sx * (op.w / 2 + 0.15), sp + r + 0.1, T / 2 + 0.4, 0, 0.9)), col("#5c5a52"));
    }
  }

  portholeWall(w: HWall) {
    const { b, C } = this, ch = wallChord(this.P, w), T = w.v1 - w.v0, m = this.chordM(ch, w.y0), cx = ch.len / 2;
    this.planar(m, ch.len, w.h, T, [{ t: "circle", cx, cy: HS.portY, r: HS.portR }], b.plaster, C.pink, b.trim, C.creamD, C.pinkIn, this.baseAO);
    this.porthole(m.clone().multiply(M(cx, HS.portY, T / 2)));
    // recessed-panel moulding (thin cream frame) + wear
    this.panelFrame(m, 0.62, 0.34, ch.len - 0.62, w.h - 0.62, T / 2);
    this.decal(m.clone().multiply(M(cx, HS.portY - HS.portR - 0.95, T / 2 + 0.012)), 1.3, 1.6, 1);
    if (this.rnd() < 0.7) this.decal(m.clone().multiply(M(this.r(0.9, 1.3) * (this.rnd() < 0.5 ? 1 : -1) + cx, this.r(0.5, 0.8), T / 2 + 0.012)), this.r(0.4, 0.8), this.r(0.3, 0.55), 2, { cell: Math.floor(this.r(0, 4)) });
    if (this.rnd() < 0.6) this.decal(m.clone().multiply(M(this.r(1, ch.len - 1), w.h - 0.8, T / 2 + 0.012)), this.r(1.2, 2.6), 1.3, 3);
  }

  endWall(w: HWall) {
    const { b, C, P, D } = this, L = this.lay.L, west = w.bay < 0, T = w.t;
    // frame: origin at the outer back corner (west) / outer front corner (east), x along the wall, z outward
    const s = west ? 0 : L, f = P.at(s);
    const ox = west ? -f.n[0] : f.n[0], oz = west ? -f.n[1] : f.n[1];
    const [px, pz] = P.pt(s, west ? D : 0);
    const m = M(px, w.y0, pz, Math.atan2(-oz, ox)).multiply(M(0, 0, -T / 2));
    const U = (u: number, wd: number) => (west ? D - u - wd : u);
    const ops: Op[] = w.openings.map((o) => (o.kind === "arch" ? { t: "arch", cx: U(o.u, o.w) + o.w / 2, w: o.w, sp: HS.gSpring } : { t: "circle", cx: U(o.u, o.w) + o.w / 2, cy: HS.portY, r: HS.portR }));
    this.planar(m, D, w.h, T, ops, b.plaster, C.pink, b.trim, C.creamD, C.pinkIn, this.baseAO);
    for (const op of ops) {
      if (op.t === "arch") {
        this.archivolt(m, op.cx, op.w, op.sp, T / 2, 0.55, 0.3, 0.13);
        this.keystone(m, op.cx, op.sp + op.w / 2, w.h + 0.02 - 0.42 + HS.slabT, T / 2);
        b.stone.box(op.w + 0.3, HS.plinth, 0.55, m.clone().multiply(M(op.cx, -HS.plinth / 2, T / 2 + 0.27)), C.step, this.uvo(), this.baseAO);
        for (const [u0, u1] of [[0, op.cx - op.w / 2], [op.cx + op.w / 2, D]]) {
          b.stone.box(u1 - u0, 0.62, 0.24, m.clone().multiply(M((u0 + u1) / 2, 0.31 - HS.plinth, T / 2)), C.stone, this.uvo(), this.baseAO);
          this.decal(m.clone().multiply(M((u0 + u1) / 2, 0.3 - HS.plinth, T / 2 + 0.125)), u1 - u0, 0.6, 0);
        }
      } else if (op.t === "circle") {
        this.porthole(m.clone().multiply(M(op.cx, op.cy, T / 2)));
        this.decal(m.clone().multiply(M(op.cx, op.cy - HS.portR - 0.95, T / 2 + 0.012)), 1.3, 1.6, 1);
      }
    }
    if (w.floor > 0) {
      // panel mouldings between the portholes
      const xs = [0.75, ...ops.map((o) => (o.t === "circle" ? o.cx : 0)).filter((x) => x > 0).sort((a, c) => a - c), D - 0.75];
      for (let i = 0; i < xs.length - 1; i++) {
        const x0 = i === 0 ? xs[0] : (xs[i]), x1 = xs[i + 1];
        if (i === 0 || i === xs.length - 2) continue;
        void x0; void x1;
      }
      this.panelFrame(m, 0.85, 0.34, D - 0.85, w.h - 0.62, T / 2);
      for (let k = 0; k < 3; k++) if (this.rnd() < 0.7) this.decal(m.clone().multiply(M(this.r(1, D - 1), this.r(0.5, w.h - 0.8), T / 2 + 0.012)), this.r(0.4, 0.9), this.r(0.3, 0.6), 2, { cell: Math.floor(this.r(0, 4)) });
      this.decal(m.clone().multiply(M(this.r(3, D - 3), w.h - 0.9, T / 2 + 0.012)), this.r(3, 5), 1.5, 3);
    }
    // vines on the west end (the wall the view camera sees)
    if (west && w.floor === this.h.floors - 1) {
      for (const u of [2.2, 10.4]) this.creeper(m, u + this.r(-0.4, 0.4), T / 2, w.h + 0.2, this.r(4.5, 7.5), true);
    }
    if (west && w.floor === 0) for (const u of [0.9, 12.8]) this.creeper(m, u, T / 2, -HS.plinth, this.r(3, 6), false);
  }

  backWall(w: HWall) {
    const { b, C } = this, ch = wallChord(this.P, w), T = w.v1 - w.v0, m = this.chordM(ch, w.y0);
    this.pieceBoxes(w, b.plaster, C.pink, this.baseAO);
    const out = -T / 2; // outside face (north)
    for (const op of w.openings) {
      const cu = op.u + op.w / 2;
      if (op.kind === "window") {
        this.windowTrim(m, op.u, op.y, op.w, op.h, out, -1, true);
        this.decal(m.clone().multiply(M(cu, op.y - 0.85, out - 0.012, PI)), 1.1, 1.5, 1);
      } else if (op.kind === "door") {
        this.doorTrim(m, op.u, op.w, op.h, out, -1);
        this.doorLeaf(m, op.u, op.w, op.h, 0, 1, 75, C.green);
      }
    }
    if (w.floor === 0) {
      for (const pc of piecesOf(ch.len, w)) if (pc.y < 0.01) {
        b.stone.box(pc.w + 0.02, 0.62, 0.24, m.clone().multiply(M(pc.u + pc.w / 2, 0.31 - HS.plinth, out)), C.stone, this.uvo(), this.baseAO);
        this.decal(m.clone().multiply(M(pc.u + pc.w / 2, 0.3 - HS.plinth, out - 0.125, PI)), pc.w, 0.6, 0);
      }
    }
    // downpipe every 3rd bay
    if (w.floor === 0 && w.bay % 3 === 1) {
      const H = this.lay.roof - this.lv[0];
      b.metal.add(cylGeo(0.07, 0.07, H + 0.2, 8), m.clone().multiply(M(0.55, H / 2, out - 0.12)), col("#b8b2a4"));
    }
  }

  roomFrontWall(w: HWall) {
    const { b, C } = this, ch = wallChord(this.P, w), T = w.v1 - w.v0, m = this.chordM(ch, w.y0);
    this.pieceBoxes(w, b.plaster, C.pink);
    const front = T / 2;
    for (const op of w.openings) {
      if (op.kind === "french") {
        this.doorTrim(m, op.u, op.w, op.h, front, 1, C.glassFrame);
        // two glazed leaves, opened out onto the loggia
        for (const sgn of [-1, 1]) {
          const hinge = sgn < 0 ? op.u : op.u + op.w, lw = op.w / 2 - 0.02, a = (sgn < 0 ? -FRENCH_DEG : FRENCH_DEG) * PI / 180;
          const mm = m.clone().multiply(M(hinge, op.h / 2, front)).multiply(M(0, 0, 0, a)).multiply(M(-sgn * lw / 2, 0, 0.03));
          b.woodDark.box(lw, op.h - 0.04, 0.05, mm, C.glassFrame);
          b.glass.add(new THREE.PlaneGeometry(lw - 0.18, op.h - 0.5), mm.clone().multiply(M(0, 0.08, 0.03)), 0xffffff);
          b.woodDark.box(lw - 0.1, 0.05, 0.06, mm.clone().multiply(M(0, 0.2, 0.01)), C.glassFrame);
        }
        b.stone.box(op.w + 0.1, 0.04, T + 0.06, m.clone().multiply(M(op.u + op.w / 2, 0.0, 0)), C.stone);
      } else if (op.kind === "window") {
        this.windowTrim(m, op.u, op.y, op.w, op.h, front, 1, op.shutters ?? false);
      }
    }
    // wear under the window + a loggia lamp over the door
    if (w.kind === "roomFront") {
      b.bulb.add(new THREE.SphereGeometry(0.09, 10, 6), m.clone().multiply(M(ch.len / 2 - 0.6, w.h - 0.35, front + 0.18)), 0xffffff);
      b.metal.box(0.14, 0.2, 0.2, m.clone().multiply(M(ch.len / 2 - 0.6, w.h - 0.2, front + 0.1)), col("#6f6a5e"));
      if (this.rnd() < 0.45) this.decal(m.clone().multiply(M(this.r(0.5, ch.len - 0.5), w.h - 0.7, front + 0.012)), this.r(1, 2), 1.2, 3);
    }
  }

  corridorWall(w: HWall) {
    const { b, C } = this, ch = wallChord(this.P, w), T = w.v1 - w.v0, m = this.chordM(ch, w.y0);
    this.pieceBoxes(w, b.plaster, C.pinkIn);
    for (const op of w.openings) {
      if (op.w > 2) continue; // stair-core opening
      this.doorTrim(m, op.u, op.w, op.h, -T / 2, -1, col("#6b4a2c"));
      this.doorLeaf(m, op.u, op.w, op.h, T / 2, 1, 82, col("#8a5a34"));
    }
    // corridor ceiling lamp
    if (w.bay % 2 === 0) b.bulb.add(new THREE.SphereGeometry(0.1, 10, 6), m.clone().multiply(M(ch.len / 2, w.h - 0.2, -1.3)), 0xffffff);
  }

  // ---------- wall dressing
  archivolt(m: THREE.Matrix4, cx: number, w: number, sp: number, z: number, y0: number, width: number, proud: number) {
    const r = w / 2, fr: SF[] = [], seg = 18;
    const push = (x: number, y: number, ax: number, ay: number, u: number) => fr.push({ p: new THREE.Vector3(x, y, z - 0.01), a: new THREE.Vector3(ax, ay, 0), b: FWD, u });
    push(cx - r, y0, -1, 0, 0);
    push(cx - r, sp, -1, 0, sp - y0);
    for (let i = 1; i < seg; i++) { const a = PI - PI * i / seg; push(cx + Math.cos(a) * r, sp + Math.sin(a) * r, Math.cos(a), Math.sin(a), sp - y0 + r * PI * i / seg); }
    push(cx + r, sp, 1, 0, sp - y0 + r * PI);
    push(cx + r, y0, 1, 0, 2 * (sp - y0) + r * PI);
    const pr: P2[] = [[0, 0], [0, proud * 0.7], [0.03, proud], [width - 0.05, proud], [width, proud * 0.6], [width, 0]];
    this.b.trim.add(sweepGeo(pr, fr), m, this.C.cream);
  }
  keystone(m: THREE.Matrix4, cx: number, crown: number, top: number, z: number) {
    const y0 = crown - 0.34, y1 = Math.max(crown + 0.12, top);
    const g = extrudeGeo([[-0.2, 0], [0.2, 0], [0.29, y1 - y0], [-0.29, y1 - y0]], 0.2);
    this.b.trim.add(g, m.clone().multiply(M(cx, y0, z - 0.04)), this.C.cream);
  }
  balustrade(m: THREE.Matrix4, u0: number, u1: number, z: number) {
    const { b, C } = this, H = HS.rail, len = u1 - u0;
    b.trim.add(barGeo(len, 0.14, 0.34, 0.03), m.clone().multiply(M((u0 + u1) / 2, 0.07, z)), C.creamD);
    const posts = [u0 + 0.11, (u0 + u1) / 2, u1 - 0.11];
    for (const p of posts) b.trim.add(chamferBoxGeo(0.22, H - 0.2, 0.3, 0.04), m.clone().multiply(M(p, 0.14 + (H - 0.2) / 2 - 0.02, z)), C.cream);
    for (let i = 0; i < 2; i++) {
      const a = posts[i] + 0.11, c = posts[i + 1] - 0.11, pw = c - a, pc = (a + c) / 2;
      b.plaster.box(pw + 0.02, H - 0.26, 0.18, m.clone().multiply(M(pc, 0.14 + (H - 0.26) / 2, z)), C.pink, this.uvo());
      // raised inset frame on the outer face
      for (const [x, y, w2, h2] of [[pc, 0.28, pw - 0.18, 0.045], [pc, H - 0.24, pw - 0.18, 0.045], [a + 0.09, (H + 0.04) / 2, 0.045, H - 0.52], [c - 0.09, (H + 0.04) / 2, 0.045, H - 0.52]] as Array<[number, number, number, number]>) b.trim.box(w2, h2, 0.03, m.clone().multiply(M(x, y, z + 0.1)), C.cream);
    }
    b.trim.add(barGeo(len + 0.08, 0.1, 0.4, 0.035), m.clone().multiply(M((u0 + u1) / 2, H - 0.05, z)), C.cream);
  }
  porthole(m: THREE.Matrix4) {
    const { b, C } = this, R = HS.portR;
    // thick cream ring (lathe around the local z axis)
    const ring = latheGeo([[R - 0.04, -0.1], [R - 0.04, 0.05], [R + 0.02, 0.1], [R + 0.2, 0.13], [R + 0.27, 0.08], [R + 0.28, 0.0], [R + 0.28, -0.02]], 32);
    ring.rotateX(PI / 2);
    b.trim.add(ring, m.clone().multiply(M(0, 0, 0, 0, 0, 0)).multiply(new THREE.Matrix4().makeRotationX(PI)), C.cream);
    b.glass.add(new THREE.CircleGeometry(R, 28), m.clone().multiply(M(0, 0, -0.17)), 0xffffff);
    // inner bead + glazing bar
    b.trim.add(new THREE.TorusGeometry(R - 0.03, 0.035, 6, 28), m.clone().multiply(M(0, 0, -0.14)), C.creamD);
  }
  panelFrame(m: THREE.Matrix4, x0: number, y0: number, x1: number, y1: number, z: number) {
    const t = 0.07, d = 0.05, c = this.C.cream;
    this.b.trim.box(x1 - x0, t, d, m.clone().multiply(M((x0 + x1) / 2, y0, z + d / 2)), c);
    this.b.trim.box(x1 - x0, t, d, m.clone().multiply(M((x0 + x1) / 2, y1, z + d / 2)), c);
    this.b.trim.box(t, y1 - y0, d, m.clone().multiply(M(x0, (y0 + y1) / 2, z + d / 2)), c);
    this.b.trim.box(t, y1 - y0, d, m.clone().multiply(M(x1, (y0 + y1) / 2, z + d / 2)), c);
  }
  /** window trims for a rect opening; side = +1 → decoration on the +z face at z, −1 → on the −z face */
  windowTrim(m: THREE.Matrix4, u: number, y: number, w: number, hh: number, z: number, side: number, shutters: boolean, blind = false) {
    const { b, C } = this, fw = 0.13, cu = u + w / 2, cy = y + hh / 2, zz = z + side * 0.04;
    b.trim.box(fw, hh + 0.16, 0.1, m.clone().multiply(M(u - fw / 2, cy, zz)), C.cream);
    b.trim.box(fw, hh + 0.16, 0.1, m.clone().multiply(M(u + w + fw / 2, cy, zz)), C.cream);
    b.trim.box(w + 2 * fw + 0.1, 0.16, 0.14, m.clone().multiply(M(cu, y + hh + 0.08, zz + side * 0.02)), C.cream);
    b.trim.box(w + 2 * fw + 0.16, 0.09, 0.24, m.clone().multiply(M(cu, y - 0.045, zz + side * 0.05)), C.cream);
    if (blind) b.louvre.add(new THREE.BoxGeometry(w, hh, 0.04), m.clone().multiply(M(cu, cy, z - side * 0.06)), C.green);
    else b.glass.add(new THREE.PlaneGeometry(w, hh), m.clone().multiply(M(cu, cy, z - side * 0.08)), 0xffffff);
    // (no cross mullion — the pane breaks and the window is a vault)
    if (shutters) {
      const sw = w / 2;
      for (const sgn of [-1, 1]) b.louvre.add(new THREE.BoxGeometry(sw, hh, 0.04), m.clone().multiply(M(sgn < 0 ? u - fw - sw / 2 - 0.03 : u + w + fw + sw / 2 + 0.03, cy, zz + side * 0.02)), C.green);
    }
  }
  doorTrim(m: THREE.Matrix4, u: number, w: number, hh: number, z: number, side: number, c?: THREE.Color) {
    const { b } = this, fw = 0.12, cc = c ?? this.C.cream, zz = z + side * 0.03;
    b.trim.box(fw, hh + fw, 0.1, m.clone().multiply(M(u - fw / 2, (hh + fw) / 2, zz)), cc);
    b.trim.box(fw, hh + fw, 0.1, m.clone().multiply(M(u + w + fw / 2, (hh + fw) / 2, zz)), cc);
    b.trim.box(w + 2 * fw, fw, 0.1, m.clone().multiply(M(u + w / 2, hh + fw / 2, zz)), cc);
  }
  doorLeaf(m: THREE.Matrix4, u: number, w: number, hh: number, z: number, side: number, deg: number, c: THREE.Color) {
    const a = side * deg * PI / 180;
    const mm = m.clone().multiply(M(u, hh / 2, z)).multiply(M(0, 0, 0, -a)).multiply(M(w / 2 - 0.02, 0, 0));
    this.b.wood.box(w - 0.05, hh - 0.05, 0.06, mm, c, this.uvo());
    this.b.woodDark.box(w - 0.35, 0.7, 0.08, mm.clone().multiply(M(0, hh * 0.22, 0)), c.clone().multiplyScalar(0.8));
    this.b.woodDark.box(w - 0.35, 0.9, 0.08, mm.clone().multiply(M(0, -hh * 0.2, 0)), c.clone().multiplyScalar(0.8));
    this.b.metal.add(new THREE.SphereGeometry(0.04, 6, 4), mm.clone().multiply(M(w / 2 - 0.12, -0.05, 0.05)), col("#c9a54a"));
  }

  // ---------- facade frame: pilasters, corner piers, bands, cornice + parapet, railing
  facadeFrame() {
    const { b, C, P, lay, D, h } = this, L = lay.L, top = lay.roof - 0.4, y0 = h.y - 0.05;
    for (let k = 1; k < lay.nBays; k++) {
      const s = k * lay.bw, m = this.normalM(s, 0);
      b.trim.add(chamferBoxGeo(HS.pier, top - y0, HS.pierOut + 0.15, 0.08), m.clone().multiply(M(0, (y0 + top) / 2, (HS.pierOut - 0.15) / 2)), C.cream, this.baseAO);
      b.stone.add(chamferBoxGeo(HS.pier + 0.2, 0.7, HS.pierOut + 0.3, 0.06), m.clone().multiply(M(0, y0 + 0.35, HS.pierOut / 2)), C.stone, this.baseAO);
      this.decal(m.clone().multiply(M(0, y0 + 0.5, HS.pierOut + 0.155)), HS.pier + 0.2, 0.9, 0);
      // drips under each band on the pier face + climbing creepers on some piers
      for (let f = 1; f < h.floors; f++) if (this.rnd() < 0.55) this.decal(m.clone().multiply(M(0, this.lv[f] - 0.42 - 0.75, HS.pierOut + 0.012)), HS.pier - 0.1, 1.5, 1);
      if (this.rnd() < 0.3) this.creeper(m, this.r(-0.25, 0.25), HS.pierOut + 0.05, 0.4 - HS.plinth + h.y - this.lv[0] + this.lv[0] - h.y, this.r(2.5, 6.5), false, h.y);
    }
    // corner piers (wrap both faces)
    const corners: Array<[number, number, number, number]> = [[0, 0, 1, 1], [L, 0, -1, 1], [0, D, 1, -1], [L, D, -1, -1]];
    for (const [s, v, sx, sz] of corners) {
      const m = this.normalM(s, v), w = 1.4;
      b.trim.add(chamferBoxGeo(w, top - y0, w, 0.09), m.clone().multiply(M(sx * (w / 2 - 0.3), (y0 + top) / 2, sz * -(w / 2 - 0.3))), C.cream, this.baseAO);
      b.stone.add(chamferBoxGeo(w + 0.2, 0.7, w + 0.2, 0.07), m.clone().multiply(M(sx * (w / 2 - 0.3), y0 + 0.35, sz * -(w / 2 - 0.3))), C.stone, this.baseAO);
    }
    // string courses between floors (swept round the whole building)
    const BAND: P2[] = ([[-0.06, -0.42], [0.2, -0.42], [0.2, -0.42], [0.27, -0.37], [0.33, -0.29], [0.41, -0.22], [0.46, -0.11], [0.48, 0.0], [0.46, 0.09], [0.4, 0.16], [0.32, 0.19], [0.32, 0.19], [0.3, 0.26], [0.3, 0.26], [-0.06, 0.26]] as P2[]).map(([a, c]) => [a * 0.55, c * 0.5] as P2);
    for (let f = 1; f < h.floors; f++) for (const side of loopFrames(P, L, D, this.lv[f])) b.trim.add(sweepGeo(BAND, side), null, C.cream);
    // chunky bullnose cornice + parapet with coping
    const ROOF: P2[] = [[-0.06, -0.98], [0.1, -0.98], [0.1, -0.98], [0.2, -0.9], [0.32, -0.8], [0.46, -0.68], [0.59, -0.53], [0.69, -0.36], [0.75, -0.19], [0.77, -0.04], [0.73, 0.07], [0.62, 0.13], [0.62, 0.13],
      [0.1, 0.15], [0.1, 0.15], [0.1, 1.0], [0.1, 1.0], [0.17, 1.0], [0.22, 1.06], [0.2, 1.15], [0.12, 1.19], [0.12, 1.19], [-0.38, 1.19], [-0.38, 1.19], [-0.45, 1.15], [-0.47, 1.06], [-0.42, 1.0], [-0.42, 1.0], [-0.33, 1.0], [-0.33, 1.0], [-0.33, 0.0]];
    const sides = loopFrames(P, L, D, lay.roof);
    for (const side of sides) b.trim.add(sweepGeo(ROOF, side), null, C.cream, (x, y, z, bb, o) => { if (y < lay.roof - 0.3) o.multiplyScalar(0.94); });
    // drips below the cornice on the end walls + west-wing panels
    // thin railing on the parapet coping (front + both ends)
    const RAIL: P2[] = [[-0.03, -0.03], [0.03, -0.03], [0.03, 0.03], [-0.03, 0.03], [-0.03, -0.03]];
    for (const [si, side] of sides.entries()) {
      if (si === 2) continue;
      for (const yy of [0.62, 0.3]) b.metal.add(sweepGeo(RAIL, side.map((f) => ({ ...f, p: f.p.clone().add(new THREE.Vector3(f.a.x * -0.14, 1.19 + yy, f.a.z * -0.14)) }))), null, C.rail);
      const u0 = side[0].u, u1 = side[side.length - 1].u, n = Math.max(1, Math.round((u1 - u0) / 1.6));
      for (let i = 0; i <= n; i++) {
        const uu = u0 + (u1 - u0) * i / n;
        let k = 0; while (k < side.length - 2 && side[k + 1].u < uu) k++;
        const fa = side[k], fb = side[k + 1], t = (uu - fa.u) / Math.max(1e-6, fb.u - fa.u);
        const p = fa.p.clone().lerp(fb.p, t), a = fa.a.clone().lerp(fb.a, t);
        b.metal.add(cylGeo(0.025, 0.025, 0.66, 6), M(p.x - a.x * 0.14, lay.roof + 1.19 + 0.33, p.z - a.z * 0.14), C.rail);
      }
    }
  }

  // ---------- slabs, floors, ceilings
  slabs() {
    const { b, C, P } = this;
    for (const s of this.lay.slabs) {
      const poly: P2[] = [P.pt(s.s0, s.v0), P.pt(s.s1, s.v0), P.pt(s.s1, s.v1), P.pt(s.s0, s.v1)];
      if (s.zone === "ground") { b.stone.add(prismGeo(poly, s.top - 0.4, s.top, 1), null, (s.bay % 2 ? C.lobby : C.lobby.clone().multiplyScalar(0.94))); continue; }
      const ceilBin = s.zone === "loggia" ? b.plaster : this.n.inner;
      if (s.zone === "cap") { b.tin.add(prismGeo(poly, s.top - s.t, s.top, 1), null, col("#7f8b6c")); continue; }
      const finish = s.zone === "room" ? b.wood : s.zone === "roof" ? b.plaster : b.stone;
      const fc = s.zone === "room" ? C.wood : s.zone === "roof" ? C.roof : s.zone === "loggia" ? C.loggia : C.corridor;
      finish.add(prismGeo(poly, s.top - 0.05, s.top, s.zone === "room" ? 1 : 1), null, fc);
      ceilBin.add(prismGeo(poly, s.top - s.t, s.top - 0.05, 1), null, s.zone === "loggia" ? C.pinkIn : C.ceil);
    }
  }

  // ---------- stairs
  stairs() {
    const { b, C, P, lay } = this;
    for (const st of lay.steps) {
      const vm = (st.v0 + st.v1) / 2, a = P.pt(st.sA, vm), c = P.pt(st.sB, vm), w = Math.hypot(c[0] - a[0], c[1] - a[1]) * 0.98;
      const m = this.normalM(st.s, vm);
      const solid = st.floor === 0, hh = solid ? st.top - this.lv[0] + 0.02 : 0.34;
      b.stone.box(w, hh, st.v1 - st.v0 + 0.02, m.clone().multiply(M(0, st.top - hh / 2, 0)), C.step, [st.top, 0]);
      const dir = st.flight === 0 ? 1 : -1; // front edge (nosing) side in local z
      b.stone.box(w + 0.02, 0.05, 0.06, m.clone().multiply(M(0, st.top - 0.025, dir * ((st.v1 - st.v0) / 2 + 0.01))), col("#b9a98a"));
    }
    for (const fl of lay.flights) {
      const run = Math.abs(fl.vTop - fl.vBot), rise = fl.yTop - fl.yBot, vm = (fl.vBot + fl.vTop) / 2;
      const a = P.pt(fl.sA, vm), c = P.pt(fl.sB, vm), w = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const m = this.normalM(fl.s, vm);
      const pitch = fl.flight === 0 ? -Math.atan2(rise, run) : Math.atan2(rise, run), len = Math.hypot(run, rise);
      if (fl.floor > 0) b.plaster.box(w * 0.98, 0.14, len, m.clone().multiply(M(0, (fl.yBot + fl.yTop) / 2 - 0.36, 0, 0, pitch)), C.ceil);
      // handrails on both sides
      for (const sx of [-1, 1]) {
        b.metal.add(cylGeo(0.03, 0.03, len, 8), m.clone().multiply(M(sx * (w / 2 - 0.08), (fl.yBot + fl.yTop) / 2 + 0.9, 0, 0, pitch + PI / 2)), col("#6d5a3e"));
        for (const t of [0.1, 0.9]) {
          const zz = (fl.flight === 0 ? 1 : -1) * (t - 0.5) * run, yy = fl.yBot + t * rise;
          b.metal.add(cylGeo(0.02, 0.02, 0.9, 6), m.clone().multiply(M(sx * (w / 2 - 0.08), yy + 0.45, zz)), col("#6d5a3e"));
        }
      }
    }
    for (const l of lay.landings) {
      const c = chordAt(P, l.s0, l.s1, (l.v0 + l.v1) / 2), m = this.chordM(c, l.top);
      const d = l.v1 - l.v0;
      if (l.floor === 0) b.stone.box(c.len, l.top - this.lv[0] + 0.02, d, m.clone().multiply(M(c.len / 2, -(l.top - this.lv[0]) / 2 + 0.01, 0)), C.step);
      else { b.stone.box(c.len, 0.06, d, m.clone().multiply(M(c.len / 2, -0.03, 0)), C.step); b.plaster.box(c.len, 0.22, d, m.clone().multiply(M(c.len / 2, -0.17, 0)), C.ceil); }
    }
  }

  // ---------- ground-floor columns
  columns() {
    const { b, C, P } = this;
    for (const c of this.lay.columns) {
      const hh = c.y1 - c.y0, r = c.r;
      const prof: P2[] = [[0, 0], [r + 0.12, 0], [r + 0.12, 0.2], [r + 0.04, 0.28], [r, 0.36], [r * 0.9, hh - 0.5], [r + 0.02, hh - 0.42], [r + 0.14, hh - 0.26], [r + 0.2, hh - 0.2], [r + 0.2, hh], [0, hh]];
      const [x, z] = P.pt(c.s, c.v);
      b.trim.add(latheGeo(prof, 14), M(x, c.y0, z), C.cream, this.baseAO);
    }
  }

  // ---------- furniture + dressing (detail bins: drawn only near the hotel)
  props() {
    const { C, P } = this, b = this.n;
    const bb = (bin: Bin, w: number, h: number, d: number, m: THREE.Matrix4, c: THREE.Color, bev = 0.03) => bin.add(chamferBoxGeo(w, h, d, bev), m, c);
    for (const p of this.lay.props) {
      const m = this.normalM(p.s, p.v, p.y, p.rot);
      const rs = mulberry(Math.floor(p.seed * 1e6) + 7);
      switch (p.kind) {
        case "bed": {
          const hx = (p.s < this.lay.bays[p.bay].sm ? -1 : 1) * (p.w / 2 - 0.25);
          bb(b.woodDark, p.w, 0.28, p.d, m.clone().multiply(M(0, 0.16, 0)), col("#6a4526"), 0.03);
          for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) bb(b.woodDark, 0.08, 0.14, 0.08, m.clone().multiply(M(x * (p.w / 2 - 0.06), 0.02, z * (p.d / 2 - 0.06))), col("#4d321b"), 0.015);
          bb(b.fabric, p.w - 0.08, 0.22, p.d - 0.06, m.clone().multiply(M(0.02, 0.41, 0)), col(["#f4efe4", "#ece2cc", "#e4ece8"][Math.floor(rs() * 3)]), 0.07);
          bb(b.fabric, p.w * 0.58, 0.07, p.d + 0.04, m.clone().multiply(M(-hx * 0.28, 0.53, 0)), col(["#d56a4e", "#3f8f86", "#e0b24a", "#6c8ec2"][Math.floor(rs() * 4)]), 0.03);
          for (const z of [-0.36, 0.36]) bb(b.fabric, 0.36, 0.15, 0.58, m.clone().multiply(M(hx, 0.6, z, 0, 0, 0.12 * Math.sign(hx))), col("#fbf7ee"), 0.07);
          // headboard: framed rattan panel
          bb(b.woodDark, 0.09, 1.05, p.d + 0.14, m.clone().multiply(M(hx + Math.sign(hx) * 0.3, 0.55, 0)), col("#5b3b20"), 0.025);
          bb(b.wood, 0.05, 0.62, p.d - 0.1, m.clone().multiply(M(hx + Math.sign(hx) * 0.26, 0.7, 0)), col("#c8a56a"), 0.015);
          // bedside table + lamp
          const nt = m.clone().multiply(M(hx, 0, -p.d / 2 - 0.35));
          bb(b.wood, 0.45, 0.55, 0.4, nt.clone().multiply(M(0, 0.275, 0)), col("#a8764a"), 0.02);
          b.stone.add(latheGeo([[0, 0], [0.08, 0], [0.1, 0.12], [0.05, 0.22], [0, 0.22]], 10), nt.clone().multiply(M(0, 0.55, 0)), col("#6fa8a0"));
          b.fabric.add(latheGeo([[0.07, 0.22], [0.15, 0.22], [0.12, 0.42], [0.07, 0.42]], 12), nt.clone().multiply(M(0, 0.55, 0)), col("#f3e6c8"));
          b.bulb.add(new THREE.SphereGeometry(0.05, 8, 6), nt.clone().multiply(M(0, 0.86, 0)), 0xffffff);
          // picture over the bed
          bb(b.woodDark, 0.04, 0.6, 0.9, m.clone().multiply(M(hx + Math.sign(hx) * 0.36, 1.6, 0)), col("#5b3b20"), 0.01);
          b.fabric.box(0.02, 0.48, 0.78, m.clone().multiply(M(hx + Math.sign(hx) * 0.335, 1.6, 0)), col(["#4fa3c8", "#e89a5a", "#6ab06a"][Math.floor(rs() * 3)]));
          break;
        }
        case "wardrobe": {
          bb(b.wood, p.w, p.h, p.d, m.clone().multiply(M(0, p.h / 2 + 0.06, 0)), col("#9a6a40"), 0.03);
          bb(b.woodDark, p.w + 0.06, 0.08, p.d + 0.06, m.clone().multiply(M(0, p.h + 0.1, 0)), col("#6e4a2a"), 0.02);
          for (const sx of [-1, 1]) {
            bb(b.wood, p.w / 2 - 0.14, p.h - 0.5, 0.03, m.clone().multiply(M(sx * p.w / 4, p.h / 2 + 0.1, p.d / 2 + 0.01)), col("#a87a4c"), 0.012);
            b.metal.add(new THREE.SphereGeometry(0.025, 6, 4), m.clone().multiply(M(sx * 0.07, p.h / 2 + 0.1, p.d / 2 + 0.04)), col("#c9a54a"));
          }
          break;
        }
        case "dresser": {
          bb(b.wood, p.w, p.h, p.d, m.clone().multiply(M(0, p.h / 2, 0)), col("#a8764a"), 0.025);
          for (let k = 0; k < 3; k++) { bb(b.wood, 0.03, 0.2, p.d - 0.12, m.clone().multiply(M(p.w / 2 + 0.01, 0.2 + k * 0.24, 0)), col("#b8865a"), 0.01); b.metal.add(new THREE.SphereGeometry(0.02, 6, 4), m.clone().multiply(M(p.w / 2 + 0.035, 0.2 + k * 0.24, 0)), col("#c9a54a")); }
          this.pot(m.clone().multiply(M(0, p.h, 0.25)), 0.16);
          // (a silvered MIRROR, not a window pane — drawn as glass it read as an unbreakable window on a
          //  solid wall in every guest room)
          b.metal.add(new THREE.PlaneGeometry(0.7, 0.9), m.clone().multiply(M(-p.w / 2 + 0.01, p.h + 0.75, 0, -PI / 2)), col("#c9d6d8"));
          break;
        }
        case "table": {
          const r = p.w / 2;
          b.wood.add(latheGeo([[0, 0], [r, 0], [r + 0.02, 0.025], [r, 0.05], [0, 0.05]], 18), m.clone().multiply(M(0, p.h - 0.05, 0)), col(p.floor === 0 ? "#c09a62" : "#b48456"));
          b.woodDark.add(cylGeo(0.045, 0.05, p.h - 0.05, 8), m.clone().multiply(M(0, (p.h - 0.05) / 2, 0)), col("#4d321b"));
          b.woodDark.add(cylGeo(0.25, 0.28, 0.04, 14), m.clone().multiply(M(0, 0.02, 0)), col("#4d321b"));
          if (p.floor > 0) for (const sx of [-1, 1]) this.chair(m.clone().multiply(M(sx * (r + 0.3), 0, 0, sx * PI / 2)));
          else { b.glass.add(cylGeo(0.05, 0.04, 0.12, 10), m.clone().multiply(M(0.1, p.h + 0.06, 0.05)), col("#c8e8e0")); this.pot(m.clone().multiply(M(-0.2, p.h, -0.1)), 0.12); }
          break;
        }
        case "desk": {
          // reception: cream panelled counter, dark wood top, brass bell, key rack + mail slots on the wall behind
          b.trim.add(barGeo(p.w, p.h, p.d, 0.08), m.clone().multiply(M(0, p.h / 2, 0)), C.cream);
          for (let k = 0; k < 4; k++) b.plaster.add(chamferBoxGeo(p.w / 4 - 0.18, p.h - 0.35, 0.04, 0.015), m.clone().multiply(M(-p.w / 2 + (k + 0.5) * p.w / 4, p.h / 2, p.d / 2 + 0.02)), C.pink);
          bb(b.wood, p.w + 0.12, 0.07, p.d + 0.2, m.clone().multiply(M(0, p.h + 0.035, 0)), col("#6e4426"), 0.02);
          b.metal.add(latheGeo([[0, 0], [0.07, 0], [0.065, 0.03], [0.02, 0.07], [0.008, 0.1], [0, 0.1]], 12), m.clone().multiply(M(0.5, p.h + 0.07, 0.15)), col("#d9b04a"));
          const wall = m.clone().multiply(M(0, 0, -1.9));
          bb(b.woodDark, 2.0, 1.2, 0.08, wall.clone().multiply(M(0, 1.9, 0)), col("#5b3b20"), 0.02);
          for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) { b.woodDark.box(0.2, 0.3, 0.1, wall.clone().multiply(M(-0.8 + c * 0.23, 1.55 + r * 0.33, 0.06)), col("#4a3018")); if ((r + c) % 3) b.metal.add(new THREE.SphereGeometry(0.02, 5, 4), wall.clone().multiply(M(-0.8 + c * 0.23, 1.48 + r * 0.33, 0.1)), col("#d9b04a")); }
          b.bulb.add(new THREE.SphereGeometry(0.12, 12, 8), m.clone().multiply(M(-p.w / 2 + 0.3, p.h + 0.4, 0)), 0xffffff);
          b.fabric.add(latheGeo([[0.1, 0.25], [0.2, 0.25], [0.16, 0.42], [0.09, 0.42]], 14), m.clone().multiply(M(-p.w / 2 + 0.3, p.h + 0.2, 0)), col("#f3e6c8"));
          b.metal.add(cylGeo(0.02, 0.1, 0.3, 8), m.clone().multiply(M(-p.w / 2 + 0.3, p.h + 0.15, 0)), col("#b08a3a"));
          this.pot(m.clone().multiply(M(p.w / 2 + 0.7, 0, 0.4)), 0.46, true);
          break;
        }
        case "sofa": case "armchair": {
          // rattan frame (woven tone) + plump cushions
          const cc = col(p.kind === "sofa" ? ["#3f8f86", "#d0654a", "#e2b04e"][Math.floor(rs() * 3)] : ["#f0e3c8", "#3f8f86", "#d0654a"][Math.floor(rs() * 3)]);
          const ratt = col("#b98e55");
          bb(b.wood, p.w, 0.36, p.d, m.clone().multiply(M(0, 0.22, 0)), ratt, 0.06);
          bb(b.wood, p.w, 0.52, 0.16, m.clone().multiply(M(0, 0.62, -p.d / 2 + 0.08)), ratt.clone().multiplyScalar(0.94), 0.06);
          for (const sx of [-1, 1]) bb(b.wood, 0.16, 0.3, p.d, m.clone().multiply(M(sx * (p.w / 2 - 0.08), 0.52, 0)), ratt.clone().multiplyScalar(0.96), 0.06);
          for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.woodDark.add(cylGeo(0.025, 0.02, 0.06, 6), m.clone().multiply(M(x * (p.w / 2 - 0.08), 0.02, z * (p.d / 2 - 0.08))), col("#4d321b"));
          const nC = p.kind === "sofa" ? 2 : 1, cw = (p.w - 0.36) / nC;
          for (let k = 0; k < nC; k++) {
            const x = -p.w / 2 + 0.18 + cw * (k + 0.5);
            bb(b.fabric, cw - 0.03, 0.16, p.d - 0.24, m.clone().multiply(M(x, 0.47, 0.04)), cc, 0.07);
            bb(b.fabric, cw - 0.06, 0.42, 0.14, m.clone().multiply(M(x, 0.72, -p.d / 2 + 0.22, 0, -0.18)), cc.clone().multiplyScalar(0.94), 0.07);
          }
          if (p.kind === "sofa") bb(b.fabric, 0.36, 0.3, 0.12, m.clone().multiply(M(-p.w / 2 + 0.4, 0.68, -p.d / 2 + 0.34, 0.3, -0.3)), col("#f2c14a"), 0.06);
          break;
        }
        case "planter": this.pot(m, 0.55, true); break;
        case "bench":
          bb(b.wood, p.w, 0.07, p.d, m.clone().multiply(M(0, 0.46, 0)), col("#9a6a40"), 0.02);
          for (const sx of [-1, 1]) bb(b.metal, 0.07, 0.44, p.d, m.clone().multiply(M(sx * (p.w / 2 - 0.15), 0.22, 0)), col("#3b3f3a"), 0.015);
          break;
        case "roofPlanter": this.roofPlanter(m, p.w, p.d, p.h, rs); break;
      }
    }
    // lobby rugs (bordered) + ceiling fans + pendant lamps; room ceiling lamps upstairs
    for (const bay of this.lay.bays) {
      if (bay.core >= 0) continue;
      const m = this.normalM(bay.sm, 6.6, this.lv[0]);
      const ceil = this.lv[1] - this.lv[0] - HS.slabT;
      if (bay.i % 3 === 0) {
        const k = (bay.i / 3) % 3;
        b.fabric.box(3.0, 0.02, 3.6, m.clone().multiply(M(0, 0.012, 0)), col(["#8a3a2c", "#1f5f5a", "#8a6428"][k]));
        b.fabric.box(2.6, 0.02, 3.2, m.clone().multiply(M(0, 0.02, 0)), col(["#d0654a", "#3f8f86", "#e2b04e"][k]));
        b.fabric.box(1.4, 0.02, 2.0, m.clone().multiply(M(0, 0.026, 0)), col("#f0e3c8"));
      }
      if (bay.i % 2 === 0) {
        // ceiling fan: motor + 4 rattan blades
        const fm = m.clone().multiply(M(0, ceil - 0.5, 0, bay.i * 0.4));
        b.metal.add(cylGeo(0.012, 0.012, 0.4, 5), m.clone().multiply(M(0, ceil - 0.2, 0)), col("#3a3530"));
        b.metal.add(latheGeo([[0, 0], [0.14, 0], [0.16, 0.06], [0.1, 0.14], [0, 0.16]], 12), fm, col("#6b5a3e"));
        for (let k = 0; k < 4; k++) bb(b.wood, 0.62, 0.015, 0.14, fm.clone().multiply(M(0, 0.04, 0, k * PI / 2)).multiply(M(0.42, 0, 0, 0, 0, 0.06)), col("#b98e55"), 0.006);
      } else {
        b.bulb.add(new THREE.SphereGeometry(0.16, 12, 8), m.clone().multiply(M(0, ceil - 0.55, 0)), 0xffffff);
        b.metal.add(cylGeo(0.012, 0.012, 0.4, 5), m.clone().multiply(M(0, ceil - 0.25, 0)), col("#3a3530"));
      }
      for (let f = 1; f < this.h.floors; f++) b.bulb.add(new THREE.SphereGeometry(0.09, 10, 6), this.normalM(bay.sm, 6.5, this.lv[f + 1] - HS.slabT - 0.12), 0xffffff);
    }
    void P;
  }
  chair(m: THREE.Matrix4) {
    const b = this.n, c = col("#e9e1cf");
    b.wood.add(chamferBoxGeo(0.42, 0.05, 0.42, 0.012), m.clone().multiply(M(0, 0.45, 0)), c);
    b.wood.add(chamferBoxGeo(0.42, 0.45, 0.05, 0.012), m.clone().multiply(M(0, 0.7, -0.2)), c);
    for (const [x, z] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) b.metal.add(cylGeo(0.02, 0.02, 0.45, 5), m.clone().multiply(M(x, 0.22, z)), col("#3b3f3a"));
  }
  bistro(m: THREE.Matrix4, u: number, z: number) {
    const mm = m.clone().multiply(M(u, 0, z));
    this.n.metal.add(cylGeo(0.3, 0.3, 0.03, 14), mm.clone().multiply(M(0, 0.72, 0)), col("#e8e2d2"));
    this.n.metal.add(cylGeo(0.025, 0.025, 0.72, 6), mm.clone().multiply(M(0, 0.36, 0)), col("#3b3f3a"));
    for (const sx of [-1, 1]) this.chair(mm.clone().multiply(M(sx * 0.62, 0, 0.05, -sx * PI / 2)));
  }
  pot(m: THREE.Matrix4, s: number, big = false) {
    const b = this.n;
    b.stone.add(latheGeo([[0, 0], [s * 0.62, 0], [s * 0.78, s * 0.9], [s * 0.86, s * 0.92], [s * 0.86, s * 1.02], [0, s * 1.02]], 14), m, col(["#b8674a", "#c9a27a", "#8b6a4a"][Math.floor(this.r(0, 3))]));
    const n = big ? 11 : 7, bat = this.vines;
    b.leaf.add(leafClumpGeo(Math.floor(this.r(0, 4))), m.clone().multiply(M(0, s * 0.95, 0, this.r(0, 6), 0, 0, s * 0.8, s * 0.6, s * 0.8)), col("#4a8c33"));
    const base = new THREE.Vector3(0, s * 1.0, 0).applyMatrix4(m);
    for (let i = 0; i < n; i++) {
      const a = this.r(0, TAU), up = this.r(0.35, 1.0), len = s * this.r(1.6, big ? 3.6 : 2.4);
      const dir = new THREE.Vector3(Math.cos(a), up, Math.sin(a));
      bat.leaf(leafMatrix(base, dir, len, len * 0.42, this.r(-0.4, 0.4)), col(this.rnd() < 0.5 ? "#3f8f2f" : "#5aa63a"));
    }
  }
  roofPlanter(m: THREE.Matrix4, w: number, d: number, hh: number, rs: () => number) {
    const { b, C } = this;
    b.trim.add(barGeo(w, hh, d, 0.06), m.clone().multiply(M(0, hh / 2, 0)), C.creamD, this.baseAO);
    b.sand.box(w - 0.16, 0.05, d - 0.16, m.clone().multiply(M(0, hh - 0.06, 0)), col("#5b4630"));
    const n = 3 + Math.floor(rs() * 3);
    for (let i = 0; i < n; i++) { const k = this.r(0.4, 0.6); b.leaf.add(leafClumpGeo(i % 4), m.clone().multiply(M(-w / 2 + 0.3 + (w - 0.6) * (i + 0.5) / n, hh - 0.05, this.r(-0.15, 0.15), this.r(0, 6), 0, 0, k, k * 0.8, k)), col(["#4a8c33", "#5a9a3a", "#3f7f2e"][i % 3])); }
    const base = new THREE.Vector3(0, hh, 0).applyMatrix4(m);
    const tall = rs() < 0.45;
    for (let i = 0; i < (tall ? 12 : 8); i++) {
      const a = this.r(0, TAU), len = this.r(0.8, tall ? 2.0 : 1.3);
      this.vines.leaf(leafMatrix(base.clone().add(new THREE.Vector3(this.r(-w / 3, w / 3), tall ? 0.9 : 0.2, 0).applyMatrix4(new THREE.Matrix4().extractRotation(m))), new THREE.Vector3(Math.cos(a), this.r(0.3, 1.1), Math.sin(a)), len, len * 0.4, this.r(-0.5, 0.5)), col(this.rnd() < 0.5 ? "#3f8f2f" : "#63ad3c"));
    }
    if (tall) b.woodDark.add(cylGeo(0.06, 0.09, 1.0, 6), m.clone().multiply(M(0, hh + 0.5, 0)), col("#6a5236"));
  }

  // ---------- roof: bulkhead dressing, pavilion + banana sculpture, AC units
  roof() {
    const { b, C, P, lay } = this;
    for (const c of lay.cores) {
      // cornice band round the bulkhead + a door leaf
      const ch = chordAt(P, c.s0, c.s1, (HS.roomFront + HS.bulkBack) / 2), m = this.chordM(ch, lay.roof);
      const d = HS.bulkBack - HS.roomFront;
      b.trim.add(barGeo(ch.len + 0.3, 0.22, d + 0.3, 0.05), m.clone().multiply(M(ch.len / 2, HS.bulkH - 0.05, 0)), C.cream);
      const back = lay.walls.find((w) => w.kind === "bulkhead" && w.axis === "s" && w.bay === c.bay && w.v0 > 5);
      if (back) {
        const bc = wallChord(P, back), bm = this.chordM(bc, lay.roof), op = back.openings[0];
        this.doorTrim(bm, op.u, op.w, op.h, -0.1, -1);
        this.doorLeaf(bm, op.u, op.w, op.h, -0.1, -1, 70, C.green);
      }
    }
    // AC units + vents near the back parapet
    for (let k = 2; k < lay.nBays; k += 5) {
      const bay = lay.bays[k]; if (bay.core >= 0 || (bay.s1 > lay.pavilion.s0 - 1 && bay.s0 < lay.pavilion.s1 + 1)) continue;
      const m = this.normalM(bay.sm, this.D - 2.2, lay.roof);
      b.metal.box(1.1, 0.8, 0.7, m.clone().multiply(M(0, 0.4, 0)), col("#c9ccc8"));
      b.louvre.add(new THREE.BoxGeometry(0.9, 0.6, 0.02), m.clone().multiply(M(0, 0.42, 0.36)), col("#9aa0a6"));
      b.metal.add(cylGeo(0.12, 0.12, 0.8, 10), m.clone().multiply(M(1.4, 0.4, -0.5)), col("#9aa0a6"));
    }
    this.pavilion();
  }

  pavilion() {
    const { b, C, P, lay } = this, pv = lay.pavilion;
    const ch = chordAt(P, pv.s0, pv.s1, (pv.v0 + pv.v1) / 2), W = ch.len, Dp = pv.v1 - pv.v0, H = pv.h;
    const m = this.chordM(ch, pv.y).multiply(M(W / 2, 0, 0)); // centred: x along, z front
    // walls (pink box) with windows + cream corner piers
    const faces: Array<[number, number, number, number]> = [[0, Dp / 2, 0, W], [0, -Dp / 2, PI, W], [W / 2, 0, PI / 2, Dp], [-W / 2, 0, -PI / 2, Dp]];
    for (const [x, z, yaw, len] of faces) {
      const fm = m.clone().multiply(M(x, 0, z, yaw)).multiply(M(-len / 2, 0, -0.15));
      const ops: Op[] = [];
      const nW = Math.max(1, Math.round(len / 3.2));
      for (let i = 0; i < nW; i++) ops.push({ t: "rect", u: len * (i + 0.5) / nW - 0.45, y: 1.1, w: 0.9, h: 1.3 });
      this.planar(fm, len, H, 0.3, ops, b.plaster, C.pink, b.trim, C.creamD, C.pinkIn, this.baseAO);
      // (the pavilion is a solid block — its windows are CLOSED louvred shutters, not glass you cannot break)
      for (const o of ops) if (o.t === "rect") { this.windowTrim(fm, o.u, o.y, o.w, o.h, 0.15, 1, false, true); }
      this.decal(fm.clone().multiply(M(len / 2, H - 0.8, 0.162)), len - 1, 1.3, 1);
    }
    b.plaster.box(W - 0.4, H - 0.1, Dp - 0.4, m.clone().multiply(M(0, H / 2, 0)), C.pinkIn);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.trim.add(chamferBoxGeo(0.7, H + 0.1, 0.7, 0.07), m.clone().multiply(M(sx * (W / 2 - 0.15), H / 2, sz * (Dp / 2 - 0.15))), C.cream, this.baseAO);
    // cornice with corbels + parapet top
    const lf = (x0: number, z0: number, x1: number, z1: number, o0: P2, o1: P2) => { const a = new THREE.Vector3(x0, 0, z0).applyMatrix4(m), c = new THREE.Vector3(x1, 0, z1).applyMatrix4(m); const r = new THREE.Matrix4().extractRotation(m); const oa = new THREE.Vector3(o0[0], 0, o0[1]).applyMatrix4(r), oc = new THREE.Vector3(o1[0], 0, o1[1]).applyMatrix4(r); return lineFrames(a.x, a.z, c.x, c.z, pv.y + H, [oa.x, oa.z], [oc.x, oc.z]); };
    const hw = W / 2, hd = Dp / 2, k = Math.SQRT2;
    const CORN: P2[] = [[-0.05, -0.45], [0.08, -0.45], [0.08, -0.45], [0.2, -0.36], [0.3, -0.2], [0.34, -0.02], [0.3, 0.1], [0.3, 0.1], [0.3, 0.48], [0.3, 0.48], [0.36, 0.52], [0.34, 0.6], [0.34, 0.6], [-0.2, 0.6], [-0.2, 0.6], [-0.2, 0.1]];
    for (const fr of [lf(-hw, hd, hw, hd, [-k / 2, k / 2], [k / 2, k / 2]), lf(hw, hd, hw, -hd, [k / 2, k / 2], [k / 2, -k / 2]), lf(hw, -hd, -hw, -hd, [k / 2, -k / 2], [-k / 2, -k / 2]), lf(-hw, -hd, -hw, hd, [-k / 2, -k / 2], [-k / 2, k / 2])])
      b.trim.add(sweepGeo(CORN, fr), null, C.cream);
    b.plaster.box(W - 0.3, 0.1, Dp - 0.3, m.clone().multiply(M(0, H + 0.5, 0)), C.roof);
    for (let i = 0; i < Math.round(W / 0.9); i++) for (const sz of [-1, 1]) b.trim.box(0.16, 0.26, 0.2, m.clone().multiply(M(-W / 2 + 0.45 + i * 0.9, H - 0.58, sz * (Dp / 2 + 0.08))), C.creamD);
    // a stone stair up the east face: pink risers, cream nosed treads,
    // the landing level with the top — the SAME boxes the server collides with (shared pavStair)
    const pf = pavFrame(lay);
    for (const [x0, z0, x1, z1, y1] of pavStair(pf)) {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      b.plaster.box(x1 - x0, y1, z1 - z0, m.clone().multiply(M(cx, y1 / 2, cz)), C.pink, this.uvo(), this.baseAO);
      b.trim.add(chamferBoxGeo(x1 - x0 + 0.04, 0.05, z1 - z0 + 0.03, 0.015), m.clone().multiply(M(cx, y1 - 0.02, cz + 0.015)), C.cream);
    }
    // banana plinth + the bunch
    const top = H + 0.55;
    b.trim.add(barGeo(W - 2.4, 0.55, 3.8, 0.1), m.clone().multiply(M(0.3, H + 0.3 + 0.275 - 0.02, 0)), C.cream);
    b.trim.add(barGeo(W - 2.9, 0.12, 3.3, 0.05), m.clone().multiply(M(0.3, top + 0.35, 0)), C.creamD);
    const yellow = col("#f3c52f");
    let base = m.clone().multiply(M(0, top + 0.35, 0));
    // turn the bunch so its broad side faces the view camera (o.sculptureFace, world xz)
    if (this.o.sculptureFace) {
      const lp = new THREE.Vector3(this.o.sculptureFace[0], base.elements[13], this.o.sculptureFace[1]).applyMatrix4(base.clone().invert());
      base = base.clone().multiply(M(0, 0, 0, Math.atan2(lp.x, lp.z)));
    }
    // the BUNCH (the landmark): THREE huge fat curved bananas leaning together on the plinth — one standing
    // tall at the back (stem up), two lying across it curving up to the right — each with a square-cut brown-green stem
    // cap and a dark blossom tip; saturated #f5c518 with a green blush toward the stems (9 upright fingers read as
    // a tulip). Chord / bulge frames in the pavilion frame (x along the facade, +z out of it toward the pool).
    const bn = (P0: [number, number, number], D0: [number, number, number], U0: [number, number, number], len: number, r: number, bend: number, tint: number) => {
      const D = new THREE.Vector3(...D0).normalize(), U = new THREE.Vector3(...U0);
      U.addScaledVector(D, -U.dot(D)).normalize();
      const Z = new THREE.Vector3().crossVectors(D, U);
      const basis = new THREE.Matrix4().makeBasis(D, U, Z).setPosition(P0[0], P0[1], P0[2]);
      const g = bananaGeo(len, r, bend, col("#ffe04a").multiplyScalar(tint * 1.08));
      const mm = base.clone().multiply(basis);
      b.fruit.add(g.body, mm, 0xffffff);
      // stem: a short square-cut neck + cap along the stem-end tangent
      const tq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), g.tipDir.clone().normalize());
      const neck = mm.clone().multiply(new THREE.Matrix4().compose(g.tip, tq, new THREE.Vector3(1, 1, 1)));
      b.fruit.add(chamferBoxGeo(0.55, r * 0.62, r * 0.62, 0.06), neck.clone().multiply(M(0.22, 0, 0)), col("#9aa33a"));
      b.woodDark.add(chamferBoxGeo(0.22, r * 0.7, r * 0.7, 0.05), neck.clone().multiply(M(0.55, 0, 0, 0, 0, 0.12)), col("#6b5a2c"));
    };
    for (const [P0, D0, U0, len, r, bend, tint] of BANANAS) bn(P0, D0, U0, len, r, bend, tint);
    // a green crown knot where the three blossom ends meet
    b.fruit.add(new THREE.SphereGeometry(0.62, 12, 9), base.clone().multiply(M(-1.2, 0.35, 0.3, 0, 0, 0, 1.2, 0.7, 1.1)), col("#7d8a2e"));
    // vines spilling off the pavilion cornice
    this.vineCurtain(m.clone().multiply(M(-W / 2, 0, Dp / 2)), 1.2, H + 0.5, 0.35, 2.4);
  }

  // ---------- vines + creepers (leaf batch)
  /** a cluster of hanging strands from (u, y) in a wall frame m, draping over whatever sits below */
  vineCurtain(m: THREE.Matrix4, u: number, y: number, z: number, drop: number) {
    const { b } = this;
    const nS = 3 + Math.floor(this.r(0, 4));
    // leafy clump at the anchor
    for (let i = 0; i < 2; i++) { const k = this.r(0.35, 0.5); b.leaf.add(leafClumpGeo(i + 2), m.clone().multiply(M(u + this.r(-0.5, 0.5), y - 0.05, z + this.r(-0.1, 0.15), this.r(0, 6), 0, 0, k * 1.2, k * 0.7, k)), col(["#4a8c33", "#3f7f2e"][i])); }
    for (let k = 0; k < nS; k++) {
      const uu = u + this.r(-0.7, 0.7), dd = drop * this.r(0.45, 1.0), out = this.r(0.45, 0.62);
      const pts = [new THREE.Vector3(uu, y, z), new THREE.Vector3(uu + this.r(-0.1, 0.1), y - 0.25, z + out), new THREE.Vector3(uu + this.r(-0.2, 0.2), y - 0.9, z + out * 0.95), new THREE.Vector3(uu + this.r(-0.3, 0.3), y - dd, z + out * 0.8 + this.r(0, 0.2))];
      this.strand(m, pts, true);
    }
  }
  /** a creeper climbing (up = true) or hanging from (u, y0) over the face at z */
  creeper(m: THREE.Matrix4, u: number, z: number, y0: number, len: number, hanging: boolean, yAbs?: number) {
    const y = yAbs !== undefined ? 0 : y0;
    void yAbs;
    const dir = hanging ? -1 : 1, pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 4; i++) pts.push(new THREE.Vector3(u + Math.sin(i * 1.7 + u) * 0.25, y + dir * len * i / 4, z + 0.06 + (hanging && i === 0 ? 0.3 : 0)));
    this.strand(m, pts, hanging, 1.4);
    if (!hanging) this.strand(m, pts.map((p, i) => p.clone().add(new THREE.Vector3(0.3 * Math.sin(i * 2.3), -0.2 * i, 0))).slice(0, 4), false, 1.2);
  }
  strand(m: THREE.Matrix4, pts: THREE.Vector3[], hanging: boolean, spread = 1) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => p.clone().applyMatrix4(m)));
    const L = curve.getLength(), n = Math.max(3, Math.floor(L / 0.09));
    const rot = new THREE.Matrix4().extractRotation(m), outW = new THREE.Vector3(0, 0, 1).applyMatrix4(rot), sideW = new THREE.Vector3(1, 0, 0).applyMatrix4(rot);
    const greens = ["#3f8f2f", "#4f9a36", "#2f6a28", "#5ea83b", "#37762c"];
    for (let i = 0; i <= n; i++) {
      const t = i / n, p = curve.getPointAt(t), taper = hanging ? 1 - 0.55 * t : 0.6 + 0.4 * (1 - t);
      for (let k = 0; k < 2; k++) {
        const side = (k === 0 ? 1 : -1) * this.r(0.3, 1.0) * spread;
        const dir = outW.clone().multiplyScalar(this.r(0.5, 1.0)).addScaledVector(sideW, side).add(new THREE.Vector3(0, hanging ? this.r(-1.0, -0.2) : this.r(-0.2, 0.7), 0));
        const len = this.r(0.14, 0.26) * taper * spread;
        const flower = this.rnd() < 0.025;
        this.vines.leaf(leafMatrix(p, dir, len, len * 0.7, this.r(-0.8, 0.8)), col(flower ? (this.rnd() < 0.5 ? "#f08a3a" : "#f2d24a") : greens[Math.floor(this.r(0, greens.length))], this.r(0.85, 1.1)));
      }
    }
  }
  /** vines spilling over the cornice + clumps on the parapet */
  roofVines() {
    const { lay, P, D } = this;
    for (const bay of lay.bays) {
      if (this.rnd() > (bay.porthole ? 0.6 : 0.3)) continue;
      const c = chordAt(P, bay.s0, bay.s1, 0), m = this.chordM(c, lay.roof);
      this.vineCurtain(m, this.r(0.8, c.len - 0.8), 1.25, 0.1, this.r(1.8, bay.porthole ? 5.5 : 3.8));
    }
    // west end cornice
    const f0 = P.at(0), [px, pz] = P.pt(0, D);
    const m = M(px, lay.roof, pz, Math.atan2(f0.n[1], -f0.n[0]));
    for (const u of [3.5, 8.8]) this.vineCurtain(m, u, 1.25, 0.1, this.r(3, 5.5));
  }

  // ---------- paved apron along the facade + base dressing
  apron() {
    const { b, P, lay, h } = this, n = Math.ceil(lay.L / 2);
    const outer: P2[] = [], inner: P2[] = [];
    for (let i = 0; i <= n; i++) { const s = lay.L * i / n; inner.push(P.pt(s, 0.1)); outer.push(P.pt(s, -3.2)); }
    const e0 = P.at(0), eL = P.at(lay.L);
    outer.unshift([P.pt(0, -3.2)[0] - e0.d[0] * 3.2, P.pt(0, -3.2)[1] - e0.d[1] * 3.2]);
    outer.push([P.pt(lay.L, -3.2)[0] + eL.d[0] * 3.2, P.pt(lay.L, -3.2)[1] + eL.d[1] * 3.2]);
    inner.unshift([P.pt(0, 0.1)[0] - e0.d[0] * 3.2, P.pt(0, 0.1)[1] - e0.d[1] * 3.2]);
    inner.push([P.pt(lay.L, 0.1)[0] + eL.d[0] * 3.2, P.pt(lay.L, 0.1)[1] + eL.d[1] * 3.2]);
    b.paving.add(prismGeo([...outer, ...inner.reverse()], h.y - 0.3, h.y + 0.09, 1), null, col("#d6c5a3"));
    // kerb
    const kerb: SF[] = outer.map((p, i) => { const q = outer[Math.min(outer.length - 1, i + 1)], r = outer[Math.max(0, i - 1)]; let dx = q[0] - r[0], dz = q[1] - r[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; return { p: new THREE.Vector3(p[0], h.y, p[1]), a: new THREE.Vector3(-dz, 0, dx), b: UP, u: i * 2 }; });
    b.stone.add(sweepGeo([[-0.3, -0.1], [0.02, -0.1], [0.02, 0.12], [0.02, 0.12], [-0.3, 0.12]], kerb), null, col("#c9b995"));
    // clumps of greenery at the base of some piers
    for (let k = 1; k < lay.nBays; k++) if (this.rnd() < 0.45) {
      const m = this.normalM(k * lay.bw + this.r(-0.3, 0.3), -0.9, h.y + 0.05);
      for (let i = 0; i < 3; i++) { const k = this.r(0.4, 0.62); b.leaf.add(leafClumpGeo(i), m.clone().multiply(M(this.r(-0.6, 0.6), 0.02, this.r(-0.3, 0.3), this.r(0, 6), 0, 0, k * 1.2, k * 0.8, k)), col(["#4a8c33", "#5a9a3a", "#3f7f2e"][i])); }
      const base = new THREE.Vector3(0, 0.1, 0).applyMatrix4(m);
      for (let i = 0; i < 7; i++) { const a = this.r(0, TAU), len = this.r(0.4, 0.8); this.vines.leaf(leafMatrix(base, new THREE.Vector3(Math.cos(a), this.r(0.4, 1.0), Math.sin(a)), len, len * 0.4, this.r(-0.5, 0.5)), col(this.rnd() < 0.5 ? "#3f8f2f" : "#5aa63a")); }
    }
  }

  finish() {
    this.vines.flush(this.b.leaf);
    if (this.grime && this.grime.count) {
      const mesh = this.grime.build();
      if (mesh) { mesh.renderOrder = 2; this.o.extra.push(mesh); }
    }
  }
}

/** collider pieces of a wall in its own length units */
function piecesOf(len: number, w: HWall) {
  const out: Array<{ u: number; y: number; w: number; h: number }> = [];
  const ops = [...w.openings].sort((a, c) => a.u - c.u);
  let u = 0;
  for (const o of ops) {
    const ou = Math.max(u, o.u), ow = Math.min(len, o.u + o.w) - ou;
    if (ow <= 0) continue;
    if (ou > u + 1e-3) out.push({ u, y: 0, w: ou - u, h: w.h });
    if (o.y > 0.02) out.push({ u: ou, y: 0, w: ow, h: o.y });
    if (o.y + o.h < w.h - 0.02) out.push({ u: ou, y: o.y + o.h, w: ow, h: w.h - o.y - o.h });
    u = ou + ow;
  }
  if (u < len - 1e-3) out.push({ u, y: 0, w: len - u, h: w.h });
  return out;
}

/** Build the serpentine hotel into the town bins (+ one grime decal mesh into o.extra). */
export async function addHotel(bins: TownBins, mats: TownMats, spec: HotelSpec = HOTEL, o: HotelOpts, y: () => Promise<void>): Promise<void> {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const lay = hotelLayout(spec);
  const H = new HotelBuilder(bins, mats, spec, lay, o);
  await H.walls(y); await y();
  H.facadeFrame(); await y();
  H.slabs(); await y();
  H.stairs(); await y();
  H.columns(); await y();
  H.props(); await y();
  H.roof(); await y();
  H.roofVines(); await y();
  H.apron(); await y();
  H.finish();
  void o.rng; void t0;
}
