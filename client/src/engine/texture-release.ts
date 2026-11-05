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
  if (px.data === undefined && typeof ImageBitmap !== "undefined" && px instanceof ImageBitmap) px.close();
}
