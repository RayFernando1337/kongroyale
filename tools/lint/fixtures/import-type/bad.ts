import { Vec, makeVec } from "./ok-lib"; // lint-expect
import * as Lib from "./ok-lib"; // lint-expect
import Default from "./ok-lib"; // lint-expect
import { unused } from "./ok-lib"; // lint-expect
export const f = (v: Vec, o: typeof Lib.thing): Default => ({ ...v, o }) as unknown as Default;
export class Impl implements Vec { x = 0; }
export const g = () => makeVec;
