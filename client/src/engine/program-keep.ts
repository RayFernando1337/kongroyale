import type * as THREE from "three";
import { contextEpoch } from "./res/restore";

const kept = new Map<string, THREE.Material>();
let keptEpoch = 0;

export function retireMaterial(renderer: THREE.WebGLRenderer, m: THREE.Material) {
  if (keptEpoch !== contextEpoch()) { kept.clear(); keptEpoch = contextEpoch(); }
  const program = (renderer.properties.get(m) as { currentProgram?: { cacheKey: string } }).currentProgram;
  if (program && !kept.has(program.cacheKey)) { kept.set(program.cacheKey, m); return; }
  m.dispose();
}
