// the Canvas Lab's COPLANAR
// RESOLVER (cnvs-lab/geo.ts) generalised to ORIENTED boxes, for the builders that merge thousands of boxes per POI (the
// town kit's GeoBin, harbor-geo's Builder, coast-kit's Batch). A builder registers every box it writes (centre, three
// unit axes, half extents, where its vertices live); resolve() then finds face pairs that lie in the same plane, face the
// same way and overlap (the z-fight: two depths equal to the last bit) and moves ONE of the two faces off the plane by
// EPS — the smaller face steps OUT (a trim strip, band, floor board, paving patch wins), or IN when its whole box sits
// inside the bigger one (a buried piece sharing one face). Only that face's plane moves (every vertex of the box on it,
// so the side faces stretch with it and the box stays closed). Build-time only; nothing changes per frame.
// Boxes carry a `tag`: only boxes drawn at the same time are compared (a town LOD unit's hi and lo copies coincide by
// design but never draw together).

/** 4 mm: resolves out to ~80 m with the game's 0.1 m near plane (beyond that most POIs draw their far proxies) */
export const EPS_COPLANAR = 0.004;
const Q = 0.002;
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export interface CoBox {
  /** centre */ c: [number, number, number];
  /** unit axes, row-major: a[k*3 .. k*3+2] = axis k */ a: Float64Array;
  /** half extents along the axes */ h: [number, number, number];
  tag: number;
  /** the position array that holds this box's vertices (looked up at resolve time — growable buffers reallocate) */
  pos: () => ArrayLike<number> & { [i: number]: number } | null;
  /** first vertex, vertex count */ v0: number; vn: number;
}

export class Coplanar {
  boxes: CoBox[] = [];
  /** register a box given by the matrix that maps the UNIT box (−0.5..0.5) scaled by (w, h, d) into place — i.e. the
   *  `w,h,d,matrix` of GeoBin.box / BoxGeometry(w,h,d) placed with `matrix`. Skips sheared / degenerate boxes. */
  addMatrix(w: number, h: number, d: number, e: ArrayLike<number>, tag: number, pos: CoBox["pos"], v0: number, vn: number): void {
    const a = new Float64Array(9), hh: [number, number, number] = [0, 0, 0], dims = [w, h, d];
    for (let k = 0; k < 3; k++) {
      const x = e[k * 4], y = e[k * 4 + 1], z = e[k * 4 + 2], L = Math.sqrt(x * x + y * y + z * z);
      if (!(L > 1e-9) || !(dims[k] > 1e-4)) return;
      a[k * 3] = x / L; a[k * 3 + 1] = y / L; a[k * 3 + 2] = z / L; hh[k] = (dims[k] * L) / 2;
    }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (Math.abs(a[i * 3] * a[j * 3] + a[i * 3 + 1] * a[j * 3 + 1] + a[i * 3 + 2] * a[j * 3 + 2]) > 1e-3) return;
    this.boxes.push({ c: [e[12], e[13], e[14]], a, h: hh, tag, pos, v0, vn });
  }
  /** register a geometry known to be a box (every normal axis-aligned in its local frame): its local bounds, placed by
   *  the matrix elements `e` (null = identity) */
  addGeometry(g: { attributes: { position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number }; normal?: { getX(i: number): number; getY(i: number): number; getZ(i: number): number } } }, e: ArrayLike<number> | null, tag: number, pos: CoBox["pos"], v0: number, vn: number): void {
    const p = g.attributes.position, n = g.attributes.normal; if (!n || p.count > 64) return;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      if (Math.max(ax, ay, az) < 0.999) return;   // a smoothed / rotated piece: not a box in this frame
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, E = e ?? ID;
    const m = [E[0], E[1], E[2], 0, E[4], E[5], E[6], 0, E[8], E[9], E[10], 0,
      E[0] * cx + E[4] * cy + E[8] * cz + E[12], E[1] * cx + E[5] * cy + E[9] * cz + E[13], E[2] * cx + E[6] * cy + E[10] * cz + E[14], 1];
    this.addMatrix(x1 - x0, y1 - y0, z1 - z0, m, tag, pos, v0, vn);
  }
  resolve(): { boxes: number; pairs: number; moved: number; ms: number; maxPass: number } { const it = this.steps(); let r = it.next(); while (!r.done) r = it.next(); return r.value; }
  /** the same, time-sliced: yields every ~`slice` ms (a builder's generator yields to the frame between: no long
   *  main-thread task at load — Mango Market registers ~100 k boxes) */
  *steps(slice = 12): Generator<void, { boxes: number; pairs: number; moved: number; ms: number; maxPass: number }, void> {
    let ms = 0; const out = { boxes: this.boxes.length, pairs: 0, moved: 0, ms: 0, maxPass: 0 };
    // (a face can sit in several overlaps: passes until no coplanar pair is left — the moved faces leave their planes;
    // later passes only revisit the planes where a pair was skipped)
    let only: Set<number> | null = null;
    const clock = { t: performance.now(), slice, run: 0 };
    for (let pass = 0; pass < 4; pass++) {
      const r = { pairs: 0, moved: 0, again: new Set<number>() };
      const t0 = performance.now(); clock.t = t0; clock.run = 0;
      for (const _ of passGen(this.boxes, only, r, clock)) { void _; ms += performance.now() - clock.t; out.maxPass = Math.max(out.maxPass, +(performance.now() - clock.t).toFixed(1)); yield; clock.t = performance.now(); }
      ms += performance.now() - clock.t; out.maxPass = Math.max(out.maxPass, +(performance.now() - clock.t).toFixed(1));
      if (pass === 0) out.pairs = r.pairs; out.moved += r.moved;
      if (!r.moved || !r.again.size) break;
      only = r.again;
      yield; clock.t = performance.now();
    }
    this.boxes = [];
    out.ms = +ms.toFixed(1);
    return out;
  }
}

interface Face { b: number; k: number; sg: number; d: number; area: number; nx: number; ny: number; nz: number }
const keyOf = (nx: number, ny: number, nz: number, qd: number) => ((Math.round(nx * 400) + 400) * 801 + (Math.round(ny * 400) + 400)) * 801 * 4e6 + (Math.round(nz * 400) + 400) * 4e6 + qd + 2e6;

function* passGen(R: CoBox[], only: Set<number> | null, out: { pairs: number; moved: number; again: Set<number> }, clock: { t: number; slice: number }): Generator<void, void, void> {
  const buckets = new Map<number, Face[]>();
  for (let i = 0; i < R.length; i++) {
    const b = R[i];
    for (let k = 0; k < 3; k++) {
      const u = (k + 1) % 3, v = (k + 2) % 3, area = 4 * b.h[u] * b.h[v];
      if (area < 4e-4) continue;   // (under 2 × 2 cm: sub-pixel beyond arm's length)
      for (let sg = -1; sg <= 1; sg += 2) {
        const nx = b.a[k * 3] * sg, ny = b.a[k * 3 + 1] * sg, nz = b.a[k * 3 + 2] * sg;
        const d = nx * b.c[0] + ny * b.c[1] + nz * b.c[2] + b.h[k];
        const key = keyOf(nx, ny, nz, Math.round(d / Q));
        if (only && !only.has(key) && !only.has(key - 1)) continue;
        let l = buckets.get(key); if (!l) buckets.set(key, l = []);
        l.push({ b: i, k, sg, d, area, nx, ny, nz });
      }
    }
    if ((i & 1023) === 1023 && performance.now() - clock.t > clock.slice) yield;
  }
  const act = new Map<number, { b: number; k: number; sg: number; delta: number }>();
  const cand: Array<{ f: Face; own: boolean; x: number; r: number }> = [];
  for (const [key, list] of buckets) {
    if (only && !only.has(key)) continue;
    const near = buckets.get(key + 1);
    if (list.length + (near?.length ?? 0) < 2) continue;
    // sweep along an in-plane world axis (the face's left edge, centre − in-plane radius): a plane with thousands of
    // faces (a paved square, a row of floor boards, a long facade) stays ~linear
    const zAxis = Math.abs(list[0].nx) > 0.7;
    cand.length = 0;
    const put = (f: Face, own: boolean) => { const b = R[f.b], u = (f.k + 1) % 3, v = (f.k + 2) % 3, r = Math.hypot(b.h[u], b.h[v]); cand.push({ f, own, x: (zAxis ? b.c[2] + f.nz * b.h[f.k] : b.c[0] + f.nx * b.h[f.k]) - r, r }); };
    for (const f of list) put(f, true);
    if (near) for (const f of near) put(f, false);
    cand.sort((p, q) => p.x - q.x);   // (once a face starts right of e's right edge, all later ones do)
    for (let x = 0; x < cand.length; x++) {
      const ce = cand[x], e = ce.f, A = R[e.b];
      for (let y = x + 1; y < cand.length; y++) {
        const cf = cand[y];
        if (cf.x > ce.x + 2 * ce.r) break;
        if (!ce.own && !cf.own) continue;
        const f = cf.f, B = R[f.b];
        if (e.b === f.b || Math.abs(e.d - f.d) > Q * 1.5) continue;
        if (A.tag !== B.tag && A.tag !== 0 && B.tag !== 0) continue;
        if (e.nx * f.nx + e.ny * f.ny + e.nz * f.nz < 0.9999) continue;
        if (!faceOverlap(A, e.k, B, f.k)) continue;
        out.pairs++;
        const [sm, bg] = e.area < f.area || (e.area === f.area && e.b > f.b) ? [e, f] : [f, e];
        const ks = sm.b * 6 + sm.k * 2 + (sm.sg > 0 ? 1 : 0), kb = bg.b * 6 + bg.k * 2 + (bg.sg > 0 ? 1 : 0);
        if (act.has(ks) || act.has(kb)) { out.again.add(key); continue; }
        const S = R[sm.b], inside = boxInside(S, R[bg.b]);
        act.set(ks, { b: sm.b, k: sm.k, sg: sm.sg, delta: inside ? -Math.min(EPS_COPLANAR, S.h[sm.k] * 0.5) : EPS_COPLANAR });
      }
    }
    if (performance.now() - clock.t > clock.slice) yield;
  }
  for (const m of act.values()) {
    const b = R[m.b], P = b.pos(); if (!P) continue;
    const ax = b.a[m.k * 3], ay = b.a[m.k * 3 + 1], az = b.a[m.k * 3 + 2], hk = b.h[m.k] * m.sg, tol = Math.max(1e-3, b.h[m.k] * 1e-3);
    const dx = ax * m.sg * m.delta, dy = ay * m.sg * m.delta, dz = az * m.sg * m.delta;
    for (let v = b.v0, ve = b.v0 + b.vn; v < ve; v++) {
      const t = (P[v * 3] - b.c[0]) * ax + (P[v * 3 + 1] - b.c[1]) * ay + (P[v * 3 + 2] - b.c[2]) * az;
      if (Math.abs(t - hk) < tol) { P[v * 3] += dx; P[v * 3 + 1] += dy; P[v * 3 + 2] += dz; }
    }
    // the face moved by delta along its normal: the box grows / shrinks by delta, its centre by delta / 2
    b.h[m.k] += m.delta / 2; b.c[0] += dx / 2; b.c[1] += dy / 2; b.c[2] += dz / 2;
    // the face's new plane: two small faces that both stepped off one big face can now share THAT plane — revisit it
    const nx = ax * m.sg, ny = ay * m.sg, nz = az * m.sg, nk = keyOf(nx, ny, nz, Math.round((nx * b.c[0] + ny * b.c[1] + nz * b.c[2] + b.h[m.k]) / Q));
    out.again.add(nk); out.again.add(nk - 1);
    if (performance.now() - clock.t > clock.slice) yield;
  }
  out.moved = act.size;
}

/** do face (A, axis ka) and face (B, axis kb) — known coplanar — overlap by more than 1 cm in both in-plane directions?
 *  (2D separating-axis test of the two face rectangles) */
function faceOverlap(A: CoBox, ka: number, B: CoBox, kb: number): boolean {
  const au = (ka + 1) % 3, av = (ka + 2) % 3, bu = (kb + 1) % 3, bv = (kb + 2) % 3;
  const dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1], dz = B.c[2] - A.c[2];
  return sepOk(A, au, av, B, bu, bv, A.a, au * 3, dx, dy, dz) && sepOk(A, au, av, B, bu, bv, A.a, av * 3, dx, dy, dz)
    && sepOk(A, au, av, B, bu, bv, B.a, bu * 3, dx, dy, dz) && sepOk(A, au, av, B, bu, bv, B.a, bv * 3, dx, dy, dz);
}
/** projections of both face rectangles on axis L (= L[o..o+2]) overlap by ≥ 1 cm (no allocation: a hot loop at load) */
function sepOk(A: CoBox, au: number, av: number, B: CoBox, bu: number, bv: number, L: Float64Array, o: number, dx: number, dy: number, dz: number): boolean {
  const lx = L[o], ly = L[o + 1], lz = L[o + 2], a = A.a, b = B.a;
  const ra = A.h[au] * Math.abs(a[au * 3] * lx + a[au * 3 + 1] * ly + a[au * 3 + 2] * lz) + A.h[av] * Math.abs(a[av * 3] * lx + a[av * 3 + 1] * ly + a[av * 3 + 2] * lz);
  const rb = B.h[bu] * Math.abs(b[bu * 3] * lx + b[bu * 3 + 1] * ly + b[bu * 3 + 2] * lz) + B.h[bv] * Math.abs(b[bv * 3] * lx + b[bv * 3 + 1] * ly + b[bv * 3 + 2] * lz);
  return ra + rb - Math.abs(dx * lx + dy * ly + dz * lz) >= 0.01;
}

/** every corner of S inside B (1 mm tolerance) */
function boxInside(S: CoBox, B: CoBox): boolean {
  for (let c = 0; c < 8; c++) {
    let x = S.c[0], y = S.c[1], z = S.c[2];
    for (let k = 0; k < 3; k++) { const s = (c >> k) & 1 ? 1 : -1; x += S.a[k * 3] * S.h[k] * s; y += S.a[k * 3 + 1] * S.h[k] * s; z += S.a[k * 3 + 2] * S.h[k] * s; }
    for (let k = 0; k < 3; k++) { const t = (x - B.c[0]) * B.a[k * 3] + (y - B.c[1]) * B.a[k * 3 + 1] + (z - B.c[2]) * B.a[k * 3 + 2]; if (Math.abs(t) > B.h[k] + 0.001) return false; }
  }
  return true;
}
