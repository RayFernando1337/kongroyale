// BANANA CO. jump plane (drop-01-plane-exterior). Owned by the actors area.
// Contract (keep the exports — showcase.ts, the lobby islet and gameplay use them):
//   createPlane(ctx)  → PlaneProps  (a ~28 m long twin-prop cargo plane, nose toward -Z, origin at the belly centre,
//                                    y = 0 at the bottom of the wheels when the gear is down)
//   views             → view cameras this piece owns (main: "drop-01-plane-exterior"; dev: "wip-plane-*")
//   stage(ctx, id)    → places the plane for a stage hint ("plane" = in flight for drop-01; "wip-plane" = dev)
//
// Everything is procedural: lofted parametric surfaces (fuselage, sponsons, wings, fin, nacelles, cowls, blades, tyres)
// with analytic-ish normals, canvas-painted colour maps + height-derived normal maps + roughness maps (paint, panel
// lines, rivets, cheat line, cockpit glazing, "BANANA CO." livery, banana-leaf fin art, grime/soot/wear).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { WorldCtx } from "../engine/engine";
import type { CamSpec } from "../engine/views";
import { shareGeometries } from "../engine/geo-share";
import { actorLook } from "./look";
import { createKong, type KongActorEx } from "./kong";
import { KongAnimator } from "./kong-rig";
import type { KongPose } from "./api";

export interface PlaneProps {
  object: THREE.Group;
  /** spin props, ramp animation, gear */
  update(dt: number, t: number): void;
  /** 0 = ramp closed, 1 = fully lowered */
  setRamp(open: number): void;
  /** 0 = gear up (in flight), 1 = gear down (parked) */
  setGear(down: number): void;
  /** true = props spinning (blurred discs), false = stopped blades */
  setEngines(running: boolean): void;
  /** local-space point where a jumper leaves the rear ramp */
  rampExit: THREE.Vector3;
}

// ============================================================================ dimensions (metres, plane-local)
// nose → -Z, +X = starboard (right wing), origin = belly centre on the ground with the gear down.
const TAU = Math.PI * 2;
const ZN = -14, Z_NOSE = -8.9, Z_UP = 4.4, Z_RAMP = 9.4, Z_OPEN = 12, ZE = 14, ZCAP = 14.55;
const BELLY = 1.3, TOP = 5.6, HW = 2.12, NOSE_Y = 3.0, SE = 2.15;
const TAIL_TOP = 5.12, TAIL_BOT = 4.62, TAIL_W = 0.36;
const FLOOR_Y = BELLY + 0.52, SKIN = 0.12;
// opening half-angle (from the belly) at the hinge / at the aft end: the opening is the UNDER-tail ramp only (the sides
// stay closed)
const TH0 = 0.5, TH1 = 0.62;
const WING_Y = 5.84, WING_LE = -4.4, WING_C0 = 4.0, WING_C1 = 2.1, WING_HALF = 17, WING_CENTRE = 6.2, WING_TIP_BROWN = 15.35;
const ENG_X = 5.8, ENG_Y = 5.02, ENG_Z = -7.0, COWL_R = 1.04;
const PROP_R = 2.1, PROP_Z = ENG_Z - 0.3;
const GEAR_TRAVEL = 0.45, WHEEL_R = 0.52, NOSE_WHEEL_R = 0.36, NOSE_GEAR_Z = -11.2, NOSE_TRAVEL = 0.98;
const STAB_Y = 5.3, STAB_LE = 11.0, STAB_HALF = 6.3;
const FIN_Y0 = 4.9, FIN_Y1 = 12.35, FIN_ZMIN = 6.2, FIN_ZMAX = 14.45;
const RAMP_PIVOT = new THREE.Vector3(0, BELLY + 0.16, Z_UP);

// palette (sampled from the drop-01 + char-02 target art, pushed back to albedo)
const YEL = "#f7d418", BROWN = "#4a2a17", BROWN_TIP = "#3a2319", CREAM = "#f4e6bf";
const LEAF_D = "#2d6a2b", LEAF_L = "#4f9a39", LEAF_RIB = "#b9d36b";

// ============================================================================ small maths
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** superellipse quarter: (1 - t^p)^(1/p) */
const ell = (t: number, p: number) => Math.pow(Math.max(0, 1 - Math.pow(clamp01(t), p)), 1 / p);
const sp = (t: number, e: number) => Math.sign(t) * Math.pow(Math.abs(t), e);
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const E2 = 2 / SE;

// ============================================================================ fuselage shape
interface Sec { w: number; cy: number; h: number }
const S0: Sec = { w: 0, cy: 0, h: 0 };
function sec(z: number, o: Sec = S0): Sec {
  if (z < Z_NOSE) {
    const t = clamp01((Z_NOSE - z) / (Z_NOSE - ZN));
    const top = NOSE_Y + (TOP - NOSE_Y) * ell(t, 1.75);
    const bot = NOSE_Y - (NOSE_Y - BELLY) * ell(t, 2.5);
    o.w = HW * ell(t, 2.1); o.cy = (top + bot) / 2; o.h = (top - bot) / 2;
  } else if (z <= Z_UP) {
    o.w = HW; o.cy = (TOP + BELLY) / 2; o.h = (TOP - BELLY) / 2;
  } else if (z <= ZE) {
    const t = (z - Z_UP) / (ZE - Z_UP);
    const top = TOP - (TOP - TAIL_TOP) * t * t;
    const bot = BELLY + (TAIL_BOT - BELLY) * Math.pow(t, 1.12);
    o.w = HW - (HW - TAIL_W) * Math.pow(t, 1.3); o.cy = (top + bot) / 2; o.h = (top - bot) / 2;
  } else {
    sec(ZE, o);
    const k = ell((z - ZE) / (ZCAP - ZE), 2);
    o.w *= k; o.h *= k; o.cy += 0.06 * (1 - k);
  }
  return o;
}
const secBot = (z: number) => { const s = sec(z, { w: 0, cy: 0, h: 0 }); return s.cy - s.h; };
/** a = angle from the belly: 0 bottom, π/2 starboard (+X), π top, 3π/2 port */
function fuse(z: number, a: number, o: THREE.Vector3, inset = 0) {
  const s = sec(z);
  const w = Math.max(0.01, s.w - inset), h = Math.max(0.01, s.h - inset);
  return o.set(w * sp(Math.sin(a), E2), s.cy - h * sp(Math.cos(a), E2), z);
}
/** angle (starboard side) at which the CABIN section reaches world height y */
function aOfY(y: number) {
  const cy = (TOP + BELLY) / 2, h = (TOP - BELLY) / 2;
  return Math.acos(THREE.MathUtils.clamp(sp((cy - y) / h, SE / 2), -1, 1));
}
const theta = (z: number) => TH0 + (TH1 - TH0) * Math.pow(clamp01((z - Z_UP) / (Z_OPEN - Z_UP)), 0.9);
const BAND_Y0 = 3.27, BAND_Y1 = 4.13, CREAM_W = 0.085;
const WIN_Y = (BAND_Y0 + BAND_Y1) / 2;

// ============================================================================ geometry kit
type Fn = (u: number, v: number, o: THREE.Vector3) => void;
interface SurfOpts { flip?: boolean; uv?: (u: number, v: number, p: THREE.Vector3) => [number, number]; ud?: [number, number]; vd?: [number, number]; color?: (u: number, v: number) => THREE.Color }
/** parametric surface on the grid us × vs with normals from the surface derivatives (seam-free across split patches) */
function surface(us: number[], vs: number[], f: Fn, o: SurfOpts = {}): THREE.BufferGeometry {
  const nu = us.length, nv = vs.length, n = nu * nv;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2);
  const C = o.color ? new Float32Array(n * 3) : null;
  const ud = o.ud ?? [us[0], us[nu - 1]], vd = o.vd ?? [vs[0], vs[nv - 1]];
  const ulo = Math.min(ud[0], ud[1]), uhi = Math.max(ud[0], ud[1]), vlo = Math.min(vd[0], vd[1]), vhi = Math.max(vd[0], vd[1]);
  const eu = (uhi - ulo) * 5e-4, ev = (vhi - vlo) * 5e-4;
  const cu = (x: number) => Math.min(uhi, Math.max(ulo, x)), cv = (x: number) => Math.min(vhi, Math.max(vlo, x));
  const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), du = new THREE.Vector3(), dv = new THREE.Vector3();
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const u = us[i], v = vs[j], k = i * nv + j;
    f(u, v, p);
    P[k * 3] = p.x; P[k * 3 + 1] = p.y; P[k * 3 + 2] = p.z;
    let uu = u;
    for (let tries = 0; tries < 8; tries++) {
      f(cu(uu + eu), v, a); f(cu(uu - eu), v, b); du.subVectors(a, b);
      f(uu, cv(v + ev), a); f(uu, cv(v - ev), b); dv.subVectors(a, b);
      du.cross(dv);
      if (du.lengthSq() > 1e-18) break;
      uu = cu(uu + (uu > (ulo + uhi) / 2 ? -1 : 1) * eu * 6 * (tries + 1)); // step off a pole
    }
    du.normalize(); if (o.flip) du.negate();
    N[k * 3] = du.x; N[k * 3 + 1] = du.y; N[k * 3 + 2] = du.z;
    const t = o.uv ? o.uv(u, v, p) : [(u - us[0]) / (us[nu - 1] - us[0] || 1), (v - vs[0]) / (vs[nv - 1] - vs[0] || 1)];
    UV[k * 2] = t[0]; UV[k * 2 + 1] = t[1];
    if (C && o.color) { const c = o.color(u, v); C[k * 3] = c.r; C[k * 3 + 1] = c.g; C[k * 3 + 2] = c.b; }
  }
  const idx: number[] = [];
  for (let i = 0; i < nu - 1; i++) for (let j = 0; j < nv - 1; j++) {
    const a0 = i * nv + j, b0 = (i + 1) * nv + j, c0 = a0 + 1, d0 = b0 + 1;
    if (o.flip) idx.push(a0, c0, b0, b0, c0, d0); else idx.push(a0, b0, c0, b0, d0, c0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(UV, 2));
  if (C) g.setAttribute("color", new THREE.BufferAttribute(C, 3));
  g.setIndex(idx);
  return g;
}
const range = (a: number, b: number, n: number, pow = 1) => Array.from({ length: n + 1 }, (_, i) => a + (b - a) * Math.pow(i / n, pow));
const cosRange = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + (b - a) * (1 - Math.cos((Math.PI * i) / n)) / 2);
function uniq(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s.filter((x, i) => i === 0 || x - s[i - 1] > 1e-6); }
/** keep position/normal/uv (+color if keepColor), indexed — so mergeGeometries accepts mixed sources */
function prep(g: THREE.BufferGeometry, keepColor = false): THREE.BufferGeometry {
  let q = g.index ? g : (() => { const n = g.attributes.position.count; g.setIndex(Array.from({ length: n }, (_, i) => i)); return g; })();
  for (const k of Object.keys(q.attributes)) if (!["position", "normal", "uv", ...(keepColor ? ["color"] : [])].includes(k)) q.deleteAttribute(k);
  if (!q.attributes.uv) q.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(q.attributes.position.count * 2), 2));
  if (!q.attributes.normal) q.computeVertexNormals();
  q = q.index!.array instanceof Uint32Array ? q : q;
  return q;
}
function merge(gs: THREE.BufferGeometry[], keepColor = false) {
  const m = mergeGeometries(gs.map((g) => prep(g, keepColor)), false);
  if (!m) throw new Error("plane: mergeGeometries failed");
  return m;
}
const Q = new THREE.Quaternion(), V1 = new THREE.Vector3(), V2 = new THREE.Vector3();
/** transform a geometry: place at pos, orient +Y (or given axis) along dir */
function place(g: THREE.BufferGeometry, pos: THREE.Vector3, dir?: THREE.Vector3, from = new THREE.Vector3(0, 1, 0), spin = 0) {
  if (spin) g.rotateY(spin);
  if (dir) { Q.setFromUnitVectors(from, V1.copy(dir).normalize()); g.applyQuaternion(Q); }
  g.translate(pos.x, pos.y, pos.z);
  return g;
}
function rbox(w: number, h: number, d: number, r: number, seg = 2) { return new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)); }
/** cylinder between two points */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 10, r2 = r) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r2, r, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  return place(g, a, V2.subVectors(b, a));
}

// ============================================================================ canvas painting kit
interface Tex { map: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture }
function mkCanvas(w: number, h: number) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
const g2d = (c: HTMLCanvasElement) => c.getContext("2d", { willReadFrequently: true })!;
const gray = (v: number) => { const c = Math.round(clamp01(v) * 255); return `rgb(${c},${c},${c})`; };
class Paint {
  readonly cc: HTMLCanvasElement; readonly hc: HTMLCanvasElement; readonly rc: HTMLCanvasElement;
  readonly c: CanvasRenderingContext2D; readonly h: CanvasRenderingContext2D; readonly r: CanvasRenderingContext2D;
  constructor(readonly w: number, readonly H: number, base: string, rough: number) {
    this.cc = mkCanvas(w, H); this.hc = mkCanvas(w, H); this.rc = mkCanvas(w, H);
    this.c = g2d(this.cc); this.h = g2d(this.hc); this.r = g2d(this.rc);
    this.c.fillStyle = base; this.c.fillRect(0, 0, w, H);
    this.h.fillStyle = gray(0.5); this.h.fillRect(0, 0, w, H);
    this.r.fillStyle = gray(rough); this.r.fillRect(0, 0, w, H);
  }
  /** soft tonal blotches — the hand-painted look */
  blotch(n: number, seed: number, rMin: number, rMax: number, a: number, cols = ["255,244,205", "150,86,0"], yMin = 0, yMax = this.H) {
    const R = rng(seed), g = this.c;
    for (let i = 0; i < n; i++) {
      const x = R() * this.w, y = yMin + R() * (yMax - yMin), rr = rMin + R() * (rMax - rMin), col = cols[i % cols.length];
      const gr = g.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, `rgba(${col},${a * (0.4 + R() * 0.6)})`); gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, rr, rr * (0.5 + R() * 0.6), R() * 3, 0, TAU); g.fill();
    }
  }
  /** fine speckle noise on colour + roughness */
  grain(n: number, seed: number, a = 0.05) {
    const R = rng(seed);
    for (let i = 0; i < n; i++) {
      const x = R() * this.w, y = R() * this.H, s = 1 + R() * 2.5, l = R() > 0.5;
      this.c.fillStyle = l ? `rgba(255,248,220,${a})` : `rgba(80,45,0,${a})`; this.c.fillRect(x, y, s, s);
      this.r.fillStyle = l ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.06)"; this.r.fillRect(x, y, s, s);
    }
  }
  /** engraved panel line: height groove + dark ink + a thin highlight */
  line(x0: number, y0: number, x1: number, y1: number, depth = 1, ink = 0.32) {
    const h = this.h, c = this.c;
    h.strokeStyle = gray(0.5 - 0.3 * depth); h.lineWidth = 2.2; h.beginPath(); h.moveTo(x0, y0); h.lineTo(x1, y1); h.stroke();
    c.strokeStyle = `rgba(92,52,6,${ink})`; c.lineWidth = 1.6; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    const nx = y1 - y0, ny = x0 - x1, l = Math.hypot(nx, ny) || 1;
    c.strokeStyle = `rgba(255,248,215,${ink * 0.5})`; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x0 + (nx / l) * 1.6, y0 + (ny / l) * 1.6); c.lineTo(x1 + (nx / l) * 1.6, y1 + (ny / l) * 1.6); c.stroke();
    this.r.strokeStyle = "rgba(255,255,255,0.25)"; this.r.lineWidth = 2; this.r.beginPath(); this.r.moveTo(x0, y0); this.r.lineTo(x1, y1); this.r.stroke();
  }
  /** rivet row along a segment */
  rivets(x0: number, y0: number, x1: number, y1: number, step = 9, off = 5, rows = 1, ink = 0.22) {
    const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.floor(len / step));
    const nx = (y1 - y0) / (len || 1), ny = (x0 - x1) / (len || 1);
    for (let row = 0; row < rows; row++) {
      const o = rows === 1 ? off : row === 0 ? off : -off;
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = x0 + (x1 - x0) * t + nx * o, y = y0 + (y1 - y0) * t + ny * o;
        this.h.fillStyle = gray(0.78); this.h.beginPath(); this.h.arc(x, y, 1.5, 0, TAU); this.h.fill();
        this.c.fillStyle = `rgba(110,64,8,${ink})`; this.c.beginPath(); this.c.arc(x + 0.4, y + 0.4, 1.1, 0, TAU); this.c.fill();
        this.c.fillStyle = `rgba(255,250,225,${ink * 1.2})`; this.c.fillRect(x - 0.8, y - 0.8, 0.9, 0.9);
      }
    }
  }
  /** rounded-rect hatch outline (engraved) */
  hatch(x: number, y: number, w: number, h: number, r: number, rivet = true) {
    for (const [g, style, lw] of [[this.h, gray(0.22), 2.4], [this.c, "rgba(92,52,6,0.4)", 1.7]] as const) {
      g.strokeStyle = style; g.lineWidth = lw; g.beginPath(); g.roundRect(x, y, w, h, r); g.stroke();
    }
    this.c.strokeStyle = "rgba(255,248,215,0.2)"; this.c.lineWidth = 1; this.c.beginPath(); this.c.roundRect(x + 1.6, y + 1.6, w, h, r); this.c.stroke();
    if (rivet) { this.rivets(x - 5, y - 5, x + w + 5, y - 5, 9, 0); this.rivets(x - 5, y + h + 5, x + w + 5, y + h + 5, 9, 0); this.rivets(x - 5, y - 5, x - 5, y + h + 5, 9, 0); this.rivets(x + w + 5, y - 5, x + w + 5, y + h + 5, 9, 0); }
  }
  /** paint chips / scuffs (lighter primer showing through) in a region */
  chips(x: number, y: number, w: number, h: number, n: number, seed: number, col = "235,222,190") {
    const R = rng(seed);
    for (let i = 0; i < n; i++) {
      const cx = x + R() * w, cy = y + R() * h, s = 0.8 + R() * 2.6;
      this.c.fillStyle = `rgba(${col},${0.35 + R() * 0.4})`; this.c.beginPath(); this.c.ellipse(cx, cy, s, s * (0.4 + R() * 0.6), R() * 3, 0, TAU); this.c.fill();
      this.h.fillStyle = gray(0.42); this.h.beginPath(); this.h.ellipse(cx, cy, s, s * 0.6, 0, 0, TAU); this.h.fill();
      this.r.fillStyle = gray(0.6); this.r.beginPath(); this.r.ellipse(cx, cy, s, s * 0.6, 0, 0, TAU); this.r.fill();
    }
  }
  tex(normalStrength: number, aniso = 8, wrap = true): Tex {
    const map = new THREE.CanvasTexture(this.cc); map.colorSpace = THREE.SRGBColorSpace;
    const normal = new THREE.CanvasTexture(heightToNormal(this.hc, normalStrength)); normal.colorSpace = THREE.NoColorSpace;
    const rough = new THREE.CanvasTexture(this.rc); rough.colorSpace = THREE.NoColorSpace;
    for (const t of [map, normal, rough]) { t.anisotropy = aniso; t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; }
    return { map, normal, rough };
  }
}
function heightToNormal(src: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const d = g2d(src).getImageData(0, 0, w, h).data;
  const out = mkCanvas(w, h), g = g2d(out), img = g.createImageData(w, h), o = img.data;
  const H = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) H[i] = d[i * 4] / 255;
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w, yp = ((y + 1) % h) * w, yc = y * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w, xp = (x + 1) % w;
      const dx = (H[yc + xp] - H[yc + xm]) * strength, dy = (H[yp + x] - H[ym + x]) * strength;
      const l = 1 / Math.hypot(dx, dy, 1), k = (yc + x) * 4;
      o[k] = (-dx * l * 0.5 + 0.5) * 255; o[k + 1] = (dy * l * 0.5 + 0.5) * 255; o[k + 2] = (l * 0.5 + 0.5) * 255; o[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}
const FONT = (px: number) => `900 ${px}px "Avenir Next", "Futura", "Arial Black", "Helvetica Neue", sans-serif`;
/** draw centred text at (x,y) with cap height `cap` px, max width `maxW`, with an optional transform flip */
function stencil(g: CanvasRenderingContext2D, txt: string, x: number, y: number, capPx: number, sx: number, sy: number, fill: string, maxW = 1e9, track = 0.06) {
  g.save(); g.translate(x, y); g.scale(sx, sy);
  const px = capPx / 0.72; g.font = FONT(px); g.textAlign = "left"; g.textBaseline = "middle";
  const chars = [...txt]; const widths = chars.map((ch) => g.measureText(ch).width); const tr = px * track;
  const total = widths.reduce((a, b) => a + b, 0) + tr * (chars.length - 1);
  const k = Math.min(1, maxW / total);
  g.scale(k, 1);
  let cx = -total / 2;
  g.fillStyle = fill;
  chars.forEach((ch, i) => { g.fillText(ch, cx, capPx * 0.04); cx += widths[i] + tr; });
  g.restore();
}

// ============================================================================ textures
const X_F = (z: number, W: number) => ((z - ZN) / (ZCAP - ZN)) * W; // fuselage canvas x for z
const Y_F = (a: number, H: number) => (1 - a / TAU) * H;             // fuselage canvas y for angle a
const PORTHOLES = [-8.2, -6.8, -5.4, -4.0, -2.6, -1.2, 0.2, 1.6];

function paintFuselage(): Tex {
  const W = 2048, H = 1024, P = new Paint(W, H, YEL, 0.26), c = P.c;
  const X = (z: number) => X_F(z, W), Y = (a: number) => Y_F(a, H);
  const side = (a: number, s: number) => (s > 0 ? a : TAU - a);
  P.blotch(320, 3, 30, 150, 0.07, ["255,236,170", "170,96,0", "255,214,90"], 40, H - 40);
  P.grain(9000, 5, 0.035);
  // top sun-bleach, belly grime (the belly is the canvas top + bottom rows: a = 0 / 2π)
  let gr = c.createLinearGradient(0, H * 0.36, 0, H * 0.64);
  gr.addColorStop(0, "rgba(255,238,170,0)"); gr.addColorStop(0.5, "rgba(255,238,170,0.12)"); gr.addColorStop(1, "rgba(255,238,170,0)");
  c.fillStyle = gr; c.fillRect(0, 0, W, H);
  for (const [y0, y1] of [[0, H * 0.13], [H, H * 0.87]]) {
    gr = c.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, "rgba(96,58,14,0.34)"); gr.addColorStop(1, "rgba(96,58,14,0)");
    c.fillStyle = gr; c.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0));
    P.r.fillStyle = "rgba(255,255,255,0.12)"; P.r.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0) * 0.6);
  }
  // oil / exhaust streaks along the belly behind the sponsons
  const R = rng(17);
  for (let i = 0; i < 26; i++) {
    const s = R() > 0.5 ? 1 : -1, a = side(0.25 + R() * 0.55, s), z0 = 1.2 + R() * 2.5, len = 2 + R() * 5;
    const y = Y(a), x0 = X(z0), x1 = X(z0 + len);
    gr = c.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, "rgba(70,44,16,0.22)"); gr.addColorStop(1, "rgba(70,44,16,0)");
    c.fillStyle = gr; c.fillRect(x0, y - 1.5 - R() * 3, x1 - x0, 2 + R() * 4);
  }
  // cheat line: cream | brown | cream at window height, full length, both sides
  const a0 = aOfY(BAND_Y0), a1 = aOfY(BAND_Y1), ac0 = aOfY(BAND_Y0 - CREAM_W), ac1 = aOfY(BAND_Y1 + CREAM_W);
  for (const s of [1, -1]) {
    const ys = [ac0, a0, a1, ac1].map((a) => Y(side(a, s)));
    const top = (i: number, j: number) => [Math.min(ys[i], ys[j]), Math.abs(ys[j] - ys[i])] as const;
    const x0 = X(ZN + 0.25), x1 = W;
    let [yy, hh] = top(0, 3); c.fillStyle = CREAM; c.fillRect(x0, yy, x1 - x0, hh);
    [yy, hh] = top(1, 2); c.fillStyle = BROWN; c.fillRect(x0, yy, x1 - x0, hh);
    // painted-edge gloss + subtle hand-painted shading on the brown band
    gr = c.createLinearGradient(0, yy, 0, yy + hh);
    gr.addColorStop(0, "rgba(120,72,40,0.35)"); gr.addColorStop(0.5, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(20,8,0,0.25)");
    c.fillStyle = gr; c.fillRect(x0, yy, x1 - x0, hh);
    P.r.fillStyle = gray(0.3); P.r.fillRect(x0, yy, x1 - x0, hh);
    P.h.fillStyle = gray(0.53); P.h.fillRect(x0, Math.min(ys[0], ys[3]), x1 - x0, Math.abs(ys[3] - ys[0])); // slightly raised decal edge
  }
  // porthole gaskets painted under the geometric frames
  for (const s of [1, -1]) for (const z of PORTHOLES) {
    const x = X(z), y = Y(side(aOfY(WIN_Y), s));
    c.fillStyle = "rgba(20,10,4,0.55)"; c.beginPath(); c.arc(x, y, 23, 0, TAU); c.fill();
    P.h.fillStyle = gray(0.35); P.h.beginPath(); P.h.arc(x, y, 23, 0, TAU); P.h.fill();
  }
  // circumferential panel joints + rivet rows
  const frames = [-12.6, -10.1, -8.6, -7.5, -6.1, -4.7, -3.3, -1.9, -0.5, 0.9, 2.3, 4.4, 5.9, 7.5, 9.4, 10.8, 12.0, 13.2];
  for (const z of frames) {
    const x = X(z), strong = z === Z_UP || z === Z_RAMP || z === Z_OPEN;
    P.line(x, 0, x, H, strong ? 1.4 : 1, strong ? 0.45 : 0.3);
    P.rivets(x, 0, x, H, 9, 5, 2);
  }
  // longitudinal seams (both sides) + top centre seam
  for (const a of [0.42, 1.08, 2.08, 2.62]) for (const s of [1, -1]) {
    const y = Y(side(a, s)); P.line(X(-12.6), y, X(13.2), y, 0.9, 0.26); P.rivets(X(-12.6), y, X(13.2), y, 9, 5, 2, 0.18);
  }
  { const y = Y(Math.PI); P.line(X(-10.1), y, X(13.2), y, 0.8, 0.22); P.rivets(X(-10.1), y, X(13.2), y, 9, 4, 1, 0.16); }
  // doors + hatches (rounded rects in (z, world-y) → canvas); paratroop doors both sides, crew door port side
  const rectZY = (z0: number, z1: number, y0: number, y1: number, s: number) => {
    const ya = Y(side(aOfY(y0), s)), yb = Y(side(aOfY(y1), s));
    return [X(z0), Math.min(ya, yb), X(z1) - X(z0), Math.abs(yb - ya)] as const;
  };
  for (const s of [1, -1]) {
    const [x, y, w, h] = rectZY(2.62, 3.82, 1.92, 3.12, s);
    P.hatch(x, y, w, h, 7);
    const [wx, wy, ww, wh] = rectZY(2.95, 3.49, 2.66, 2.98, s);
    c.fillStyle = "#16202a"; c.beginPath(); c.roundRect(wx, wy, ww, wh, 5); c.fill();
    c.fillStyle = "rgba(150,190,220,0.35)"; c.fillRect(wx + 3, wy + 2, ww * 0.35, wh * 0.4);
    P.r.fillStyle = gray(0.06); P.r.fillRect(wx, wy, ww, wh);
    P.h.fillStyle = gray(0.3); P.h.fillRect(wx, wy, ww, wh);
    const [hx, hy] = rectZY(3.52, 3.66, 2.3, 2.42, s);
    c.fillStyle = "#6b6258"; c.fillRect(hx, hy, 10, 5); P.h.fillStyle = gray(0.8); P.h.fillRect(hx, hy, 10, 5);
    // little square service hatch + lower cargo windows (target art: row of small dark windows under the band)
    const [sx, sy, sw, sh] = rectZY(1.9, 2.35, 2.72, 3.08, s); P.hatch(sx, sy, sw, sh, 3, false);
    for (const z of [-9.3, -7.9, -6.5, -5.1, 0.95]) {
      const [lx, ly, lw, lh] = rectZY(z, z + 0.26, 2.48, 2.86, s);
      c.fillStyle = "#1a2129"; c.beginPath(); c.roundRect(lx, ly, lw, lh, 4); c.fill();
      c.fillStyle = "rgba(170,205,230,0.3)"; c.fillRect(lx + 2, ly + 2, lw * 0.4, lh * 0.35);
      c.strokeStyle = "rgba(60,36,10,0.5)"; c.lineWidth = 2; c.strokeRect(lx - 1, ly - 1, lw + 2, lh + 2);
      P.r.fillStyle = gray(0.06); P.r.fillRect(lx, ly, lw, lh); P.h.fillStyle = gray(0.32); P.h.fillRect(lx, ly, lw, lh);
    }
  }
  { const [x, y, w, h] = rectZY(-8.75, -7.75, 1.95, 3.15, -1); P.hatch(x, y, w, h, 8); }
  // top escape hatches
  for (const z of [-6.8, 1.4]) { const x = X(z), y = Y(Math.PI); P.hatch(x - 22, y - 22, 44, 44, 5, false); }
  // nose gear well (belly, wraps the canvas seam)
  for (const [yy, hh] of [[Y(0.24), H - Y(0.24)], [0, Y(TAU - 0.24)]]) {
    c.fillStyle = "#17110d"; c.fillRect(X(-11.95), yy, X(-10.35) - X(-11.95), hh);
    P.r.fillStyle = gray(0.8); P.r.fillRect(X(-11.95), yy, X(-10.35) - X(-11.95), hh);
  }
  // ramp + upper door seams are the strong frames above; hinge line rivets
  // cockpit glazing: wrap-around panes (dark tinted glass, glossy), yellow frames between them
  const pane = (z0: number, z1: number, aa0: number, aa1: number, s: number, skew = 0) => {
    const pts: [number, number][] = [[z0 + skew, aa0], [z1, aa0], [z1, aa1], [z0, aa1]];
    const q = pts.map(([z, a]) => [X(z), Y(side(a, s))] as [number, number]);
    for (const [g, style] of [[c, "#101920"], [P.r, gray(0.05)], [P.h, gray(0.28)]] as const) {
      g.fillStyle = style; g.beginPath(); q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
    }
    // sky reflection gradient on the glass
    const ys = q.map((p) => p[1]), yMin = Math.min(...ys), yMax = Math.max(...ys);
    const rg = c.createLinearGradient(0, yMin, 0, yMax);
    rg.addColorStop(0, "rgba(120,170,210,0.28)"); rg.addColorStop(0.55, "rgba(40,70,95,0.08)"); rg.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = rg; c.beginPath(); q.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill();
    c.strokeStyle = "rgba(30,18,6,0.8)"; c.lineWidth = 2.5; c.stroke();
  };
  for (const s of [1, -1]) {
    pane(-12.92, -12.02, 2.66, 3.09, s, 0.12);      // windscreen (centre post at a = π)
    pane(-12.52, -11.42, 2.2, 2.6, s, 0.1);         // side pane 1
    pane(-11.28, -10.36, 2.12, 2.52, s);            // side pane 2
    pane(-12.1, -11.5, 2.7, 3.05, s);               // eyebrow window
  }
  // radome: dark glossy nose cap
  { const x1 = X(-13.18); c.fillStyle = "#2a1c15"; c.fillRect(0, 0, x1, H);
    gr = c.createLinearGradient(0, 0, x1, 0); gr.addColorStop(0, "rgba(0,0,0,0.3)"); gr.addColorStop(1, "rgba(90,60,40,0.25)"); c.fillStyle = gr; c.fillRect(0, 0, x1, H);
    P.r.fillStyle = gray(0.26); P.r.fillRect(0, 0, x1, H);
    P.line(x1, 0, x1, H, 1.2, 0.5); c.fillStyle = "rgba(244,230,190,0.5)"; c.fillRect(x1 + 3, 0, 3, H); }
  // BANANA CO. above the cheat line between cockpit and wing, both sides reading nose-ward/aft correctly
  for (const s of [1, -1]) {
    const zc = -6.95, yc = 4.72, a = side(aOfY(yc), s);
    const pxPerM = W / (ZCAP - ZN);
    stencil(c, "BANANA CO.", X(zc), Y(a), 0.5 * pxPerM, s > 0 ? -1 : 1, s > 0 ? 1 : -1, BROWN, 3.7 * pxPerM);
    P.r.globalAlpha = 1;
  }
  // wear: chips around doors, ramp hinge + edges, nose; scuffs near the belly
  for (const s of [1, -1]) {
    const [x, y, w, h] = rectZY(2.5, 3.95, 1.85, 3.2, s); P.chips(x, y, w, h, 40, 30 + s);
    P.chips(X(Z_UP) - 30, 0, 60, H, 90, 40 + s);
  }
  P.chips(X(-13.2), 0, X(-12) - X(-13.2), H, 70, 51);
  P.chips(0, H * 0.9, W, H * 0.1, 160, 52, "90,60,30"); P.chips(0, 0, W, H * 0.1, 160, 53, "90,60,30");
  return P.tex(5.5);
}

// lifting surfaces (wing / stabiliser). Canvas x = span (port tip → starboard tip), y = chord around:
// top row = trailing edge upper, middle = leading edge, bottom row = trailing edge lower.
interface LiftSpec { half: number; tipBrown: number; seams: number[]; hingeXc: number; hingeFrom: number; hingeTo: number; ribs: number; soot?: number[]; stripe?: boolean; seed: number }
function paintLift(W: number, H: number, L: LiftSpec): Tex {
  const P = new Paint(W, H, YEL, 0.26), c = P.c;
  const X = (x: number) => ((x + L.half) / (2 * L.half)) * W;
  const Yu = (xc: number) => (0.5 - xc / 2) * H, Yl = (xc: number) => (0.5 + xc / 2) * H;
  P.blotch(160, L.seed, 20, 90, 0.07); P.grain(4000, L.seed + 1, 0.035);
  // upper surface slightly bleached, lower a touch dirtier
  let gr = c.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, "rgba(255,236,170,0.1)"); gr.addColorStop(0.5, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(110,64,10,0.14)");
  c.fillStyle = gr; c.fillRect(0, 0, W, H);
  // spar lines + ribs + control surface hinge + separators
  for (const xc of [0.14, 0.62]) for (const Yf of [Yu, Yl]) { P.line(0, Yf(xc), W, Yf(xc), 0.8, 0.22); P.rivets(0, Yf(xc), W, Yf(xc), 8, 4, 2, 0.16); }
  for (const s of [1, -1]) for (const Yf of [Yu, Yl]) {
    const x0 = X(s * L.hingeFrom), x1 = X(s * L.hingeTo);
    P.line(Math.min(x0, x1), Yf(L.hingeXc), Math.max(x0, x1), Yf(L.hingeXc), 1.3, 0.42);
    for (const sx of L.seams) P.line(X(s * sx), Yf(L.hingeXc), X(s * sx), Yf(1), 1.3, 0.42);
    // control-surface ribs (fine)
    for (let x = L.hingeFrom + 0.3; x < L.hingeTo; x += 0.3) P.line(X(s * x), Yf(L.hingeXc + 0.02), X(s * x), Yf(0.99), 0.35, 0.1);
  }
  for (let x = -L.half + 0.6; x < L.half; x += L.ribs) {
    for (const Yf of [Yu, Yl]) { P.line(X(x), Yf(0.02), X(x), Yf(L.hingeXc), 0.5, 0.14); P.rivets(X(x), Yf(0.02), X(x), Yf(L.hingeXc), 8, 0, 1, 0.14); }
  }
  // thin brown leading-edge stripe on the upper surface (target art: de-icer style line)
  if (L.stripe) for (const s of [1, -1]) {
    const xa = X(s * 2.3), xb = X(s * (L.tipBrown - 0.1));
    c.fillStyle = "rgba(74,42,23,0.9)"; c.fillRect(Math.min(xa, xb), Yu(0.085), Math.abs(xb - xa), 5);
  }
  // leading-edge wear: lighter scuffs + chips around the nose of the airfoil
  gr = c.createLinearGradient(0, Yu(0.05), 0, Yl(0.05));
  gr.addColorStop(0, "rgba(255,244,210,0)"); gr.addColorStop(0.5, "rgba(255,244,210,0.22)"); gr.addColorStop(1, "rgba(255,244,210,0)");
  c.fillStyle = gr; c.fillRect(0, Yu(0.05), W, Yl(0.05) - Yu(0.05));
  P.chips(0, Yu(0.03), W, Yl(0.03) - Yu(0.03), Math.round(W * 0.35), L.seed + 7);
  // engine soot streaks behind the exhausts (upper + lower)
  for (const sx of L.soot ?? []) for (const Yf of [Yu, Yl]) {
    const R = rng(L.seed + Math.round(sx * 10));
    for (let i = 0; i < 18; i++) {
      const x = X(sx + (R() - 0.5) * 1.3), y0 = Yf(0.35 + R() * 0.2), y1 = Yf(1);
      gr = c.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, "rgba(40,30,22,0.0)"); gr.addColorStop(0.3, "rgba(40,30,22,0.16)"); gr.addColorStop(1, "rgba(40,30,22,0.05)");
      c.fillStyle = gr; c.fillRect(x, Math.min(y0, y1), 3 + R() * 9, Math.abs(y1 - y0));
    }
    P.r.fillStyle = "rgba(255,255,255,0.15)"; P.r.fillRect(X(sx - 0.7), Math.min(Yf(0.4), Yf(1)), X(0.7) - X(-0.7), Math.abs(Yf(1) - Yf(0.4)));
  }
  // brown tips (painted last), with a crisp masking edge
  for (const s of [1, -1]) {
    const xe = X(s * L.tipBrown), x0 = s > 0 ? xe : 0, x1 = s > 0 ? W : xe;
    c.fillStyle = BROWN_TIP; c.fillRect(x0, 0, x1 - x0, H);
    gr = c.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, "rgba(120,80,56,0.3)"); gr.addColorStop(0.5, "rgba(255,230,200,0.12)"); gr.addColorStop(1, "rgba(0,0,0,0.2)");
    c.fillStyle = gr; c.fillRect(x0, 0, x1 - x0, H);
    P.r.fillStyle = gray(0.3); P.r.fillRect(x0, 0, x1 - x0, H);
    P.line(xe, 0, xe, H, 0.8, 0.3); c.fillStyle = "rgba(255,240,200,0.4)"; c.fillRect(xe + (s > 0 ? 2 : -4), 0, 2, H);
    P.chips(s > 0 ? xe : 0, H * 0.46, Math.abs(x1 - x0), H * 0.08, 60, L.seed + 9 + s, "200,160,120");
  }
  return P.tex(5);
}

// fin: two halves (left half = starboard skin, right half = port skin), planar (z,y) mapping so the livery reads
// correctly from both sides. Banana-leaf fan + BANANA CO.
function paintFin(): Tex {
  const W = 2048, H = 1024, P = new Paint(W, H, YEL, 0.26), c = P.c;
  const sx = 1024 / (FIN_ZMAX - FIN_ZMIN), sy = H / (FIN_Y1 - FIN_Y0);
  P.blotch(160, 21, 20, 110, 0.07); P.grain(5000, 22, 0.035);
  for (let half = 0; half < 2; half++) {
    const X = (z: number) => (half === 0 ? (FIN_ZMAX - z) * sx : 1024 + (z - FIN_ZMIN) * sx);
    const Y = (y: number) => (FIN_Y1 - y) * sy;
    c.save(); c.beginPath(); c.rect(half * 1024, 0, 1024, H); c.clip();
    P.h.save(); P.h.beginPath(); P.h.rect(half * 1024, 0, 1024, H); P.h.clip();
    P.r.save(); P.r.beginPath(); P.r.rect(half * 1024, 0, 1024, H); P.r.clip();
    // rudder hinge line + rib seams + hinge plates
    const hinge = (y: number) => finTE(y) - 0.3 * (finTE(y) - finLE(y));
    for (let y = FIN_Y0 + 0.2; y < FIN_Y1 - 0.2; y += 0.1) P.line(X(hinge(y)), Y(y), X(hinge(y + 0.1)), Y(y + 0.1), 1.2, 0.4);
    for (const y of [6.3, 7.6, 8.9, 10.2, 11.4]) { P.line(X(finLE(y)), Y(y), X(finTE(y)), Y(y), 0.6, 0.16); P.rivets(X(finLE(y)), Y(y), X(hinge(y)), Y(y), 9, 4, 2, 0.14); }
    for (const f of [0.18, 0.5]) for (let y = FIN_Y0 + 0.4; y < FIN_Y1 - 0.6; y += 0.1) {
      const z0 = lerp(finLE(y), finTE(y), f), z1 = lerp(finLE(y + 0.1), finTE(y + 0.1), f);
      P.line(X(z0), Y(y), X(z1), Y(y + 0.1), 0.6, 0.14);
    }
    for (const y of [7.1, 9.1, 11.0]) {
      const z = hinge(y); c.fillStyle = "#b9a98a"; c.fillRect(X(z) - 9, Y(y) - 5, 18, 10); P.h.fillStyle = gray(0.75); P.h.fillRect(X(z) - 9, Y(y) - 5, 18, 10);
      c.strokeStyle = "rgba(60,40,20,0.6)"; c.lineWidth = 1.5; c.strokeRect(X(z) - 9, Y(y) - 5, 18, 10);
    }
    // banana-leaf fan (drawn in world (z,y) so the two sides mirror correctly)
    const L = (bz: number, by: number, tz: number, ty: number, w: number, bend: number, seed: number) =>
      drawLeaf(c, P.h, X(bz), Y(by), X(tz), Y(ty), w * sy, half === 0 ? bend : -bend, seed);
    L(12.4, 7.3, 13.95, 11.6, 0.8, -0.12, 1);      // big leaf sweeping up-aft
    L(12.2, 7.3, 11.05, 10.9, 0.66, 0.14, 2);      // leaf sweeping up-forward
    L(12.5, 7.27, 14.05, 9.0, 0.48, -0.1, 3);      // low leaf aft
    // BANANA CO. — brown, heavy, reads left→right from each side
    // lettering sits clear above the stabiliser root so it reads whole from below (target art)
    stencil(c, "BANANA CO.", X(11.75), Y(6.72), 0.52 * sy, 1, 1, BROWN, 3.4 * sx);
    c.restore(); P.h.restore(); P.r.restore();
  }
  // leading-edge wear along both halves
  for (let half = 0; half < 2; half++) for (let y = FIN_Y0 + 0.5; y < FIN_Y1 - 0.2; y += 0.12) {
    const x = half === 0 ? (FIN_ZMAX - finLE(y)) * sx : 1024 + (finLE(y) - FIN_ZMIN) * sx;
    P.chips(x - (half === 0 ? 14 : 0), (FIN_Y1 - y) * sy, 14, 10, 2, Math.round(y * 100) + half);
  }
  return P.tex(5);
}
function drawLeaf(g: CanvasRenderingContext2D, hg: CanvasRenderingContext2D, bx: number, by: number, tx: number, ty: number, w: number, bend: number, seed: number) {
  const R = rng(seed * 97 + 13);
  const dx = tx - bx, dy = ty - by, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, px = -uy, py = ux;
  const cxp = bx + dx * 0.5 + px * bend * len, cyp = by + dy * 0.5 + py * bend * len;
  const spine = (t: number) => { const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t; return [a * bx + b * cxp + d * tx, a * by + b * cyp + d * ty]; };
  const tang = (t: number) => { const x = 2 * (1 - t) * (cxp - bx) + 2 * t * (tx - cxp), y = 2 * (1 - t) * (cyp - by) + 2 * t * (ty - cyp); const l = Math.hypot(x, y); return [x / l, y / l]; };
  const half = (t: number) => w * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.75) * (1 - 0.2 * t);
  const N = 44, left: [number, number][] = [], right: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, [sx, sy] = spine(t), [tx2, ty2] = tang(t), nx = -ty2, ny = tx2, hw = half(t);
    // smooth broad outline (target art); the leaf's splits are painted as thin slits afterwards
    left.push([sx + nx * hw, sy + ny * hw]);
    right.push([sx - nx * hw, sy - ny * hw]);
  }
  const path = (ctx: CanvasRenderingContext2D, a: [number, number][], b: [number, number][]) => {
    ctx.beginPath(); a.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); for (let i = b.length - 1; i >= 0; i--) ctx.lineTo(b[i][0], b[i][1]); ctx.closePath();
  };
  const mid: [number, number][] = Array.from({ length: N + 1 }, (_, i) => spine(i / N) as [number, number]);
  // soft drop shadow under the decal for depth
  g.save(); g.shadowColor = "rgba(40,30,0,0.25)"; g.shadowBlur = 6; g.shadowOffsetY = 2;
  g.fillStyle = LEAF_D; path(g, left, right); g.fill(); g.restore();
  g.fillStyle = LEAF_L; path(g, left, mid); g.fill();
  // shading gradient across the light half
  const [mx, my] = spine(0.5);
  const gr = g.createLinearGradient(bx, by, mx, my); gr.addColorStop(0, "rgba(20,50,10,0.35)"); gr.addColorStop(1, "rgba(20,50,10,0)");
  g.fillStyle = gr; path(g, left, right); g.fill();
  // veins
  g.strokeStyle = "rgba(190,225,120,0.35)"; g.lineWidth = 1.4;
  for (let i = 4; i < N - 2; i += 3) {
    const t = i / N, [sx, sy] = spine(t), [tx2, ty2] = tang(t), hw = half(t) * 0.85;
    for (const s of [1, -1]) { g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + (-ty2 * s) * hw + tx2 * hw * 0.5, sy + (tx2 * s) * hw + ty2 * hw * 0.5); g.stroke(); }
  }
  // 2–3 clean splits per edge: thin paint-coloured slits running from the edge in along the veins, toward the tip
  g.strokeStyle = YEL; g.lineCap = "round";
  for (const sd of [1, -1]) for (const t of [0.34, 0.55, 0.74].map((q) => q + (R() - 0.5) * 0.06)) {
    if (sd < 0 && t > 0.7 && R() < 0.5) continue;
    const [sx, sy] = spine(t), [tx2, ty2] = tang(t), hw = half(t), vx = -ty2 * sd + tx2 * 0.55, vy = tx2 * sd + ty2 * 0.55, vl = Math.hypot(vx, vy);
    const ex = sx + (-ty2 * sd) * hw + tx2 * hw * 0.5, ey = sy + (tx2 * sd) * hw + ty2 * hw * 0.5, k = hw * (0.45 + R() * 0.2);
    g.lineWidth = Math.max(1.5, w * 0.035); g.beginPath(); g.moveTo(ex + (vx / vl) * 2, ey + (vy / vl) * 2); g.lineTo(ex - (vx / vl) * k, ey - (vy / vl) * k); g.stroke();
  }
  g.strokeStyle = LEAF_RIB; g.lineWidth = Math.max(2, w * 0.1); g.lineCap = "round";
  g.beginPath(); mid.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  // decal edge in the height map
  hg.fillStyle = gray(0.54); path(hg, left, right); hg.fill();
}
const FIN_TOP0 = 11.75;
function finLE(y: number) {
  const straight = 8.9 + (y - 6.2) * 0.46;
  const f = y < 6.3 ? Math.pow((6.3 - y) / 1.4, 2) : 0;
  return straight - 2.5 * f;
}
function finTE(y: number) { return 14.4 - (y - FIN_Y0) * 0.07; }

function paintCowl(): Tex {
  // x = profile (0 inner lip → 1 rear edge), y = around
  const W = 1024, H = 512, P = new Paint(W, H, YEL, 0.26), c = P.c;
  P.blotch(60, 31, 10, 60, 0.07); P.grain(2500, 32, 0.035);
  const band = (u0: number, u1: number, col: string, rough = 0.3) => {
    c.fillStyle = col; c.fillRect(u0 * W, 0, (u1 - u0) * W, H); P.r.fillStyle = gray(rough); P.r.fillRect(u0 * W, 0, (u1 - u0) * W, H);
    P.line(u0 * W, 0, u0 * W, H, 0.6, 0.25); P.line(u1 * W, 0, u1 * W, H, 0.6, 0.25);
  };
  band(0, 0.17, BROWN); band(0.36, 0.4, BROWN); band(0.46, 0.475, BROWN); band(0.94, 1, "#3b2a1c", 0.45);
  for (let k = 0; k < 4; k++) { const y = ((k + 0.5) / 4) * H; P.line(0.17 * W, y, 0.94 * W, y, 0.9, 0.3); P.rivets(0.17 * W, y, 0.94 * W, y, 8, 5, 2, 0.16);
    for (const u of [0.28, 0.6, 0.8]) { c.fillStyle = "#6a5a44"; c.fillRect(u * W - 7, y - 4, 14, 8); P.h.fillStyle = gray(0.78); P.h.fillRect(u * W - 7, y - 4, 14, 8); } }
  P.chips(0, 0, 0.2 * W, H, 120, 34, "200,170,130");
  return P.tex(4);
}
function paintNacelle(): Tex {
  // x = along the nacelle (front → rear), y = around (0 bottom → 0.5 top → 1 bottom)
  const W = 1024, H = 512, P = new Paint(W, H, YEL, 0.26), c = P.c;
  P.blotch(80, 41, 10, 60, 0.07); P.grain(3000, 42, 0.035);
  for (const x of [0.02, 0.3, 0.58, 0.85]) { P.line(x * W, 0, x * W, H, 1, 0.3); P.rivets(x * W, 0, x * W, H, 8, 4, 2, 0.15); }
  for (const y of [0.25, 0.75]) { P.line(0, y * H, W, y * H, 0.8, 0.25); }
  // (no exhaust soot — the target art's nacelles are clean lemon enamel; the streaks read as smudges)
  P.r.fillStyle = "rgba(255,255,255,0.15)"; P.r.fillRect(0, 0.2 * H, W * 0.6, 0.2 * H); P.r.fillRect(0, 0.6 * H, W * 0.6, 0.2 * H);
  // oil cooler intake on the belly
  c.fillStyle = "#1b1511"; c.beginPath(); c.roundRect(0.05 * W, H - 30, 0.14 * W, 30, 8); c.fill(); c.beginPath(); c.roundRect(0.05 * W, 0, 0.14 * W, 30, 8); c.fill();
  return P.tex(4);
}
function paintSponson(): Tex {
  // x = along (front → rear), y = around the sponson section (0 = bottom)
  const W = 1024, H = 256, P = new Paint(W, H, YEL, 0.26), c = P.c;
  P.blotch(60, 51, 10, 50, 0.07); P.grain(1500, 52, 0.035);
  for (const x of [0.12, 0.3, 0.5, 0.7, 0.86]) { P.line(x * W, 0, x * W, H, 1, 0.3); P.rivets(x * W, 0, x * W, H, 8, 4, 2, 0.15); }
  P.line(0, H * 0.25, W, H * 0.25, 0.8, 0.25); P.line(0, H * 0.75, W, H * 0.75, 0.8, 0.25);
  // wheel-well slot (both canvas edges = bottom)
  for (const [y, h] of [[0, 20], [H - 20, 20]]) { c.fillStyle = "#15100c"; c.fillRect(0.1 * W, y, 0.63 * W, h); P.r.fillStyle = gray(0.85); P.r.fillRect(0.1 * W, y, 0.63 * W, h); }
  const gr = c.createLinearGradient(0, 0, 0, H * 0.3); gr.addColorStop(0, "rgba(80,50,15,0.4)"); gr.addColorStop(1, "rgba(80,50,15,0)"); c.fillStyle = gr; c.fillRect(0, 0, W, H * 0.3);
  const gr2 = c.createLinearGradient(0, H, 0, H * 0.7); gr2.addColorStop(0, "rgba(80,50,15,0.4)"); gr2.addColorStop(1, "rgba(80,50,15,0)"); c.fillStyle = gr2; c.fillRect(0, H * 0.7, W, H * 0.3);
  P.chips(0, 0, W * 0.15, H, 80, 53, "220,200,160");
  return P.tex(4);
}
function paintTyre(): Tex {
  // x = profile (0 → 1 across: inner rim, sidewall, tread, sidewall, outer rim), y = around
  const W = 256, H = 1024, P = new Paint(W, H, "#262422", 0.86), c = P.c;
  P.blotch(40, 61, 6, 30, 0.08, ["120,110,95", "0,0,0"]);
  // sidewall rings
  for (const u of [0.1, 0.16, 0.84, 0.9]) { c.fillStyle = "rgba(90,85,78,0.5)"; c.fillRect(u * W, 0, 2, H); P.h.fillStyle = gray(0.62); P.h.fillRect(u * W, 0, 2, H); }
  // chevron tread blocks
  const n = 36;
  for (let i = 0; i < n; i++) {
    const y = (i / n) * H;
    for (const s of [1, -1]) {
      P.h.fillStyle = gray(0.2); P.h.beginPath();
      const x0 = W * 0.5, x1 = W * (0.5 + s * 0.2);
      P.h.moveTo(x0, y); P.h.lineTo(x1, y + H / n * 0.55); P.h.lineTo(x1, y + H / n * 0.75); P.h.lineTo(x0, y + H / n * 0.2); P.h.closePath(); P.h.fill();
      c.fillStyle = "rgba(10,10,10,0.55)"; c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y + H / n * 0.55); c.lineTo(x1, y + H / n * 0.75); c.lineTo(x0, y + H / n * 0.2); c.closePath(); c.fill();
    }
  }
  c.fillStyle = "rgba(180,160,120,0.12)"; c.fillRect(W * 0.3, 0, W * 0.4, H); // dust on the tread
  return P.tex(6);
}
function paintTreadplate(): Tex {
  const W = 512, H = 512, P = new Paint(W, H, "#8d9093", 0.42), c = P.c;
  P.blotch(90, 71, 10, 60, 0.12, ["60,55,48", "200,200,205"]);
  const s = 32;
  for (let y = 0; y < H + s; y += s) for (let x = 0; x < W + s; x += s) {
    const odd = ((y / s) | 0) % 2, cx = x + (odd ? s / 2 : 0), cy = y, ang = odd ? 0.8 : -0.8;
    for (const [g, st] of [[P.h, gray(0.85)], [c, "rgba(230,232,236,0.45)"]] as const) {
      g.save(); g.translate(cx, cy); g.rotate(ang); g.fillStyle = st; g.beginPath(); g.ellipse(0, 0, 11, 3, 0, 0, TAU); g.fill(); g.restore();
    }
  }
  // dirt in the recesses
  const R = rng(72);
  for (let i = 0; i < 400; i++) { c.fillStyle = `rgba(50,40,30,${0.05 + R() * 0.1})`; c.fillRect(R() * W, R() * H, 2 + R() * 10, 2 + R() * 10); }
  return P.tex(6);
}
function paintCrate(): Tex {
  const W = 512, H = 512, P = new Paint(W, H, "#b88a4e", 0.8), c = P.c;
  const R = rng(91);
  for (let i = 0; i < 5; i++) {
    const y = (i / 5) * H, tone = 0.85 + R() * 0.3;
    c.fillStyle = `rgba(${Math.round(184 * tone)},${Math.round(138 * tone)},${Math.round(78 * tone)},1)`; c.fillRect(0, y, W, H / 5);
    for (let k = 0; k < 40; k++) { c.fillStyle = `rgba(90,55,20,${0.08 + R() * 0.12})`; c.fillRect(0, y + R() * H / 5, W, 1 + R() * 2); }
    P.line(0, y, W, y, 1.6, 0.6);
  }
  // frame battens + nails
  for (const [x, y, w, h] of [[0, 0, W, 34], [0, H - 34, W, 34], [0, 0, 34, H], [W - 34, 0, 34, H]] as const) {
    c.fillStyle = "#9c6d36"; c.fillRect(x, y, w, h); P.h.fillStyle = gray(0.7); P.h.fillRect(x, y, w, h);
  }
  for (const [x, y] of [[17, 17], [W - 17, 17], [17, H - 17], [W - 17, H - 17]]) { c.fillStyle = "#3a3632"; c.beginPath(); c.arc(x, y, 5, 0, TAU); c.fill(); }
  stencil(c, "BANANA CO.", W / 2, H / 2, 58, 1, 1, "rgba(60,32,12,0.88)", W * 0.8);
  P.chips(0, 0, W, H, 120, 92, "230,200,150");
  return P.tex(4);
}
function propDiscTexture(): THREE.Texture {
  // a spinning 4-blade prop as the eye (and the target art) sees it: each blade a dark paddle with a yellow tip, smeared
  // backwards over ~40° (strong at the leading edge, fading trail), over a faint full-disc haze and a yellow tip ring
  const S = 1024, cv = mkCanvas(S, S), g = g2d(cv), C = S / 2, R0 = C * 0.98;
  g.clearRect(0, 0, S, S);
  const gr = g.createRadialGradient(C, C, R0 * 0.2, C, C, R0);
  gr.addColorStop(0, "rgba(40,32,24,0.0)"); gr.addColorStop(0.28, "rgba(40,32,24,0.24)"); gr.addColorStop(0.9, "rgba(40,32,24,0.3)"); gr.addColorStop(1, "rgba(40,32,24,0.12)");
  g.fillStyle = gr; g.beginPath(); g.arc(C, C, R0, 0, TAU); g.fill();
  const blade = (ang: number, alpha: number, tip: boolean) => {
    g.save(); g.translate(C, C); g.rotate(ang);
    const r0 = R0 * 0.2, r1 = R0 * 0.985;
    g.fillStyle = `rgba(30,23,18,${alpha})`;
    g.beginPath(); g.moveTo(r0, -R0 * 0.045); g.quadraticCurveTo(R0 * 0.55, -R0 * 0.1, r1 * 0.95, -R0 * 0.065); g.quadraticCurveTo(r1, 0, r1 * 0.95, R0 * 0.06);
    g.quadraticCurveTo(R0 * 0.55, R0 * 0.08, r0, R0 * 0.045); g.closePath(); g.fill();
    if (tip) {
      g.fillStyle = `rgba(246,192,34,${Math.min(1, alpha * 1.15)})`;
      g.beginPath(); g.moveTo(r1 * 0.86, -R0 * 0.07); g.quadraticCurveTo(r1, -R0 * 0.03, r1, 0); g.quadraticCurveTo(r1, R0 * 0.03, r1 * 0.86, R0 * 0.066); g.closePath(); g.fill();
    }
    g.restore();
  };
  for (let k = 0; k < 4; k++) {
    for (let s = 34; s >= 1; s--) blade((k * Math.PI) / 2 - s * 0.021, 0.24 * Math.pow(1 - s / 35, 2.0), true);
    blade((k * Math.PI) / 2, 0.8, true);
  }
  g.strokeStyle = "rgba(245,190,30,0.38)"; g.lineWidth = R0 * 0.07; g.beginPath(); g.arc(C, C, R0 * 0.94, 0, TAU); g.stroke();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// ============================================================================ parts
function airfoil(xc: number, t: number, m: number, p = 0.4) {
  const yt = 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
  const yc = xc < p ? (m / (p * p)) * (2 * p * xc - xc * xc) : (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * xc - xc * xc);
  return [yc, yt];
}
/** v ∈ [0,1] around an airfoil: 0 TE lower → 0.5 LE → 1 TE upper */
const aroundV = (n: number) => uniq([...cosRange(0, 0.5, n), ...cosRange(0.5, 1, n)]);
const chordOf = (v: number) => Math.abs(1 - 2 * v);

interface LiftShape { half: number; chord(x: number): number; le(x: number): number; y(x: number): number; t(x: number): number; camber: number; inc: number; round: number }
function liftSurface(L: LiftShape, nSpan: number, nAround: number, xFrom = -L.half, xTo = L.half) {
  const f: Fn = (s, v, o) => {
    const x = s, ax = Math.abs(x);
    let c = L.chord(ax), le = L.le(ax), th = L.t(ax);
    const q = (ax - (L.half - L.round)) / L.round;
    if (q > 0) { const k = ell(q, 2.2); le += c * 0.42 * (1 - k); c *= Math.max(1e-3, k); th *= Math.max(0.05, Math.pow(k, 0.5)); }
    const xc = chordOf(v), [yc, yt] = airfoil(xc, th, L.camber), up = v >= 0.5 ? 1 : -1;
    const yy = (yc + up * yt) * c;
    o.set(x, L.y(ax) + yy - xc * c * Math.sin(L.inc), le + xc * c * Math.cos(L.inc));
  };
  const spans: number[] = [];
  const edge = L.half - L.round;
  for (const x of range(xFrom, xTo, nSpan)) spans.push(x);
  for (const sgn of [-1, 1]) for (let i = 0; i <= 10; i++) { const x = sgn * (edge + L.round * (1 - Math.cos((Math.PI / 2) * (i / 10)))); if (x >= xFrom && x <= xTo) spans.push(x); }
  return { f, spans: uniq(spans), vs: aroundV(nAround) };
}

function buildFuselage(mat: THREE.Material, interiorMat: THREE.Material) {
  const nose = range(ZN, Z_NOSE, 30, 1.7).map((z, i, a) => (i === 0 ? z : z)).map((z) => z);
  // denser near the tip: remap so spacing grows away from the nose
  const noseZ = Array.from({ length: 31 }, (_, i) => ZN + (Z_NOSE - ZN) * (1 - Math.cos((Math.PI / 2) * (i / 30))));
  void nose;
  const cabinZ = range(Z_NOSE, Z_UP, 16);
  const tailA = range(Z_UP, Z_OPEN, 22);
  const tailB = uniq([...range(Z_OPEN, ZE, 8), ...Array.from({ length: 9 }, (_, i) => ZE + (ZCAP - ZE) * Math.sin((Math.PI / 2) * (i / 8)))]);
  const ring = range(0, TAU, 96);
  const uvF = (_u: number, _v: number, p: THREE.Vector3): [number, number] => [0, 0 * p.x];
  void uvF;
  const shellUV = (z: number, a: number): [number, number] => [(z - ZN) / (ZCAP - ZN), a / TAU];
  const full = (zs: number[]) => surface(zs, ring, (z, a, o) => fuse(z, a, o), { flip: true, uv: (z, a) => shellUV(z, a), vd: [0, TAU] });
  // opening region: a ∈ [θ(z), 2π - θ(z)] mapped from v ∈ [0,1]
  const vv = range(0, 1, 80);
  const aOf = (z: number, v: number) => theta(z) + v * (TAU - 2 * theta(z));
  const open = surface(tailA, vv, (z, v, o) => fuse(z, aOf(z, v), o), { flip: true, uv: (z, v) => shellUV(z, aOf(z, v)) });
  const geoms = [full([...noseZ, ...cabinZ.slice(1)]), open, full(tailB)];
  // cut-edge rims (skin thickness) along both sides of the opening
  for (const side of [0, 1]) {
    const rimF: Fn = (z, s, o) => { const a = side ? TAU - theta(z) : theta(z); fuse(z, a, o, s * SKIN); };
    geoms.push(surface(tailA, [0, 1], rimF, { flip: side === 1, uv: (z) => shellUV(z, side ? TAU - theta(z) : theta(z)) }));
  }
  // wing-root fairing on the fuselage top (uses the fuselage paint via top-of-canvas UVs)
  const fair = surface(range(-5.6, 1.9, 30), range(0, Math.PI, 24), (z, a, o) => {
    const t = (z - -5.6) / 7.5;
    const k = t < 0.2 ? ell((0.2 - t) / 0.2, 2) : t > 0.55 ? ell((t - 0.55) / 0.45, 1.6) : 1;
    const w = 1.35 * Math.max(0.02, Math.pow(k, 0.6)), h = 0.62 * k;
    o.set(-w * Math.cos(a), TOP - 0.35 + h * Math.pow(Math.sin(a), 0.8), z);
  }, { uv: (z, a) => [(z - ZN) / (ZCAP - ZN), 0.5 + (Math.cos(a) * 1.35) / 13.4] });
  geoms.push(fair);
  const shell = new THREE.Mesh(merge(geoms), mat);
  shell.name = "fuselage"; shell.castShadow = true; shell.receiveShadow = true;

  // ---- interior lining + bulkheads
  const inner: THREE.BufferGeometry[] = [];
  const iUV = (z: number, a: number): [number, number] => [(z - ZN) / (ZCAP - ZN), a / TAU];
  const cab = range(-9.0, Z_UP, 14);
  inner.push(surface(cab, range(0.5, TAU - 0.5, 60), (z, a, o) => fuse(z, a, o, SKIN), { uv: (z, a) => iUV(z, a) }));
  inner.push(surface(tailA, vv, (z, v, o) => fuse(z, aOf(z, v), o, SKIN), { uv: (z, v) => iUV(z, aOf(z, v)) }));
  inner.push(surface(range(Z_OPEN, 12.9, 4), range(0, TAU, 48), (z, a, o) => fuse(z, a, o, SKIN), { uv: (z, a) => iUV(z, a) }));
  // bulkheads (front at -9, aft at 12.9)
  for (const [z, dir] of [[-9.0, 1], [12.9, -1]] as const) {
    const s = sec(z, { w: 0, cy: 0, h: 0 });
    inner.push(surface([0, 1], range(0, TAU, 48), (r, a, o) => { fuse(z, a, o, SKIN); o.set(o.x * r, s.cy + (o.y - s.cy) * r, z); }, { flip: dir < 0, uv: (r, a) => [0.5 + 0.2 * r * Math.sin(a), 0.5 - 0.3 * r * Math.cos(a)] }));
  }
  const lining = new THREE.Mesh(merge(inner), interiorMat);
  lining.name = "cargo-lining"; lining.receiveShadow = true;
  return { shell, lining };
}

// ramp + upper door: bottom sector of the upswept tail, built in fuselage space then re-based on the hinge
function buildRamp(paintM: THREE.Material, interiorM: THREE.Material, treadM: THREE.Material, metalM: THREE.Material) {
  const group = new THREE.Group(); group.name = "ramp"; group.position.copy(RAMP_PIVOT);
  const zs = range(Z_UP, Z_RAMP, 14), vv = range(-1, 1, 36);
  const aOf = (z: number, v: number) => v * theta(z);
  const shellUV = (z: number, a: number): [number, number] => [(z - ZN) / (ZCAP - ZN), a / TAU];
  const skin: THREE.BufferGeometry[] = [surface(zs, vv, (z, v, o) => fuse(z, aOf(z, v), o), { flip: true, uv: (z, v) => shellUV(z, aOf(z, v)) })];
  for (const s of [-1, 1]) skin.push(surface(zs, [0, 1], (z, t, o) => fuse(z, s * theta(z), o, t * SKIN), { flip: s < 0, uv: (z) => shellUV(z, s * theta(z)) }));
  for (const [z, fl] of [[Z_UP, true], [Z_RAMP, false]] as const) skin.push(surface(vv, [0, 1], (v, t, o) => fuse(z, aOf(z, v), o, t * SKIN), { flip: fl, uv: (v) => shellUV(z, aOf(z, v)) }));
  const skinG = merge(skin); skinG.translate(-RAMP_PIVOT.x, -RAMP_PIVOT.y, -RAMP_PIVOT.z);
  const skinM = new THREE.Mesh(skinG, paintM); skinM.castShadow = true; skinM.receiveShadow = true;
  const inner = surface(zs, vv, (z, v, o) => fuse(z, aOf(z, v), o, SKIN), { uv: (z, v) => [(z - ZN) / (ZCAP - ZN), aOf(z, v) / TAU] });
  inner.translate(-RAMP_PIVOT.x, -RAMP_PIVOT.y, -RAMP_PIVOT.z);
  const innerM = new THREE.Mesh(inner, interiorM); innerM.receiveShadow = true;
  // deck: flat treadplate plank running from the floor line at the hinge to the ramp end
  const slope = Math.atan2(secBot(Z_RAMP) - BELLY, Z_RAMP - Z_UP);
  const len = (Z_RAMP - Z_UP - 0.08) / Math.cos(slope);
  const halfAt = (z: number, y: number) => { // inset section half width at height y
    const s = sec(z, { w: 0, cy: 0, h: 0 }), h = s.h - SKIN, w = s.w - SKIN;
    const cr = THREE.MathUtils.clamp((s.cy - y) / h, -1, 1), ca = sp(cr, SE / 2);
    return w * sp(Math.sqrt(Math.max(0, 1 - ca * ca)), E2) - 0.04;
  };
  const deckY0 = FLOOR_Y - RAMP_PIVOT.y;
  const w0 = halfAt(Z_UP + 0.05, FLOOR_Y), w1 = halfAt(Z_RAMP - 0.1, FLOOR_Y + Math.tan(slope) * (Z_RAMP - Z_UP));
  const deckShape = new THREE.Shape();
  deckShape.moveTo(-w0, 0); deckShape.lineTo(w0, 0); deckShape.lineTo(w1, len); deckShape.lineTo(-w1, len); deckShape.closePath();
  const deck = new THREE.ExtrudeGeometry(deckShape, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 1 });
  // shape is in XY; lay it flat (XZ), top at y = 0, then tilt by the ramp slope
  deck.rotateX(Math.PI / 2); deck.translate(0, -0.0, 0);
  const uvA = deck.attributes.uv as THREE.BufferAttribute, pA = deck.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < uvA.count; i++) uvA.setXY(i, pA.getX(i) * 1.2, pA.getZ(i) * 1.2);
  deck.rotateX(-slope); deck.translate(0, deckY0, 0);
  const deckParts: THREE.BufferGeometry[] = [deck];
  // side kick-rails + treads (raised bars across the deck) + toes at the end
  const dirV = new THREE.Vector3(0, Math.sin(slope), Math.cos(slope));
  for (let i = 1; i < 9; i++) {
    const d = (i / 9) * len, w = lerp(w0, w1, d / len) - 0.1;
    const b = rbox(w * 2, 0.035, 0.07, 0.015); b.rotateX(-slope);
    b.translate(0, deckY0 + dirV.y * d + 0.03, dirV.z * d); deckParts.push(b);
  }
  for (const s of [-1, 1]) {
    const a = new THREE.Vector3(s * (w0 - 0.06), deckY0 + 0.1, 0.05), b = new THREE.Vector3(s * (w1 - 0.06), deckY0 + 0.1 + dirV.y * len, dirV.z * len);
    deckParts.push(rod(a, b, 0.05, 8));
  }
  const toes: THREE.BufferGeometry[] = [];
  const toeW = (w1 * 2 - 0.1) / 3;
  for (let k = 0; k < 3; k++) {
    const t = rbox(toeW - 0.04, 0.05, 0.62, 0.02); t.translate(0, 0, 0.31); t.rotateX(-slope + 0.22);
    t.translate(-w1 + 0.05 + toeW * (k + 0.5), deckY0 + dirV.y * len + 0.01, dirV.z * len);
    toes.push(t);
  }
  const deckM = new THREE.Mesh(merge([...deckParts, ...toes]), treadM); deckM.castShadow = true; deckM.receiveShadow = true;
  // hinge knuckles
  const hinge: THREE.BufferGeometry[] = [];
  for (let k = -3; k <= 3; k++) { const c = new THREE.CylinderGeometry(0.07, 0.07, 0.28, 12); c.rotateZ(Math.PI / 2); c.translate(k * 0.42, 0.02, 0); hinge.push(c); }
  const hingeM = new THREE.Mesh(merge(hinge), metalM); hingeM.castShadow = true;
  group.add(skinM, innerM, deckM, hingeM);
  const exitLocal = new THREE.Vector3(0, deckY0 + dirV.y * (len + 0.5), dirV.z * (len + 0.5));
  return { group, slope, len, exitLocal };
}
function buildUpperDoor(paintM: THREE.Material, interiorM: THREE.Material) {
  const pivot = new THREE.Vector3(0, secBot(Z_OPEN), Z_OPEN);
  const group = new THREE.Group(); group.name = "upper-door"; group.position.copy(pivot);
  const zs = range(Z_RAMP, Z_OPEN, 8), vv = range(-1, 1, 30);
  const aOf = (z: number, v: number) => v * theta(z);
  const uvf = (z: number, a: number): [number, number] => [(z - ZN) / (ZCAP - ZN), a / TAU];
  const parts = [surface(zs, vv, (z, v, o) => fuse(z, aOf(z, v), o), { flip: true, uv: (z, v) => uvf(z, aOf(z, v)) })];
  for (const s of [-1, 1]) parts.push(surface(zs, [0, 1], (z, t, o) => fuse(z, s * theta(z), o, t * SKIN), { flip: s < 0, uv: (z) => uvf(z, s * theta(z)) }));
  parts.push(surface(vv, [0, 1], (v, t, o) => fuse(Z_RAMP, aOf(Z_RAMP, v), o, t * SKIN), { flip: true, uv: (v) => uvf(Z_RAMP, aOf(Z_RAMP, v)) }));
  const g = merge(parts); g.translate(-pivot.x, -pivot.y, -pivot.z);
  const inner = surface(zs, vv, (z, v, o) => fuse(z, aOf(z, v), o, SKIN), { uv: (z, v) => uvf(z, aOf(z, v)) }); inner.translate(-pivot.x, -pivot.y, -pivot.z);
  const m = new THREE.Mesh(g, paintM); m.castShadow = true;
  group.add(m, new THREE.Mesh(inner, interiorM));
  return group;
}

// ============================================================================ cargo bay (drop-02-plane-interior)
// Yellow ribbed walls (painted panel tile in
// metres + U-channel frames every 0.8 m, split round the portholes), 8 lit portholes a side, an overhead spine beam +
// pipes + lamps, a grey aft portal frame with hazard stripes and the red JUMP lamp over the ramp, red padded seats with
// grey tube frames, headrest loops + harness reels, yellow floor rails with tie-down slots, strapped crates by the ramp,
// and a crew of seated, harnessed kongs along both walls (instanced kongs; createPlane adds them).
export interface BaySeat { side: 1 | -1; z: number; backX: number; seatY: number }
interface BayMats { tread: THREE.Material; metal: THREE.Material; crate: THREE.Material; seat: THREE.Material; lamp: THREE.Material; rib: THREE.Material; frame: THREE.Material; strap: THREE.Material; jump: THREE.Material; glass: THREE.Material; hazard: THREE.Material; railY: THREE.Material; dark: THREE.Material }
const BAY_SEATS_Z = [-7.6, -6.35, -5.1, -3.85, -2.6, -1.35, -0.1, 1.15, 2.4, 3.65];
function bayHalfW() {
  const s = sec(0, { w: 0, cy: 0, h: 0 }), h = s.h - SKIN, w = s.w - SKIN;
  const ca = sp((s.cy - FLOOR_Y) / h, SE / 2);
  return { halfW: w * sp(Math.sqrt(1 - ca * ca), E2) - 0.02, aFloor: Math.acos(ca) };
}
/** inner wall x (one side) at height y above the cabin floor */
function wallX(y: number) {
  const s = sec(0, { w: 0, cy: 0, h: 0 }), h = s.h - SKIN, w = s.w - SKIN;
  const cr = THREE.MathUtils.clamp((s.cy - y) / h, -1, 1), ca = sp(cr, SE / 2);
  return w * sp(Math.sqrt(Math.max(0, 1 - ca * ca)), E2);
}
function buildCargoBay(M: BayMats) {
  const g = new THREE.Group(); g.name = "cargo-bay";
  const { halfW, aFloor } = bayHalfW();
  const Z0 = -9.0;
  // ---- floor slab + yellow aisle rails with tie-down slots + wall tie-down rails / rings
  const floor = rbox(halfW * 2, 0.12, Z_UP - Z0, 0.03); floor.translate(0, FLOOR_Y - 0.06, (Z_UP + Z0) / 2);
  const fu = floor.attributes.uv as THREE.BufferAttribute, fp = floor.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < fu.count; i++) fu.setXY(i, fp.getX(i) * 1.2, fp.getZ(i) * 1.2);
  const floorM = new THREE.Mesh(floor, M.tread); floorM.receiveShadow = true;
  const metal: THREE.BufferGeometry[] = [], rails: THREE.BufferGeometry[] = [], dark: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const r = rbox(0.16, 0.035, Z_UP - Z0 - 0.3, 0.012); r.translate(sx * 0.46, FLOOR_Y + 0.012, (Z_UP + Z0) / 2); rails.push(r);
    for (let z = Z0 + 0.5; z < Z_UP - 0.3; z += 0.55) { const sl = rbox(0.07, 0.02, 0.2, 0.008); sl.translate(sx * 0.46, FLOOR_Y + 0.024, z); dark.push(sl); }
    const x = sx * (halfW - 0.2);
    const wr = rbox(0.1, 0.05, Z_UP - Z0 - 0.4, 0.015); wr.translate(x, FLOOR_Y + 0.02, (Z_UP + Z0) / 2); metal.push(wr);
    for (let z = Z0 + 0.6; z < Z_UP; z += 0.7) { const t = new THREE.TorusGeometry(0.05, 0.012, 5, 10); t.rotateY(Math.PI / 2); t.translate(x, FLOOR_Y + 0.07, z); metal.push(t); }
  }
  // ---- frames: yellow U-channels every 0.8 m (on the wall-panel seams), split round the portholes
  const ribs: THREE.BufferGeometry[] = [];
  const aWin = aOfY(WIN_Y);
  const ribArc = (z: number, a0: number, a1: number) => {
    if (a1 - a0 < 0.05) return;
    const as = range(a0, a1, Math.max(4, Math.round((a1 - a0) * 14)));
    // face (toward the cabin) + two side walls, each its own strip (crisp edges)
    const D = 0.075, Wd = 0.06;
    ribs.push(surface(as, [-Wd, Wd], (a, dz, o) => fuse(z + dz, a, o, SKIN + D), { uv: (a, dz) => [a * 2, dz * 4] }));
    ribs.push(surface(as, [0, D], (a, d, o) => fuse(z - Wd, a, o, SKIN + d), { flip: true, uv: (a, d) => [a * 2, d * 4] }));
    ribs.push(surface(as, [0, D], (a, d, o) => fuse(z + Wd, a, o, SKIN + d), { uv: (a, d) => [a * 2, d * 4] }));
  };
  const pAng = 0.19;
  for (let z = ZN + 0.8 * Math.ceil((Z0 + 0.4 - ZN) / 0.8); z < Z_UP; z += 0.8) {
    const hitP = PORTHOLES.some((zp) => Math.abs(zp - z) < 0.36);
    if (!hitP) { ribArc(z, aFloor, TAU - aFloor); continue; }
    ribArc(z, aFloor, aWin - pAng); ribArc(z, aWin + pAng, TAU - aWin - pAng); ribArc(z, TAU - aWin + pAng, TAU - aFloor);
  }
  for (let z = Z_UP + 0.4; z < Z_OPEN; z += 0.8) ribArc(z, theta(z) + 0.02, TAU - theta(z) - 0.02);
  // stringers (longitudinal) high on the walls
  for (const a of [2.35, TAU - 2.35]) ribs.push(surface(range(Z0 + 0.2, Z_UP, 24), [-0.03, 0.03], (z, d, o) => fuse(z, a + d, o, SKIN + 0.05), { uv: (z, d) => [z, d] }));
  // ---- portholes: grey frame ring + lit sky glass, 8 a side (same z as the livery's)
  const glass: THREE.BufferGeometry[] = [], frames: THREE.BufferGeometry[] = [];
  const pp = new THREE.Vector3(), nn = new THREE.Vector3(), q1 = new THREE.Vector3(), q2 = new THREE.Vector3();
  for (const s of [1, -1]) for (const z of PORTHOLES) {
    const a = s > 0 ? aWin : TAU - aWin;
    fuse(z, a, pp, SKIN);
    fuse(z + 0.01, a, q1, SKIN); fuse(z - 0.01, a, q2, SKIN); const dz = q1.clone().sub(q2);
    fuse(z, a + 0.01, q1, SKIN); fuse(z, a - 0.01, q2, SKIN); nn.copy(dz.cross(q1.sub(q2)).normalize()); if (nn.x * s > 0) nn.negate();   // into the cabin
    const ring = new THREE.TorusGeometry(0.23, 0.036, 8, 28); ring.scale(1, 1, 0.7); place(ring, pp.clone().addScaledVector(nn, 0.03), nn, new THREE.Vector3(0, 0, 1)); frames.push(ring);
    const gl = new THREE.CircleGeometry(0.215, 24); place(gl, pp.clone().addScaledVector(nn, 0.004), nn, new THREE.Vector3(0, 0, 1)); glass.push(gl);
  }
  // ---- overhead: spine beam + two pipes + clamps, lamps
  const beamY = TOP - SKIN - 0.16;
  const beam = rbox(0.56, 0.16, Z_UP - Z0 - 0.4, 0.03); beam.translate(0, beamY, (Z_UP + Z0) / 2); ribs.push(beam);
  for (const a of [Math.PI - 0.62, Math.PI + 0.62]) {
    const pts = range(Z0 + 0.3, Z_UP + 0.2, 10).map((z) => fuse(z, a, new THREE.Vector3(), SKIN + 0.13));
    metal.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.05, 8, false));
    for (let z = Z0 + 0.8; z < Z_UP; z += 1.6) { const c = new THREE.TorusGeometry(0.065, 0.014, 5, 12); const p0 = fuse(z, a, new THREE.Vector3(), SKIN + 0.13); c.translate(p0.x, p0.y, p0.z); metal.push(c); }
  }
  // static-line anchor cables + hanging grab straps + ceiling hatches
  for (const x of [-0.72, 0.72]) {
    const y = fuse(0, Math.PI - Math.sign(x) * 0.36, new THREE.Vector3(), SKIN + 0.3).y;
    metal.push(rod(new THREE.Vector3(x, y, Z0 + 0.4), new THREE.Vector3(x, y, Z_UP - 0.2), 0.012, 6));
    for (let z = Z0 + 1.0; z < Z_UP - 0.5; z += 1.2) { const st = rbox(0.035, 0.34, 0.012, 0.005); st.translate(x, y - 0.17, z); dark.push(st); const lp = new THREE.TorusGeometry(0.05, 0.012, 5, 10); lp.translate(x, y - 0.38, z); dark.push(lp); }
  }
  for (let z = Z0 + 1.6; z < Z_UP - 1; z += 3.2) for (const d of [-1, 1]) { const h = rbox(0.6, 0.03, 0.9, 0.02); h.rotateZ(-d * 0.42); const p0 = fuse(z, Math.PI + d * 0.42, new THREE.Vector3(), SKIN + 0.02); h.translate(p0.x, p0.y, z); dark.push(h); }
  const lamps: THREE.BufferGeometry[] = [];
  for (let z = -8; z < Z_UP; z += 2.4) {
    const l = rbox(0.24, 0.05, 0.7, 0.02); l.translate(0, beamY - 0.1, z); lamps.push(l);
    const h = rbox(0.34, 0.05, 0.8, 0.02); h.translate(0, beamY - 0.07, z); dark.push(h);
  }
  // ---- aft portal: grey frame ring round the cabin section at the ramp hinge + hazard band on its edge + JUMP lamp
  const zP = Z_UP + 0.1;
  const portal = surface(range(aFloor, TAU - aFloor, 48), [0, 1], (a, r, o) => { fuse(zP, a, o, SKIN - 0.01); const c = fuse(zP, a, new THREE.Vector3(), SKIN + 0.24); o.lerp(c, r); o.z = zP; }, { flip: true, uv: (a, r) => [a, r] });
  const portalBack = surface(range(aFloor, TAU - aFloor, 48), [0, 1], (a, r, o) => { const c = fuse(zP + 0.18, a, new THREE.Vector3(), SKIN + 0.24); fuse(zP, a, o, SKIN + 0.24); o.lerp(c, r); }, { uv: (a, r) => [a, r] });
  const hazard = surface(range(aFloor, TAU - aFloor, 64), [0, 1], (a, r, o) => { const c0 = fuse(zP - 0.004, a, new THREE.Vector3(), SKIN + 0.24 - 0.1 * (1 - r)); o.copy(c0); o.z = zP - 0.004; }, { flip: true, uv: (a, r) => [((a - aFloor) / (TAU - 2 * aFloor)) * 22, r] });
  const thr = rbox(halfW * 2 - 0.1, 0.05, 0.25, 0.015); thr.translate(0, FLOOR_Y + 0.01, Z_UP - 0.1);
  const lampTop = fuse(zP, Math.PI, new THREE.Vector3(), SKIN + 0.24);
  const LY = lampTop.y - 0.3;
  const housing = rbox(0.66, 0.5, 0.22, 0.06); housing.translate(0, LY, zP - 0.1); dark.push(housing);
  const jumpLamp = new THREE.CylinderGeometry(0.2, 0.2, 0.1, 8); jumpLamp.rotateX(Math.PI / 2); jumpLamp.rotateZ(Math.PI / 8); jumpLamp.translate(0, LY, zP - 0.22);
  const cage = new THREE.TorusGeometry(0.225, 0.022, 6, 8); cage.rotateZ(Math.PI / 8); cage.translate(0, LY, zP - 0.27); metal.push(cage);
  for (const d of [-1, 1]) { const bar = rbox(0.02, 0.4, 0.02, 0.008); bar.translate(d * 0.09, LY, zP - 0.28); metal.push(bar); }
  // ---- seats (both walls): red padded back + pan + headrest loop, grey tube frame, harness reel
  const seatG: THREE.BufferGeometry[] = [], tubes: THREE.BufferGeometry[] = [];
  const seats: BaySeat[] = [];
  const SEAT_Y = FLOOR_Y + 0.23, BACK_Y = FLOOR_Y + 0.72;
  for (const s of [-1, 1] as const) {
    const xb = wallX(BACK_Y) - 0.12, xs = wallX(SEAT_Y) - 0.02;
    for (const z of BAY_SEATS_Z) {
      const back = rbox(0.12, 0.72, 0.54, 0.05, 3); back.rotateZ(s * 0.1); back.translate(s * xb, BACK_Y, z); seatG.push(back);
      const pan = rbox(0.5, 0.1, 0.54, 0.04, 3); pan.translate(s * (xs - 0.3), SEAT_Y, z); seatG.push(pan);
      const head = new THREE.TorusGeometry(0.15, 0.036, 8, 16, Math.PI); head.rotateY(Math.PI / 2); head.translate(s * (wallX(BACK_Y + 0.5) - 0.1), BACK_Y + 0.42, z); seatG.push(head);
      const reel = rbox(0.1, 0.16, 0.22, 0.02); reel.translate(s * (wallX(BACK_Y + 0.4) - 0.1), BACK_Y + 0.4, z); dark.push(reel);
      // frame: two legs from the pan's front edge to the floor, two posts at the wall
      for (const dz of [-0.24, 0.24]) {
        tubes.push(rod(new THREE.Vector3(s * (xs - 0.52), SEAT_Y - 0.05, z + dz), new THREE.Vector3(s * (xs - 0.48), FLOOR_Y, z + dz), 0.022, 8));
        tubes.push(rod(new THREE.Vector3(s * (xs - 0.52), SEAT_Y - 0.04, z + dz), new THREE.Vector3(s * (wallX(SEAT_Y) - 0.06), SEAT_Y - 0.04, z + dz), 0.02, 8));
      }
      seats.push({ side: s, z, backX: s * (xb - 0.065), seatY: SEAT_Y + 0.05 });
      // dark grey backing panel behind each seat (the target art's seat rows sit on dark metal panels)
      const bp = rbox(0.04, 1.05, 0.66, 0.02); bp.rotateZ(s * 0.1); bp.translate(s * (wallX(BACK_Y) - 0.035), BACK_Y + 0.1, z); dark.push(bp);
    }
    // continuous rails: seat front + top rail + wall posts between the seats
    const z0 = BAY_SEATS_Z[0] - 0.4, z1 = BAY_SEATS_Z[BAY_SEATS_Z.length - 1] + 0.4;
    tubes.push(rod(new THREE.Vector3(s * (xs - 0.53), SEAT_Y - 0.03, z0), new THREE.Vector3(s * (xs - 0.53), SEAT_Y - 0.03, z1), 0.026, 8));
    tubes.push(rod(new THREE.Vector3(s * (wallX(BACK_Y + 0.33) - 0.08), BACK_Y + 0.33, z0), new THREE.Vector3(s * (wallX(BACK_Y + 0.33) - 0.08), BACK_Y + 0.33, z1), 0.024, 8));
    for (let k = 0; k <= BAY_SEATS_Z.length; k++) { const z = (k === 0 ? BAY_SEATS_Z[0] - 0.62 : BAY_SEATS_Z[k - 1] + 0.62); tubes.push(rod(new THREE.Vector3(s * (wallX(FLOOR_Y + 0.05) - 0.05), FLOOR_Y, z), new THREE.Vector3(s * (wallX(BACK_Y + 0.35) - 0.08), BACK_Y + 0.35, z), 0.022, 8)); }
  }
  // ---- BANANA CO. crates strapped by the ramp (cargo straps over them)
  const crates: THREE.BufferGeometry[] = [], straps: THREE.BufferGeometry[] = [];
  for (const [x, y, z, sz, ry] of [[-(halfW - 0.62), 0, -8.3, 0.95, 0.04], [-(halfW - 0.62), 0.95, -8.25, 0.78, 0.1], [halfW - 0.6, 0, -8.2, 0.85, -0.06]] as const) {
    const b = rbox(sz, sz, sz, 0.04); b.rotateY(ry); b.translate(x, FLOOR_Y + y + sz / 2, z); crates.push(b);
    for (const dz of [-0.25, 0.25]) { const st = rbox(sz + 0.03, 0.02, 0.07, 0.008); st.translate(0, sz / 2 + 0.005, dz * sz); const st2 = rbox(0.02, sz + 0.02, 0.07, 0.008); const st3 = st2.clone(); st2.translate(sz / 2 + 0.005, 0, dz * sz); st3.translate(-sz / 2 - 0.005, 0, dz * sz); for (const q of [st, st2, st3]) { q.rotateY(ry); q.translate(x, FLOOR_Y + y + sz / 2, z); straps.push(q); } }
  }
  const mk = (geo: THREE.BufferGeometry, m: THREE.Material, cast = false, name = "") => { const me = new THREE.Mesh(geo, m); me.castShadow = cast; me.receiveShadow = true; if (name) me.name = name; return me; };
  g.add(floorM, mk(merge(metal), M.metal), mk(merge(ribs), M.rib, false, "bay-frames"), mk(merge(seatG), M.seat, false, "bay-seats"), mk(merge(tubes), M.frame), mk(merge(dark), M.dark),
    mk(merge(lamps), M.lamp), mk(merge(crates), M.crate, true), mk(merge(straps), M.strap), mk(merge(rails), M.railY), mk(merge(frames), M.frame), mk(merge(glass), M.glass),
    mk(merge([portal, portalBack, thr]), M.metal), mk(hazard, M.hazard), mk(jumpLamp, M.jump, false, "jump-lamp"));
  return { group: g, seats };
}
/** yellow painted cabin wall tile (1.6 × 1.6 m, repeat): panels between the frame seams, rivet rows, stencils, wear */
function paintCabinWall(): Tex {
  const W = 1024, H = 1024, P = new Paint(W, H, "#efc21a", 0.62), c = P.c;
  P.blotch(90, 301, 30, 160, 0.14, ["255,236,150", "150,96,0"]);
  // vertical seams (under the frames) at u = 0, .5 and horizontal panel seams every 0.4 m
  for (const x of [0, W / 2]) { P.line(x + 1, 0, x + 1, H, 1.4, 0.4); P.rivets(x + 14, 0, x + 14, H, 16, 0, 1, 0.3); P.rivets(x - 14 + (x ? 0 : W), 0, x - 14 + (x ? 0 : W), H, 16, 0, 1, 0.3); }
  for (let y = 0; y < H; y += H / 4) { P.line(0, y + 1, W, y + 1, 1, 0.34); P.rivets(0, y + 10, W, y + 10, 18, 0, 1, 0.24); }
  // access hatches + a few stencils
  P.hatch(W * 0.12, H * 0.58, W * 0.24, H * 0.12, 8);
  P.hatch(W * 0.64, H * 0.08, W * 0.2, H * 0.1, 8);
  // scuffs + grime runs down from the rivet rows
  P.chips(0, 0, W, H, 70, 303, "210,180,110");
  const R = rng(305);
  for (let i = 0; i < 40; i++) { const x = R() * W, y = R() * H, l = 20 + R() * 80; const g = c.createLinearGradient(x, y, x, y + l); g.addColorStop(0, "rgba(110,70,10,0.22)"); g.addColorStop(1, "rgba(110,70,10,0)"); c.fillStyle = g; c.fillRect(x, y, 2 + R() * 3, l); }
  P.grain(9000, 307, 0.05);
  return P.tex(3);
}
/** red seat webbing (repeat): woven strap basket weave with stitched borders */
function paintWebbing(): Tex {
  // red padded seat vinyl: 5 rolled vertical channels (lit crowns, dark stitched seams), a piped border, wear on the crowns
  const W = 256, H = 256, P = new Paint(W, H, "#b0291b", 0.72), c = P.c;
  const n = 5, s = W / n;
  for (let i = 0; i < n; i++) {
    const g = c.createLinearGradient(i * s, 0, (i + 1) * s, 0);
    g.addColorStop(0, "rgba(40,0,0,0.42)"); g.addColorStop(0.18, "rgba(255,120,90,0.05)"); g.addColorStop(0.5, "rgba(255,150,120,0.16)"); g.addColorStop(0.82, "rgba(255,120,90,0.02)"); g.addColorStop(1, "rgba(40,0,0,0.42)");
    c.fillStyle = g; c.fillRect(i * s, 0, s, H);
    const hg = P.h.createLinearGradient(i * s, 0, (i + 1) * s, 0); hg.addColorStop(0, gray(0.15)); hg.addColorStop(0.5, gray(0.8)); hg.addColorStop(1, gray(0.15));
    P.h.fillStyle = hg; P.h.fillRect(i * s, 0, s, H);
    c.strokeStyle = "rgba(255,220,200,0.18)"; c.setLineDash([4, 4]); c.lineWidth = 1; c.beginPath(); c.moveTo(i * s + 3, 0); c.lineTo(i * s + 3, H); c.stroke(); c.setLineDash([]);
  }
  c.strokeStyle = "rgba(50,5,0,0.6)"; c.lineWidth = 6; c.strokeRect(3, 3, W - 6, H - 6);
  P.chips(0, 0, W, H, 30, 311, "220,120,100");
  P.grain(2500, 309, 0.05);
  return P.tex(2);
}
/** diagonal yellow / black hazard stripes (repeat along u) */
function paintHazard(): THREE.Texture {
  const c = mkCanvas(64, 32), g = g2d(c);
  g.fillStyle = "#e9b50f"; g.fillRect(0, 0, 64, 32);
  g.fillStyle = "#1c1a17"; for (let x = -32; x < 96; x += 32) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 16, 32); g.lineTo(x + 32, 0); g.lineTo(x + 16, 0); g.closePath(); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
/** porthole view: bright sky → sea gradient (unlit — the glass shows the daylight outside) */
function paintPortholeGlass(): THREE.Texture {
  const c = mkCanvas(64, 64), g = g2d(c);
  const gr = g.createLinearGradient(0, 0, 0, 64); gr.addColorStop(0, "#bfe6ff"); gr.addColorStop(0.55, "#8fd0ff"); gr.addColorStop(0.62, "#3fb7d8"); gr.addColorStop(1, "#1f86b8");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const hl = g.createRadialGradient(22, 20, 0, 22, 20, 30); hl.addColorStop(0, "rgba(255,255,255,0.55)"); hl.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = hl; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildWings(mat: THREE.Material) {
  const shape: LiftShape = {
    half: WING_HALF, round: 0.95, camber: 0.025, inc: 0.035,
    chord: (x) => (x < WING_CENTRE ? WING_C0 : lerp(WING_C0, WING_C1, (x - WING_CENTRE) / (WING_HALF - WING_CENTRE))),
    le: (x) => WING_LE + (x < WING_CENTRE ? 0 : 0.45 * (x - WING_CENTRE) / (WING_HALF - WING_CENTRE)),
    y: (x) => WING_Y + Math.max(0, x - 1.8) * Math.tan(THREE.MathUtils.degToRad(2.6)),
    t: (x) => lerp(0.17, 0.12, clamp01((x - WING_CENTRE) / (WING_HALF - WING_CENTRE))),
  };
  const { f, spans, vs } = liftSurface(shape, 64, 22);
  const geo = surface(spans, vs, f, { flip: true, uv: (x, v) => [(x + WING_HALF) / (2 * WING_HALF), v], vd: [0, 1] });
  const m = new THREE.Mesh(geo, mat); m.name = "wing"; m.castShadow = true; m.receiveShadow = true;
  // flap-track canoe fairings under the trailing edge
  const canoes: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) for (const x of [3.1, 8.6, 11.8]) {
    const c = new THREE.CapsuleGeometry(0.1, 0.9, 4, 8); c.rotateX(Math.PI / 2); c.scale(1, 1.4, 1);
    const ax = Math.abs(x), le = shape.le(ax), ch = shape.chord(ax);
    c.translate(s * x, shape.y(ax) - 0.2, le + ch * 0.86); canoes.push(c);
  }
  return { mesh: m, shape, canoes };
}

function buildStabs(mat: THREE.Material) {
  const shape: LiftShape = {
    half: STAB_HALF, round: 0.55, camber: 0, inc: 0,
    chord: (x) => lerp(3.2, 1.9, x / STAB_HALF), le: (x) => STAB_LE + 1.05 * (x / STAB_HALF),
    y: (x) => STAB_Y + x * 0.012, t: () => 0.12,
  };
  const { f, spans, vs } = liftSurface(shape, 36, 16);
  const geo = surface(spans, vs, f, { flip: true, uv: (x, v) => [(x + STAB_HALF) / (2 * STAB_HALF), v], vd: [0, 1] });
  const m = new THREE.Mesh(geo, mat); m.name = "stabiliser"; m.castShadow = true; m.receiveShadow = true;
  return m;
}

function buildFin(mat: THREE.Material) {
  const f: Fn = (h, v, o) => {
    const y = lerp(FIN_Y0, FIN_Y1, h);
    let le = finLE(y), te = finTE(y);
    // squared, raked top with small rounded corners (the target art's fin is squared, not a pointed ogive)
    const q = (y - FIN_TOP0) / (FIN_Y1 - FIN_TOP0);
    if (q > 0) { const kl = ell(q, 4.5), kt = ell(q, 3.2); const mid = lerp(le, te, 0.5); le = mid - (mid - le) * kl; te = mid + (te - mid) * Math.max(1e-3, kt); }
    const c = Math.max(1e-3, te - le), xc = chordOf(v), [, yt] = airfoil(xc, 0.12, 0);
    const side = v >= 0.5 ? -1 : 1; // v<0.5 → starboard (+x) skin
    o.set(side * yt * c * (q > 0 ? Math.max(0.15, ell(q, 2.4)) : 1), y, le + xc * c);
  };
  const hs = uniq([...range(0, 1, 40), ...range((FIN_TOP0 - FIN_Y0) / (FIN_Y1 - FIN_Y0), 1, 14, 0.7)]);
  const sx = 0.5 / (FIN_ZMAX - FIN_ZMIN);
  const stbd = surface(hs, cosRange(0, 0.5, 22), f, { flip: true, vd: [0, 1], uv: (_h, _v, p) => [(FIN_ZMAX - p.z) * sx, (p.y - FIN_Y0) / (FIN_Y1 - FIN_Y0)] });
  const port = surface(hs, cosRange(0.5, 1, 22), f, { flip: true, vd: [0, 1], uv: (_h, _v, p) => [0.5 + (p.z - FIN_ZMIN) * sx, (p.y - FIN_Y0) / (FIN_Y1 - FIN_Y0)] });
  const m = new THREE.Mesh(merge([stbd, port]), mat); m.name = "fin"; m.castShadow = true; m.receiveShadow = true;
  return m;
}

function buildSponsons(mat: THREE.Material) {
  const geos: THREE.BufferGeometry[] = [];
  const Z0 = -5.25, Z1 = 1.75;
  for (const s of [-1, 1]) {
    const f: Fn = (z, a, o) => {
      const t = (z - Z0) / (Z1 - Z0);
      const kf = t < 0.16 ? ell((0.16 - t) / 0.16, 2.1) : 1;
      const kr = t > 0.62 ? ell((t - 0.62) / 0.38, 1.5) : 1;
      const k = kf * kr;
      const hw = 0.78 * Math.max(0.03, Math.pow(k, 0.9)), hh = 0.74 * Math.max(0.03, k);
      const cx = s * lerp(1.45, 1.9, Math.pow(kr, 0.6)), cy = lerp(2.05, 1.62, Math.pow(kr, 0.8));
      o.set(cx + hw * sp(Math.sin(a), 2 / 2.5) * s, cy - hh * sp(Math.cos(a), 2 / 2.5), z);
    };
    geos.push(surface(range(Z0, Z1, 40), range(0, TAU, 40), f, { flip: s > 0, vd: [0, TAU], uv: (z, a) => [(z - Z0) / (Z1 - Z0), a / TAU] }));
  }
  const m = new THREE.Mesh(merge(geos), mat); m.name = "sponsons"; m.castShadow = true; m.receiveShadow = true;
  return m;
}

function wheelGeoms(R: number, W: number) {
  // tyre (profile around the axle, axle = X)
  const prof: [number, number][] = [];
  const rim = R * 0.58;
  const pts: [number, number][] = [[rim, W * 0.44], [R * 0.8, W * 0.5], [R * 0.95, W * 0.46], [R * 0.995, W * 0.36], [R, W * 0.2], [R, -W * 0.2], [R * 0.995, -W * 0.36], [R * 0.95, -W * 0.46], [R * 0.8, -W * 0.5], [rim, -W * 0.44]];
  const curve = new THREE.SplineCurve(pts.map(([r, x]) => new THREE.Vector2(x, r)));
  const n = 18;
  for (let i = 0; i <= n; i++) { const p = curve.getPoint(i / n); prof.push([p.y, p.x]); }
  const tyre = surface(range(0, n, n), range(0, TAU, 40), (i, a, o) => {
    const k = Math.min(n - 1, Math.floor(i)), fr = i - k, p0 = prof[k], p1 = prof[Math.min(n, k + 1)];
    const r = lerp(p0[0], p1[0], fr), x = lerp(p0[1], p1[1], fr);
    o.set(x, r * Math.cos(a), r * Math.sin(a));
  }, { uv: (i, a) => [i / n, a / TAU], ud: [0, n], vd: [0, TAU] });
  // hub: dished disc on the outer face + bolt ring + axle cap (both faces)
  const hubs: THREE.BufferGeometry[] = [];
  for (const sgn of [1, -1]) {
    const hp = [new THREE.Vector2(0.001, W * 0.34), new THREE.Vector2(R * 0.12, W * 0.34), new THREE.Vector2(R * 0.16, W * 0.26), new THREE.Vector2(R * 0.36, W * 0.24), new THREE.Vector2(R * 0.44, W * 0.34), new THREE.Vector2(rim * 1.01, W * 0.42), new THREE.Vector2(rim * 1.01, 0)];
    const lg = new THREE.LatheGeometry(hp, 28); lg.rotateZ(-Math.PI / 2); if (sgn < 0) lg.rotateY(Math.PI);
    hubs.push(lg);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU, b = new THREE.CylinderGeometry(0.022, 0.026, 0.05, 6);
      b.rotateZ(Math.PI / 2); b.translate(sgn * W * 0.27, Math.cos(a) * R * 0.27, Math.sin(a) * R * 0.27); hubs.push(b);
    }
  }
  return { tyre, hub: merge(hubs) };
}

function buildGear(tyreM: THREE.Material, hubM: THREE.Material, strutM: THREE.Material, darkM: THREE.Material) {
  const main: THREE.Group[] = [];
  const { tyre, hub } = wheelGeoms(WHEEL_R, 0.38);
  const WZ = [-3.95, -2.78, -1.61, -0.44];
  for (const s of [-1, 1]) {
    const g = new THREE.Group(); g.name = s > 0 ? "gear-R" : "gear-L";
    const x = s * 1.98;
    const t: THREE.BufferGeometry[] = [], h: THREE.BufferGeometry[] = [], st: THREE.BufferGeometry[] = [];
    for (const z of WZ) { t.push(tyre.clone().translate(x, WHEEL_R, z)); h.push(hub.clone().translate(x, WHEEL_R, z)); }
    // bogie beams + oleo struts (hidden in the sponson when retracted)
    for (const zc of [(WZ[0] + WZ[1]) / 2, (WZ[2] + WZ[3]) / 2]) {
      st.push(rod(new THREE.Vector3(x - s * 0.26, WHEEL_R, zc - 0.62), new THREE.Vector3(x - s * 0.26, WHEEL_R, zc + 0.62), 0.07, 8));
      st.push(rod(new THREE.Vector3(x - s * 0.26, WHEEL_R, zc), new THREE.Vector3(x - s * 0.26, WHEEL_R + 1.1, zc), 0.09, 10));
      st.push(rod(new THREE.Vector3(x - s * 0.26, WHEEL_R + 0.35, zc), new THREE.Vector3(x - s * 0.26, WHEEL_R + 1.25, zc), 0.12, 10));
    }
    const mt = new THREE.Mesh(merge(t), tyreM), mh = new THREE.Mesh(merge(h), hubM), ms = new THREE.Mesh(merge(st), strutM);
    for (const m of [mt, mh, ms]) { m.castShadow = true; m.receiveShadow = true; }
    g.add(mt, mh, ms); main.push(g);
  }
  // nose gear: twin wheels, strut, torque link
  const ng = new THREE.Group(); ng.name = "gear-nose";
  const nw = wheelGeoms(NOSE_WHEEL_R, 0.24);
  const nt: THREE.BufferGeometry[] = [], nh: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) { nt.push(nw.tyre.clone().translate(s * 0.2, NOSE_WHEEL_R, NOSE_GEAR_Z)); nh.push(nw.hub.clone().translate(s * 0.2, NOSE_WHEEL_R, NOSE_GEAR_Z)); }
  const ns = [
    rod(new THREE.Vector3(-0.1, NOSE_WHEEL_R, NOSE_GEAR_Z), new THREE.Vector3(0.1, NOSE_WHEEL_R, NOSE_GEAR_Z), 0.06, 8),
    rod(new THREE.Vector3(0, NOSE_WHEEL_R, NOSE_GEAR_Z), new THREE.Vector3(0, NOSE_WHEEL_R + 1.25, NOSE_GEAR_Z - 0.05), 0.075, 10),
    rod(new THREE.Vector3(0, NOSE_WHEEL_R + 0.45, NOSE_GEAR_Z), new THREE.Vector3(0, NOSE_WHEEL_R + 1.4, NOSE_GEAR_Z - 0.05), 0.1, 10),
    rod(new THREE.Vector3(0, NOSE_WHEEL_R + 0.25, NOSE_GEAR_Z + 0.12), new THREE.Vector3(0, NOSE_WHEEL_R + 0.6, NOSE_GEAR_Z + 0.2), 0.03, 6),
  ];
  const mt = new THREE.Mesh(merge(nt), tyreM), mh = new THREE.Mesh(merge(nh), hubM), ms = new THREE.Mesh(merge(ns), strutM);
  for (const m of [mt, mh, ms]) { m.castShadow = true; m.receiveShadow = true; }
  ng.add(mt, mh, ms);
  // dark wheel-well boxes inside the sponsons / nose so the retracted wheels sit in shadowed bays
  const wells: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) { const b = rbox(0.5, 0.5, 4.5, 0.05); b.translate(s * 1.98, 1.25, -2.2); wells.push(b); }
  { const b = rbox(0.62, 0.55, 1.5, 0.05); b.translate(0, 1.62, NOSE_GEAR_Z); wells.push(b); }
  const wellM = new THREE.Mesh(merge(wells), darkM);
  return { main, nose: ng, wells: wellM };
}

function buildEngine(cowlM: THREE.Material, nacM: THREE.Material, darkM: THREE.Material, spinM: THREE.Material, bladeM: THREE.Material, discM: THREE.Material, sootM: THREE.Material, s: number) {
  const eng = new THREE.Group(); eng.name = s > 0 ? "engine-R" : "engine-L";
  // cowl: lathe around the engine axis (+Z aft). profile u: inner lip → outer → rear
  const prof: [number, number][] = [[0.8, 0.34], [0.82, 0.14], [0.87, 0.03], [0.95, 0.0], [1.0, 0.05], [1.03, 0.2], [COWL_R, 0.6], [COWL_R, 1.4], [1.02, 2.0], [0.98, 2.4]];
  const pc = new THREE.CatmullRomCurve3(prof.map(([r, z]) => new THREE.Vector3(r, z, 0)));
  const np = 40, pp = pc.getSpacedPoints(np);
  const cowl = surface(range(0, np, np), range(0, TAU, 56), (i, a, o) => {
    const k = Math.min(np - 1, Math.floor(i)), fr = i - k, p0 = pp[k], p1 = pp[k + 1];
    const r = lerp(p0.x, p1.x, fr), z = lerp(p0.y, p1.y, fr);
    o.set(r * Math.sin(a), r * Math.cos(a), z);
  }, { uv: (i, a) => [i / np, a / TAU], ud: [0, np], vd: [0, TAU] });
  const cowlMesh = new THREE.Mesh(cowl, cowlM); cowlMesh.castShadow = true; cowlMesh.receiveShadow = true;
  // nacelle body behind the cowl, blending up into the wing
  const L = 7.6;
  const nac = surface(range(0, 1, 30), range(0, TAU, 40), (t, a, o) => {
    const r = 0.98 * (1 - 0.62 * Math.pow(t, 1.6)), cy = 0.55 * Math.pow(t, 1.4);
    const topFlat = 1 + 0.25 * Math.pow(t, 0.8);
    const y = -Math.cos(a) * r * (Math.cos(a) < 0 ? topFlat : 1);
    o.set(Math.sin(a) * r * (1 - 0.06 * t), cy + y, 2.35 + t * L);
  }, { flip: true, uv: (t, a) => [t, a / TAU], vd: [0, TAU] });
  const nacMesh = new THREE.Mesh(nac, nacM); nacMesh.castShadow = true; nacMesh.receiveShadow = true;
  // engine face: crankcase + 9 cylinders behind the lip; gills; exhaust stubs
  const dark: THREE.BufferGeometry[] = [];
  const face = new THREE.CircleGeometry(0.84, 32); face.translate(0, 0, 0.42); dark.push(face);
  const crank = new THREE.SphereGeometry(0.34, 20, 10, 0, TAU, 0, Math.PI / 2); crank.rotateX(-Math.PI / 2); crank.scale(1, 1, 0.6); crank.translate(0, 0, 0.4); dark.push(crank);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * TAU, cyl = new THREE.CylinderGeometry(0.1, 0.12, 0.42, 10);
    cyl.translate(0, 0.52, 0); cyl.rotateZ(a); cyl.translate(0, 0, 0.36); dark.push(cyl);
    for (let f = 0; f < 4; f++) { const fin = new THREE.CylinderGeometry(0.15, 0.15, 0.018, 12); fin.translate(0, 0.4 + f * 0.07, 0); fin.rotateZ(a); fin.translate(0, 0, 0.36); dark.push(fin); }
  }
  const soot: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * TAU, flap = rbox(0.3, 0.025, 0.44, 0.01);
    flap.translate(0, 0, 0.2); flap.rotateX(-0.2); flap.translate(0, 0.965, 2.34); flap.rotateZ(a); soot.push(flap);
  }
  for (const side of [-1, 1]) for (const dy of [-0.2, -0.55]) {
    const p0 = new THREE.Vector3(side * 0.85, dy, 2.6), p1 = new THREE.Vector3(side * 1.02, dy - 0.05, 3.0), p2 = new THREE.Vector3(side * 1.08, dy - 0.08, 3.35);
    soot.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([p0, p1, p2]), 8, 0.085, 10, false));
    const lip = new THREE.TorusGeometry(0.085, 0.018, 6, 12); lip.translate(p2.x, p2.y, p2.z); soot.push(lip);
  }
  const darkMesh = new THREE.Mesh(merge(dark), darkM), sootMesh = new THREE.Mesh(merge(soot), sootM);
  sootMesh.castShadow = true;
  // spinner (vertex coloured: brown base ring, glossy black-brown dome)
  const spinL = 1.25;
  const spin = surface(range(0, 1, 18), range(0, TAU, 32), (t, a, o) => {
    const r = 0.46 * ell(t, 1.9) * (t < 0.05 ? 1 : 1);
    o.set(r * Math.sin(a), r * Math.cos(a), PROP_Z - ENG_Z + 0.12 - t * spinL);
  }, { vd: [0, TAU], flip: true, color: (t) => (t < 0.16 ? new THREE.Color("#6b4724") : t < 0.2 ? new THREE.Color("#e0b030") : new THREE.Color("#1e1713")) });
  const spinMesh = new THREE.Mesh(spin, spinM); spinMesh.castShadow = true;
  // prop: 4 crisp blades (stopped) + blurred disc (running), both on a spinning hub group
  const prop = new THREE.Group(); prop.position.set(0, 0, PROP_Z - ENG_Z);
  const blades: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const b = surface(range(0.34, PROP_R, 22), range(0, TAU, 14), (r, a, o) => {
      const t = (r - 0.34) / (PROP_R - 0.34);
      let c = 0.18 + 0.24 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.12)) ;
      const tipQ = (r - (PROP_R - 0.14)) / 0.14;
      if (tipQ > 0) c *= Math.max(0.02, ell(tipQ, 2));
      const th = lerp(0.1, 0.028, Math.pow(t, 0.6)) * (tipQ > 0 ? Math.max(0.1, ell(tipQ, 2)) : 1);
      const beta = Math.atan(0.9 / (r + 0.2)) * 0.9;
      const cx = (c / 2) * Math.cos(a), cz = (th / 2) * Math.sin(a) + 0.02 * Math.cos(a) * Math.cos(a);
      o.set(cx * Math.cos(beta) - cz * Math.sin(beta), r, cx * Math.sin(beta) + cz * Math.cos(beta));
    }, { vd: [0, TAU], color: (r) => (r > PROP_R - 0.24 ? new THREE.Color(YEL) : new THREE.Color("#1f1813")) });
    b.rotateZ((k / 4) * TAU + 0.35);
    blades.push(b);
  }
  const hubC = new THREE.CylinderGeometry(0.36, 0.4, 0.3, 20); hubC.rotateX(Math.PI / 2);
  const colorAttr = new Float32Array(hubC.attributes.position.count * 3).fill(0.12); hubC.setAttribute("color", new THREE.BufferAttribute(colorAttr, 3));
  const bladeMesh = new THREE.Mesh(merge([...blades, hubC], true), bladeM); bladeMesh.castShadow = true;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(PROP_R + 0.03, 64), discM); disc.renderOrder = 2;
  prop.add(bladeMesh, disc);
  // brown cowling lip ring (reads from behind as the outline of the cowl mouth around the prop disc)
  const lip = new THREE.TorusGeometry(0.97, 0.075, 10, 56); lip.translate(0, 0, 0.07);
  const lipMesh = new THREE.Mesh(lip, darkM); lipMesh.castShadow = true;
  eng.add(cowlMesh, nacMesh, darkMesh, sootMesh, spinMesh, prop, lipMesh);
  eng.position.set(s * ENG_X, ENG_Y, ENG_Z);
  return { eng, prop, blades: bladeMesh, disc };
}

function buildDetails(metalM: THREE.Material, darkM: THREE.Material, redM: THREE.Material, greenM: THREE.Material, whiteM: THREE.Material, glassM: THREE.Material, frameM: THREE.Material, wingShape: LiftShape) {
  const g = new THREE.Group(); g.name = "details";
  const metal: THREE.BufferGeometry[] = [], dark: THREE.BufferGeometry[] = [], glass: THREE.BufferGeometry[] = [], frames: THREE.BufferGeometry[] = [];
  const p = new THREE.Vector3(), n = new THREE.Vector3(), q = new THREE.Vector3();
  const normalAt = (z: number, a: number) => {
    fuse(z + 0.01, a, q); fuse(z - 0.01, a, p); const dz = q.clone().sub(p);
    fuse(z, a + 0.01, q); fuse(z, a - 0.01, p); const da = q.clone().sub(p);
    return dz.cross(da).normalize().negate();
  };
  // portholes: glass lens (shallow spherical cap) + raised frame ring, 8 each side along the cheat line
  for (const s of [1, -1]) for (const z of PORTHOLES) {
    const a = s > 0 ? aOfY(WIN_Y) : TAU - aOfY(WIN_Y);
    fuse(z, a, p); n.copy(normalAt(z, a));
    const R = 0.62, rr = 0.225, th = Math.asin(rr / R);
    const cap = new THREE.SphereGeometry(R, 20, 4, 0, TAU, 0, th);
    cap.translate(0, -R * Math.cos(th) + 0.004, 0); place(cap, p, n); glass.push(cap);
    const ring = new THREE.TorusGeometry(0.255, 0.038, 8, 28); ring.scale(1, 1, 0.55); ring.rotateX(Math.PI / 2);
    place(ring, p.clone().addScaledVector(n, 0.008), n); frames.push(ring);
  }
  // beacons (top + belly), nav lights, tail light
  const top = fuse(1.9, Math.PI, new THREE.Vector3());
  const beacon = (pos: THREE.Vector3, up: number) => {
    const dome = new THREE.SphereGeometry(0.11, 14, 8, 0, TAU, 0, Math.PI / 2); dome.scale(1, 1.3, 1); if (up < 0) dome.rotateX(Math.PI);
    dome.translate(pos.x, pos.y + up * 0.05, pos.z);
    const base = new THREE.CylinderGeometry(0.14, 0.16, 0.06, 14); base.translate(pos.x, pos.y + up * 0.02, pos.z);
    return { dome, base };
  };
  const b1 = beacon(top, 1);
  // (no belly beacon: from the drop-01 camera it reads as a pink blob under the plane)
  const red = [b1.dome], green: THREE.BufferGeometry[] = [], white: THREE.BufferGeometry[] = [];
  metal.push(b1.base);
  for (const s of [-1, 1]) {
    const x = s * (WING_HALF - 0.28), le = wingShape.le(Math.abs(x)) + wingShape.chord(Math.abs(x)) * 0.42 * (1 - ell((Math.abs(x) - (WING_HALF - 0.95)) / 0.95, 2.2)) + 0.05;
    const l = new THREE.SphereGeometry(0.09, 12, 8); l.scale(1.6, 0.8, 1); l.translate(x, wingShape.y(Math.abs(x)), le);
    (s < 0 ? red : green).push(l);
  }
  { const l = new THREE.SphereGeometry(0.07, 10, 6); const tp = fuse(ZCAP - 0.02, 0, new THREE.Vector3()); l.translate(0, sec(ZCAP - 0.05).cy, ZCAP + 0.02); white.push(l); void tp; }
  // antennas: two blade antennas on top, one on the belly, whip + long wire from a mast to the fin
  const blade = (z: number, a: number, h: number, sw = 0.25) => {
    fuse(z, a, p); const nn = normalAt(z, a);
    const sh = new THREE.Shape(); sh.moveTo(-sw, 0); sh.lineTo(sw * 0.4, 0); sh.lineTo(sw * 0.2, h); sh.lineTo(-sw * 0.05, h); sh.closePath();
    const eg = new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 1 });
    eg.translate(0, 0, -0.015); eg.rotateY(Math.PI / 2); place(eg, p, nn); dark.push(eg);
  };
  blade(-7.2, Math.PI, 0.42); blade(3.3, Math.PI, 0.36); blade(-0.3, 0, 0.3); blade(6.6, Math.PI + 0.25, 0.3);
  // (no HF wire from a mast to the fin: the target art has none and a 7 mm wire only aliases into a stray line)
  // pitot tubes on both nose sides
  for (const s of [1, -1]) {
    const a = s > 0 ? 1.95 : TAU - 1.95; fuse(-12.35, a, p); const nn = normalAt(-12.35, a);
    const base = p.clone().addScaledVector(nn, 0.0), out = p.clone().addScaledVector(nn, 0.18);
    metal.push(rod(base, out, 0.022, 6)); metal.push(rod(out, out.clone().add(new THREE.Vector3(0, 0, -0.32)), 0.016, 6));
  }
  // landing lights in the wing leading edge (glass lenses)
  for (const s of [-1, 1]) { const l = new THREE.SphereGeometry(0.12, 14, 8, 0, TAU, 0, Math.PI / 2); l.rotateX(-Math.PI / 2); l.scale(1.2, 0.7, 0.4); l.translate(s * 3.2, wingShape.y(3.2) + 0.02, WING_LE - 0.005); glass.push(l); }
  const mk = (geo: THREE.BufferGeometry[], m: THREE.Material, cast = true) => { if (!geo.length) return; const me = new THREE.Mesh(merge(geo), m); me.castShadow = cast; me.receiveShadow = true; g.add(me); return me; };
  mk(metal, metalM); mk(dark, darkM); mk(glass, glassM, false); mk(frames, frameM); mk(red, redM, false); mk(green, greenM, false); mk(white, whiteM, false);
  return g;
}

// ============================================================================ assembly
type TexSet = { fT: Tex; wT: Tex; sT: Tex; finT: Tex; cT: Tex; nT: Tex; spT: Tex; tyT: Tex; trT: Tex; inT: Tex; webT: Tex; hazT: THREE.Texture; pgT: THREE.Texture; crT: Tex; discT: THREE.Texture };
let TEX: TexSet | null = null;
export async function createPlane(ctx: WorldCtx, opts: { crew?: boolean } = {}): Promise<PlaneProps> {
  const object = new THREE.Group();
  object.name = "plane";

  // ---- textures + materials
  // painted once per page and shared by every plane (the lobby's parked plane + the flight plane)
  // (painted in slices with a yield between them — no single main-thread task > ~50 ms)
  const yieldT = () => new Promise<void>((r) => setTimeout(r, 0));
  if (!TEX) {
    const t = {} as Partial<TexSet>;
    t.fT = paintFuselage(); await yieldT();
    t.wT = paintLift(2048, 512, { half: WING_HALF, tipBrown: WING_TIP_BROWN, seams: [2.25, 5.0, 6.6, 11.0, 15.2], hingeXc: 0.72, hingeFrom: 2.25, hingeTo: 15.2, ribs: 1.15, stripe: true, seed: 101 }); await yieldT();
    t.sT = paintLift(1024, 256, { half: STAB_HALF, tipBrown: STAB_HALF - 0.85, seams: [0.7, 2.9, 5.4], hingeXc: 0.68, hingeFrom: 0.7, hingeTo: 5.4, ribs: 0.9, seed: 202 });
    t.finT = paintFin(); await yieldT();
    t.cT = paintCowl(); t.nT = paintNacelle(); t.spT = paintSponson(); t.tyT = paintTyre(); await yieldT();
    t.trT = paintTreadplate(); t.inT = paintCabinWall(); t.webT = paintWebbing(); await yieldT();
    t.hazT = paintHazard(); t.pgT = paintPortholeGlass(); t.crT = paintCrate(); t.discT = propDiscTexture(); await yieldT();
    TEX ??= t as TexSet;
  }
  const { fT, wT, sT, finT, cT, nT, spT, tyT, trT, inT, webT, hazT, pgT, crT, discT } = TEX as TexSet;
  const paint = (t: Tex, o: THREE.MeshPhysicalMaterialParameters = {}) => new THREE.MeshPhysicalMaterial({
    map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(0.9, 0.9), roughnessMap: t.rough, roughness: 1, metalness: 0,
    // glossy lemon-yellow enamel (target art: a lacquered toy plane): strong clearcoat; a small LEMON fill through the
    // albedo map keeps shaded sides yellow (a dark-orange fill read ochre)
    // (pastel butter, saturation 0.66 vs 0.85–0.95 — the sky env on a 0.6 clearcoat + a lemon fill washed the
    // yellow out: a thinner coat, half the env, a small fill)
    clearcoat: 0.35, clearcoatRoughness: 0.14, envMapIntensity: 0.6,
    // a yellow fill through the albedo map (the target art lights the plane like a studio: its shaded flank stays lemon, never
    // tan) — with the thinner coat it lifts saturation, not whiteness
    // at 0.2 the shaded flank measured val 0.55 / sat 0.6 vs the target art's 0.8 / 0.95
    emissive: new THREE.Color("#ffdc30"), emissiveMap: t.map, emissiveIntensity: 0.3,
  });
  // (fin hue 32 vs the target art's 46 — atmos's warm bounce squared the yellow's chroma in the fill)
  const paintL = (t: Tex, o: THREE.MeshPhysicalMaterialParameters = {}) => actorLook(paint(t, o), { key: "plane-paint" });
  const fuseM = paintL(fT), wingM = paintL(wT), stabM = paintL(sT), finM = paintL(finT), cowlM = paintL(cT), nacM = paintL(nT), sponM = paintL(spT);
  const tyreM = new THREE.MeshStandardMaterial({ map: tyT.map, normalMap: tyT.normal, roughnessMap: tyT.rough, roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  const hubM = new THREE.MeshStandardMaterial({ color: "#c9c6bd", metalness: 0.85, roughness: 0.32 });
  const strutM = new THREE.MeshStandardMaterial({ color: "#d8d8d4", metalness: 0.9, roughness: 0.18 });
  const metalM = new THREE.MeshStandardMaterial({ color: "#7c7a74", metalness: 0.8, roughness: 0.4 });
  const darkM = new THREE.MeshStandardMaterial({ color: "#241f1b", metalness: 0.5, roughness: 0.55 });
  const sootM = new THREE.MeshStandardMaterial({ color: "#3b3129", metalness: 0.6, roughness: 0.5 });
  const wellM = new THREE.MeshStandardMaterial({ color: "#16110d", metalness: 0, roughness: 0.9, side: THREE.BackSide });
  const spinM = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.22, clearcoat: 0.8, clearcoatRoughness: 0.1 });
  const bladeM = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.35, clearcoat: 0.5, clearcoatRoughness: 0.2 });
  // unlit: a blur disc is an image of moving blades, not a lit surface (a lit disc goes grey from its back side)
  const discM = new THREE.MeshBasicMaterial({ map: discT, transparent: true, depthWrite: false, side: THREE.DoubleSide, color: "#8a8178" });
  const glassM = new THREE.MeshPhysicalMaterial({ color: "#0d161d", metalness: 0.1, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.8 });
  const frameM = new THREE.MeshPhysicalMaterial({ color: "#d8d2c2", metalness: 0.7, roughness: 0.28, clearcoat: 0.4 });
  const glow = (c: string, i: number) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: i, roughness: 0.2 });
  const redM = glow("#ff2a1a", 2.2), greenM = glow("#27ff5a", 2.0), whiteM = glow("#fff6e0", 0.7), lampM = glow("#fff1c9", 3.2);
  const treadM = new THREE.MeshStandardMaterial({ map: trT.map, normalMap: trT.normal, roughnessMap: trT.rough, roughness: 1, metalness: 0.75, envMapIntensity: 0.9 });
  // cargo bay: yellow painted walls lit by the cabin lamps (a small emissive fill through the albedo —
  // no PointLights: a light-count change recompiles every program), shaded red webbing seats (no emissive)
  for (const x of [inT.map, inT.normal, inT.rough]) { x.wrapS = x.wrapT = THREE.RepeatWrapping; x.repeat.set((ZCAP - ZN) / 1.6, 7.8); }
  for (const x of [webT.map, webT.normal, webT.rough]) x.wrapS = x.wrapT = THREE.RepeatWrapping;
  const interiorM = actorLook(new THREE.MeshStandardMaterial({ map: inT.map, normalMap: inT.normal, normalScale: new THREE.Vector2(0.8, 0.8), roughnessMap: inT.rough, roughness: 1, metalness: 0.1, emissiveMap: inT.map, emissive: "#fff1d0", emissiveIntensity: 0.16, side: THREE.FrontSide, envMapIntensity: 0.4 }), { key: "bay-wall" });
  const ribM = actorLook(new THREE.MeshStandardMaterial({ color: "#e6b414", roughness: 0.55, metalness: 0.15, emissive: "#e6b414", emissiveIntensity: 0.1, envMapIntensity: 0.4 }), { key: "bay-rib" });
  const crateM = new THREE.MeshStandardMaterial({ map: crT.map, normalMap: crT.normal, roughnessMap: crT.rough, roughness: 1, metalness: 0, emissive: "#3a2410", emissiveIntensity: 0.25, envMapIntensity: 0.45 });
  const seatM = new THREE.MeshStandardMaterial({ map: webT.map, normalMap: webT.normal, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.86, metalness: 0, color: "#ffffff", envMapIntensity: 0.4 });
  const bayFrameM = new THREE.MeshStandardMaterial({ color: "#9a9ea2", metalness: 0.75, roughness: 0.34 });
  const strapM = new THREE.MeshStandardMaterial({ color: "#2a2622", roughness: 0.8, metalness: 0 });
  const bayDarkM = new THREE.MeshStandardMaterial({ color: "#3a3835", roughness: 0.6, metalness: 0.4 });
  const jumpM = new THREE.MeshStandardMaterial({ color: "#ff2410", emissive: "#ff2410", emissiveIntensity: 4.5, roughness: 0.3 });
  const glassBayM = new THREE.MeshBasicMaterial({ map: pgT, color: "#ffffff" });
  const hazM = new THREE.MeshStandardMaterial({ map: hazT, roughness: 0.6, metalness: 0.2, emissive: "#ffffff", emissiveMap: hazT, emissiveIntensity: 0.08 });
  const railYM = actorLook(new THREE.MeshStandardMaterial({ color: "#f0c01a", roughness: 0.5, metalness: 0.2 }), { key: "bay-rail" });
  for (const t of [trT, crT]) for (const x of [t.map, t.normal, t.rough]) x.wrapS = x.wrapT = THREE.RepeatWrapping;

  // ---- geometry
  await yieldT();
  const { shell, lining } = buildFuselage(fuseM, interiorM);
  await yieldT();
  const ramp = buildRamp(fuseM, interiorM, treadM, metalM);
  const door = buildUpperDoor(fuseM, interiorM);
  const bayB = buildCargoBay({ tread: treadM, metal: metalM, crate: crateM, seat: seatM, lamp: lampM, rib: ribM, frame: bayFrameM, strap: strapM, jump: jumpM, glass: glassBayM, hazard: hazM, railY: railYM, dark: bayDarkM }), bay = bayB.group;
  const wings = buildWings(wingM);
  const canoes = new THREE.Mesh(merge(wings.canoes), wingM); canoes.castShadow = true;
  const stabs = buildStabs(stabM), fin = buildFin(finM), spons = buildSponsons(sponM);
  await yieldT();
  const gear = buildGear(tyreM, hubM, strutM, wellM);
  const engines = [-1, 1].map((s) => buildEngine(cowlM, nacM, darkM, spinM, bladeM, discM, sootM, s));
  const details = buildDetails(metalM, darkM, redM, greenM, whiteM, glassM, frameM, wings.shape);
  object.add(shell, lining, ramp.group, door, bay, wings.mesh, canoes, stabs, fin, spons, gear.wells, gear.nose, ...gear.main, details, ...engines.map((e) => e.eng));

  // ---- state
  const rampExit = new THREE.Vector3();
  // max ramp angle: the toe tips touch y = 0 with the gear down
  const toeEnd = ramp.exitLocal.clone();
  let rampMax = 0.5;
  for (let a = 0; a < 1.2; a += 0.002) { const y = RAMP_PIVOT.y + toeEnd.y * Math.cos(a) - toeEnd.z * Math.sin(a); if (y <= 0.03) { rampMax = a; break; } }
  let running = true, rampOpen = 0, gearDown = 1;
  const setRamp = (o: number) => {
    rampOpen = clamp01(o);
    ramp.group.rotation.x = rampOpen * rampMax;
    door.rotation.x = Math.min(1, rampOpen * 8) * 0.22;
    door.visible = rampOpen < 0.12;
    bay.visible = lining.visible = rampOpen > 0.001;
    rampExit.copy(ramp.exitLocal).applyAxisAngle(new THREE.Vector3(1, 0, 0), ramp.group.rotation.x).add(RAMP_PIVOT);
  };
  const setGear = (d: number) => {
    gearDown = clamp01(d);
    for (const g of gear.main) g.position.y = (1 - gearDown) * GEAR_TRAVEL;
    gear.nose.position.y = (1 - gearDown) * NOSE_TRAVEL;
  };
  const setEngines = (r: boolean) => { running = r; for (const e of engines) { e.disc.visible = r; e.blades.visible = !r; } };
  setRamp(0); setGear(1); setEngines(false);
  let spin = 0;
  const update = (dt: number, t: number) => {
    spin = running ? t * 31 : spin + dt * 0.0;
    for (const [i, e] of engines.entries()) e.prop.rotation.z = (i ? -1 : 1) * spin + i * 0.7;
    const blink = (Math.sin(t * 7) > 0.6 ? 1.1 : 0.25);
    redM.emissiveIntensity = blink;
  };
  void gearDown;
  shareGeometries("plane", object);
  // ---- the crew: seated, harnessed kongs along both walls
  const crew = opts.crew === false ? null : await buildCrew(ctx, object, bayB.seats, bay);
  const update2 = (dt: number, t: number) => { update(dt, t); crew?.pose(dt); };
  return { object, update: update2, setRamp, setGear, setEngines, rampExit };
}

// ============================================================================ cabin crew
/** seated kongs (the other riders): sit pose + harness straps conformed to each one's chest; posed in world space from
 *  the plane's matrix every update (gameplay moves the plane first), hidden whenever the plane / bay is hidden or the
 *  plane is not level (their root has yaw only) */
async function buildCrew(ctx: WorldCtx, object: THREE.Group, seats: BaySeat[], bay: THREE.Object3D) {
  const used = seats.filter((st) => st.z > -1.0);
  const members: Array<{ k: KongActorEx; local: THREE.Vector3; yaw: number }> = [];
  const straps: THREE.BufferGeometry[] = [], buckles: THREE.BufferGeometry[] = [];
  const probe = new KongAnimator(0);
  const tmp = new THREE.Vector3(), P = (x: number, y: number, z: number, m: THREE.Matrix4) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  // head yaw toward the FRONT of the plane (+) / the ramp (−), pitch, chest twist: the two nearest the seat camera grin at
  // it (target art: the big foreground kongs look at the camera), the rest look down the bay at the ramp or at each other
  const looksNear: Array<[number, number, number]> = [[0.62, -0.05, 0.12], [0.5, 0.02, 0.08]];
  const looksFar: Array<[number, number, number]> = [[-0.7, -0.1, -0.05], [-0.35, 0.05, 0], [-0.8, -0.05, -0.08], [0.2, 0.1, 0.05], [-0.6, -0.12, 0.04], [-0.9, 0, -0.05], [-0.15, -0.15, 0.1], [-0.7, 0.05, 0]];
  let i = 0;
  for (const st of used) {
    const yaw = st.side * Math.PI / 2;
    const base: KongPose = { x: 0, y: FLOOR_Y, z: st.z, yaw, pitch: 0, vx: 0, vz: 0, vy: 0, state: "idle", crouch: false, sprint: false, weapon: null, team: 0, friendly: true };
    probe.showPose = "sit"; probe.overlay = null;
    probe.update(base, 0);
    // the pack's back against the seat back, the pelvis on the pan
    const chest = probe.bone("chest"), hips = probe.bone("hips");
    const pb = P(0, 0.03, 0.47, chest), hy = tmp.setFromMatrixPosition(hips).y;
    const local = new THREE.Vector3(st.backX - pb.x, st.seatY + 0.22 - (hy - FLOOR_Y), st.z);
    base.x = local.x; base.y = local.y;
    probe.update(base, 0);
    // harness (3D webbing, 7 × 1.6 cm, routed OUTSIDE the fur: over the trapezius beside the head, down the
    // pecs to a chest buckle, + a lap belt) — flat cards cut through muzzles and eyes
    const cm = probe.bone("chest"), hm = probe.bone("hips");
    for (const sx of [-1, 1]) {
      // (the Blender kong's trapezius tops out at ≈ chest + 0.42: a route at + 0.55 hung in the air as black hoops)
      const ctrl = [P(sx * 0.2, 0.28, 0.4, cm), P(sx * 0.25, 0.38, 0.26, cm), P(sx * 0.27, 0.43, 0.06, cm), P(sx * 0.27, 0.36, -0.17, cm), P(sx * 0.22, 0.2, -0.33, cm), P(sx * 0.1, 0.02, -0.36, cm), P(sx * 0.03, -0.06, -0.35, cm)];
      straps.push(strap3d(ctrl, P(0, 0.15, 0.02, cm), 0.07, 0.016));
    }
    straps.push(strap3d([P(-0.4, 0.04, 0.02, hm), P(-0.34, 0.08, -0.26, hm), P(0, 0.11, -0.4, hm), P(0.34, 0.08, -0.26, hm), P(0.4, 0.04, 0.02, hm)], P(0, 0.05, 0, hm), 0.065, 0.016));
    for (const [bx, by, bz, m] of [[0, -0.05, -0.395, cm], [0, 0.11, -0.415, hm]] as const) { const b = rbox(0.12, 0.085, 0.035, 0.012); b.applyMatrix4(new THREE.Matrix4().extractRotation(m)); const c = P(bx, by, bz, m); b.translate(c.x, c.y, c.z); buckles.push(b); }
    const k = await createKong(ctx, { variant: 20 + i * 3 });
    k.animator.showPose = "sit";
    const near = st.z < 0.5;
    const [hy2, hp, cy] = near ? looksNear[st.side > 0 ? 0 : 1] : looksFar[i % looksFar.length];
    // (+yaw turns the head to the kong's left; the front of the plane is on a port kong's left, a starboard kong's right)
    k.animator.overlay = (add) => { add.R("head", hp, hy2 * (st.side > 0 ? -1 : 1)); add.R("chest", 0, cy * 0.5 * (st.side > 0 ? -1 : 1)); };
    k.setLodBias(0.6);
    k.setLook({ fill: "#564c3a" });
    k.setVisible(false);
    members.push({ k, local, yaw });
    i++;
  }
  const strapM = new THREE.MeshStandardMaterial({ color: "#3a332c", roughness: 0.74 });
  const buckleM = new THREE.MeshStandardMaterial({ color: "#b8bcc0", metalness: 0.85, roughness: 0.3 });
  const harness = new THREE.Group(); harness.name = "bay-harness";
  harness.add(new THREE.Mesh(merge(straps), strapM), new THREE.Mesh(merge(buckles), buckleM));
  bay.add(harness);
  const up = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler();
  let shown = false;
  const visible = () => { if (!bay.visible) return false; let o: THREE.Object3D | null = object; while (o) { if (!o.visible) return false; o = o.parent; } return !!object.parent; };
  const pose = (dt: number) => {
    object.updateMatrixWorld(true);
    q.setFromRotationMatrix(object.matrixWorld); up.set(0, 1, 0).applyQuaternion(q);
    const on = visible() && up.y > 0.9994;
    if (on !== shown) { shown = on; for (const m of members) m.k.setVisible(on); }
    if (!on) return;
    e.setFromQuaternion(q, "YXZ");
    for (const m of members) {
      const w = m.local.clone().applyMatrix4(object.matrixWorld);
      m.k.apply({ x: w.x, y: w.y, z: w.z, yaw: e.y + m.yaw, pitch: 0, vx: 0, vz: 0, vy: 0, state: "idle", crouch: false, sprint: false, weapon: null, team: 0, friendly: true }, dt);
    }
  };
  // hide them the frame the plane / bay goes away (gameplay stops calling update() once the plane is hidden)
  ctx.onUpdate(() => { if (shown && !visible()) { shown = false; for (const m of members) m.k.setVisible(false); } });
  return { pose };
}
/** a 3D webbing strap (rounded rectangle w × t) along a curve, its broad face turned away from `centre` */
function strap3d(ctrl: THREE.Vector3[], centre: THREE.Vector3, w: number, t: number) {
  const curve = new THREE.CatmullRomCurve3(ctrl, false, "centripetal");
  const n = 40, ring = 12, pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, c = curve.getPoint(u), tg = curve.getTangent(u), out = c.clone().sub(centre); out.addScaledVector(tg, -out.dot(tg)).normalize();
    const side = new THREE.Vector3().crossVectors(tg, out).normalize();
    for (let j = 0; j < ring; j++) {
      const a = (j / ring) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      // superellipse (flat faces, rounded edges)
      const x = Math.sign(ca) * Math.pow(Math.abs(ca), 0.35) * w / 2, y = Math.sign(sa) * Math.pow(Math.abs(sa), 0.35) * t / 2;
      const p = c.clone().addScaledVector(side, x).addScaledVector(out, y + t / 2 + 0.004);
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < ring; j++) { const a = i * ring + j, b = i * ring + (j + 1) % ring, c = a + ring, d = b + ring; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const ng = g.toNonIndexed(); ng.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
  return ng;
}

// ============================================================================ staging + shot cameras
// In flight (drop-01): low over the turquoise water just off the south coast, flying north-west toward Ripe Peak.
// The camera offset/target (plane-yaw frame), fov and plane pitch/bank were solved by fitting 10 landmarks of
// the drop-01 target art (fin top, stab tips, nose, wingtips, spinners, ramp end, wheels) with a horizon-at-mid-frame constraint.
// The plane yaw is then derived so Ripe Peak sits ~7° right of the view axis as in the target art.
const PEAK = new THREE.Vector3(-380, 201, -430);
// Offshore SW of LOOKOUT POINT looking NNE along the green west coast —
// open sea + islets left, the coast, beach + reef below-right, the red/white lighthouse on its cliff at the right edge,
// Ripe Peak small and hazy behind the nose
const DROP_CAM = new THREE.Vector3(-860, 140, 660);
/** the whole camera + plane rig is pitched about the camera (the fitted plane framing is kept): tilted up 3° (sign:
 *  + = camera up), so open turquoise-blue sea sits under the plane and the wreck below the frame */
const RIG_TILT = THREE.MathUtils.degToRad(3);
// the camera sits ~4 m BELOW the wing plane, 3/4 behind-right, looking up — both prop discs show under the
// nacelles, the belly + sponson bogies read, the fin towers top-left (target art). Fitted to 8 target-art landmarks + the horizon
// (fit loss 0.067, camera 4.0 m under the pitched wing plane, horizon at 52 %).
// From there the camera sits higher (≈ 2.5 m over the wing plane) and further abeam (≈ 30° off the tail) so BOTH prop
// discs read beside the nacelles; the rig is turned 0.15 rad further so the coast + beach + reef sit right and Ripe
// Peak's lava cone leaves the frame
const DROP_CAM_L = new THREE.Vector3(18, 9, 32), DROP_TGT_L = new THREE.Vector3(4, 3.5, 2), DROP_FOV = 36;
const FLIGHT = (() => {
  const yawOf = (dx: number, dz: number) => Math.atan2(-dx, -dz);
  const camYawL = yawOf(DROP_TGT_L.x - DROP_CAM_L.x, DROP_TGT_L.z - DROP_CAM_L.z);
  const peakYaw = yawOf(PEAK.x - DROP_CAM.x, PEAK.z - DROP_CAM.z);
  const yaw = peakYaw + 0.61 - camYawL;   // turned left of Ripe Peak — sea + reef under the plane, the coast right (target art)
  const pos = DROP_CAM.clone().sub(DROP_CAM_L.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
  return { pos, yaw, pitch: -0.12, bank: 0.01 };
})();
const PARK = { pos: new THREE.Vector3(0, 2.5, 1020), yaw: 0.55 };
/** drop-02 (cabin): at the match altitude off the south coast flying south, so the open ramp looks back at the island;
 *  the camera is gameplay's seat camera (render.ts planeCamera: plane-local 0.55, floor + 1.5, −6.2, pitch −0.18) */
// from the seat the open ramp shows down to ≈ −12°, so the
// plane flies LOW (250 m) ≈ 1.2 km off the south coast heading south — the whole island fills the ramp opening
const CABIN = { pos: new THREE.Vector3(80, 250, 2200), yaw: Math.PI + 0.12 };
const cabinM = new THREE.Matrix4().compose(CABIN.pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, CABIN.yaw, 0, "YXZ")), new THREE.Vector3(1, 1, 1));
const flightM0 = new THREE.Matrix4().compose(FLIGHT.pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, FLIGHT.yaw, 0, "YXZ")), new THREE.Vector3(1, 1, 1));
const flightFull0 = new THREE.Matrix4().compose(FLIGHT.pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(FLIGHT.pitch, FLIGHT.yaw, FLIGHT.bank, "YXZ")), new THREE.Vector3(1, 1, 1));
const tiltM = (() => {
  const flat = new THREE.Matrix4().compose(FLIGHT.pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, FLIGHT.yaw, 0, "YXZ")), new THREE.Vector3(1, 1, 1));
  const c = DROP_CAM_L.clone().applyMatrix4(flat), t = DROP_TGT_L.clone().applyMatrix4(flat);
  const right = new THREE.Vector3().subVectors(t, c).cross(new THREE.Vector3(0, 1, 0)).normalize();
  return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationAxis(right, RIG_TILT)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
})();
const flightFullM = tiltM.clone().multiply(flightFull0);
const flightM = tiltM.clone().multiply(flightM0);
const parkM = new THREE.Matrix4().compose(PARK.pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, PARK.yaw, 0, "YXZ")), new THREE.Vector3(1, 1, 1));
const W = (m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] => { const v = new THREE.Vector3(x, y, z).applyMatrix4(m); return [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]; };
const cam = (m: THREE.Matrix4, p: [number, number, number], t: [number, number, number], fov: number, stage: string, note?: string): CamSpec => ({ pos: W(m, ...p), target: W(m, ...t), fov, stage, note });

export const views: Record<string, CamSpec> = {
  "drop-01-plane-exterior": cam(flightM, DROP_CAM_L.toArray(), DROP_TGT_L.toArray(), DROP_FOV, "plane", "plane in flight, 3/4 from behind-right; island + Ripe Peak behind"),
  "wip-plane-flight-ramp": cam(flightFullM, [7, -2.5, 24], [0, 2.5, 8], 40, "plane"),
  "wip-plane-flight-engine": cam(flightFullM, [14, 3, -16], [ENG_X, ENG_Y, ENG_Z], 38, "plane"),
  "wip-plane-flight-tail": cam(flightFullM, [9, 6, 26], [0, 8, 12], 40, "plane"),
  // the camera stands in the aisle 5 m short of the ramp hinge, low, looking aft
  // through the big lit open ramp at the island (target art), three harnessed kongs down each wall in frame
  "drop-02-plane-interior": cam(cabinM, [-0.25, FLOOR_Y + 1.12, -2.3], [0.15, FLOOR_Y + 0.55, 10.5], 72, "plane-cabin", "cargo bay looking aft through the open ramp"),
  "wip-plane-cabin-wide": cam(cabinM, [0, FLOOR_Y + 1.6, -8.4], [0, FLOOR_Y + 0.9, 4], 80, "plane-cabin"),
  "wip-plane-cabin-side": cam(cabinM, [1.2, FLOOR_Y + 1.3, -1.0], [-1.6, FLOOR_Y + 0.9, -3.6], 60, "plane-cabin"),
  "wip-plane-front": cam(parkM, [-14, 4.5, -30], [0, 4, -2], 45, "wip-plane"),
  "wip-plane-side": cam(parkM, [36, 4.5, 0], [0, 4.2, 0], 50, "wip-plane"),
  "wip-plane-rear-ramp": cam(parkM, [5, 4, 30], [0, 3, 6], 45, "wip-plane"),
  "wip-plane-tail": cam(parkM, [12, 8, 22], [0, 8, 11.5], 42, "wip-plane"),
  "wip-plane-parked": cam(parkM, [-26, 7, 22], [0, 3.5, 0], 50, "wip-plane"),
  "wip-plane-nose": cam(parkM, [7, 4.6, -20], [0, 4, -12], 38, "wip-plane"),
};

const staged = new Map<string, PlaneProps>();
export async function stage(ctx: WorldCtx, id: string): Promise<void> {
  if (id !== "plane" && id !== "wip-plane" && id !== "plane-cabin") return;
  if (staged.has(id)) return;
  const p = await createPlane(ctx);
  staged.set(id, p);
  if (id === "plane") {
    flightFullM.decompose(p.object.position, p.object.quaternion, p.object.scale);
    // stills show blurred prop DISCS too (the target art's props read as motion blur, not stopped blades)
    p.setGear(0); p.setRamp(0.6); p.setEngines(true);
  } else if (id === "plane-cabin") {
    cabinM.decompose(p.object.position, p.object.quaternion, p.object.scale);
    p.setGear(0); p.setRamp(1); p.setEngines(true);
    // the target art's cargo door is the whole rear section (ramp down, upper door up): clip the tail-cone skin + lining aft
    // of the portal frame so the camera sees sky + island through a big lit opening
    ctx.renderer.localClippingEnabled = true;
    p.object.updateMatrixWorld(true);
    const n = new THREE.Vector3(0, 0, -1).transformDirection(p.object.matrixWorld), o = new THREE.Vector3(0, 0, Z_UP + 0.35).applyMatrix4(p.object.matrixWorld);
    const clip = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
    p.object.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh || (m.name !== "fuselage" && m.name !== "cargo-lining" && m.name !== "bay-frames")) return;
      const mm = (m.material as THREE.Material).clone();          // the ramp shares the paint: clip a private copy
      mm.clippingPlanes = [clip]; mm.clipShadows = false;
      m.material = mm;
    });
  } else {
    p.object.position.copy(PARK.pos);
    p.object.rotation.set(0, PARK.yaw, 0, "YXZ");
    p.setGear(1); p.setRamp(1); p.setEngines(false);
  }
  ctx.scene.add(p.object);
  p.update(0, 12);
  ctx.onUpdate((dt, t) => p.update(dt, t));
}
