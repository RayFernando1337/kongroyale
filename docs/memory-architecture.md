# Memory architecture: one resource layer

This is the design for how the client creates, owns, caches and frees GPU and CPU resources. It exists because the
browser holds 4.5 GB at the title and 6.5-7.5 GB in a match at 640x360 on SwiftShader (RAY-104, PSS), and players on
16 GB machines swap. The target is a browser under 4 GB in a match at 1080p, and no growth from one match to the next.

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

The API is small. This is a sketch; the names land with step 2 of the migration:

```ts
type Category = "tex.world" | "tex.actor" | "tex.ui" | "geo.world" | "geo.actor" | "target" | "audio";
interface Scope {
  readonly name: string;
  child(name: string): Scope;
  texture<T extends THREE.Texture>(cat: Category, make: () => T, o?: { keepCpu?: string }): T;
  geometry<T extends THREE.BufferGeometry>(cat: Category, make: () => T, o?: { keepCpu?: string }): T;
  material<T extends THREE.Material>(make: () => T): T;
  target<T extends THREE.RenderTarget>(make: () => T): T;
  worker(make: () => Worker): Worker;
  adopt(o: { dispose(): void }, cat: Category, bytes: number): void;
  dispose(): void;
}
```

A transient scope is a function, so a bake can't forget to free its target:

```ts
await withScope("bake:impostor", async (s) => {
  const rt = s.target(() => new THREE.WebGLRenderTarget(size, size));
  renderBake(rt);
});
```

What changes for each owner:

- **World modules** get `ctx.res`, their region scope, on `WorldCtx`. A module creates through it and no longer frees
  anything by hand. The boot already knows each module's scene roots (`rootsOf` in `main.ts`), so the scope also gives
  per-POI accounting.
- **`GameRender`** gets the match scope. Its hand-written `dispose()` chain becomes `match.dispose()` plus removing its
  roots from the scene. Per-match classes stop writing their own `dispose()`.
- **Shared prefabs** (the `SHARED ??= build()` pattern) move to the app scope through the cache below. They stay
  session-long, as RAY-16 needs (their programs stay linked), but now they are counted.

Sharing is explicit: a resource from the cache is borrowed, and only the cache frees it. Freeing a borrowed resource
throws in development builds.

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

After a resource is uploaded, the layer drops its CPU copy by default:

- Textures: `texture.onUpdate` closes an `ImageBitmap`, and lets go of an `<img>`, a canvas or a typed array once the
  upload has happened. Width and height stay readable.
- Geometry: `attribute.onUpload` swaps the array for an empty one of the same type, after the bounding box and sphere are
  computed.

Code that reads the data later says so: `{ keepCpu: "hlod merge" }`. The reason is a string so the ledger can list every
kept copy and why. Known readers today are the HLOD far merge (`engine/hlod.ts` reads source arrays), raycasts against
world meshes, canvas textures that are redrawn (plane paint, signs), and DataTextures updated in place (water fields,
splat fade). Collision is not a reader: it comes from `shared/` and the static-world worker.

After a context loss, a texture is reloaded through the cache, not from a kept copy.

## Budgets and residency

Each category has a budget. The numbers below start from the measurements above and the 4 GB target; the textures,
geometry and lifecycle lanes (RAY-105, RAY-106, RAY-107) refine them.

| category | budget | today (640x360, in a match) | how it gets there |
|---|---|---|---|
| `tex.world` on the GPU | 1000 MB | about 1700 MB | POI textures at the size they are seen at, KTX2, far regions drop near-only maps |
| `tex.actor` on the GPU | 350 MB | about 1050 MB | the helicopter at 2048² (RAY-105), one texture set per kong variant |
| `target` | 350 MB at 1080p | about 450 MB | impostor arrays sized to the view-distance setting |
| `geo.world` on the GPU | 600 MB | about 1100 MB | far regions draw their proxy only (RAY-106) |
| kept CPU copies, all categories | 150 MB | about 3700 MB | the CPU-copy policy |
| `audio` PCM | 150 MB | 212 MB, plus 50 MB per match | the existing idle eviction, also run at match end |
| JS heap | 350 MB | 205-318 MB | lifecycle lane (RAY-107) |

Budgets scale with the quality tier, and with `navigator.deviceMemory` where the browser reports it.

**Residency.** A region is in one of three states:

1. **near**: built, and drawn as the module built it.
2. **far**: only its HLOD proxy is resident. The engine already builds a merged proxy for far POIs (`engine/hlod.ts`), but
   keeps the sources alive beside it, so today a far POI costs its sources plus the proxy. In this state the region
   frees its sources' GPU buffers and near-only textures.
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
| The renderer holds no unowned resource | `npm test` memory step: after boot and a match on SwiftShader, the `renderer.info.memory` counts equal the ledger's counts |
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
2. **The ledger and scopes** in `client/src/engine/res/`: `Scope`, categories, byte counts, and a read-only `__kr.res`.
   No callers yet.
3. **The lint rule `resource-owner`**, with today's sites as its baseline. From then on, no new unowned texture, target
   or worker.
4. **The match scope.** `GameRender` creates through it and `dispose()` becomes `match.dispose()`. The
   match-to-match leak check joins CI.
5. **The CPU-copy policy**, behind a flag, applied first to loads that go through `Assets`. This is the largest single
   saving that needs no visual change.
6. **One asset cache**: reference counts and one loader of each kind. Then each bypass site, one PR each, by the lane that
   owns that code.
7. **Region scopes**: `ctx.res` for world modules, with per-POI accounting.
8. **The budget step in `npm test`**, on KONG-43's harness, with each budget set to today's number. Budgets only go down.
9. **Residency**: `far` regions free their sources (with RAY-106), then `cold` for the lobby islet.

Steps 2, 3, 4 and 8 belong to the architecture lane. Steps 5, 6, 7 and 9 change other lanes' code and go through them.

## Open questions

- Whether a `far` region can free its source buffers without a hitch when the POI comes back near. The proxy keeps
  drawing until the sources upload again, so the cost is upload time, not a visual pop. RAY-106 measures it.
- How budgets measured on SwiftShader, where GPU memory is process memory, map to Metal and D3D11. KONG-43 calibrates
  them with GPU runs.
- Whether sharing one `Source` is enough for textures that differ only in sampler state, or whether those callers should
  agree on one sampler.
