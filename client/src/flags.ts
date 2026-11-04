type Kind<T> = { readonly type: string; readonly default: T; readonly parse: (value: string) => T };

const on: Kind<boolean> = { type: "on unless =0", default: true, parse: (v) => v !== "0" };
const present: Kind<boolean> = { type: "on when present", default: false, parse: () => true };
const one: Kind<boolean> = { type: "on when =1", default: false, parse: (v) => v === "1" };
const num = (d: number): Kind<number> => ({ type: "number", default: d, parse: Number });
const text: Kind<string | null> = { type: "string", default: null, parse: (v) => v };
const list: Kind<readonly string[]> = { type: "comma list", default: [], parse: (v) => v.split(",").filter(Boolean) };
const numbers: Kind<readonly number[] | undefined> = { type: "comma numbers", default: undefined, parse: (v) => v.split(",").map(Number) };

type Owner = "atmos" | "boot" | "engine" | "terrain" | "veg" | "water";
type Flag = { readonly kind: Kind<unknown>; readonly owner: Owner; readonly purpose: string };

const FLAGS = {
  atmos: { kind: list, owner: "atmos", purpose: "atmosphere debug switches: noao, nogr, nobloom, nosmaa, nosharpen, noshadow, noclouds, nopost, nofog, nocloudshadow, cloudmarch" },
  atmosp: { kind: text, owner: "atmos", purpose: "override preset fields as key:value,key:value (hex colours as c0ffee)" },
  bananatint: { kind: on, owner: "veg", purpose: "per-plant tint variation on banana leaves" },
  cullfov: { kind: on, owner: "engine", purpose: "detail cull distances scale with the camera's field of view" },
  dither: { kind: on, owner: "engine", purpose: "LOD fades dither; =0 scales instead (always off under Node)" },
  dpr: { kind: num(0), owner: "engine", purpose: "device pixel ratio instead of the screen's (capped at 2); 0 = the screen's" },
  dynres: { kind: text, owner: "engine", purpose: "dynamic resolution: =1 on, =0 forced off, absent = the setting" },
  fullcam: { kind: present, owner: "engine", purpose: "full scene-graph camera updates instead of the camera-only walk" },
  gpu: { kind: text, owner: "engine", purpose: "renderer string to classify instead of the real GPU's" },
  impblend: { kind: on, owner: "veg", purpose: "impostors crossfade between their baked views" },
  impcull: { kind: on, owner: "veg", purpose: "cull impostor cells outside the view; =0 draws every impostor every frame" },
  impgrade: { kind: numbers, owner: "veg", purpose: "four numbers that replace the impostor colour grade uImpGrade" },
  impshadow: { kind: on, owner: "veg", purpose: "impostor quads cast the island-wide canopy shadows into the static far map" },
  impsplit: { kind: numbers, owner: "veg", purpose: "four numbers that replace the impostor shade/sun split uImpSplit" },
  lodv: { kind: on, owner: "engine", purpose: "the anti-pop LOD path: terrain geomorph, rock and HLOD crossfades, view-dependent detail culling" },
  nocull: { kind: present, owner: "engine", purpose: "turn off detail culling and draw everything near" },
  nofreeze: { kind: present, owner: "engine", purpose: "turn off the static matrix cache" },
  nohlod: { kind: present, owner: "engine", purpose: "turn off the far HLOD merge" },
  nolootworker: { kind: present, owner: "engine", purpose: "compute loot spots on the main thread instead of a worker" },
  noocc: { kind: present, owner: "engine", purpose: "turn off POI occlusion culling" },
  notimer: { kind: present, owner: "engine", purpose: "act as a browser without GPU timer queries" },
  nowarmshadow: { kind: present, owner: "engine", purpose: "warm draws skip the roots' shadow-depth programs" },
  offinstant: { kind: on, owner: "engine", purpose: "culled detail switches off at once instead of fading out" },
  rocks: { kind: on, owner: "terrain", purpose: "draw the terrain rocks" },
  scale: { kind: num(0), owner: "engine", purpose: "pin the 3D resolution scale; 0 = not pinned" },
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
  steam: { kind: on, owner: "terrain", purpose: "lava steam vents in the badlands" },
  streamslice: { kind: numbers, owner: "engine", purpose: "stream budget per frame in ms: title,warm,match" },
  sun: { kind: numbers, owner: "atmos", purpose: "sun elevation,azimuth in degrees instead of the preset's" },
  texprof: { kind: present, owner: "engine", purpose: "profile texture uploads" },
  tfar: { kind: on, owner: "terrain", purpose: "far terrain material beyond 350 m" },
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
  visfade: { kind: on, owner: "engine", purpose: "detail fades in and out at the cull edge (always off under Node)" },
  waniso: { kind: num(0), owner: "water", purpose: "anisotropy of the water normal and ripple textures; 0 = the default (4, ripples 8)" },
  wbase: { kind: num(0), owner: "water", purpose: "water clipmap base cell size (m); 0 = 1 m" },
  wcells: { kind: num(0), owner: "water", purpose: "water clipmap cells per level; 0 = by quality (48 low, else 64)" },
  wfoampass: { kind: present, owner: "water", purpose: "draw foam in its own pass instead of the main water pass" },
  wfoamtest: { kind: present, owner: "water", purpose: "paint demo foam shapes" },
  wlevels: { kind: num(0), owner: "water", purpose: "water clipmap levels; 0 = 8" },
  wnodual: { kind: present, owner: "water", purpose: "turn off dual-source blending for water" },
  wnoscene: { kind: present, owner: "water", purpose: "turn off the scene grab behind water (refraction)" },
  wnovshadow: { kind: present, owner: "water", purpose: "turn off the water's per-vertex sun shadow lookup" },
  wphys: { kind: present, owner: "water", purpose: "physical water: full sun glitter, no artistic reflection lifts" },
  wprepass: { kind: present, owner: "water", purpose: "depth pre-pass for water" },
  wripple: { kind: present, owner: "water", purpose: "demo ripples" },
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
