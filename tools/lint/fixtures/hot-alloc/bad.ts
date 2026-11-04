// Fixture for hot-alloc: inside the functions fixtures/hot-alloc/hot.json lists, each marked line must be flagged.
type P = { x: number; z: number };
export function stepThing(ps: P[], out: number[]) {
  const v = new Float64Array(3); // lint-expect
  const o = { x: 1, z: 2 }; // lint-expect
  const pair = [o.x, o.z]; // lint-expect
  const near = ps.filter((p) => p.x < 1); // lint-expect
  const xs = ps.map(px); // lint-expect
  const copy = { ...o }; // lint-expect
  out.push(...pair); // lint-expect
  function inner() { return v[0] + copy.x + near.length + xs.length + restOfO.z + first.x + others.length; } // lint-expect
  const { x: _x, ...restOfO } = o; // lint-expect
  const [first, ...others] = ps; // lint-expect
  ps.forEach((p) => { // lint-expect
    out.push(p.x, [p.z].length); // lint-expect
  });
  return inner();
}
const px = (p: P) => p.x;
export class Sim {
  ps: P[] = [];
  tick() {
    for (let i = 0; i < this.ps.length; i++) this.ps[i].x += 1;
    return this.ps.slice(0, 2); // lint-expect
  }
  cold() { return { x: 0, z: 0 }; }
}
export const arrowStep = (p: P) => ({ x: p.x, z: p.z }); // lint-expect
export function restStep(...ps: P[]) { return ps.length; } // lint-expect
export function notHot() { return [1, 2, 3].map((n) => ({ n })); }
