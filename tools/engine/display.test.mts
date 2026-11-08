// The video settings' Auto (client/src/engine/display.ts, ui/settings-model.ts): a player who never chose a preset gets the
// detected tier, a preset the player chose stays, and stepping back from Auto in the preset row never lands on Epic.
// The engine, the page and localStorage are stubbed; the GPU string is the one from a Radeon 740M report (rated Low).
import assert from "node:assert/strict";

const store = new Map<string, string>();
const RADEON = "ANGLE (AMD, AMD Radeon 740M Graphics (0x00001901) Direct3D11 vs_5_0 ps_5_0, D3D11)";
let gpu = RADEON;
const glFor = (name: string) => ({ getExtension: (n: string) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 1 } : null), getParameter: () => name });
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() },
  location: { search: "?join=Q4KR", href: "http://localhost/?join=Q4KR" },
  innerWidth: 1528, innerHeight: 732,
  document: { createElement: () => ({ getContext: () => glFor(gpu) }) },
});
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Edge", maxTouchPoints: 0 }, configurable: true });
const { Display, LEVELS, bootQuality } = await import("../../client/src/engine/display");
const { nextChoice, videoCategory } = await import("../../client/src/ui/settings-model");
type Settings = InstanceType<typeof Display>["settings"];

const engine = () => ({
  renderer: { getContext: () => glFor(gpu), domElement: { clientWidth: 1528, clientHeight: 732 } },
  dprBase: 1.25, shared: new Map(), cull: {}, onRefresh() { /* no refresh in the stub */ },
  setFrameCap() { /* stub */ }, setResolution() { /* stub */ }, setDynamicRes() { /* stub */ },
}) as unknown as ConstructorParameters<typeof Display>[0];
const saved = (preset: string, auto: string, level: string, extra: Partial<Settings> = {}) => ({ v: 2, preset, auto, res3d: 1, dynres: false, fpsCap: -1, aa: "taa", shadows: level, ao: true, post: level, viewDist: level, foliage: level, effects: level, fov: 72, showFps: false, ...extra });
const boot = (s: object | null) => { store.clear(); if (s) store.set("kr-video", JSON.stringify(s)); return new Display(engine()); };
const allAt = (s: Settings, level: string) => [s.shadows, s.post, s.viewDist, s.foliage, s.effects].every((l) => l === level);

const fresh = boot(null);
assert.equal(fresh.gpuLevel, "low", "the 740M rates Low");
assert.equal(fresh.firstVisit, true);
assert.equal(fresh.settings.preset, "auto", "a fresh profile starts on Auto");
assert.equal(fresh.settings.auto, "low");
assert.ok(allAt(fresh.settings, "low") && !fresh.settings.ao && fresh.settings.aa === "fxaa", "Auto on a Low GPU builds the Low options");

const v1 = (preset: string, auto: string) => ({ ...saved(preset, auto, auto), v: 1, res3d: 0.8 });
let d = boot(v1("auto", "epic"));
assert.equal(d.settings.preset, "auto", "a v1 Auto save migrates to v2 and stays Auto");
assert.equal(d.settings.auto, "low", "and is reclassified to the detected tier");
assert.ok(allAt(d.settings, "low"));
d = boot(v1("auto", "low"));
assert.deepEqual([d.settings.v, d.settings.preset, d.settings.auto, d.settings.res3d], [2, "auto", "low", 1], "a v1 Auto save already at the detected tier keeps Auto; the 3D resolution is re-derived");

d = boot(saved("auto", "epic", "epic"));
assert.deepEqual([d.settings.preset, d.settings.auto, d.firstVisit], ["auto", "low", true], "a v2 Auto save from a stronger GPU is reclassified and re-benched");
assert.ok(allAt(d.settings, "low"));

d = boot(saved("auto", "medium", "medium", { stepped: { from: "high", to: "medium", res: 1 } }));
assert.deepEqual([d.settings.preset, d.settings.auto, d.firstVisit, d.settings.stepped], ["auto", "low", true, undefined], "a bench step-down above the detected tier is reclassified; its notice goes");
assert.ok(allAt(d.settings, "low"));
d = boot(saved("auto", "low", "low", { stepped: { from: "medium", to: "low", res: 1 } }));
assert.deepEqual([d.settings.auto, d.firstVisit, d.settings.stepped?.to], ["low", false, "low"], "a step-down at the detected tier is kept");
const strong = (s: object) => { gpu = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11)"; try { return boot(s); } finally { gpu = RADEON; } };
d = strong(saved("auto", "medium", "medium", { stepped: { from: "high", to: "medium", res: 1 } }));
assert.deepEqual([d.gpuLevel, d.settings.auto, d.firstVisit], ["epic", "medium", false], "a step-down below the detected tier is a measurement on this machine and is kept");

for (const preset of ["epic", "high", "medium"]) {
  d = boot(saved(preset, "low", preset));
  assert.deepEqual([d.settings.preset, d.firstVisit], [preset, false], "a preset the player chose is respected: " + preset);
  assert.ok(allAt(d.settings, preset));
}
d = boot(saved("custom", "low", "epic"));
assert.equal(d.settings.preset, "custom", "Custom is respected");

d = boot(null);
d.set({ preset: "epic" });
assert.equal(JSON.parse(store.get("kr-video")!).preset, "epic", "choosing Epic stores it");
assert.equal(boot(JSON.parse(store.get("kr-video")!)).settings.preset, "epic", "and a reload keeps it");
d.set({ preset: "auto" });
assert.deepEqual([d.settings.preset, d.settings.auto, d.settings.dynres], ["auto", "low", false], "choosing Auto again goes back to the detected tier");

const bootAt = (s: object | null) => { store.clear(); if (s) store.set("kr-video", JSON.stringify(s)); return bootQuality(); };
assert.equal(bootAt(null), "low", "the first boot builds at the detected tier");
assert.equal(bootAt(saved("auto", "epic", "epic")), "low", "an Auto save from a stronger GPU builds at the detected tier");
assert.equal(bootAt(saved("auto", "medium", "medium", { stepped: { from: "high", to: "medium", res: 1 } })), "low", "a step-down above the detected tier builds at the detected tier");
assert.equal(bootAt(saved("epic", "low", "epic")), "ultra", "a chosen Epic builds at Epic");

const preset = () => {
  const d = boot(null);
  const row = videoCategory({ refreshHz: 60 } as never, d).sections.flatMap((s) => s.rows()).find((r) => r.id === "preset");
  assert.ok(row && row.kind === "cycle");
  return { d, row };
};
const { d: pd, row } = preset();
assert.equal(row.get(), "auto");
assert.equal(nextChoice(row, -1, true), null, "stepping back from Auto stays on Auto, never Epic");
assert.equal(nextChoice(row, 1, true)?.v, "low", "stepping on from Auto goes to Low");
pd.set({ preset: "low" });
assert.equal(nextChoice(row, -1, true)?.v, "auto", "stepping back from Low goes to Auto");
pd.set({ preset: "epic" });
assert.equal(nextChoice(row, 1, true)?.v, "auto", "stepping on from Epic wraps to Auto (Enter and click keep cycling)");
assert.equal(nextChoice(row, -1, true)?.v, "high");
assert.deepEqual(LEVELS, ["low", "medium", "high", "epic"]);

const other = { kind: "cycle", id: "x", label: "x", help: () => ({ eb: "" }), options: () => [{ v: 1, label: "1" }, { v: 2, label: "2" }], get: () => 1, set() { /* stub */ } } as const;
assert.equal(nextChoice(other as never, -1, true)?.v, 2, "other cycle rows still wrap");

console.log("display: Auto, stored presets, migration, join link and preset stepping ok");
