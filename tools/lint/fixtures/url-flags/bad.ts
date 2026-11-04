export const a = new URLSearchParams(location.search).get("seed"); // lint-expect
export const b = new URLSearchParams(globalThis.location?.search ?? "").has("sculpt"); // lint-expect
export const c = typeof location !== "undefined" && /[?&]nocull\b/.test(window.location.search); // lint-expect
export const d = new URL(location.href).searchParams.get("join"); // lint-expect
const url = new URL(location.href);
export const e = url.searchParams.has("caster"); // lint-expect
export const qs = url.searchParams; // lint-expect
export const all: string[] = [];
for (const [k] of new URL(window.location.href).searchParams) all.push(k); // lint-expect
export const spread = [...url.searchParams]; // lint-expect
export const based = new URL(location.href, location.origin).searchParams.get("join"); // lint-expect
