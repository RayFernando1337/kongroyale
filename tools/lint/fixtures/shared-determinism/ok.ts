// Fixture for the shared-determinism rule: the same names used as properties, strings, types, locals and comments pass.
import { Rng } from "../../../../shared/sim/rng";
// Math.random(), Date.now(), window and process in a comment are fine
export const names = ["window", "document", "process", "Math.random"];
export const opts = { window: 2, process: 1, performance: 0 };
export const read = (o: typeof opts) => o.window + o.process + o.performance;
export const roll = (rng: Rng) => rng.next();
export class Clock { now = 0; document = ""; }
export interface Tick { navigator: number; }
export const { location: loc } = { location: 3 };
const screen = (x: number) => [x, x];
export const top = (x: number) => screen(x)[1];
export function moveTo(history: number[]) { return history.length; }
export function walk(list: number[]) { let s = 0; for (const performance of list) s += performance; return s; }
export const mod = () => import("./ok-other");
