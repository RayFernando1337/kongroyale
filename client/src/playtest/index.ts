import type { Engine } from "../engine/engine";
import { BUILD } from "../build";
import { flag } from "../flags";

export function installPlaytest(engine: Engine, game: boolean): void {
  if (BUILD.channel !== "stable" && flag("badge")) void import("../ui/build-badge").then((m) => m.showBuildBadge());
  if (game && flag("perfhud")) void import("./perf-hud").then((m) => m.installPerfHud(engine));
}
