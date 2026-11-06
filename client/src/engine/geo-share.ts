import type * as THREE from "three";
import { flag } from "../flags";

const GEO_SHARE = flag("geoshare");
const pools = new Map<string, Map<string, THREE.BufferAttribute[]>>();

function sameArray(a: THREE.TypedArray | null, b: THREE.TypedArray): boolean {
  if (a === b) return true;
  // ?geofree drops an uploaded attribute's array, so a pooled one may have none left to compare
  if (!a) return false;
  if (a.length !== b.length || a.constructor !== b.constructor) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function intern(pool: Map<string, THREE.BufferAttribute[]>, a: THREE.BufferAttribute): THREE.BufferAttribute {
  const key = `${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.length}`;
  let seen = pool.get(key);
  if (!seen) pool.set(key, (seen = []));
  const same = seen.find((s) => sameArray(s.array, a.array));
  if (same) return same;
  seen.push(a);
  return a;
}

export function shareAttributes(poolId: string, g: THREE.BufferGeometry): void {
  if (!GEO_SHARE) return;
  let pool = pools.get(poolId);
  if (!pool) pools.set(poolId, (pool = new Map()));
  for (const [name, a] of Object.entries(g.attributes)) {
    if (!(a as THREE.BufferAttribute).isBufferAttribute) continue;
    const s = intern(pool, a as THREE.BufferAttribute);
    if (s !== a) g.setAttribute(name, s);
  }
  if (g.index) {
    const s = intern(pool, g.index);
    if (s !== g.index) g.setIndex(s);
  }
}

export function shareGeometries(poolId: string, root: THREE.Object3D): void {
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g?.isBufferGeometry) shareAttributes(poolId, g);
  });
}
