import type * as THREE from "three";
import { flag } from "../flags";

type Pixels = { data?: ArrayBufferView | null; close?: () => void };

const ENABLED = flag("texfree");

export function releaseAfterUpload<T extends THREE.Texture>(t: T): T {
  if (ENABLED) t.onUpdate = dropSource;
  return t;
}

function dropSource(t: THREE.Texture) {
  const px = t.source.data as Pixels | null;
  if (!px || px.data === null) return;
  t.onUpdate = null;
  if (typeof ImageBitmap !== "undefined" && px instanceof ImageBitmap) px.close();
  t.source.data = null;
}
