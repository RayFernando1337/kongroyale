// The half-rate guard's decisions (client/src/engine/res-guard.ts): it steps the 3D resolution down only when a match
// sits past the half-rate line, never below Auto's floor, steps back up after a run of full-rate seconds, and backs off
// instead of oscillating when an up-step falls back (RAY-186).
import assert from "node:assert/strict";
import { AUTO_RES_FLOOR, UP_AFTER_MAX_S, UP_AFTER_S, decide, guardBudgetMs, newGuardState } from "../../client/src/engine/res-guard";

const HZ60 = 1000 / 60;
/** run the guard for "seconds" with a frame model (median ms of a second at a scale); the steps it took */
function run(seconds: number, frameAt: (scale: number, s: number) => number, opts: { budgetMs?: number; top?: number; start?: number; cpuMs?: number; gpuMs?: number } = {}) {
  const st = newGuardState(), top = opts.top ?? 1, steps: Array<{ s: number; from: number; to: number; why: string }> = [];
  let scale = opts.start ?? top;
  for (let s = 0; s < seconds; s++) {
    const med = frameAt(scale, s);
    const d = decide(st, med, med, Math.round(1000 / med), opts.budgetMs ?? HZ60, opts.cpuMs ?? 7, opts.gpuMs ?? 0, scale, top, s);
    if (!d) continue;
    steps.push({ s, from: scale, to: d.to, why: d.why });
    scale = d.to;
  }
  return { steps, scale, st };
}

// full rate at 60 Hz: nothing happens
assert.equal(run(120, () => HZ60).steps.length, 0, "full rate");
// Ray's case: High at DPR 2 on Safari snaps to 30 fps; the guard steps down to the floor, then says so once
{
  const r = run(60, () => 2 * HZ60);
  assert.equal(r.steps[0].why, "halfrate");
  assert.equal(r.steps[0].s, 1, "two seconds past the line before the first step");
  assert.ok(r.steps.every((x, i) => i === 0 || x.s - r.steps[i - 1].s >= 3), "a hold between steps");
  assert.equal(r.scale, AUTO_RES_FLOOR, "stops at Auto's floor");
  assert.equal(r.steps.filter((x) => x.why === "floor").length, 1, "the floor is logged once");
  assert.ok(r.steps.length <= 7, "bounded steps: " + r.steps.length);
}
// a frame back under the line at 0.85: it steps down to there, then tries one step up after UP_AFTER_S full-rate
// seconds, falls back and waits twice as long, never more than UP_AFTER_MAX_S, and spends most of the match at full rate
{
  const r = run(1800, (scale) => (scale > 0.85 ? 2 * HZ60 : HZ60));
  const downs = r.steps.filter((x) => x.why === "halfrate"), ups = r.steps.filter((x) => x.why === "headroom"), falls = r.steps.filter((x) => x.why === "fallback");
  assert.equal(downs.length, 2, "1 → 0.92 → 0.846");
  assert.equal(ups[0].s - downs[1].s, 3 + UP_AFTER_S - 1, "first up-step after the hold and UP_AFTER_S good seconds");
  assert.ok(falls.length >= 3, "up-steps that fell back");
  for (let i = 1; i < ups.length; i++) assert.ok(ups[i].s - ups[i - 1].s >= Math.min(UP_AFTER_MAX_S, UP_AFTER_S * 2 ** i), "backoff " + i);
  assert.equal(r.st.upWaitS, UP_AFTER_MAX_S, "the wait is capped");
  assert.ok(r.steps.length < 40, "no oscillation: " + r.steps.length + " steps in 30 min");
}
// headroom comes back for good (the player left the heavy view): it climbs back to the player's 3D resolution
{
  const r = run(200, (scale, s) => (s < 20 ? 2 * HZ60 : HZ60));
  assert.equal(r.scale, 1, "back at 100 %");
  assert.ok(r.steps.at(-1)?.why === "headroom");
}
// a 120 Hz screen at a steady 60 fps is not past the line (the reference is never shorter than a 60 Hz frame)
assert.equal(run(60, () => HZ60, { budgetMs: 1000 / 120 }).steps.length, 0, "60 fps on 120 Hz");
// ...but 30 fps on it is
assert.equal(run(10, () => 2 * HZ60, { budgetMs: 1000 / 120 }).steps[0]?.why, "halfrate", "30 fps on 120 Hz");
// a player's 30 fps cap is the budget: 30 fps is full rate there
assert.equal(run(60, () => 1000 / 30, { budgetMs: 1000 / 30 }).steps.length, 0, "30 fps cap");
// the player's own 3D resolution under the floor: nothing to step, the floor is logged once
{
  const r = run(30, () => 2 * HZ60, { top: 0.5 });
  assert.equal(r.scale, 0.5);
  assert.deepEqual(r.steps.map((x) => x.why), ["floor"]);
}
// a far-too-slow frame takes the bigger step
assert.equal(run(3, () => 4 * HZ60).steps[0].to, 0.85, "big step at 15 fps");
// a stalled second (a few frames) decides nothing
{
  const st = newGuardState();
  for (let s = 0; s < 10; s++) assert.equal(decide(st, 500, 500, 2, HZ60, 7, 0, 1, 1, s), null);
}
// the budget: the player's cap wins; otherwise the highest refresh measured, so a match locked at half rate whose
// refresh re-estimate reads 30 Hz is still judged against 60 Hz and keeps stepping down
assert.equal(guardBudgetMs(30, 60), 1000 / 30, "cap");
assert.equal(guardBudgetMs(0, 0), HZ60, "refresh unknown");
{
  let maxHz = 0;
  const st = newGuardState();
  let scale = 1, downs = 0;
  for (let s = 0; s < 30; s++) {
    maxHz = Math.max(maxHz, s < 20 ? 60 : 30);
    const d = decide(st, 2 * HZ60, 2 * HZ60, 30, guardBudgetMs(0, maxHz), 7, 0, scale, 1, s);
    if (d && d.why === "halfrate") { downs++; scale = d.to; }
  }
  assert.equal(scale, AUTO_RES_FLOOR, "keeps stepping after the refresh re-estimate reads 30 Hz (" + downs + " steps)");
}
// a CPU-bound half rate (the main thread alone takes a period, or the GPU timer says the GPU is the shorter side):
// fewer pixels would not help, so the scale stays and the log says so once
{
  const r = run(30, () => 2 * HZ60, { cpuMs: 20 });
  assert.deepEqual(r.steps.map((x) => x.why), ["cpu"], "CPU-bound, no timer");
  assert.equal(r.scale, 1);
  assert.deepEqual(run(30, () => 2 * HZ60, { cpuMs: 12, gpuMs: 9 }).steps.map((x) => x.why), ["cpu"], "CPU-bound by the GPU timer");
  assert.equal(run(10, () => 2 * HZ60, { cpuMs: 7, gpuMs: 25 }).steps[0].why, "halfrate", "GPU-bound by the GPU timer");
}
console.log("res-guard: ok");
