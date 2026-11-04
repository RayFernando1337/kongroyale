import * as THREE from "three";

export type Category = "tex.world" | "tex.actor" | "tex.ui" | "geo.world" | "geo.actor" | "target" | "audio" | "other";
export const CATEGORIES: readonly Category[] = ["tex.world", "tex.actor", "tex.ui", "geo.world", "geo.actor", "target", "audio", "other"];

type Kind = "texture" | "geometry" | "target" | "material" | "worker" | "other" | "finalizer";
type Disposable = { dispose(): void };
interface Entry {
  kind: Kind;
  cat: Category;
  obj: object;
  free: () => void;
  bytes: () => number;
  uploaded: boolean;
}

export interface Totals { count: number; bytes: number }
export interface Report {
  byCategory: Record<Category, Totals>;
  byScope: Record<string, Totals>;
  uploaded: { geometries: number; textures: number };
  scopes: number;
}

const MIPMAP_FILTERS = new Set<number>([THREE.NearestMipmapNearestFilter, THREE.NearestMipmapLinearFilter, THREE.LinearMipmapNearestFilter, THREE.LinearMipmapLinearFilter]);
const CHANNELS = new Map<number, number>([
  [THREE.AlphaFormat, 1], [THREE.RedFormat, 1], [THREE.RedIntegerFormat, 1], [THREE.DepthFormat, 1], [THREE.DepthStencilFormat, 1],
  [THREE.RGFormat, 2], [THREE.RGIntegerFormat, 2], [THREE.RGBAFormat, 4], [THREE.RGBAIntegerFormat, 4],
]);
const TYPE_BYTES = new Map<number, number>([
  [THREE.UnsignedByteType, 1], [THREE.ByteType, 1], [THREE.ShortType, 2], [THREE.UnsignedShortType, 2], [THREE.HalfFloatType, 2],
  [THREE.IntType, 4], [THREE.UnsignedIntType, 4], [THREE.FloatType, 4], [THREE.UnsignedInt248Type, 4],
  [THREE.UnsignedShort4444Type, 2], [THREE.UnsignedShort5551Type, 2],
]);

const mipScale = (t: THREE.Texture) => (t.generateMipmaps && MIPMAP_FILTERS.has(t.minFilter) ? 4 / 3 : 1);
const texelBytes = (t: THREE.Texture) => (t.format === THREE.DepthStencilFormat || t.type === THREE.UnsignedInt248Type ? 4 : (CHANNELS.get(t.format) ?? 4) * (TYPE_BYTES.get(t.type) ?? 1));

export function textureBytes(t: THREE.Texture): number {
  if ((t as THREE.CompressedTexture).isCompressedTexture) {
    let b = 0;
    for (const m of t.mipmaps ?? []) b += (m as { data?: ArrayBufferView }).data?.byteLength ?? 0;
    return b;
  }
  const img = t.image as { width?: number; height?: number; depth?: number } | null;
  if (!img?.width || !img.height) return 0;
  return Math.round(img.width * img.height * (img.depth ?? 1) * texelBytes(t) * mipScale(t));
}

export function targetBytes(rt: THREE.RenderTarget): number {
  const layers = rt.depth || 1;
  let b = 0;
  for (const t of rt.textures) b += rt.width * rt.height * layers * texelBytes(t) * mipScale(t);
  if (rt.depthTexture) b += rt.width * rt.height * layers * texelBytes(rt.depthTexture);
  else if (rt.depthBuffer) b += rt.width * rt.height * 4;
  return Math.round(b);
}

export function geometryBytes(g: THREE.BufferGeometry): number {
  const seen = new Set<ArrayBufferLike>();
  let b = 0;
  const add = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined) => {
    if (!a) return;
    const arr = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data.array : (a as THREE.BufferAttribute).array;
    if (seen.has(arr.buffer)) return;
    seen.add(arr.buffer);
    b += arr.byteLength;
  };
  for (const a of Object.values(g.attributes)) add(a);
  for (const list of Object.values(g.morphAttributes)) for (const a of list) add(a);
  add(g.index);
  return b;
}

export class Ledger {
  private readonly owners = new Map<object, Scope>();
  private readonly live = new Set<Scope>();
  readonly root: Scope;

  constructor(name = "app") {
    this.root = new Scope(name, this, null);
  }

  claim(obj: object, scope: Scope) {
    const prev = this.owners.get(obj);
    if (prev && prev !== scope) throw new Error("resource already owned by scope " + prev.path + ", cannot also be owned by " + scope.path);
    if (prev) throw new Error("resource owned twice by scope " + scope.path);
    this.owners.set(obj, scope);
  }

  release(obj: object) { this.owners.delete(obj); }
  ownerOf(obj: object): Scope | undefined { return this.owners.get(obj); }
  opened(s: Scope) { this.live.add(s); }
  closed(s: Scope) { this.live.delete(s); }

  report(): Report {
    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, { count: 0, bytes: 0 }])) as Record<Category, Totals>;
    const byScope: Record<string, Totals> = {};
    const uploaded = { geometries: 0, textures: 0 };
    for (const s of this.live) {
      const own = (byScope[s.path] = { count: 0, bytes: 0 });
      for (const e of s.entries()) {
        const b = e.bytes();
        own.count++; own.bytes += b;
        byCategory[e.cat].count++; byCategory[e.cat].bytes += b;
        if (e.uploaded && e.kind === "geometry") uploaded.geometries++;
        if (e.uploaded && e.kind === "texture") uploaded.textures++;
        if (e.kind === "finalizer") { own.count--; byCategory[e.cat].count--; }
      }
    }
    return { byCategory, byScope, uploaded, scopes: this.live.size };
  }
}

export class Scope {
  private readonly owned: Entry[] = [];
  private readonly children: Scope[] = [];
  private disposed = false;
  readonly path: string;

  constructor(readonly name: string, private readonly ledger: Ledger, private readonly parent: Scope | null) {
    this.path = parent ? parent.path + "/" + name : name;
    ledger.opened(this);
  }

  get isDisposed() { return this.disposed; }
  entries(): readonly Entry[] { return this.owned; }

  child(name: string): Scope {
    this.alive();
    const c = new Scope(name, this.ledger, this);
    this.children.push(c);
    return c;
  }

  texture<T extends THREE.Texture>(cat: Category, t: T): T {
    const e = this.add("texture", cat, t, () => t.dispose(), () => textureBytes(t));
    const prev = t.onUpdate;
    t.onUpdate = (x: THREE.Texture) => { e.uploaded = true; prev?.(x); };
    return t;
  }

  geometry<T extends THREE.BufferGeometry>(cat: Category, g: T): T {
    const e = this.add("geometry", cat, g, () => g.dispose(), () => geometryBytes(g));
    for (const a of Object.values(g.attributes)) {
      const buf = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data : (a as THREE.BufferAttribute);
      const prev = buf.onUploadCallback;
      buf.onUploadCallback = function (this: unknown) { e.uploaded = true; prev.call(this); };
    }
    return g;
  }

  target<T extends THREE.RenderTarget>(rt: T): T {
    this.add("target", "target", rt, () => rt.dispose(), () => targetBytes(rt));
    return rt;
  }

  material<T extends THREE.Material>(m: T): T {
    this.add("material", "other", m, () => m.dispose(), () => 0);
    return m;
  }

  worker(w: Worker): Worker {
    this.add("worker", "other", w, () => w.terminate(), () => 0);
    return w;
  }

  own<T extends Disposable>(cat: Category, obj: T, bytes: () => number = () => 0): T {
    this.add("other", cat, obj, () => obj.dispose(), bytes);
    return obj;
  }

  defer(fn: () => void): void {
    const key = {};
    this.add("finalizer", "other", key, fn, () => 0);
  }

  dispose() {
    if (this.disposed) return;
    for (let i = this.children.length - 1; i >= 0; i--) this.children[i].dispose();
    this.children.length = 0;
    const errors: unknown[] = [];
    for (let i = this.owned.length - 1; i >= 0; i--) {
      const e = this.owned[i];
      this.ledger.release(e.obj);
      try { e.free(); } catch (err) { errors.push(err); }
    }
    this.owned.length = 0;
    this.disposed = true;
    this.ledger.closed(this);
    if (this.parent && !this.parent.disposed) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
    }
    if (errors.length) throw new AggregateError(errors, "scope " + this.path + ": " + errors.length + " resource(s) failed to free");
  }

  private alive() {
    if (this.disposed) throw new Error("scope " + this.path + " is disposed");
  }

  private add(kind: Kind, cat: Category, obj: object, free: () => void, bytes: () => number): Entry {
    this.alive();
    this.ledger.claim(obj, this);
    const e: Entry = { kind, cat, obj, free, bytes, uploaded: false };
    this.owned.push(e);
    return e;
  }
}

export async function withScope<T>(parent: Scope, name: string, fn: (s: Scope) => Promise<T> | T): Promise<T> {
  const s = parent.child(name);
  try { return await fn(s); } finally { s.dispose(); }
}

export const resources = new Ledger();
