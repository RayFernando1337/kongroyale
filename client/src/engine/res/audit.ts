import * as THREE from "three";
import { geometryBytes, resources, targetBytes, textureBytes, type Report } from "./scope";

type Kind = "geometry" | "texture" | "target";
type Held = THREE.BufferGeometry | THREE.Texture | THREE.RenderTarget;
type Totals = { count: number; bytes: number };

export interface Audit {
  owned: Totals;
  unowned: Totals & { byKind: Record<Kind, Totals> };
  names: Record<string, Totals>;
  info: { geometries: number; textures: number };
  ledger: Report;
}

const kindOf = (o: object): Kind | null =>
  (o as THREE.BufferGeometry).isBufferGeometry ? "geometry" : (o as THREE.RenderTarget).isRenderTarget ? "target" : (o as THREE.Texture).isTexture ? "texture" : null;

const bytesOf = (kind: Kind, o: Held) =>
  kind === "geometry" ? geometryBytes(o as THREE.BufferGeometry) : kind === "target" ? targetBytes(o as THREE.RenderTarget) : textureBytes(o as THREE.Texture);

export function auditRenderer(renderer: () => THREE.WebGLRenderer | undefined): () => Audit {
  const held = new Set<Held>();
  const add = THREE.EventDispatcher.prototype.addEventListener;
  const forget = (e: { target: Held }) => { held.delete(e.target); };
  THREE.EventDispatcher.prototype.addEventListener = function (this: THREE.EventDispatcher, type: string, listener: unknown) {
    add.call(this, type as never, listener as never);
    if (type !== "dispose" || listener === forget || !kindOf(this)) return;
    const o = this as unknown as Held;
    if (held.has(o)) return;
    held.add(o);
    add.call(this, "dispose" as never, forget as never);
  } as typeof add;

  return () => {
    const attached = new Set<THREE.Texture>();
    for (const o of held) {
      if (!(o as THREE.RenderTarget).isRenderTarget) continue;
      const rt = o as THREE.RenderTarget;
      for (const t of rt.textures) attached.add(t);
      if (rt.depthTexture) attached.add(rt.depthTexture);
    }
    const totals = (): Totals => ({ count: 0, bytes: 0 });
    const out: Audit = { owned: totals(), unowned: { ...totals(), byKind: { geometry: totals(), texture: totals(), target: totals() } }, names: {}, info: { geometries: 0, textures: 0 }, ledger: resources.report() };
    for (const o of held) {
      const kind = kindOf(o) as Kind;
      if (kind === "texture" && attached.has(o as THREE.Texture)) continue;
      const bytes = bytesOf(kind, o);
      if (resources.ownerOf(o)) { out.owned.count++; out.owned.bytes += bytes; continue; }
      out.unowned.count++;
      out.unowned.bytes += bytes;
      out.unowned.byKind[kind].count++;
      out.unowned.byKind[kind].bytes += bytes;
      const n = (out.names[kind + " " + ((o as { name?: string }).name || (o as { type?: string }).type || o.constructor.name)] ??= totals());
      n.count++;
      n.bytes += bytes;
    }
    const r = renderer();
    if (r) out.info = { geometries: r.info.memory.geometries, textures: r.info.memory.textures };
    return out;
  };
}
