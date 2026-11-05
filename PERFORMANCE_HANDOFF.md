# Performance workstream handoff

This document owns dispatch prompts and coordination rules for the proposed work in
[PERFORMANCE.md](PERFORMANCE.md). It does not implement or authorize production automation.

## Coordinator instructions

1. Read the plan and assign **one workstream per agent**. FND's core landed (#10, #11, #12), so start with the open
   items in the table below, through the lane that owns them.
2. Give every agent an isolated branch/worktree, an approved file scope and access only to private test servers.
3. PERF-02 touches `client/src/game/render.ts`; agree ownership with anyone else editing it before writing. FND owns shared timing/schema changes. PERF-03 owns shared simulation indexing.
4. Allow code-reading/fixture design in parallel, but serialize timed GPU trials on each physical GPU.
5. Explicitly discuss protected changes under AGENTS.md before assigning implementation that requires them.
   This handoff is not blanket approval for CI, dependencies, telemetry endpoints, wire changes or balance.
6. Review evidence and integrated regressions before accepting a candidate. Negative experiments may be delivered
   without a production code change. Do not ask agents to optimize until an arbitrary percentage is reached.

## Workstream assignments

Status as of 2026-11-05 on fork main 6f684aba; [PERFORMANCE.md](PERFORMANCE.md) has the item-by-item detail.

| Id | Assignment | First deliverable | Status, lane |
|---|---|---|---|
| FND | Measurement foundation and benchmark validity | Versioned scenario/result contract, representative fixture and repeated baseline comparison | Core done (#10, #11, #12). Open, no lane: storm/endgame and multi-lobby scenarios, network tail gates, the Windows server wrapper. Open, KONG-68: one GPU query owner |
| PERF-01 | Procedural character animation budget | Crowded/dispersed CPU baseline and one distant-animation experiment | Done (#187) |
| PERF-02 | Interaction prompt query reuse/invalidation | Query-count baseline, same-frame reuse/cache experiment and responsiveness gate | Open, KONG-68 |
| PERF-03 | Deterministic loot candidate index | Trace-sensitive fixture and bounded pickup indexing experiment | Open, no lane; must pass RAY-152's determinism gates |
| PERF-04 | Tree/understory splat budgets | Fixed-quality motion route and understory-only density sweep | Open, KONG-68 |
| PERF-05 | Water SSR refinement | Water/control scenes and five-to-three refinement experiment | Done (#21). GI samples follow-up open, KONG-68 |
| OBS | Bounded incident flight recorder | Privacy/overhead design first; no new automatic uploads without review | Recorder done (#97, #105, #91), context loss done (#150, #153). Automatic upload open, no lane |
| OPS | Private continuous regression orchestration | Isolation/resource/retention design first; no live deployment or unreviewed CI changes | No-GPU CI gates done (#33, #114, #123, #153). Hardware regression lane open, no lane |

Lanes: textures KONG-44, geometry and impostors KONG-45, resource ownership KONG-47, shader-compile stalls KONG-59,
in-game FPS KONG-68, determinism RAY-152.

## Copyable agent prompt

Replace the bracketed fields before sending:

```text
You are working on Kong Royale's performance plan.

Assigned workstream: [FND / PERF-01 / PERF-02 / PERF-03 / PERF-04 / PERF-05 / OBS / OPS]
Branch/worktree: [isolated location and branch]
Approved implementation scope: [files and explicitly agreed protected changes, or "investigation only"]
Available runner: [OS, CPU/GPU, browser/backend, private server details, or "no execution environment"]
Shared-file coordination: [owner/sequence, especially game/render.ts and shared timing code]

Read AGENTS.md, CONTRIBUTING.md, ARCHITECTURE.md, PERFORMANCE.md and PERFORMANCE_HANDOFF.md first.
Treat PERFORMANCE.md as a set of unmeasured hypotheses, not evidence that a bottleneck or speedup exists.

Work only on the assigned workstream. Verify current code and instructions before editing. Preserve existing user
changes. Do not introduce dependencies or change protected files/contracts without the required discussion.
Do not test against kongroyale.com or another server we do not run.

1. State the hypothesis, eligible files, representative scenario, primary metric, guardrails and stop condition.
2. Reuse existing tools/performance helpers, parity checks and real-GPU capture infrastructure. Coordinate shared
   schema/timer changes with FND rather than creating a competing profiler or harness.
3. Establish a reproducible baseline first. Fix quality/resolution for efficiency trials and record achieved load.
   Distinguish CPU submission, valid GPU execution, frame intervals, server deadline debt and network latency.
4. Make one bounded experiment. Preserve deterministic simulation, visual/collision parity and gameplay behavior.
   Do not combine cleanup, quality reductions and algorithm changes into one unexplained result.
5. Compare repeated interleaved baseline/candidate runs on the same runner. Record run-level variability, raw data
   and environment. If the runner is unavailable or results are noisy, report blocked/inconclusive, not a win.
6. Run the narrow correctness/performance gates, then npm run build followed by npm test before every PR.
   Visible changes also require real-GPU local play and screenshot/clip evidence. Do not fake hardware performance
   with software rendering or change tests to hide failures.
7. Return the report below. Do not push, open a PR, merge, deploy, change external services or enable scheduled
   automation unless separately authorized. Commit only if the assignment authorizes it.

Required report:
- Workstream, hypothesis and whether the candidate was kept, rejected or remains inconclusive.
- Changed files and baseline/candidate commit ids (or identify uncommitted state precisely).
- Exact commands, scenario/version, seed, workload, measurement windows and runner configuration.
- Repetition count, achieved load, primary/guardrail results, variability and artifacts.
- Correctness tests and visual/motion checks: passed, failed, blocked or skipped with reasons.
- Remaining risks, protected changes needing discussion and the next smallest useful experiment.

Do not invent timing numbers, successful tests, source attribution or approvals.
```

## Next assignments

The first assignment, FND, is obsolete as written: the result contract, compare, real-play fixture and achieved-load
checks landed in #10, #11 and #12, and the `perf` skill (`.agents/skills/perf/`) is the procedure owners follow. Use the
prompt above for the open items, with this scope:

- PERF-02, PERF-04 and the GI samples experiment go to KONG-68. PERF-01 is done (#187).
- One GPU timer owner goes to KONG-68. Propose it before changing the engine, display, storm and water query paths.
- PERF-03 and the ray collider dedup have no lane. Assign a simulation owner, and gate the change on RAY-152's
  determinism checks and the `sim` step's golden hashes.
- The remaining FND scenarios (storm/endgame, multiple lobbies), network tail gates and the Windows server wrapper have
  no lane.
- Automatic incident upload and a hardware regression lane are protected (telemetry, CI). Discuss them before
  assigning.
- Keep new CI jobs, dependencies and server/telemetry endpoint changes out of any change unless approved.

## Completion and escalation

Stop and report when a task requires a protected change, overlaps another owner's files, cannot reproduce its
baseline, exhausts its agreed trial budget, or lacks suitable hardware. Do not switch to a different workstream
silently. The coordinator resolves ownership and approvals; an agent's report is not approval to ship.
