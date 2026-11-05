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
| `npx tsx tools/performance/net-tail.mts` | `kong-perf-result` (`reports/performance/net-tail.json`) | The network tail gate. Runs `tools/netlab.mts` with the game's two sockets over every weapon × path profile × RTT in [net-budgets.json](net-budgets.json) and checks each row against its budgets. Deterministic (simulated clock), so it needs no repetitions and no quiet machine; about 2 min on 2 vCPU. Report-only: exits 0 unless `--check`. See [Network tails](#network-tails). |
| `npx tsx tools/performance/gpu-match.mts --out <file>` | `kong-perf-result` | Real GPU, in-match frame timing: a seed-42 trios practice match in Chrome at a pinned video preset (default High, 1920x1080, DPR 1, no dynamic resolution), normal rAF, valid `EXT_disjoint_timer_query_webgl2` samples per frame. Four cases: `warmup-15s`, `plane`, `descent`, `ground-pan`. Build first; `--root` measures another checkout's `dist/`. One timed GPU job per machine. |
| `npx tsx tools/performance/load-profile.mts run --url http://127.0.0.1:<port> --browsers chrome,safari` | `kong-perf-result`, one file per run | Browser page load to the playable title and a practice match start, cold and warm, per phase (workload `page-load`). Chrome adds a CDP trace and CPU profile; Safari runs through safaridriver. `table` prints medians per browser. See [the profile-kongroyale-load skill](../../.agents/skills/profile-kongroyale-load/SKILL.md). |
| `npx tsx tools/performance/memory.mts run --url http://127.0.0.1:<port>` | `kong-perf-result` | Whole-browser memory per process (PSS, footprint or private bytes from the OS), JS heap after GC, every WebGL allocation, CPU copies kept after upload and decoded audio, at the title, plane, match and after leaving, over two matches. `table --md` ranks textures, modules, geometry and audio. See [the verify-memory skill](../../.agents/skills/verify-memory/SKILL.md). |

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
ln -s "$PWD/node_modules" ../kong-base/node_modules  # Windows: a junction, see the perf skill
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

## Network tails

`net-tail.mts` is the gate for how the game feels over a network. Each row is one `tools/netlab.mts` run: the real
client prediction (`ClientMatch`) and the real host loop (`MatchHost`) in one process, joined by simulated TCP links,
with a shooter firing at a strafing, jumping target on the lobby islet. The matrix comes from
[net-budgets.json](net-budgets.json): weapons (`ar`, `smg`, `shotgun`), RTTs (50, 150, 250 ms) and three path
profiles:

| Profile | Jitter | Loss | Stands for |
|---|---|---|---|
| `jitter20` | ±10 ms per way | 0 | a steady home connection |
| `loss1` | ±10 ms per way | 1% per socket and direction | busy Wi-Fi |
| `loss2j40` | ±20 ms per way | 2% | a bad connection (reported, no budget) |

Loss is modelled the way TCP behaves, not as dropped frames: a lost message arrives `max(1.25 × RTT, RTT + 35 ms)`
late and every later message on that socket waits behind it. Each client has two sockets, like the game, and the first
copy of each frame wins. The resend delay was measured with `netpath.py` (below) on Linux TCP (cubic, SACK, RACK) at
1% loss and 20 ms jitter: stalls peaked at 68-100 ms at 50 ms RTT, 167-201 ms at 150 ms and 305-336 ms at 250 ms.

Metrics, over the shooter's firing window: `confirmPct` and `ghost` (predicted hits the server confirmed or
rejected), `rttP99Ms`, `inputAckP99OverRttMs` (input sent → first snapshot acknowledging it, minus the path RTT),
`snapGapP99Ms`, `corrPct` (prediction corrections per 100 snapshots) and `holdPct` (the shooter's frames that froze
the target because no newer snapshot had arrived). The RTT sample is small (one ping a second after the first eight),
so its p99 is close to the run's maximum.

```sh
npx tsx tools/performance/net-tail.mts                    # the whole matrix, report-only
npx tsx tools/performance/net-tail.mts --check            # exit 1 when a row breaks a budget
npx tsx tools/performance/net-tail.mts --weapons shotgun --rtts 150 --secs 10
```

What it does not cover: a 50-player server under load (`bench:server`), real TCP, or a real network. For those, run
the real server and real sockets over an emulated path with `netpath.py`. It relays IP packets between two network
namespaces through TUN devices with added delay, jitter and loss, for kernels without `netem` (Linux, root):

```sh
sudo python3 tools/performance/netpath.py --rtt 150 --jitter 20 --loss 1 &
sudo ip netns exec kr-srv sudo -u "$USER" env "PATH=$PATH" KR_EVENT_MODE=0 KR_WARMUP_S=5 KR_HOST=10.77.0.1 npm start &
sudo ip netns exec kr-cli sh -c 'until curl -sf http://10.77.0.1:3020/health >/dev/null; do sleep 1; done'
sudo ip netns exec kr-cli sudo -u "$USER" env "PATH=$PATH" npx tsx tools/performance/sockets.mts \
  --url http://10.77.0.1:3020 --players 2 --aux --seconds 60 --out reports/performance/sockets-150-loss1.json
# stop the server and netpath, then remove the namespaces
sudo python3 tools/performance/netpath.py --down
```

Label those results "emulated path". Neither tool replaces one measurement over a real WAN.
