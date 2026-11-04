import * as THREE from "three";
declare const s: { texture<T>(c: string, t: T): T; target<T>(t: T): T; worker(w: Worker): Worker; own<T>(c: string, o: T): T };
export const a = s.texture("tex.ui", new THREE.DataTexture(new Uint8Array(4), 1, 1));
export const b = s.target(new THREE.WebGLRenderTarget(4, 4));
export const c = s.worker(new Worker(new URL("./w.ts", import.meta.url), { type: "module" }));
export const d = s.own("other", new THREE.TextureLoader());
export const g = new THREE.BoxGeometry(1, 1, 1);
export const m = new THREE.MeshBasicMaterial();
