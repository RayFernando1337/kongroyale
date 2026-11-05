# Resources

Every GPU texture, render target and worker the client creates has one owner: a resource scope. Files load through one asset cache. The `resource-owner` lint rule enforces both.

## Scopes

A scope owns resources and frees all of them when it is disposed. Scopes form a tree, and disposing a scope disposes its children first. The API is `client/src/engine/res/scope.ts`.

| scope | lifetime | holds |
|---|---|---|
| `resources.root` | the page | the renderer's own targets and anything shared for the whole session |
| `region:<id>` | while a world module is built | one module's geometry, materials and textures |
| `match` | one match, from start to leaving | `GameRender` and everything it creates |
| a transient scope (`withScope`) | one call | bake targets, readback buffers |

A scope takes ownership of an object you have just made and returns it, so the call site reads like the code it replaces:

```ts
import { resources, withScope, type Scope } from "../engine/res/scope";

const matchScope: Scope = resources.root.child("match");
const geo = matchScope.geometry("geo.actor", new THREE.CapsuleGeometry(0.09, 0.4, 4, 8));
const tex = matchScope.texture("tex.ui", new THREE.CanvasTexture(canvas));
matchScope.defer(() => overlay.remove());
matchScope.dispose();

await withScope(resources.root, "bake:impostor", async (scope) => {
  const rt = scope.target(new THREE.WebGLRenderTarget(size, size));
  renderBake(rt);
});
```

Rules the module enforces:

- An object has one owner. Handing it to a second scope throws and names both scopes.
- `dispose()` frees children first, then what the scope owns and its `defer` callbacks together, newest first. A failure doesn't stop the rest; the scope closes and throws one `AggregateError`.
- A disposed scope refuses new resources.
- `resources.report()` gives count and bytes per category (`tex.world`, `tex.actor`, `tex.ui`, `geo.world`, `geo.actor`, `target`, `audio`, `other`) and per scope, measured when it is read.

## The lint rule

Outside `client/src/engine/res/`, a `new` of a `*Texture`, a `*RenderTarget` or a `Worker` must be handed straight to a scope as it is created: `scope.texture(cat, new ...)`, `scope.target(new ...)`, `scope.worker(new Worker(...))`. The scope must be a variable or property named `scope`, `res` or `<name>Scope`, or `resources.root`, so a reader can see who frees it.

Today's sites are listed in `tools/lint/baseline.json`. The list only shrinks: move a site onto a scope and delete its entry.

## One asset cache

A `new *Loader` (`TextureLoader`, `GLTFLoader` and the rest) belongs only in `client/src/engine/assets.ts`, which keeps one loader of each kind and loads each file once. Load files through it instead of making a loader at the call site.
