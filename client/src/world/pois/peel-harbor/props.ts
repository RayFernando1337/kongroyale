// PEEL HARBOR — yard dressing. Hero props are bevelled, detailed models: counterbalance forklifts (overhead guard,
// mast channels with lift chains + cylinder, carriage + backrest, forks, LPG bottle, tread tyres with hubs), terminal
// tractors (glazed offset cab, grille + lamps, fifth wheel, fuel tank, exhaust stack, coiled air lines, dual rears),
// skeletal chassis, stacked ship hatch covers, lashing-gear cages, pipe + timber stacks, jersey barriers, high-mast
// light towers, the gate's scale house + booths; plus pallets (open crates filled with instanced banana HANDS), crates,
// gold bollards, lamps, gensets, tyre stacks, drums, spools, cones. Every prop is built INSIDE its PROP_FOOT collider
// box (shared/pois/peel-harbor.ts). Props are merged per 128 m cell (frustum-culled per cell), shown ≤ 320 m, cast
// shadows ≤ 45 m. Helpers (crateGeo / palletInto / forkliftInto) are reused by the warehouse interiors.
import * as THREE from "three";
import { APRON_Y, PROPS, palletLoads, boothLocalPieces, scaleHouseLocalPieces, type PalletLoad, type PropSpec } from "../../../../../shared/pois/peel-harbor";
import { Builder, chamferBox, hash, trs, type V3, mergeCasters } from "../_kit/harbor-geo";
import { paint, type HarborMats } from "../_kit/harbor-materials";
import { canvas, drawFruitBanana, paintNoise, stencilText, tex } from "../_kit/harbor-paint";
import { BananaKit } from "../_kit/harbor-bananas";
import { PropBatcher } from "../_kit/harbor-batch";
import { drawPieces, roomMats } from "../_kit/harbor-rooms";
import type { Part } from "./parts";
import { harborFarProxy } from "./far";
import { flag } from "../../../flags";

// ------------------------------------------------------------------------------------------------ materials
let boxMat: THREE.MeshStandardMaterial | null = null;
/** printed cardboard banana box (kraft brown, yellow banana, "BANANA CO.") — UV 0..1 per face */
function bananaBoxMat(): THREE.MeshStandardMaterial {
  if (boxMat) return boxMat;
  const [el, c] = canvas(256, 256);
  c.fillStyle = "#b58a58"; c.fillRect(0, 0, 256, 256);
  paintNoise(c, 0, 0, 256, 256, { seed: 301, scale: 200, alpha: 0.25, blend: "overlay" });
  c.fillStyle = "#e9b722"; c.fillRect(0, 60, 256, 100);
  drawFruitBanana(c, 128, 112, 190, -0.3, { color: "#fff0b8", outline: "#6b4a1a", stem: "#6d6a22" });
  stencilText(c, "BANANA CO.", 128, 222, { size: 34, color: "#3f2a14", align: "center" });
  c.strokeStyle = "rgba(60,40,20,0.5)"; c.lineWidth = 4; c.strokeRect(2, 2, 252, 252);
  boxMat = new THREE.MeshStandardMaterial({ map: tex(el, { repeat: false }), roughness: 0.9, metalness: 0 });
  boxMat.name = "banana-box";
  return boxMat;
}
const amber = () => { const m = paint("#ffa21a", { rough: 0.3, name: "beacon-amber" }); m.emissive = new THREE.Color("#ff8a00"); m.emissiveIntensity = 0.9; return m; };
const chrome = () => paint("#d8dcdf", { rough: 0.18, metal: 0.9, name: "chrome" });

/** prototype detail level (PropBatcher builds every prop twice: HI with DETAIL, LO without the small parts) */
let DETAIL = true;

// ------------------------------------------------------------------------------------------------ local-frame helper
/** build a prop in its own frame (`base` = world placement): box / cyl / beam / tube / lathe in local coordinates */
function local(b: Builder, base: THREE.Matrix4) {
  const P = (v: V3): V3 => { const t = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(base); return [t.x, t.y, t.z]; };
  return {
    P,
    box: (mat: THREE.Material, c: V3, s: V3, bevel = 0, rot: V3 = [0, 0, 0]) => b.add(mat, bevel > 0 ? chamferBox(s[0], s[1], s[2], bevel) : new THREE.BoxGeometry(s[0], s[1], s[2]), base.clone().multiply(trs(c, rot[1], rot[0], rot[2]))),
    cyl: (mat: THREE.Material, a: V3, c: V3, r: number, seg = 12, o: { r1?: number; caps?: boolean } = {}) => b.cyl(mat, P(a), P(c), r, seg, o),
    beam: (mat: THREE.Material, a: V3, c: V3, w: number, d: number) => b.beam(mat, P(a), P(c), w, d),
    tube: (mat: THREE.Material, pts: V3[], r: number, seg = 6) => b.tube(mat, pts.map(P), r, seg, { samples: Math.max(8, pts.length * 4) }),
    lathe: (mat: THREE.Material, profile: Array<[number, number]>, seg: number, m: THREE.Matrix4) => b.lathe(mat, profile, seg, base.clone().multiply(m)),
    add: (mat: THREE.Material, g: THREE.BufferGeometry, m: THREE.Matrix4) => b.add(mat, g, base.clone().multiply(m)),
  };
}
type Local = ReturnType<typeof local>;

/** a tyre with circumferential tread ribs + a hub with a bolt ring; axis along local Z at c, radius R, width W */
function wheel(L: Local, m: HarborMats, c: V3, R: number, W: number, hubMat: THREE.Material, side = 1) {
  const g = 0.035 * R / 0.4;
  const prof: Array<[number, number]> = [[R * 0.6, -W / 2], [R - 0.06, -W / 2], [R - 0.02, -W / 2 + 0.03], [R, -W / 2 + 0.07], [R - g, -W * 0.16], [R, -W * 0.08], [R, W * 0.08], [R - g, W * 0.16], [R, W / 2 - 0.07], [R - 0.02, W / 2 - 0.03], [R - 0.06, W / 2], [R * 0.6, W / 2]];
  const lo: Array<[number, number]> = [[R * 0.6, -W / 2], [R - 0.05, -W / 2], [R, -W / 2 + 0.06], [R, W / 2 - 0.06], [R - 0.05, W / 2], [R * 0.6, W / 2]];
  L.lathe(m.rubber, DETAIL ? prof : lo, DETAIL ? 14 : 8, new THREE.Matrix4().makeTranslation(c[0], c[1], c[2]).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
  // rim + hub (the side facing out) + bolt ring
  const zf = c[2] + side * (W / 2 - 0.03);
  L.cyl(hubMat, [c[0], c[1], c[2] - side * 0.02], [c[0], c[1], zf], R * 0.6, DETAIL ? 12 : 6);
  if (!DETAIL) return;
  L.cyl(m.darkPaint, [c[0], c[1], zf], [c[0], c[1], zf + side * 0.02], R * 0.24, 10);
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; L.cyl(m.steel, [c[0] + Math.cos(a) * R * 0.34, c[1] + Math.sin(a) * R * 0.34, zf], [c[0] + Math.cos(a) * R * 0.34, c[1] + Math.sin(a) * R * 0.34, zf + side * 0.035], 0.018, 6); }
}

// ------------------------------------------------------------------------------------------------ geometry helpers
/** wooden crate (w × h × d, bottom at y=0): chamfered frame boards on every edge, inset panels, a diagonal brace per side */
export function crateGeo(w: number, h: number, d: number): THREE.BufferGeometry {
  const b = new Builder();
  const W = new THREE.MeshBasicMaterial();
  const t = 0.07;
  b.box(W, [0, h / 2, 0], [w - 2 * t + 0.02, h - 2 * t + 0.02, d - 2 * t + 0.02]);
  for (const sy of [t / 2, h - t / 2]) for (const sz of [-1, 1]) b.box(W, [0, sy, sz * (d / 2 - t / 2)], [w, t, t]);
  for (const sy of [t / 2, h - t / 2]) for (const sx of [-1, 1]) b.box(W, [sx * (w / 2 - t / 2), sy, 0], [t, t, d - 2 * t]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(W, [sx * (w / 2 - t / 2), h / 2, sz * (d / 2 - t / 2)], [t, h - 2 * t, t]);
  for (const sz of [-1, 1]) b.beam(W, [-w / 2 + t, t, sz * (d / 2 - 0.01)], [w / 2 - t, h - t, sz * (d / 2 - 0.01)], 0.1, 0.04);
  for (const sx of [-1, 1]) b.beam(W, [sx * (w / 2 - 0.01), t, -d / 2 + t], [sx * (w / 2 - 0.01), h - t, d / 2 - t], 0.04, 0.1, { roll: Math.PI / 2 });
  const g = b.build("crate").children[0] as THREE.Mesh;
  return g.geometry;
}
let crateCache: THREE.BufferGeometry | null = null;
const crate = () => (crateCache ??= crateGeo(1.1, 1.0, 1.1));

/** EUR-ish pallet (1.2 × 0.15 × 1.0) at p (bottom), yaw; optional load. "slatted" = an open crate filled with banana
 *  HANDS (needs a BananaKit; without one it carries printed banana boxes). Returns the top height above p. */
export function palletInto(b: Builder, m: HarborMats, p: V3, yaw: number, load: PalletLoad, h = 0.5, bk?: BananaKit): number {
  const base = trs(p, yaw);
  const add = (mat: THREE.Material, pos: V3, size: V3, bevel = 0.01) => b.add(mat, bevel > 0.015 ? chamferBox(size[0], size[1], size[2], bevel) : new THREE.BoxGeometry(size[0], size[1], size[2]), base.clone().multiply(trs(pos)));
  const pal = m.plywood;
  for (const z of [-0.45, 0, 0.45]) add(pal, [0, 0.055, z], [1.2, 0.09, 0.1]);
  for (let i = 0; i < 7; i++) add(pal, [0, 0.125, -0.45 + i * 0.15], [1.2, 0.022, 0.12]);
  for (const x of [-0.5, 0, 0.5]) add(pal, [x, 0.011, 0], [0.12, 0.022, 1.0]);
  let top = 0.136;
  if (load === "slatted" && !bk) load = "bananas";
  if (load === "crates") {
    const n = h < 0.7 ? 1 : 2;
    for (let i = 0; i < n; i++) b.add(m.wood, crate(), base.clone().multiply(trs([0, top + i * 1.0, 0], (hash(p[0], p[2], i) - 0.5) * 0.1, 0, 0, [1, 0.95, 0.9])));
    top += n * 0.95;
  } else if (load === "boxes" || load === "bananas") {
    const bm = bananaBoxMat(), rows = load === "bananas" ? 3 : 2;
    for (let l = 0; l < rows; l++) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const jitter = (hash(p[0], l, i, j) - 0.5) * 0.04;
      b.add(bm, new THREE.BoxGeometry(0.56, 0.3, 0.46), base.clone().multiply(trs([-0.29 + i * 0.58 + jitter, top + 0.15 + l * 0.305, -0.24 + j * 0.48], jitter)), false);
    }
    top += rows * 0.305;
  } else if (load === "slatted") {
    // open-top slatted crate heaped with discrete banana hands
    const H = 0.55;
    for (const sz of [-1, 1]) for (let k = 0; k < 3; k++) add(m.wood, [0, top + 0.1 + k * 0.18, sz * 0.47], [1.18, 0.12, 0.05]);
    for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) add(m.wood, [sx * 0.57, top + 0.1 + k * 0.18, 0], [0.05, 0.12, 0.9]);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(m.wood, [sx * 0.56, top + H / 2, sz * 0.46], [0.08, H, 0.08]);
    add(m.plywood, [0, top + 0.03, 0], [1.1, 0.04, 0.9]);
    bk!.crate(base.clone().multiply(trs([0, top, 0])), 1.1, 0.9, H, Math.floor(hash(p[0], p[2]) * 9973), 1.05);
    top += H + 0.2;
  }
  return top;
}

// ------------------------------------------------------------------------------------------------ hero props
/** yellow counterbalance forklift at p (ground), yaw; local +X = forks. ≈ 3.4 × 2.2 × 1.2 m */
export function forkliftInto(b: Builder, m: HarborMats, p: V3, yaw: number) {
  const L = local(b, trs(p, yaw));
  const Y = m.yellowPaint, D = m.darkPaint, S = m.steel;
  // chassis, rounded counterweight (with LPG bottle + tail lamps), engine hood with vents, step plates
  L.box(Y, [-0.15, 0.56, 0], [1.8, 0.58, 1.14], 0.09);
  L.box(Y, [-1.18, 0.78, 0], [0.56, 1.02, 1.2], 0.2);
  L.cyl(Y, [-1.22, 1.22, -0.58], [-1.22, 1.22, 0.58], 0.2, 14);
  L.box(Y, [-0.5, 0.98, 0], [0.92, 0.26, 1.02], 0.08);
  for (let k = 0; k < 5; k++) L.box(D, [-0.72 + k * 0.1, 1.115, 0], [0.04, 0.012, 0.6]);
  for (const sz of [-1, 1]) { L.box(D, [0.05, 0.3, sz * 0.6], [0.7, 0.05, 0.14]); L.box(m.warnLight, [-1.47, 0.95, sz * 0.42], [0.03, 0.1, 0.14]); }
  L.cyl(m.whitePaint, [-1.22, 1.52, -0.36], [-1.22, 1.52, 0.36], 0.15, 12);
  L.cyl(S, [-1.22, 1.52, 0.36], [-1.22, 1.52, 0.44], 0.05, 8);
  L.box(D, [-1.2, 1.33, 0], [0.34, 0.06, 0.8]);
  // wheels: big drive tyres at the front, smaller steer tyres at the back + a front mudguard arc
  for (const sz of [-1, 1]) {
    wheel(L, m, [0.45, 0.37, sz * 0.62], 0.37, 0.26, m.yellowPaint, sz);
    wheel(L, m, [-1.02, 0.3, sz * 0.55], 0.3, 0.2, m.yellowPaint, sz);
    for (let k = 0; k < 4; k++) { const a = Math.PI * (0.15 + k * 0.23); L.box(Y, [0.45 + Math.cos(a) * 0.44, 0.37 + Math.sin(a) * 0.44, sz * 0.62], [0.2, 0.04, 0.3], 0.01, [0, 0, a - Math.PI / 2]); }
  }
  if (DETAIL) {
  // cockpit: seat cushion + tilted backrest + armrest, steering column + wheel, levers with knobs, dash
  L.box(D, [-0.56, 1.17, 0], [0.48, 0.1, 0.48], 0.04);
  L.box(D, [-0.82, 1.45, 0], [0.09, 0.5, 0.48], 0.04, [0, 0, 0.18]);
  L.box(D, [-0.56, 1.28, 0.3], [0.36, 0.05, 0.06], 0.01);
  L.box(D, [0.12, 1.05, 0], [0.16, 0.3, 0.8], 0.03);
  L.cyl(D, [0.08, 1.15, 0], [-0.16, 1.58, 0], 0.035, 6);
  L.add(D, new THREE.TorusGeometry(0.17, 0.02, 5, 14), trs([-0.17, 1.6, 0], Math.PI / 2, 0.45, 0));
  for (const [z, knob] of [[0.22, m.warnLight], [0.3, D], [0.38, D]] as Array<[number, THREE.Material]>) { L.cyl(S, [0.12, 1.2, z], [0.02, 1.45, z], 0.012, 5); L.add(knob, new THREE.SphereGeometry(0.03, 6, 5), trs([0.015, 1.47, z])); }
  } else L.box(D, [-0.6, 1.3, 0], [0.5, 0.3, 0.5]);
  // overhead guard: raked front pillars + rear pillars (square tube), perimeter frame, slats, work lamps, beacon
  for (const sz of [-1, 1]) {
    L.beam(D, [0.34, 0.86, sz * 0.52], [0.2, 2.16, sz * 0.52], 0.07, 0.07);
    L.beam(D, [-0.98, 1.0, sz * 0.52], [-0.94, 2.16, sz * 0.52], 0.07, 0.07);
    L.box(D, [-0.37, 2.18, sz * 0.52], [1.3, 0.07, 0.07]);
    L.box(m.lampLens, [0.26, 1.98, sz * 0.52], [0.08, 0.12, 0.14], 0.02);
  }
  for (const x of [0.2, -0.94]) L.box(D, [x, 2.18, 0], [0.07, 0.07, 1.1]);
  for (let k = 1; k < 5; k++) L.box(D, [0.2 - k * 0.228, 2.19, 0], [0.04, 0.035, 1.02]);
  // (a perforated steel deck over the slats — the guard roof is a floor you can stand on, PROP_MEMBERS)
  L.box(cageMesh(), [-0.37, 2.215, 0], [1.3, 0.004, 1.06]);
  L.cyl(D, [-0.8, 2.22, 0.34], [-0.8, 2.27, 0.34], 0.07, 10); L.cyl(amber(), [-0.8, 2.27, 0.34], [-0.8, 2.39, 0.34], 0.055, 10, { r1: 0.035 });
  // mast: outer + inner channels (C sections as two plates each), cross ties, lift cylinder + piston, twin chains
  for (const sz of [-1, 1]) {
    L.box(D, [0.82, 1.23, sz * 0.37], [0.13, 2.28, 0.03]); L.box(D, [0.82, 1.23, sz * 0.33], [0.03, 2.28, 0.09]);
    L.box(S, [0.88, 1.2, sz * 0.29], [0.1, 2.2, 0.025]);
    // chain: alternating links from the carriage over the top pulley
    if (DETAIL) for (let y = 0.62; y < 2.2; y += 0.06) L.box(D, [0.76, y, sz * 0.15], [0.025, 0.05, (Math.round(y / 0.06) % 2) ? 0.03 : 0.012]);
    L.cyl(S, [0.76, 2.26, sz * 0.2], [0.76, 2.26, sz * 0.1], 0.055, 10);
    // tilt cylinders chassis → mast
    L.cyl(chrome(), [0.35, 0.82, sz * 0.46], [0.72, 1.02, sz * 0.4], 0.04, 8);
  }
  for (const y of [0.18, 1.25, 2.33]) L.box(D, [0.82, y, 0], [0.12, 0.09, 0.8], 0.01);
  L.cyl(D, [0.74, 0.18, 0], [0.74, 1.55, 0], 0.06, 10); L.cyl(chrome(), [0.74, 1.55, 0], [0.74, 2.2, 0], 0.036, 8);
  L.tube(D, [[0.3, 0.95, 0.22], [0.55, 1.2, 0.2], [0.7, 1.6, 0.14], [0.74, 2.0, 0.12]], 0.016, 5);
  // carriage + load backrest grille + forks (tine + shank + heel)
  L.box(D, [0.96, 0.62, 0], [0.06, 0.36, 0.96], 0.01);
  L.box(D, [0.96, 1.4, 0], [0.04, 0.05, 0.94]);
  for (let k = 0; k < (DETAIL ? 6 : 2); k++) L.box(D, [0.96, 1.0, -0.4 + k * (DETAIL ? 0.16 : 0.8)], [0.03, 0.8, 0.03]);
  for (const sz of [-0.28, 0.28]) { L.box(S, [1.56, 0.07, sz], [1.14, 0.05, 0.12], 0.008); L.box(S, [0.99, 0.37, sz], [0.05, 0.62, 0.12], 0.008); L.box(S, [1.03, 0.09, sz], [0.1, 0.1, 0.12], 0.02); }
}

/** yellow terminal tractor at (x,y,z), yaw; local +X = forward. Offset glazed cab, engine hood with grille and lamps,
 *  fifth wheel on a lift frame, fuel tank, exhaust stack, coiled air lines, dual rear tyres. ≈ 6.6 × 3.0 × 2.4 m */
function tractorInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const L = local(b, trs([x, y, z], yaw));
  const Y = m.yellowPaint, D = m.darkPaint, S = m.steel;
  // frame rails + cross members, front bumper, rear light bar
  for (const sz of [-0.46, 0.46]) L.box(D, [-0.1, 0.78, sz], [6.2, 0.26, 0.18], 0.02);
  for (let k = 0; k < 5; k++) L.box(D, [-2.6 + k * 1.3, 0.78, 0], [0.12, 0.2, 0.8]);
  L.box(D, [3.08, 0.72, 0], [0.22, 0.34, 2.1], 0.05);
  L.box(D, [-3.1, 0.9, 0], [0.12, 0.2, 2.0]);
  for (const sz of [-0.8, 0.8]) L.box(m.warnLight, [-3.17, 0.92, sz], [0.02, 0.1, 0.22]);
  // hood + grille + lamps
  L.box(Y, [2.35, 1.42, 0.12], [1.3, 0.95, 1.46], 0.12);
  L.box(D, [3.01, 1.38, 0.12], [0.04, 0.62, 1.0], 0.01);
  if (DETAIL) for (let k = 0; k < 6; k++) L.box(chrome(), [3.035, 1.14 + k * 0.1, 0.12], [0.02, 0.025, 0.96]);
  for (const sz of [-0.5, 0.74]) { L.box(m.lampLens, [3.02, 1.02, sz], [0.05, 0.14, 0.22], 0.02); L.box(amber(), [3.02, 1.2, sz + (sz > 0 ? 0.1 : -0.1)], [0.04, 0.06, 0.1]); }
  // offset cab (-Z side): lower body, glazed upper (dark glass panes + yellow pillars), roof, beacon, mirrors, step
  const cz = -0.28;
  L.box(Y, [1.35, 1.5, cz], [1.6, 0.85, 1.55], 0.08);
  L.box(m.windowDark, [1.35, 2.38, cz], [1.48, 0.9, 1.43]);
  for (const [px, pz] of [[0.56, cz - 0.76], [0.56, cz + 0.76], [2.14, cz - 0.76], [2.14, cz + 0.76]]) L.box(Y, [px, 2.38, pz], [0.1, 0.92, 0.1], 0.02);
  L.box(Y, [1.35, 2.88, cz], [1.72, 0.14, 1.66], 0.05);
  L.cyl(D, [1.0, 2.95, cz], [1.0, 3.0, cz], 0.08, 10); L.cyl(amber(), [1.0, 3.0, cz], [1.0, 3.12, cz], 0.06, 10, { r1: 0.04 });
  for (const sz of [-1, 1]) { L.cyl(D, [2.1, 2.5, cz + sz * 0.8], [2.2, 2.55, cz + sz * 1.15], 0.02, 5); L.box(D, [2.22, 2.4, cz + sz * 1.17], [0.06, 0.34, 0.2], 0.02); }
  L.box(D, [1.3, 0.95, cz - 0.86], [0.5, 0.05, 0.22]); L.box(D, [1.3, 1.25, cz - 0.86], [0.5, 0.05, 0.22]);
  L.cyl(S, [0.62, 1.3, cz - 0.8], [0.62, 2.1, cz - 0.8], 0.018, 5);
  // fuel tank + battery box under the cab, exhaust stack behind it
  L.cyl(m.galv, [0.55, 0.78, -0.92], [1.95, 0.78, -0.92], 0.3, 14);
  for (const x of [0.75, 1.75]) L.box(D, [x, 0.78, -0.92], [0.06, 0.64, 0.64]);
  L.box(D, [0.3, 0.8, 0.82], [0.7, 0.45, 0.45], 0.03);
  L.cyl(S, [0.52, 1.1, 0.72], [0.52, 3.3, 0.72], 0.075, 10); L.box(D, [0.52, 3.32, 0.72], [0.2, 0.03, 0.16], 0.005, [0, 0, 0.35]);
  // fifth wheel on its lift frame + ramps, coiled red/blue air lines from the cab back
  L.box(D, [-1.45, 1.05, 0], [1.3, 0.2, 1.2], 0.03);
  L.cyl(D, [-1.45, 1.15, 0], [-1.45, 1.26, 0], 0.62, 18);
  for (const sz of [-1, 1]) L.box(D, [-2.0, 1.27, sz * 0.14], [0.5, 0.04, 0.1], 0, [0, sz * 0.35, 0]);
  for (const sz of [-1, 1]) L.beam(D, [-2.5, 0.95, sz * 0.5], [-2.95, 0.65, sz * 0.5], 0.14, 0.12);
  if (DETAIL) for (const [col, off] of [[m.redPaint, 0.1], [m.bluePaint, -0.1]] as Array<[THREE.Material, number]>) {
    const pts: V3[] = [];
    for (let k = 0; k <= 24; k++) { const t = k / 24, a = t * Math.PI * 7; pts.push([0.35 - t * 0.9, 1.9 + Math.cos(a) * 0.14 - t * 0.35, off + Math.sin(a) * 0.14]); }
    L.tube(col, pts, 0.014, 5);
  }
  // wheels: steer axle + dual drive axle, rear mudguards + flaps
  for (const sz of [-1, 1]) {
    wheel(L, m, [2.25, 0.54, sz * 0.9], 0.54, 0.34, m.yellowPaint, sz);
    wheel(L, m, [-1.45, 0.54, sz * 0.78], 0.54, 0.3, m.yellowPaint, sz);
    wheel(L, m, [-1.45, 0.54, sz * 1.08], 0.54, 0.3, m.yellowPaint, sz);
    L.box(D, [-1.45, 1.14, sz * 0.95], [1.3, 0.05, 0.72], 0.01);
    L.box(m.rubber, [-2.12, 0.62, sz * 0.95], [0.02, 0.6, 0.6]);
  }
}

// ------------------------------------------------------------------------------------------------ yard props
/** skeletal container chassis (12.4 m, deck at 1.36), tandem rear axle, landing legs, twist-locks */
function chassisInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const L = local(b, trs([x, y, z], yaw));
  const F = paint("#3b3f45", { rough: 0.55, name: "chassis-grey" }), Y = m.yellowPaint, D = m.darkPaint;
  for (const sz of [-0.5, 0.5]) { L.box(F, [0, 1.2, sz], [12.3, 0.3, 0.12], 0.02); L.box(F, [0, 1.06, sz], [12.3, 0.03, 0.26]); L.box(F, [0, 1.34, sz], [12.3, 0.03, 0.26]); }
  for (let k = 0; k < 9; k++) L.box(F, [-5.6 + k * 1.4, 1.22, 0], [0.12, 0.22, 1.9]);
  // chequer-plate walkway over the rails (the deck collider is a slab: no 1.3 m gaps to fall into under the frame)
  L.box(m.steel, [0, 1.36, 0], [12.3, 0.025, 1.26]);
  for (const sx of [-1, 1]) {
    L.box(F, [sx * 6.05, 1.24, 0], [0.24, 0.3, 2.44], 0.02);
    for (const sz of [-1, 1]) L.add(Y, new THREE.CylinderGeometry(0.03, 0.07, 0.1, 6), trs([sx * 6.02, 1.41, sz * 1.1]));
  }
  // landing legs + foot pads + crank
  for (const sz of [-0.55, 0.55]) { L.box(Y, [3.6, 0.72, sz], [0.14, 1.0, 0.14], 0.02); L.box(D, [3.6, 0.12, sz], [0.36, 0.06, 0.3]); }
  L.cyl(D, [3.6, 0.95, 0.62], [3.6, 0.95, 0.95], 0.02, 5);
  // tandem axle with dual tyres, mudguards, ICC bumper, light bar
  for (const ax of [-3.9, -5.1]) for (const sz of [-1, 1]) {
    wheel(L, m, [ax, 0.5, sz * 0.72], 0.5, 0.27, m.galv, sz);
    wheel(L, m, [ax, 0.5, sz * 1.0], 0.5, 0.27, m.galv, sz);
  }
  for (const sz of [-1, 1]) L.box(D, [-4.5, 1.06, sz * 0.86], [2.7, 0.04, 0.66], 0.01);
  L.box(F, [-6.25, 0.55, 0], [0.12, 0.14, 2.2], 0.02);
  for (const sz of [-1, 1]) { L.box(F, [-6.2, 0.82, sz * 0.9], [0.08, 0.5, 0.08]); L.box(m.warnLight, [-6.28, 1.05, sz * 0.95], [0.02, 0.1, 0.2]); }
}

/** two steel ship hatch-cover pontoons stacked on timber dunnage: weathered
 *  green box pontoons with transverse top stiffeners, a black rubber packing band, yellow corner cleats + lifting lugs,
 *  rusty skirts, white stencilled numbers; the drawn tops sit on the collider tops (PROP_MEMBERS "hatch-cover") */
function hatchCoverInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const L = local(b, trs([x, y, z], yaw));
  const G = paint("#4a7a50", { rough: 0.62, grime: 0.55, name: "hatch-green" }), W = m.whitePaint;
  for (const sx of [-4.5, 0, 4.5]) L.box(m.wood, [sx, 0.04, 0], [0.3, 0.08, 4.4], 0.01);
  const dims: Array<[number, number, number]> = [[12.0, 4.8, 0.08], [11.5, 4.5, 0.88]];
  dims.forEach(([Lk, Wk, b0], k) => {
    const top = b0 + 0.72;
    L.box(G, [0, b0 + 0.36, 0], [Lk, 0.72, Wk], 0.05);
    L.box(m.rust, [0, b0 + 0.05, 0], [Lk + 0.01, 0.1, Wk + 0.01]);
    L.box(m.rubber, [0, top - 0.12, 0], [Lk + 0.02, 0.05, Wk + 0.02]);
    // transverse stiffeners + a centre girder on the deck
    for (let i = 0; i < 8; i++) L.box(G, [-Lk / 2 + 0.8 + i * ((Lk - 1.6) / 7), top + 0.03, 0], [0.1, 0.06, Wk - 0.3]);
    L.box(G, [0, top + 0.03, 0], [Lk - 1.2, 0.06, 0.12]);
    // side plate seams + drain slots
    if (DETAIL) for (let i = 1; i < 6; i++) for (const sz of [-1, 1]) { L.box(m.darkPaint, [-Lk / 2 + i * (Lk / 6), b0 + 0.36, sz * (Wk / 2 + 0.004)], [0.02, 0.6, 0.006]); L.box(m.darkPaint, [-Lk / 2 + i * (Lk / 6) - 0.9, b0 + 0.12, sz * (Wk / 2 + 0.004)], [0.22, 0.05, 0.006]); }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      L.box(m.yellowPaint, [sx * (Lk / 2 - 0.5), top + 0.07, sz * (Wk / 2 - 0.35)], [0.24, 0.14, 0.1], 0.01);
      L.box(m.yellowPaint, [sx * (Lk / 2 - 1.6), b0 + 0.45, sz * (Wk / 2 + 0.05)], [0.3, 0.2, 0.1], 0.02);
    }
    // stencilled pontoon number on both long sides
    if (DETAIL) for (const sz of [-1, 1]) { L.box(W, [-Lk / 2 + 1.4, b0 + 0.38, sz * (Wk / 2 + 0.006)], [0.08, 0.36, 0.004]); L.box(W, [-Lk / 2 + 1.62, b0 + 0.38, sz * (Wk / 2 + 0.006)], [0.22, 0.06, 0.004]); if (k) L.box(W, [-Lk / 2 + 1.75, b0 + 0.38, sz * (Wk / 2 + 0.006)], [0.06, 0.36, 0.004]); }
    // timber packers between the pontoons
    if (k === 0) for (const sx of [-4, 0, 4]) L.box(m.wood, [sx, top + 0.04, 0], [0.25, 0.08, 4.2], 0.01);
  });
}

/** lashing-gear bin (its collider is what you see): fork-pocket skid, solid ribbed galvanised
 *  sheet sides to 1.2 m (hard cover), a welded-mesh band above + a mesh lid (see-through: players stop, bullets pass —
 *  PROP_MEMBERS), lashing rods + twist-locks inside, a stencilled ID plate */
let cageMeshMat: THREE.MeshStandardMaterial | null = null;
function cageMesh(): THREE.MeshStandardMaterial {
  if (cageMeshMat) return cageMeshMat;
  const [el, c] = canvas(128, 128);
  c.clearRect(0, 0, 128, 128);
  c.strokeStyle = "#c9ced1"; c.lineWidth = 5;
  for (let k = 0; k <= 4; k++) { c.beginPath(); c.moveTo(k * 32, 0); c.lineTo(k * 32, 128); c.stroke(); c.beginPath(); c.moveTo(0, k * 32); c.lineTo(128, k * 32); c.stroke(); }
  c.strokeStyle = "rgba(90,70,50,0.55)"; c.lineWidth = 2;
  for (let k = 0; k <= 4; k++) { c.beginPath(); c.moveTo(k * 32 + 2, 0); c.lineTo(k * 32 + 2, 128); c.stroke(); }
  const t = tex(el); t.repeat.set(3, 3);
  cageMeshMat = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.45, metalness: 0.6, name: "cage-mesh" });
  return cageMeshMat;
}
function lashingCageInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const L = local(b, trs([x, y, z], yaw));
  const G = m.galv, hx = 1.2, hz = 0.9, H = 1.8, S0 = 0.2, S1 = 1.2;
  // skid with yellow fork pockets
  L.box(G, [0, S0 / 2, 0], [2 * hx, S0, 2 * hz], 0.02);
  for (const sz of [-0.5, 0.5]) L.box(m.yellowPaint, [0, 0.1, sz], [2 * hx + 0.02, 0.12, 0.26], 0.01);
  // solid sheet sides with pressed horizontal ribs
  L.box(G, [0, (S0 + S1) / 2, 0], [2 * hx - 0.04, S1 - S0, 2 * hz - 0.04], 0.015);
  for (let yy = S0 + 0.17; yy < S1 - 0.05; yy += 0.24) { for (const sz of [-1, 1]) L.box(G, [0, yy, sz * (hz - 0.01)], [2 * hx - 0.2, 0.05, 0.03], 0.01); for (const sx of [-1, 1]) L.box(G, [sx * (hx - 0.01), yy, 0], [0.03, 0.05, 2 * hz - 0.2], 0.01); }
  // corner posts + top / mid frame
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) L.box(G, [sx * (hx - 0.04), H / 2, sz * (hz - 0.04)], [0.09, H, 0.09], 0.01);
  for (const yy of [S1, H - 0.035]) { for (const sz of [-1, 1]) L.box(G, [0, yy, sz * (hz - 0.04)], [2 * hx, 0.07, 0.07]); for (const sx of [-1, 1]) L.box(G, [sx * (hx - 0.04), yy, 0], [0.07, 0.07, 2 * hz]); }
  // ID plate + hazard corner bands
  L.box(m.yellowPaint, [0.55, 0.82, hz + 0.005], [0.7, 0.3, 0.012]);
  L.box(m.darkPaint, [0.55, 0.82, hz + 0.012], [0.56, 0.05, 0.004]);
  // welded mesh band + lid (alpha-tested panels at the collider faces)
  const M = cageMesh();
  if (DETAIL) {
    for (const sz of [-1, 1]) L.box(M, [0, (S1 + H) / 2, sz * (hz - 0.04)], [2 * hx - 0.1, H - S1, 0.004]);
    for (const sx of [-1, 1]) L.box(M, [sx * (hx - 0.04), (S1 + H) / 2, 0], [0.004, H - S1, 2 * hz - 0.1]);
    L.box(M, [0, H - 0.01, 0], [2 * hx - 0.1, 0.004, 2 * hz - 0.1]);
    // contents: lashing rods leaning against the far side, a heap of twist-locks on the floor of the bin
    for (let k = 0; k < 14; k++) { const zz = -0.6 + k * 0.09; L.cyl(m.steel, [-0.95, S1 - 0.1, zz], [0.9, 1.45 + (k % 3) * 0.1, zz + 0.05], 0.022, 5); }
    for (let k = 0; k < 10; k++) L.box(m.darkPaint, [0.4 + (hash(x, k) - 0.5) * 0.9, S1 + 0.02 + (k % 3) * 0.06, (hash(z, k) - 0.5) * 1.2], [0.16, 0.1, 0.1], 0.02, [0, hash(k, x) * 3, 0]);
  }
}

/** mooring winch (berth strip): a steel bedplate, two side frames, a wire drum wrapped in grey wire rope with a red
 *  band brake, a gearbox + electric motor at one end (orange / dark), guard plate and lifting eyes; local +X = drum axis */
function winchInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const L = local(b, trs([x, y, z], yaw));
  const D = m.darkPaint, S = m.steel, O = paint("#d9661f", { rough: 0.5, grime: 0.4, name: "winch-orange" });
  L.box(D, [0, 0.09, 0], [2.0, 0.18, 1.24], 0.02);
  for (const sx of [-0.75, 0.35]) L.box(O, [sx, 0.7, 0], [0.12, 1.06, 1.2], 0.03);
  // drum (between the frames) + rope wraps + flanges
  L.cyl(S, [-0.69, 0.72, 0], [0.29, 0.72, 0], 0.3, 18);
  if (DETAIL) for (let k = 0; k < 11; k++) { const xx = -0.64 + k * 0.088; L.cyl(m.galv, [xx, 0.72, 0], [xx + 0.07, 0.72, 0], 0.4, 18); }
  else L.cyl(m.galv, [-0.66, 0.72, 0], [0.26, 0.72, 0], 0.4, 12);
  for (const fx of [-0.68, 0.28]) L.cyl(O, [fx - 0.02, 0.72, 0], [fx + 0.02, 0.72, 0], 0.55, 20);
  // band brake + its lever
  L.add(m.redPaint, new THREE.TorusGeometry(0.56, 0.03, 6, 20, Math.PI * 1.4).rotateY(Math.PI / 2), trs([-0.2, 0.72, 0], 0, 0, 0.6));
  L.box(m.redPaint, [-0.2, 1.22, -0.55], [0.06, 0.5, 0.06]);
  // gearbox + motor at +x
  L.box(O, [0.62, 0.72, 0], [0.42, 0.9, 0.9], 0.05);
  L.cyl(D, [0.84, 0.62, 0], [0.98, 0.62, 0], 0.34, 16);
  L.box(D, [0.9, 0.3, 0], [0.18, 0.32, 0.8], 0.02);
  for (let k = 0; k < 5; k++) L.box(S, [0.85, 0.42 + k * 0.08, 0.36], [0.2, 0.02, 0.02]);
  // guard plate over the drum + lifting eyes, hazard edge
  L.box(O, [-0.2, 1.28, 0.2], [1.1, 0.04, 0.8], 0.01);
  L.box(m.hazard, [-0.2, 1.23, 0.6], [1.1, 0.1, 0.02]);
  for (const sx of [-0.75, 0.35]) L.cyl(D, [sx, 1.27, 0.5], [sx, 1.33, 0.5], 0.06, 8);
  // a wire rope leading off the drum toward the quay edge (along −z), into a coil on the deck
  if (DETAIL) L.tube(m.cable, [[-0.2, 0.9, 0.38], [-0.2, 0.45, 0.75], [-0.1, 0.2, 1.1], [0.2, 0.06, 1.5]], 0.025, 6);
}

/** steel pipes stacked 3-2-1 on timber dunnage, strapped */
function pipeStackInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const L = local(b, trs([x, y, z], yaw));
  const P = paint("#3a3634", { rough: 0.6, grime: 0.3, name: "pipe-black" }), r = 0.24;
  for (const sx of [-2.2, 0, 2.2]) L.box(m.wood, [sx, 0.06, 0], [0.14, 0.12, 2.3]);
  const rows: Array<[number, number]> = [[3, 0.12 + r], [2, 0.12 + r + r * 1.73], [1, 0.12 + r + r * 3.46]];
  for (const [n, yy] of rows) for (let i = 0; i < n; i++) {
    const zz = (i - (n - 1) / 2) * 2 * r * 1.01;
    L.cyl(P, [-2.9, yy, zz], [2.9, yy, zz], r, DETAIL ? 12 : 6, { caps: false });
    for (const ex of [-2.9, 2.9]) { L.cyl(m.rust, [ex, yy, zz], [ex + Math.sign(ex) * 0.005, yy, zz], r, DETAIL ? 12 : 6); L.cyl(m.interior, [ex + Math.sign(ex) * 0.006, yy, zz], [ex + Math.sign(ex) * 0.012, yy, zz], r * 0.82, DETAIL ? 12 : 6); }
  }
  for (const sx of [-1.5, 1.5]) L.box(m.yellowPaint, [sx, 0.12 + r * 2.2, 0], [0.05, r * 4.9, 3 * 2 * r + 0.06]);
}

/** sawn timber packs: layers of boards with spacers, two packs, yellow straps */
function timberStackInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const L = local(b, trs([x, y, z], yaw));
  for (const [ox, n] of [[0, 5], [0.1, 3]] as Array<[number, number]>) {
    const base = ox ? 5 * 0.2 + 0.08 : 0.08;
    for (let l = 0; l < n; l++) {
      // (parity: boards butt edge to edge, the bevel reads as the joint — 2 cm slots would run down through every layer)
      for (let k = 0; k < 7; k++) L.box(m.wood, [ox, base + l * 0.2 + 0.08, -0.84 + k * 0.28], [4.6, 0.14, 0.28], 0.012);
      L.box(m.wood, [ox - 1.6, base + l * 0.2 + 0.17, 0], [0.08, 0.04, 2.0]); L.box(m.wood, [ox + 1.6, base + l * 0.2 + 0.17, 0], [0.08, 0.04, 2.0]);
    }
    for (const sx of [-1.2, 1.2]) L.box(m.yellowPaint, [ox + sx, base + n * 0.1, 0], [0.05, n * 0.2 + 0.02, 2.02]);
  }
  for (const sx of [-1.8, 1.8]) L.box(m.wood, [sx, 0.04, 0], [0.14, 0.08, 1.9]);
}

/** concrete jersey barrier (3 m) with lifting slots and a hazard stripe */
function barrierInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const L = local(b, trs([x, y, z], yaw));
  const sh = new THREE.Shape();
  sh.moveTo(-0.3, 0); sh.lineTo(0.3, 0); sh.lineTo(0.3, 0.08); sh.lineTo(0.14, 0.3); sh.lineTo(0.1, 0.9); sh.lineTo(-0.1, 0.9); sh.lineTo(-0.14, 0.3); sh.lineTo(-0.3, 0.08); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 2.96, bevelEnabled: false }).translate(0, 0, -1.48);
  L.add(m.concrete, g, trs([0, 0, 0], Math.PI / 2));
  L.box(m.hazard, [0, 0.78, 0], [2.9, 0.12, 0.215]);
  for (const sx of [-0.9, 0.9]) L.box(m.interior, [sx, 0.1, 0], [0.24, 0.1, 0.62]);
}

/** high-mast floodlight tower (≈ 24 m): tapered galvanised pole, access ladder with hoops, head frame with 6 lamps */
function lightTowerInto(b: Builder, m: HarborMats, x: number, y: number, z: number) {
  const L = local(b, trs([x, y, z], 0));
  const G = m.galv, H = 23.5;
  L.box(m.concrete, [0, 0.25, 0], [1.4, 0.5, 1.4], 0.08);
  L.cyl(G, [0, 0.5, 0], [0, H, 0], 0.32, 12, { r1: 0.16 });
  L.box(G, [0, 0.75, 0], [0.7, 0.5, 0.7], 0.04);
  for (let yy = 1.2; yy < H - 2; yy += 0.7) L.box(G, [0.4, yy, 0], [0.03, 0.03, 0.4]);
  for (const sz of [-0.2, 0.2]) L.box(G, [0.36, H / 2, sz], [0.03, H - 3, 0.03]);
  for (let yy = 4; yy < H - 2.5; yy += 3) L.add(G, new THREE.TorusGeometry(0.36, 0.015, 3, 8, Math.PI), trs([0.25, yy, 0], -Math.PI / 2, Math.PI / 2, 0));
  L.box(G, [0, H, 0], [2.6, 0.14, 2.6]);
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; L.box(G, [Math.cos(a) * 1.3, H + 0.55, Math.sin(a) * 1.3], [0.05, 1.0, 0.05]); }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3, px = Math.cos(a) * 1.05, pz = Math.sin(a) * 1.05;
    L.box(m.darkPaint, [px, H + 0.5, pz], [0.5, 0.36, 0.5], 0.04, [0, -a, 0.5]);
    L.box(m.lampLens, [px * 1.08, H + 0.38, pz * 1.08], [0.4, 0.04, 0.4], 0, [0, -a, 0.5]);
  }
}

/** gate scale house: rendered block with a flat overhanging roof, windows on three sides, door + steps, AC unit */
function scaleHouseInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  // a real room (shared pieces = the colliders): door + steps on −x, windows all round, counter + cabinet inside
  const prev = b.base; b.base = trs([x, y, z], yaw);
  drawPieces(b, scaleHouseLocalPieces(), roomMats(m));
  b.base = prev;
  const L = local(b, trs([x, y, z], yaw));
  L.box(m.concrete, [0, -0.02, 0], [6.6, 0.06, 4.6], 0.02);
  for (let k = 0; k < 2; k++) L.box(m.concrete, [-3.1 - 0.3 - k * 0.3, 0.05 - k * 0.03, -0.9], [0.3, 0.1, 1.3]);
  L.box(m.whitePaint, [-1.6, 3.25 + 0.3, 0.8], [1.0, 0.5, 0.7], 0.04);
  for (let k = 0; k < 5; k++) L.box(m.darkPaint, [-1.6 - 0.4 + k * 0.2, 3.25 + 0.3, 1.16], [0.03, 0.4, 0.02]);
}

/** gate booth: small glazed cabin (a real room) + a striped barrier arm */
function boothInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const prev = b.base; b.base = trs([x, y, z], yaw);
  drawPieces(b, boothLocalPieces(), roomMats(m));
  b.base = prev;
  const L = local(b, trs([x, y, z], yaw));
  L.box(m.concrete, [0, -0.02, 0], [2.6, 0.06, 2.6], 0.02);
  L.box(m.darkPaint, [1.4, 0.55, 0.8], [0.3, 0.9, 0.3], 0.03);
  const arm = paint("#d8312a", { rough: 0.45, name: "barrier-red" });
  for (let k = 0; k < 6; k++) L.box(k % 2 ? m.whitePaint : arm, [1.4 + 0.5 + k * 0.9 / 1, 1.0, 0.8], [0.9, 0.1, 0.1]);
}

function tyreWallInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const d of [-1.25, 0, 1.25]) tyres(b, m, x + d * c, y, z - d * s, 3);
}
function binInto(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const L = local(b, trs([x, y, z], yaw));
  const G = paint("#2f5a3a", { rough: 0.6, grime: 0.5, name: "skip-green" });
  L.box(G, [0, 0.62, 0], [1.7, 1.1, 1.1], 0.04, [0, 0, 0]);
  L.box(m.darkPaint, [0, 0.06, 0], [1.4, 0.12, 0.9]);
  for (const sx of [-0.8, 0.8]) L.box(m.yellowPaint, [sx, 0.9, 0], [0.06, 0.12, 1.14]);
  L.box(m.darkPaint, [0, 1.19, 0], [1.72, 0.04, 1.12]);
}

// ------------------------------------------------------------------------------------------------ small props
function bollard(b: Builder, m: HarborMats, x: number, y: number, z: number) {
  // gold mushroom bollard (chunky, ~1 m) on a base plate with 4 bolts
  const k = 1.25;
  b.lathe(m.yellowPaint, [[0.001, 0], [0.4, 0], [0.4, 0.06], [0.24, 0.1], [0.22, 0.5], [0.3, 0.58], [0.34, 0.7], [0.3, 0.8], [0.001, 0.84]].map(([r, h]) => [r * k, h * k] as [number, number]), 18, new THREE.Matrix4().makeTranslation(x, y, z));
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.4; b.cyl(m.steel, [x + Math.cos(a) * 0.4, y + 0.02, z + Math.sin(a) * 0.4], [x + Math.cos(a) * 0.4, y + 0.1, z + Math.sin(a) * 0.4], 0.04, 6); }
}

function lamp(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const G = m.galv, H = 10.5;
  b.box(m.concrete, [x, y + 0.2, z], [0.8, 0.4, 0.8], { bevel: 0.06 });
  b.cyl(G, [x, y + 0.4, z], [x, y + H, z], 0.16, 8, { r1: 0.09 });
  b.box(G, [x, y + 0.55, z], [0.34, 0.3, 0.34], { bevel: 0.03 });
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const sd of [-1, 1]) {
    const ex = x + c * sd * 1.3, ez = z - s * sd * 1.3;
    b.tube(G, [[x, y + H - 0.3, z], [x + c * sd * 0.7, y + H + 0.15, z - s * sd * 0.7], [ex, y + H + 0.1, ez]], 0.055, 6, { samples: 8 });
    b.box(m.darkPaint, [ex + c * sd * 0.35, y + H + 0.05, ez - s * sd * 0.35], [0.9, 0.18, 0.42], { bevel: 0.05, rotY: yaw });
    b.box(m.lampLens, [ex + c * sd * 0.35, y + H - 0.05, ez - s * sd * 0.35], [0.74, 0.03, 0.32], { rotY: yaw });
  }
}

function generator(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number, h: number) {
  const base = trs([x, y, z], yaw);
  const mat = h < 0.5 ? m.greenPaint : m.yellowPaint;
  const add = (mt: THREE.Material, c: V3, s: V3, bevel = 0.05) => b.add(mt, chamferBox(s[0], s[1], s[2], bevel), base.clone().multiply(trs(c)));
  add(m.darkPaint, [0, 0.12, 0], [2.6, 0.24, 1.3]);
  add(mat, [0, 0.95, 0], [2.5, 1.45, 1.25], 0.08);
  add(mat, [0, 1.72, 0], [2.58, 0.08, 1.33], 0.02);
  for (const sz of [-1, 1]) {
    add(m.darkPaint, [-0.7, 1.0, sz * 0.63], [0.8, 0.8, 0.02], 0.005);
    for (let k = 0; k < 6; k++) add(m.galv, [-0.7, 0.7 + k * 0.12, sz * 0.645], [0.76, 0.03, 0.02], 0.004);
    add(m.darkPaint, [0.6, 0.95, sz * 0.63], [0.9, 1.1, 0.02], 0.005);
  }
  add(m.darkPaint, [0.9, 1.9, 0.3], [0.2, 0.36, 0.2], 0.03);
  const A = new THREE.Vector3(0.9, 2.05, 0.3).applyMatrix4(base);
  b.cyl(m.steel, [A.x, A.y, A.z], [A.x, A.y + 0.6, A.z], 0.07, 8);
}

function tyres(b: Builder, m: HarborMats, x: number, y: number, z: number, n = 4) {
  for (let k = 0; k < n; k++) {
    const g = new THREE.TorusGeometry(0.62, 0.26, DETAIL ? 8 : 5, DETAIL ? 18 : 9).rotateX(Math.PI / 2);
    const tx = x + (hash(x, k) - 0.5) * 0.12, tz = z + (hash(z, k) - 0.5) * 0.12, ty = y + 0.26 + k * 0.27;
    b.add(m.rubber, g, trs([tx, ty, tz]));
    // the top tyre is still on its steel wheel (dished rim + hub + nuts) — the stack's top is a surface, not a hole
    if (k === n - 1) {
      b.lathe(m.galv, [[0.001, -0.1], [0.43, -0.1], [0.47, -0.08], [0.47, 0.21], [0.42, 0.17], [0.16, 0.19], [0.12, 0.22], [0.001, 0.22]], DETAIL ? 18 : 9, new THREE.Matrix4().makeTranslation(tx, ty, tz));
      if (DETAIL) for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; b.cyl(m.darkPaint, [tx + Math.cos(a) * 0.09, ty + 0.22, tz + Math.sin(a) * 0.09], [tx + Math.cos(a) * 0.09, ty + 0.25, tz + Math.sin(a) * 0.09], 0.018, 6); }
    }
  }
}

function barrel(b: Builder, m: HarborMats, x: number, y: number, z: number, h: number) {
  const mat = h < 0.33 ? m.bluePaint : h < 0.66 ? m.redPaint : m.yellowPaint;
  b.lathe(mat, [[0.001, 0], [0.29, 0], [0.3, 0.02], [0.3, 0.29], [0.315, 0.31], [0.3, 0.33], [0.3, 0.58], [0.315, 0.6], [0.3, 0.62], [0.3, 0.88], [0.28, 0.9], [0.001, 0.9]], 14, new THREE.Matrix4().makeTranslation(x, y, z));
}

function spool(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const sd of [-0.5, 0.5]) b.cyl(m.wood, [x - s * sd, y + 0.8, z - c * sd], [x - s * (sd + Math.sign(sd) * 0.08), y + 0.8, z - c * (sd + Math.sign(sd) * 0.08)], 0.8, 18);
  b.cyl(m.rubber, [x - s * 0.5, y + 0.8, z - c * 0.5], [x + s * 0.5, y + 0.8, z + c * 0.5], 0.55, 18);
}

function cone(b: Builder, m: HarborMats, x: number, y: number, z: number) {
  const orange = paint("#f06a1c", { rough: 0.5, name: "cone-orange" });
  b.box(m.rubber, [x, y + 0.02, z], [0.42, 0.04, 0.42], { bevel: 0.01 });
  b.lathe(orange, [[0.17, 0.04], [0.14, 0.2], [0.001, 0.72]], 12, new THREE.Matrix4().makeTranslation(x, y, z));
  b.lathe(m.whitePaint, [[0.118, 0.3], [0.095, 0.44]], 12, new THREE.Matrix4().makeTranslation(x, y + 0.001, z));
}

function drumPallet(b: Builder, m: HarborMats, x: number, y: number, z: number, yaw: number, h: number) {
  const t = palletInto(b, m, [x, y, z], yaw, "empty");
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const mat = h < 0.5 ? m.bluePaint : m.redPaint;
  for (const [a, d] of [[-0.3, -0.25], [0.3, -0.25], [-0.3, 0.25], [0.3, 0.25]]) {
    const px = x + a * c + d * s, pz = z - a * s + d * c;
    // (20 segments, a rolled chime + a recessed lid with two bungs — 12-sided drums read as octagons at 2 m)
    b.lathe(mat, [[0.001, 0], [0.26, 0], [0.27, 0.02], [0.27, 0.26], [0.285, 0.28], [0.27, 0.3], [0.27, 0.56], [0.285, 0.58], [0.27, 0.6], [0.27, 0.8], [0.278, 0.81], [0.272, 0.83], [0.255, 0.825], [0.25, 0.805], [0.001, 0.805]], 20, new THREE.Matrix4().makeTranslation(px, y + t, pz));
    for (const [bx, bz] of [[0.12, 0.05], [-0.13, -0.04]]) b.cyl(m.darkPaint, [px + bx, y + t + 0.8, pz + bz], [px + bx, y + t + 0.83, pz + bz], 0.035, 8);
  }
}

// ------------------------------------------------------------------------------------------------ part
/** the prototype key a placed prop is drawn with (variants = colour / load choices baked into their own prototypes) */
function protoKey(p: PropSpec, h: number): string {
  switch (p.kind) {
    // (the loads come from the shared palletLoads — the colliders follow the same drawn heights)
    case "pallet": return `pallet:${palletLoads(p)[0]}`;
    case "pallet-stack": { const [a, b] = palletLoads(p); return `pallet-stack:${a}:${b}`; }
    case "generator": return `generator:${h < 0.5 ? 0 : 1}`;
    case "barrel": return `barrel:${h < 0.33 ? 0 : h < 0.66 ? 1 : 2}`;
    case "drum-pallet": return `drum-pallet:${h < 0.5 ? 0 : 1}`;
    default: return p.kind;
  }
}
/** the LO stand-ins (≈ 100–400 tris): the HI silhouette in its own textured paint (the batcher keeps yellow paint,
 *  wood, plywood, printed boxes textured) — a forklift still reads guard + mast + counterweight at 150 m */
function loProto(kind: string, b: Builder, m: HarborMats): boolean {
  const L = local(b, new THREE.Matrix4());
  const w8 = (c: V3, r: number, w: number, hub: THREE.Material = m.yellowPaint) => { L.cyl(m.rubber, [c[0], c[1], c[2] - w / 2], [c[0], c[1], c[2] + w / 2], r, 8); L.cyl(hub, [c[0], c[1], c[2] + (c[2] > 0 ? w / 2 : -w / 2)], [c[0], c[1], c[2] + (c[2] > 0 ? w / 2 + 0.01 : -w / 2 - 0.01)], r * 0.58, 8); };
  const Y = m.yellowPaint, D = m.darkPaint;
  switch (kind) {
    case "forklift":
      L.box(Y, [-0.15, 0.56, 0], [1.8, 0.58, 1.14], 0.06); L.box(Y, [-1.18, 0.78, 0], [0.56, 1.02, 1.2], 0.12); L.cyl(Y, [-1.22, 1.22, -0.58], [-1.22, 1.22, 0.58], 0.2, 8);
      L.box(Y, [-0.5, 0.98, 0], [0.92, 0.26, 1.02], 0.05); L.cyl(m.whitePaint, [-1.22, 1.52, -0.36], [-1.22, 1.52, 0.36], 0.15, 6); L.box(D, [-0.6, 1.3, 0], [0.5, 0.35, 0.5]);
      for (const sz of [-1, 1]) {
        L.beam(D, [0.34, 0.86, sz * 0.52], [0.2, 2.16, sz * 0.52], 0.08, 0.08); L.beam(D, [-0.98, 1.0, sz * 0.52], [-0.94, 2.16, sz * 0.52], 0.08, 0.08);
        L.box(D, [0.82, 1.23, sz * 0.35], [0.13, 2.28, 0.08]); L.box(m.steel, [1.56, 0.07, sz * 0.28], [1.14, 0.05, 0.12]);
        w8([0.45, 0.37, sz * 0.62], 0.37, 0.26); w8([-1.02, 0.3, sz * 0.55], 0.3, 0.2);
      }
      L.box(D, [-0.37, 2.18, 0], [1.34, 0.07, 1.1]); for (const y of [0.18, 1.25, 2.33]) L.box(D, [0.82, y, 0], [0.12, 0.09, 0.8]); L.box(D, [0.96, 0.9, 0], [0.05, 0.9, 0.9]);
      return true;
    case "truck":
      L.box(D, [-0.1, 0.78, 0], [6.2, 0.3, 1.1]); L.box(Y, [2.35, 1.42, 0.12], [1.3, 0.95, 1.46], 0.08); L.box(D, [3.01, 1.38, 0.12], [0.04, 0.62, 1.0]);
      L.box(Y, [1.35, 1.5, -0.28], [1.6, 0.85, 1.55], 0.06); L.box(m.windowDark, [1.35, 2.38, -0.28], [1.5, 0.9, 1.45]); L.box(Y, [1.35, 2.88, -0.28], [1.72, 0.14, 1.66]);
      L.cyl(m.galv, [0.55, 0.78, -0.92], [1.95, 0.78, -0.92], 0.3, 8); L.cyl(m.steel, [0.52, 1.1, 0.72], [0.52, 3.3, 0.72], 0.075, 6); L.box(D, [-1.45, 1.1, 0], [1.3, 0.25, 1.2]);
      for (const sz of [-1, 1]) { w8([2.25, 0.54, sz * 0.9], 0.54, 0.34); w8([-1.45, 0.54, sz * 0.93], 0.54, 0.6); L.box(D, [-1.45, 1.14, sz * 0.95], [1.3, 0.05, 0.72]); }
      return true;
    case "chassis": {
      const F = paint("#3b3f45", { rough: 0.55, name: "chassis-grey" });
      for (const sz of [-0.5, 0.5]) L.box(F, [0, 1.2, sz], [12.3, 0.3, 0.2]);
      L.box(m.steel, [0, 1.36, 0], [12.3, 0.025, 1.26]);
      for (let k = 0; k < 5; k++) L.box(F, [-5.2 + k * 2.6, 1.22, 0], [0.12, 0.22, 1.9]);
      for (const sx of [-1, 1]) L.box(F, [sx * 6.05, 1.24, 0], [0.24, 0.3, 2.44]);
      for (const sz of [-0.55, 0.55]) L.box(Y, [3.6, 0.72, sz], [0.14, 1.0, 0.14]);
      for (const ax of [-3.9, -5.1]) for (const sz of [-1, 1]) w8([ax, 0.5, sz * 0.86], 0.5, 0.56, m.galv);
      return true;
    }
    case "hatch-cover": {
      const G = paint("#4a7a50", { rough: 0.62, grime: 0.55, name: "hatch-green" });
      L.box(G, [0, 0.44, 0], [12.0, 0.72, 4.8], 0.04); L.box(G, [0, 1.24, 0], [11.5, 0.72, 4.5], 0.04);
      for (const yy of [0.8, 1.6]) for (let i = 0; i < 8; i++) L.box(G, [-5.0 + i * 1.43, yy + 0.03, 0], [0.1, 0.06, yy > 1 ? 4.2 : 4.5]);
      L.box(m.rust, [0, 0.13, 0], [12.01, 0.1, 4.81]); L.box(m.rust, [0, 0.93, 0], [11.51, 0.1, 4.51]);
      L.box(m.rubber, [0, 0.68, 0], [12.02, 0.05, 4.82]); L.box(m.rubber, [0, 1.48, 0], [11.52, 0.05, 4.52]);
      for (const sx of [-4.5, 0, 4.5]) L.box(m.wood, [sx, 0.04, 0], [0.3, 0.08, 4.4]);
      return true;
    }
    case "lashing-cage":
      L.box(m.galv, [0, 0.6, 0], [2.36, 1.2, 1.76]); L.box(Y, [0, 0.1, 0], [2.42, 0.12, 1.2]);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) L.box(m.galv, [sx * 1.16, 0.9, sz * 0.86], [0.09, 1.8, 0.09]);
      for (const sz of [-1, 1]) L.box(m.galv, [0, 1.765, sz * 0.86], [2.4, 0.07, 0.07]); for (const sx of [-1, 1]) L.box(m.galv, [sx * 1.16, 1.765, 0], [0.07, 0.07, 1.8]);
      return true;
    case "pipe-stack": { const P = paint("#3a3634", { rough: 0.6, grime: 0.3, name: "pipe-black" }); for (const [n, yy] of [[3, 0.36], [2, 0.78], [1, 1.19]] as Array<[number, number]>) for (let i = 0; i < n; i++) L.cyl(P, [-2.9, yy, (i - (n - 1) / 2) * 0.485], [2.9, yy, (i - (n - 1) / 2) * 0.485], 0.24, 6); for (const sx of [-2.2, 0, 2.2]) L.box(m.wood, [sx, 0.06, 0], [0.14, 0.12, 2.3]); for (const sx of [-1.5, 1.5]) L.box(Y, [sx, 0.7, 0], [0.05, 1.2, 1.5]); return true; }
    case "timber-stack": L.box(m.wood, [0, 0.62, 0], [4.6, 1.02, 2.0], 0.03); L.box(m.wood, [0.1, 1.42, 0], [4.6, 0.58, 2.0], 0.03); for (const sx of [-1.2, 1.2]) L.box(Y, [sx, 0.9, 0], [0.05, 1.7, 2.04]); for (const sx of [-1.8, 1.8]) L.box(m.wood, [sx, 0.04, 0], [0.14, 0.08, 1.9]); return true;
    case "barrier": L.box(m.concrete, [0, 0.15, 0], [2.96, 0.3, 0.6]); L.box(m.concrete, [0, 0.6, 0], [2.96, 0.6, 0.26]); L.box(m.hazard, [0, 0.78, 0], [2.9, 0.12, 0.28]); return true;
    case "tyre-wall": for (const d of [-1.25, 0, 1.25]) for (let k = 0; k < 3; k++) L.cyl(m.rubber, [d, k * 0.27, 0], [d, k * 0.27 + 0.26, 0], 0.86, 8); return true;
    case "tyres": for (let k = 0; k < 4; k++) L.cyl(m.rubber, [0, k * 0.27, 0], [0, k * 0.27 + 0.26, 0], 0.86, 8); return true;
    case "winch": { const O = paint("#d9661f", { rough: 0.5, grime: 0.4, name: "winch-orange" }); L.box(D, [0, 0.09, 0], [2.0, 0.18, 1.24]); for (const sx of [-0.75, 0.35]) L.box(O, [sx, 0.7, 0], [0.12, 1.06, 1.2]); L.cyl(m.galv, [-0.66, 0.72, 0], [0.26, 0.72, 0], 0.4, 10); L.box(O, [0.62, 0.72, 0], [0.42, 0.9, 0.9]); L.cyl(D, [0.84, 0.62, 0], [0.98, 0.62, 0], 0.34, 8); L.box(O, [-0.2, 1.28, 0.2], [1.1, 0.04, 0.8]); return true; }
    case "bin": L.box(paint("#2f5a3a", { rough: 0.6, grime: 0.5, name: "skip-green" }), [0, 0.62, 0], [1.7, 1.1, 1.1], 0.04); L.box(D, [0, 1.19, 0], [1.72, 0.04, 1.12]); for (const sx of [-0.8, 0.8]) L.box(Y, [sx, 0.9, 0], [0.06, 0.12, 1.14]); return true;
    case "generator": L.box(D, [0, 0.12, 0], [2.6, 0.24, 1.3]); L.box(Y, [0, 0.95, 0], [2.5, 1.45, 1.25], 0.06); L.box(Y, [0, 1.72, 0], [2.58, 0.08, 1.33]); for (const sz of [-1, 1]) L.box(D, [-0.7, 1.0, sz * 0.63], [0.8, 0.8, 0.02]); L.cyl(m.steel, [0.9, 1.75, 0.3], [0.9, 2.6, 0.3], 0.07, 6); return true;
    case "spool": for (const sd of [-0.54, 0.54]) L.cyl(m.wood, [0, 0.8, sd], [0, 0.8, sd + Math.sign(sd) * 0.08], 0.8, 10); L.cyl(m.rubber, [0, 0.8, -0.5], [0, 0.8, 0.5], 0.55, 10); return true;
    case "crate": L.box(m.wood, [0, 0.5, 0], [1.1, 1.0, 1.1]); for (const sy of [0.04, 0.96]) L.box(m.wood, [0, sy, 0], [1.14, 0.08, 1.14]); return true;
    case "crate-stack": L.box(m.wood, [0, 0.5, 0], [1.1, 1.0, 1.1]); L.box(m.wood, [0.04, 1.47, -0.03], [1.05, 0.95, 1.05], 0, [0, 0.12, 0]); for (const sy of [0.04, 0.96]) L.box(m.wood, [0, sy, 0], [1.14, 0.08, 1.14]); return true;
    case "barrel": L.cyl(m.bluePaint, [0, 0, 0], [0, 0.9, 0], 0.3, 8); return true;
    case "bollard": L.cyl(Y, [0, 0, 0], [0, 0.62, 0], 0.3, 8); L.cyl(Y, [0, 0.62, 0], [0, 1.0, 0], 0.42, 8); return true;
    case "cone": L.cyl(paint("#f06a1c", { rough: 0.5, name: "cone-orange" }), [0, 0, 0], [0, 0.72, 0], 0.17, 6, { r1: 0.02 }); return true;
    case "booth": L.box(m.concrete, [0, 0.1, 0], [2.4, 0.2, 2.4]); L.box(m.whitePaint, [0, 0.65, 0], [2.0, 0.9, 2.0]); L.box(m.windowDark, [0, 1.6, 0], [1.9, 1.0, 1.9]); L.box(Y, [0, 2.2, 0], [2.4, 0.18, 2.4]); return true;
    case "scale-house": L.box(m.wallWhite, [0, 1.8, 0], [6.2, 3.1, 4.2]); L.box(m.windowDark, [0.6, 1.9, 0], [3.4, 1.1, 4.24]); L.box(m.bluePaint, [0, 3.5, 0], [7.4, 0.3, 5.4]); return true;
  }
  return false;
}
/** LO pallets (≤ ~100 tris): a plywood base + the load as one textured block (printed banana boxes / a wood crate /
 *  an open slatted crate whose fruit comes from the banana kit / four drums) */
function loPallet(b: Builder, m: HarborMats, kind: string, a: string, b2: string) {
  const L = local(b, new THREE.Matrix4());
  const one = (y: number, load: string) => {
    L.box(m.plywood, [0, y + 0.068, 0], [1.2, 0.136, 1.0]);
    const t = y + 0.136;
    if (load === "boxes" || load === "bananas") { const h = load === "bananas" ? 0.915 : 0.61; L.box(bananaBoxMat(), [0, t + h / 2, 0], [1.14, h, 0.94]); return t + h; }
    if (load === "crates") { L.box(m.wood, [0, t + 0.475, 0], [1.08, 0.95, 0.98]); return t + 0.95; }
    if (load === "slatted") { for (const sz of [-1, 1]) L.box(m.wood, [0, t + 0.28, sz * 0.47], [1.18, 0.5, 0.05]); for (const sx of [-1, 1]) L.box(m.wood, [sx * 0.57, t + 0.28, 0], [0.05, 0.5, 0.9]); return t + 0.55; }
    return t;
  };
  if (kind === "drum-pallet") { const t = one(0, "empty"); for (const [x, z] of [[-0.3, -0.25], [0.3, -0.25], [-0.3, 0.25], [0.3, 0.25]]) L.cyl(a === "0" ? m.bluePaint : m.redPaint, [x, t, z], [x, t + 0.82, z], 0.27, 8); return; }
  if (kind === "pallet") { one(0, a === "slatted" ? "slatted" : a); return; }
  const t = one(0, a);
  one(t, b2);
}

/** a prototype builder at the origin (yaw 0) for a key */
function protoFn(key: string, mats: HarborMats): (b: Builder, detail: boolean) => void {
  const [kind, a, b2] = key.split(":");
  return (b, detail) => {
    if (!detail && (kind === "pallet" || kind === "pallet-stack" || kind === "drum-pallet")) { loPallet(b, mats, kind, a, b2); return; }
    if (!detail && loProto(kind, b, mats)) return;
    DETAIL = detail;
    const O: V3 = [0, 0, 0];
    switch (kind) {
      case "forklift": forkliftInto(b, mats, O, 0); break;
      case "truck": tractorInto(b, mats, 0, 0, 0, 0); break;
      case "chassis": chassisInto(b, mats, 0, 0, 0, 0); break;
      case "hatch-cover": hatchCoverInto(b, mats, 0, 0, 0, 0); break;
      case "lashing-cage": lashingCageInto(b, mats, 0, 0, 0, 0); break;
      case "pipe-stack": pipeStackInto(b, mats, 0, 0, 0, 0); break;
      case "timber-stack": timberStackInto(b, mats, 0, 0, 0, 0); break;
      case "barrier": barrierInto(b, mats, 0, 0, 0, 0); break;
      case "scale-house": scaleHouseInto(b, mats, 0, 0, 0, 0); break;
      case "booth": boothInto(b, mats, 0, 0, 0, 0); break;
      case "tyre-wall": tyreWallInto(b, mats, 0, 0, 0, 0); break;
      case "bin": binInto(b, mats, 0, 0, 0, 0); break;
      case "winch": winchInto(b, mats, 0, 0, 0, 0); break;
      case "crate": b.add(mats.wood, crate(), trs(O)); break;
      case "crate-stack": b.add(mats.wood, crate(), trs(O)); b.add(mats.wood, crate(), trs([0.04, 1.0, -0.03], 0.12, 0, 0, [0.95, 0.95, 0.95])); break;
      case "bollard": bollard(b, mats, 0, 0, 0); break;
      case "generator": generator(b, mats, 0, 0, 0, 0, a === "0" ? 0.2 : 0.8); break;
      case "tyres": tyres(b, mats, 0, 0, 0); break;
      case "barrel": barrel(b, mats, 0, 0, 0, a === "0" ? 0.1 : a === "1" ? 0.5 : 0.9); break;
      case "spool": spool(b, mats, 0, 0, 0, 0); break;
      case "cone": cone(b, mats, 0, 0, 0); break;
      case "drum-pallet": drumPallet(b, mats, 0, 0, 0, 0, a === "0" ? 0.2 : 0.8); break;
      case "pallet": palletInto(b, mats, O, 0, (a as PalletLoad) === "slatted" ? "empty" : (a as PalletLoad), 0.5); if (a === "slatted") slattedCrate(b, mats, 0.136); break;
      case "pallet-stack": {
        const t = palletInto(b, mats, O, 0, a as PalletLoad, 0.5);
        if (b2 === "slatted") { palletInto(b, mats, [0, t, 0], 0.03, "empty", 0.5); slattedCrate(b, mats, t + 0.136, 0.03); } else palletInto(b, mats, [0, t, 0], 0.03, b2 as PalletLoad, 0.5);
        break;
      }
    }
    DETAIL = true;
  };
}
/** draw one prop spec into a builder under `base` (warehouse halls: the IndoorBuilder) — the same prototype the yard
 *  batches, at full detail */
export function propInto(b: Builder, mats: HarborMats, p: PropSpec, base: THREE.Matrix4) {
  const key = protoKey(p, hash(p.x, p.z));
  const prev = b.base; b.base = base.clone().multiply(trs([p.x, p.y ?? 0, p.z], p.yaw, 0, 0, [p.s ?? 1, p.s ?? 1, p.s ?? 1]));
  DETAIL = true; protoFn(key, mats)(b, true);
  b.base = prev;
}
/** the open slatted crate of a banana pallet (the fruit is instanced separately per placement) */
function slattedCrate(b: Builder, m: HarborMats, top: number, yaw = 0) {
  const base = trs([0, 0, 0], yaw);
  const add = (mat: THREE.Material, pos: V3, size: V3) => b.add(mat, new THREE.BoxGeometry(size[0], size[1], size[2]), base.clone().multiply(trs(pos)));
  const H = 0.55;
  for (const sz of [-1, 1]) for (let k = 0; k < 3; k++) add(m.wood, [0, top + 0.1 + k * 0.18, sz * 0.47], [1.18, 0.12, 0.05]);
  for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) add(m.wood, [sx * 0.57, top + 0.1 + k * 0.18, 0], [0.05, 0.12, 0.9]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(m.wood, [sx * 0.56, top + H / 2, sz * 0.46], [0.08, H, 0.08]);
  add(m.plywood, [0, top + 0.03, 0], [1.1, 0.04, 0.9]);
  // a dark bed of fruit inside so the gaps between the hands never show the crate floor
  add(bananaBed(), [0, top + H - 0.2, 0], [1.06, 0.2, 0.86]);
}
let bedMat: THREE.MeshStandardMaterial | null = null;
const bananaBed = () => (bedMat ??= new THREE.MeshStandardMaterial({ color: "#a47514", roughness: 0.7, name: "banana-bed" }));

/** props are prototypes drawn through PropBatcher (HI ≤ 55 m with shadows, LO to 340 m); the pallets' banana hands
 *  are instanced per 128 m cell; tall lamps / light towers are one merged group seen from far */
export const part: Part = {
  id: "props",
  async build({ ctx, mats, group, lod, c1 }) {
    const pb = new PropBatcher();
    // lamps + light towers: ONE merged builder for the whole terminal (perf: 7 cells × 2 materials × the shadow
    // passes = 34 draw calls at kong eye), shown/hidden together with their HLOD proxy on ONE metric (the group's box)
    const tallB = new Builder(true);
    const tallOf = (_x: number, _z: number) => tallB;
    // ONE banana kit for the whole yard: per-instance LOD (buildLod) makes 128 m cells unnecessary — 1 skins draw
    // + ≤ 4 instanced fruit draws
    const fruitKit = new BananaKit();
    const fruitCells = new Map<string, BananaKit>([["yard", fruitKit]]);
    const kitOf = (_x: number, _z: number) => fruitKit;
    let nP = 0;
    for (const p of PROPS as PropSpec[]) {
      if (++nP % 48 === 0) await ctx.yield();
      const y = p.y ?? APRON_Y, h = hash(p.x, p.z);
      if (p.kind === "lamp") { lamp(tallOf(p.x, p.z), mats, p.x, y, p.z, p.yaw); continue; }
      if (p.kind === "light-tower") { lightTowerInto(tallOf(p.x, p.z), mats, p.x, y, p.z); continue; }
      if (p.kind === "reefer-rack") continue;
      const key = protoKey(p, h);
      pb.proto(key, protoFn(key, mats));
      const sc = p.s ?? 1, m = trs([p.x, y, p.z], p.yaw, 0, 0, [sc, sc, sc]);
      pb.add(key, m);
      // banana hands in the open crates (per placement, random): pallet → crate at 0.136, stack → on the second pallet
      const [kind, a, b2] = key.split(":");
      if (kind === "pallet" && a === "slatted") kitOf(p.x, p.z).crate(m.clone().multiply(trs([0, 0.136, 0])), 1.1 * sc, 0.9 * sc, 0.55 * sc, Math.floor(h * 9973), 1.05 * sc);
      if (kind === "pallet-stack" && b2 === "slatted") {
        const t = a === "crates" ? 0.136 + 0.95 : a === "boxes" ? 0.136 + 2 * 0.305 : 0.136;
        kitOf(p.x, p.z).crate(m.clone().multiply(trs([0, t + 0.136, 0], 0.03)), 1.1 * sc, 0.9 * sc, 0.55 * sc, Math.floor(h * 9973), 1.05 * sc);
      }
    }
    // HI within 24 m (inside the c0 shadow split: they cast into cascade 0 only), the merged LO beyond
    // (`?nocull` = the parity tool: every prop at its HI detail, like the harbor's other detail tiers)
    const nocull = flag("nocull");
    await ctx.yield();
    const batch = await pb.buildAsync({ name: "props", near: nocull ? 2000 : 24, far: nocull ? 2000 : 260 }, () => ctx.yield());
    await ctx.yield();
    group.add(batch);
    const inv = new THREE.Matrix4(), cam = new THREE.Vector3();
    // (the batcher does its own per-instance distance bucketing — not registered with HarborLod, whose bounds are taken
    // at build time when every bucket is still empty)
    // seen from the air (> 40 m up and > 250 m from the terminal's middle) every prop stays on as its light stand-in, so the yard reads
    // as a busy working port from the plane / glider (rather than dropping out beyond 260 m and leaving a bare slab); in the
    // yard itself only the props within 260 m are drawn
    ctx.onUpdate(() => {
      inv.copy(group.matrixWorld).invert(); cam.copy(ctx.camera.position).applyMatrix4(inv);
      // (pop-proof: the far edge is a ramp, not a STEP (1600 m above 40 m, 180 m below) that drops the whole yard's
      // props at once when a glide sinks through 40 m: 180 m up to 40 m (on foot — the
      // props' LO tier is 36–53 draws, measured), out to 1600 m by 160 m up, so a glide sheds them one by one far out)
      pb.far = nocull ? 2000 : 180 + 1420 * Math.min(1, Math.max(0, (cam.y - 40) / 120));
      pb.update(cam);
    });
    const lamps = new THREE.Group(); lamps.name = "lamps";
    lamps.add(await tallB.buildAsync("lamps-all", { palette: () => true }, () => ctx.yield()));
    group.add(lamps);
    const lampsFar = harborFarProxy({ lamps: true, name: "lamps-far" });
    group.add(lampsFar);
    lampsFar.userData.c1Shadow = false; c1.push(lampsFar);
    mergeCasters(lamps, { farShadow: false, c1: false });
    // (the masts are ONE draw and resident: switched, 9 lamp masts appeared at 362–518 m in one frame)
    lod.pair(lamps, lampsFar, 230, { shadow: 90 });
    // the skinned heaps (one draw per cell) carry the read from 400 m; the few hero hands on top: per-instance LOD, the
    // full model within 30 m, the 3-segment one to 110 m
    for (const [k, bk] of fruitCells) {
      const bn = bk.buildLod({ name: `yard-bananas-${k}`, near: 30, far: 75 });
      const skins = bn.children.find((c) => c.name.endsWith("-skins"));
      if (skins) { bn.remove(skins); skins.name = `yard-banana-skins-${k}`; group.add(skins); lod.add(skins, { show: 420 }); }
      group.add(bn);
      const inv2 = new THREE.Matrix4(), cam2 = new THREE.Vector3();
      ctx.onUpdate(() => { inv2.copy(group.matrixWorld).invert(); bn.update(cam2.copy(ctx.camera.position).applyMatrix4(inv2)); });
    }
  },
};
