// The lobby islet's per-frame distance gate for its props on the Low view distance (index.ts registers it as an update
// hook). The props are merged per material into meshes as big as the islet, so the engine's screen-size cull never cuts
// them: from Banana Temple, 1.25 km away, they were 0.39 M triangles in 30 draws on every preset (RAY-288).
import type * as THREE from "three";

/** on the Low view distance (engine/display.ts publishes it as "display:viewDist"), the islet's props stop drawing
 *  beyond this many metres from its centre. The rock, the runway with its paint, the island's terrain and its palms
 *  (the veg area's) stay */
export const LOW_PROPS_M = 600;

/** props draw unless the view distance is Low and the camera is LOW_PROPS_M or more from the islet centre (cx, cz) */
export function gateIsletProps(props: THREE.Object3D, cam: THREE.Vector3, cx: number, cz: number, viewDist: unknown) {
  const dx = cam.x - cx, dz = cam.z - cz;
  props.visible = viewDist !== "low" || dx * dx + dz * dz < LOW_PROPS_M * LOW_PROPS_M;
}
