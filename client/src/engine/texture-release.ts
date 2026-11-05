import type * as THREE from "three";
import { flag } from "../flags";
import { onRestore, unrestorable } from "./res/restore";

type Pixels = { data?: ArrayBufferView | null; width: number; height: number; depth?: number };
type Source = THREE.Texture["source"]["data"];

const ENABLED = flag("texfree");

export function releaseAfterUpload<T extends THREE.Texture>(t: T, rebuild?: () => Source | Promise<Source>): T {
  if (!ENABLED) return t;
  t.onUpdate = dropSource;
  const done = rebuild
    ? onRestore("source", async () => { t.source.data = await rebuild(); t.onUpdate = dropSource; t.needsUpdate = true; })
    : unrestorable();
  t.addEventListener("dispose", done);
  return t;
}

export function shareTexture<T extends THREE.Texture>(t: T): T {
  const version = t.source.version;
  const c = releaseAfterUpload(t.clone() as T, () => t.source.data);
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
