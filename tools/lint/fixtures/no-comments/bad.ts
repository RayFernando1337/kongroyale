export const a = 1; // trailing note // lint-expect
// a line comment // lint-expect
/* a block // lint-expect
   over three lines // lint-expect
   ends here */ export const b = 2; // lint-expect
/** a doc comment */ // lint-expect
export function f(/* inline */ x: number) { return x; } // lint-expect
// @ts-ignore-ish prose is still a comment // lint-expect
// eslint-disable-next-line no-console // lint-expect
