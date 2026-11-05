declare function flag(name: string): unknown;
export const a = flag("view");
const u = new URL("/ws", location.href);
u.searchParams.set("attach", "1");
export const b = u.searchParams.get("attach");
const page = new URL(location.href);
page.searchParams.delete("join");
export const c = new URLSearchParams({ a: "1" }).toString();
export const d = { search: "x" }.search;
export const e = location.href;
const endpoint = new URL("/api/items?cursor=next", location.origin);
export const f = endpoint.searchParams.get("cursor");
const pageUrl = new URL(location.href);
export const g = pageUrl.href;
export function cursor(pageUrl: URL) { return pageUrl.searchParams.get("cursor"); }
let moving = new URL(location.href);
moving = new URL("/api", location.origin);
export const h = moving.searchParams.get("cursor");
