import type { Vec } from "./ok-lib";
import { type Shape, makeVec, Base } from "./ok-lib";
import * as Lib from "./ok-lib";
import Default from "./ok-lib";
import { reexported } from "./ok-lib";
export const v: Vec = makeVec();
export const s = (x: Shape) => x;
export class K extends Base {}
export const n = Lib.thing + Default.size;
export const o = { makeVec };
export { reexported };
