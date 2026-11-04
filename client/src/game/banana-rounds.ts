// TOP BANANA's rounds: bananas streaking out of the door gun, tumbling as they go.
// Cosmetic only (the round itself is hitscan, shared/sim/heli.ts): each one flies from the barrels to where its round
// stopped at SPEED m/s and vanishes there. One instanced mesh, a fixed pool, zero allocations per frame.
import * as THREE from "three";
import type { Scope } from "../engine/res/scope";

const MAX = 48;
/** m/s: fast enough to read as gunfire, slow enough to see the fruit */
const SPEED = 140;
/** a banana's length (m) — big enough to read at range */
const LEN = 0.42;

/** a curved banana along +Z: a tapered tube round an arc, brown stalk and tip (vertex colours) */
function bananaGeometry(): THREE.BufferGeometry {
  const seg = 14, rad = 8, R = LEN * 0.9, arc = 1.0;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const Y = new THREE.Color(0xf6d21c).convertSRGBToLinear(), B = new THREE.Color(0x4b3112).convertSRGBToLinear(), G = new THREE.Color(0xc9c43a).convertSRGBToLinear();
  for (let i = 0; i <= seg; i++) {
    const u = i / seg, a = (u - 0.5) * arc;
    // the spine: an arc in the YZ plane bowing up
    const cz = Math.sin(a) * R, cy = (Math.cos(a) - Math.cos(arc / 2)) * R * 0.9;
    const tz = Math.cos(a), ty = -Math.sin(a);
    const r = 0.055 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, u * 0.94 + 0.03))), 0.65) + 0.006;
    for (let j = 0; j < rad; j++) {
      const t = (j / rad) * Math.PI * 2, cx = Math.cos(t), sy = Math.sin(t);
      // the cross-section's "up" is perpendicular to the spine in YZ: (0, tz, -ty)
      pos.push(cx * r, cy + sy * r * tz, cz - sy * r * ty);
      const c = u < 0.07 ? B : u > 0.95 ? B : u > 0.85 ? G.clone().lerp(Y, (0.95 - u) / 0.1) : Y;
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < rad; j++) {
    const a = i * rad + j, b = i * rad + ((j + 1) % rad), c = a + rad, d = b + rad;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export class BananaRounds {
  readonly mesh: THREE.InstancedMesh;
  private from = new Float32Array(MAX * 3); private dir = new Float32Array(MAX * 3);
  private dist = new Float32Array(MAX); private t = new Float32Array(MAX); private spin = new Float32Array(MAX); private live = new Uint8Array(MAX);
  private next = 0;
  private readonly M = new THREE.Matrix4(); private readonly Q = new THREE.Quaternion(); private readonly Q2 = new THREE.Quaternion();
  private readonly P = new THREE.Vector3(); private readonly S = new THREE.Vector3(1, 1, 1); private readonly Z = new THREE.Vector3(0, 0, 1); private readonly X = new THREE.Vector3(1, 0, 0); private readonly D = new THREE.Vector3();
  constructor(scene: THREE.Scene, res: Scope) {
    const mat = res.material(new THREE.MeshStandardMaterial({ name: "banana-round", vertexColors: true, roughness: 0.45, metalness: 0, emissive: 0x3a2a00, emissiveIntensity: 0.6 }));
    this.mesh = res.own("geo.actor", new THREE.InstancedMesh(res.geometry("geo.actor", bananaGeometry()), mat, MAX), () => this.mesh.instanceMatrix.array.byteLength);
    this.mesh.name = "banana-rounds"; this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.castShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    res.defer(() => this.mesh.removeFromParent());
  }
  /** a banana from the barrels (a) toward where the round stopped (b) */
  spawn(a: THREE.Vector3, b: THREE.Vector3) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
    if (d < 1.5) return;
    const i = this.next; this.next = (this.next + 1) % MAX;
    this.from[i * 3] = a.x; this.from[i * 3 + 1] = a.y; this.from[i * 3 + 2] = a.z;
    this.dir[i * 3] = dx / d; this.dir[i * 3 + 1] = dy / d; this.dir[i * 3 + 2] = dz / d;
    this.dist[i] = Math.min(d, 320); this.t[i] = 0; this.spin[i] = Math.random() * Math.PI * 2; this.live[i] = 1;
  }
  update(dt: number) {
    let n = 0;
    for (let i = 0; i < MAX; i++) {
      if (!this.live[i]) continue;
      this.t[i] += dt * SPEED;
      if (this.t[i] >= this.dist[i]) { this.live[i] = 0; continue; }
      this.spin[i] += dt * 22;
      const s = this.t[i];
      this.P.set(this.from[i * 3] + this.dir[i * 3] * s, this.from[i * 3 + 1] + this.dir[i * 3 + 1] * s, this.from[i * 3 + 2] + this.dir[i * 3 + 2] * s);
      this.D.set(this.dir[i * 3], this.dir[i * 3 + 1], this.dir[i * 3 + 2]);
      // along the flight, tumbling end over end a little and rolling round it
      this.Q.setFromUnitVectors(this.Z, this.D);
      this.Q2.setFromAxisAngle(this.Z, this.spin[i]); this.Q.multiply(this.Q2);
      this.Q2.setFromAxisAngle(this.X, Math.sin(this.spin[i] * 0.5) * 0.35); this.Q.multiply(this.Q2);
      // a fresh banana grows out of the muzzle over its first metre
      const g = Math.min(1, 0.35 + s / 1.5); this.S.setScalar(g);
      this.M.compose(this.P, this.Q, this.S);
      this.mesh.setMatrixAt(n++, this.M);
    }
    this.mesh.count = n;
    if (n) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
