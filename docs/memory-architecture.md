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

On a real GPU the whole browser is three times that, and the GPU process is the largest part. Windows numbers are from
Chrome on D3D11 (RTX, 1600x900, seed 42, main 88d6d44, three runs, RAY-119). The Mac numbers are from Chrome on Metal
(M4 Mac mini, RAY-104). Medians, in MB:

| phase | whole browser | GPU process | renderer | JS heap after GC | WebGL allocations | CPU copies (textures + geometry) |
|---|---:|---:|---:|---:|---:|---:|
| title (D3D11) | 7588, bimodal: 6930 or 8368 | 4700 | 2745 | 214 | 2538 | 762 + 379 |
| plane (D3D11) | 12897 | 8612 | 4143 | 303 | 4590 | 1316 + 1395 |
| match, 30 s in (D3D11) | 12713 | 8330 | 4240 | 310 | 4606 | 1316 + 1461 |
| plane onward (Metal) | 12300-12500 | | | | | |

In a match the GPU process holds about 1.8 times what the game asks WebGL for (8330 MB for 4606 MB). That extra is
the driver's copies, mip chains and staging, which the game can't free directly, so only cutting WebGL allocations
reduces it. The renderer holds the JS heap, the CPU copies, decoded audio (305 MB) and about 848 MB of everything else:
code, the DOM, decoded images in flight and V8's overhead.

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

A world module gets its region scope as the second argument to `build(ctx, scope)`. `buildOne` creates it as
`region:<module id>` (`region:poi:peel-harbor`), keeps it for as long as the module is resident, and disposes it when the
build throws. Eviction is the caller's job: it takes off the scene roots and `ctx.onUpdate` hooks the build added, calls
the module's optional `release(ctx)`, then disposes the scope. `release` undoes only what the caller can't see, such as
module-level caches and fields that hold built objects. After it returns, `build` can run again on the same module
object, because modules are singletons. A region scope never owns a resource another module shares: a kit's cached
materials and textures, used by several towns, belong to a kit scope or the app scope.

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

const matchScope: Scope = resources.root.child("match");
const geo = matchScope.geometry("geo.actor", new THREE.CapsuleGeometry(0.09, 0.4, 4, 8));
const mat = matchScope.material(new THREE.MeshStandardMaterial({ color: "#f5c531" }));
const rocket = new THREE.Mesh(geo, mat);
scene.add(rocket);
matchScope.defer(() => rocket.removeFromParent());
matchScope.defer(() => overlay.remove());

matchScope.dispose();
```

A bake frees its target even when it throws:

```ts
await withScope(resources.root, "bake:impostor", async (scope) => {
  const rt = scope.target(new THREE.WebGLRenderTarget(size, size));
  renderBake(rt);
});
```

Shared resources (a prefab's geometry, a cached texture) are not handed to a per-match scope: the scope that made them
owns them. The tests in `tools/res/test.mts` run each of these cases.

What changes for each owner:

- **World modules** get their region scope as the second argument to `build(ctx, scope)`. A module creates through it and no longer frees
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

Each category has a budget. The budgets come from the 4 GB target, split by process first, because the process is
what the OS charges and what a player's machine swaps. The textures, geometry and lifecycle lanes (RAY-105, RAY-106,
RAY-107) refine them.

| process | today (D3D11, match) | target | what it means |
|---|---:|---:|---|
| GPU process | 8330 MB | 2200 MB | WebGL allocations at most 1200 MB, at today's 1.8 ratio: down 74% from 4606 MB |
| renderer | 4240 MB | 1500 MB | the JS heap, kept CPU copies and audio within their budgets below, plus today's 848 MB of everything else |
| browser and utility processes | 143 MB | 150 MB | already there |
| **whole browser** | **12713 MB** | **3850 MB** | under 4 GB, with 150 MB to spare |

The renderer can't take up the slack: 848 MB of its 1500 MB target is outside the game's categories, so the GPU
process has to come down to about a quarter of today, from 8.3 GB to 2.2 GB. WebGL allocations are split by category:

| category | budget | today | how it gets there |
|---|---:|---:|---|
| `tex.world` on the GPU | 520 MB | about 1700 MB | POI textures at the size they are seen at, KTX2, far regions drop near-only maps |
| `tex.actor` on the GPU | 150 MB | about 1050 MB | the helicopter at 2048² (RAY-105), one texture set per kong variant, kongs at 1024² beyond close range |
| `target` | 200 MB at the tier's pixel cap | about 450 MB | impostor arrays sized to the view-distance setting, capped internal pixels (migration step 10) |
| `geo.world` on the GPU | 250 MB | 1361 MB of buffers on D3D11 | far regions draw their proxy only (RAY-106), quantized positions and normals |
| `geo.actor` on the GPU | 50 MB | small | one geometry per prefab, shared by every instance |
| `tex.ui` and `other` on the GPU | 30 MB | small | the title art and UI atlases at the size they are drawn at |
| **WebGL allocations** | **1200 MB** | **4606 MB on D3D11** | |
| kept CPU copies, all categories | 150 MB | 2777 MB on D3D11 | the CPU-copy policy |
| `audio` PCM | 150 MB | 305 MB on D3D11, plus 50 MB per match | the existing idle eviction, also run at match end |
| JS heap | 350 MB | 310 MB on D3D11 | lifecycle lane (RAY-107) |

The per-category "today" numbers for textures and targets are the 640x360 SwiftShader census above. On D3D11 at
1600x900 the textures total 3208 MB. The ledger reports each category directly once owners have moved to scopes.

Budgets scale with the quality tier, and with `navigator.deviceMemory` where the browser reports it.

**Render targets are sized from capped internal pixels, not display pixels.** Today the canvas follows
`devicePixelRatio` up to 2 (`engine/engine.ts`), so a 4K display at DPR 2 (a 1920x1080 CSS viewport) renders 8.3
million pixels, and the post chain's half-float targets grow with the display, not with the quality setting. Safari on a
16 GB M4 Mac mini killed the page (`ExceededMemoryLimit`) as a match loaded, at or just after the switch to fullscreen on
such a display, in 5 of 5 runs (RAY-104). So:

- Each quality tier sets a maximum number of internal pixels (for example 2.1 million, 1080p, on high). Every
  screen-sized target is created from `min(display pixels, cap)`, and only the final blit writes the canvas at display
  size. That includes the TAA history targets, which `AtmosFinalPass.setSizes` (`world/atmos/post.ts`) sizes to the
  output today, not to the internal resolution. `renderScale` and dynamic resolution keep working below the cap.
- The `target` budget is set at the cap, so it is a fixed number per tier, the same on a 1080p laptop and a 4K monitor.
- A resize or a fullscreen switch can still reallocate targets when the aspect ratio changes, but never past the cap's
  bytes, so going fullscreen on a large display costs no more than on a small one.
- The budget step checks `target` bytes at the cap, with the page at DPR 2 on a 1920x1080 CSS viewport (a 4K display).

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

## Context loss

The browser can take the WebGL context away at any time: a GPU reset, a driver update, too many contexts, or memory
pressure (the Safari case above). three.js handles the event itself: it calls `preventDefault()` on
`webglcontextlost`, so the browser may restore the context, and on `webglcontextrestored` it rebuilds its GL state and
uploads geometry and textures again from their CPU copies. On its own that leaves:

- Every baked render target empty: impostor banks, the terrain's far albedo, water obstacle and wave bakes, cloud
  volumes, the sky bake. They were drawn once and are never drawn again.
- Every texture whose CPU copy was released (`releaseAfterUpload` in `engine/texture-release.ts`, on by default,
  `?texfree=0` turns it off) with only a sized stub, so it uploads as nothing.
- Geometry whose CPU arrays are dropped (`?geofree=1`) the same, which is why the [CPU copies](#cpu-copies) section
  keeps them until the owner can rebuild them.
- three.js's dispose listeners from the lost context still on every older object, deleting objects that belong to the
  old context when it is disposed.

`engine/res/restore.ts` owns both events (`watchContext`, called from `engine/engine.ts`), and the restore itself runs
from `engine/res/restore-run.ts`, loaded on the first loss:

1. **On `webglcontextlost`** the frame loop pauses and a 10 s timer starts that reloads the page if no restore comes.
2. **On `webglcontextrestored`** `restoreAll()` runs three phases, then `__kr.restores` goes up and frames resume:
   - `source`: every released texture refills its pixels from the rebuild it gave `releaseAfterUpload(t, rebuild)`
     (a cached file through the cache, a procedural texture through its painter). A geometry released with
     `releaseGeometryAfterUpload(g, rebuild)` (`engine/geometry-release.ts`, the terrain's shadow proxy) refills its
     arrays the same way.
   - modules: a module that owns resources with no restore path (`unrestorable()`: a released texture without a
     rebuild, a `geofree` batch) is rebuilt through `restoreModulesWith`. With `geofree` on, `low-mem.ts` registers it
     for streamed modules (`low-mem-restore.ts`): the module is evicted during the restore and built again from source
     through the stream's build queue once the context is live.
   - `bake`: every bake registered with `bake(fn)`, or `onRestore("bake", fn)`, draws again.
3. **Reload** stays the fallback. If any resource with no restore path belongs to no module, or to a module that cannot
   be rebuilt, `restoreAll()` throws before it touches anything and the page reloads, which is correct for every
   resource. A `geofree` batch in a title module (built at boot, not streamed) still reloads the page this way.

A deletion of an object made before the loss is skipped (`ignoreStaleDeletes`), so three.js's leftover listeners are
harmless. A bake must not sample its own target: the terrain's far albedo clears `tFar` while it redraws.

What enforces it: the CI job "no-GPU context restore" runs `tools/verify-context-loss.mts` on SwiftShader with the
title modules. It calls `WEBGL_lose_context.loseContext()` and then `restoreContext()` twice: once at the title, and
once in the warm-up of a practice match. Each time it sets a marker on `window` before the loss and requires the same
document afterwards (no reload), a higher `__kr.restores`, the frame loop running, no `__kr.errors`, no page error and
no WebGL or three.js console warning, and a picture at least 60% as bright as before the loss (an empty bake shows as
black). It reads the picture from the canvas's drawing buffer right after a frame the engine drew, so a slow
SwiftShader compositor can't time it out the way a page screenshot did. On SwiftShader the browser's memory rises by about 6 GB during a restore and falls back within a minute, so the
run keeps to the title modules.

## Rules and what enforces them

A rule only counts if a check fails when it breaks. Each rule lands together with its check, as a row in AGENTS.md
"What enforces each rule".

| rule | enforced by |
|---|---|
| GPU resources are created only through a scope or the cache | Lint rule `resource-owner`: outside `client/src/engine/res/`, every `new THREE.*Texture`, `*RenderTarget` and `new Worker` is handed straight to a scope (`scope.texture`, `scope.target`, `scope.worker`) through a binding named `scope`, `res`, `<name>Scope` or `resources.root`, and `new *Loader` appears only in `client/src/engine/assets.ts`. Today's sites go in `tools/lint/baseline.json`, which only shrinks |
| The renderer holds no unowned resource | CI job "no-GPU match-to-match memory" (`memory.mts --warmup --budgets tools/memory-leak-budgets.json`, page loaded with `?resaudit`): `engine/res/audit.ts` records every geometry, texture and render target the renderer registers (three.js adds its `dispose` listener to each one when it first uploads it, which is what `renderer.info.memory` counts) and drops it on `dispose()`. After the third match it compares that set with the ledger's owners. Render-target attachments count with their target. The unowned count and bytes have a ceiling (`left3`) that is lowered as owners move to scopes, and the check reaches zero when every owner has moved. Bytes and categories come from the ledger, never from `renderer.info`. Programs and VAOs are outside the check; they are small |
| Each category stays inside its budget | `npm test` memory step on KONG-43's harness: bytes per category against `tools/memory-budgets.json`. Over budget fails, and more than 5% under fails until the budget is lowered, as `tools/size-budgets.json` works today |
| A match leaves nothing behind | The same CI job: three practice matches, each entered and left in its warm-up, with only the title modules (`?modules=`), because on SwiftShader the browser passes 10 GB once Peel Harbor streams in. What grows from the second left sample to the third (WebGL bytes, textures, geometries, unowned resources, ledger bytes per category) stays under `leak` in `tools/memory-leak-budgets.json`, and the run fails if the match scope is still open after leaving. The first match is not compared: the island keeps streaming through it. `--max-mb` stops the browser before the runner runs out of memory |
| A match holds no more than it did | Two budget files with the title budget's rule (over fails, more than 5% under fails until the budget is lowered). `tools/memory-warmup-budgets.json` reads the first warm-up of the match-to-match run. `tools/memory-lowmem-budgets.json` is CI job "no-GPU low-memory memory": the low-memory setup with the whole island at the title, in the plane and in play, including the resident POI count and its peak. See [In-match and low-memory budgets](#in-match-and-low-memory-budgets) |
| No CPU copy without a reason | The ledger lists kept copies with their `keepCpu` reason, and the budget step fails on bytes kept with no reason |
| Only the cache frees what it lends | Development builds throw on `dispose()` of a cached resource from outside the cache |
| The game survives a WebGL context loss | CI job "no-GPU context restore" (`tools/verify-context-loss.mts`): `loseContext()` then `restoreContext()` at the title and again in a match's warm-up, the same document, a higher `__kr.restores`, no page, WebGL or three.js error and the picture as bright as before (see [Context loss](#context-loss)) |

### In-match and low-memory budgets

The title budget alone let a regression in match code or in a streamed POI through. Two budget files cover the match,
calibrated on CI's own runner (`ubuntu-latest`, 4 vCPUs, 16 GB):

- **Default setup, warm-up.** The match-to-match run already enters three practice warm-ups with the title modules, so
  `tools/memory-warmup-budgets.json` budgets its first warm-up at no extra CI time: WebGL bytes, textures, geometry and
  texture CPU copies, JS heap. Past the warm-up with the whole island, SwiftShader passes 10 GB and the runner can't
  hold it, so the default setup has no budget in the plane or in play.
- **Low-memory setup, title to play.** CI job "no-GPU low-memory memory" runs `memory.mts run --matches 1` on
  `?lowmem=1&geofree=1&farimp=1` with the whole island and checks `tools/memory-lowmem-budgets.json`. It fits the runner
  (about 5.5 GB for the whole browser) because POIs stream in near the player and past `lowmemcap` the farthest is
  evicted. It samples `title`, `plane` (as the plane phase starts) and `match` (60 s into the play phase), and adds
  three residency numbers to every sample: `residentPois` (built POI modules, the lobby islet included),
  `peakResidentPois` (the most at once, polled every 250 ms in the page) and `evictions`. The title budgets every
  metric. After the title, which POI is mid-build at the sample varies between runner instances, so the plane budgets
  WebGL bytes and textures, and the match budgets WebGL bytes, the heap, `residentPois` and
  `peakResidentPois`. The peak is the cap plus the islet, so it fails over budget if eviction stops holding the cap and
  under budget if nothing streams. The match's texture count, CPU copies and evictions (1-2 on seed 42) are recorded
  but not budgeted. The job takes about 10 minutes beside the others, so the workflow is no slower.

A scripted walk between POIs was tried and dropped: on SwiftShader a POI's integration runs one program per frame at
about 1 fps, so waiting for the POIs around one stop to settle took over 5 minutes on the runner, and a walk that
doesn't wait samples whatever happens to be mid-build.

`memory.mts --budgets` prints each failure as `phase.metric measured, budget: over budget by N MB (+P%)`, or names
the lower budget to set when a number is more than 5% under. On GitHub Actions each failure is also an `::error`
annotation on the budget file, and the job summary has a table of every budgeted number with its change. `--budgets`
takes several files; each one's `config` must match the run. Each file's `about` says what it measures and how its
budgets are set. The runs and reason behind each change go in that change's PR description and commit message, not in
`about`, so two PRs that move different budgets don't conflict on one line.

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
   Budgets only go down. KONG-43's title budget is `tools/memory-budgets.json`; the leak and ownership check is
   `tools/memory-leak-budgets.json`.
6. **The CPU-copy policy for textures**, behind a flag, applied first to loads that go through `Assets`. This is the
   largest single saving that needs no visual change.
7. **One asset cache**, as [One asset cache](#one-asset-cache) defines it: keys by what the resource is, a reference per
   acquiring scope dropped when that scope is disposed, least-recently-used eviction of unreferenced entries only when
   their category is over budget, and one loader of each kind. Then each bypass site, one PR each, by the lane that
   owns that code.
8. **Region scopes**: the `scope` argument to `build(ctx, scope)` for world modules, with per-POI accounting and `rebuild` callbacks for their geometry.
9. **Residency**: `far` regions free their sources' GPU buffers (with RAY-106), then `cold` for the lobby islet.
10. **Capped internal pixels** for every screen-sized target (`world/atmos/post.ts`, `engine/engine.ts`), so the
    `target` budget no longer depends on the display.
11. **Context loss**: restore in place (`engine/res/restore.ts`) with reload as the fallback. `geofree` batches in
    streamed modules restore by rebuilding the module; title modules still reload.

Steps 2, 4 and 5 belong to the architecture lane. Steps 3 and 6 to 11 change other lanes' code and go through them.
Step 10 needs none of the others and addresses the Safari kill, so it can land first.

## Open questions

- Whether a `far` region can free its source buffers without a hitch when the POI comes back near. The proxy keeps
  drawing until the sources upload again, so the cost is upload time, not a visual pop. RAY-106 measures it.
- How budgets measured on SwiftShader, where GPU memory is process memory, map to Metal. On D3D11 the GPU process holds
  1.8 times the WebGL allocations in a match (RAY-119). Metal's ratio is still to be measured, and the GPU-process target
  assumes it is no worse.
- Whether sharing one `Source` is enough for textures that differ only in sampler state, or whether those callers should
  agree on one sampler.
