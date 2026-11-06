// The half-rate guard (RAY-186): with dynamic resolution off (every preset's default, and what an explicit High pins),
// a GPU-bound match that misses vsync is presented at half the display rate or worse, and nothing used to bring it back.
// Once a second in a match this reads the engine's frame intervals; when the median frame stays past the half-rate line
// while the main thread fits in a frame (the miss is GPU work, so fewer pixels help; a CPU-bound miss is logged and left
// alone) it steps the 3D render scale down (TAAU in the post chain; the canvas and the HUD stay native), never below Auto's
// floor, and steps it back up after a run of full-rate seconds, waiting twice as long after each up-step that fell back.
// The preset's other settings stay as they are. Every step goes into a bounded log (resLog, __kr.resLog) that KONGBOT
// and diagnostics reports carry in their context. ?resguard=1 / =0 force it on / off; it is off under automation
// (navigator.webdriver) unless forced, and ?dynres=0 or a pinned ?scale also keep it off (engine.guardScale).
import type { Engine } from "./engine";
import { flag } from "../flags";
import { AUTO_RES_FLOOR } from "./display";

export { AUTO_RES_FLOOR };
/** a median frame this many reference periods long missed vsync: presented at half rate or worse */
export const LINE_PERIODS = 1.5;
/** a median frame within this many reference periods is full rate */
export const OK_PERIODS = 1.25;
/** the reference period is the frame budget (cap or refresh), but never shorter than a 60 Hz frame: on a 120 Hz screen
 *  a steady 60 fps is not a frame rate to trade resolution for */
export const MIN_REF_MS = 1000 / 60;
/** seconds in a row past the line before a step down */
export const DOWN_AFTER_S = 2;
/** full-rate seconds in a row before the first step up; doubled after each up-step that fell back, up to the cap */
export const UP_AFTER_S = 10;
export const UP_AFTER_MAX_S = 120;
/** a step down this soon after a step up means the step up fell back */
export const FALLBACK_S = 8;
/** seconds left alone after a step, so the new scale's frames are what the next decision reads */
export const HOLD_S = 2;
/** one step multiplies the scale by STEP (up: divides); a median past BIG_PERIODS takes the bigger BIG_STEP down */
export const STEP = 0.92;
export const BIG_STEP = 0.85;
export const BIG_PERIODS = 3;
/** The guard's frame budget (ms): the player's frame cap, else the display refresh. The refresh is the highest the
 *  engine has measured this session: its estimate is retaken every 20 s, and a match locked at half rate on a 60 Hz
 *  screen (every frame two vsyncs) reads as a 30 Hz display, which would make the same 30 fps look like full rate. */
export function guardBudgetMs(capFps: number, maxHz: number): number {
  return capFps > 0 ? 1000 / capFps : 1000 / (maxHz || 60);
}
/** without a GPU timer, a main thread under this many reference periods per frame can't be what misses vsync: the
 *  miss is GPU work, which fewer pixels shorten. Above it the frame is CPU-bound and the guard leaves the scale alone */
export const CPU_BOUND_PERIODS = 0.9;
/** a second with fewer drawn frames than this (a stall, a hidden page) decides nothing */
export const MIN_FRAMES = 4;
/** log entries kept (about 150 bytes each as JSON) */
export const RES_LOG_MAX = 32;

export type StepWhy = "halfrate" | "fallback" | "headroom" | "floor" | "cpu" | "left-match";
export interface GuardState { bad: number; good: number; holdS: number; upWaitS: number; lastUpS: number; atFloor: boolean; cpuNoted: boolean }
export const newGuardState = (): GuardState => ({ bad: 0, good: 0, holdS: 0, upWaitS: UP_AFTER_S, lastUpS: -Infinity, atFloor: false, cpuNoted: false });

/** One second's decision. medMs and p95Ms are the second's frame intervals, budgetMs the frame budget (guardBudgetMs),
 *  cpuMs the main thread's smoothed ms per frame, gpuMs the GPU's (0 = no timer), scale the render scale now and top
 *  the player's 3D resolution. Returns the scale to step to and why, or null. "floor" is returned once when the frame
 *  stays past the line at the floor, with nothing left to step, and "cpu" once per run of CPU-bound seconds past it. */
export function decide(st: GuardState, medMs: number, p95Ms: number, frames: number, budgetMs: number, cpuMs: number, gpuMs: number, scale: number, top: number, nowS: number): { to: number; why: StepWhy } | null {
  if (st.holdS > 0) { st.holdS--; return null; }
  if (frames < MIN_FRAMES) { st.bad = 0; st.good = 0; return null; }
  const ref = Math.max(budgetMs, MIN_REF_MS), line = ref * LINE_PERIODS, floor = Math.min(top, AUTO_RES_FLOOR);
  if (medMs > line) { st.bad++; st.good = 0; }
  else if (medMs <= ref * OK_PERIODS && p95Ms <= line) { st.good++; st.bad = 0; }
  else { st.bad = 0; st.good = 0; }
  if (st.good) st.cpuNoted = false;
  if (st.bad >= DOWN_AFTER_S) {
    st.bad = 0;
    if (gpuMs > 0 ? gpuMs < cpuMs : cpuMs >= ref * CPU_BOUND_PERIODS) {
      if (st.cpuNoted) return null;
      st.cpuNoted = true;
      return { to: scale, why: "cpu" };
    }
    if (scale <= floor + 1e-3) {
      if (st.atFloor) return null;
      st.atFloor = true;
      return { to: scale, why: "floor" };
    }
    const fell = nowS - st.lastUpS < FALLBACK_S;
    if (fell) st.upWaitS = Math.min(UP_AFTER_MAX_S, st.upWaitS * 2);
    st.holdS = HOLD_S;
    return { to: Math.round(Math.max(floor, scale * (medMs > ref * BIG_PERIODS ? BIG_STEP : STEP)) * 1000) / 1000, why: fell ? "fallback" : "halfrate" };
  }
  if (st.good >= st.upWaitS && scale < top - 1e-3) {
    st.good = 0; st.holdS = HOLD_S; st.lastUpS = nowS; st.atFloor = false;
    return { to: Math.round(Math.min(top, scale / STEP) * 1000) / 1000, why: "headroom" };
  }
  return null;
}

/** one step: page and match seconds, phase, the second's fps and frame p95 before it, the scale before and after,
 *  why, the display refresh it judged by (guardBudgetMs), the canvas backing size, and whether the page was hidden or
 *  focused */
export interface ResStep { at: number; t: number; ph: number; fps: number; p95: number; from: number; to: number; why: StepWhy; hz: number; cv: [number, number]; hid: boolean; foc: boolean }
export const resLog: ResStep[] = [];

interface KrMatch { phase: number; time: number }
type Kr = Record<string, unknown> & { game?: { inMatch?: boolean; cm?: KrMatch | null } };

/** start the guard's once-a-second check (main.ts loads this chunk once the video settings are applied) */
export function startResGuard(engine: Engine): void {
  const forced = flag("resguard");
  if (forced === "0" || (forced !== "1" && navigator.webdriver)) return;
  const kr = (window as unknown as { __kr: Kr }).__kr;
  kr.resLog = resLog;
  const st = newGuardState(), iv = new Float32Array(engine.frameMs.length);
  let seen = engine.frameCount, stepped = false, maxHz = 0;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const log = (why: StepWhy, from: number, to: number, fps: number, p95: number) => {
    const cm = kr.game?.inMatch ? kr.game.cm ?? null : null, c = engine.renderer.domElement;
    resLog.push({ at: r1(performance.now() / 1000), t: cm ? r1(cm.time) : -1, ph: cm ? cm.phase : -1, fps: r1(fps), p95: r1(p95), from, to, why, hz: maxHz, cv: [c.width, c.height], hid: document.visibilityState === "hidden", foc: document.hasFocus() });
    if (resLog.length > RES_LOG_MAX) resLog.splice(0, resLog.length - RES_LOG_MAX);
  };
  setInterval(() => {
    const ring = engine.frameMs, count = engine.frameCount, n = Math.min(count - seen, ring.length);
    seen = count;
    maxHz = Math.max(maxHz, engine.refreshHz);
    const top = engine.resBase, scale = engine.renderScale;
    if (!kr.game?.inMatch) {
      Object.assign(st, newGuardState());
      if (stepped && scale < top) { if (engine.guardScale(top)) { log("left-match", scale, top, 0, 0); stepped = false; } }
      else stepped = false;
      return;
    }
    if (document.visibilityState !== "visible" || engine.suspended || engine.dynamicRes) { st.bad = 0; st.good = 0; return; }
    let sum = 0;
    for (let i = 0; i < n; i++) { const v = ring[(count - n + i) % ring.length]; iv[i] = v; sum += v; }
    const s = iv.subarray(0, n).sort();
    const med = n ? s[n >> 1] : 0, p95 = n ? s[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
    const d = decide(st, med, p95, n, guardBudgetMs(engine.frameCap, maxHz), engine.stepEma, engine.gpuMs, scale, top, performance.now() / 1000);
    if (!d) return;
    const fps = sum > 0 ? (n * 1000) / sum : 0;
    if (d.to === scale) { log(d.why, scale, scale, fps, p95); return; }
    if (!engine.guardScale(d.to)) return;
    stepped = true;
    log(d.why, scale, d.to, fps, p95);
  }, 1000);
}
