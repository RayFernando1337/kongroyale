import * as THREE from "three";
import { POIS } from "../../shared/world/map";
import { flag } from "./flags";

const PHASE_PLAY = 2;
const cam = new THREE.Vector3();

function detect(): boolean {
  const forced = flag("lowmem");
  if (forced !== null) return forced === "1";
  const ua = navigator.userAgent;
  const webkitOnly = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua);
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return webkitOnly || (mem !== undefined && mem < 8);
}

let on = false;

export function lowMemoryDevice(): boolean {
  on = detect();
  const kr = (globalThis as unknown as { __kr?: { lowMem?: boolean } }).__kr;
  if (kr) kr.lowMem = on;
  return on;
}

function playing(): boolean {
  const game = (globalThis as unknown as { __kr?: { game?: { inMatch?: boolean; cm?: { phase?: number } } } }).__kr?.game;
  return !!game?.inMatch && game.cm?.phase === PHASE_PLAY;
}

function nearModule(pending: string[], camera: THREE.Camera): string | null {
  if (!playing()) return null;
  cam.setFromMatrixPosition(camera.matrixWorld);
  let best: string | null = null, bestD = flag("lowmemr");
  for (const id of pending) {
    const p = POIS.find((x) => `poi:${x.id}` === id);
    if (!p) return id;
    const d = Math.hypot(cam.x - p.x, cam.y - (p.padY ?? 0), cam.z - p.z) - p.r;
    if (d < bestD) { best = id; bestD = d; }
  }
  return best;
}

export async function nextModule(pending: string[], camera: THREE.Camera): Promise<string> {
  if (!on) return pending.shift()!;
  for (;;) {
    const id = nearModule(pending, camera);
    if (id) { pending.splice(pending.indexOf(id), 1); return id; }
    await new Promise((r) => setTimeout(r, 250));
  }
}
