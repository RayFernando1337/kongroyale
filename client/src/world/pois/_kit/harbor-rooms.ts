// poi-harbor — draws the shared building PIECES (shared/pois/harbor-kit.ts: walls with openings, floors, stairs,
// rails, furniture) as dressed, painted geometry. The colliders are the SAME boxes (pieceBox), so every wall, tread and
// desk you see is exactly what you collide with. Dressing never grows a piece's silhouette by more than a few cm.
//   const rm = roomMats(mats, { indoor: true });  drawPieces(builder, pieces, rm);
import * as THREE from "three";
import type { Piece, PieceMat } from "../../../../../shared/pois/harbor-kit";
import { Builder, hash, type V3 } from "./harbor-geo";
import { harborTex, paint, tileMetres, weather, type HarborMats } from "./harbor-materials";
import { canvas, tex } from "./harbor-paint";

// ------------------------------------------------------------------------------------------------ indoor lighting
const indoorCache = new Map<string, THREE.Material>();
/** an "indoor" twin of a material: same maps, sky light (IBL) scaled by `ibl`, a warm tint (rooms read lit by lamps
 *  and the windows, not by the open sky) */
export function indoorMat(m: THREE.Material, ibl = 0.3, tint = "#fff0dc"): THREE.Material {
  const key = `${m.uuid}|${ibl}|${tint}`;
  const hit = indoorCache.get(key);
  if (hit) return hit;
  const src = m as THREE.MeshStandardMaterial;
  if (!src.isMeshStandardMaterial || (src.emissive && src.emissiveIntensity > 0.01 && src.emissive.getHex() !== 0)) { indoorCache.set(key, m); return m; }
  const c = src.clone();
  c.name = `${src.name}-in`;
  c.color = src.color.clone().multiply(new THREE.Color(tint));
  const prev = src.onBeforeCompile;
  c.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_maps>", `#include <lights_fragment_maps>
      iblIrradiance *= ${ibl.toFixed(3)}; radiance *= ${(ibl * 0.8).toFixed(3)};`);
  };
  const key0 = src.customProgramCacheKey.bind(src);
  c.customProgramCacheKey = () => key0() + `|in${ibl}`;
  indoorCache.set(key, c);
  return c;
}

// ------------------------------------------------------------------------------------------------ painted materials
// (painted as harbor-materials TEX_GROUPS room*, off the main thread when harborMatsAsync() ran first)
let plasterM: THREE.MeshStandardMaterial | null = null, dadoM: THREE.MeshStandardMaterial | null = null, vinylM: THREE.MeshStandardMaterial | null = null;
let ceilM: THREE.MeshStandardMaterial | null = null, grateM: THREE.MeshStandardMaterial | null = null, plateM: THREE.MeshStandardMaterial | null = null;
/** cream plaster: mottled, hairline cracks, scuffs and grime toward the floor (3 m tile) */
function plaster(): THREE.MeshStandardMaterial {
  if (plasterM) return plasterM;
  plasterM = new THREE.MeshStandardMaterial({ map: harborTex("roomPlaster", { aniso: 8 }), roughness: 0.88, metalness: 0, name: "room-plaster" });
  tileMetres(plasterM, 3);
  return plasterM;
}
/** the lower wall band: gloss teal-grey paint with chips (office / crew corridors) */
function dado(): THREE.MeshStandardMaterial {
  if (dadoM) return dadoM;
  dadoM = new THREE.MeshStandardMaterial({ map: harborTex("roomDado", { aniso: 8 }), roughness: 0.42, metalness: 0.05, name: "room-dado" });
  tileMetres(dadoM, 2);
  return dadoM;
}
/** vinyl floor tiles (0.5 m, two warm greys, scuffed traffic path) */
function vinyl(): THREE.MeshStandardMaterial {
  if (vinylM) return vinylM;
  vinylM = new THREE.MeshStandardMaterial({ map: harborTex("roomVinyl", { aniso: 8 }), roughness: 0.55, metalness: 0, name: "room-vinyl" });
  tileMetres(vinylM, 2);
  return vinylM;
}
/** suspended ceiling tiles (0.6 m grid, a few stained / missing) */
function ceiling(): THREE.MeshStandardMaterial {
  if (ceilM) return ceilM;
  ceilM = new THREE.MeshStandardMaterial({ map: harborTex("roomCeiling", { aniso: 4 }), roughness: 0.9, metalness: 0, name: "room-ceiling" });
  tileMetres(ceilM, 3);
  return ceilM;
}
/** steel bar grating (30 mm bars, cross rods) with a height-derived normal map */
function grating(): THREE.MeshStandardMaterial {
  if (grateM) return grateM;
  grateM = new THREE.MeshStandardMaterial({ map: harborTex("roomGrating.color", { aniso: 8 }), normalMap: harborTex("roomGrating.normal", { srgb: false }), roughness: 0.6, metalness: 0.55, name: "room-grating" });
  tileMetres(grateM, 0.8);
  return grateM;
}
/** diamond checker plate (tread nosings, machinery floors, ship decks inside) */
function checker(): THREE.MeshStandardMaterial {
  if (plateM) return plateM;
  plateM = new THREE.MeshStandardMaterial({ map: harborTex("roomChecker.color", { aniso: 8 }), normalMap: harborTex("roomChecker.normal", { srgb: false }), roughness: 0.45, metalness: 0.6, name: "room-checker" });
  tileMetres(plateM, 0.6);
  return plateM;
}

// ---- derelict variants (the wreck's rooms): the same finishes after years of salt, rain and rust
let dPlaster: THREE.MeshStandardMaterial | null = null, dVinyl: THREE.MeshStandardMaterial | null = null, dDado: THREE.MeshStandardMaterial | null = null;
function derelict(src: () => THREE.MeshStandardMaterial, texName: string, name: string): THREE.MeshStandardMaterial {
  const base = src(), m = base.clone();
  m.map = harborTex(texName, { aniso: 8 }); m.map.repeat.copy(base.map!.repeat); m.roughness = Math.min(1, base.roughness + 0.1); m.name = name;
  return m;
}
const plasterD = () => (dPlaster ??= derelict(plaster, "roomPlasterD", "room-plaster-d"));
const vinylD = () => (dVinyl ??= derelict(vinyl, "roomVinylD", "room-vinyl-d"));
const dadoD = () => (dDado ??= derelict(dado, "roomDadoD", "room-dado-d"));

export type RoomMats = Record<PieceMat, THREE.Material> & { dado: THREE.Material; lamp: THREE.Material; screen: THREE.Material; paper: THREE.Material; dark: THREE.Material; checker: THREE.Material; glow: THREE.Material };
const roomCache = new Map<string, RoomMats>();
/** the paint set for pieces; `indoor` = inside a roofed building (sky light scaled down) */
export function roomMats(m: HarborMats, o: { indoor?: boolean; ibl?: number; steel?: string; derelict?: boolean } = {}): RoomMats {
  const key = `${o.indoor ? 1 : 0}|${o.ibl ?? 0.3}|${o.steel ?? ""}|${o.derelict ? 1 : 0}`;
  const hit = roomCache.get(key);
  if (hit) return hit;
  const I = (x: THREE.Material) => (o.indoor ? indoorMat(x, o.ibl ?? 0.3) : x);
  const steel = paint(o.steel ?? "#e8b21c", { rough: 0.5, grime: 0.4, name: "stair-yellow" });
  const rm: RoomMats = {
    wall: I(m.wallWhite), wallIn: I(plaster()), floor: I(vinyl()), ceiling: I(ceiling()), concrete: I(m.concrete),
    steel: I(steel), grate: I(grating()), yellow: I(m.yellowPaint), trim: I(m.bluePaint), wood: I(m.wood), rail: I(m.galv),
    desk: I(m.plywood), cabinet: I(paint("#8b9196", { rough: 0.45, grime: 0.2, name: "room-cabinet" })), locker: I(paint("#46698a", { rough: 0.45, grime: 0.25, name: "room-locker" })),
    machine: I(paint("#3f6a4c", { rough: 0.5, grime: 0.45, name: "room-machine" })), crate: I(m.wood), pipe: I(m.redPaint), glass: m.glass,
    rust: I(m.rust), deckPlate: I(checker()), hull: I(m.whitePaint),
    dado: I(dado()), lamp: m.lampLens, screen: screenMat(), paper: I(paint("#efe9dc", { rough: 0.9, grime: 0.05, name: "room-paper" })), dark: I(m.darkPaint), checker: I(checker()),
    glow: glowMat(),
  };
  if (o.derelict) {
    rm.wallIn = I(plasterD()); rm.floor = I(vinylD()); rm.dado = I(dadoD()); rm.ceiling = I(plasterD());
    rm.steel = I(paint(o.steel ?? "#8a5a36", { rough: 0.8, grime: 0.7, name: "room-steel-d" })); rm.grate = I(m.rust);
    rm.cabinet = I(paint("#6f7478", { rough: 0.75, grime: 0.8, name: "room-cabinet-d" })); rm.locker = I(paint("#3d5670", { rough: 0.75, grime: 0.8, name: "room-locker-d" }));
  }
  roomCache.set(key, rm);
  return rm;
}
let scr: THREE.MeshStandardMaterial | null = null;
const screenMat = () => (scr ??= new THREE.MeshStandardMaterial({ color: "#0c1a22", emissive: new THREE.Color("#5fb8d8"), emissiveIntensity: 0.9, roughness: 0.2, name: "room-screen" }));
let glw: THREE.MeshBasicMaterial | null = null;
/** additive warm light pool under ceiling lamps */
function glowMat(): THREE.MeshBasicMaterial {
  if (glw) return glw;
  const [el, c] = canvas(128, 128);
  const g = c.createRadialGradient(64, 64, 2, 64, 64, 62);
  g.addColorStop(0, "rgba(255,214,160,0.8)"); g.addColorStop(0.5, "rgba(255,196,130,0.3)"); g.addColorStop(1, "rgba(255,180,110,0)");
  c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  glw = new THREE.MeshBasicMaterial({ map: tex(el, { repeat: false }), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, name: "room-glow" });
  return glw;
}

// ------------------------------------------------------------------------------------------------ drawing
/** a box whose UVs follow the builder frame's metres (textures line up across neighbouring pieces) */
function wbox(b: Builder, mat: THREE.Material, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, bevel = 0) {
  const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
  if (sx < 0.004 || sy < 0.004 || sz < 0.004) return;
  if (bevel > 0 && Math.min(sx, sy, sz) > bevel * 3) { b.box(mat, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [sx, sy, sz], { bevel }); return; }
  const g = new THREE.BoxGeometry(sx, sy, sz).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  g.userData.coBox = true;   // the builder's coplanar resolver takes it (its own bounds)
  b.add(mat, g);
}
const lo = (p: Piece, i: number) => p.c[i] - p.h[i], hi = (p: Piece, i: number) => p.c[i] + p.h[i];

/**
 * Draw pieces into a builder (coordinates = the builder's frame). `fx` (optional) takes the additive light pools.
 * Walls get a painted dado + skirting on their lower 1.1 m, floors a skin of their finish over a ceiling underside,
 * treads grating + a yellow nosing, rails posts + two bars, furniture its dressing (all inside the collider box).
 */
export function drawPieces(b: Builder, pieces: Piece[], rm: RoomMats, fx?: Builder, o: { floorMat?: PieceMat; wallBand?: boolean } = {}) {
  for (const p of pieces) {
    const x0 = lo(p, 0), x1 = hi(p, 0), y0 = lo(p, 1), y1 = hi(p, 1), z0 = lo(p, 2), z1 = hi(p, 2);
    const cx = p.c[0], cz = p.c[2], alongX = p.h[0] >= p.h[2];
    const M = rm[p.mat];
    switch (p.kind) {
      case "tread": {
        const body = y1 - y0 > 0.3;
        if (body) wbox(b, rm.steel, x0 + 0.01, y0, z0 + 0.01, x1 - 0.01, y1 - 0.05, z1 - 0.01);
        else wbox(b, rm.steel, x0, y1 - 0.12, z0, x1, y1 - 0.05, z1);
        wbox(b, rm.grate, x0, y1 - 0.05, z0, x1, y1, z1);
        break;
      }
      case "landing": {
        wbox(b, rm.steel, x0, y0, z0, x1, y1 - 0.06, z1);
        wbox(b, rm.grate, x0 + 0.03, y1 - 0.06, z0 + 0.03, x1 - 0.03, y1, z1 - 0.03);
        break;
      }
      case "stringer": case "post": wbox(b, rm.steel, x0, y0, z0, x1, y1, z1); break;
      case "flight": {
        // two channel stringers along the pitch line (under the tread ends) + a handrail 0.95 m above the nosings on
        // both sides, posts every ~1.2 m
        const [ux, uz] = p.up ?? [1, 0], ax = Math.abs(ux) > 0.5;
        const lowA = ax ? (ux > 0 ? x0 : x1) : (uz > 0 ? z0 : z1), highA = ax ? (ux > 0 ? x1 : x0) : (uz > 0 ? z1 : z0);
        const sides = ax ? [z0 + 0.03, z1 - 0.03] : [x0 + 0.03, x1 - 0.03];
        const P = (a: number, y: number, s: number): V3 => (ax ? [a, y, s] : [s, y, a]);
        for (const sd of sides) {
          b.beam(rm.steel, P(lowA, y0 - 0.12, sd), P(highA, y1 - 0.12, sd), 0.06, 0.26);
          const hy = 0.95, n = Math.max(2, Math.round(Math.abs(highA - lowA) / 1.2));
          b.cyl(rm.rail, P(lowA, y0 + hy, sd), P(highA, y1 + hy, sd), 0.028, 6);
          for (let k = 0; k <= n; k++) { const t = k / n, a = lowA + (highA - lowA) * t, yy = y0 + (y1 - y0) * t; b.cyl(rm.rail, P(a, yy, sd), P(a, yy + hy, sd), 0.022, 5, { caps: false }); }
        }
        break;
      }
      case "rail": {
        const L = alongX ? x1 - x0 : z1 - z0, n = Math.max(1, Math.round(L / 1.3));
        for (let k = 0; k <= n; k++) {
          const t = k / n, px = alongX ? x0 + (x1 - x0) * t : cx, pz = alongX ? cz : z0 + (z1 - z0) * t;
          b.cyl(rm.rail, [px, y0, pz], [px, y1, pz], 0.028, 6, { caps: false });
        }
        for (const yy of [y1 - 0.02, y0 + 0.52]) b.cyl(rm.rail, [alongX ? x0 : cx, yy, alongX ? cz : z0], [alongX ? x1 : cx, yy, alongX ? cz : z1], 0.026, 6);
        wbox(b, rm.steel, alongX ? x0 : cx - 0.02, y0, alongX ? cz - 0.02 : z0, alongX ? x1 : cx + 0.02, y0 + 0.1, alongX ? cz + 0.02 : z1);
        break;
      }
      case "door": case "window": {
        // frame (inside the opening's box): jambs + head (+ sill and a mullion for windows)
        const f = 0.07, T = alongX ? [z0 - 0.02, z1 + 0.02] : [x0 - 0.02, x1 + 0.02];
        const put = (a0: number, a1: number, q0: number, q1: number) => (alongX ? wbox(b, rm.trim, a0, q0, T[0], a1, q1, T[1]) : wbox(b, rm.trim, T[0], q0, a0, T[1], q1, a1));
        const A0 = alongX ? x0 : z0, A1 = alongX ? x1 : z1;
        put(A0, A0 + f, y0, y1); put(A1 - f, A1, y0, y1); put(A0, A1, y1 - f, y1);
        if (p.kind === "window") {
          // (no mullion — the pane is breakable glass, and a bar left standing in a smashed window
          // reads as something you could not vault through)
          put(A0, A1, y0, y0 + f);
          // a thin tinted pane in the middle of the wall, where its 10 cm breakable collider sits (harbor-kit wallRun)
          const mid = alongX ? cz : cx;
          if (alongX) wbox(b, rm.glass, A0 + f, y0 + f, mid - 0.006, A1 - f, y1 - f, mid + 0.006); else wbox(b, rm.glass, mid - 0.006, y0 + f, A0 + f, mid + 0.006, y1 - f, A1 - f);
        }
        break;
      }
      case "desk": case "table": {
        wbox(b, rm.desk, x0, y1 - 0.04, z0, x1, y1, z1, 0.01);
        for (const [lx, lz] of [[x0 + 0.05, z0 + 0.05], [x1 - 0.05, z0 + 0.05], [x0 + 0.05, z1 - 0.05], [x1 - 0.05, z1 - 0.05]]) wbox(b, rm.cabinet, lx - 0.03, y0, lz - 0.03, lx + 0.03, y1 - 0.04, lz + 0.03);
        // modesty panel + a drawer pedestal (the collider box is solid: the space under the top is filled visually too)
        if (alongX) { wbox(b, rm.cabinet, x0 + 0.05, y0 + 0.02, cz - 0.02, x1 - 0.05, y1 - 0.06, cz + 0.02); wbox(b, rm.cabinet, x1 - 0.5, y0, z0 + 0.06, x1 - 0.06, y1 - 0.05, z1 - 0.06); }
        else { wbox(b, rm.cabinet, cx - 0.02, y0 + 0.02, z0 + 0.05, cx + 0.02, y1 - 0.06, z1 - 0.05); wbox(b, rm.cabinet, x0 + 0.06, y0, z1 - 0.5, x1 - 0.06, y1 - 0.05, z1 - 0.06); }
        if (p.kind === "desk") {
          // monitor, keyboard, paper stacks, a mug
          const h = hash(cx, cz);
          wbox(b, rm.dark, cx - 0.22, y1, cz - 0.1, cx + 0.22, y1 + 0.03, cz + 0.1);
          if (alongX) { wbox(b, rm.dark, cx - 0.25, y1 + 0.05, cz + (h < 0.5 ? 0.15 : -0.2), cx + 0.25, y1 + 0.38, cz + (h < 0.5 ? 0.19 : -0.16)); wbox(b, rm.screen, cx - 0.22, y1 + 0.08, cz + (h < 0.5 ? 0.145 : -0.155), cx + 0.22, y1 + 0.35, cz + (h < 0.5 ? 0.15 : -0.15)); }
          else { wbox(b, rm.dark, cx + (h < 0.5 ? 0.15 : -0.2), y1 + 0.05, cz - 0.25, cx + (h < 0.5 ? 0.19 : -0.16), y1 + 0.38, cz + 0.25); wbox(b, rm.screen, cx + (h < 0.5 ? 0.145 : -0.155), y1 + 0.08, cz - 0.22, cx + (h < 0.5 ? 0.15 : -0.15), y1 + 0.35, cz + 0.22); }
          wbox(b, rm.paper, x0 + 0.1, y1, z0 + 0.1, x0 + 0.4, y1 + 0.06 + h * 0.08, z0 + 0.32);
          b.cyl(rm.trim, [x1 - 0.2, y1, z1 - 0.2], [x1 - 0.2, y1 + 0.1, z1 - 0.2], 0.04, 8);
        }
        break;
      }
      case "locker": case "cabinet": {
        wbox(b, M, x0, y0, z0, x1, y1, z1, 0.015);
        const n = p.kind === "locker" ? Math.max(1, Math.round((alongX ? x1 - x0 : z1 - z0) / 0.45)) : 1;
        const face = alongX ? (p.c[2] < 0 ? z1 : z0) : (p.c[0] < 0 ? x1 : x0), sgn = alongX ? (p.c[2] < 0 ? 1 : -1) : (p.c[0] < 0 ? 1 : -1);
        for (let k = 0; k < n; k++) {
          const a0 = (alongX ? x0 : z0) + ((alongX ? x1 - x0 : z1 - z0) * k) / n, a1 = (alongX ? x0 : z0) + ((alongX ? x1 - x0 : z1 - z0) * (k + 1)) / n;
          const rows = p.kind === "locker" ? [[y0 + 0.1, y1 - 0.05]] : [...Array(Math.max(2, Math.round((y1 - y0) / 0.33)))].map((_, i, arr) => [y0 + 0.04 + ((y1 - y0 - 0.08) * i) / arr.length, y0 + 0.04 + ((y1 - y0 - 0.08) * (i + 1)) / arr.length]);
          for (const [q0, q1] of rows) {
            // door / drawer outline (dark seam) + handle
            if (alongX) { wbox(b, rm.dark, a0 + 0.01, q0, face - 0.005, a0 + 0.025, q1, face + sgn * 0.01); wbox(b, rm.rail, (a0 + a1) / 2 - 0.08, (q0 + q1) / 2 + (p.kind === "locker" ? 0.2 : 0.06), face, (a0 + a1) / 2 + 0.08, (q0 + q1) / 2 + (p.kind === "locker" ? 0.22 : 0.08), face + sgn * 0.03); }
            else { wbox(b, rm.dark, face - 0.005, q0, a0 + 0.01, face + sgn * 0.01, q1, a0 + 0.025); wbox(b, rm.rail, face, (q0 + q1) / 2 + (p.kind === "locker" ? 0.2 : 0.06), (a0 + a1) / 2 - 0.08, face + sgn * 0.03, (q0 + q1) / 2 + (p.kind === "locker" ? 0.22 : 0.08), (a0 + a1) / 2 + 0.08); }
            if (p.kind === "locker") for (let v = 0; v < 3; v++) { const vy = q1 - 0.2 - v * 0.05; if (alongX) wbox(b, rm.dark, a0 + 0.1, vy, face, a1 - 0.1, vy + 0.02, face + sgn * 0.008); else wbox(b, rm.dark, face, vy, a0 + 0.1, face + sgn * 0.008, vy + 0.02, a1 - 0.1); }
          }
        }
        break;
      }
      case "console": {
        wbox(b, rm.dark, x0, y0, z0, x1, y1 - 0.12, z1, 0.02);
        wbox(b, rm.cabinet, x0, y1 - 0.12, z0, x1, y1, z1, 0.02);
        const n = Math.max(1, Math.round((alongX ? x1 - x0 : z1 - z0) / 0.6));
        for (let k = 0; k < n; k++) {
          const t0 = (k + 0.15) / n, t1 = (k + 0.85) / n;
          if (alongX) wbox(b, rm.screen, x0 + (x1 - x0) * t0, y1, cz - 0.15, x0 + (x1 - x0) * t1, y1 + 0.01, cz + 0.15);
          else wbox(b, rm.screen, cx - 0.15, y1, z0 + (z1 - z0) * t0, cx + 0.15, y1 + 0.01, z0 + (z1 - z0) * t1);
        }
        for (let k = 0; k < 6; k++) { const h = hash(cx, cz, k); const px = x0 + 0.1 + h * (x1 - x0 - 0.2), pz = z0 + 0.1 + hash(k, cz) * (z1 - z0 - 0.2); wbox(b, h < 0.5 ? rm.pipe : rm.yellow, px - 0.03, y1, pz - 0.03, px + 0.03, y1 + 0.04, pz + 0.03); }
        break;
      }
      case "machine": {
        wbox(b, M, x0 + 0.05, y0, z0 + 0.05, x1 - 0.05, y1 - 0.05, z1 - 0.05, 0.04);
        wbox(b, rm.dark, x0, y0, z0, x1, y0 + 0.12, z1);
        // motor + drum along the long axis, flange rings, a gauge panel
        const L = alongX ? x1 - x0 : z1 - z0, r = Math.min(p.h[1], alongX ? p.h[2] : p.h[0]) * 0.7;
        const a: V3 = alongX ? [x0 + 0.02, y1 - r - 0.05, cz] : [cx, y1 - r - 0.05, z0 + 0.02], c: V3 = alongX ? [x1 - 0.02, y1 - r - 0.05, cz] : [cx, y1 - r - 0.05, z1 - 0.02];
        b.cyl(rm.dark, a, c, r * 0.35, 12);
        for (let k = 1; k < 4; k++) { const t = k / 4, q: V3 = [a[0] + (c[0] - a[0]) * t, a[1], a[2] + (c[2] - a[2]) * t], e: V3 = [q[0] + (alongX ? 0.06 : 0), q[1], q[2] + (alongX ? 0 : 0.06)]; b.cyl(rm.steel, q, e, r * 0.55, 14); }
        void L;
        break;
      }
      case "crate": {
        wbox(b, rm.crate, x0, y0, z0, x1, y1, z1, 0.02);
        for (const yy of [y0 + 0.08, y1 - 0.08]) { wbox(b, rm.dark, x0 - 0.01, yy - 0.03, z0 - 0.01, x1 + 0.01, yy + 0.03, z0 + 0.01); wbox(b, rm.dark, x0 - 0.01, yy - 0.03, z1 - 0.01, x1 + 0.01, yy + 0.03, z1 + 0.01); }
        break;
      }
      case "bunk": {
        wbox(b, rm.cabinet, x0, y0, z0, x1, y0 + 0.35, z1);
        wbox(b, rm.paper, x0 + 0.05, y0 + 0.35, z0 + 0.05, x1 - 0.05, y0 + 0.5, z1 - 0.05, 0.03);
        if (y1 - y0 > 1.2) { wbox(b, rm.cabinet, x0, y1 - 0.4, z0, x1, y1 - 0.25, z1); wbox(b, rm.paper, x0 + 0.05, y1 - 0.25, z0 + 0.05, x1 - 0.05, y1 - 0.1, z1 - 0.05, 0.03); for (const [lx, lz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) wbox(b, rm.rail, lx - 0.03, y0, lz - 0.03, lx + 0.03, y1, lz + 0.03); }
        break;
      }
      case "shelf": {
        const n = Math.max(2, Math.round((y1 - y0) / 0.45));
        for (let k = 0; k <= n; k++) { const yy = y0 + ((y1 - y0 - 0.03) * k) / n; wbox(b, rm.cabinet, x0, yy, z0, x1, yy + 0.03, z1); if (k < n && k > 0) for (let q = 0; q < 3; q++) { const h = hash(cx, yy, q); if (h < 0.3) continue; const along = alongX ? x0 + (x1 - x0) * (q + 0.5) / 3 : z0 + (z1 - z0) * (q + 0.5) / 3; const s = 0.18 + h * 0.12; if (alongX) wbox(b, h < 0.6 ? rm.crate : rm.paper, along - s, yy + 0.03, cz - 0.15, along + s, yy + 0.03 + s * 1.2, cz + 0.15); else wbox(b, h < 0.6 ? rm.crate : rm.paper, cx - 0.15, yy + 0.03, along - s, cx + 0.15, yy + 0.03 + s * 1.2, along + s); } }
        for (const [lx, lz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) wbox(b, rm.rail, lx - 0.02, y0, lz - 0.02, lx + 0.02, y1, lz + 0.02);
        break;
      }
      case "lamp": {
        // a ceiling light panel (emissive) + its pool on the floor below (`c` = the panel, the pool goes y0 − floor gap)
        wbox(b, rm.dark, x0 - 0.04, y1 - 0.06, z0 - 0.04, x1 + 0.04, y1, z1 + 0.04);
        wbox(b, rm.lamp, x0, y1 - 0.08, z0, x1, y1 - 0.06, z1);
        if (fx) fx.add(rm.glow, new THREE.PlaneGeometry(4.5, 4.5).rotateX(-Math.PI / 2).translate(cx, y0 + 0.02, cz), undefined, false);
        break;
      }
      case "pipe": {
        // a service pipe run along the piece's long axis (radius = its smaller half size) on clamps every 1.2 m
        const r = Math.min(alongX ? p.h[2] : p.h[0], p.h[1]), cy = (y0 + y1) / 2;
        b.cyl(M, [alongX ? x0 : cx, cy, alongX ? cz : z0], [alongX ? x1 : cx, cy, alongX ? cz : z1], r, 10, { caps: false });
        const L = alongX ? x1 - x0 : z1 - z0;
        for (let t = 0.4; t < L - 0.2; t += 1.2) { const px = alongX ? x0 + t : cx, pz = alongX ? cz : z0 + t; wbox(b, rm.dark, px - (alongX ? 0.03 : r + 0.02), cy - r - 0.02, pz - (alongX ? r + 0.02 : 0.03), px + (alongX ? 0.03 : r + 0.02), cy + r + 0.15, pz + (alongX ? r + 0.02 : 0.03)); }
        break;
      }
      case "panel": {
        // a floor / ceiling slab: the finish on top, a painted soffit under it, a steel edge band
        const top = o.floorMat ? rm[o.floorMat] : p.mat === "grate" ? rm.grate : p.mat === "floor" ? rm.floor : M;
        wbox(b, p.mat === "floor" ? rm.ceiling : M, x0, y0, z0, x1, y1 - 0.03, z1);
        // the finish stands 4 mm proud: a deckhouse floor laid on the ship's deck plate drew in the same plane (flicker)
        wbox(b, top, x0, y1 - 0.03, z0, x1, y1 + 0.004, z1);
        break;
      }
      default: {
        if ((p.mat === "wallIn" || p.mat === "wall") && o.wallBand !== false) {
          // the lower band: painted dado (1.1 m) + a dark skirting, both faces; the plaster above
          const band = Math.min(y1, y0 + 1.1);
          const thinX = p.h[0] < p.h[2];
          if (y0 < 0.02 + minFloor(p)) {
            wbox(b, rm.dado, x0 - (thinX ? 0.006 : 0), y0, z0 - (thinX ? 0 : 0.006), x1 + (thinX ? 0.006 : 0), band, z1 + (thinX ? 0 : 0.006));
            wbox(b, rm.dark, x0 - (thinX ? 0.012 : 0), y0, z0 - (thinX ? 0 : 0.012), x1 + (thinX ? 0.012 : 0), Math.min(y1, y0 + 0.1), z1 + (thinX ? 0 : 0.012));
          }
          if (y0 >= 0.02 + minFloor(p)) wbox(b, M, x0, y0, z0, x1, y1, z1);
          else if (y1 > band) wbox(b, M, x0, band, z0, x1, y1, z1);
          break;
        }
        wbox(b, M, x0, y0, z0, x1, y1, z1, p.mat === "crate" || p.mat === "machine" ? 0.03 : 0);
      }
    }
  }
}
/** walls start at their storey's floor: the dado only on pieces that start at a floor (not lintels / upper parts) */
function minFloor(p: Piece): number { return p.base ?? -1e9; }
void weather;
