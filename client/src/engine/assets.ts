// Cached loaders. Every load registers a readiness hold so view-camera stills never capture half-loaded worlds.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { releaseAfterUpload } from "./texture-release";
import { capped, cappedMips } from "./tex-cap";
import { flag } from "../flags";

const KTX2 = flag("ktx2");
const SOURCE_EXT = /\.(webp|jpe?g|png)$/i;
const TRANSCODER_IDLE_MS = 2000;

const BASE = import.meta.env.BASE_URL || "/";
/** resolve a public/ path ("assets/x.glb" or "/assets/x.glb") against the deploy base */
export const assetUrl = (p: string) => (/^(https?:|data:|blob:)/.test(p) ? p : BASE.replace(/\/$/, "") + "/" + p.replace(/^\//, ""));

/** A transient load failure no longer fails a whole module build: Chrome answers a request burst
 *  under memory pressure with net::ERR_INSUFFICIENT_RESOURCES, and one failed webp of the shared coast set rejected
 *  Lookout Point's, The Plantation's and Peel Strip's builds in the same session (an image error Event). 3 tries,
 *  0.4 / 1.2 s apart — a real 404 still fails, ~1.6 s later */
async function retry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) { if (i >= tries - 1) throw e; await new Promise((r) => setTimeout(r, 400 * 3 ** i)); }
  }
}

export class Assets {
  private gltf = new GLTFLoader();
  private tex = new THREE.TextureLoader();
  private cache = new Map<string, Promise<unknown>>();
  readonly maxAniso: number;
  readonly ktx2: KTX2Loader;
  private ktx2Sources: Promise<ReadonlySet<string>> | null = null;
  private transcoderIdle: ReturnType<typeof setTimeout> | undefined;

  constructor(renderer: THREE.WebGLRenderer, private hold: (label: string) => () => void) {
    const draco = new DRACOLoader().setDecoderPath(assetUrl("assets/decoders/draco/"));
    this.ktx2 = new KTX2Loader().setTranscoderPath(assetUrl("assets/actors/basis/")).setWorkerLimit(4).detectSupport(renderer);
    this.gltf.setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(draco).setKTX2Loader(this.ktx2);
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
  }

  private compressed(path: string): Promise<boolean> {
    if (!KTX2) return Promise.resolve(false);
    this.ktx2Sources ??= fetch(assetUrl("assets/ktx2.json")).then((r) => r.json() as Promise<{ sources: string[] }>).then((m) => new Set(m.sources), () => new Set<string>());
    return this.ktx2Sources.then((s) => s.has(path.replace(/^\//, "")));
  }

  private idleTranscoder() {
    clearTimeout(this.transcoderIdle);
    this.transcoderIdle = setTimeout(() => {
      const pool = (this.ktx2 as unknown as { workerPool: { workerStatus: number; queue: unknown[]; dispose(): void } }).workerPool;
      if (pool.workerStatus === 0 && pool.queue.length === 0) pool.dispose();
    }, TRANSCODER_IDLE_MS);
  }

  private once<T>(key: string, make: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      const release = this.hold(key);
      p = make().finally(release);
      this.cache.set(key, p);
    }
    return p;
  }

  model(path: string): Promise<GLTF> {
    return this.once("gltf:" + path, () => retry(() => this.gltf.loadAsync(assetUrl(path))));
  }

  /** color textures get sRGB; pass { srgb: false } for normal/roughness/AO data maps */
  texture(path: string, o: { srgb?: boolean; repeat?: boolean; aniso?: boolean } = {}): Promise<THREE.Texture> {
    const { srgb = true, repeat = true, aniso = true } = o;
    return this.once(`tex:${path}:${srgb}:${repeat}`, async () => {
      const t: THREE.Texture = (await this.compressed(path)) ? cappedMips(await retry(() => this.ktx2.loadAsync(assetUrl(path.replace(SOURCE_EXT, ".ktx2"))))) : await retry(() => this.tex.loadAsync(assetUrl(path))).then((x) => { (x as THREE.Texture).image = capped(x.image); return x; });
      releaseAfterUpload(t);
      if ((t as THREE.CompressedTexture).isCompressedTexture) this.idleTranscoder();
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (aniso) t.anisotropy = this.maxAniso;
      return t;
    });
  }
}
