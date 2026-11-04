// TUK-TUK FX: the two-stroke's blue-grey exhaust puffs, dust off the tyres, the smoke of a sick engine, the fire of a
// dying one, sparks from a body scraping along on its side, and — when it finally goes up — a fireball, a column of
// black smoke and its wheels, bars and banana-laden canopy sailing through the air.
//
// One instanced draw for every particle of every tuk-tuk (CPU-simulated: a few hundred soft cartoon puffs), blended
// premultiplied like the weapons FX (ONE, ONE_MINUS_SRC_ALPHA): alpha 0 = pure glow (flames, sparks), alpha > 0 = a
// shape that covers (smoke, dust). The loose pieces are real meshes thrown on a ballistic arc that bounce on the terrain.
import * as THREE from "three";

const CAP = 640;
/** floats per particle: x y z | vx vy vz | age life | size0 size1 | r g b a | drag grav | rise-fade */
const ST = 17;
interface Piece { o: THREE.Object3D; vx: number; vy: number; vz: number; wx: number; wy: number; wz: number; life: number; r: number }

export class TukFx {
  readonly object = new THREE.Group();
  private readonly P = new Float32Array(CAP * ST);
  private n = 0;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly aPos = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
  private readonly aCol = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
  private readonly pieces: Piece[] = [];
  private seed = 1337;
  constructor(scene: THREE.Scene, private readonly ground: (x: number, z: number) => number) {
    this.geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    this.geo.setIndex([0, 1, 2, 1, 3, 2]);
    this.aPos.setUsage(THREE.DynamicDrawUsage); this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("iPos", this.aPos); this.geo.setAttribute("iCol", this.aCol);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, toneMapped: true, fog: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      vertexShader: /* glsl */ `
        attribute vec4 iPos; attribute vec4 iCol; varying vec2 vUv; varying vec4 vCol;
        void main() {
          vUv = position.xy; vCol = iCol;
          vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
          mv.xy += position.xy * iPos.w;
          gl_Position = projectionMatrix * mv;
        }`,
      // a firm-edged cartoon puff with a lit top and a darker belly (the weapons FX's look), or a glow when alpha is 0
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec4 vCol;
        void main() {
          float d = length(vUv);
          if (d > 1.0) discard;
          float glow = step(vCol.a, 0.001);
          float shape = mix(smoothstep(1.0, 0.5, d), pow(1.0 - d, 1.6), glow);
          float lit = mix(0.8 + 0.26 * smoothstep(-0.9, 0.9, vUv.y), 1.0, glow);
          gl_FragColor = vec4(vCol.rgb * lit * shape, vCol.a * shape);
        }`,
    });
    const mesh = new THREE.Mesh(this.geo, mat); mesh.name = "tuk-fx"; mesh.frustumCulled = false; mesh.renderOrder = 4;
    mesh.userData.castShadow = false; mesh.userData.farShadow = false;
    this.object.add(mesh); this.object.name = "tuk-fx";
    scene.add(this.object);
  }
  private rnd() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0; return ((this.seed >>> 8) & 0xffff) / 65536; }
  /** one particle: colour premultiplied by the caller's alpha (a = 0: additive glow) */
  private add(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, a: number, drag: number, grav: number) {
    let i = this.n;
    if (i >= CAP) { i = Math.floor(this.rnd() * CAP); } else this.n++;
    const o = i * ST, P = this.P;
    P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = vx; P[o + 4] = vy; P[o + 5] = vz; P[o + 6] = 0; P[o + 7] = life; P[o + 8] = s0; P[o + 9] = s1;
    P[o + 10] = r; P[o + 11] = g; P[o + 12] = b; P[o + 13] = a; P[o + 14] = drag; P[o + 15] = grav; P[o + 16] = 0;
  }
  /** the engine's putt: one small blue-grey puff out of the pipe (dx, dz = the way it blows) */
  exhaust(p: THREE.Vector3, dx: number, dz: number, hard: number) {
    const k = 0.5 + this.rnd() * 0.5, a = 0.16 + 0.12 * hard;
    this.add(p.x, p.y, p.z, dx * (0.9 + hard * 1.6) * k, 0.35 + this.rnd() * 0.5, dz * (0.9 + hard * 1.6) * k, 0.4 + this.rnd() * 0.25, 0.05, 0.2 + hard * 0.14, 0.72 * a, 0.74 * a, 0.8 * a, a, 2.6, -0.5);
  }
  /** a backfire: a lick of flame at the pipe */
  backfire(p: THREE.Vector3, dx: number, dz: number) {
    for (let i = 0; i < 5; i++) this.add(p.x, p.y, p.z, dx * (2 + this.rnd() * 3), 0.4 * this.rnd(), dz * (2 + this.rnd() * 3), 0.12 + this.rnd() * 0.1, 0.22, 0.05, 2.6, 1.2, 0.3, 0, 4, 0);
    for (let i = 0; i < 3; i++) this.exhaust(p, dx, dz, 1);
  }
  /** dust off a tyre / a sliding body: `c` = the ground's colour (linear rgb) */
  dust(x: number, y: number, z: number, vx: number, vz: number, c: readonly [number, number, number], big = 1) {
    const a = 0.26 + this.rnd() * 0.14;
    this.add(x + (this.rnd() - 0.5) * 0.3, y + 0.1, z + (this.rnd() - 0.5) * 0.3, vx + (this.rnd() - 0.5) * 1.2, 0.5 + this.rnd() * 0.9, vz + (this.rnd() - 0.5) * 1.2, 0.7 + this.rnd() * 0.6, 0.18 * big, (0.7 + this.rnd() * 0.5) * big, c[0] * a, c[1] * a, c[2] * a, a, 1.6, -0.3);
  }
  /** smoke off a hurt engine: `dark` 0 = thin grey … 1 = thick and black */
  smoke(p: THREE.Vector3, dark: number, vx = 0, vz = 0) {
    const v = 0.5 - 0.42 * dark, a = 0.3 + 0.32 * dark;
    this.add(p.x + (this.rnd() - 0.5) * 0.3, p.y, p.z + (this.rnd() - 0.5) * 0.3, vx * 0.3 + (this.rnd() - 0.5) * 0.5, 1.2 + this.rnd() * 1.2 + dark, vz * 0.3 + (this.rnd() - 0.5) * 0.5, 1.2 + this.rnd() * 0.9 + dark * 0.8, 0.22, 0.9 + dark * 0.9, v * a, v * a * 0.97, v * a * 0.94, a, 0.7, -0.6);
  }
  /** flames licking off it: tongues of fire over an area `spread` m wide round p, a bright core under them */
  flame(p: THREE.Vector3, size = 1, vx = 0, vz = 0, spread = 0.5) {
    const h = this.rnd();
    this.add(p.x + (this.rnd() - 0.5) * spread * 2, p.y + this.rnd() * 0.25, p.z + (this.rnd() - 0.5) * spread * 2, vx * 0.4 + (this.rnd() - 0.5) * 0.6, 2 + this.rnd() * 2.2, vz * 0.4 + (this.rnd() - 0.5) * 0.6, 0.32 + this.rnd() * 0.3, (0.5 + this.rnd() * 0.4) * size, 0.08, 2.6, 0.75 + 0.95 * h, 0.12 + 0.22 * h, 0, 0.6, -1.4);
    if (this.rnd() < 0.35) this.add(p.x + (this.rnd() - 0.5) * spread, p.y + 0.1, p.z + (this.rnd() - 0.5) * spread, vx * 0.4, 1.2, vz * 0.4, 0.2, 0.55 * size, 0.2, 3.0, 2.2, 0.9, 0, 0.5, 0);
    if (this.rnd() < 0.2) this.add(p.x, p.y + 0.3, p.z, (this.rnd() - 0.5) * 3, 2.5 + this.rnd() * 3, (this.rnd() - 0.5) * 3, 0.5 + this.rnd() * 0.5, 0.045, 0.02, 3.2, 1.8, 0.4, 0, 0.4, 5);   // a rising ember
  }
  sparks(x: number, y: number, z: number, vx: number, vz: number, n: number) {
    for (let i = 0; i < n; i++) this.add(x, y, z, vx * 0.4 + (this.rnd() - 0.5) * 6, 1.5 + this.rnd() * 4, vz * 0.4 + (this.rnd() - 0.5) * 6, 0.3 + this.rnd() * 0.45, 0.05, 0.02, 3.2, 1.9, 0.5, 0, 0.6, 16);
  }
  /** it goes up: a fireball, a rolling column of black smoke, a spray of sparks */
  blast(x: number, y: number, z: number) {
    for (let i = 0; i < 26; i++) { const a = this.rnd() * 6.283, e = this.rnd() * 1.3, s = 4 + this.rnd() * 9; this.add(x, y + 0.4, z, Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + 2, Math.sin(a) * Math.cos(e) * s, 0.45 + this.rnd() * 0.5, 1.5 + this.rnd(), 0.3, 2.8, 1.0 + this.rnd() * 0.9, 0.2, 0, 2.6, -1.5); }
    for (let i = 0; i < 34; i++) { const a = this.rnd() * 6.283, s = 1 + this.rnd() * 4.5, al = 0.5 + this.rnd() * 0.2, v = 0.07 + this.rnd() * 0.08; this.add(x + Math.cos(a) * 0.8, y + 0.4 + this.rnd() * 1.4, z + Math.sin(a) * 0.8, Math.cos(a) * s, 2.5 + this.rnd() * 5, Math.sin(a) * s, 2.2 + this.rnd() * 1.8, 0.9, 2.6 + this.rnd() * 1.6, v * al, v * al, v * al, al, 1.1, -0.8); }
    this.sparks(x, y + 0.6, z, 0, 0, 46);
  }
  /** loose pieces (actors/tuktuk.ts tukDebris) thrown clear from (x, y, z) */
  throwPieces(list: THREE.Object3D[], x: number, y: number, z: number) {
    list.forEach((o, i) => {
      const a = (i / list.length) * 6.283 + this.rnd() * 1.2, s = 5 + this.rnd() * 6;
      o.position.set(x + Math.cos(a) * 0.7, y + 0.8 + this.rnd() * 0.8, z + Math.sin(a) * 0.7);
      this.object.add(o);
      this.pieces.push({ o, vx: Math.cos(a) * s, vy: 8 + this.rnd() * 6, vz: Math.sin(a) * s, wx: (this.rnd() - 0.5) * 16, wy: (this.rnd() - 0.5) * 8, wz: (this.rnd() - 0.5) * 16, life: 6 + this.rnd() * 2, r: i < 3 ? 0.36 : 0.25 });
    });
  }
  update(dt: number) {
    dt = Math.min(dt, 0.05);
    const P = this.P, A = this.aPos.array as Float32Array, C = this.aCol.array as Float32Array;
    let n = this.n;
    for (let i = 0; i < n;) {
      const o = i * ST;
      P[o + 6] += dt;
      if (P[o + 6] >= P[o + 7]) { n--; if (i < n) P.copyWithin(o, n * ST, n * ST + ST); continue; }
      const dk = Math.exp(-P[o + 14] * dt);
      P[o + 3] *= dk; P[o + 5] *= dk; P[o + 4] = P[o + 4] * dk - P[o + 15] * dt;
      P[o] += P[o + 3] * dt; P[o + 1] += P[o + 4] * dt; P[o + 2] += P[o + 5] * dt;
      const k = P[o + 6] / P[o + 7], fade = k < 0.12 ? k / 0.12 : 1 - Math.pow((k - 0.12) / 0.88, 1.7);
      A[i * 4] = P[o]; A[i * 4 + 1] = P[o + 1]; A[i * 4 + 2] = P[o + 2]; A[i * 4 + 3] = P[o + 8] + (P[o + 9] - P[o + 8]) * (1 - (1 - k) * (1 - k));
      C[i * 4] = P[o + 10] * fade; C[i * 4 + 1] = P[o + 11] * fade; C[i * 4 + 2] = P[o + 12] * fade; C[i * 4 + 3] = P[o + 13] * fade;
      i++;
    }
    this.n = n; this.geo.instanceCount = n;
    if (n > 0) { this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aPos.clearUpdateRanges(); this.aPos.addUpdateRange(0, n * 4); this.aCol.clearUpdateRanges(); this.aCol.addUpdateRange(0, n * 4); }
    // the loose pieces: fall, tumble, bounce, come to rest, then sink away
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const q = this.pieces[i], o = q.o;
      q.life -= dt;
      if (q.life <= 0) { o.removeFromParent(); this.pieces.splice(i, 1); continue; }
      q.vy -= 24 * dt;
      o.position.x += q.vx * dt; o.position.y += q.vy * dt; o.position.z += q.vz * dt;
      o.rotation.x += q.wx * dt; o.rotation.y += q.wy * dt; o.rotation.z += q.wz * dt;
      const g = Math.max(this.ground(o.position.x, o.position.z), -0.4) + q.r;
      if (o.position.y < g) {
        o.position.y = g;
        if (q.vy < -2.5) { q.vy = -q.vy * 0.42; q.vx *= 0.7; q.vz *= 0.7; q.wx *= 0.6; q.wy *= 0.6; q.wz *= 0.6; }
        else { q.vy = 0; const f = Math.exp(-dt * 4); q.vx *= f; q.vz *= f; q.wx *= f; q.wy *= f; q.wz *= f; }
      }
      if (q.life < 1) o.scale.setScalar(Math.max(0.01, q.life));
    }
  }
  dispose() { this.object.removeFromParent(); this.geo.dispose(); this.object.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) (m as THREE.Material).dispose(); }); for (const q of this.pieces) q.o.removeFromParent(); this.pieces.length = 0; }
}
