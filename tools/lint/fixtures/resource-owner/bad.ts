import * as THREE from "three";
import { TextureLoader } from "three";
import type { Scope } from "../../../../client/src/engine/res/scope";
declare const scope: Scope, pool: { worker(w: Worker): Worker }, match: Scope;
export const a = new THREE.DataTexture(new Uint8Array(4), 1, 1); // lint-expect
export const b = new THREE.WebGLRenderTarget(4, 4); // lint-expect
export const c = new Worker(new URL("./w.ts", import.meta.url), { type: "module" }); // lint-expect
export const d = new TextureLoader(); // lint-expect
export const e = [new THREE.CanvasTexture(document.createElement("canvas"))]; // lint-expect
export const f = scope.texture("tex.ui", new THREE.Texture()).copy(new THREE.CanvasTexture(document.createElement("canvas"))); // lint-expect
export const g = pool.worker(new Worker(new URL("./w.ts", import.meta.url), { type: "module" })); // lint-expect
export const h = new THREE.CubeTextureLoader(); // lint-expect
export const i = match.target(new THREE.WebGLRenderTarget(4, 4)); // lint-expect
export const j = scope.own("other", new THREE.TextureLoader() as unknown as { dispose(): void }); // lint-expect
