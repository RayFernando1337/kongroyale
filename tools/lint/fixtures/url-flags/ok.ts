declare function flag(name: string): unknown;
export const a = flag("view");
export const d = { search: "x" }.search;
export const e = location.href;
export const f = new URL(location.href).searchParams.get("join");
