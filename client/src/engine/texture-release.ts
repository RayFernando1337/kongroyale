import type * as THREE from "three";
import { flag } from "../flags";

type Pixels = { data?: ArrayBufferView | null; width: number; height: number; depth?: number };

const ENABLED = flag("texfree");

export function releaseAfterUpload<T extends THREE.Texture>(t: T): T {
  if (ENABLED) t.onUpdate = dropSource;
  return t;
}

export function shareTexture<T extends THREE.Texture>(t: T): T {
  const version = t.source.version;
  const c = releaseAfterUpload(t.clone() as T);
  c.source.version = version;
  return c;
}

function dropSource(t: THREE.Texture) {
  const px = t.source.data as Pixels | null;
  if (!px || px.data === null) return;
  t.onUpdate = null;
  t.source.data = { width: px.width, height: px.height, depth: px.depth, data: null };
  if (px.data === undefined) freeImage(px);
}

export function freeImage(img: unknown) {
  if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
  else if ((typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement) || (typeof OffscreenCanvas !== "undefined" && img instanceof OffscreenCanvas)) img.width = img.height = 1;
}
