// A spatial index over the match's loot list (Match.items) for bounded nearby-item queries (Match.autoPickup, PERF-03).
// Items never move once spawned and the list only grows (the firing range's rack replaces it with a filtered copy), so
// the index takes in new items on each query and rebuilds when the list itself is replaced. A query returns list
// indices in ascending order, so a caller visits its candidates in exactly the order a full scan of the list would.
// Deterministic; no allocation once its arrays have grown to the match's item count.
import { WORLD } from "../world/map";
import type { Item } from "./loot";

/** the index's cell size (m): a few pickup reaches, so a query reads at most 2 × 2 cells */
const ITEM_CELL_M = 8;
const ORIGIN_M = -WORLD.HALF, CELLS = Math.ceil((2 * WORLD.HALF) / ITEM_CELL_M);
const cellOf = (v: number) => Math.min(CELLS - 1, Math.max(0, Math.floor((v - ORIGIN_M) / ITEM_CELL_M)));

export class ItemGrid {
  private list: readonly Item[] | null = null;
  private count = 0;
  private readonly head = new Int32Array(CELLS * CELLS).fill(-1);
  private readonly tail = new Int32Array(CELLS * CELLS);
  private next = new Int32Array(1024);
  /** near()'s result: list indices, ascending */
  out = new Int32Array(64);
  /** list indices of the items a player dropped (Item.dropper ≥ 0) that are still held back from them, ascending */
  held = new Int32Array(64);
  heldN = 0;

  /** take in items appended to `items` since the last call; rebuild if `items` is a different list */
  sync(items: readonly Item[]): void {
    if (items !== this.list) { this.list = items; this.count = 0; this.heldN = 0; this.head.fill(-1); }
    if (this.next.length < items.length) { const g = new Int32Array(Math.max(items.length, this.next.length * 2)); g.set(this.next); this.next = g; }
    for (; this.count < items.length; this.count++) {
      const i = this.count, it = items[i], c = cellOf(it.z) * CELLS + cellOf(it.x);
      this.next[i] = -1;
      if (this.head[c] < 0) this.head[c] = i; else this.next[this.tail[c]] = i;
      this.tail[c] = i;
      if (it.dropper !== undefined && it.dropper >= 0) {
        if (this.heldN === this.held.length) { const g = new Int32Array(this.held.length * 2); g.set(this.held); this.held = g; }
        this.held[this.heldN++] = i;
      }
    }
    let n = 0;
    for (let k = 0; k < this.heldN; k++) { const i = this.held[k], it = items[i]; if (!it.taken && it.dropper !== undefined && it.dropper >= 0) this.held[n++] = i; }
    this.heldN = n;
  }

  /** the list indices of every item whose x/z lies within the square of half-size r round (x, z), and maybe a few
   *  more, ascending in `out`; returns how many. Call sync first. */
  near(x: number, z: number, r: number): number {
    const x0 = cellOf(x - r), x1 = cellOf(x + r), z0 = cellOf(z - r), z1 = cellOf(z + r);
    let n = 0;
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      for (let i = this.head[cz * CELLS + cx]; i >= 0; i = this.next[i]) {
        if (n === this.out.length) { const g = new Int32Array(n * 2); g.set(this.out); this.out = g; }
        let k = n++;
        while (k > 0 && this.out[k - 1] > i) { this.out[k] = this.out[k - 1]; k--; }
        this.out[k] = i;
      }
    }
    return n;
  }
}
