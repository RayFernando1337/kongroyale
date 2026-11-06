# Performance improvement plan

This document owns the proposed measurement, optimization and continuous-regression workflow for Kong Royale.
It complements [ARCHITECTURE.md](ARCHITECTURE.md), not the implementation rules in [AGENTS.md](AGENTS.md) and
[CONTRIBUTING.md](CONTRIBUTING.md). Dispatch instructions are in [PERFORMANCE_HANDOFF.md](PERFORMANCE_HANDOFF.md).
Memory work has its own plan in [docs/memory-architecture.md](docs/memory-architecture.md).

## Status and recommendation

Written 2026-11-03 from a read-only investigation of client CPU, rendering, simulation, networking and diagnostics.
The five optimization candidates below started as hypotheses, not measured bottlenecks or promised improvements.

Updated 2026-11-05 against fork main (6f684aba, after #201). Every item is marked **done** with the
pull request that did it, **open** with the lane that owns it where one exists, or **obsolete** with the reason.
File references were re-checked on that revision; verify them again before implementation.

| Status | Count | Items |
|---|---|---|
| Done | 15 | Benchmark warmup split and real-play scenario, timing without packet hashing, achieved load, simulated network tail gate, in-match real-GPU timing, result contract and compare, browser collectors, PERF-01 kong animation budget, PERF-05 water SSR, shared benchmark helpers, local Basis transcoder, metrics flight recorder, context-loss events, replay, no-GPU CI gates |
| Open | 12 | Storm/endgame and multi-lobby scenarios, real-socket and WAN network tails, Windows server wrapper, one GPU query owner, PERF-02, PERF-03, ray collider dedup, PERF-04, GI samples, DOM helpers, automatic incident upload, hardware regression lane |
| Obsolete | 4 | "No benchmarks were run", "no memory leak was established", FND as the first assignment, CI described as build and secrets only |

Lanes that own open work: textures KONG-44, geometry and impostors KONG-45, resource ownership KONG-47, shader-compile
stalls KONG-59, in-game FPS KONG-68, determinism RAY-152 (deterministic math for every platform landed in #184). An open item with no lane named has no owner
yet.

Build a small performance lab around the existing tools, then assign narrowly scoped experiments. Do not start with
a renderer rewrite, a general-purpose framework, or broad cleanup. Shared measurement and lifecycle procedures
should make extensions safe without forcing unrelated systems into one abstraction. The lab now exists (section 1);
the optimization tracks in section 2 are where most of the open work is.

This plan is not approval to change protected areas. Discuss dependencies, CI, security-sensitive server code,
wire formats, map/terrain contracts and balance as required by AGENTS.md. No public-server tests, automatic
production rollout, or automatic merging are authorized by this document.

## Goals

- Improve frame pacing and responsiveness, not just average FPS.
- Preserve authoritative, deterministic simulation and existing visual/collision parity.
- Give independent engineers a repeatable baseline, a bounded experiment and an objective acceptance gate.
- Store machine-readable evidence so later contributors can reproduce and improve results.
- Connect player incidents to private reproductions without making telemetry itself a source of stalls or leaks.

## 1. Establish trustworthy measurements first (FND)

FND was the first implementation milestone and its core landed in #10, #11 and #12. Optimization owners still must not
claim a win until their scenario produces repeatable baseline/candidate comparisons.

### Existing foundations

| Capability | Existing entry points |
|---|---|
| Result contract, statistics, environment and JSON output | `tools/performance/schema.ts`, `tools/performance/common.mts` (#10) |
| Interleaved baseline/candidate runs and verdicts | `tools/performance/run.mts`, `tools/performance/compare.mts`, `tools/performance/budgets.json` (#10, #12, #50) |
| Simulation/serialization timings | `tools/performance/host.mts`, seeded `scenarios/real-play.mts` (#11, #12) |
| Bytes allocated per tick and GC | `tools/performance/alloc.mts` (#42) |
| Private server/socket workload | `tools/performance/server-bench.mjs`, `tools/performance/sockets.mts` |
| Latency/jitter hit-registration checks | `tools/netlab.mts` |
| Wire, matrix, geometry and splat coverage checks | `npm run bench:verify` |
| Real-GPU view captures and synchronous render benchmark | `tools/shot.mjs`, `await __kr.bench(n)` (`bench()` in `client/src/engine/dev-probes.ts`) |
| Real-GPU in-match frame timing | `tools/performance/gpu-match.mts` (#18) with the fixed-seed play route `--route tour` and the per-POI `--route survey` (#201), the `?perfhud` per-second timeline (#97) |
| Page load to playable title and match | `tools/performance/load-profile.mts` (#22) |
| Whole-browser memory and what holds it | `tools/performance/memory.mts` (#96) |
| Tick/event-loop histograms, CPU and memory | `server/perf.ts`, enabled by `KR_PERF_METRICS=1` |
| Bounded error/frame evidence | `client/src/kongbot/capture.ts` |
| Player reports, playtest bundles, durable server queue and triage | `client/src/kongbot/`, `server/kongbot.ts`, `tools/kongbot/cli.mts` (#105) |

### Fix benchmark blind spots

1. **Separate match warmup from benchmark warmup and add real-play scenarios.** **Done:** `bench:host` plays the real
   start, plane and drop untimed and times only the PLAY phase, and `bench:server` waits for PLAY too (#11). A seeded
   all-bot trios `real-play` scenario is the representative one (#12). **Open:** storm/endgame and multiple-lobby
   scenarios still don't exist; do not label synthetic islet combat as representative full-match coverage.
2. **Separate correctness instrumentation from timing.** **Done (#12):** the timed ticks hash nothing; a digest of the
   match state after the window checks that both sides replayed the same match, and `--trace` hashes every packet in a
   separate, slower mode that only compares with traced runs.
3. **Record achieved load.** **Done (#11):** results record inputs per player per second and skipped generator steps,
   and the `inputLoadAchieved` and `serverKeptTickRate` gates reject an under-driven run.
4. **Gate relevant network tails.** **Done (#192, #216):** `tools/performance/net-tail.mts` reports RTT, input ack,
   snapshot gaps, corrections, remote holds and hit confirm/ghost rates at 50, 150 and 250 ms RTT with jitter and loss
   profiles, against `net-budgets.json`; `npm test` fails when a row breaks one (check `nettail`). **Open:**
   real-socket and WAN numbers still need runs over `netpath.py` or a real network; see
   [tools/performance/README.md](tools/performance/README.md#network-tails).
5. **Keep platform prerequisites explicit.** The server wrapper sets `KR_EVENT_MODE=0` for private room creation.
   **Open:** its extensionless `node_modules/.bin/tsx` spawn still targets Linux/macOS; Windows compatibility is not
   established.
6. **Do not confuse render throughput with live latency.** `__kr.bench()` forces completion with `readPixels`.
   Keep it for controlled rendering comparisons. **Done:** normal-rAF in-match measurement exists in
   `gpu-match.mts` (#18) and the `?perfhud` timeline (#97).
7. **Unify GPU query ownership.** **Open (KONG-68).** Elapsed-time queries are still owned separately by the
   engine (`client/src/engine/engine.ts:715-760`), display calibration (`client/src/engine/display.ts:360-373`) and the
   storm volume (`client/src/game/storm/volume.ts:615`). The water grab's query (`client/src/world/water/grab.ts:97`) is
   an `ANY_SAMPLES_PASSED_CONSERVATIVE` occlusion query, not a timer, so the timer owner doesn't need to serve it. One bounded
   query owner should serve calibration, dynamic resolution, profiling and collection. Avoid overlapping elapsed-time
   queries; use exclusive pass-profiling leases. Retain raw valid samples, explicitly mark unsupported timing and
   discard disjoint results. The existing smoothed controller estimate is not a suitable raw regression distribution.

Evidence: `tools/performance/host.mts`, `tools/performance/server-bench.mjs:16-17`,
`tools/performance/sockets.mts:75-84`, `client/src/engine/engine.ts:715-760`, `client/src/engine/display.ts:360-373`.

### Measure four different sources of lag

| Layer | Primary measurements | Interpretation |
|---|---|---|
| Client CPU | Update/render-submission spans, actor/HUD costs, frame intervals, hitch counts | JS timing is not GPU execution time. |
| GPU | Asynchronous query samples, pass samples, render resolution, draws/points | Reject invalid/disjoint samples; count all frame passes, not only the last render call. |
| Server | Tick execution, deadline lateness, accumulator debt, catch-up batches/cap hits, rolling event-loop delay/utilization | Fast individual ticks do not prove timely delivery under multiple lobbies or GC. |
| Network | RTT/jitter, snapshot age/gaps, input ack age, reconciliation frequency/magnitude, queue depth | Loopback and simulated pipes do not prove WAN or input-to-photon latency. |

Also record cold/warm boot milestones (`load-profile.mts`, #22) and memory/resource trends across repeated matches
(`memory.mts`, #96). The original investigation found no concrete memory leak; that is **obsolete**. Matches did
leak, and the leaks were fixed (#108, #110, #146) and are now gated in CI by a match-to-match check (#123).

At 60 FPS the frame interval is 16.67 ms; at 120 FPS it is 8.33 ms. These are interval budgets, not a license for every
subsystem to consume that whole time. Server tick execution needs headroom inside its 16.67 ms fixed step.
Choose supported-device targets after baselining. Browser long-animation-frame entries start above 50 ms and miss
many frame-budget failures, so use them for attribution, not as the only game performance metric.

### The measurement contract

**Done.** The files this section proposed now exist in `tools/performance/`: `schema.ts` and `compare.mts` (#10),
`run.mts`, `scenarios/real-play.mts` and `budgets.json` (#12, #50). [tools/performance/README.md](tools/performance/README.md)
describes the contract. Extend these rather than adding a competing harness.

Browser runtime collection must remain browser-safe; `schema.ts` imports nothing from Node so a browser or GPU
collector can share its types. Keep platform collectors separate while sharing portable types and metric semantics.

Each result should include:

- Schema version, commit, dirty state, scenario id/version, seed and relevant world/asset version.
- Workload phase, player/lobby counts, duration, achieved load and warmup/measurement windows.
- Hardware/OS, Node/browser version, GPU/backend, viewport/DPR and quality/AA/render scale.
- Fixed-quality or adaptive-experience mode, cache state and visibility/focus state.
- Run-level summaries plus bounded raw samples; unsupported and invalid metrics must not become zero-cost results.
- Correctness gates, exit status, errors and artifact references for traces/screenshots.

### Repeatable comparison procedure

1. Define the hypothesis, primary metric, guardrails and eligible files before editing.
2. Verify the fixture is representative and sensitive to the intended change.
3. Fix hardware, browser/backend, workload, seed, resolution and quality. Warm up JIT/shaders where appropriate.
   Measure cold boot separately with an explicit cache protocol.
4. Run repeated interleaved baseline/candidate trials on the same runner. Start with several repetitions, then
   increase them when variance makes the conclusion unclear. Separate independent runs from correlated frames.
5. Compare run-level results and tail distributions. Do not pool all frames and claim they are independent trials.
   Establish noise before choosing regression thresholds; report inconclusive results honestly.
6. Pass correctness and visual/motion gates. Preserve evidence of failed or rejected experiments.
7. Recheck the accepted candidate against the broader scenario suite and the current integration base.

The `perf` skill (`.agents/skills/perf/`) scripts this procedure for host and allocation changes.

Maintain two modes:

- **Fixed quality:** disable dynamic resolution and pin settings to compare efficiency.
- **Player experience:** normal frame cap and adaptive resolution; track pacing and image-resolution stability.

Run one timed GPU job per physical GPU. Keep software-rendered functional checks separate from hardware performance
results. Do not add blocking GL reads to production hot paths to make profiling easier.

## 2. Five initial optimization tracks

The order is a dispatch recommendation based on code evidence and experiment scope, not a measured cost ranking.
Keep each experiment single-variable. PERF-01 and PERF-05 have landed; the other three are still hypotheses.

### PERF-01: Budget procedural character animation

**Status: done (#187).** A kong drawn at the min tier re-poses at most every `ANIM_SMALL_S` (1/30 s), and one neither
in view nor casting a shadow into it every `ANIM_HIDDEN_S` (0.1 s). In between, its last pose follows the body rigidly,
the springs step at most `SPRING_DT_S`, and shots and hits it skipped still play (`client/src/actors/kong.ts`,
`client/src/actors/kong-rig.ts`). Drawing is unchanged; IK, overlays, staged poses and shot mode re-pose every frame.

**Hypothesis:** full animation work is paid for remote characters that are tiny or off-screen, even though drawing
already uses screen-size LOD. `updateActors` calls `apply`, which runs the full pose/IK/face pipeline.

Evidence: `client/src/game/render.ts:2072-2112`, `client/src/actors/kong.ts:1150`, `client/src/actors/kong-rig.ts`.

- First experiment: keep near animation unchanged; reduce distant pose update cadence and/or omit unnecessary
  face/foot-IK work using existing projected-size information. Avoid blindly multiplying spring integration `dt`;
  preserve stable time progression and smooth re-entry.
- Scenarios: crowded warmup, dispersed mid-match, rapid camera turn, canopy/descent and entering close combat.
- Metrics: actor-update CPU p50/p95/p99, full/reduced rig counts, whole-frame tails.
- Gates: stable pose recovery, hands/weapons/outfits/eyes, shadows and relevant auxiliary views. Do not freeze a
  character merely because the main camera cannot see it if another visible pass still needs its pose.
- Preserve instanced rendering, bone texture uploads, LOD hysteresis and dither crossfade.
- Never alter simulation/hitboxes or assume render pose budgeting changes authoritative state.
- Owner: character engineer; coordinate shared `game/render.ts` edits with PERF-02.

### PERF-02: Invalidate and cache interaction queries

**Status: open (KONG-68).** The interact prompt is still recomputed every frame.

**Hypothesis:** per-frame HUD interaction work scans world collections unnecessarily. The prompt block queries
vehicles twice and checks loot, chests, glass and ziplines; the loot helper scans all items.

Evidence: `client/src/game/render.ts:2500-2516`, `shared/sim/pickup.ts:37`.

- First experiment: reuse same-frame results and cache prompt candidates until relevant player/aim/world changes,
  with a bounded refresh interval. Test cadence before building a new index.
- Invalidate on spawn/take/remove, relevant state changes and snapshot updates; handle practice and online paths.
  Recompute on an interaction action; a stale prompt must never authorize gameplay.
- Scenarios: empty jungle, dense/looted POI, aiming across adjacent items, range racks, moving vehicles and ziplines.
- Metrics: prompt CPU, inspected candidates/raycasts, refresh count and prompt response delay.
- Gates: unchanged pickup choice/reachability; no stale prompt or perceptible interaction delay. A provisional
  100 ms maximum refresh bound is a hypothesis to test, not a guaranteed acceptable feel.
- Preserve existing HUD dirty checks and server-side validation.
- Owner: gameplay/UI engineer.

### PERF-03: Deterministic loot candidate indexing

**Status: open.** No lane owns simulation CPU; any change must pass the determinism gates RAY-152 owns. #46 removed the
per-item closure allocation in `autoPickup`, but pickup and bot acquisition still scan every item.

**Hypothesis:** automatic pickup and bot acquisition repeatedly scan loot collections; cost grows with players
multiplied by world loot.

Evidence: `shared/sim/match.ts:1213-1217`, `shared/sim/bots.hot.ts:466`, `shared/sim/bots.hot.ts:569`
(the per-tick bot code moved there in #76).

- First experiment: a match-owned, allocation-free spatial candidate index for bounded pickup queries.
  Expand to bot acquisition only after proving weighted search coverage and tie ordering remain equivalent.
- Preserve original candidate order, floor/reachability checks, freshly spawned drops and taken-item visibility.
  A local-radius lookup must not silently replace a bot's global search.
- Scenarios: hot-drop loot, many dropped items, sparse late game and multiple fixed seeds.
- Metrics: inspected candidates, query/bot CPU, simulation p95/p99 and bot arming/acquisition times.
- Gates: deterministic state/event trace comparisons (the `sim` step's golden hashes), pickup tests, path/movement
  checks and full seeded matches. Share candidate lookup where appropriate, not every caller's decision policy.
- Preserve existing think staggering and pickup cadence. Do not start by indexing the 50 players; maintenance may
  exceed savings and a once-per-tick index could change sequential observation semantics.
- Owner: simulation engineer.

Follow-up after profiling: ray-local collider deduplication in `shared/sim/world.ts:826-941`. **Status: open**, same
owner note as PERF-03. #13 and #19 cut the boxes and cells a ray tests, but a box spanning several cells can still be
tested once per cell; the capsule queries already deduplicate with a generation stamp, the raycast doesn't. Preserve
equal-distance selection, normals, terrain precedence, glass and nested query safety. Existing grids/DDA already
provide a broadphase; do not replace them without comparative evidence.

### PERF-04: Separate tree and understory splat budgets

**Status: open (KONG-68).** The density sweep hasn't been run. `gpu-match.mts --route tour` (#201) now gives a
fixed-seed motion route to run it on. Quality tiers still apply one `dist` and one `density`
multiplier (`client/src/world/veg/index.ts:228-300`).

**Hypothesis:** the same quality multiplier for trees and understory spends unnecessary far-vegetation work.

Evidence: `client/src/world/veg/index.ts:228-300`, `client/src/world/veg/splat.ts:36-44`.

- First experiment: hold trees fixed; sweep understory density in small steps, such as baseline, -10%, -20%.
  Evaluate tree density independently afterward. Reuse existing `SplatSet` density controls.
- Scenarios: jungle trail, aerial forest, descent into canopy; fixed 1080p/1440p/4K where supported.
- Metrics: valid GPU p50/p95, frame p95/p99, submitted points/per-level counts and selection CPU.
- Gates: no crown holes, silhouette loss, shimmer, brightness shifts or visible transition bands; test moving
  cameras with TAA and with FXAA/off.
- Preserve actual-scene-height selection, complementary dissolves, ordering, dirty uploads and fallback paths.
  Fewer points can mean larger sprites and more overdraw; accept measured frame improvement, not point count alone.
- Owner: vegetation engineer.

### PERF-05: Reduce water SSR refinement cost

**Status: done (#21).** High-tier SSR refines its hit in three binary steps instead of five
(`client/src/world/water/shader.ts:1073-1100`); march count, reach and strength were left alone.

Separate later experiment: GI samples eight to six, without changing AO resolution or temporal blending.
**Status: open (KONG-68).** `GI_SAMPLES` is still 8 (`client/src/world/atmos/post.ts:467`). The file already uses
blur/history and staggered work; compare compute frames separately from reused frames. Prior quarter-resolution AO
artifacts are documented there; do not repeat that shortcut.

## 3. Extension and DRY procedures

Every new subsystem or substantial extension should describe:

1. Which module owns it and where per-frame work registers.
2. What makes its state dirty, when it sleeps and its update cadence.
3. Which resources it owns and whether teardown disposes or deliberately pools them.
4. Which counters/spans identify its cost without per-frame allocation.
5. Which scenario, correctness test and visual/motion gate exercise it.

Build on `WorldModule` in `client/src/world/module.ts`, which now takes a region resource scope and an optional
`release` (#122). Preserve idempotent `afterBuild`, sliced builds, readiness holds and shared authoritative collision
layouts. Add contract fields only for demonstrated reuse. Resource ownership rules are in
[docs/memory-architecture.md](docs/memory-architecture.md) and enforced by the `resource-owner` lint rule (#103).

Small DRY work worth considering, in separate scoped changes:

- One GPU query lifecycle and portable metric semantics. **Open (KONG-68)**, the same item as FND-7.
- Existing benchmark statistics/environment helpers rather than new per-runner implementations. **Done (#10):**
  every runner writes the shared `kong-perf-result` contract.
- Shared DOM `el`/dirty-text/class/clock helpers, preserving differing behavior instead of mechanically replacing it.
  **Open**, no lane.
- Consistent decoder configuration. **Done (#167):** the Basis transcoder is self-hosted and one KTX2 pool serves both
  `engine/assets.ts` and the lobby atlas.

Do not attach an unrelated cleanup to an optimization PR. Fewer lines or abstractions alone are not performance wins.

## 4. In-game diagnostics and crash evidence (OBS)

Extend KONGBOT's bounded capture and triage rather than replacing it. Current submission is player-initiated;
capturing errors in a local buffer is not automatic crash delivery.

**Done:** a cheap, bounded flight recorder exists. `?perfhud` keeps a per-second metrics timeline for the session
(#97); KONGBOT reports and F8 marks save playtest bundles with metrics, flags, build identity and the input replay
(#105); every report carries the build (#91). Context loss has a policy (#109), restores in place with reload as the
fallback (#150), and is checked in CI on SwiftShader (#153, #179).

**Open**, no lane: automatic incident upload. The rules below still apply before anything is sent without the player
pressing a button.

- Do not run visual raycasts, screenshots, large serialization or synchronous GL diagnostics in a hitch callback.
- Sample, deduplicate and rate-limit automatic reports; cap storage, payloads and retry/backoff.
- Treat current URLs/query strings, callsigns, screenshots, console content and movement trails as potentially
  sensitive. Establish consent, redaction, access and retention before automatic upload; do not reuse the full manual
  report payload by default. Do not transmit to an external service without user authorization.
- Distinguish handled errors, context loss, disconnects, stalls and confirmed process exits. A killed renderer/GPU
  process may never execute a reporting callback. Combine breadcrumbs with private runner watchdogs and server
  evidence; no client-only system guarantees complete crash capture.
- Manual report snapshots are not deterministic replays on their own. **Done:** an explicit replay design exists, an
  input recorder with `replayMatch` (#45) and `tools/replay.mts` with a round-trip test (#80).

Server-side telemetry ingestion is a protected area requiring discussion. Preserve existing quotas and durable
fallbacks. Heavy report handling/storage must not starve the authoritative match event loop.

## 5. Continuous improvement workflow (OPS)

```text
Incident or regression
  -> deduplicate and claim work
  -> private reproduction and baseline
  -> isolated single-variable candidate
  -> correctness + performance + visual/motion checks
  -> evidence-backed pull request
  -> human review and normal release process
```

- Give each task an owner, file scope, hypothesis, scenario, primary metric, guardrails and stop condition.
- Use isolated branches/worktrees; keep shared-file edits serial or explicitly coordinated.
- Schedule bounded trials, not an infinite mutation loop. Cap attempts, time, CPU/GPU/memory, disk and retries.
- Deduplicate incidents/tasks, use expiring claims and heartbeat/watchdog recovery, and retain rejected experiments.
- Keep one timed job per GPU; do not compare runs contaminated by sibling agents' builds or workloads.
- Use fast CPU/correctness gates first, then dedicated hardware lanes and longer soak/rematch runs.
- GPU runners executing untrusted changes must be isolated and have no deployment credentials or sensitive network
  access. Do not execute fork PR code on a privileged persistent runner.
- Record runner health and instrumentation overhead. Retain artifacts for failures and accepted candidates with
  explicit retention limits; do not silently advance baselines after a failure.
- Re-run integrated changes; independently beneficial patches can interact badly.
- Produce PRs, not automatic merges or deployments. CI/runner/service additions require the repository's discussion.

**Done:** `.github/workflows/ci.yml` now runs more than build, tests and secret checks. It also runs a no-GPU boot
smoke with a title memory budget (#33, #114), a match-to-match memory check (#123) and a context-restore check (#153),
and `npm test` checks download size against its budgets (#61). The earlier description of CI as build and secrets only
is obsolete.

**Open**, no lane: a hardware performance regression lane. Real-GPU timing is still a manual step, the flight check in
the release GPU smokes (#141, #152), not a CI gate or a scheduled run. A staged rollout is still: local FND artifacts
-> private repeatable runs -> reviewed regression lane -> scheduled soak/incident intake. This plan installs none of
those services or schedules.

## 6. Commands and validation

Existing examples, run from the repository root after installing dependencies. Use only servers you run.

```sh
npm run build
npm test
npm run bench:host -- --out reports/performance/host-base.json
npm run netlab -- 20,80,160,250,320 --jitter 20 --secs 20 --weapon ar
npm run sim -- trios 42
node tools/shot.mjs biome-01-beach --bench --q high --out shots/performance/base
```

`bench:host` times the PLAY phase, and its `real-play` scenario is the representative one; the other host scenarios
are synthetic. `bench:splat-viewport` is a CPU-side coverage regression check, not a GPU speed benchmark.
`shot --bench` is a synchronous view benchmark, not a live CPU/input-latency test; use `gpu-match.mts` or
`?perfhud` for in-match frame timing.

For the private server wrapper on Linux/macOS, build first, then:

```sh
npm run bench:server -- --seconds 60 --out reports/performance/sockets-base.json
```

The wrapper sets `KR_EVENT_MODE=0` itself, but its process spawning is still not Windows-compatible. Do not work around
a failed launch by pointing tests at a public host.

Before every PR, run `npm run build` then `npm test`, plus the narrow scenario/correctness gates.
Visible changes also need a real-GPU local play check and screenshot or clip. Record unavailable checks as blocked,
not passed. Do not install dependencies or change CI just to conceal an environment limitation.

## 7. Dispatch order and completion evidence

1. FND: **done** for host and socket workloads (#10, #11, #12). Still open: storm/endgame and multi-lobby scenarios,
   real-socket and WAN network tails, the Windows server wrapper and the GPU query owner.
2. PERF-01: done (#187). PERF-02: open, KONG-68.
3. PERF-03 and ray deduplication: open, no lane; trace fixtures exist (the `sim` step's golden hashes), and RAY-152 owns
   determinism.
4. PERF-04 and GI samples: open, KONG-68. PERF-05 is done (#21).
5. OBS/OPS: the bounded recorder, replay and no-GPU CI gates are done; automatic upload and a hardware regression lane
   are open with no lane.

Each delivered task needs: hypothesis, before/after commit ids, full scenario/configuration, repetitions and noise,
primary and guardrail metrics, correctness/visual results, artifacts, limitations and a recommendation to keep,
reject or continue. A careful negative result is useful. Never invent a baseline, gain or successful validation.

## Research references

These inform procedures, not proof of this game's bottlenecks:

- [MDN: WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices):
  avoid blocking GL operations in production paths; prefer asynchronous work.
- [Khronos: WebGL2 timer queries](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/):
  asynchronous availability and disjoint validity.
- [MDN: long animation frames](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing):
  50 ms reporting threshold and attribution.
- [Node 22: performance APIs](https://nodejs.org/docs/latest-v22.x/api/perf_hooks.html):
  event-loop delay/utilization; histogram delay units require conversion.
- [Google Benchmark guide](https://google.github.io/benchmark/user_guide.html):
  warmup, repetitions and random interleaving to reduce system-state bias. Its principles apply here without adding
  the C++ library as a dependency.
