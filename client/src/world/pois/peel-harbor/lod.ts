// PEEL HARBOR / THE WRECK — distance LOD for the POI's pieces (without it the harbor draws full detail and casts
// into every cascade from anywhere on the island).
//   lod.add(obj, { show: 140 })               → obj is drawn only within 140 m of the camera (distance from the camera to
//                                               the closest point of its world bounding BOX — a sphere around a merged
//                                               yard-wide group made "within 140 m" true from 300 m away). atmos bakes a
//                                               static far map from the casters at load + draws
//                                               2 near cascades (≤ ~120 m); small parts are built as non-casters.
//   lod.add(obj, { shadow: 80 })              → obj's meshes cast only while the camera is within 80 m (clutter that
//                                               only matters in the near cascade; skipped by the far-map bake)
//   lod.add(far, { hideWithin: 260 })         → a far proxy: drawn only BEYOND 260 m
//   lod.pair(detail, proxy, 180)              → detail within 180 m, proxy beyond — BOTH measured to the DETAIL's box, so
//                                               exactly one of them is drawn at every camera position (measuring the
//                                               proxy to its own, bigger box left an HLOD hole where both hid)
//   lod.containers(set)                       → drive a ContainerSet's full-model/box LOD in local space
// Distances are evaluated when the camera moves > 2 m or every 30 frames — a few hundred checks, no allocations.
//
// OFF-SCREEN CULL (a harbor that is not in the shot should cost no draws): every direct
// child of the root is also tested EVERY FRAME against the view frustum with its world BOX (three's bounding spheres
// around a 400 m slab / a 300 m lamp set are always "in view"). A child that does not cast is hidden whenever its box is
// off-screen; a casting child only when it is ALSO beyond the shadow cascades' reach (CAST_REACH m — a crane behind you
// still throws its shadow into the frame). The static far map is unaffected: every static caster is baked from the
// POI's force-shown stand-in (harbor-geo farBakeStandIn), never from the live groups.
import * as THREE from "three";
import type { ContainerSet } from "../_kit/containers";
import { flag } from "../../../flags";

interface Entry { obj: THREE.Object3D; ref: THREE.Object3D; box: THREE.Box3; show: number; hideWithin: number; showAir: number; hideAir: number; shadow: number; casters: THREE.Mesh[]; pairOf?: Entry }
interface Kid { obj: THREE.Object3D; box: THREE.Box3; casts: boolean }
/** above this camera height (world y) the `air` distances apply (the crane / ship swap to their proxies at 150 m on
 *  the ground, but the elevated poi-01 view and the plane keep the detail to ~320 m) */
export const AIR_Y = 20;
/** a casting group off-screen still shadows the frame while it is within this distance (cascade 1 reaches ~220 m) */
const CAST_REACH = 240;
/** world boxes are padded by this much for the frustum test (the camera may move after the update hooks ran) */
const PAD = 6;
/** ground hysteresis up to the air distance (?harborhyst=0 = the old AIR_Y swap, A/B) */
const HYST = flag("harborhyst");

export class HarborLod {
  private entries: Entry[] = [];
  private sets: ContainerSet[] = [];
  private last = new THREE.Vector3(1e9, 0, 0);
  private frames = 0;
  private inv = new THREE.Matrix4();
  private local = new THREE.Vector3();
  /** distance-LOD decision per registered object (the off-screen cull ANDs with it for direct children) */
  private distVis = new Map<THREE.Object3D, boolean>();
  private kids: Kid[] = [];
  /** entries that are direct children of the root but not culled kids (empty boxes): plain distance LOD */
  private loose: Entry[] = [];
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  /** set false to disable the off-screen cull (debug: `?harborNoCull`) */
  cull = !flag("harborNoCull");
  /** `?nocull` (for the collider ≡ visual parity check) — every DETAIL tier is drawn at any distance
   *  and the far proxies stay hidden, so the tool compares the colliders with what a player sees up close */
  nearAll = flag("nocull");
  constructor(readonly root: THREE.Object3D) {}

  /** `ref`: measure the distance to THIS object's bounding box instead of obj's own (a proxy paired with its detail) */
  add(obj: THREE.Object3D, o: { show?: number; hideWithin?: number; shadow?: number; ref?: THREE.Object3D; showAir?: number; hideAir?: number } = {}) {
    const show = o.show ?? Infinity, hide = o.hideWithin ?? -1;
    this.entries.push({ obj, ref: o.ref ?? obj, box: new THREE.Box3(), show, hideWithin: hide, showAir: o.showAir ?? show, hideAir: o.hideAir ?? hide, shadow: o.shadow ?? Infinity, casters: [] });
    return obj;
  }
  /** detail ≤ dist < proxy, one metric (the detail's box): never both hidden, never both drawn. `air`: the switch
   *  distance while the camera is above AIR_Y */
  pair(detail: THREE.Object3D, proxy: THREE.Object3D, dist: number, o: { shadow?: number; air?: number; instant?: boolean } = {}) {
    // A detail ↔ proxy switch flips `visible`, which the engine's module visibility fade (engine/cull.ts) turns into
    // a 0.3 s SCALE fade about the bounding centre — the 56 m crane would shrink into its proxy and grow back, the
    // ship, the sheds and the tanks likewise at 150–330 m (and again at landing, when the camera crosses AIR_Y and
    // the distance jumps 330 → 150).
    //   default  → NO swap: the detail is resident at every distance; the proxy stays built but hidden — still the far
    //              shadow map's forced caster (userData.farShadow "force") and the cascade-1 caster source (harbor-c1)
    //   instant  → the swap stays (draw calls: the shed clusters, lamps, tank farm) but far out, ONE distance on the ground
    //              and in the air, and as a plain cut (userData.noCull: no shrink / grow) between two look-alike models
    void o.air;
    if (!o.instant) { this.add(detail, { shadow: o.shadow }); proxy.visible = false; return; }
    detail.userData.noCull = true; proxy.userData.noCull = true;
    this.add(detail, { show: dist, shadow: o.shadow });
    const d = this.entries[this.entries.length - 1];
    this.add(proxy, { hideWithin: dist, ref: detail });
    this.entries[this.entries.length - 1].pairOf = d;
  }
  containers(set: ContainerSet) { this.sets.push(set); }

  /** compute world bounds once everything is built */
  finish() { const it = this.finishSteps(); while (!it.next().done) { /* sync */ } }
  /** finish() in time slices (the bounds of every LOD entry / child: instanced meshes walk all instances) */
  async finishAsync(yieldFn: () => Promise<void>) { const it = this.finishSteps(); while (!it.next().done) await yieldFn(); }
  private *finishSteps(): Generator<void, void, void> {
    this.root.updateMatrixWorld(true);
    let t0 = performance.now();
    const tick = () => { if (performance.now() - t0 > 10) { t0 = performance.now(); return true; } return false; };
    for (const e of this.entries) {
      if (tick()) yield;
      e.box.setFromObject(e.ref);
      if (e.box.isEmpty()) { e.box.set(new THREE.Vector3(0, -1e6, 0), new THREE.Vector3(0, -1e6, 0)); continue; }
      e.obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.castShadow) e.casters.push(m); });
    }
    this.kids = [];
    for (const c of this.root.children) {
      if (tick()) yield;
      // (invisible-by-design children — bake stand-ins, caster-only meshes, the pairs' hidden proxies — are left alone)
      if (!c.visible && !this.entries.some((e) => e.obj === c)) continue;
      // Pop-proof: only a child that neither casts nor has a distance band of its own is culled off-screen,
      // and its switch is INSTANT (userData.noCull keeps the engine's visibility fade off it: it flips while off-screen,
      // a fade would make it grow in at the screen edge when the player turns). A caster stays resident (three's own
      // per-mesh frustum test still skips its draws) — otherwise it would vanish beyond CAST_REACH behind the player and scale
      // back in on every turn; a distance-banded child keeps its (faded) distance switch only.
      const e = this.entries.find((q) => q.obj === c);
      if (e && (isFinite(e.show) || e.hideWithin >= 0 || isFinite(e.showAir) || e.hideAir >= 0)) continue;
      const box = new THREE.Box3();
      // setFromObject(precise = false) uses geometry bounds incl. instanced meshes' computed spheres
      const wasVis = c.visible; c.visible = true; box.setFromObject(c); c.visible = wasVis;
      if (box.isEmpty()) continue;
      let casts = false;
      c.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.castShadow) casts = true; });
      if (casts) continue;
      c.userData.noCull = true;
      this.kids.push({ obj: c, box: box.expandByScalar(PAD), casts });
    }
    const kidSet = new Set(this.kids.map((k) => k.obj));
    this.loose = this.entries.filter((e) => e.obj.parent === this.root && !kidSet.has(e.obj));
  }

  update(camera: THREE.Camera, force = false) {
    const cam = camera.position;
    for (const s of this.sets) {
      this.inv.copy(s.matrixWorld).invert();
      this.local.copy(cam).applyMatrix4(this.inv);
      s.update(this.local, force);
    }
    if (force || ++this.frames >= 30 || cam.distanceToSquared(this.last) >= 4) {
      this.frames = 0; this.last.copy(cam);
      const air = cam.y > AIR_Y;
      for (const e of this.entries) {
        const d = e.box.distanceToPoint(cam);
        let vis = this.nearAll ? e.hideWithin < 0 && e.hideAir < 0 : air ? d < e.showAir && d >= e.hideAir : d < e.show && d >= e.hideWithin;
        // no swap for crossing AIR_Y: landing 150–330 m from the ship / a shed would swap it from its detail
        // (air rule) to its proxy (ground rule) right as the player touches down. On the ground a detail that is still
        // drawn stays drawn until the AIR distance (hysteresis: show … showAir); a pair's proxy is exactly its detail's
        // complement, so the two can never both hide or both draw
        if (HYST && !this.nearAll && !air && !vis && e.showAir > e.show && this.distVis.get(e.obj) && d < e.showAir && d >= e.hideWithin) vis = true;
        if (!this.nearAll && e.pairOf) vis = !(this.distVis.get(e.pairOf.obj) ?? false);
        this.distVis.set(e.obj, vis);
        if (e.obj.parent !== this.root && e.obj.visible !== (vis && !e.obj.userData.abHide)) e.obj.visible = vis && !e.obj.userData.abHide;
        if (isFinite(e.shadow)) { const cast = vis && d < e.shadow; for (const m of e.casters) if (m.castShadow !== cast) m.castShadow = cast; }
      }
    }
    // per frame: direct children = distance decision AND (on screen OR still able to shadow the frame)
    const doCull = this.cull && this.kids.length > 0;
    if (doCull) {
      camera.updateMatrixWorld();
      this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.pv);
    }
    for (const k of this.kids) {
      // (userData.abHide: an A/B tool hides a child for its paired comparison — the per-frame cull must not undo it)
      let vis = !k.obj.userData.abHide && (this.distVis.get(k.obj) ?? true);
      if (vis && doCull && !this.frustum.intersectsBox(k.box)) vis = k.casts && k.box.distanceToPoint(cam) < CAST_REACH;
      if (k.obj.visible !== vis) k.obj.visible = vis;
    }
    // registered entries that are direct children but were skipped as kids (empty boxes): plain distance LOD
    for (const e of this.loose) { const v = !e.obj.userData.abHide && (this.distVis.get(e.obj) ?? true); if (e.obj.visible !== v) e.obj.visible = v; }
  }
}
