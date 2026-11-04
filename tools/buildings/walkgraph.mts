// FINE WALK GRAPH — a route planner for building interiors:
// every standable surface of every 0.4 m column of a box (floors, treads,
// landings, roofs; the capsule resolved with step-up, its resolved place kept), linked when ≤ 1.0 m apart, ≤ 0.5 m rise,
// knee (0.62 m) and chest (1.5 m) rays clear on the server's walk colliders. Independent of the loot generator's nav.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// (a file URL, not a path: Node's ESM loader reads a Windows path's drive letter as a URL scheme)
const { makeHit } = await import(pathToFileURL(path.join(ROOT, "shared/sim/world.ts")).href);
const { PLAYER_R, PLAYER_H } = await import(pathToFileURL(path.join(ROOT, "shared/sim/const.ts")).href);
type World = InstanceType<(typeof import("../../shared/sim/world.ts"))["StaticWorld"]>;
export type FineGraph = ReturnType<typeof makeFineGraph>;
// ---------------------------------------------------------------------------------------------- the fine walk graph
/** a 0.4 m standable-surface graph over a box (every surface of every column: floors, treads, landings, roofs), links
 * between 8-neighbours that step ≤ 0.5 m with knee + chest rays clear. Routes the mover independently of the loot
 * generator's 1.25 m nav (which misses narrow stair cores). */
export const FG = 0.4;
export function makeFineGraph(world: World, x0: number, z0: number, x1: number, z1: number, yMax: number, yMin: number) {
  const H = makeHit();
  // Walking links must include player-solid glass and balustrades. world.clear
  // is bullet LOS and deliberately ignores noShoot colliders.
  const walkClear = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    world.raycast(ax, ay, az, bx - ax, by - ay, bz - az, 1, H, false);
    return !H.hit;
  };
  const nx = Math.ceil((x1 - x0) / FG), nz = Math.ceil((z1 - z0) / FG);
  const X: number[] = [], Y: number[] = [], Z: number[] = [], colStart = new Int32Array(nx * nz + 1);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + (i + 0.5) * FG, z = z0 + (j + 0.5) * FG;
    colStart[j * nx + i] = X.length;
    let y = yMax;
    for (let guard = 0; guard < 24 && y > yMin; guard++) {
      world.raycast(x, y, z, 0, -1, 0, y - yMin + 0.5, H, false);
      if (!H.hit) break;
      const hy = H.y, bi = H.box;
      if (H.ny >= 0.7 && hy >= yMin - 0.3) {
        // (step-up on: on a flight the capsule overlaps the next riser and rides up onto it, as the mover does)
        world.velY = 0; world.headBump = false; world.resolveCapsule(x, hy + 0.02, z, PLAYER_R, PLAYER_H, true);
        // (a 1.05 m flight leaves the capsule ±0.1 m of play: accept a ≤ 0.3 m push and keep the RESOLVED place as the node)
        if (!world.headBump && Math.hypot(world.P[0] - x, world.P[2] - z) < 0.3 && world.P[1] - hy - 0.02 < 0.5 && world.P[1] - hy > -0.05) { X.push(world.P[0]); Y.push(world.P[1] - 0.02); Z.push(world.P[2]); }
      }
      if (bi < 0) break;
      y = world.cy[bi] - world.hy[bi] - 0.02;
    }
  }
  colStart[nx * nz] = X.length;
  const n = X.length, adj: number[][] = Array.from({ length: n }, () => []);
  // links: any two nodes ≤ 0.75 m apart (resolved places: a flight's nodes sit on its centreline, wherever their column
  // was), rise ≤ 0.5 m, knee + chest rays clear
  const HB = 1.05, hk = (x: number, z: number) => Math.floor(x / HB) * 100003 + Math.floor(z / HB), bucket = new Map<number, number[]>();
  for (let q = 0; q < n; q++) { const k = hk(X[q], Z[q]); let l = bucket.get(k); if (!l) bucket.set(k, l = []); l.push(q); }
  for (let a = 0; a < n; a++) {
    const ia = Math.floor(X[a] / HB), ja = Math.floor(Z[a] / HB);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const b of bucket.get((ia + di) * 100003 + ja + dj) ?? []) {
      if (b <= a) continue;
      const d = Math.hypot(X[a] - X[b], Z[a] - Z[b]);
      if (d > 1.0 || d < 0.04 && Math.abs(Y[a] - Y[b]) < 0.05 || Math.abs(Y[a] - Y[b]) > 0.5) continue;
      const ya = Math.max(Y[a], Y[b]);
      if (!walkClear(X[a], ya + 0.62, Z[a], X[b], ya + 0.62, Z[b]) || !walkClear(X[a], ya + 1.5, Z[a], X[b], ya + 1.5, Z[b])) continue;
      // the capsule's width: two more knee rays 0.3 m to each side (a gap narrower than the capsule is no link)
      { const ux = (Z[b] - Z[a]) / d * 0.3, uz = -(X[b] - X[a]) / d * 0.3;
        if (!walkClear(X[a] + ux, ya + 0.62, Z[a] + uz, X[b] + ux, ya + 0.62, Z[b] + uz) || !walkClear(X[a] - ux, ya + 0.62, Z[a] - uz, X[b] - ux, ya + 0.62, Z[b] - uz)) continue; }
      // Sample the full link with the production capsule solver. A single
      // midpoint misses a narrow jamb near one end of a diagonal link.
      let blocked = false;
      const samples = Math.ceil(d / 0.08);
      for (let i = 1; i < samples; i++) {
        const t = i / samples, mx = X[a] + (X[b] - X[a]) * t, mz = Z[a] + (Z[b] - Z[a]) * t;
        const my = Y[a] + (Y[b] - Y[a]) * t;
        world.velY = 0; world.headBump = false;
        world.resolveCapsule(mx, my + 0.02, mz, PLAYER_R, PLAYER_H, true);
        if (world.headBump || world.overlap || Math.hypot(world.P[0] - mx, world.P[2] - mz) > 0.06 || world.P[1] - my - 0.02 > 0.45) { blocked = true; break; }
      }
      if (blocked) continue;
      adj[a].push(b); adj[b].push(a);
    }
  }
  const nearest = (x: number, y: number, z: number, dyMax = 0.6) => { const i = Math.floor((x - x0) / FG), j = Math.floor((z - z0) / FG); let best = -1, bd = 1e9; for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) { const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue; const c = jj * nx + ii; for (let k = colStart[c]; k < colStart[c + 1]; k++) { const dy = Math.abs(Y[k] - y); if (dy > dyMax) continue; const d = Math.hypot(X[k] - x, Z[k] - z) + dy; if (d < bd) { bd = d; best = k; } } } return best; };
  /** BFS; `maxDy` limits the rise per link (0.3: tread by tread — a planner that cuts onto a flight from its side over a
   * 0.5 m edge would charge the stair with a "step" the player never has to take) */
  const bfs = (src: number, maxDy = 0.5, maxY = Infinity) => { const par = new Int32Array(n).fill(-2), q = new Int32Array(n); let h = 0, t = 0; q[t++] = src; par[src] = -1; while (h < t) { const a = q[h++]; for (const b of adj[a]) { if (par[b] !== -2 || Math.abs(Y[b] - Y[a]) > maxDy || Y[b] > maxY) continue; par[b] = a; q[t++] = b; } } return par; };
  return { n, X, Y, Z, adj, nearest, bfs };
}
