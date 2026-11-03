# Performance improvement plan

This document owns the proposed measurement, optimization and continuous-regression workflow for Kong Royale.
It complements [ARCHITECTURE.md](ARCHITECTURE.md), not the implementation rules in [AGENTS.md](AGENTS.md) and
[CONTRIBUTING.md](CONTRIBUTING.md). Dispatch instructions are in [PERFORMANCE_HANDOFF.md](PERFORMANCE_HANDOFF.md).

## Status and recommendation

Written 2026-11-03 from a read-only investigation of client CPU, rendering, simulation, networking and diagnostics.
**No benchmarks were run for this plan. The five optimization candidates are hypotheses, not measured bottlenecks
or promised improvements.** File references describe the investigated revision; verify them before implementation.

Build a small performance lab around the existing tools, then assign narrowly scoped experiments. Do not start with
a renderer rewrite, a general-purpose framework, or broad cleanup. Shared measurement and lifecycle procedures
should make extensions safe without forcing unrelated systems into one abstraction.

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

FND is the first implementation milestone. Optimization owners may investigate in parallel, but must not claim a
win until their scenario produces repeatable baseline/candidate comparisons.

### Existing foundations

| Capability | Existing entry points |
|---|---|
| Statistics, environment and JSON output | `tools/performance/common.mts` |
| Simulation/serialization timings | `tools/performance/host.mts` |
| Private server/socket workload | `tools/performance/server-bench.mjs`, `tools/performance/sockets.mts` |
| Latency/jitter hit-registration checks | `tools/netlab.mts` |
| Wire, matrix, geometry and splat coverage checks | `npm run bench:verify` |
| Real-GPU view captures and synchronous render benchmark | `tools/shot.mjs`, `Engine.bench()` in `client/src/engine/engine.ts` |
| Tick/event-loop histograms, CPU and memory | `server/perf.ts`, enabled by `KR_PERF_METRICS=1` |
| Bounded error/frame evidence | `client/src/kongbot/capture.ts` |
| Player reports, context, durable server queue and triage | `client/src/kongbot/`, `server/kongbot.ts`, `tools/kongbot/cli.mts` |

### Fix benchmark blind spots

1. **Separate match warmup from benchmark warmup and add real-play scenarios.** `host.mts` has a 240-tick
   benchmark warmup, but `m.warmupS = 1e9` keeps that match in its warmup phase. The server wrapper sets
   `KR_WARMUP_S` to the run duration plus 90 seconds, so its timed socket workload also remains in match warmup.
   Add seeded ground combat, loot acquisition, storm/endgame and multiple-lobby scenarios; do not label synthetic
   islet combat or a warmup-only run as representative full-match coverage.
2. **Separate correctness instrumentation from timing.** Host packet hashing runs inside timed calls. Preserve a
   verified trace mode, but distinguish its overhead from representative timing. Align CPU/memory windows with
   the reported tick window and report what includes warmup.
3. **Record achieved load.** Socket input generation can skip generator ticks. Capture actual inputs per second,
   generator lateness and server/client counts; reject an under-driven run rather than celebrating low latency.
4. **Gate relevant network tails.** Existing socket gates do not cover every reported RTT/ack/snapshot-gap metric.
   Add scenario-specific checks after establishing noise and intended behavior.
5. **Keep platform prerequisites explicit.** The server wrapper sets `KR_EVENT_MODE=0` for private room creation.
   Its extensionless `node_modules/.bin/tsx` spawn targets Linux/macOS; Windows compatibility is not established.
6. **Do not confuse render throughput with live latency.** `Engine.bench()` forces completion with `readPixels`.
   Keep it for controlled rendering comparisons; add normal-rAF, moving-camera/in-match measurements.
7. **Unify GPU query ownership.** The engine's continuous timer and display calibration have separate query
   lifecycles, validity rules and aggregation. One bounded query owner should serve calibration, dynamic resolution,
   profiling and collection. Avoid overlapping elapsed-time queries; use exclusive pass-profiling leases.
   Retain raw valid samples, explicitly mark unsupported timing and discard disjoint results. The existing smoothed
   controller estimate is not a suitable raw regression distribution.

Evidence: `tools/performance/host.mts:17-38`, `tools/performance/server-bench.mjs:16`,
`tools/performance/sockets.mts:29-41`, `client/src/engine/engine.ts:723-810`,
`client/src/engine/display.ts:315-344`.

### Measure four different sources of lag

| Layer | Primary measurements | Interpretation |
|---|---|---|
| Client CPU | Update/render-submission spans, actor/HUD costs, frame intervals, hitch counts | JS timing is not GPU execution time. |
| GPU | Asynchronous query samples, pass samples, render resolution, draws/points | Reject invalid/disjoint samples; count all frame passes, not only the last render call. |
| Server | Tick execution, deadline lateness, accumulator debt, catch-up batches/cap hits, rolling event-loop delay/utilization | Fast individual ticks do not prove timely delivery under multiple lobbies or GC. |
| Network | RTT/jitter, snapshot age/gaps, input ack age, reconciliation frequency/magnitude, queue depth | Loopback and simulated pipes do not prove WAN or input-to-photon latency. |

Also record cold/warm boot milestones and memory/resource trends across repeated matches. No concrete memory leak
was established in the investigation.

At 60 FPS the frame interval is 16.67 ms; at 120 FPS it is 8.33 ms. These are interval budgets, not a license for every
subsystem to consume that whole time. Server tick execution needs headroom inside its 16.67 ms fixed step.
Choose supported-device targets after baselining. Browser long-animation-frame entries start above 50 ms and miss
many frame-budget failures, so use them for attribution, not as the only game performance metric.

### Minimal proposed additions

Extend the existing directory and helpers; these files are proposals, not existing commands:

```text
tools/performance/
  common.mts       # Extend existing statistics/environment/report helpers
  schema.ts        # Versioned results and scenario contracts
  run.mts          # Bounded orchestration around existing tools
  compare.mts      # Baseline/candidate analysis and exit status
  scenarios/       # Seeded host workloads and browser camera/input routes
  budgets.json     # Scenario/device-specific limits, calibrated from evidence
```

Browser runtime collection must remain browser-safe; do not import Node-dependent `common.mts` into the client.
Keep platform collectors separate while sharing portable types and metric semantics.

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

Maintain two modes:

- **Fixed quality:** disable dynamic resolution and pin settings to compare efficiency.
- **Player experience:** normal frame cap and adaptive resolution; track pacing and image-resolution stability.

Run one timed GPU job per physical GPU. Keep software-rendered functional checks separate from hardware performance
results. Do not add blocking GL reads to production hot paths to make profiling easier.

## 2. Five initial optimization tracks

The order is a dispatch recommendation based on code evidence and experiment scope, not a measured cost ranking.
Keep each experiment single-variable; no claimed percentage gains are available yet.

### PERF-01: Budget procedural character animation

**Hypothesis:** full animation work is paid for remote characters that are tiny or off-screen, even though drawing
already uses screen-size LOD. `updateActors` calls `apply`, which runs the full pose/IK/face pipeline.

Evidence: `client/src/game/render.ts:2065-2093`, `client/src/actors/kong.ts:1117-1155`,
`client/src/actors/kong-rig.ts:538-656`.

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

**Hypothesis:** per-frame HUD interaction work scans world collections unnecessarily. The prompt block queries
vehicles twice and checks loot, chests, glass and ziplines; the loot helper scans all items.

Evidence: `client/src/game/render.ts:2454-2461`, `shared/sim/pickup.ts:36-53`.

- First experiment: reuse same-frame results and cache prompt candidates until relevant player/aim/world changes,
  with a bounded refresh interval. Test cadence before building a new index.
- Invalidate on spawn/take/remove, relevant state changes and snapshot updates; handle practice and online paths.
  Recompute on an interaction action; a stale prompt must never authorize gameplay.
- Scenarios: empty jungle, dense/looted POI, aiming across adjacent items, range racks, moving vehicles and ziplines.
- Metrics: prompt CPU, inspected candidates/raycasts, refresh count and prompt response delay.
- Gates: unchanged pickup choice/reachability; no stale prompt or perceptible interaction delay. A provisional
  100 ms maximum refresh bound is a hypothesis to test, not a guaranteed acceptable feel.
- Preserve existing HUD dirty checks and server-side validation.
- Owner: gameplay/UI engineer; coordinate `game/render.ts` with PERF-01.

### PERF-03: Deterministic loot candidate indexing

**Hypothesis:** automatic pickup and bot acquisition repeatedly scan loot collections; cost grows with players
multiplied by world loot.

Evidence: `shared/sim/match.ts:1208-1211`, `shared/sim/bots.ts:701-732`.

- First experiment: a match-owned, allocation-free spatial candidate index for bounded pickup queries.
  Expand to bot acquisition only after proving weighted search coverage and tie ordering remain equivalent.
- Preserve original candidate order, floor/reachability checks, freshly spawned drops and taken-item visibility.
  A local-radius lookup must not silently replace a bot's global search.
- Scenarios: hot-drop loot, many dropped items, sparse late game and multiple fixed seeds.
- Metrics: inspected candidates, query/bot CPU, simulation p95/p99 and bot arming/acquisition times.
- Gates: deterministic state/event trace comparisons, pickup tests, path/movement checks and full seeded matches.
  Share candidate lookup where appropriate, not every caller's decision policy.
- Preserve existing think staggering and pickup cadence. Do not start by indexing the 50 players; maintenance may
  exceed savings and a once-per-tick index could change sequential observation semantics.
- Owner: simulation engineer.

Follow-up after profiling: ray-local collider deduplication in `shared/sim/world.ts:813-870`. Boxes occupy multiple
grid cells, so a ray may retest them. Preserve equal-distance selection, normals, terrain precedence, glass and nested
query safety. Existing grids/DDA already provide a broadphase; do not replace them without comparative evidence.

### PERF-04: Separate tree and understory splat budgets

**Hypothesis:** the same quality multiplier for trees and understory spends unnecessary far-vegetation work.

Evidence: `client/src/world/veg/index.ts:283-288`, `client/src/world/veg/splat.ts:36-44`.

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

**Hypothesis:** high-quality screen-space reflection refinement is expensive over large water-covered screen areas.
The shader uses up to 20 march steps plus five binary refinements.

Evidence: `client/src/world/water/shader.ts:1070-1114`.

- First experiment: binary refinements five to three only. Keep march count, reflection reach/strength, scene
  copies and depth/contact behavior fixed.
- Scenarios: `water-harbor-bow`, `water-wreck-wade`, beach, open ocean and an open-ground negative control.
- Metrics: water-pass and whole-frame GPU tails, frame pacing and water coverage.
- Gates: stable thin-object, hull and pier reflections, screen edges, contact foam and underwater crossings.
- Preserve existing visibility sleeping, combined color/depth grab, occlusion, cadence and blending fallbacks.
  Do not clip framebuffer copies to the water horizon without proving all SSR reads remain initialized.
- Owner: water engineer.

Separate later experiment: GI samples eight to six, without changing AO resolution or temporal blending.
`client/src/world/atmos/post.ts:454-534` already uses blur/history and staggered work; compare compute frames
separately from reused frames. Prior quarter-resolution AO artifacts are documented there; do not repeat that shortcut.

## 3. Extension and DRY procedures

Every new subsystem or substantial extension should describe:

1. Which module owns it and where per-frame work registers.
2. What makes its state dirty, when it sleeps and its update cadence.
3. Which resources it owns and whether teardown disposes or deliberately pools them.
4. Which counters/spans identify its cost without per-frame allocation.
5. Which scenario, correctness test and visual/motion gate exercise it.

Build on `WorldModule` in `client/src/world/module.ts`. Preserve idempotent `afterBuild`, sliced builds,
readiness holds and shared authoritative collision layouts. Add contract fields only for demonstrated reuse.

Small DRY work worth considering, in separate scoped changes:

- One GPU query lifecycle and portable metric semantics.
- Existing benchmark statistics/environment helpers rather than new per-runner implementations.
- Shared DOM `el`/dirty-text/class/clock helpers, preserving differing behavior instead of mechanically replacing it.
- Consistent decoder configuration: `engine/assets.ts:30` uses a CDN Basis path, while
  `world/pois/lobby-islet/atlas.ts:654` uses checked-in `public/assets/actors/basis/` files.
  Verify compatibility before reuse. The title atlas already uses local files; do not claim a proven title-CDN stall.

Do not attach an unrelated cleanup to an optimization PR. Fewer lines or abstractions alone are not performance wins.

## 4. In-game diagnostics and crash evidence (OBS)

Extend KONGBOT's bounded capture and triage rather than replacing it. Current submission is player-initiated;
capturing errors in a local buffer is not automatic crash delivery.

Add a cheap, bounded flight recorder for build/asset identity, CPU/GPU/frame summaries, render-scale changes,
shader/upload hitches, network/reconciliation summaries, match phase and subsystem ids. Add context-loss/restoration
events and test the instrumentation with a local simulated WebGL loss.

Separate cheap incident data from expensive on-demand context:

- Do not run visual raycasts, screenshots, large serialization or synchronous GL diagnostics in a hitch callback.
- Sample, deduplicate and rate-limit automatic reports; cap storage, payloads and retry/backoff.
- Treat current URLs/query strings, callsigns, screenshots, console content and movement trails as potentially
  sensitive. Establish consent, redaction, access and retention before automatic upload; do not reuse the full manual
  report payload by default. Do not transmit to an external service without user authorization.
- Distinguish handled errors, context loss, disconnects, stalls and confirmed process exits. A killed renderer/GPU
  process may never execute a reporting callback. Combine breadcrumbs with private runner watchdogs and server
  evidence; no client-only system guarantees complete crash capture.
- Manual report snapshots are not deterministic replays. A seed plus movement trail does not capture all inputs,
  network timing and world events; add an explicit replay design if exact reproduction becomes necessary.

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

Current `.github/workflows/ci.yml` runs build/tests and secret checks, not a hardware performance gate.
A staged rollout is: local FND artifacts -> private repeatable runs -> reviewed regression lane -> scheduled
soak/incident intake. This plan installs none of those services or schedules.

## 6. Commands and validation

Existing examples, run from the repository root after installing dependencies. Use only servers you run.
These commands were inspected, not executed for this plan:

```sh
npm run build
npm test
npm run bench:host -- --root . --ticks 1800 --out reports/performance/host-base.json
npm run netlab -- 20,80,160,250,320 --jitter 20 --secs 20 --weapon ar
npm run sim -- trios 42
node tools/shot.mjs biome-01-beach --bench --q high --out shots/performance/base
```

The current host/socket workloads have the limitations described above; their results are not real-play coverage.
`bench:splat-viewport` is a CPU-side coverage regression check, not a GPU speed benchmark.
`shot --bench` is a synchronous view benchmark, not a live CPU/input-latency test.

For the current private server wrapper on Linux/macOS, build first, then:

```sh
KR_EVENT_MODE=0 npm run bench:server -- --seconds 60 --out reports/performance/sockets-base.json
```

PowerShell environment assignment uses `$env:KR_EVENT_MODE = "0"`, but this does not by itself make the current
wrapper's process spawning Windows-compatible. Do not work around a failed launch by pointing tests at a public host.

For implementation PRs, run `npm run build` then `npm test`, plus the narrow scenario/correctness gates.
Visible changes also need a real-GPU local play check and screenshot or clip. Record unavailable checks as blocked,
not passed. Do not install dependencies or change CI just to conceal an environment limitation.

## 7. Dispatch order and completion evidence

1. FND: shared measurement contracts, representative scenarios and reliable comparisons.
2. PERF-01/PERF-02: independent investigation, coordinated shared renderer edits.
3. PERF-03: deterministic query indexing after trace fixtures are available.
4. PERF-04/PERF-05: independent GPU experiments using the shared measurement owner.
5. OBS/OPS: reviewed telemetry and scheduled private regression lanes, building on FND.

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
