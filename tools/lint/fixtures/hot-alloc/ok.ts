// Fixture for hot-alloc: hot functions that reuse scratch state pass; allocation outside them is not checked.
type P = { x: number; z: number };
const SCRATCH = { x: 0, z: 0 }, BUF = new Float64Array(3);
export function stepThing(ps: P[]) {
  let sum = 0;
  for (let i = 0; i < ps.length; i++) { SCRATCH.x = ps[i].x; BUF[0] = SCRATCH.x; sum += BUF[0]; }
  // a comment with { x: 1 } and [1, 2].map() is fine
  return sum + "".length;
}
export class Sim {
  ps: P[] = [];
  tick() { for (const p of this.ps) p.x += 1; }
  build() { return this.ps.map((p) => ({ ...p })); }
}
