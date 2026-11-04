type Kind<T> = { readonly type: string; readonly default: T; readonly parse: (value: string) => T };

const on: Kind<boolean> = { type: "on unless =0", default: true, parse: (v) => v !== "0" };
const present: Kind<boolean> = { type: "on when present", default: false, parse: () => true };
const one: Kind<boolean> = { type: "on when =1", default: false, parse: (v) => v === "1" };
const num = (d: number): Kind<number> => ({ type: "number", default: d, parse: Number });
const text: Kind<string | null> = { type: "string", default: null, parse: (v) => v };
const list: Kind<readonly string[]> = { type: "comma list", default: [], parse: (v) => v.split(",").filter(Boolean) };
const numbers: Kind<readonly number[] | undefined> = { type: "comma numbers", default: undefined, parse: (v) => v.split(",").map(Number) };

type Owner = "boot" | "veg";
type Flag = { readonly kind: Kind<unknown>; readonly owner: Owner; readonly purpose: string };

const FLAGS = {
  bananatint: { kind: on, owner: "veg", purpose: "per-plant tint variation on banana leaves" },
  impblend: { kind: on, owner: "veg", purpose: "impostors crossfade between their baked views" },
  impcull: { kind: on, owner: "veg", purpose: "cull impostor cells outside the view; =0 draws every impostor every frame" },
  impgrade: { kind: numbers, owner: "veg", purpose: "four numbers that replace the impostor colour grade uImpGrade" },
  impshadow: { kind: on, owner: "veg", purpose: "impostor quads cast the island-wide canopy shadows into the static far map" },
  impsplit: { kind: numbers, owner: "veg", purpose: "four numbers that replace the impostor shade/sun split uImpSplit" },
  splasync: { kind: one, owner: "veg", purpose: "read splat captures back from the GPU asynchronously" },
  splcache: { kind: on, owner: "veg", purpose: "keep baked splats in the browser cache; =0 bakes on every load" },
  splcut: { kind: num(1), owner: "veg", purpose: "splat opacity cut-off gain" },
  spldbg: { kind: list, owner: "veg", purpose: "splat shader switches: noatm, nofog, nofar" },
  spldens: { kind: num(0.3), owner: "veg", purpose: "splat density that picks a level from a plant's projected radius" },
  splhue: { kind: num(-0.12), owner: "veg", purpose: "near-splat hue shift" },
  splhull: { kind: one, owner: "veg", purpose: "bake splats from the crown hull capture (always on under Node)" },
  splkeep: { kind: num(0.35), owner: "veg", purpose: "splat keep fraction" },
  splnear: { kind: num(1024), owner: "veg", purpose: "levels with at least this many splats are captured from LOD1" },
  splocc: { kind: num(1), owner: "veg", purpose: "splat ambient occlusion gain" },
  splocfar: { kind: num(0.5), owner: "veg", purpose: "splat ambient occlusion gain far away" },
  splop: { kind: num(1.35), owner: "veg", purpose: "splat opacity gain" },
  splres: { kind: num(256), owner: "veg", purpose: "splat capture resolution (px)" },
  splsat: { kind: num(1.1), owner: "veg", purpose: "near-splat saturation" },
  splshadow: { kind: num(1), owner: "veg", purpose: "splat shadow gain" },
  splshfar: { kind: num(0.6), owner: "veg", purpose: "splat shadow gain far away" },
  splshoff: { kind: num(1), owner: "veg", purpose: "splat shadow offset" },
  splspread: { kind: num(1.25), owner: "veg", purpose: "splat capture spread" },
  splsz: { kind: num(1), owner: "veg", purpose: "splat size gain" },
  splthick: { kind: num(0.22), owner: "veg", purpose: "splat capture thickness" },
  vegcol: { kind: one, owner: "veg", purpose: "debug colours for the veg colliders" },
  vegdbg: { kind: list, owner: "veg", purpose: "veg perf attribution switches: noshadow, noimp, nolod0, nolod1, nodetail" },
  vegpre: { kind: one, owner: "veg", purpose: "depth pre-pass for alpha-tested foliage (measured slower, so off)" },
  vegq: { kind: text, owner: "veg", purpose: "veg quality tier (low, medium, high, epic) instead of the engine's" },
  vegshadow1: { kind: on, owner: "veg", purpose: "LOD1 of the casting species casts into the dynamic shadow cascades" },
  vegsolidfade: { kind: on, owner: "veg", purpose: "opaque LOD0 parts crossfade with their tier" },
  vegsplat: { kind: on, owner: "veg", purpose: "gaussian-splat far trees" },
  vegsplatsmall: { kind: on, owner: "veg", purpose: "gaussian-splat far understory" },
  vegsyncscatter: { kind: present, owner: "veg", purpose: "scatter the vegetation on the main thread instead of a worker" },
  vegwarm: { kind: on, owner: "veg", purpose: "compile every veg shadow program at load" },
  vegxfade: { kind: on, owner: "veg", purpose: "foliage LOD tiers crossfade" },
  view: { kind: text, owner: "boot", purpose: "boot into a fixed dev view (a POI, biome or studio) instead of the game" },
} as const satisfies Record<string, Flag>;

export type FlagName = keyof typeof FLAGS;
export type FlagValue<K extends FlagName> = (typeof FLAGS)[K]["kind"] extends Kind<infer T> ? T : never;

const values: Record<string, unknown> = {};
{
  const q = new URLSearchParams(globalThis.location?.search ?? "");
  for (const [name, { kind }] of Object.entries(FLAGS as Record<string, Flag>)) {
    const v = q.get(name);
    values[name] = v === null ? kind.default : kind.parse(v);
  }
}

export function flag<K extends FlagName>(name: K): FlagValue<K> {
  return values[name] as FlagValue<K>;
}
