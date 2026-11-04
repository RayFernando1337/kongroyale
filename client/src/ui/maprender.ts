// The baked top-down render of the island (assets/ui/map-render.webp) laid onto the map canvas: the render scaled to
// the map, its border colour taken as the open sea, the borders faded into that sea, and the Mist Falls river painted
// over it. Pure painter shared by maprenderworker.ts (OffscreenCanvas, so the 4096² decode and the scale stay off the
// main thread) and mapimage.ts's main-thread fallback.

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Src = CanvasImageSource & { width: number; height: number };

export interface MapRenderWater {
  /** the river centreline, world x/z (FALLS.river) */
  river: ReadonlyArray<readonly [number, number]>;
  /** the plunge pool ellipse (FALLS.pool) */
  pool: { x: number; z: number; rx: number; rz: number };
}

/** draws `img` over the whole sizePx² map in `g`; returns the sea colour (CSS) beyond the rendered square, or null
 *  when the border could not be sampled (the caller keeps its painted sea colour) */
export function paintRender(g: Ctx2D, img: Src, sizePx: number, half: number, water: MapRenderWater, scratch: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas): string | null {
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, sizePx, sizePx);
  try {
    const cg = scratch(8, 8).getContext("2d") as Ctx2D;
    // all four borders, not just the top: the east edge of the render is a different blue
    let r = 0, gg = 0, b = 0, n = 0;
    for (const [sx, sy, sw, sh] of [[0, 0, img.width, 16], [0, img.height - 16, img.width, 16], [0, 0, 16, img.height], [img.width - 16, 0, 16, img.height]]) {
      cg.clearRect(0, 0, 8, 8); cg.drawImage(img, sx, sy, sw, sh, 0, 0, 8, 8); const d = cg.getImageData(0, 0, 8, 8).data;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    }
    const rgb = `${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)}`;
    // …and the render's borders melt into that sea over 7 % of the map (no straight seam where the square ends)
    const f = sizePx * 0.07;
    for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [[0, 0, f, 0, 0, 0, f, sizePx], [sizePx, 0, sizePx - f, 0, sizePx - f, 0, f, sizePx], [0, 0, 0, f, 0, 0, sizePx, f], [0, sizePx, 0, sizePx - f, 0, sizePx - f, sizePx, f]]) {
      const gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.fillRect(rx, ry, rw, rh);
    }
    paintWater(g, sizePx, half, water);
    return `rgb(${rgb})`;
  } catch {
    return null;
  }
}

/** the Mist Falls plunge pool and its river, which the top-down bake shows as a dry beige bed (the river water is not
 *  drawn from 6 km up): painted blue over the render from poi-jungle's own centreline */
function paintWater(g: Ctx2D, sizePx: number, half: number, { river, pool }: MapRenderWater) {
  const s = sizePx / (half * 2);
  const P = (x: number, z: number): [number, number] => [(x + half) * s, (z + half) * s];
  const pts = river.map(([x, z]) => P(x, z));
  g.save(); g.lineCap = "round"; g.lineJoin = "round";
  const stroke = (w: number, c: string) => { g.strokeStyle = c; g.lineWidth = w * s; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const [x, y] of pts.slice(1)) g.lineTo(x, y); g.stroke(); };
  stroke(17, "rgba(226,214,168,0.9)"); stroke(12, "#2a8fc4"); stroke(5, "rgba(120,214,240,0.75)");
  const [px, py] = P(pool.x, pool.z);
  g.fillStyle = "rgba(226,214,168,0.9)"; g.beginPath(); g.ellipse(px, py, (pool.rx + 3) * s, (pool.rz + 3) * s, 0, 0, Math.PI * 2); g.fill();
  const gr = g.createRadialGradient(px, py, 0, px, py, pool.rz * s);
  gr.addColorStop(0, "#1c6fa8"); gr.addColorStop(1, "#3cb6dc");
  g.fillStyle = gr; g.beginPath(); g.ellipse(px, py, pool.rx * s, pool.rz * s, 0, 0, Math.PI * 2); g.fill();
  g.restore();
}
