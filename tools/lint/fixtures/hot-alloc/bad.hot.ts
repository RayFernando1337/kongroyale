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
  step = () => new Float32Array(3); // lint-expect
}
export default (ps: P[]) => ps.slice(1); // lint-expect
export const loop = {
  tick() { return { ...SCRATCH }; }, // lint-expect
  step: (r: number) => [r], // lint-expect
};
export const Spinner = class {
  tick() { return new Float32Array(1); } // lint-expect
};
export const wrapped = ((r: number) => ALL.map((p) => p.x * r)); // lint-expect
setInterval(() => ({ ...SCRATCH }), 16); // lint-expect
export const POOL = Array.from({ length: 3 }, () => ({ x: 0, z: 0 })); // lint-expect
export const spun = new (class { tick() { return [SCRATCH.x]; } })(); // lint-expect
export class Wired {
  tick: () => number[];
  constructor() {
    this.tick = () => [SCRATCH.x]; // lint-expect
  }
}
export class Defaulted {
  constructor(
    public tick = () => [SCRATCH.z], // lint-expect
  ) {}
}
