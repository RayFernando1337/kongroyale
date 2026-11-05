import type * as THREE from "three";

const kept = new Map<string, THREE.Material>();

export function retireMaterial(renderer: THREE.WebGLRenderer, m: THREE.Material) {
  const program = (renderer.properties.get(m) as { currentProgram?: { cacheKey: string } }).currentProgram;
  if (program && !kept.has(program.cacheKey)) { kept.set(program.cacheKey, m); return; }
  m.dispose();
}
