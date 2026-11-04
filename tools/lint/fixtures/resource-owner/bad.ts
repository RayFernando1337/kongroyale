import * as THREE from "three";
import { TextureLoader } from "three";
declare const s: { texture<T>(c: string, t: T): T; target<T>(t: T): T; worker(w: Worker): Worker; own<T>(c: string, o: T): T };
export const a = new THREE.DataTexture(new Uint8Array(4), 1, 1); // lint-expect
export const b = new THREE.WebGLRenderTarget(4, 4); // lint-expect
export const c = new Worker(new URL("./w.ts", import.meta.url), { type: "module" }); // lint-expect
export const d = new TextureLoader(); // lint-expect
export const e = [new THREE.CanvasTexture(document.createElement("canvas"))]; // lint-expect
export const f = s.texture("tex.ui", new THREE.Texture()).clone(new THREE.WebGL3DRenderTarget(1, 1, 1)); // lint-expect
