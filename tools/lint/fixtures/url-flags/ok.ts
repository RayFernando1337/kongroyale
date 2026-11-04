declare function flag(name: string): unknown;
export const a = flag("view");
const u = new URL("/ws", location.href);
u.searchParams.set("attach", "1");
export const b = u.href;
export const c = new URLSearchParams({ a: "1" }).toString();
export const d = { search: "x" }.search;
export const e = location.href;
