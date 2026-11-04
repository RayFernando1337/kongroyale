// STORM VISUAL CONTRACT (gameplay-internal). The storm module implements ./index.ts `createStormVisual(ctx)`.
// Gameplay drives it from the authoritative storm state; the visual never decides gameplay.
import type * as THREE from "three";

export interface StormCircle {
  /** current (damaging outside) circle */
  cx: number; cz: number; r: number;
  /** the next circle the wall is shrinking toward (== current while holding) */
  tx: number; tz: number; tr: number;
  /** true while the wall is moving */
  shrinking: boolean;
  /** 0 = not announced yet (no wall), 1..N = storm phase */
  phase: number;
}

export interface StormVisual {
  /** update the circle (call whenever the sim state changes; cheap) */
  set(c: StormCircle): void;
  /** per frame. Returns how deep inside the storm the camera is, 0 (safe) .. 1 (fully inside). */
  update(dt: number, t: number, cam: THREE.PerspectiveCamera): number;
  /** last `update` result */
  readonly inside: number;
  /** force a lightning flash now (server event) */
  flash(strength?: number): void;
  setVisible(v: boolean): void;
  compile(renderer: THREE.WebGLRenderer): Promise<unknown>;
  dispose(): void;
}
