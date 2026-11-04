// PEEL HARBOR — the natural ground around the apron: the headland foot by the pier (the view camera's bottom-left
// foreground: banana plants, monstera, ferns, palms leaning out over the water, mossy boulders on the sand spit), and
// palms + big-leaf clumps fringing the land edges. Plants come from the veg area (ctx.shared "veg" → VegApi.plant) so
// they match the rest of the island. Positions are harbor-local and converted to world matrices here.
import * as THREE from "three";
import { nearestRoad } from "../../../../../shared/world/veg-scatter";
import { APRON, WATER_EDGES, onApron, toLocal, toWorld, worldYaw } from "../../../../../shared/pois/peel-harbor";

/** harbor-local (x, y, z) → world */
const toWorld3 = (lx: number, y: number, lz: number): [number, number, number] => { const [x, z] = toWorld(lx, lz); return [x, y, z]; };
import type { VegApi, PlantKind } from "../../veg/api";
import { hash } from "../_kit/harbor-geo";
import type { PartCtx } from "./parts";

export async function dressBeach(p: PartCtx) {
  const { ctx } = p;
  const veg = ctx.shared.get("veg") as VegApi | undefined;
  if (!veg) return;
  const lists = new Map<PlantKind, THREE.Matrix4[]>();
  /** plant at a harbor-local point: world transform with a local yaw, a lean (tilt) toward local +X (the water) */
  const plant = (kind: PlantKind, lx: number, lz: number, s: number, yaw: number, tilt = 0, minY = 0.35) => {
    if (onApron(lx, lz, -1.5)) return;
    const [x, z] = toWorld(lx, lz);
    // These scenic palms have no shared trunk collider. Keep the approach verge free of visual-only pillars;
    // harbor's real solid cover still comes from JUNGLE_TREES and its authored apron collider list.
    if ((kind === 'palm' || kind === 'palm-leaning' || kind === 'jungle-tree') && nearestRoad(ctx.terrain,x,z).d < 10) return;
    const y = ctx.terrain.height(x, z);
    if (y < minY) return;
    const wy = worldYaw(yaw);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, wy, -tilt, "YXZ"));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.05, z), q, new THREE.Vector3(s, s, s));
    (lists.get(kind) ?? lists.set(kind, []).get(kind)!).push(m);
  };
  // the headland foot beside the pier (local x 866..945, z 472..540): dense tropical understorey + leaning palms
  for (let i = 0; i < 520; i++) {
    const x = 862 + hash(i, 1) * 86, z = 471 + hash(i, 2) * 72;
    const r = hash(i, 3), s = 0.85 + hash(i, 4) * 0.7, yaw = hash(i, 5) * 6.28;
    const kind: PlantKind = r < 0.24 ? "banana-plant" : r < 0.5 ? "monstera" : r < 0.68 ? "fern" : r < 0.84 ? "bush" : r < 0.92 ? "flowers" : "grass";
    plant(kind, x, z, s, yaw, 0, 0.6);
  }
  // the headland's seaward face + top edge above the pier (hide the bare rock steps under a curtain of jungle)
  // (low plants + palms only, and only on the camera end of the headland — trees there would hide the sheds)
  for (let i = 0; i < 300; i++) {
    const x = 852 + hash(i, 61) * 106, z = 478 + hash(i, 62) * 58;
    const r = hash(i, 63);
    plant(r < 0.35 ? "bush" : r < 0.58 ? "fern" : r < 0.8 ? "monstera" : r < 0.92 ? "banana-plant" : "palm", x, z, 0.9 + hash(i, 64) * 0.7, hash(i, 65) * 6.28, 0, 3);
  }
  for (let i = 0; i < 16; i++) {
    const x = 872 + hash(i, 11) * 64, z = 474 + hash(i, 12) * 40;
    // lean out toward the water (local +X): palms at the shore arc over the inlet along the view's left edge
    plant(hash(i, 13) < 0.7 ? "palm-leaning" : "palm", x, z, 0.95 + hash(i, 14) * 0.35, (hash(i, 15) - 0.5) * 0.8, 0.12 + hash(i, 16) * 0.12, 0.8);
  }
  // fringes along the land edges (between the apron kerb and the jungle): palms + banana + monstera clumps
  for (let i = 0; i < APRON.length; i++) {
    if (WATER_EDGES.includes(i)) continue;
    const [ax, az] = APRON[i], [bx, bz] = APRON[(i + 1) % APRON.length];
    const len = Math.hypot(bx - ax, bz - az), n = Math.floor(len / 7);
    let nx = (bz - az) / len, nz = -(bx - ax) / len;
    if (onApron((ax + bx) / 2 + nx * 2, (az + bz) / 2 + nz * 2)) { nx = -nx; nz = -nz; }
    for (let k = 0; k < n; k++) {
      const t = (k + hash(i, k)) / n, off = 3 + hash(k, i, 7) * 12;
      const x = ax + (bx - ax) * t + nx * off, z = az + (bz - az) * t + nz * off;
      const r = hash(i, k, 9);
      plant(r < 0.28 ? "palm" : r < 0.5 ? "banana-plant" : r < 0.72 ? "monstera" : r < 0.86 ? "bush" : "fern", x, z, 0.9 + hash(k, i) * 0.5, hash(k, i, 3) * 6.28, r < 0.28 ? 0.08 : 0);
    }
  }
  // the view camera's bottom-left foreground (big banana + monstera leaves, fern fronds, palm crowns filling
  // the corner, seen from above): tall big-leaf clumps on the headland foot at bearing −38…−52°, 16–38 m from the cam
  {
    const cam = [969.5, 492.3], tg = [858, 393.2], fl = Math.hypot(tg[0] - cam[0], tg[1] - cam[1]);
    const f = [(tg[0] - cam[0]) / fl, (tg[1] - cam[1]) / fl], r = [-f[1], f[0]];
    for (let i = 0; i < 70; i++) {
      const deg = -52 + hash(i, 81) * 15, d = 16 + hash(i, 82) * 22, th = (deg * Math.PI) / 180;
      const lx = cam[0] + d * (Math.cos(th) * f[0] + Math.sin(th) * r[0]), lz = cam[1] + d * (Math.cos(th) * f[1] + Math.sin(th) * r[1]);
      const u = hash(i, 83);
      const kind: PlantKind = u < 0.34 ? "banana-plant" : u < 0.6 ? "monstera" : u < 0.78 ? "fern" : u < 0.9 ? "palm-leaning" : "jungle-tree";
      const sc = kind === "banana-plant" ? 1.3 + hash(i, 84) * 0.5 : kind === "monstera" ? 1.5 + hash(i, 84) * 0.6 : kind === "fern" ? 1.6 : 1.0;
      plant(kind, lx, lz, sc, hash(i, 85) * 6.28, kind === "palm-leaning" ? 0.2 : 0, 0.3);
    }
  }
  // the headland's bare rock blocks (terrain's rocks-*) fill the left fifth of the view's frame (it should read as a
  // jungle corner). Cast rays from the view camera through the bottom-left of the frame against the terrain's rock
  // meshes + the ground (they exist already: terrain builds before the POIs) and root plants exactly where they land —
  // big-leaf clumps on the tops and ledges, hanging vines on the steep faces
  {
    const C = new THREE.Vector3(...toWorld3(969.5, 33.3, 492.3)), T = new THREE.Vector3(...toWorld3(858, 17.3, 393.2));
    const f = T.clone().sub(C).normalize(), r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize(), u = new THREE.Vector3().crossVectors(r, f);
    const ty = Math.tan((50 * Math.PI) / 360), tx = ty * (16 / 9);
    const rocks: THREE.Object3D[] = [];
    ctx.scene.traverse((o) => { if (/^rocks-/.test(o.name) && (o as THREE.Mesh).isMesh) rocks.push(o); });
    const rc = new THREE.Raycaster(); rc.far = 140;
    const nm = new THREE.Matrix3();
    // (each ray walks the rock meshes' triangles, ~4 ms: one build slice holds a few, not all 120 — 0.5 s in one task)
    for (let i = 0; i < 120; i++) {
      await ctx.yield();
      const sx = -1 + hash(i, 91) * 0.46, sy = -1 + hash(i, 92) * 0.95;          // NDC: left 23 % of the frame, lower 48 %
      const dir = f.clone().addScaledVector(r, sx * tx).addScaledVector(u, sy * ty).normalize();
      rc.set(C, dir);
      const hitR = rocks.length ? rc.intersectObjects(rocks, false)[0] : undefined;
      let hit: THREE.Vector3 | null = null, n = new THREE.Vector3(0, 1, 0);
      for (let t = 4; t < 140; t += 0.5) { const q = C.clone().addScaledVector(dir, t); if (ctx.terrain.height(q.x, q.z) >= q.y) { hit = q; break; } }
      if (hitR && (!hit || hitR.distance < C.distanceTo(hit))) {
        hit = hitR.point.clone();
        if (hitR.face) { nm.getNormalMatrix(hitR.object.matrixWorld); n = hitR.face.normal.clone(); if ((hitR.object as THREE.InstancedMesh).isInstancedMesh && hitR.instanceId !== undefined) { const im = new THREE.Matrix4(); (hitR.object as THREE.InstancedMesh).getMatrixAt(hitR.instanceId, im); n.applyMatrix3(new THREE.Matrix3().getNormalMatrix(im)); } n.applyMatrix3(nm).normalize(); }
      } else if (hit) { const tn = ctx.terrain.normal(hit.x, hit.z, [0, 1, 0]) as number[]; n.set(tn[0], tn[1], tn[2]); }
      if (!hit || hit.y < 0.8 || C.distanceTo(hit) < 16 || !Number.isFinite(n.y)) continue;
      const [lx, lz] = toLocal(hit.x, hit.z);
      if (onApron(lx, lz, -2)) continue;
      // (steep faces stay rock — a vine curtain there hung over the whole left third and hid the tank farm)
      if (!(n.y >= 0.45)) continue;
      const k = hash(i, 93), kind: PlantKind = k < 0.34 ? "monstera" : k < 0.58 ? "banana-plant" : k < 0.76 ? "fern" : k < 0.92 ? "bush" : "palm-leaning";
      const tilt = Math.min(0.45, Math.acos(Math.max(-1, Math.min(1, n.y))) * 0.5);
      const sc = kind === "monstera" ? 1.6 + hash(i, 94) * 0.8 : kind === "banana-plant" ? 1.3 + hash(i, 94) * 0.5 : kind === "fern" ? 1.7 : 1.0 + hash(i, 94) * 0.4;
      const yaw = Math.atan2(n.x, n.z) + (hash(i, 95) - 0.5) * 0.8;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, yaw, 0, "YXZ"));
      (lists.get(kind) ?? lists.set(kind, []).get(kind)!).push(new THREE.Matrix4().compose(hit.clone().setY(hit.y - 0.1), q, new THREE.Vector3(sc, sc, sc)));
    }
  }
  for (const [kind, mats] of lists) veg.plant(kind, mats);
}
