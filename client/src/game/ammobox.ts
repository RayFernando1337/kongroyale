// AMMO BOXES: the loot generator's third container. Olive painted-steel crates with a hinged lid, two
// latches, end handles and a stencilled "AMMO" plate — smaller and quieter than a chest (no
// glow, no hum), so a house holds one or two without looking like a chest room. Drawn as three InstancedMeshes (body,
// lid, interior) holding only the boxes within BOX_R of the camera; the lid of a box that opens swings back in 0.35 s.
import * as THREE from "three";
import type { Scope } from "../engine/res/scope";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Chest } from "../../../shared/sim/loot";
import { AMMO_CRATE } from "../../../shared/sim/crate";

// drawn to 140 m, shrinking away over the last 35 m (was a hard cut at 110 m)
const W = 0.76, H = 0.36, D = 0.44, LID_H = 0.075, MAX = 768, BOX_R = 140, BOX_FADE_R = 105;
const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
// the open angle the loot generator validates against walls (was 1.95 rad = 112°: a box by a
// wall swung its lid through it)
const OPEN_A = -AMMO_CRATE.open, OPEN_S = 0.3;

function sideTex(): THREE.CanvasTexture {
  const S = 512, h = 256, c = document.createElement("canvas"); c.width = S; c.height = h;
  const x = c.getContext("2d")!;
  let sd = 11; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#6f7d3a"); g.addColorStop(1, "#56622a"); x.fillStyle = g; x.fillRect(0, 0, S, h);
  for (let i = 0; i < 70; i++) { x.fillStyle = `rgba(${r() < 0.5 ? "38,44,16" : "150,160,92"},${0.05 + r() * 0.08})`; x.beginPath(); x.ellipse(r() * S, r() * h, 12 + r() * 50, 4 + r() * 12, r() * 3, 0, Math.PI * 2); x.fill(); }
  for (let i = 0; i < 26; i++) { x.fillStyle = "rgba(40,36,20,.10)"; x.fillRect(r() * S, r() * h * 0.3, 1 + r() * 2, 20 + r() * 60); }
  x.strokeStyle = "rgba(30,36,12,.85)"; x.lineWidth = 7; x.strokeRect(5, 5, S - 10, h - 10);
  x.strokeStyle = "rgba(196,206,130,.32)"; x.lineWidth = 2; x.strokeRect(12, 12, S - 24, h - 24);
  for (const [px, py] of [[20, 20], [S - 20, 20], [20, h - 20], [S - 20, h - 20]]) { x.fillStyle = "#3a4119"; x.beginPath(); x.arc(px, py, 6, 0, 7); x.fill(); x.fillStyle = "rgba(220,226,170,.45)"; x.beginPath(); x.arc(px - 1.5, py - 1.5, 2.4, 0, 7); x.fill(); }
  // the stencil plate: a cream panel, three fat rounds and AMMO
  x.fillStyle = "rgba(232,222,170,.92)"; x.fillRect(S * 0.2, h * 0.24, S * 0.6, h * 0.52);
  x.strokeStyle = "rgba(40,40,20,.7)"; x.lineWidth = 3; x.strokeRect(S * 0.2, h * 0.24, S * 0.6, h * 0.52);
  for (let k = 0; k < 3; k++) {
    const bx = S * 0.25 + k * 26, by = h * 0.33;
    x.fillStyle = "#2c2f18"; x.fillRect(bx, by + 22, 17, 50); x.beginPath(); x.moveTo(bx, by + 22); x.quadraticCurveTo(bx + 8.5, by - 6, bx + 17, by + 22); x.fill();
  }
  x.fillStyle = "#2c2f18"; x.font = "900 64px Impact, 'Arial Black', sans-serif"; x.textBaseline = "middle"; x.fillText("AMMO", S * 0.42, h * 0.52);
  // wear: chipped paint along the edges showing steel
  for (let i = 0; i < 260; i++) {
    const e = r(), side = Math.floor(r() * 4), t = r();
    const px = side < 2 ? t * S : side === 2 ? e * 14 : S - e * 14, py = side === 0 ? e * 14 : side === 1 ? h - e * 14 : t * h;
    x.fillStyle = r() < 0.7 ? `rgba(150,150,140,${0.35 + r() * 0.4})` : `rgba(90,60,30,${0.3 + r() * 0.3})`;
    x.fillRect(px, py, 1 + r() * 4, 1 + r() * 3);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function innerTex(): THREE.CanvasTexture {
  const S = 256, h = 128, c = document.createElement("canvas"); c.width = S; c.height = h;
  const x = c.getContext("2d")!;
  x.fillStyle = "#1d2010"; x.fillRect(0, 0, S, h);
  for (let row = 0; row < 2; row++) for (let k = 0; k < 11; k++) {
    const cx = 22 + k * 21.5, cy = 36 + row * 54;
    const g = x.createRadialGradient(cx - 3, cy - 3, 1, cx, cy, 10); g.addColorStop(0, "#fff0b0"); g.addColorStop(0.45, "#d6a43c"); g.addColorStop(1, "#6a4a12");
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, 9, 0, 7); x.fill();
    x.fillStyle = "#b07a30"; x.beginPath(); x.arc(cx, cy, 3.4, 0, 7); x.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** non-indexed copy with a per-vertex colour (multiplies the texture) and a UV set (steel fittings sample the plain rim) */
function tint(g: THREE.BufferGeometry, c: readonly [number, number, number], plainUv = false): THREE.BufferGeometry {
  const q = g.index ? g.toNonIndexed() : g;
  const n = q.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; }
  q.setAttribute("color", new THREE.BufferAttribute(a, 3));
  if (plainUv || !q.attributes.uv) { const uv = new Float32Array(n * 2); for (let i = 0; i < n; i++) { uv[i * 2] = 0.1; uv[i * 2 + 1] = 0.5; } q.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); }
  if (!q.attributes.normal) q.computeVertexNormals();
  return q;
}
const PAINT = [1, 1, 1] as const, LIDC = [0.93, 0.95, 0.88] as const, STEEL = [0.34, 0.35, 0.32] as const;
function at(g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry { g.rotateY(ry); g.translate(x, y, z); return tint(g, STEEL, true); }

function buildGeos() {
  const bh = H - LID_H;
  const body = new RoundedBoxGeometry(W, bh, D, 3, 0.025); body.translate(0, bh / 2, 0);
  const parts: THREE.BufferGeometry[] = [tint(body, PAINT)];
  parts.push(at(new RoundedBoxGeometry(W + 0.02, 0.035, D + 0.02, 2, 0.01), 0, 0.0175, 0));          // base skid
  for (const sx of [-0.22, 0.22]) parts.push(at(new RoundedBoxGeometry(0.075, 0.11, 0.035, 2, 0.008), sx, bh - 0.035, D / 2 + 0.012)); // latches
  for (const sx of [-1, 1]) parts.push(at(new THREE.TorusGeometry(0.07, 0.013, 6, 12, Math.PI), sx * (W / 2 + 0.004), H * 0.5, 0, sx > 0 ? Math.PI / 2 : -Math.PI / 2)); // end handles
  const base = mergeGeometries(parts, false)!;
  // the lid hinges at its back top edge: geometry origin ON the hinge line, extending to +Z
  const L = D + 0.025;
  const lid = new RoundedBoxGeometry(W + 0.025, LID_H, L, 3, 0.02); lid.translate(0, LID_H / 2, L / 2);
  const bar = new THREE.CylinderGeometry(0.014, 0.014, 0.28, 8); bar.rotateZ(Math.PI / 2);
  const lidParts = [tint(lid, LIDC), at(bar, 0, LID_H + 0.035, L / 2)];
  for (const sx of [-0.14, 0.14]) lidParts.push(at(new THREE.BoxGeometry(0.02, 0.04, 0.02), sx, LID_H + 0.015, L / 2));
  const lidG = mergeGeometries(lidParts, false)!;
  const inner = new THREE.PlaneGeometry(W - 0.06, D - 0.06); inner.rotateX(-Math.PI / 2); inner.translate(0, bh + 0.002, 0);
  return { base, lid: lidG, inner };
}

const M4 = new THREE.Matrix4(), M4b = new THREE.Matrix4(), M4c = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), SC = new THREE.Vector3(1, 1, 1);
const AX = new THREE.Vector3(1, 0, 0), UP = new THREE.Vector3(0, 1, 0);

export class AmmoBoxes {
  readonly group = new THREE.Group();
  private base: THREE.InstancedMesh; private lid: THREE.InstancedMesh; private inner: THREE.InstancedMesh;
  /** chest id → instance slot; lid angle (0 closed … OPEN_A) */
  private slot = new Map<number, number>(); private ang = new Map<number, number>(); private sc = new Map<number, number>();
  private animating = new Set<number>();
  constructor(res: Scope) {
    const g = buildGeos();
    for (const geo of [g.base, g.lid, g.inner]) res.geometry("geo.world", geo);
    const mat = res.material(new THREE.MeshStandardMaterial({ map: res.texture("tex.world", sideTex()), vertexColors: true, roughness: 0.58, metalness: 0.28 }));
    const imat = res.material(new THREE.MeshStandardMaterial({ map: res.texture("tex.world", innerTex()), roughness: 0.45, metalness: 0.5 }));
    const mk = (geo: THREE.BufferGeometry, m: THREE.Material, name: string, shadow: boolean) => {
      const x = new THREE.InstancedMesh(geo, m, MAX); x.name = name; x.count = 0; x.castShadow = shadow; x.receiveShadow = true; x.frustumCulled = false; this.group.add(x); return x;
    };
    this.base = mk(g.base, mat, "ammobox-body", true); this.lid = mk(g.lid, mat, "ammobox-lid", true); this.inner = mk(g.inner, imat, "ammobox-inner", false);
    this.group.name = "ammo-boxes";
    res.defer(() => this.group.removeFromParent());
  }
  /** the boxes within BOX_R of (cx, cz), nearest first (the loot cull tick, ≤ 2.5 Hz) */
  sync(chests: Chest[], cx: number, cz: number) {
    const list: Array<[number, Chest]> = [];
    for (const c of chests) { if (!c.box) continue; const d = (c.x - cx) ** 2 + (c.z - cz) ** 2; if (d < BOX_R * BOX_R) list.push([d, c]); }
    list.sort((a, b) => a[0] - b[0]);
    const shown = list.slice(0, MAX);
    this.slot.clear();
    shown.forEach(([d2, c], i) => {
      this.slot.set(c.id, i); if (!this.ang.has(c.id)) this.ang.set(c.id, c.opened ? OPEN_A : 0);
      const d = Math.sqrt(d2); this.sc.set(c.id, d > BOX_FADE_R ? Math.max(0.001, 1 - smooth01((d - BOX_FADE_R) / (BOX_R - BOX_FADE_R))) : 1);
      this.write(i, c);
    });
    this.base.count = this.lid.count = this.inner.count = shown.length;
    this.base.instanceMatrix.needsUpdate = this.lid.instanceMatrix.needsUpdate = this.inner.instanceMatrix.needsUpdate = true;
  }
  private write(i: number, c: Chest) {
    Q.setFromAxisAngle(UP, c.yaw); P.set(c.x, c.y, c.z);
    M4.compose(P, Q, SC.setScalar(this.sc.get(c.id) ?? 1)); this.base.setMatrixAt(i, M4); this.inner.setMatrixAt(i, M4);
    // hinge: the back top edge (local z = −D/2 − 0.0125, y = body height); the lid swings up and back about +X
    M4b.makeTranslation(0, H - LID_H, -D / 2 - 0.0125).multiply(M4c.makeRotationAxis(AX, this.ang.get(c.id) ?? 0));
    this.lid.setMatrixAt(i, M4.multiply(M4b));
  }
  /** a box restocked (end-game regen): its lid is shut again — the next sync writes it */
  close(id: number) { this.animating.delete(id); this.ang.set(id, 0); }
  /** a box opened (server event / join state): its lid swings back */
  open(id: number) { if ((this.ang.get(id) ?? 0) > OPEN_A) { if (!this.ang.has(id)) this.ang.set(id, 0); this.animating.add(id); } }
  update(dt: number, chests: Chest[]) {
    if (!this.animating.size) return;
    for (const id of [...this.animating]) {
      const a = Math.max(OPEN_A, (this.ang.get(id) ?? 0) + (OPEN_A / OPEN_S) * dt);
      this.ang.set(id, a); if (a <= OPEN_A) this.animating.delete(id);
      const i = this.slot.get(id), c = chests[id]; if (i !== undefined && c) this.write(i, c);
    }
    this.lid.instanceMatrix.needsUpdate = true;
  }
  reset() { this.slot.clear(); this.ang.clear(); this.sc.clear(); this.animating.clear(); this.base.count = this.lid.count = this.inner.count = 0; }
}
