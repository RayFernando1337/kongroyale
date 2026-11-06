// The display's refresh rate, estimated from requestAnimationFrame timestamps. The engine uses it as the default frame
// cap and the dynamic-resolution target; the video menu and KONGBOT reports show it. A sample is steady or uneven: a
// steady one (the frames kept pace) reads its median, an uneven one (a game missing vsync) its fast tail, and the
// engine holds an uneven reading under the highest steady one on the screen, since Safari's timestamps under an uneven
// load carry a fast tail that is no period at all.

/** Percentile of the intervals read as the period. A frame that misses vsync is presented one or more whole periods
 *  later, never earlier, so the fast tail of the rAF intervals is the period itself however slow the game runs on
 *  average. The 20th percentile used before read a GPU-bound 21 fps match on a 60 Hz screen as 30 Hz (RAY-186). At 5 %,
 *  at least 5 of every 90 frames must make vsync; fewer read as a fraction of the refresh, as no frame making it does. */
export const REFRESH_TAIL_PCT = 5;
/** a sample whose median interval is within this factor of its fast tail is steady, and its median is the period.
 *  Safari's rAF timestamp is when the rendering update started, not the vsync: idle they spread about ±3 ms (a 14 ms
 *  fast tail on a 60 Hz screen, which read 71 Hz), and under an uneven load an update that starts late is followed by
 *  one a few ms after the next vsync, so the fast tail read 100-144 Hz on a 60 Hz screen (RAY-186, the guard's A/B) */
export const STEADY_RATIO = 1.3;
const SNAP_HZ = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 175, 180, 200, 240, 280, 300, 360, 480, 500];

/** one sample of rAF intervals (ms): the refresh it reads (Hz, snapped to a common display rate when within 4 %, at
 *  least 3 Hz, of one) and whether it was steady */
export function refreshSample(intervalsMs: readonly number[]): { hz: number; steady: boolean } {
  const s = [...intervalsMs].sort((a, b) => a - b);
  const tail = s[Math.floor((s.length * REFRESH_TAIL_PCT) / 100)], med = s[s.length >> 1], steady = med <= tail * STEADY_RATIO;
  const hz = Math.round(1000 / (steady ? med : tail));
  const snap = SNAP_HZ.reduce((a, b) => Math.abs(b - hz) < Math.abs(a - hz) ? b : a);
  return { hz: Math.abs(snap - hz) <= Math.max(3, hz * 0.04) ? snap : hz, steady };
}

/** refresh (Hz) from rAF intervals (ms) */
export function refreshFromIntervals(intervalsMs: readonly number[]): number {
  return refreshSample(intervalsMs).hz;
}

/** the refresh to use from a sample, given the highest steady reading on this screen (0 = none yet): an uneven sample
 *  reads at most that */
export function heldRefresh(sample: { hz: number; steady: boolean }, steadyHz: number): number {
  return sample.steady || !steadyHz ? sample.hz : Math.min(sample.hz, steadyHz);
}
