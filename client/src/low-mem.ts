import * as THREE from "three";
import type { Poi } from "../../shared/world/map";
import { Phase } from "../../shared/sim/match";

export function lowMemoryDevice(forced: string | null, fullPrepare: boolean): boolean {
  const ua = navigator.userAgent;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const on = !fullPrepare && (forced !== null ? forced === "1" : (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) || (mem !== undefined && mem < 8));
  const kr = (globalThis as unknown as { __kr?: { lowMem?: boolean; streamed?: boolean } }).__kr;
  if (kr) { kr.lowMem = on; if (on) kr.streamed = true; }
  return on;
}

type Session = { game?: { inMatch?: boolean; cm?: { phase: number } | null }; caster?: { casting?: boolean } };

const VIEW_HALF_H_M = 150;
const OFFSCREEN_RANK_M = 1e6;
let viewBuilds = 0, pickedByView = false;
const view = new THREE.Frustum(), viewProj = new THREE.Matrix4(), poiSphere = new THREE.Sphere();

function nearModule(pending: string[], camera: THREE.Camera, pois: readonly Poi[], radiusM: number, viewCap: number): string | null {
  const kr = (globalThis as unknown as { __kr?: Session }).__kr;
  const casting = !!kr?.caster?.casting;
  if (!kr?.game?.inMatch && !casting) return null;
  const airborne = !casting && (kr?.game?.cm?.phase ?? Phase.Play) <= Phase.Plane;
  const overview = airborne && viewBuilds < viewCap;
  if (overview) view.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const e = camera.matrixWorld.elements;
  let best: string | null = null, bestD = Infinity;
  for (const id of pending) {
    const p = pois.find((x) => `poi:${x.id}` === id);
    if (!p) return id;
    const d = Math.hypot(e[12] - p.x, e[14] - p.z) - p.r;
    const near = (airborne ? Math.hypot(d, e[13] - (p.padY ?? 0)) : d) < radiusM;
    const seen = overview && view.intersectsSphere(poiSphere.set(poiSphere.center.set(p.x, (p.padY ?? 0) + VIEW_HALF_H_M, p.z), Math.hypot(p.r, VIEW_HALF_H_M)));
    if (!seen && !near) continue;
    const rank = overview && !seen ? d + OFFSCREEN_RANK_M : d;
    if (rank < bestD) { best = id; bestD = rank; pickedByView = !near; }
  }
  return best;
}

export async function nextNearModule(pending: string[], camera: THREE.Camera, pois: readonly Poi[], radiusM: number, viewCap: number): Promise<string> {
  for (;;) {
    const id = nearModule(pending, camera, pois, radiusM, viewCap);
    if (id) { if (pickedByView) viewBuilds++; pending.splice(pending.indexOf(id), 1); return id; }
    await new Promise((r) => setTimeout(r, 250));
  }
}
