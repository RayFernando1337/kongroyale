# Performance tools

This folder holds the Node benchmark runners and the shared result contract. Read
[PERFORMANCE.md](../../PERFORMANCE.md) for the plan these tools serve. Every runner here measures only servers and
processes you start yourself.

## Result contract

Every runner writes one JSON file per run in the shape defined in [schema.ts](schema.ts) (`kong-perf-result`,
version 1). The file records:

- **source**: the measured checkout, its commit, and whether it had uncommitted changes.
- **environment**: OS, CPU, Node, memory, load average at start, and the GPU. `gpu` is `null` for CPU-only runners.
- **config**: every option that shapes the workload. Runs with different config are never compared.
- **cases**: one per scenario. A case has the scenario id, version, seed and workload kind, the warmup and measurement
  windows, the achieved load, the metrics, and pass/fail gates.

A metric is either a per-run distribution (`summary`: n, mean, p50, p95, p99, max), a single per-run `value`, or
`unsupported`/`invalid` with a reason. A runner that can't measure something records it that way, never as zero.

`schema.ts` imports nothing from Node, so a browser or GPU collector can use the same types.

When a scenario's workload changes, bump its `version`. When a field in the contract changes meaning, bump
`RESULT_VERSION`. `compare.mts` refuses to mix either.

## Runners

| Command | Writes | Notes |
|---|---|---|
| `npm run bench:host -- --out <file>` | `kong-perf-result` | Authoritative host and snapshot fan-out, CPU only. `--root <checkout>` measures another checkout, `--scenario combat` runs one scenario, `--ticks N` sets the synthetic window. Each scenario plays the real start, plane and drop untimed, then times the PLAY phase. `real-play` ([scenarios/real-play.mts](scenarios/real-play.mts)) is the representative one: a seeded all-bot trios match, nothing placed, timed for the first 7200 PLAY ticks (about 30 s on a 4-vCPU runner). The other four are synthetic: scripted placement and inputs, humans kept alive. `--trace` also hashes every packet. |
| `npx tsx tools/performance/alloc.mts --out <file>` | `kong-perf-result` | Bytes allocated per host tick (`allocBytesPerTick`), GC count and GC time over `real-play`'s PLAY window, read from `v8.GCProfiler` with no inspector attached. The same match as `bench:host`'s real-play, with the same state digest. Ten runs on a 4-vCPU runner spread under 3% on bytes and GC count; `gcMs` spreads about 45%, so treat it as a guardrail. `--sample` adds the top allocating functions to `detail.topAllocators` (the sampling heap profiler perturbs the JIT, so sampled runs only compare with sampled runs). `run.mts --runner alloc` interleaves it. |
| `npx tsx tools/performance/run.mts --base <checkout> --cand <checkout>` | a folder of results plus `comparison.md` | Interleaved repeated `bench:host` runs and the comparison. See below. |
| `npm run bench:server -- --seconds 60 --out <file>` | `kong-perf-result` | Private server and 50 real WebSocket players, each also on an aux socket. Build first. The match gets a 5 s warm-up and a real plane, so the bench takes about 50 s plus `--seconds`. The timed window starts at the first PLAY snapshot. Linux and macOS only. |
| `npx tsx tools/performance/gpu-match.mts --out <file>` | `kong-perf-result` | Real GPU, in-match frame timing: a seed-42 trios practice match in Chrome at a pinned video preset (default High, 1920x1080, DPR 1, no dynamic resolution), normal rAF, valid `EXT_disjoint_timer_query_webgl2` samples per frame. Four cases: `warmup-15s`, `plane`, `descent`, `ground-pan`. Build first; `--root` measures another checkout's `dist/`. One timed GPU job per machine. |
| `npx tsx tools/performance/load-profile.mts run --url http://127.0.0.1:<port> --browsers chrome,safari` | `kong-perf-result`, one file per run | Browser page load to the playable title and a practice match start, cold and warm, per phase (workload `page-load`). Chrome adds a CDP trace and CPU profile; Safari runs through safaridriver. `table` prints medians per browser. See [the profile-kongroyale-load skill](../../.agents/skills/profile-kongroyale-load/SKILL.md). |

### What the windows include

- **Host**: CPU time, wall time and memory cover the measured ticks only. The 240 benchmark warm-up ticks and the
  untimed match setup (about 2460 ticks of warm-up skip and plane) are excluded. The timed ticks hash nothing: after
  the window, `detail.stateDigest` hashes the match state (tick, items, every player's position, health, state and
  kills) to prove a run replayed the same match. `--trace` adds `detail.packetChecksum` over every packet, hashed
  inside the timed tick, so traced runs only compare with traced runs.
- **Server**: client-side metrics (RTT, snapshot gaps, input-to-ack, bytes) and the achieved load cover the PLAY window
  only. The server's own tick and event-loop histograms (`serverTickMsLifetime`, `eventLoopDelayMsLifetime`) cover
  the server's whole life, including the lobby, warm-up and plane, because `/health` can't reset them. `serverCpuMsPerSecond`
  is the CPU delta across the window. `bytesPerPlayerSecond` is every frame received on the player's sockets (main
  and aux). The server picks a random match seed and has no knob to fix it, so each server run samples a different
  match: the scenario records seed -1 and the real seed is in `detail.matchSeed`.

### Achieved load

A run that missed its intended load fails a gate instead of reporting low latency:

- **Host**: every measured tick is in PLAY, every driven human is alive and sent one input per tick, and combat fired
  every tick. `real-play` has no driven humans; its load is recorded (alive at end, kills, pellets) and fixed by the
  seed, which the state digest checks.
- **Server**: at least 95% of 60 inputs per player per second were sent, with skipped generator steps counted. The
  server kept at least 95% of 60 ticks per second, measured from snapshot tick numbers. Every snapshot in the window
  was PLAY. The match-wide alive count never dropped between two snapshots in the window, bots included, so any death
  fails, even one masked by a redeploy. No errors or disconnects. Every client got at least 28 snapshots per
  second.

## Comparing runs

```sh
npx tsx tools/performance/compare.mts --base base-{1..5}.json --cand cand-{1..5}.json --metrics hostTickMs --stats p50,p99
```

- Each run contributes one number per metric and statistic, for example its p99 host tick. Ticks or frames inside a
  run are correlated, so they are never pooled across runs.
- The table shows the median over runs, the min–max range, and that range as a percentage of the median. Run the
  baseline alone (`--base` only) to see the noise floor.
- A metric is **worse** or **better** only when every candidate run is outside the baseline runs' range and the
  medians differ by at least `--threshold` percent (default 5). Fewer than five runs on a side is **inconclusive**:
  with three, all candidates land outside the baseline range by chance 10% of the time per row, and an A/A run of
  identical code did report false regressions. With five it is under 1% per row.
- Name the primary metric and guardrails with `--metrics` before you run, and gate on those. Every extra row
  compared is another chance of a false hit, so a run over every metric is for exploring, not for a verdict.
- Exit status: 0 means no regression. 1 means a regression, a failed candidate gate, or a candidate metric that is
  `invalid` or no longer measured. 2 means the inputs can't be compared (different config, machine, scenario version
  or contract version, or a `--metrics` name that no case has).
- A zero baseline has no percentage. Any change from zero shows as "from zero" and is judged on the range test alone.
- Options: `--stats p50,p95,p99`, `--metrics hostTickMs,simulationMs`, `--threshold 5`, `--out comparison.json`,
  `--budgets tools/performance/budgets.json`.
- [budgets.json](budgets.json) holds per-scenario thresholds calibrated from A/A runs on one runner class, with the
  calibration written next to them. Recalibrate before gating on a different machine.

Interleave the runs (base, candidate, base, candidate, ...) on the same machine. `compare.mts` warns when all
baseline runs came before all candidate runs, because machine drift can then look like a change.

## Repeated baseline/candidate runs

`run.mts` does the interleaving for you (`--runner alloc` runs alloc.mts instead of host.mts): `--reps` pairs, alternating which side runs first, each run a fresh Node
process measuring the checkout you name with `host.mts --root`. Then it checks the state digests and runs
`compare.mts`.

```sh
git worktree add ../kong-base origin/main          # the baseline checkout
ln -s "$PWD/node_modules" ../kong-base/node_modules
npx tsx tools/performance/run.mts --base ../kong-base --cand . --scenario real-play \
  --metrics hostTickMs,simulationMs --stats p50,p99 --budgets tools/performance/budgets.json
npx tsx tools/performance/run.mts --base .           # A/A: the noise floor of this runner
```

- The harness (`run.mts`, `host.mts`) always comes from the checkout you run it in; only the measured game code
  comes from `--base`/`--cand`. Commit the candidate first, or the results say `dirty`.
- Every run of one side must produce the same state digest, or the run fails as nondeterministic. The two sides must
  produce the same digest too, because a performance change should replay the same match. Pass
  `--allow-outcome-change` only for an intended gameplay change.
- Results go to `--out-dir` (default `reports/performance/run-<time>/`, which git ignores): one JSON per run,
  `comparison.json` and `comparison.md`.
- Exit status is `compare.mts`'s, or 1 on a digest mismatch. Five pairs of `real-play` take about 10 minutes on a
  4-vCPU runner. Don't run anything else on the machine meanwhile.
