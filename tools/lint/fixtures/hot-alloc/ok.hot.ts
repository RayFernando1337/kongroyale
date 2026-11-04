type P = { x: number; z: number };
const SCRATCH = { x: 0, z: 0 }, BUF = new Float64Array(4);
export const ALL: P[] = [];
export function step(ps: P[]) {
  for (let i = 0; i < ps.length; i++) { SCRATCH.x += ps[i].x; BUF[0] = SCRATCH.x; }
  return BUF[0];
}
export class Mover {
  n = 0;
  tick() { this.n++; return this.n; }
  step = () => this.n + 1;
  readonly scratch = new Float32Array(3);
}
