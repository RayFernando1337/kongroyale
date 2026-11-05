---
name: perf
description: "Measure a Kong Royale server or sim performance change the way this repo trusts: interleaved baseline/candidate runs of bench:host (host tick) or alloc.mts (bytes per tick, GC), the state-digest check that both sides replayed the same match, compare.mts verdicts against budgets.json, and a checklist before you report a number. Also how to find what allocates. Use when you change shared/, server/ or shared/net code that could cost time or allocation, when you claim a speedup or regression, or when asked to profile the host."
---

# Measure a Kong Royale perf change

The tools live in [tools/performance/](../../../tools/performance/README.md); read its README for the result contract
and every option. This skill is the order to use them in and the mistakes to avoid. It covers the authoritative host
(CPU only, runs on any machine). For page load use [profile-kongroyale-load](../profile-kongroyale-load/SKILL.md); for
GPU frame time, `tools/performance/gpu-match.mts` on real hardware.

| Question | Runner | Primary metrics |
|---|---|---|
| Is the host tick faster or slower? | `host.mts` (`npm run bench:host`), `--scenario real-play` | `hostTickMs`, `simulationMs` (p50, p99) |
| Does it allocate more or less? GC? | `alloc.mts` | `allocBytesPerTick`, `gcCount` (`gcMs` is a noisy guardrail) |
| What allocates? | `alloc.mts --sample` | `detail.topAllocators` (diagnosis only, never compared) |

Both runners play the same seeded all-bot trios match (`scenarios/real-play.mts`) and time 7,200 PLAY ticks.

## 1. Before you run

1. Write the claim you expect to ship, in its final words: "allocBytesPerTick −55% on real-play, digest unchanged".
   Name the primary metric now. Every extra metric you gate on is another chance of a false hit.
2. Commit the candidate. Uncommitted runs are marked `dirty` and their commit does not identify the code.
3. Make a baseline checkout next to this one:

   ```sh
   git worktree add ../kong-base origin/main
   ln -s "$PWD/node_modules" ../kong-base/node_modules
   ```

   On Windows, Git Bash's `ln -s` copies the folder instead of linking it. Make a junction from PowerShell instead:
   `New-Item -ItemType Junction -Path ..\kong-base\node_modules -Target "$PWD\node_modules"` (`mklink /J` in cmd).
   Before you remove the worktree, delete the junction alone with `cmd /c rmdir ..\kong-base\node_modules` (no `/s`),
   so no recursive delete walks into this checkout's `node_modules`.

4. Check the machine is idle (`uptime`, `nproc`; on Windows, Task Manager or
   `Get-Counter '\Processor(_Total)\% Processor Time'`). Run nothing else while a benchmark runs, including builds,
   `npm test` or a second benchmark.

## 2. Run interleaved, five pairs or more

`run.mts` alternates base and candidate (A B, B A, ...), each in a fresh Node process, then checks digests and runs
`compare.mts`. The harness always comes from the checkout you run it in; only the measured game code comes from
`--base`/`--cand`.

```sh
# host tick, about 10 min for 5 pairs on 4 vCPU
npx tsx tools/performance/run.mts --base ../kong-base --cand . --scenario real-play \
  --metrics hostTickMs,simulationMs --stats p50,p99 --budgets tools/performance/budgets.json
# allocation and GC, about 4 min for 5 pairs
npx tsx tools/performance/run.mts --runner alloc --base ../kong-base --cand . \
  --metrics allocBytesPerTick,gcCount,gcMs --budgets tools/performance/budgets.json
# noise floor of this machine: the same checkout on both sides (A/A)
npx tsx tools/performance/run.mts --base .
```

Results land in `reports/performance/run-<time>/` (git ignores it): one JSON per run, `comparison.md`.

The same commands run in Git Bash on Windows. In PowerShell, join each command onto one line, because the trailing `\`
continuations are POSIX shell syntax. On a Windows on ARM64 desktop (20 cores, Node 24.20 arm64),
five host pairs took 139 s and five alloc pairs 137 s.

On a cloud machine a long background run can die when the machine sleeps or restarts. Run it in the foreground with
a long enough timeout, or check that every run file exists before you read `comparison.md`.

## 3. Read the verdict

- **Digest.** "every run replayed the same match" is required for a performance change. "OUTCOME CHANGED" means the
  candidate plays a different match, so its timing is not comparable and `shared/` lost determinism or behaviour
  changed. Find out which before anything else. Pass `--allow-outcome-change` only for an intended gameplay change,
  and say so in the PR. Also run `npm run sim -- trios 42 --check`: the pinned hash `SIM_HASH_TRIOS_42` must not move
  unless the PR means it to.
- **worse / better** needs every candidate run outside the baseline range and a median change past the threshold
  (5% by default, per row from `budgets.json`). "no clear change" and "below threshold" mean no measurable difference:
  report them that way, not as a small win.
- **Exit status.** 0 means no regression. 1 means a regression past budget, a failed gate, a lost metric or a digest
  mismatch. 2 means the runs can't be compared (different config, machine, Node or scenario version).
- **Budgets** in `budgets.json` were calibrated on one runner class (4 vCPU AMD EPYC, Node 22.23.4), with the
  calibration written next to them. Timing budgets don't transfer to another machine: run an A/A there first. Byte
  and GC-count budgets don't depend on CPU speed, but they do move with the Node/V8 version.

## 4. Checklist before you report a number

Adapted from the pstack benchmark checklist. Answer each one from a run, not from reading the code.

1. **What limits it?** The host is bound by ray and box tests (`rayBox`, `raycast`, `gather`), not by GC. Profile
   with `node --cpu-prof --import tsx tools/performance/host.mts --scenario real-play` in a run you don't report.
   Removing something that takes 10% of the tick can make the tick at most about 11% faster.
2. **Is it tuned like production?** Node 22, no inspector attached, no `--trace-*` flags in timed runs. The inspector
   (`--sample`, heap profiling) changes what V8 optimizes. Use it only to attribute, never in a run you report.
3. **Did it break a limit?** A speedup larger than the share of time the changed code took measured something else.
4. **Did it error?** Gates in each result (`measuredInPlay`, `hostP99Within60Hz`) must pass. real-play gates nothing
   on load, so compare each side's `load` (`aliveAtEnd`, `kills`, `pellets`) yourself: a side with fewer players
   alive or fewer pellets did less work.
5. **Does it reproduce?** Five runs a side minimum, interleaved. A gap smaller than the A/A spread is no difference.
6. **Does it matter?** Put a micro result next to `hostTickMs` on real-play. An allocation cut that leaves the tick
   unchanged is still worth shipping when it cuts GC count, but claim the allocation cut only.
7. **Did the work happen?** The digest checks the final state and the gates check the phase; with equal `load`
   numbers they show the same match ran. A code path the scenario never
   reaches (humans, vehicles) is not measured by real-play: say so instead of claiming it.

Lead the report with the verdict, then one primary number with run count and range, for example "allocBytesPerTick
419 KB → 188 KB (−55%), 5+5 interleaved runs, ranges ±1%, digest unchanged; hostTickMs no clear change".

## Finding what allocates

1. `npx tsx tools/performance/alloc.mts --sample` lists the top allocating functions, in bytes per tick. The
   attribution is per function, and inlined callees are charged to their caller.
2. Confirm a suspect without the inspector: wrap it (`proto.fn = function (...a) { ... }`) and sum
   `v8.getHeapStatistics().used_heap_size` before and after each call, skipping calls that saw a GC. That gives bytes
   per call.
3. Check it is optimized (`node --allow-natives-syntax`, `%GetOptimizationStatus(fn)`) before blaming boxing in the
   interpreter.
4. Bisect with a temporary early `continue`/`return` and measure again. Each try takes a minute.

Known cause, found this way: a closure inside a loop that captures the loop variable (`for (const it of items) {
... slots.some((s) => s.id === it.sub) ... }`) makes V8 allocate a context on every iteration, even when the closure
never runs. In `Match.autoPickup` that was about 40 B per item visited, 55% of the sim's allocation. Fix it with a
module-level helper that takes the value as a parameter. Indexed loops versus `for-of` made no difference there.
