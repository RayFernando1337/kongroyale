// Fixture for the shared-determinism rule: each marked line must be flagged, and only those.
import fs from "node:fs"; // lint-expect
import { join } from "path"; // lint-expect
export const roll = () => Math.random(); // lint-expect
export const stamp = () => Date.now(); // lint-expect
export const today = () => new Date(); // lint-expect
export const t = () => performance.now(); // lint-expect
export const dbg = typeof process !== "undefined" && !!process.env?.DEBUG; // lint-expect
export const w = () => window.innerWidth; // lint-expect
export const el = () => document.createElement("canvas"); // lint-expect
export const raf = (f: () => void) => requestAnimationFrame(f); // lint-expect
export const buf = () => Buffer.alloc(4); // lint-expect
export const lazy = () => import("node:os"); // lint-expect
declare const global: { gc?: () => void };
export const gc = () => global.gc?.(); // lint-expect
export { fs, join };
