// Worker: downloads and decodes the baked island render (map-render.webp, 4096²), lays it onto a map-sized
// OffscreenCanvas with maprender.ts and ships the finished map back as an ImageBitmap, so the main thread only copies
// it. Imports nothing heavy: the Mist Falls water comes in the message.
import { paintRender, type MapRenderWater } from "./maprender";

export interface MapRenderRequest { url: string; sizePx: number; half: number; water: MapRenderWater }

const ctx = self as unknown as { onmessage: ((e: MessageEvent<MapRenderRequest>) => void) | null; postMessage(m: unknown, t?: Transferable[]): void };
ctx.onmessage = async (e) => {
  try {
    const { url, sizePx, half, water } = e.data;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const img = await createImageBitmap(await res.blob());
    const c = new OffscreenCanvas(sizePx, sizePx);
    const seaCss = paintRender(c.getContext("2d")!, img, sizePx, half, water, (w, h) => new OffscreenCanvas(w, h));
    img.close();
    const bmp = c.transferToImageBitmap();
    ctx.postMessage({ ok: true, bmp, seaCss }, [bmp]);
  } catch (err) {
    ctx.postMessage({ ok: false, error: String(err) });
  }
};
