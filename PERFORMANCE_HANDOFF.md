# Performance workstream handoff

This document owns dispatch prompts and coordination rules for the proposed work in
[PERFORMANCE.md](PERFORMANCE.md). It does not implement or authorize production automation.

## Coordinator instructions

1. Read the plan and assign **one workstream per agent**. Start implementation with FND.
2. Give every agent an isolated branch/worktree, an approved file scope and access only to private test servers.
3. PERF-01 and PERF-02 both touch `client/src/game/render.ts`; serialize those edits or agree non-overlapping
   ownership before writing. FND owns shared timing/schema changes. PERF-03 owns shared simulation indexing.
4. Allow code-reading/fixture design in parallel, but serialize timed GPU trials on each physical GPU.
5. Explicitly discuss protected changes under AGENTS.md before assigning implementation that requires them.
   This handoff is not blanket approval for CI, dependencies, telemetry endpoints, wire changes or balance.
6. Review evidence and integrated regressions before accepting a candidate. Negative experiments may be delivered
   without a production code change. Do not ask agents to optimize until an arbitrary percentage is reached.

## Workstream assignments

| Id | Assignment | First deliverable |
|---|---|---|
| FND | Measurement foundation and benchmark validity | Versioned scenario/result contract, representative fixture and repeated baseline comparison |
| PERF-01 | Procedural character animation budget | Crowded/dispersed CPU baseline and one distant-animation experiment |
| PERF-02 | Interaction prompt query reuse/invalidation | Query-count baseline, same-frame reuse/cache experiment and responsiveness gate |
| PERF-03 | Deterministic loot candidate index | Trace-sensitive fixture and bounded pickup indexing experiment |
| PERF-04 | Tree/understory splat budgets | Fixed-quality motion route and understory-only density sweep |
| PERF-05 | Water SSR refinement | Water/control scenes and five-to-three refinement experiment |
| OBS | Bounded incident flight recorder | Privacy/overhead design first; no new automatic uploads without review |
| OPS | Private continuous regression orchestration | Isolation/resource/retention design first; no live deployment or unreviewed CI changes |

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

## First assignment: FND

Use the prompt above with FND and this additional scope:

- Start with existing `tools/performance/common.mts`, `host.mts`, `sockets.mts`, `server-bench.mjs` and `shot.mjs`.
- Document current warmup-only workloads, packet-hashing overhead, achieved-load gaps and platform prerequisites.
- Implement the smallest versioned result/comparison contract and one representative real-play fixture before
  expanding the scenario suite. Record unsupported metrics explicitly.
- Propose a single GPU timer owner before changing both engine and display timing paths.
- Keep new CI jobs, dependencies and server/telemetry endpoint changes out of the initial change unless approved.
- Deliver reproducible local artifacts and a clear procedure the five optimization owners can follow.

## Completion and escalation

Stop and report when a task requires a protected change, overlaps another owner's files, cannot reproduce its
baseline, exhausts its agreed trial budget, or lacks suitable hardware. Do not switch to a different workstream
silently. The coordinator resolves ownership and approvals; an agent's report is not approval to ship.
