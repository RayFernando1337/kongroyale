export { lowMemoryDevice, nextNearModule, evictStreamed, trimStreamed, moduleCtx } from "./low-mem";
const POST_BUILD_EXPECT_MS = { afterBuild: 750, game: 11200, settle: 4300 };
const POST_MS_PER_PRE_READY_BUILD_MS = 0.27;
const POST_BUILD_STORE_KEY = "kr-boot-post-v1";
const POST_BUILD_STORED_MIN_MS = 2000, POST_BUILD_STORED_MAX_MS = 90_000;
const POST_BUILD_TICK_MS = 250, POST_BUILD_TICK_LATE_MS = 1000, POST_BUILD_NO_FRAME_MS = 2000;

function storedPostBuildMs(): number | null {
  try {
    const ms = Number((JSON.parse(localStorage.getItem(POST_BUILD_STORE_KEY) ?? "null") as { baseMs?: unknown } | null)?.baseMs);
    return Number.isFinite(ms) && ms >= POST_BUILD_STORED_MIN_MS && ms <= POST_BUILD_STORED_MAX_MS ? ms : null;
  } catch { return null; }
}

export function postBuildEstimate(factor: number) {
  const stored = storedPostBuildMs();
  const ms = stored ?? (POST_BUILD_EXPECT_MS.afterBuild + POST_BUILD_EXPECT_MS.game + POST_BUILD_EXPECT_MS.settle) * factor;
  return { ms, stored: stored !== null, rest: (preMs: number) => ms + POST_MS_PER_PRE_READY_BUILD_MS * preMs };
}

export function measurePostBuild(noFrameWaitCount: () => number) {
  const from = performance.now();
  let hidden = document.hidden;
  const noteHidden = () => { if (document.hidden) hidden = true; };
  document.addEventListener("visibilitychange", noteHidden);
  const noFrameWaits = noFrameWaitCount();
  let unpainted = false, measuring = true, frameAt = from;
  const noteFrame = () => { frameAt = performance.now(); if (measuring) requestAnimationFrame(noteFrame); };
  requestAnimationFrame(noteFrame);
  const tick = (due: number) => {
    if (!measuring) return;
    const now = performance.now();
    if (now - due < POST_BUILD_TICK_LATE_MS && now - frameAt > POST_BUILD_NO_FRAME_MS) unpainted = true;
    setTimeout(tick, POST_BUILD_TICK_MS, now + POST_BUILD_TICK_MS);
  };
  setTimeout(tick, POST_BUILD_TICK_MS, from + POST_BUILD_TICK_MS);
  return {
    stop() {
      document.removeEventListener("visibilitychange", noteHidden);
      measuring = false;
    },
    finish(kr: Record<string, unknown>, store: boolean) {
      kr.postBuildHidden = hidden;
      if (noFrameWaitCount() > noFrameWaits) unpainted = true;
      kr.postBuildUnpainted = unpainted;
      if (!store || hidden || unpainted) return;
      const postMs = performance.now() - from;
      const buildMs = kr.buildMs as Record<string, number>;
      const preMs = ((kr.preReady as string[] | undefined) ?? []).reduce((a, id) => a + (buildMs[id] ?? 0), 0);
      const baseMs = postMs - POST_MS_PER_PRE_READY_BUILD_MS * preMs;
      kr.postBuildMs = Math.round(postMs);
      if (baseMs < POST_BUILD_STORED_MIN_MS || baseMs > POST_BUILD_STORED_MAX_MS) return;
      const prev = storedPostBuildMs();
      try { localStorage.setItem(POST_BUILD_STORE_KEY, JSON.stringify({ baseMs: Math.round(prev === null ? baseMs : (prev + baseMs) / 2) })); } catch { kr.postBuildStoreFailed = true; }
    },
  };
}
