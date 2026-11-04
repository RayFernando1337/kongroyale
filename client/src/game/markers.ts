// MAP MARKER BEAMS: every map marker — yours, and in trios your
// squadmates' (shared through the server, see ClientMatch.squadMarks) — stands in the world as a tall beam of light in
// its owner's colour, with a pulsing ring on the ground.
//
// One camera-facing vertical quad (cylindrical billboard) + one ground ring per marker, additive, no fog: readable from
// across the island. The beam keeps a minimum width on screen (it grows with distance) and fades to a faint thread
// within ~40 m of the camera, so it never blocks your aim at the spot itself. ≤ MAX beams, two draws each, nothing per
// frame but a few uniforms; no allocations.
import * as THREE from "three";
import type { Scope } from "../engine/res/scope";

export const BEAM_H = 1400;
const MAX = 4;

const BEAM_VERT = /* glsl */ `
  uniform vec3 uBase; uniform float uW;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 to = cameraPosition - uBase; to.y = 0.0;
    float l = length(to); vec3 side = l > 1e-3 ? vec3(-to.z, 0.0, to.x) / l : vec3(1.0, 0.0, 0.0);
    vec3 p = uBase + side * (position.x * uW) + vec3(0.0, position.y * ${BEAM_H.toFixed(1)}, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;
const BEAM_FRAG = /* glsl */ `
  uniform vec3 uCol; uniform float uA; uniform float uT; uniform float uCore;
  varying vec2 vUv;
  void main() {
    float x = vUv.x * 2.0 - 1.0, h = vUv.y;
    // three layers across the column: a white-hot core, a saturated inner column, a wide soft outer glow
    float core = exp(-x * x * uCore), inner = exp(-x * x * 14.0), outer = exp(-x * x * 2.4);
    // bright all the way up (slow falloff), dissolving only near the top
    float vert = smoothstep(0.0, 0.004, h) * pow(1.0 - h, 0.7) * (1.0 - smoothstep(0.82, 1.0, h));
    float shimmer = 0.88 + 0.12 * sin(h * 220.0 - uT * 2.6);
    float k = vert * shimmer * uA;
    vec3 c = mix(uCol, vec3(1.0), core * 0.45);
    // premultiplied "over" + add: the glow tints what is behind it (a saturated tower even on a bright sky), the core glows
    gl_FragColor = vec4((c * core * 2.6 + uCol * (inner * 1.1 + outer * 0.4)) * k, clamp((inner * 0.55 + outer * 0.22) * k, 0.0, 0.8));
  }`;
const RING_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FRAG = /* glsl */ `
  uniform vec3 uCol; uniform float uA; uniform float uT;
  varying vec2 vUv;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    float p = fract(uT * 0.45);
    float wave = exp(-pow((r - p) * 14.0, 2.0)) * (1.0 - p);
    float rim = exp(-pow((r - 0.96) * 30.0, 2.0)) * 0.55, fill = (1.0 - smoothstep(0.0, 1.0, r)) * 0.18;
    gl_FragColor = vec4(uCol * (wave + rim + fill) * uA * step(r, 1.0), 1.0);
  }`;

interface Beam { beam: THREE.Mesh; ring: THREE.Mesh; bm: THREE.ShaderMaterial; rm: THREE.ShaderMaterial; key: string; k: number; x: number; y: number; z: number }

/** one marker to show this frame */
export interface MarkerSpec { x: number; z: number; color: string; /** stable id (owner) — a new spot restarts the rise */ key: string }

export class MarkerBeams {
  readonly group = new THREE.Group();
  private beams: Beam[] = [];
  private t = 0;
  constructor(scene: THREE.Scene, private ground: (x: number, z: number) => number, res: Scope) {
    this.group.name = "marker-beams";
    const quad = res.geometry("geo.actor", new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0));
    const disc = res.geometry("geo.actor", new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    for (let i = 0; i < MAX; i++) {
      const bm = new THREE.ShaderMaterial({
        name: "marker-beam", vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
        uniforms: { uBase: { value: new THREE.Vector3() }, uW: { value: 3 }, uCol: { value: new THREE.Color() }, uA: { value: 0 }, uT: { value: 0 }, uCore: { value: 40 } },
        transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        toneMapped: false, side: THREE.DoubleSide,
      });
      const rm = new THREE.ShaderMaterial({
        name: "marker-ring", vertexShader: RING_VERT, fragmentShader: RING_FRAG,
        uniforms: { uCol: { value: new THREE.Color() }, uA: { value: 0 }, uT: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      });
      res.material(bm); res.material(rm);
      const beam = new THREE.Mesh(quad, bm), ring = new THREE.Mesh(disc, rm);
      for (const m of [beam, ring]) { m.frustumCulled = false; m.visible = false; m.castShadow = false; m.receiveShadow = false; m.userData.castShadow = false; m.renderOrder = 9; this.group.add(m); }
      this.beams.push({ beam, ring, bm, rm, key: "", k: 0, x: 0, y: 0, z: 0 });
    }
    scene.add(this.group);
    res.defer(() => this.group.removeFromParent());
  }
  /** this frame's markers (≤ MAX; the first is drawn first) and the camera */
  update(dt: number, cam: THREE.Vector3, list: ReadonlyArray<MarkerSpec>) {
    this.t += dt;
    for (let i = 0; i < MAX; i++) {
      const b = this.beams[i], m = list[i];
      if (!m) { b.beam.visible = b.ring.visible = false; b.key = ""; continue; }
      const key = `${m.key}|${m.x.toFixed(1)}|${m.z.toFixed(1)}`;
      if (key !== b.key) { b.key = key; b.k = 0; b.x = m.x; b.z = m.z; b.y = Math.max(0, this.ground(m.x, m.z)) - 0.5; (b.bm.uniforms.uCol.value as THREE.Color).set(m.color); (b.rm.uniforms.uCol.value as THREE.Color).set(m.color); }
      b.k = Math.min(1, b.k + dt / 0.6);
      const d = Math.hypot(cam.x - b.x, cam.z - b.z);
      // a few pixels wide at any range; a faint thread near you (it never sits in your sights at the spot itself)
      const near = 0.1 + 0.9 * smooth((d - 10) / 35);
      const rise = b.k * b.k * (3 - 2 * b.k);
      (b.bm.uniforms.uBase.value as THREE.Vector3).set(b.x, b.y, b.z);
      b.bm.uniforms.uW.value = Math.max(4, d * 0.05);
      b.bm.uniforms.uCore.value = 90;
      b.bm.uniforms.uA.value = rise * near * (d > 900 ? 1.25 : 1);
      b.bm.uniforms.uT.value = this.t;
      b.beam.visible = true;
      const rs = 3.2 + 0.6 * Math.sin(this.t * 2.2);
      b.ring.position.set(b.x, b.y + 0.6, b.z); b.ring.scale.set(rs * 2, 1, rs * 2);
      b.rm.uniforms.uA.value = rise * (0.35 + 0.65 * smooth((d - 6) / 20)) * (d > 250 ? Math.max(0, 1 - (d - 250) / 150) : 1);
      b.rm.uniforms.uT.value = this.t;
      b.ring.visible = b.rm.uniforms.uA.value > 0.01;
    }
  }
}
const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
