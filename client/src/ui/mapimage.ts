// Painted top-down island map shared by the minimap and the full-screen map. The canvas exists immediately (open
// sea colour); the painting (mappaint.ts) runs in a worker and lands ~0.5 s later — `version` bumps so the HUD
// redraws. In view-camera stills a readiness hold keeps the capture waiting for the finished map.
import type { CreateMapImage, MapImage } from "./api";
import { DEEP_SEA_CSS, paintMap, type MapPaintInput } from "./mappaint";
import { terrainData } from "../world/terrain/load";
import { uiAsset } from "./styles";
import { FALLS } from "../../../shared/pois/jungle-falls";
import { paintRender, type MapRenderWater } from "./maprender";
import type { MapRenderRequest } from "./maprenderworker";

export interface PaintedMap extends MapImage {
  /** increments when the painting lands */
  version: number;
  ready: Promise<void>;
  seaCss: string;
}

let shared: PaintedMap | null = null;

export const createMapImage: CreateMapImage = (terrain, sizePx): PaintedMap => {
  // one painting per page (HUD re-creation in harnesses reuses it)
  if (shared && shared.sizePx === sizePx && shared.half === terrain.half) return shared;
  const half = terrain.half;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = sizePx;
  const g = canvas.getContext("2d")!;
  g.fillStyle = DEEP_SEA_CSS;
  g.fillRect(0, 0, sizePx, sizePx);
  const s = sizePx / (half * 2);
  let extra: { coast: Int8Array | null; path: Uint8Array | null } = { coast: null, path: null };
  try { const d = terrainData(); extra = { coast: d.coast, path: d.path }; } catch { /* sampler-only terrain */ }
  const inp: MapPaintInput = { heights: terrain.heights, biome: terrain.biome, coast: extra.coast, path: extra.path, sizePx };

  const kr = (globalThis as unknown as { __kr?: { engine?: { hold?: (l: string) => () => void } } }).__kr;
  const release = kr?.engine?.hold?.("ui:map") ?? (() => {});
  const map: PaintedMap = {
    canvas, sizePx, half, version: 0, seaCss: DEEP_SEA_CSS, ready: Promise.resolve(),
    toPx(x: number, z: number): [number, number] { return [(x + half) * s, (z + half) * s]; },
    toWorld(pxx: number, pyy: number): [number, number] { return [pxx / s - half, pyy / s - half]; },
  };
  // the map is a RENDER of the real island (every POI's
  // buildings, the jungle, reefs and the game's own sun, shadows and clouds, straight down) — the procedural painting
  // below is only the fallback while it downloads / if it is missing. Whichever lands last never overwrites the render.
  let rendered = false;
  const land = (src: CanvasImageSource) => {
    if (rendered) return;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, sizePx, sizePx); map.version++;
  };
  const water: MapRenderWater = { river: FALLS.river, pool: FALLS.pool };
  const url = uiAsset("map-render.webp");
  const landRender = (seaCss: string | null) => { if (seaCss) map.seaCss = seaCss; rendered = true; map.version++; };
  /** the main-thread path (no worker / OffscreenCanvas / createImageBitmap, or the worker failed): decode with an
   *  <img> and paint here, as before the worker existed */
  const renderHere = (resolve: () => void) => {
    if (typeof Image === "undefined") { resolve(); return; }
    const img = new Image(); img.decoding = "async";
    img.onload = () => {
      landRender(paintRender(g, img, sizePx, half, water, (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }));
      resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  };
  // (perf: the 4096² render's decode and scale ran on the main thread in onload, ~0.7 s; a worker now decodes it with
  // createImageBitmap, paints the finished map on an OffscreenCanvas and hands back a map-sized bitmap to copy)
  const renderReady = new Promise<void>((resolve) => {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") { renderHere(resolve); return; }
    try {
      const w = new Worker(new URL("./maprenderworker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<{ ok: boolean; bmp?: ImageBitmap; seaCss?: string | null; error?: string }>) => {
        w.terminate();
        if (!e.data.ok || !e.data.bmp) { console.warn("[ui] map render worker failed, decoding on the main thread:", e.data.error); renderHere(resolve); return; }
        g.drawImage(e.data.bmp, 0, 0); e.data.bmp.close();
        landRender(e.data.seaCss ?? null);
        resolve();
      };
      w.onerror = (ev) => { console.warn("[ui] map render worker error", ev.message); w.terminate(); renderHere(resolve); };
      const req: MapRenderRequest = { url: new URL(url, location.href).href, sizePx, half, water };
      w.postMessage(req);
    } catch { renderHere(resolve); }
  });
  const mainThread = async () => {
    const [{ scatterVegetation }, { allClearings, allColliders }, { Terrain }] = await Promise.all([
      import("../../../shared/world/veg-scatter"), import("../../../shared/pois/index"), import("../../../shared/world/terrain"),
    ]);
    const t = new Terrain(terrain.heights, terrain.biome);
    land(paintMap(inp, (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }, scatterVegetation(t, allClearings()), allColliders()) as HTMLCanvasElement);
  };
  map.ready = new Promise<void>((resolve) => {
    const done = () => { void renderReady.then(() => { release(); resolve(); }); };
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") { mainThread().catch((e) => console.warn("[ui] map paint failed", e)).finally(done); return; }
    try {
      const w = new Worker(new URL("./mapworker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<{ ok: boolean; bmp?: ImageBitmap; error?: string; ms?: number }>) => {
        if (e.data.ok && e.data.bmp) { land(e.data.bmp); e.data.bmp.close(); (globalThis as unknown as { __krMapMs?: number }).__krMapMs = e.data.ms; done(); }
        else { console.warn("[ui] map worker failed, painting on the main thread:", e.data.error); mainThread().catch(() => {}).finally(done); }
        w.terminate();
      };
      w.onerror = (ev) => { console.warn("[ui] map worker error", ev.message); w.terminate(); mainThread().catch(() => {}).finally(done); };
      w.postMessage(inp);
    } catch { mainThread().catch(() => {}).finally(done); }
  });
  shared = map;
  return map;
};
