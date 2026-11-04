// "Continue after the next paint", for build loops that yield between slices of work (the boot, the island stream,
// engine.yield) so the loading screen / title repaints between long tasks. requestAnimationFrame alone is not enough:
// Safari renders no frames while its window is off screen (a locked screen, an occluded or minimised window) and still
// reports visibilityState "visible", so a boot that waited on rAF stalled until the window came back (KONG-26 cause 6).
// afterPaint() races the frame with a timer: while frames arrive it is the rAF path, unchanged; after FRAME_WAIT_MS
// without one it continues anyway, and from then on each wait continues in a fresh MessageChannel task (timers are
// throttled in such windows; message tasks are not) until a probe frame shows the browser is painting again.
// Waits that need a REAL rendered frame (the game's prewarm frames, the title's settle frames) stay on rAF.

/** ms without a frame before a wait stops waiting for one. A visible window paints every 7-33 ms, and a hitch (a
 * synchronous shader compile on a prewarm frame) can hold the next frame for a few hundred ms: those must not count as
 * "not painting", or the build work runs back to back between the prewarm's frames and delays them. */
const FRAME_WAIT_MS = 1000;
let stalled = false;
let probe = 0;
let noFrameWaits = 0;
const channel = new MessageChannel();
const queued: Array<() => void> = [];
channel.port1.onmessage = () => queued.shift()?.();

/** a real task boundary after the next paint, or without one when the browser is not painting */
export function afterPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stalled) {
      if (!probe) probe = requestAnimationFrame(() => { probe = 0; stalled = false; });
      noFrameWaits++;
      queued.push(resolve);
      channel.port2.postMessage(0);
      return;
    }
    const raf = requestAnimationFrame(() => { clearTimeout(timer); setTimeout(resolve, 0); });
    const timer = setTimeout(() => { cancelAnimationFrame(raf); stalled = true; noFrameWaits++; resolve(); }, FRAME_WAIT_MS);
  });
}

/** afterPaint() waits that continued without a frame so far (0 on a visible window) */
export const noFrameWaitCount = () => noFrameWaits;
