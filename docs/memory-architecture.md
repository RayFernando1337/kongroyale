# Memory architecture: one resource layer

This is the design for how the client creates, owns, caches and frees GPU and CPU resources. It exists because the
browser holds 10 GB at the title and 12.3-12.5 GB from the plane onward on an M4 Mac mini with 16 GB (Chrome on Metal,
whole-browser footprint; every run swapped), and 4.5-7.5 GB on SwiftShader at 640x360 (RAY-104, PSS), which understates
the GPU process. The target is a browser under 4 GB in a match at 1080p, and no growth from one match to the next.

The design has five parts: scopes with explicit lifetimes, one asset cache, a CPU-copy policy, per-category budgets
with residency, and checks that fail the build when a rule breaks. Each part lands as its own small PR, in the order
under [Migration](#migration). Nothing here needs a rewrite.

## What we have today

Measured on main 290a32b, production build, headless Chromium on SwiftShader, 640x360, seed 42 (RAY-104, RAY-105,
RAY-108). The census walks `engine.scene`, attributes each geometry and texture to the world module whose root holds it,
and counts each one once. Texture sizes are estimates (texels × bytes per texel, × 4/3 with mipmaps).

| holder | geometry arrays | texture GPU | texture CPU copy |
|---|---|---|---|
| 17 POIs together | 1095 MB | 1641 MB | 1234 MB |
| helicopter near model (nine 4096² maps) | ~0 | 825 MB | 618 MB |
| kongs | 8 MB | 225 MB | 169 MB |
| atmos | 0.1 MB | 153 MB | 102 MB |
| vegetation | 22 MB | 85 MB, plus 331 MB of impostor arrays | 64 MB |
| chests | 82 MB | 42 MB | 32 MB |
| everything reachable from the scene | 1414 MB | 3127 MB | 2317 MB |

Decoded audio is another 212 MB, and it grows by about 50 MB per match (RAY-104).

Five properties of the code produce these numbers:

1. **Almost everything lives for the whole session.** No world module can unload. `engine/assets.ts` caches every load
   forever. Shared prefabs live in about 64 module-level `Map` caches and 128 lazy singletons that are never freed. So
   memory is the sum of everything the island contains, not of what the player can see.
2. **Everything uploaded is stored twice.** three.js keeps `texture.image` and `attribute.array` after it uploads them,
   and nothing in `client/src` releases them: about 2.3 GB of texture sources and 1.4 GB of vertex arrays.
3. **Caching is ad hoc.** `Assets` has 21 callers. Ten more sites load textures and models with their own loaders
   (actors, terrain, vegetation, the title, and the lobby islet with a second KTX2 transcoder pool), and about 220
   hand-rolled caches build procedural resources. No code can say how much a category holds or who still needs a
   resource.
4. **Disposal is written by hand, class by class, and is partial.** `GameRender.dispose()` calls about 15 other
   `dispose()` methods. Some free materials but not geometries; some only remove objects from the scene. Whether a
   geometry is shared or owned is not written down anywhere, so each `dispose()` either leaks or risks freeing something
   another object still draws.
5. **Audio already has the right shape.** `audio/loader.ts` decodes groups on demand, evicts idle ones and reports
   `pcmBytes`. The resource layer generalises that to every category.

## Principles

The classic tightly engineered games (RollerCoaster Tycoon is the usual example) fixed their memory up front: a known
number of each kind of thing, allocated from pools sized at load, and nothing allocated during play that the design did
not plan for. A browser game can't fix every size at build time, but it can keep the same discipline:

- **Every resource has exactly one owner, and the owner is a scope with a lifetime.** Code never frees a resource it got
  from someone else, and never forgets one it made.
- **Every resource has a category and a byte count.** The layer always knows the total per category.
- **Each category has a budget.** When a category is over, the layer evicts by a rule.
- **Data the GPU has is not kept on the CPU** unless the owner asks for it, by name, with a reason.
- **One place loads each thing once.** Two callers asking for the same file share one resource.

## Scopes

A scope owns resources and frees all of them when it is disposed. Scopes form a tree, and disposing a scope disposes its
children first.

| scope | lifetime | created by | holds |
|---|---|---|---|
| `app` | the page | `main.ts` | the renderer, post-processing targets, shadows, sky, terrain, shared prefabs (kongs, weapons, chests, vehicles), UI atlases |
| `region:<id>` | while a world module is resident | the boot (`buildOne` in `main.ts`) | one module's geometry, materials and textures, and its far proxy |
| `match` | one match, from start to leaving | `game/index.ts` | `GameRender` and everything it creates: views, FX, markers, the storm volume |
| `transient` | one call | the function that opens it | bake targets, readback buffers, worker pools for one build |

The API is `client/src/engine/res/scope.ts`. A scope takes ownership of an object you have just made and returns it,
so the call site reads like the code it replaces:

```ts
type Category = "tex.world" | "tex.actor" | "tex.ui" | "geo.world" | "geo.actor" | "target" | "audio" | "other";
class Scope {
  readonly path: string;
  child(name: string): Scope;
  texture<T extends THREE.Texture>(cat: Category, t: T): T;
  geometry<T extends THREE.BufferGeometry>(cat: Category, g: T): T;
  target<T extends THREE.RenderTarget>(rt: T): T;
  material<T extends THREE.Material>(m: T): T;
  worker(w: Worker): Worker;
  own<T extends { dispose(): void }>(cat: Category, obj: T, bytes?: () => number): T;
  defer(fn: () => void): void;
  dispose(): void;
}
function withScope<T>(parent: Scope, name: string, fn: (s: Scope) => Promise<T> | T): Promise<T>;
const resources: Ledger;
```

Rules the module enforces:

- An object has one owner. Handing the same object to a second scope throws, and names both scopes.
- `dispose()` frees children first, then walks what the scope owns and its `defer` callbacks together, newest first,
  so a finalizer registered after a resource runs before that resource is freed. A child or resource that fails to free
  does not stop the others; the scope finishes, closes, and throws one `AggregateError` with every failure.
- A disposed scope refuses new resources, and live siblings have unique names.
- `resources.report()` gives count and bytes per category and per scope. Geometry bytes count each GPU buffer once (a
  `BufferAttribute` or an `InterleavedBuffer`), and a cube map counts all six faces. Bytes are measured when the report is read, so a texture whose image arrives later, or a render target that
  is resized, is counted at its current size.

## Usage

A match owns what it makes, and the non-resource cleanup that leaving a match needs goes into `defer`, next to the code
it undoes:

```ts
import { resources, type Scope } from "../engine/res/scope";

const match: Scope = resources.root.child("match");
const geo = match.geometry("geo.actor", new THREE.CapsuleGeometry(0.09, 0.4, 4, 8));
const mat = match.material(new THREE.MeshStandardMaterial({ color: "#f5c531" }));
const rocket = new THREE.Mesh(geo, mat);
scene.add(rocket);
match.defer(() => rocket.removeFromParent());
match.defer(() => overlay.remove());

match.dispose();
```

A bake frees its target even when it throws:

```ts
await withScope(resources.root, "bake:impostor", async (s) => {
  const rt = s.target(new THREE.WebGLRenderTarget(size, size));
  renderBake(rt);
});
```

Shared resources (a prefab's geometry, a cached texture) are not handed to a per-match scope: the scope that made them
owns them. The tests in `tools/res/test.mts` run each of these cases.

What changes for each owner:

- **World modules** get `ctx.res`, their region scope, on `WorldCtx`. A module creates through it and no longer frees
  anything by hand. The boot already knows each module's scene roots (`rootsOf` in `main.ts`), so the scope also gives
  per-POI accounting.
- **`GameRender`** gets the match scope. The resources its views and effects own move into the scope, so their
  hand-written `dispose()` methods shrink to nothing. The rest of today's teardown stays, registered with `defer` where it
  is set up: the `disposed` flag that pending chest and loot loads check, returning kongs to the pool with
  `releaseKong`, removing the buff overlay's DOM, and stopping sound loops. The lifecycle lane (RAY-107) does this
  migration.
- **Shared prefabs** (the `SHARED ??= build()` pattern) move to the app scope through the cache below. They stay
  session-long, as RAY-16 needs (their programs stay linked), but now they are counted.

Sharing is explicit: a resource from the cache is borrowed, and only the cache frees it.

## One asset cache

`engine/assets.ts` becomes the only way to get a file-backed or shared procedural resource:

- **Keyed by what the resource is, not by how it was asked for.** Today the key `tex:path:srgb:repeat` makes two GPU
  textures from one image when two callers want different wrap modes. The cache keys the upload by path and decode
  options, and hands out `Texture` objects that share one `Source` when only sampler state differs.
- **Reference counted.** `acquire(key, scope)` adds a reference owned by that scope, and disposing the scope drops it. A
  resource with no references stays cached until its category needs the room, then the least recently used goes first.
- **Procedural builds go through it too:** `cache.build(key, cat, () => buildTukTuk())`. This replaces the hand-rolled
  `Map` caches, one area at a time.
- **One loader of each kind**, owned by the cache: one GLTF loader, one KTX2 transcoder pool, one image path. The ten
  bypass sites move onto it.

## CPU copies

After a texture is uploaded, the layer drops its CPU copy by default: `texture.onUpdate` closes an `ImageBitmap`, and
lets go of an `<img>`, a canvas or a typed array once the upload has happened. Width and height stay readable. After a
context loss, a texture is reloaded through the cache, never from a kept copy, so every texture whose copy is dropped
must come from the cache or from a builder the cache can run again.

Geometry is different: three.js uploads `attribute.array` again whenever the GPU buffer is recreated (after a
`dispose()`, or after a context loss), so a geometry whose array is gone can't come back. Geometry copies are dropped
only where the owner can rebuild it: the scope gets a `rebuild` callback for that geometry (a module's builder, a
cached GLTF), and the `far`-to-near transition and context restore call it. Until an owner registers one, its geometry
keeps its CPU copy. This puts textures first in the migration, which is also where most of the bytes are.

Code that reads the data later says so: `{ keepCpu: "hlod merge" }`. The reason is a string so the ledger can list every
kept copy and why. Known readers today are the HLOD far merge (`engine/hlod.ts` reads source arrays), the interaction
highlight (`hullOf` in `game/highlight.ts` welds a hull from the target's positions, sometimes in an idle slice long
after the upload), raycasts against world meshes, canvas textures that are redrawn (plane paint, signs), and
DataTextures updated in place (water fields, splat fade). Collision is not a reader: it comes from `shared/` and the
static-world worker.

## Budgets and residency

Each category has a budget. The numbers below start from the measurements above and the 4 GB target; the textures,
geometry and lifecycle lanes (RAY-105, RAY-106, RAY-107) refine them.

| category | budget | today (640x360, in a match) | how it gets there |
|---|---|---|---|
| `tex.world` on the GPU | 1000 MB | about 1700 MB | POI textures at the size they are seen at, KTX2, far regions drop near-only maps |
| `tex.actor` on the GPU | 350 MB | about 1050 MB | the helicopter at 2048² (RAY-105), one texture set per kong variant |
| `target` | 350 MB at the tier's pixel cap | about 450 MB | impostor arrays sized to the view-distance setting |
| `geo.world` on the GPU | 600 MB | about 1100 MB | far regions draw their proxy only (RAY-106) |
| kept CPU copies, all categories | 150 MB | about 3700 MB | the CPU-copy policy |
| `audio` PCM | 150 MB | 212 MB, plus 50 MB per match | the existing idle eviction, also run at match end |
| JS heap | 350 MB | 205-318 MB | lifecycle lane (RAY-107) |

Budgets scale with the quality tier, and with `navigator.deviceMemory` where the browser reports it.

**Render targets are sized from capped internal pixels, not display pixels.** Today the canvas follows
`devicePixelRatio` up to 2 (`engine/engine.ts`), so a 4K display at DPR 2 renders 8.3 million pixels. The post chain's
half-float targets then grow with the display, not with the quality setting. Safari on a 16 GB M4 Mac mini killed the
page (`ExceededMemoryLimit`) as a match loaded, at or just after the switch to fullscreen on such a display, in 5 of 5
runs (RAY-104). So:

- Each quality tier sets a maximum number of internal pixels (for example 2.1 million, 1080p, on high). Every
  screen-sized target is created from `min(display pixels, cap)`, and the final pass upscales to the canvas.
  `renderScale` and dynamic resolution keep working below the cap.
- The `target` budget is set at the cap, so it is a fixed number per tier, the same on a 1080p laptop and a 4K monitor.
- A resize or fullscreen switch that would cross the cap changes the upscale factor, never the target sizes, so
  switching to fullscreen allocates nothing.
- The budget step checks `target` bytes at the cap, with the page at DPR 2 on a 4K viewport.

**Residency.** A region is in one of three states:

1. **near**: built, and drawn as the module built it.
2. **far**: only its HLOD proxy is resident. The engine already builds a merged proxy for far POIs (`engine/hlod.ts`), but
   keeps the sources alive beside it, so today a far POI costs its sources plus the proxy. In this state the region
   frees its sources' GPU buffers and near-only textures. It keeps the sources' CPU arrays, or a `rebuild` callback for
   them (see [CPU copies](#cpu-copies)), because coming back near uploads them again.
3. **cold**: nothing resident; the module rebuilds it when the camera comes close.

Distance moves a region between states, with hysteresis, and so does its category being over budget. Regions the player
can reach within a few seconds stay near. Rebuilding costs time, so `far` is the main lever, and `cold` is for the lobby
islet once the plane leaves and for anything the storm has closed.

## Rules and what enforces them

A rule only counts if a check fails when it breaks. Each rule lands together with its check, as a row in AGENTS.md
"What enforces each rule".

| rule | enforced by |
|---|---|
| GPU resources are created only through a scope or the cache | Lint rule `resource-owner`: no `new THREE.*Texture`, `*RenderTarget`, `new Worker`, `TextureLoader` or `GLTFLoader` outside `client/src/engine/res/`. Today's sites go in `tools/lint/baseline.json`, which only shrinks |
| The renderer holds no unowned resource | `npm test` memory step: after boot and a match on SwiftShader, every geometry, texture and render target the renderer holds belongs to a scope. The harness observes the renderer's own registration (three.js counts a geometry once in `renderer.info.memory` however many attributes it has, counts render-target attachments as textures, and drops both on `dispose()`) and compares it with the ledger's owned set. Attribute-upload callbacks are not used for this: two geometries sharing one attribute would both look uploaded, and a render target's attachments never fire `texture.onUpdate`. Bytes and categories come from the ledger, never from `renderer.info`. Programs and VAOs are outside the check; they are small |
| Each category stays inside its budget | `npm test` memory step on KONG-43's harness: bytes per category against `tools/memory-budgets.json`. Over budget fails, and more than 5% under fails until the budget is lowered, as `tools/size-budgets.json` works today |
| A match leaves nothing behind | CI on SwiftShader: two matches back to back. The ledger's bytes per category after the second equal those after the first, within a small tolerance, and the match scope is empty after leaving |
| No CPU copy without a reason | The ledger lists kept copies with their `keepCpu` reason, and the budget step fails on bytes kept with no reason |
| Only the cache frees what it lends | Development builds throw on `dispose()` of a cached resource from outside the cache |

Geometry constructors are not in the lint rule. Most of the roughly 1,400 `new THREE.*Geometry` calls build temporary
inputs that are merged and never reach the GPU, so a lint would mostly flag harmless code. The "no unowned resource"
check covers geometry at runtime instead, at upload, which is where it starts to cost memory.

## Migration

One PR per step. Each step is useful on its own, keeps the state hash, the visuals and the boot smoke unchanged, and
ships dark behind a registry flag where it changes behaviour.

1. **This document.**
2. **The ledger and scopes**: `client/src/engine/res/scope.ts` with its tests (`tools/res/test.mts`). No callers yet.
3. **The match scope**, by the lifecycle lane (RAY-107): `GameRender` creates through it, and its teardown moves into the
   scope and its `defer` callbacks.
4. **The lint rule `resource-owner`**, with today's sites as its baseline. From then on, no new unowned texture, target
   or worker.
5. **The budget step and the match-to-match leak check**, on KONG-43's harness, with each budget set to today's number.
   Budgets only go down.
6. **The CPU-copy policy for textures**, behind a flag, applied first to loads that go through `Assets`. This is the
   largest single saving that needs no visual change.
7. **One asset cache**, as [One asset cache](#one-asset-cache) defines it: keys by what the resource is, a reference per
   acquiring scope dropped when that scope is disposed, least-recently-used eviction of unreferenced entries only when
   their category is over budget, and one loader of each kind. Then each bypass site, one PR each, by the lane that
   owns that code.
8. **Region scopes**: `ctx.res` for world modules, with per-POI accounting and `rebuild` callbacks for their geometry.
9. **Residency**: `far` regions free their sources' GPU buffers (with RAY-106), then `cold` for the lobby islet.
10. **Capped internal pixels** for every screen-sized target (`world/atmos/post.ts`, `engine/engine.ts`), so the
    `target` budget no longer depends on the display.

Steps 2, 4 and 5 belong to the architecture lane. Steps 3 and 6 to 10 change other lanes' code and go through them.
Step 10 needs none of the others and addresses the Safari kill, so it can land first.

## Open questions

- Whether a `far` region can free its source buffers without a hitch when the POI comes back near. The proxy keeps
  drawing until the sources upload again, so the cost is upload time, not a visual pop. RAY-106 measures it.
- How budgets measured on SwiftShader, where GPU memory is process memory, map to Metal and D3D11. KONG-43 calibrates
  them with GPU runs.
- Whether sharing one `Source` is enough for textures that differ only in sampler state, or whether those callers should
  agree on one sampler.
