// The sky irradiance the water body is lit by, measured ONCE per environment (atmos bakes its irradiance-sky env per
// preset) instead of a cube-UV IBL lookup in every water pixel: the water's normal is ~up, so its IBL irradiance is one
// value for the whole sea (~0.1 ms at eye level saved). A 1×1 probe renders a white, matte, specular-free up-facing
// plane lit only by the scene environment → exactly three's indirect diffuse term for an up normal; read back once.
import * as THREE from "three";

export class SkyIrradianceProbe {
  /** the measured indirect diffuse (linear, = irradiance / π for a white albedo) */
  readonly value = new THREE.Color(0, 0, 0);
  private env: THREE.Texture | null = null;
  private envI = -1;
  private rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private buf = new Float32Array(4);
  private busy = false;

  constructor() {
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, specularIntensity: 0, envMapIntensity: 1 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), mat);
    plane.rotation.x = -Math.PI / 2;                                   // normal +Y
    plane.frustumCulled = false;
    this.scene.add(plane);
    this.cam.position.set(0, 5, 0); this.cam.up.set(0, 0, -1); this.cam.lookAt(0, 0, 0); this.cam.updateMatrixWorld(true);
  }

  /** re-measure when the scene's environment changed; true when `value` was updated */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Promise<boolean> | null {
    const env = scene.environment as THREE.Texture | null, ei = scene.environmentIntensity ?? 1;
    if (this.busy || (env === this.env && ei === this.envI)) return null;
    this.env = env; this.envI = ei;
    if (!env) { this.value.setRGB(0, 0, 0); return Promise.resolve(true); }
    this.scene.environment = env;
    this.scene.environmentIntensity = ei;
    this.busy = true;
    return this.measure(renderer).finally(() => { this.busy = false; });
  }

  private async measure(renderer: THREE.WebGLRenderer): Promise<boolean> {
    await renderer.compileAsync(this.scene, this.cam);
    const prevRT = renderer.getRenderTarget(), prevTM = renderer.toneMapping, prevXR = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prevRT); renderer.toneMapping = prevTM; renderer.xr.enabled = prevXR;
    const b = await renderer.readRenderTargetPixelsAsync(this.rt, 0, 0, 1, 1, this.buf) as Float32Array;
    if ([b[0], b[1], b[2]].every((v) => Number.isFinite(v) && v >= 0)) this.value.setRGB(b[0], b[1], b[2]);
    return true;
  }
}
