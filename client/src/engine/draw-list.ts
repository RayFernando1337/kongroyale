// Draw list (?drawlist=<module ids>, =1 for Mango Market, =all for every world module; off by default. KONG-93 / RAY-237 option (c) step 2). Three
// spends ~15 µs of main-thread JavaScript on each static draw (RTX lab, #323) where the GL calls themselves cost ~5: most
// of it is setProgram re-deciding and re-sending what has not changed. This replaces renderer.renderBufferDirect on the
// instance: a draw of a listed world module's opaque mesh, from the engine camera in the main scene, goes to the lean
// path in draw-list.hot.ts once three has drawn it once (its program, VAO and uniforms are then valid) and for as long
// as valid() holds; every other draw, and a pinned one whose program, material version, lights layout, fog,
// environment or output target moved, goes to three's own function, which then re-pins it. Three still culls, sorts,
// runs the object hooks and computes the matrices, so the frame draws the same draws in the same order: the pixels must
// not change: tools/performance/draw-list-frame.mts renders one frame with the list off, on and off again and fails on
// any differing value.
//
// Three internals it leans on (r186; re-check on an upgrade): renderer.properties (per-material program, uniforms,
// uniformsList), renderer.state, the WebGLUniforms setters and their caches, the WebGLTextures object (taken from the first
// WebGLUniforms.upload), the lights.state shadow-map arrays (taken from three's own setValue calls in the main pass) and
// the VAO bindingStates binds (seen through a wrapper on the context's bindVertexArray). Pinned materials must be frozen:
// a property change that three would copy into a uniform without a version bump is not seen.
//
// On context loss everything is dropped and rebuilt from three's renderer after the restore. An entry dies with its
// geometry's dispose event (three deletes the VAO then); a disposed material gets new renderer properties, which valid()
// sees. __kr.drawList (DrawList below) switches it live and counts lean and fallback draws.
import * as THREE from "three";
import type { Engine } from "./engine";
import { flag } from "../flags";
import { handBack, leanDraw, lightLayout, valid, type Entry, type GlProgram, type GlTextures, type GlUniform, type GlUniforms, type Layout, type LeanState, type MatProps } from "./draw-list.hot";

/** ?drawlist=1: the module with the most static draws in walk-town (KONG-93 census) */
const DEFAULT_MODULES = ["poi:mango-market"];
/** the light uniforms three re-sends only on a program switch (markUniformsLightsNeedsUpdate) */
const LIGHT_IDS = new Set(["ambientLightColor", "lightProbe", "sunLights", "sunLightShadows", "directionalLights", "directionalLightShadows", "pointLights", "pointLightShadows", "spotLights", "spotLightShadows", "rectAreaLights", "hemisphereLights"]);
const FOG_IDS = new Set(["fogColor", "fogNear", "fogFar", "fogDensity"]);
/** GL sampler types (three's getSingularSetter / getPureArraySetter texture cases) */
const SAMPLERS = new Set([0x8b5e, 0x8d66, 0x8dca, 0x8dd2, 0x8b62, 0x8b5f, 0x8dcb, 0x8dd3, 0x8b60, 0x8dcc, 0x8dd4, 0x8dc5, 0x8dc1, 0x8dcf, 0x8dd7, 0x8dc4]);
/** material types the lean path serves, and the ShaderLib entry whose uniforms refreshMaterialUniforms fills from the material */
const SHADER_OF: Record<string, string> = { MeshStandardMaterial: "standard", MeshPhysicalMaterial: "physical", MeshBasicMaterial: "basic", MeshLambertMaterial: "lambert", MeshPhongMaterial: "phong" };
/** main-pass render calls between walks of the listed modules' roots (objects a module adds later get pinned then) */
const SCAN_RENDERS = 60;
const SHADOW_NAMES = ["sunShadowMap", "directionalShadowMap", "spotShadowMap", "pointShadowMap"] as const;

/** __kr.drawList */
export interface DrawList {
  /** false: every draw goes to three (a live A/B switch) */
  on: boolean;
  readonly modules: readonly string[];
  /** why it is not running ("" while it is) */
  readonly off: string;
  /** draws served by the lean path, and pinned draws three drew instead, since the last reset */
  counts(): { lean: number; fallback: number };
  reset(): void;
}

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || ArrayBuffer.isView(a)) {
    const x = a as ArrayLike<unknown>, y = b as ArrayLike<unknown>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!equal(x[i], y[i])) return false;
    return true;
  }
  const eq = (a as { equals?: (o: unknown) => boolean }).equals;
  return typeof eq === "function" && a.constructor === b.constructor && eq.call(a, b);
};

/** what main.ts's __kr gives the list: the engine and the world modules' scene roots; the list is set as kr.drawList */
interface DrawListHost { engine: Engine; moduleRoots(id: string): THREE.Object3D[]; moduleIds(): string[]; drawList?: DrawList }

export function installDrawList(host: Record<string, unknown>): void {
  const kr = host as unknown as DrawListHost, e = kr.engine, ids = flag("drawlist"), roots = kr.moduleRoots, allIds = kr.moduleIds;
  const all = ids.includes("all"), modules = [...new Set(ids.flatMap((id) => (id === "1" ? DEFAULT_MODULES : id === "all" ? [] : [id])))];
  const r = e.renderer, gl = r.getContext() as WebGL2RenderingContext, scene = e.scene, camera = e.camera;
  const s: LeanState = {
    gl, renderer: r, camera, scene, multiDraw: gl.getExtension("WEBGL_multi_draw") as LeanState["multiDraw"], bindVao: gl.bindVertexArray, textures: null,
    sunShadowMap: null, directionalShadowMap: null, spotShadowMap: null, pointShadowMap: null, shadowSeen: false,
    epoch: 0, fog: null, env: null, glVao: null, threeVao: null, dirty: false, material: null, lean: 0, fallback: 0,
  };
  const why = r.capabilities.logarithmicDepthBuffer ? "logarithmic depth" : (r.state.buffers.depth as unknown as { getReversed?: () => boolean }).getReversed?.() ? "reversed depth" : "";
  const list: DrawList = { on: !why, modules: all ? ["all"] : modules, off: why, counts: () => ({ lean: s.lean, fallback: s.fallback }), reset: () => { s.lean = 0; s.fallback = 0; } };
  kr.drawList = list;
  if (why) return;

  // ---- what three binds and passes: its VAO, its WebGLTextures, the main pass's shadow-map arrays
  const bindVao = s.bindVao;
  gl.bindVertexArray = function (v: WebGLVertexArrayObject | null) { s.threeVao = v; s.glVao = v; bindVao.call(gl, v); };
  let capturing = false, hooked = false, uploadArmed = false;
  const hook = (program: GlProgram) => {
    const pu = program.getUniforms(), W = pu.constructor as unknown as { upload: (gl: WebGL2RenderingContext, seq: GlUniform[], v: unknown, t: GlTextures) => void };
    if (!uploadArmed) {
      uploadArmed = true;
      const up = W.upload;
      W.upload = function (g, seq, v, t) { s.textures = t; W.upload = up; uploadArmed = false; up.call(this, g, seq, v, t); };
    }
    if (hooked) return;
    hooked = true;
    const proto = Object.getPrototypeOf(pu) as GlUniforms, setValue = proto.setValue;
    proto.setValue = function (this: GlUniforms, g, name, v, t) {
      if (capturing && t !== undefined) {
        s.textures = t as GlTextures;
        for (const k of SHADOW_NAMES) if (name === k) s[k] = v as unknown[];
      }
      setValue.call(this, g, name, v, t);
    };
  };

  // ---- pinned objects and their entries
  let pinned = new WeakSet<THREE.Object3D>(), entries = new WeakMap<THREE.Object3D, Entry>();
  const byGeometry = new WeakMap<THREE.BufferGeometry, Entry[]>();
  const layouts = new Map<GlProgram, { layout: Layout; mats: Set<THREE.Material> }>();
  const props = (m: THREE.Material) => r.properties.get(m) as MatProps;
  let scans = 0;
  const scan = () => { for (const id of all ? allIds() : modules) for (const root of roots(id)) root.traverse((o) => { if ((o as THREE.Mesh).isMesh) pinned.add(o); }); };

  const onGeometryDispose = (ev: { target: THREE.BufferGeometry }) => { for (const en of byGeometry.get(ev.target) ?? []) en.dead = true; byGeometry.delete(ev.target); };
  const onMaterialDispose = (ev: { target: THREE.Material }) => {
    for (const [p, l] of layouts) if (l.mats.delete(ev.target)) { if (l.mats.size) rebuild(l.layout, l.mats, p); else layouts.delete(p); }
  };

  // which uniforms of a program can be sent once at its bind: the lights, fog, and every non-sampler uniform equal on all
  // of its pinned materials (builtins by value: refreshMaterialUniforms fills them from frozen materials; anything else
  // only when the materials share the very uniform object). The rest go out with each material, samplers always.
  // Each list is made from this program's own uniforms, as three's seqWithValue does: a material's cached uniformsList
  // belongs to whichever program three last drew it with, and a material drawn by two programs would hand one the
  // other's locations.
  const rebuild = (L: Layout, mats: Set<THREE.Material>, program: GlProgram) => {
    const ms = [...mats], seq = program.getUniforms().seq, vals = ms.map((m) => props(m).uniforms ?? {});
    const lists = vals.map((v) => seq.filter((u) => u.id in v));
    const builtin = ms.map((m) => THREE.ShaderLib[SHADER_OF[m.type]]?.uniforms ?? {});
    const shared = new Set<string>();
    for (const u of lists[0]) {
      if (LIGHT_IDS.has(u.id) || u.type === undefined || SAMPLERS.has(u.type)) continue;
      if (!lists.every((l) => l.includes(u))) continue;
      if (FOG_IDS.has(u.id) || vals.every((v) => v[u.id] === vals[0][u.id]) || (builtin.every((b) => u.id in b) && vals.every((v) => equal(v[u.id]?.value, vals[0][u.id]?.value)))) shared.add(u.id);
    }
    L.lights = lists[0].filter((u) => LIGHT_IDS.has(u.id));
    L.shared = lists[0].filter((u) => shared.has(u.id));
    L.fog = lists[0].some((u) => FOG_IDS.has(u.id));
    L.own = new Map(ms.map((m, i) => [m, lists[i].filter((u) => !LIGHT_IDS.has(u.id) && !shared.has(u.id))]));
    L.epoch = -1;
  };

  const pin = (object: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, group: object | null) => {
    const mp = props(material), program = mp.currentProgram;
    const o = object as THREE.Mesh & THREE.BatchedMesh & THREE.InstancedMesh;
    const kind = o.isBatchedMesh ? 2 : o.isInstancedMesh ? 1 : 0;
    const g = geometry as THREE.BufferGeometry & { isInstancedBufferGeometry?: boolean }, morph = g.morphAttributes;
    if (!program || !mp.uniformsList || !mp.uniforms || !o.isMesh || (o as unknown as THREE.SkinnedMesh).isSkinnedMesh || !SHADER_OF[material.type]
      || material.transparent || (material as THREE.MeshStandardMaterial).wireframe || material.clippingPlanes?.length || r.clippingPlanes.length
      || (material as THREE.ShaderMaterial).uniformsGroups?.length || morph.position || morph.normal || morph.color
      || (kind === 0 && g.isInstancedBufferGeometry) || (kind === 2 && !s.multiDraw) || s.threeVao === null) { entries.delete(object); return; }
    const old = entries.get(object);
    if (old) old.dead = true;
    let lo = layouts.get(program);
    if (!lo) layouts.set(program, (lo = { layout: { lights: [], shared: [], own: new Map(), fog: false, epoch: -1 }, mats: new Set() }));
    if (!lo.mats.has(material)) { lo.mats.add(material); material.addEventListener("dispose", onMaterialDispose); rebuild(lo.layout, lo.mats, program); }
    const arr = geometry.index?.array;
    const lights = new Int32Array(12);
    lightLayout(mp.uniforms, lights);
    const en: Entry = {
      material, geometry, group, mp, program, matVersion: material.version, lightsVersion: mp.lightsStateVersion, lights, vao: s.threeVao, layout: lo.layout, kind,
      type: arr instanceof Uint32Array ? gl.UNSIGNED_INT : arr instanceof Uint8Array ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT,
      bytes: arr instanceof Uint32Array ? 4 : arr instanceof Uint8Array ? 1 : 2,
      rtNull: r.getRenderTarget() === null, fog: scene.fog, env: scene.environment, dead: false,
    };
    entries.set(object, en);
    let gs = byGeometry.get(geometry);
    if (!gs) { byGeometry.set(geometry, (gs = [])); geometry.addEventListener("dispose", onGeometryDispose); }
    for (let i = gs.length - 1; i >= 0; i--) if (gs[i].dead) gs.splice(i, 1);
    gs.push(en);
    hook(program);
  };

  const three = r.renderBufferDirect;
  let lastFrame = -1;
  r.renderBufferDirect = function (this: THREE.WebGLRenderer, cam: THREE.Camera, sc: THREE.Scene, geometry: THREE.BufferGeometry, material: THREE.Material, object: THREE.Object3D, group: THREE.GeometryGroup) {
    if (!list.on || cam !== camera || sc !== scene) {
      handBack(s); s.epoch++;
      return three.call(this, cam, sc, geometry, material, object, group);
    }
    const frame = r.info.render.frame;
    if (frame !== lastFrame) {
      lastFrame = frame; s.epoch++; s.fog = scene.fog; s.env = scene.environment;
      if (scans++ % SCAN_RENDERS === 0) scan();
    }
    const isPinned = pinned.has(object), en = isPinned ? entries.get(object) : undefined;
    const grp = group as unknown as { start: number; count: number } | null;
    if (en !== undefined && valid(s, en, geometry, material, object, grp)) { leanDraw(s, en, geometry, material, object, grp); return; }
    handBack(s); s.epoch++;
    capturing = true;
    try { three.call(this, cam, sc, geometry, material, object, group); }
    finally { capturing = false; }
    if (props(material).needsLights) s.shadowSeen = true;
    if (isPinned) { s.fallback++; pin(object, geometry, material, grp); }
  } as unknown as typeof r.renderBufferDirect;

  // ---- context loss: three rebuilds its programs, VAOs, textures and state objects on restore; start over from them
  const canvas = r.domElement;
  canvas.addEventListener("webglcontextlost", () => {
    entries = new WeakMap(); layouts.clear(); pinned = new WeakSet(); scans = 0;
    s.textures = null; s.sunShadowMap = s.directionalShadowMap = s.spotShadowMap = s.pointShadowMap = null; s.shadowSeen = false;
    s.glVao = s.threeVao = null; s.dirty = false; s.material = null; uploadArmed = false;
  });
  canvas.addEventListener("webglcontextrestored", () => { s.multiDraw = gl.getExtension("WEBGL_multi_draw") as LeanState["multiDraw"]; });
}
