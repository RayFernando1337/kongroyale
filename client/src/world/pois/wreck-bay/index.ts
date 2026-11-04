// POI wreck-bay — WRECK BAY: the wrecked pirate galleon in the north-coast cove, the rope bridge + boardwalk to the
// shore, the castaway camp and the headland waterfall. Every walkable / solid visual is derived from
// shared/pois/wreck-bay.ts (the same pieces the server collides against). Merged through a TownLod (poi-town kit) whose
// materials are the wreck-bay photo-textured sets (mats.ts): the galleon, each hut and the lookout are LOD items (full
// shell near, LOD1 + shadow proxy beyond), the shore props are cells, the far proxy is a handful of boxes.
import * as THREE from "three";
import type { WorldModule } from "../../module";
import type { WorldCtx } from "../../../engine/engine";
import type { CamSpec } from "../../../engine/views";
import {
  SHIP, LV, HULL, MASTS, NEST, SH, SHACKS, SHIP_ROOMS, SHIP_LAYOUTS, INTERIOR_ROOMS, TOWER, TENT, FIRE, PALMS, LANDING, BRIDGE, ROCKS, HEADLAND, ROCK_SOLIDS, HEADLAND_PALMS, centroid2, inPoly2, shipToWorld, hb, shackToWorld, towerToWorld,
} from "../../../../../shared/pois/wreck-bay";
import { mulberry } from "../../../../../shared/pois/town-kit";
import { TownLod } from "../_kit/town-materials";
import { M, col } from "../_kit/town-geo";
import { TownVeg } from "../_kit/town-veg";
import { glowPoints } from "../_kit/coast-kit";
import { wbMats, aliasTown } from "./mats";
import { buildShip, shipProxy, belowDeckLight, SHIPM } from "./ship";
import { addCarving } from "./carving";
import { dressShipRooms } from "./cabin-dress";
import { buildInteriors } from "../_kit/interior";
import { buildShore, shoreProxy, type ItemBins } from "./shore";
import { flag } from "../../../flags";

type V3 = [number, number, number];
// ---------------------------------------------------------------- views
/** the view camera: on the upper beach behind the camp, jungle framing the foreground, looking NNE past the camp
 *  fire to the galleon (left) and the headland (right) with the sun on the horizon */
// (fire centre, tent centre-right, the waterfall cliff right, the ship filling the left half)
const CAM = { x: 41, z: -628, y: 4.0 }, LOOK: V3 = [67.2, 11.0, -670.6];
const sp = (x: number, lvl: number, z: number, dy = 1.8): V3 => { const w = shipToWorld(x, lvl, z); return [w[0], w[1] + dy, w[2]]; };
const views: Record<string, CamSpec> = {
  "poi-16-wreck-bay": { pos: [CAM.x, CAM.y, CAM.z], target: LOOK, fov: 60, t: 14, stage: "sunset" },
  "wreckbay-aerial": { pos: [125, 62, -770], target: [55, 0, -662], fov: 55, t: 12 },
  "wreckbay-top": { pos: [45, 330, -660], target: [45, 0, -690], fov: 50, t: 12 },
  "wreckbay-plane": { pos: [-260, 520, -380], target: [40, 0, -690], fov: 50, t: 12 },
  "wreckbay-sea": { pos: [0, 12, -800], target: [48, 8, -700], fov: 55, t: 12 },
  // eye level (kong eye ≈ 1.8 m over the floor)
  "wreckbay-eye-beach": { pos: [20, 2.6, -648], target: [45, 7, -705], fov: 70, t: 12 },
  "wreckbay-eye-camp": { pos: [48.5, 2.3, -636.5], target: [75, 2.5, -646], fov: 70, t: 12 },
  "wreckbay-eye-fire": { pos: [46.5, 2.2, -638.5], target: [51.5, 0.6, -642.5], fov: 70, t: 12 },
  "wreckbay-eye-bridge": { pos: [BRIDGE.a[0] + 1, BRIDGE.a[1] + 1.8, BRIDGE.a[2] + 2], target: [BRIDGE.b[0], BRIDGE.b[1] + 2, BRIDGE.b[2]], fov: 70, t: 12 },
  "wreckbay-eye-main": { pos: sp(6.5, LV.main, SH * 2.5), target: sp(-8, LV.qd, 0, 1.2), fov: 70, t: 12 },
  "wreckbay-eye-gun": { pos: sp(8.5, LV.gun, 0.6), target: sp(-10, LV.gun, 0, 1.0), fov: 75, t: 12 },
  "wreckbay-eye-hold": { pos: sp(-12.5, LV.hold, -1.0), target: sp(4, LV.hold, 0, 1.0), fov: 75, t: 12 },
  "wreckbay-eye-cabin": { pos: sp(-8.0, LV.main, SH * 1.5), target: sp(-17, LV.main, 0, 1.2), fov: 75, t: 12 },
  "wreckbay-eye-chart": { pos: sp(-13.2, LV.qd, -SH * 0.9), target: sp(-17.5, LV.qd, SH * 1.5, 0.9), fov: 75, t: 12 },
  "wreckbay-eye-fc": { pos: sp(9.6, LV.main, 0.4), target: sp(15, LV.main, -0.5, 0.9), fov: 75, t: 12 },
  "wreckbay-eye-gunroom": { pos: sp(-10.5, LV.gun, SH * 1.8), target: sp(-17.2, LV.gun, -SH * 1.0, 0.9), fov: 75, t: 12 },
  "wreckbay-eye-holdfwd": { pos: sp(5.5, LV.hold, 0.8), target: sp(12.5, LV.hold, -1.0, 0.9), fov: 75, t: 12 },
  "wreckbay-eye-nest": { pos: sp(MASTS[1].x - 1.9, NEST.y, -SH * 1.2), target: [60, 1, -650], fov: 70, t: 12 },
  "wreckbay-eye-poop": { pos: sp(-16.5, LV.poop, 0), target: sp(15, LV.fc, 0, 2), fov: 70, t: 12 },
  "wreckbay-eye-hut": { pos: (() => { const s = SHACKS[0]; const [x, z] = shackToWorld(s, 1.4, 1.2); return [x, s.y + 1.7, z] as V3; })(), target: (() => { const s = SHACKS[0]; const [x, z] = shackToWorld(s, -2.2, -1.4); return [x, s.y + 1.0, z] as V3; })(), fov: 75, t: 12 },
  "wreckbay-eye-tower": { pos: (() => { const [x, z] = towerToWorld(0.6, 0.6); return [x, TOWER.l2 + 1.8, z] as V3; })(), target: [45, 6, -705], fov: 70, t: 12 },
};

// ---------------------------------------------------------------- fire flames + waterfall
function flames(mat: THREE.ShaderMaterial, x: number, y: number, z: number): THREE.Mesh {
  const geos: THREE.BufferGeometry[] = [];
  // a bonfire you read from the view camera (≈ 20 m): tall licking tongues (to ~3.4 m), a ring of lower cards
  const cards: Array<[number, number, number, number]> = [[0, 0, 1.15, 1.9], [0.9, 0.1, 1.0, 1.7], [1.9, -0.1, 1.05, 1.8], [0.45, 0.2, 0.8, 1.3], [1.3, -0.2, 0.85, 1.4], [2.5, 0.15, 0.85, 1.5], [2.9, 0.4, 0.7, 1.1]];
  for (const [a, off, w, h] of cards) {
    const g = new THREE.PlaneGeometry(w, h, 1, 1); g.translate(off * 0.2, h / 2, 0); g.rotateY(a);
    const c = new Float32Array(g.attributes.position.count * 3).fill(1); g.setAttribute("color", new THREE.Float32BufferAttribute(c, 3));
    geos.push(g);
  }
  const merged = new THREE.BufferGeometry();
  const pos: number[] = [], uv: number[] = [], colr: number[] = [], idx: number[] = [];
  for (const g of geos) {
    const b = pos.length / 3;
    pos.push(...(g.attributes.position.array as Float32Array)); uv.push(...(g.attributes.uv.array as Float32Array)); colr.push(...(g.attributes.color.array as Float32Array));
    const ia = g.index!.array; for (let k = 0; k < ia.length; k++) idx.push(b + ia[k]);
  }
  merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); merged.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); merged.setAttribute("color", new THREE.Float32BufferAttribute(colr, 3)); merged.setIndex(idx);
  const m = new THREE.Mesh(merged, mat);
  m.position.set(x, y, z); m.name = "wreckbay:flames"; m.renderOrder = 4;
  m.userData.castShadow = false; m.userData.farShadow = false;
  return m;
}
/** the fire's solid core: teardrop flame tongues (a hot core + 6 licking around it), vertex-coloured yellow → orange →
 *  red at the tips, unlit (reads in daylight; the soft cards around it carry the flicker) */
function fireCore(x: number, y: number, z: number, rng: () => number): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const tongue = (h: number, r: number, m: THREE.Matrix4) => {
    const g = new THREE.LatheGeometry([[0, 0], [0.7, 0.08], [1, 0.25], [0.8, 0.5], [0.4, 0.78], [0.12, 0.95], [0, 1]].map(([a, b]) => new THREE.Vector2(a * r, b * h)), 10);
    const p = g.attributes.position as THREE.BufferAttribute, c = new Float32Array(p.count * 3), lo = new THREE.Color("#fff2a0"), mid = new THREE.Color("#ff9a1e"), hi = new THREE.Color("#e8380a"), t = new THREE.Color();
    for (let i = 0; i < p.count; i++) { const k = p.getY(i) / h; if (k < 0.45) t.copy(lo).lerp(mid, k / 0.45); else t.copy(mid).lerp(hi, (k - 0.45) / 0.55); c.set([t.r, t.g, t.b], i * 3); }
    g.setAttribute("color", new THREE.Float32BufferAttribute(c, 3)); g.deleteAttribute("uv"); g.applyMatrix4(m); parts.push(g.toNonIndexed());
  };
  tongue(1.35, 0.32, M(0, 0.1, 0, 0, 0.05, 0.04));
  tongue(0.85, 0.2, M(0, 0.18, 0));
  for (let i = 0; i < 6; i++) { const a = i * 1.05 + rng() * 0.4, r = 0.22 + rng() * 0.08; tongue(0.6 + rng() * 0.45, 0.13 + rng() * 0.05, M(Math.cos(a) * r, 0.08, Math.sin(a) * r, rng() * 3, Math.sin(a) * 0.3, -Math.cos(a) * 0.3)); }
  const pos: number[] = [], col: number[] = [];
  for (const g of parts) { pos.push(...(g.attributes.position.array as Float32Array)); col.push(...(g.attributes.color.array as Float32Array)); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ name: "wb:flame-glow-core", vertexColors: true, toneMapped: false }));
  m.position.set(x, y, z); m.name = "wreckbay:flamecore-glow"; m.userData.castShadow = false; m.userData.farShadow = false;
  return m;
}
/** embers (additive sparks spiralling up out of the fire) + a smoke wisp (soft grey puffs drifting up and downwind) */
function fireFx(x: number, y: number, z: number): { group: THREE.Group; tick: (t: number, h: number) => void } {
  const group = new THREE.Group(); group.name = "wreckbay:firefx";
  const mk = (n: number, smoke: boolean) => {
    const g = new THREE.BufferGeometry();
    const seed = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { seed[i * 3] = Math.random(); seed[i * 3 + 1] = Math.random(); seed[i * 3 + 2] = Math.random(); }
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("seed", new THREE.Float32BufferAttribute(seed, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 5, 0), 12);
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 540 } },
      transparent: true, depthWrite: false, blending: smoke ? THREE.NormalBlending : THREE.AdditiveBlending,
      vertexShader: `attribute vec3 seed; uniform float uTime; uniform float uScale; varying float vA;
        void main() {
          float life = ${smoke ? "5.5" : "2.2"}, t = fract(uTime / life + seed.x), a = seed.y * 6.2832 + t * ${smoke ? "1.2" : "5.0"};
          float r = ${smoke ? "0.25 + t * 1.6" : "0.12 + t * 0.9 * seed.z"};
          vec3 p = vec3(cos(a) * r + ${smoke ? "t * t * 2.2" : "0.0"}, ${smoke ? "2.2 + t * 7.5" : "0.6 + t * (3.0 + 3.5 * seed.z)"}, sin(a) * r ${smoke ? "- t * 1.2" : ""});
          vA = ${smoke ? "smoothstep(0.0, 0.15, t) * (1.0 - t) * 0.32" : "(1.0 - t) * smoothstep(0.0, 0.05, t)"};
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = max(${smoke ? "1.0" : "1.5"}, ${smoke ? "(0.9 + t * 2.6)" : "(0.018 + 0.016 * seed.z)"} * uScale / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard;
          ${smoke ? "gl_FragColor = vec4(vec3(0.55, 0.5, 0.48), vA * (1.0 - d * d));" : "gl_FragColor = vec4(vec3(1.5, 0.55, 0.12) * vA * (1.0 - d), 1.0);"}
        }`,
    });
    const pts = new THREE.Points(g, m); pts.frustumCulled = true; pts.renderOrder = smoke ? 5 : 6;
    pts.userData.castShadow = false; pts.userData.farShadow = false;
    group.add(pts);
    return m;
  };
  const em = mk(60, false), sm = mk(18, true);
  group.position.set(x, y, z);
  // h = the projection scale in pixels (drawing-buffer height / (2·tan(fov/2)))
  return { group, tick: (t, h) => { em.uniforms.uTime.value = t; sm.uniforms.uTime.value = t; em.uniforms.uScale.value = sm.uniforms.uScale.value = h; } };
}
/** spray + mist rolling off the waterfall's foot (soft white puffs) */
function sprayFx(x: number, y: number, z: number, w: number): { group: THREE.Group; tick: (t: number, h: number) => void } {
  const n = 96, g = new THREE.BufferGeometry(), seed = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { seed[i * 3] = Math.random(); seed[i * 3 + 1] = Math.random(); seed[i * 3 + 2] = Math.random(); }
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("seed", new THREE.Float32BufferAttribute(seed, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 10);
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 540 }, uW: { value: w } },
    transparent: true, depthWrite: false,
    vertexShader: `attribute vec3 seed; uniform float uTime, uScale, uW; varying float vA;
      void main() {
        float t = fract(uTime / 3.2 + seed.x), a = seed.y * 6.2832;
        vec3 p = vec3((seed.z - 0.5) * uW + cos(a) * t * 2.2, 0.2 + t * (2.5 + seed.y * 2.0), sin(a) * t * 2.2);
        vA = smoothstep(0.0, 0.2, t) * (1.0 - t) * 0.45;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.2 + t * 3.0) * uScale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `varying float vA; void main() { float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard; gl_FragColor = vec4(vec3(0.95, 0.98, 1.0), vA * (1.0 - d * d)); }`,
  });
  const pts = new THREE.Points(g, m); pts.renderOrder = 5; pts.userData.castShadow = false; pts.userData.farShadow = false;
  const group = new THREE.Group(); group.name = "wreckbay:spray"; group.add(pts); group.position.set(x, y, z);
  return { group, tick: (t, h) => { m.uniforms.uTime.value = t; m.uniforms.uScale.value = h; } };
}
/** a warm light pool on the sand round the fire (additive disc, radial falloff in the vertex colours) */
function firePool(x: number, y: number, z: number, r: number): THREE.Mesh {
  const g = new THREE.CircleGeometry(r, 32, 0, Math.PI * 2);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position as THREE.BufferAttribute, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const d = Math.hypot(p.getX(i), p.getZ(i)) / r, k = Math.pow(Math.max(0, 1 - d), 1.8); c[i * 3] = 0.55 * k; c[i * 3 + 1] = 0.28 * k; c[i * 3 + 2] = 0.08 * k; }
  g.setAttribute("color", new THREE.Float32BufferAttribute(c, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  m.position.set(x, y, z); m.name = "wreckbay:firepool"; m.renderOrder = 2;
  m.userData.castShadow = false; m.userData.farShadow = false;
  return m;
}
/** the waterfall ribbon down the headland's west face + a foam disc at its foot */
export const FALL = (() => {
  // on the headland's face toward the view camera: from the top tier's lip down past the stepped tiers into the sea
  const r = ROCKS[0], tiers = ROCK_SOLIDS[0], dx = CAM.x - r.x, dz = CAM.z - r.z, l = Math.hypot(dx, dz), ux = dx / l, uz = dz / l;
  // distance from the rock axis to a ring's edge along (ux, uz)
  const edge = (pts: Array<[number, number]>) => { let d = 0; while (d < 40 && inPoly2(pts, r.x + ux * d, r.z + uz * d)) d += 0.1; return d; };
  const T = tiers[tiers.length - 1], eTop = edge(T.rings[T.rings.length - 1].pts) + 0.25, eBot = edge(tiers[0].rings[1].pts) + 1.4;
  return { top: [r.x + ux * eTop, T.top - 0.2, r.z + uz * eTop] as V3, bottom: [r.x + ux * eBot, -0.3, r.z + uz * eBot] as V3, w: 3.4, ux, uz };
})();
/** white water at both ends of the fall: a foam roll pouring over the lip and a churned foam ring + mound where it
 *  plunges into the sea */
function fallFoam(): THREE.Group {
  const grp = new THREE.Group(); grp.name = "wreckbay:fall-foam";
  const mat = new THREE.MeshStandardMaterial({ name: "wb:foam", color: "#f4fbff", emissive: new THREE.Color(0.32, 0.36, 0.38), roughness: 1, metalness: 0, transparent: true, opacity: 0.92, depthWrite: false });
  const px = -FALL.uz, pz = FALL.ux, [ax, ay, az] = FALL.top, [bx, , bz] = FALL.bottom, w = FALL.w;
  // lip: a lumpy roll across the fall's width, bulging out over the edge
  const lip: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i++) { const u = (i / 8 - 0.5) * w * 0.95, bump = Math.sin(i * 1.7) * 0.06; lip.push(new THREE.Vector3(ax + px * u + FALL.ux * 0.15, ay + 0.08 + bump, az + pz * u + FALL.uz * 0.15)); }
  const roll = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lip), 24, 0.22, 8, false), mat); roll.renderOrder = 4; grp.add(roll);
  // plunge: a flattened churn ring + a low foam mound, lumpy (noise-displaced icosphere / torus)
  const lump = (g: THREE.BufferGeometry, k: number, seed: number) => { const p = g.attributes.position as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) { const f = 1 + k * Math.sin(p.getX(i) * 5.1 + seed) * Math.cos(p.getZ(i) * 4.3 + seed * 1.7); p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f); } g.computeVertexNormals(); return g; };
  const ring = new THREE.Mesh(lump(new THREE.TorusGeometry(w * 0.85, 0.42, 8, 28), 0.18, 1), mat); ring.rotation.x = Math.PI / 2; ring.scale.set(1, 1, 0.35); ring.position.set(bx, 0.02, bz); ring.renderOrder = 4; grp.add(ring);
  const mound = new THREE.Mesh(lump(new THREE.IcosahedronGeometry(w * 0.55, 2), 0.12, 3), mat); mound.scale.set(1, 0.32, 1); mound.position.set(bx, 0.0, bz); mound.renderOrder = 4; grp.add(mound);
  for (const o of grp.children) { o.userData.castShadow = false; o.userData.farShadow = false; }
  return grp;
}
function waterfall(mat: THREE.ShaderMaterial): THREE.Mesh {
  const [ax, ay, az] = FALL.top, [bx, by, bz] = FALL.bottom;
  const n = 18, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  // across direction ⟂ to the view direction (the sheet faces the camera)
  const hx = bx - ax, hz = bz - az, hl = Math.hypot(hx, hz) || 1, px = -FALL.uz, pz = FALL.ux;
  for (let i = 0; i <= n; i++) {
    const t = i / n, bulge = Math.sin(t * Math.PI) * 0.8 * (1 - t * 0.5);
    const x = ax + hx * (t * t * 0.7 + t * 0.3) + (hx / hl) * bulge, y = ay + (by - ay) * t, z = az + hz * (t * t * 0.7 + t * 0.3) + (hz / hl) * bulge;
    const w = FALL.w * (0.8 + 0.5 * t);
    pos.push(x - px * w / 2, y, z - pz * w / 2, x + px * w / 2, y, z + pz * w / 2);
    uv.push(0, 1 - t, 1, 1 - t);
  }
  for (let i = 0; i < n; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat); m.name = "wreckbay:waterfall"; m.renderOrder = 3;
  m.userData.castShadow = false; m.userData.farShadow = false;
  return m;
}

const mod: WorldModule = {
  id: "poi:wreck-bay",
  views,
  async build(ctx: WorldCtx) {
    const t0 = performance.now();
    const group = new THREE.Group();
    group.name = "poi:wreck-bay";
    ctx.scene.add(group);
    const wm = await wbMats(ctx);
    const tMats = performance.now();
    const mats = aliasTown(wm);
    // far 560: beyond `far` only the box proxy draws; at 340 m the swap to the real cove (BatchedMesh instance
    // toggles: no engine fade) landed in the middle of a dive onto the bay; at 560 m the whole cove is a few % of the screen
    const EL = flag("elevlod");   // ?elevlod=0 = old distances (A/B)
    const lod = new TownLod(mats, "wreckbay", { cell: 48, near: 95, far: EL ? 560 : 340, fine: 42, itemNear: 75, itemFine: 36, castItem: 180 });
    const rng = mulberry(0x57524b42);
    const g = (x: number, z: number) => ctx.terrain.height(x, z);

    // ---- the galleon (one LOD item: full detail within ~240 m of its bounds; LOD1 + shadow proxy beyond / casting)
    // (the build yields between its stages so no main-thread task runs much past ~50 ms while the POI streams in)
    // busy = this module's own main-thread time between yields; maxSlice = its longest synchronous slice
    const BZ = { busy: 0, max: 0, last: performance.now(), at: "" };
    const intLevels: Array<{ y: number; o: THREE.Object3D }> = [];
    const SHIPI = SHIPM.clone().invert(), camS = new THREE.Vector3();
    // ?nocull (the parity tool, screenshot captures that must see everything): no per-level room culling
    const noCull = flag("nocull");
    const yieldTask = async () => { const n = performance.now(); BZ.busy += n - BZ.last; if (n - BZ.last > BZ.max) { BZ.max = n - BZ.last; BZ.at = (new Error().stack ?? "").split("\n").slice(2, 4).join(" < ").replace(/https?:[^ )]*\//g, ""); } await new Promise<void>((r) => setTimeout(r, 0)); BZ.last = performance.now(); };
    // (mid 420: the galleon's LOD1 swap stays out of the dive)
    const it = lod.item("ship", SHIP.x, SHIP.z, { mid: EL ? 420 : 240, near: 110, fine: 46, top: 34 });
    const T: Record<string, number> = {};
    let tk = performance.now();
    const lap = (k: string) => { const n2 = performance.now(); T[k] = Math.round(n2 - tk); tk = n2; };
    const shipBins = { main: it.main, near: it.near, fine: it.fine, lod1: it.lod1 };
    const ship = await buildShip(shipBins, rng, yieldTask);
    await yieldTask();
    { const t = performance.now(); addCarving(shipBins); T.carve = Math.round(performance.now() - t); }   // balustrades, stair rails, carved stern, beakhead + figurehead (carving.ts)
    await yieldTask();
    { const t = performance.now(); dressShipRooms(shipBins, rng, ship.pools); T.dress = Math.round(performance.now() - t); }   // storytelling props + wall lanterns (pools) in every ship room
    await yieldTask();
    shipProxy((geo, m, c) => lod.proxyGeo(geo, m, c));

    // ---- shore: bridge, landing, boardwalk, camp, rocks, cover
    const hutItems = new Map<string, ItemBins>();
    for (const s of SHACKS) {
      const h = lod.item(`hut-${s.id}`, s.x, s.z, { mid: EL ? 220 : 130, near: 70, fine: 34, top: s.y + s.wallH + s.rise + 0.5 });
      hutItems.set(s.id, { main: h.main, near: h.near, fine: h.fine, lod1: h.lod1 });
    }
    const tw = lod.item("tower", TOWER.x, TOWER.z, { mid: EL ? 240 : 150, near: 80, fine: 36, top: TOWER.roof + 2 });
    lap("ship");
    const shore = await buildShore(
      { main: (x, z) => lod.main(x, z), near: (x, z) => lod.near(x, z), fine: (x, z) => lod.fine(x, z) },
      { hut: (s) => hutItems.get(s.id)!, tower: { main: tw.main, near: tw.near, fine: tw.fine, lod1: tw.lod1 } },
      rng, g, yieldTask,
    );
    shoreProxy((m, w, h, d, wall, roof, win) => lod.proxyBox(m, w, h, d, wall, roof, win), (geo, m, c) => lod.proxyGeo(geo, m, c));
    await yieldTask();

    // ---- vegetation through the veg area's API: leaning palms over the beach, jungle framing the camp
    const veg = new TownVeg(ctx, lod.near(TENT.x, TENT.z), rng);
    // each palm through a planter bound to ITS lod cell: without the veg module (isolated builds, the parity tool) the
    // POI's fallback trunk then shows wherever the palm stands, not only near the tent's cell
    for (const p of PALMS) { const pv = new TownVeg(ctx, lod.near(p.x, p.z), rng); pv.plant(p.lean ? "palm-leaning" : "palm", p.x, p.z, p.yaw, p.s); pv.flush(); }
    const jungle: Array<[string, number, number, number, number]> = [
      // [kind, x, z, yaw, scale] — behind the camp / at the foot of the terrace, and the view camera's foreground
      // the view camera's foreground band (6–11 m in front of it, a gap in the middle for the fire)
      ["monstera", 37.0, -633.8, 0.4, 2.8], ["bush", 35.6, -633.2, 1.1, 1.3], ["fern", 41.2, -636.2, 2.1, 1.8], ["groundcover", 43.2, -635.2, 0.3, 1.6],
      ["fern", 46.8, -634.4, 1.2, 1.7], ["monstera", 49.0, -627.6, 0.9, 2.4], ["fern", 50.5, -625.8, 2.2, 1.8],
      ["fern", 35.4, -631.5, 0.8, 1.8], ["bush", 33.8, -634.0, 1.9, 1.8], ["monstera", 35.8, -630.2, 2.6, 2.6],
      ["monstera", 38.3, -632.6, 0.4, 1.8], ["fern", 36.8, -636.5, 0.3, 1.4], ["banana-plant", 35.0, -631.0, 1.0, 1.4],
      ["monstera", 45.8, -627.0, 2.0, 1.4], ["fern", 43.5, -634.0, 1.7, 0.9], ["bamboo", 47.5, -625.5, 0.4, 1.1],
      ["monstera", 84.0, -628.5, 1.1, 1.3], ["banana-plant", 101.5, -634.0, 0.7, 1.2], ["fern", 88.5, -625.0, 2.2, 1.2],
      ["bush", 76.5, -630.5, 0.2, 1.1], ["monstera", 110.5, -644.5, 2.8, 1.4], ["bamboo", 99.0, -622.0, 0.5, 1.0],
      ["bamboo", 104.0, -626.0, 1.2, 1.1], ["fern", 63.0, -636.0, 1.4, 1.0], ["banana-plant", 117.0, -650.0, 0.4, 1.2],
      ["monstera", 5.0, -644.0, 1.9, 1.3], ["fern", -8.0, -655.0, 0.8, 1.2], ["bush", -22.0, -665.0, 2.4, 1.3],
      // the view's lower band (5–9 m in front of the camera): giant monstera + banana leaves on both lower corners,
      // bamboo culms at the right edge, fern / shrub layers across the bottom — the fire's sight line (bearing ≈ 36°) open
      ["monstera", 39.4, -633.4, 0.9, 1.4], ["fern", 40.6, -634.0, 1.9, 1.2], ["fern", 41.9, -633.9, 0.6, 1.0], ["groundcover", 39.8, -636.2, 2.9, 1.0],
      ["monstera", 45.3, -630.4, 1.4, 1.3], ["bamboo", 46.0, -629.8, 0.2, 1.1], ["monstera", 45.4, -629.2, 2.5, 1.3],
      ["fern", 44.6, -632.2, 2.8, 1.0], ["fern", 38.7, -635.0, 1.1, 1.0],
    ];
    for (const [k, x, z, yaw, s] of jungle) veg.plant(k as Parameters<TownVeg["plant"]>[0], x, z, yaw, s);
    // jungle crowning the headland plateaus (palms + bushes over the cliff)
    ROCKS.slice(0, HEADLAND).forEach((r, i) => {
      if (r.sy < 5) return;
      // the top tier's cap polygon (shared ROCK_SOLIDS: the plateau a kong stands on)
      const tiers = ROCK_SOLIDS[i], T = tiers[tiers.length - 1], ring = T.rings[T.rings.length - 1].pts, top = T.top;
      const [cx, cz] = centroid2(ring);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      const n = Math.round(((x1 - x0) * (z1 - z0)) / 22);
      for (let k = 0, tries = 0; k < n && tries < n * 8; tries++) {
        const x = x0 + rng() * (x1 - x0), z = z0 + rng() * (z1 - z0);
        if (!inPoly2(ring, x, z, 1.6)) continue;
        // (soft plants only: the plateau palms are shared HEADLAND_PALMS with trunk colliders)
        const kind = (["bush", "monstera", "fern", "bush", "monstera", "fern"] as const)[(k + i) % 6];
        veg.plant(kind, x, z, rng() * 6.28, 0.9 + rng() * 0.4, top - 0.1);
        k++;
      }
      // the lip: a hedge of bushes / ferns / monstera right ON the rim, leaning out — the jungle spills over the cliff edge
      for (let e = 0; e < ring.length; e++) {
        const [ax, az] = ring[e], [bx, bz] = ring[(e + 1) % ring.length], L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.round(L / 2.4));
        for (let k = 0; k < m; k++) {
          const t = (k + 0.25 + rng() * 0.5) / m, px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
          const dx = cx - px, dz = cz - pz, dl = Math.hypot(dx, dz) || 1, inset = 0.35 + rng() * 0.4;
          veg.plant((["bush", "fern", "monstera", "bush", "monstera", "fern"] as const)[(k + e) % 6], px + (dx / dl) * inset, pz + (dz / dl) * inset, rng() * 6.28, 1.15 + rng() * 0.5, top - 0.15);
        }
      }
    });
    for (const p of HEADLAND_PALMS) { const pv = new TownVeg(ctx, lod.near(p.x, p.z), rng); pv.plant("palm", p.x, p.z, p.yaw, p.s, p.y - 0.05); pv.flush(); }
    veg.flush();
    lap("shore+veg");

    // ---- interiors (shared kit): the galleon's cabins / gun deck / hold in the listed ship frame, the huts in the world
    {
      const shipFrame = new THREE.Group();
      shipFrame.name = "wreckbay:ship-frame";
      shipFrame.matrixAutoUpdate = false;
      shipFrame.matrix.copy(SHIPM);
      group.add(shipFrame);
      shipFrame.updateMatrixWorld(true);
      // (hidden beyond ~28 m past the hull bounds: from farther out only the lit ports / windows read, the rooms do not)
      // one kit build per deck level (each its own holder): rooms more than about a deck above / below the camera are
      // hidden — from the main deck the hold and gun-deck rooms cannot be seen, yet they cost ~0.4 ms (measured A/B)
      for (const ly of [...new Set(SHIP_ROOMS.map((r) => r.y))]) {
        const idx = SHIP_ROOMS.map((r, i) => (r.y === ly ? i : -1)).filter((i) => i >= 0);
        const holder = new THREE.Object3D(); holder.name = `wreckbay:ship-int-level-${ly}`; shipFrame.add(holder); holder.updateMatrixWorld(true);   // (the kit reads world bounds at build time)
        await buildInteriors(ctx, idx.map((i) => SHIP_ROOMS[i]), { parent: holder, name: "wreckbay-ship-int", layouts: idx.map((i) => SHIP_LAYOUTS[i]), maxDist: 28 });
        intLevels.push({ y: ly, o: holder });
      }
      await buildInteriors(ctx, INTERIOR_ROOMS, { parent: group, name: "wreckbay-hut-int", maxDist: 60 });
    }
    lap("interiors");

    // ---- far proxy: the ship silhouette + hut boxes (TownLod draws it beyond `far`)
    const tGeo = performance.now();
    const n = lod.build(ctx, group);

    // ---- fire: flame cards, ember glow, a warm light pool on the sand; lamp halos everywhere
    const fy = g(FIRE.x, FIRE.z);
    const fl = flames(wm.flame, FIRE.x, fy + 0.05, FIRE.z);
    group.add(fl);
    group.add(fireCore(FIRE.x, fy - 0.02, FIRE.z, rng));
    const ffx = fireFx(FIRE.x, fy, FIRE.z);
    group.add(ffx.group);
    group.add(firePool(FIRE.x, fy + 0.12, FIRE.z, 5.5));
    const glowList = [...ship.glows, ...shore.glows].map((p) => ({ p, size: 1.3 }));
    glowList.push({ p: new THREE.Vector3(FIRE.x, fy + 1.3, FIRE.z), size: 7.5 });
    const gp = glowPoints(glowList, { opacity: 0.45 });
    gp.name = "wreckbay:glows";
    group.add(gp);
    // ---- below decks: warm lantern pools + gun-port light shafts (hidden beyond 70 m of the ship)
    const bl = belowDeckLight(ship.pools);
    group.add(bl);
    // ---- the waterfall
    const wf = waterfall(wm.fall);
    group.add(wf);
    const spray = sprayFx(FALL.bottom[0], -0.2, FALL.bottom[2], FALL.w * 1.4);
    group.add(spray.group);
    group.add(fallFoam());
    const vp = new THREE.Vector2();
    ctx.onUpdate((dt, t) => {
      wm.flame.uniforms.uTime.value = t; wm.fall.uniforms.uTime.value = t;
      ctx.renderer.getDrawingBufferSize(vp);
      const cam = ctx.camera as THREE.PerspectiveCamera;
      const ps = vp.y / (2 * Math.tan(((cam.fov ?? 60) * Math.PI) / 360));
      ffx.tick(t, ps); spray.tick(t, ps);
      bl.visible = Math.hypot(cam.position.x - SHIP.x, cam.position.z - SHIP.z) < 70;
      // ship rooms: only the levels within ~a deck of the camera's eye (ship frame)
      camS.copy(cam.position).applyMatrix4(SHIPI);
      for (const L of intLevels) L.o.visible = noCull || Math.abs(camS.y - (L.y + 1.6)) < 3.3;
    });
    void col; void M; void hb; void HULL; void LANDING;
    console.info(`[wreck-bay] ${n} batches, ${lod.stats()}, veg fallbacks ${veg.fallbacks}, mats ${Math.round(tMats - t0)} ms (async), geometry ${Math.round(tGeo - tMats)} ms (${Object.entries(T).map(([k, v]) => `${k} ${v}`).join(", ")}), batch ${Math.round(performance.now() - tGeo)} ms, build ${Math.round(performance.now() - t0)} ms wall, main-thread busy ${Math.round(BZ.busy)} ms, longest slice ${Math.round(BZ.max)} ms (ending at ${BZ.at})`);
  },
  async stage(ctx, stage) {
    if (stage === "sunset") (await import("./stage")).stageSunset(ctx);
  },
};
export default mod;
