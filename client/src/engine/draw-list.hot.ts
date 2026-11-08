// The draw list's per-draw path (?drawlist, KONG-93 / RAY-237 option (c) step 2): what engine/draw-list.ts runs instead
// of three's renderBufferDirect for a pinned draw. It does what three r186's setProgram + renderBufferDirect would do for
// that draw, minus the work that cannot change the result for a validated entry: the program-change checks
// (valid() checks what they would react to), refreshMaterialUniforms (pinned materials are frozen), the whole-list
// uniform upload on a material switch (only the uniforms that differ between the materials pinned to one program are
// re-sent; the rest go out when the program is bound) and bindingStates.setup (the VAO three made for the draw is bound
// directly). Every value still goes through three's own uniform setters and renderer.state, so three's caches stay
// true; handBack() restores the two things three tracks outside them (its VAO and its current material) before three
// draws again. Allocates nothing.
import * as THREE from "three";

/** three r186's uniform objects (renderers/webgl/WebGLUniforms.js): one per active uniform of a program */
export interface GlUniform { id: string; type?: number; cache: unknown[]; setValue(gl: WebGL2RenderingContext, v: unknown, textures?: unknown): void }
/** three's WebGLUniforms of one program */
export interface GlUniforms { map: Record<string, GlUniform | undefined>; seq: GlUniform[]; setValue(gl: WebGL2RenderingContext, name: string, v: unknown, textures?: unknown): void; setOptional(gl: WebGL2RenderingContext, o: object, name: string): void }
/** three's WebGLProgram */
export interface GlProgram { program: WebGLProgram; getUniforms(): GlUniforms }
/** the fields of three's per-material renderer properties this path reads or keeps current */
export interface MatProps {
  currentProgram?: GlProgram; uniforms?: Record<string, { value: unknown; needsUpdate?: boolean }>; uniformsList?: GlUniform[] | null;
  __version?: number; needsLights?: boolean; lightsStateVersion?: number; receiveShadow?: boolean;
  batchingColor?: boolean; instancingColor?: boolean; instancingMorph?: boolean;
}
/** three's WebGLTextures, as the uniform setters use it */
export interface GlTextures { resetTextureUnits(): void }

/** what the materials pinned to one program share; draw-list.ts rebuilds it when a material joins */
export interface Layout {
  /** the light uniforms, sent when the program is bound (three: refreshLights) */
  lights: GlUniform[];
  /** non-sampler uniforms equal on every material pinned to this program: sent when the program is bound */
  shared: GlUniform[];
  /** per material: its samplers, in list order (three allocates their units in that order), and the uniforms it differs in */
  own: Map<THREE.Material, GlUniform[]>;
  /** the program has fog uniforms: they are refreshed into the bound material's values first (three: refreshFogUniforms) */
  fog: boolean;
  /** LeanState.epoch when its shared uniforms were last sent */
  epoch: number;
}

/** one pinned draw: what three's last render of it left valid, and what must still hold to skip three */
export interface Entry {
  material: THREE.Material; geometry: THREE.BufferGeometry; group: object | null;
  mp: MatProps; program: GlProgram; matVersion: number; lightsVersion: number | undefined;
  /** the light layout (lengths of the light arrays) the program was built for */
  lights: Int32Array;
  vao: WebGLVertexArrayObject | null; layout: Layout;
  /** 0 a Mesh, 1 an InstancedMesh, 2 a BatchedMesh */
  kind: number;
  /** element type and bytes per element of an indexed draw */
  type: number; bytes: number;
  /** drawn to the canvas (three picks the output colour space and tone mapping by it), the scene's fog and environment */
  rtNull: boolean; fog: unknown; env: unknown;
  dead: boolean;
}

/** everything the lean path reads and keeps, owned by draw-list.ts */
export interface LeanState {
  gl: WebGL2RenderingContext; renderer: THREE.WebGLRenderer; camera: THREE.Camera; scene: THREE.Scene;
  multiDraw: { multiDrawElementsWEBGL(...a: unknown[]): void; multiDrawArraysWEBGL(...a: unknown[]): void } | null;
  /** the context's own bindVertexArray (draw-list.ts wraps the instance's to see what three binds) */
  bindVao: (this: WebGL2RenderingContext, v: WebGLVertexArrayObject | null) => void;
  textures: GlTextures | null;
  /** the main pass's lights.state shadow-map arrays, as three last passed them to setValue (the same arrays every frame) */
  sunShadowMap: unknown[] | null; directionalShadowMap: unknown[] | null; spotShadowMap: unknown[] | null; pointShadowMap: unknown[] | null;
  /** a lit main-pass draw by three has been seen, so the arrays above are the main pass's */
  shadowSeen: boolean;
  /** bumped by every draw three makes and every render call: a lean draw after it binds its program afresh */
  epoch: number;
  /** what this render call checks entries against */
  fog: unknown; env: unknown;
  /** the VAO bound in GL, and the one three's bindingStates believes is bound */
  glVao: WebGLVertexArrayObject | null; threeVao: WebGLVertexArrayObject | null;
  /** a lean draw ran since three last drew: handBack() has work to do */
  dirty: boolean;
  /** the material whose own uniforms the bound program holds, null after a bind */
  material: THREE.Material | null;
  /** counts for __kr.drawList */
  lean: number; fallback: number;
}

const _camPos = new THREE.Vector3();

/** the light-array lengths three's WebGLLights hash is made of, read through a lit material's uniforms */
export function lightLayout(u: MatProps["uniforms"], out: Int32Array): void {
  out[0] = len(u, "sunLights"); out[1] = len(u, "directionalLights"); out[2] = len(u, "pointLights"); out[3] = len(u, "spotLights");
  out[4] = len(u, "rectAreaLights"); out[5] = len(u, "hemisphereLights"); out[6] = len(u, "sunLightShadows"); out[7] = len(u, "directionalLightShadows");
  out[8] = len(u, "pointLightShadows"); out[9] = len(u, "spotLightShadows"); out[10] = len(u, "spotLightMap"); out[11] = len(u, "spotLightMatrix");
}
function len(u: MatProps["uniforms"], k: string): number {
  const v = u?.[k]?.value as unknown[] | undefined;
  return v !== undefined && v !== null && typeof v.length === "number" ? v.length : -1;
}
function sameLights(u: MatProps["uniforms"], a: Int32Array): boolean {
  return a[0] === len(u, "sunLights") && a[1] === len(u, "directionalLights") && a[2] === len(u, "pointLights") && a[3] === len(u, "spotLights")
    && a[4] === len(u, "rectAreaLights") && a[5] === len(u, "hemisphereLights") && a[6] === len(u, "sunLightShadows") && a[7] === len(u, "directionalLightShadows")
    && a[8] === len(u, "pointLightShadows") && a[9] === len(u, "spotLightShadows") && a[10] === len(u, "spotLightMap") && a[11] === len(u, "spotLightMatrix");
}

/** the entry still describes this draw: nothing three's needsProgramChange would react to has moved (else three draws it) */
export function valid(s: LeanState, e: Entry, geometry: THREE.BufferGeometry, material: THREE.Material, object: THREE.Object3D, group: object | null): boolean {
  if (e.dead || e.material !== material || e.geometry !== geometry || e.group !== group || s.textures === null) return false;
  const mp = e.mp, r = s.renderer;
  if (r.properties.get(material) !== mp || material.version !== e.matVersion || mp.__version !== e.matVersion || mp.currentProgram !== e.program) return false;
  if (e.rtNull !== (r.getRenderTarget() === null) || e.fog !== s.fog || e.env !== s.env) return false;
  if (mp.needsLights === true && (!s.shadowSeen || mp.lightsStateVersion !== e.lightsVersion || !sameLights(mp.uniforms, e.lights))) return false;
  const o = object as THREE.Object3D & { _colorsTexture?: unknown; instanceColor?: unknown; morphTexture?: unknown };
  if (e.kind === 2) return mp.batchingColor === (o._colorsTexture !== null);
  if (e.kind === 1) return mp.instancingColor === (o.instanceColor !== null) && mp.instancingMorph === (o.morphTexture !== null);
  return true;
}

/** three's setProgram + renderBufferDirect for a validated entry */
export function leanDraw(s: LeanState, e: Entry, geometry: THREE.BufferGeometry, material: THREE.Material, object: THREE.Object3D, group: { start: number; count: number } | null): void {
  const gl = s.gl, r = s.renderer, state = r.state, mp = e.mp, pu = e.program.getUniforms(), values = mp.uniforms!, textures = s.textures!;
  const L = e.layout, cam = s.camera, scene = s.scene;
  textures.resetTextureUnits();
  let bind = state.useProgram(e.program.program);
  if (L.epoch !== s.epoch) bind = true;
  if (bind) {
    L.epoch = s.epoch;
    s.material = null;
    pu.setValue(gl, "projectionMatrix", cam.projectionMatrix);
    pu.setValue(gl, "viewMatrix", cam.matrixWorldInverse);
    const cp = pu.map.cameraPosition;
    if (cp !== undefined) cp.setValue(gl, _camPos.setFromMatrixPosition(cam.matrixWorld));
    pu.setValue(gl, "isOrthographic", (cam as THREE.OrthographicCamera).isOrthographicCamera === true);
  }
  if (mp.needsLights === true) {
    if (s.sunShadowMap !== null && s.sunShadowMap.length > 0) pu.setValue(gl, "sunShadowMap", s.sunShadowMap, textures);
    if (s.directionalShadowMap !== null && s.directionalShadowMap.length > 0) pu.setValue(gl, "directionalShadowMap", s.directionalShadowMap, textures);
    if (s.spotShadowMap !== null && s.spotShadowMap.length > 0) pu.setValue(gl, "spotShadowMap", s.spotShadowMap, textures);
    if (s.pointShadowMap !== null && s.pointShadowMap.length > 0) pu.setValue(gl, "pointShadowMap", s.pointShadowMap, textures);
  }
  if (e.kind === 2) {
    const b = object as THREE.Object3D & { _matricesTexture: unknown; _indirectTexture: unknown; _colorsTexture: unknown };
    pu.setOptional(gl, object, "batchingTexture");
    pu.setValue(gl, "batchingTexture", b._matricesTexture, textures);
    pu.setOptional(gl, object, "batchingIdTexture");
    pu.setValue(gl, "batchingIdTexture", b._indirectTexture, textures);
    pu.setOptional(gl, object, "batchingColorTexture");
    if (b._colorsTexture !== null) pu.setValue(gl, "batchingColorTexture", b._colorsTexture, textures);
  }
  const refresh = s.material !== material;
  if (refresh || mp.receiveShadow !== object.receiveShadow) {
    mp.receiveShadow = object.receiveShadow;
    pu.setValue(gl, "receiveShadow", object.receiveShadow);
  }
  const sm = material as THREE.MeshStandardMaterial;
  if ((sm.isMeshStandardMaterial || (material as THREE.MeshLambertMaterial).isMeshLambertMaterial || (material as THREE.MeshPhongMaterial).isMeshPhongMaterial)
    && sm.envMap === null && scene.environment !== null) values.envMapIntensity.value = scene.environmentIntensity;
  if (refresh) {
    s.material = material;
    if (bind) {
      pu.setValue(gl, "toneMappingExposure", r.toneMappingExposure);
      for (let i = 0; i < L.lights.length; i++) { const u = L.lights[i]; u.setValue(gl, values[u.id].value, textures); }
      const fog = scene.fog;
      if (L.fog && fog !== null && sm.fog === true) {
        // three's refreshFogUniforms; getUnlitUniformColorSpace is the output colour space on the canvas, else the working one
        if (r.getRenderTarget() === null) fog.color.getRGB(values.fogColor.value as THREE.Color, r.outputColorSpace);
        else fog.color.getRGB(values.fogColor.value as THREE.Color);
        if ((fog as THREE.Fog).isFog) { values.fogNear.value = (fog as THREE.Fog).near; values.fogFar.value = (fog as THREE.Fog).far; }
        else if ((fog as THREE.FogExp2).isFogExp2) values.fogDensity.value = (fog as THREE.FogExp2).density;
      }
      for (let i = 0; i < L.shared.length; i++) { const u = L.shared[i], v = values[u.id]; if (v.needsUpdate !== false) u.setValue(gl, v.value, textures); }
    }
    const own = L.own.get(material);
    if (own !== undefined) for (let i = 0; i < own.length; i++) { const u = own[i], v = values[u.id]; if (v.needsUpdate !== false) u.setValue(gl, v.value, textures); }
  }
  pu.setValue(gl, "modelViewMatrix", object.modelViewMatrix);
  pu.setValue(gl, "normalMatrix", object.normalMatrix);
  pu.setValue(gl, "modelMatrix", object.matrixWorld);

  (state as unknown as { setMaterial(m: THREE.Material, frontFaceCW: boolean): void }).setMaterial(material, (object as THREE.Mesh).isMesh === true && object.matrixWorld.determinantAffine() < 0);
  if (s.glVao !== e.vao) { s.bindVao.call(gl, e.vao); s.glVao = e.vao; }
  s.dirty = true;
  s.lean++;

  // three's draw-range arithmetic and buffer renderers (renderBufferDirect, WebGL(Indexed)BufferRenderer)
  const index = geometry.index, dr = geometry.drawRange;
  let start = dr.start, end = dr.start + dr.count;
  if (group !== null) { start = Math.max(start, group.start); end = Math.min(end, group.start + group.count); }
  if (index !== null) { start = Math.max(start, 0); end = Math.min(end, index.count); }
  else { const p = geometry.attributes.position; if (p !== undefined && p !== null) { start = Math.max(start, 0); end = Math.min(end, p.count); } }
  const count = end - start;
  if (count < 0 || count === Infinity) return;
  const info = r.info, TRI = gl.TRIANGLES;
  if (e.kind === 2) {
    const bm = object as unknown as { _multiDrawStarts: Int32Array; _multiDrawCounts: Int32Array; _multiDrawCount: number };
    const n = bm._multiDrawCount;
    if (n === 0) return;
    if (index !== null) s.multiDraw!.multiDrawElementsWEBGL(TRI, bm._multiDrawCounts, 0, e.type, bm._multiDrawStarts, 0, n);
    else s.multiDraw!.multiDrawArraysWEBGL(TRI, bm._multiDrawStarts, 0, bm._multiDrawCounts, 0, n);
    let elements = 0;
    for (let i = 0; i < n; i++) elements += bm._multiDrawCounts[i];
    info.update(elements, TRI, 1);
  } else if (e.kind === 1) {
    const k = (object as THREE.InstancedMesh).count;
    if (k === 0) return;
    if (index !== null) gl.drawElementsInstanced(TRI, count, e.type, start * e.bytes, k);
    else gl.drawArraysInstanced(TRI, start, count, k);
    info.update(count, TRI, k);
  } else {
    if (index !== null) gl.drawElements(TRI, count, e.type, start * e.bytes);
    else gl.drawArrays(TRI, start, count);
    info.update(count, TRI, 1);
  }
}

/** before three draws again: the VAO it believes is bound, and a program switch so it re-sends the material it thinks is loaded */
export function handBack(s: LeanState): void {
  if (!s.dirty) return;
  s.dirty = false;
  if (s.glVao !== s.threeVao) { s.bindVao.call(s.gl, s.threeVao); s.glVao = s.threeVao; }
  s.renderer.state.useProgram(null as unknown as WebGLProgram);
}
