import assert from "node:assert/strict";
import * as THREE from "three";
import { Ledger, withScope, textureBytes, targetBytes, geometryBytes } from "../../client/src/engine/res/scope";

const disposed = (o: THREE.EventDispatcher<{ dispose: object }>) => { const s = { hit: 0 }; o.addEventListener("dispose", () => { s.hit++; }); return s; };
const tri = () => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3)); return g; };
const mb = (r: ReturnType<Ledger["report"]>, k: keyof ReturnType<Ledger["report"]>["byCategory"]) => r.byCategory[k];

{
  const res = new Ledger();
  const match = res.root.child("match");
  const geo = match.geometry("geo.actor", tri());
  const mat = match.material(new THREE.MeshBasicMaterial());
  const tex = match.texture("tex.actor", new THREE.DataTexture(new Uint8Array(16), 2, 2));
  const mesh = new THREE.Mesh(geo, mat);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const order: string[] = [];
  match.defer(() => { order.push("remove mesh"); mesh.removeFromParent(); });
  match.defer(() => order.push("overlay"));
  const g = disposed(geo), m = disposed(mat), t = disposed(tex);

  const r = res.report();
  assert.deepEqual(mb(r, "geo.actor"), { count: 1, bytes: 36 });
  assert.deepEqual(mb(r, "tex.actor"), { count: 1, bytes: 16 });
  assert.equal(r.byScope["app/match"].count, 3);
  assert.equal(r.scopes, 2);

  match.dispose();
  assert.deepEqual([g.hit, m.hit, t.hit], [1, 1, 1]);
  assert.deepEqual(order, ["overlay", "remove mesh"]);
  assert.equal(scene.children.length, 0);
  const after = res.report();
  assert.equal(after.scopes, 1);
  assert.deepEqual(mb(after, "geo.actor"), { count: 0, bytes: 0 });
  assert.throws(() => match.geometry("geo.actor", tri()), /disposed/);
  match.dispose();
  assert.deepEqual([g.hit, m.hit, t.hit], [1, 1, 1]);
  console.log("PASS  a match scope frees what it owns and runs its finalizers, last first");
}

{
  const res = new Ledger();
  const a = res.root.child("a"), b = res.root.child("b");
  const shared = a.geometry("geo.world", tri());
  assert.throws(() => b.geometry("geo.world", shared), /owned by scope app\/a/);
  assert.throws(() => a.geometry("geo.world", shared), /owned twice/);
  console.log("PASS  one owner per resource");
}

{
  const res = new Ledger();
  const region = res.root.child("region:poi:x");
  const props = region.child("props");
  const g = disposed(props.geometry("geo.world", tri()));
  const w = { terminated: 0, terminate() { this.terminated++; } };
  region.worker(w as unknown as Worker);
  region.dispose();
  assert.equal(g.hit, 1);
  assert.equal(w.terminated, 1);
  assert.equal(props.isDisposed, true);
  assert.equal(res.report().scopes, 1);
  console.log("PASS  disposing a scope disposes its children and terminates its workers");
}

{
  const res = new Ledger();
  let rt: THREE.WebGLRenderTarget | null = null;
  await assert.rejects(withScope(res.root, "bake", (s) => { rt = s.target(new THREE.WebGLRenderTarget(4, 4)); throw new Error("bake failed"); }), /bake failed/);
  assert.ok(rt);
  assert.equal(res.ownerOf(rt!), undefined);
  assert.equal(res.report().scopes, 1);
  console.log("PASS  withScope frees a transient target even when the bake throws");
}

{
  const res = new Ledger();
  const s = res.root.child("s");
  const bad = { dispose() { throw new Error("boom"); } };
  const good = disposed(s.geometry("geo.world", tri()));
  s.own("other", bad);
  assert.throws(() => s.dispose(), (e: unknown) => e instanceof AggregateError && e.errors.length === 1);
  assert.equal(good.hit, 1);
  assert.equal(s.isDisposed, true);
  console.log("PASS  one resource failing to free does not stop the rest");
}

{
  const res = new Ledger();
  const g = res.root.geometry("geo.world", tri());
  const t = res.root.texture("tex.world", new THREE.DataTexture(new Uint8Array(16), 2, 2));
  assert.deepEqual(res.report().uploaded, { geometries: 0, textures: 0 });
  (g.attributes.position as THREE.BufferAttribute).onUploadCallback();
  t.onUpdate?.(t);
  assert.deepEqual(res.report().uploaded, { geometries: 1, textures: 1 });
  const ib = new THREE.InterleavedBuffer(new Float32Array(12), 6);
  const ig = new THREE.BufferGeometry();
  ig.setAttribute("position", new THREE.InterleavedBufferAttribute(ib, 3, 0));
  ig.setAttribute("normal", new THREE.InterleavedBufferAttribute(ib, 3, 3));
  res.root.geometry("geo.world", ig);
  ib.onUploadCallback();
  assert.equal(res.report().uploaded.geometries, 2);
  assert.equal(geometryBytes(ig), 48);
  console.log("PASS  uploads are counted for plain and interleaved geometry and for textures");
}

{
  const lazy = new THREE.Texture();
  assert.equal(textureBytes(lazy), 0);
  (lazy as { image: unknown }).image = { width: 64, height: 32 };
  lazy.minFilter = THREE.LinearMipmapLinearFilter;
  assert.equal(textureBytes(lazy), Math.round(64 * 32 * 4 * 4 / 3));
  const half = new THREE.DataTexture(new Uint16Array(4 * 4 * 2), 4, 4, THREE.RGFormat, THREE.HalfFloatType);
  assert.equal(textureBytes(half), 4 * 4 * 2 * 2);
  const rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType, depthBuffer: true });
  assert.equal(targetBytes(rt), 8 * 8 * 8 + 8 * 8 * 4);
  rt.setSize(16, 16);
  assert.equal(targetBytes(rt), 16 * 16 * 8 + 16 * 16 * 4);
  console.log("PASS  bytes are measured at read time: a late image, a resized target");
}

console.log("resource scopes: all checks passed");
