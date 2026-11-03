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
| `npm run bench:host -- --out <file>` | `kong-perf-result` | Authoritative host and snapshot fan-out, CPU only. `--root <checkout>` measures another checkout, `--scenario combat` runs one scenario, `--ticks N` sets the window. Each scenario plays the real start, plane and drop untimed, then times the PLAY phase. The four scenarios are still synthetic: scripted placement and inputs, humans kept alive. They are not full-match coverage. |
| `npm run bench:server -- --seconds 60 --out <file>` | `kong-perf-result` | Private server and 50 real WebSocket players, each also on an aux socket. Build first. The match gets a 5 s warm-up and a real plane, so the bench takes about 50 s plus `--seconds`. The timed window starts at the first PLAY snapshot. Linux and macOS only. |

### What the windows include

- **Host**: CPU time, wall time and memory cover the measured ticks only. The 240 benchmark warm-up ticks and the
  untimed match setup (about 2460 ticks of warm-up skip and plane) are excluded. Packet hashing for the checksum still
  runs inside the timed tick.
- **Server**: client-side metrics (RTT, snapshot gaps, input-to-ack, bytes) and the achieved load cover the PLAY window
  only. The server's own tick and event-loop histograms (`serverTickMsLifetime`, `eventLoopDelayMsLifetime`) cover
  the server's whole life, including the lobby, warm-up and plane, because `/health` can't reset them. `serverCpuMsPerSecond`
  is the CPU delta across the window. `bytesPerPlayerSecond` counts each snapshot once per player, not once per socket.

### Achieved load

A run that missed its intended load fails a gate instead of reporting low latency:

- **Host**: every measured tick is in PLAY, every driven human is alive and sent one input per tick, and combat fired
  every tick.
- **Server**: at least 95% of 60 inputs per player per second were sent, with skipped generator steps counted. The
  server kept at least 95% of 60 ticks per second, measured from snapshot tick numbers. Every snapshot in the window
  was PLAY. No errors or disconnects. Every client got at least 28 snapshots per second.

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
- Options: `--stats p50,p95,p99`, `--metrics hostTickMs,simulationMs`, `--threshold 5`, `--out comparison.json`.

Interleave the runs (base, candidate, base, candidate, ...) on the same machine. `compare.mts` warns when all
baseline runs came before all candidate runs, because machine drift can then look like a change.
