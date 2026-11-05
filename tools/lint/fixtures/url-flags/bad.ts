export const a = new URLSearchParams(location.search).get("seed"); // lint-expect
export const b = new URLSearchParams(globalThis.location?.search ?? "").has("sculpt"); // lint-expect
export const c = typeof location !== "undefined" && /[?&]nocull\b/.test(window.location.search); // lint-expect
