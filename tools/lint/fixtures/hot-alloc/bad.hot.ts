type P = { x: number; z: number };
const SCRATCH = { x: 0, z: 0 };
const ALL: P[] = [];
export function step(ps: P[]) {
  const o = { x: 1, z: 2 }; // lint-expect
  for (let i = 0; i < ps.length; i++) SCRATCH.x += ps[i].x;
  return o;
}
export const near = (r: number) => ALL.filter((p) => p.x < r); // lint-expect
export class Mover {
  tick() { return new Float32Array(2); } // lint-expect
  get pair() { return [SCRATCH.x, SCRATCH.z]; } // lint-expect
}
