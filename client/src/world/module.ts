// The world-module contract. Each area exports ONE default WorldModule from its folder's index.ts.
// Streaming (perf, backward compatible):
// in the GAME page only the title-critical modules build before the title is ready; every other module
// builds right after, in idle time while the player is in the title / lobby / warm-up. In ?view / ?cam / ?shot pages
// every module builds before ready. Inside build(), `await ctx.yield()` between chunks of work keeps
// every main-thread task short (the loading bar and the title keep painting).
import type { WorldCtx } from "../engine/engine";
import type { CamSpec } from "../engine/views";
import type { Scope } from "../engine/res/scope";

export interface WorldModule {
  id: string;
  /** add meshes/lights to ctx.scene, register ctx.onUpdate hooks, publish handles on ctx.shared */
  build(ctx: WorldCtx, scope: Scope): Promise<void> | void;
  release?(ctx: WorldCtx): Promise<void> | void;
  /**
   * runs after every TITLE module has built (registry order) — e.g. shadows/material patching, shader warm-up — and,
   * for a streamed module, right after its own build. Once the stream has finished, every loaded module's afterBuild
   * runs ONE more time (the world is complete then): keep it idempotent.
   */
  afterBuild?(ctx: WorldCtx): Promise<void> | void;
  /** view cameras (`?view=<id>`) this module owns (override DEFAULT_VIEWS with the same id) */
  views?: Record<string, CamSpec>;
  /** optional staging for a view's `stage` hint (place props/actors for that view camera) */
  stage?(ctx: WorldCtx, stage: string): Promise<void> | void;
  /**
   * when the game page builds this module: "title" = before the title is ready (the title / lobby camera or the
   * warm-up needs it), "stream" = after, in idle time (a POI on the main island). Unset = the registry default
   * (registry.ts TITLE_MODULES). The server's static world never depends on this: colliders come from shared/pois.
   */
  priority?: "title" | "stream";
  /**
   * streamed modules only: skip the engine's far-POI merge for this module (engine/hlod.ts). Set it if the module
   * already draws a merged far LOD of its own, or animates meshes through shaders fed per-object uniforms.
   */
  noFarMerge?: boolean;
}
