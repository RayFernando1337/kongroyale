// The ray path of the static world (shared/sim/world.ts StaticWorld): the terrain march and the grid walk over the box
// grid that every bullet, rocket, bot probe and loot placement asks. Split out of the class so the hot-alloc lint covers
// it (AGENTS.md "Code style": per-tick code lives in *.hot.ts files); zero allocations — the ray writes into the caller's
// Hit register.
import { GRID_CELL, TN, type Hit, type StaticWorld } from "./world";
import * as dmath from "./dmath";

// ---- raycast against boxes + terrain. Writes into `out`. dir need not be normalised (t in units of dir).
// `firstHit` stops at the first hit found, which need not be the nearest: only for yes/no tests like clear().
export function raycast(w: StaticWorld, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, out: Hit, bullets = true, firstHit = false): Hit {
  out.hit = false; out.t = maxT; out.box = -1; out.cover = -1;
  // terrain: march with adaptive steps, refine with bisection
  const len = dmath.hypot3(dx, dy, dz);
  if (len > 0) {
    let t = 0, prevAbove = oy - w.terrain.height(ox, oz);
    if (prevAbove < 0) { // start under ground → immediate hit
      out.hit = true; out.t = 0; out.x = ox; out.y = oy; out.z = oz; const n = w.terrain.normal(ox, oz, TN); out.nx = n[0]; out.ny = n[1]; out.nz = n[2]; out.surf = 255;
    } else {
      const step0 = Math.max(0.5, Math.min(4, prevAbove * 0.5)) / len;
      let step = step0;
      while (t < out.t) {
        const nt = Math.min(out.t, t + step);
        const px = ox + dx * nt, py = oy + dy * nt, pz = oz + dz * nt;
        const above = py - w.terrain.height(px, pz);
        if (above < 0) {
          // bisect between t and nt
          let a = t, b = nt;
          for (let k = 0; k < 8; k++) { const m = (a + b) * 0.5; const ay = oy + dy * m - w.terrain.height(ox + dx * m, oz + dz * m); if (ay < 0) b = m; else a = m; }
          out.hit = true; out.t = a; out.x = ox + dx * a; out.y = oy + dy * a; out.z = oz + dz * a;
          const n = w.terrain.normal(out.x, out.z, TN); out.nx = n[0]; out.ny = n[1]; out.nz = n[2]; out.surf = 255; out.box = -1;
          break;
        }
        t = nt; prevAbove = above;
        step = Math.max(0.35, Math.min(6, above * 0.6)) / len;
      }
    }
  }
  // firstHit (a line-of-sight test): any hit decides the answer, so stop at the first one instead of finding the nearest
  if (firstHit && out.hit) return out;
  // boxes: walk grid cells along the ray (2D DDA over x/z)
  const ex = ox + dx * out.t, ez = oz + dz * out.t;
  const rx0 = Math.min(ox, ex), rx1 = Math.max(ox, ex), rz0 = Math.min(oz, ez), rz1 = Math.max(oz, ez);
  const cx0 = w.cell(rx0 - 1), cx1 = w.cell(rx1 + 1), cz0 = w.cell(rz0 - 1), cz1 = w.cell(rz1 + 1);
  const span = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
  if (span <= 64) {
    // a diagonal ray's cell rectangle is mostly cells it never enters: skip a cell (grown by the 1 m margin above)
    // unless the segment up to the nearest hit so far passes through it; the rest keep their row-major order
    // Skipping changes which cell first offers a box, so rayBox settles an exact tie as the full walk would have.
    const ix = 1 / dx, iz = 1 / dz;
    if (span > 2) { w.tieX0 = cx0; w.tieZ0 = cz0; }
    cells: for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      if (span > 2) {
        const x0 = w.gridMin + cx * GRID_CELL - 1, z0 = w.gridMin + cz * GRID_CELL - 1, x1 = x0 + GRID_CELL + 2, z1 = z0 + GRID_CELL + 2;
        let t0 = 0, t1 = out.t;
        if (dx === 0) { if (ox < x0 || ox > x1) continue; }
        else { const a = (x0 - ox) * ix, b = (x1 - ox) * ix; t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b)); }
        if (dz === 0) { if (oz < z0 || oz > z1) continue; }
        else { const a = (z0 - oz) * iz, b = (z1 - oz) * iz; t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b)); }
        if (t0 > t1) continue;
      }
      w.rayCell(cz * w.gridN + cx, ox, oy, oz, dx, dy, dz, out, bullets, rx0, rx1, rz0, rz1);
      if (firstHit && out.hit) break cells;
    }
    w.tieX0 = w.tieZ0 = -1;
  } else {
    // long ray: DDA
    let cx = w.cell(ox), cz = w.cell(oz);
    const tcx = w.cell(ex), tcz = w.cell(ez);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(GRID_CELL / dx) : 1e9, tdz = dz !== 0 ? Math.abs(GRID_CELL / dz) : 1e9;
    const bx = w.gridMin + cx * GRID_CELL, bz = w.gridMin + cz * GRID_CELL;
    let tmx = dx !== 0 ? ((dx > 0 ? bx + GRID_CELL - ox : ox - bx) / Math.abs(dx)) : 1e9;
    let tmz = dz !== 0 ? ((dz > 0 ? bz + GRID_CELL - oz : oz - bz) / Math.abs(dz)) : 1e9;
    for (let guard = 0; guard < 400; guard++) {
      // visit this cell and its neighbours across (boxes may straddle)
      w.rayCell(cz * w.gridN + cx, ox, oy, oz, dx, dy, dz, out, bullets, rx0, rx1, rz0, rz1);
      if ((firstHit && out.hit) || (cx === tcx && cz === tcz)) break;
      if (tmx < tmz) { if (tmx > out.t) break; cx += sx; tmx += tdx; } else { if (tmz > out.t) break; cz += sz; tmz += tdz; }
      if (cx < 0 || cz < 0 || cx >= w.gridN || cz >= w.gridN) break;
    }
  }
  if (!(firstHit && out.hit) && w.cover !== null && w.cover.n > 0) w.cover.ray(ox, oy, oz, dx, dy, dz, out);
  return out;
}

/** one box against the ray: exact Y slab, then the box's local frame. Writes a nearer hit into `out`. */
export function rayBox(w: StaticWorld, i: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: Hit) {
  // Exact Y-slab rejection before the x/z transforms. Keep the original slab order below
  // for survivors so equal-distance axes retain their original normal and hit semantics.
  const yo = oy - w.cy[i], yh = w.hy[i];
  if (Math.abs(dy) < 1e-9) { if (yo < -yh || yo > yh) return; }
  else {
    const yi = 1 / dy; let yl = (-yh - yo) * yi, yu = (yh - yo) * yi;
    if (yl > yu) { const tmp = yl; yl = yu; yu = tmp; }
    if (Math.max(0, yl) > Math.min(out.t, yu)) return;
  }
  const c = w.cos[i], s = w.sin[i];
  const rx = ox - w.cx[i], rz = oz - w.cz[i];
  const lox = rx * c + rz * s, loz = -rx * s + rz * c, loy = oy - w.cy[i];
  const ldx = dx * c + dz * s, ldz = -dx * s + dz * c, ldy = dy;
  let tmin = 0, tmax = out.t, axis = -1, sign = 0;
  // slab x
  let lo: number, hi: number;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? lox : a === 1 ? loy : loz, d = a === 0 ? ldx : a === 1 ? ldy : ldz, h = a === 0 ? w.hx[i] : a === 1 ? w.hy[i] : w.hz[i];
    if (Math.abs(d) < 1e-9) { if (o < -h || o > h) return; continue; }
    const inv = 1 / d; lo = (-h - o) * inv; hi = (h - o) * inv;
    let sg = -1; if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; sg = 1; }
    if (lo > tmin) { tmin = lo; axis = a; sign = sg; }
    if (hi < tmax) tmax = hi;
    if (tmin > tmax) return;
  }
  if (axis < 0 || tmin > out.t || tmin <= 0) return;
  // an exact tie keeps the box found first, in the full row-major walk of the ray's cell rectangle
  if (tmin === out.t && !(w.tieZ0 >= 0 && out.box >= 0 && w.walkedFirst(i, out.box))) return;
  out.hit = true; out.t = tmin; out.box = i; out.surf = w.surf[i];
  out.x = ox + dx * tmin; out.y = oy + dy * tmin; out.z = oz + dz * tmin;
  const nx = axis === 0 ? sign : 0, ny = axis === 1 ? sign : 0, nz = axis === 2 ? sign : 0;
  out.nx = nx * c - nz * s; out.ny = ny; out.nz = nx * s + nz * c;
}
