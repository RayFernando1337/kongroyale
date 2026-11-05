---
name: profile-kongroyale-load
description: "Profile Kong Royale's page load, from a cold or warm start to the playable title (window.__kr.ready) and on to a started practice match, in Google Chrome (CDP trace + CPU profile, hardware Metal/D3D11), real Safari (safaridriver/WebDriver timing, Web Inspector Timelines and Instruments for the deep dive) and Playwright WebKit (a stand-in, not Safari). Writes a per-phase result.json per run for interleaved A/B with compare.mts. Use when asked why the game loads slowly, to compare browsers, to measure a load-time change, or to rank load-time work by seconds saved."
---

# Profile Kong Royale's load

A player's load has two halves: navigation to the playable title (`window.__kr.ready`, the loading screen fades), then
**Play** to a running match (`window.__kr.game.inMatch`). This skill times both halves the same way in every browser,
breaks them into phases, and writes one `kong-perf-result` file per run ([tools/performance/schema.ts](../../../tools/performance/schema.ts)),
so a change is judged with [compare.mts](../../../tools/performance/compare.mts) like every other benchmark here.

Everything runs through one helper, from the repository root (Node 22.12+; on Ray's Mac put
`/opt/homebrew/opt/node@22/bin` first in `PATH`):

```sh
node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs up --prod --port 3140    # a production build on :3140 (npm run build first)
npx tsx tools/performance/load-profile.mts run --url http://127.0.0.1:3140 --browsers chrome,safari --runs 3 --no-trace
npx tsx tools/performance/load-profile.mts table shots/load-profile/<stamp>/*/result.json
node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs down
```

Measure the **production build** (`up --prod` or `npm start`): that is what players load. The Vite dev client serves
hundreds of unbundled modules and is slower in every browser, so only use it for function-level attribution (below).

Validated on Fuego Max (M3 Max, macOS 27.0.1) against the production build: Chrome 156 headless with ANGLE Metal
(5 runs) and Safari 27.0.1 through safaridriver. A cold Chrome load reaches the title in about 22.6 s (range
22.5-23.2 s, one 39 s outlier) and a warm one in about 21.1 s. Safari took 24.9 s cold and 23.5 s warm in the one
valid run so far. One run (cold and warm, each with a 15 s match) takes about 80 s in Chrome without the trace, 140 s with it, and
90 s in Safari.

## How it measures

Each run is one fresh browser profile:

1. **Cold**: a new profile with an empty HTTP cache, IndexedDB (the far-tree splat bake cache, `kr-veg-splats`) and
   shader cache. This is a first visit. It is the "cache off" case: nothing is cached, but repeat requests inside the
   load behave as they do for a player (DevTools' "Disable cache" would also re-fetch those).
2. The practice match: click **Play** (`button.tn-play-cta`), wait for `inMatch`, record `--match-secs` (default 15) of frames.
3. **Warm**: the same profile navigates to the game again (from `about:blank`, a normal navigation, not a reload):
   HTTP disk cache, IndexedDB and the browser's shader cache are warm. This is a returning player. Then its match.

Every load goes through a **probe proxy** the helper starts on a random local port. It forwards to the server you
started and logs every request (bytes on the wire, time to first and last byte). It also injects one script into
`index.html`, right after the loading screen's own script, so **the same probe runs in every browser**:

- it timestamps every write of `__kr.stage`, `__kr.gameStage` and `__kr.streamStage` (main.ts and game/index.ts set
  them right before each boot step), which gives the phase timeline;
- a 10 ms timer: a gap of 50 ms or more is a main-thread block (a long task or a long frame). This is the long-task
  measure that also works in Safari, which has no `longtask` or `long-animation-frame` entries;
- every animation frame's timestamp (frame times in the match);
- it wraps the WebGL calls that can block the main thread (shader compile, link and status queries, uniform lookups,
  texture and buffer uploads, readbacks) and sums their time per window (boot, title, match).

It also reads the game's own instrumentation at ready (`__kr.buildMs`, `terrainMs`, `prewarmMs`, `warmAllMs`,
`settleHolds`, `preReady` and more), Resource Timing, and the renderer string and extensions of the game's context.

The probe costs a little: the WebGL wrappers add a `performance.now()` pair to each wrapped call. To check that a
finding is not the probe, rerun with `--no-gl` (no wrappers) and compare `readyMs`.

## Browsers

| `--browsers` | What runs | Extra evidence | Use it for |
|---|---|---|---|
| `chrome` | Google Chrome (`channel: chrome`), headless, `--use-angle=metal` on a Mac (`d3d11` on Windows), as in verify-kongroyale | A CDP trace (`trace-<start>.json.gz`) and the page's CPU profile (`cpu-<start>.cpuprofile`), unless `--no-trace` | Attribution: what the main thread and the GPU process did |
| `edge` | Microsoft Edge (`channel: msedge`), the same Chromium flags and ANGLE backend as `chrome` | Same as Chrome | The numbers Windows players get in the default browser |
| `safari` | Real Safari through `safaridriver` (W3C WebDriver), a visible automation window | Screenshots; `--inspect` asks safaridriver to start a Web Inspector Timelines recording with the session (`safari:automaticProfiling`; not yet exercised on Fuego Max) | The numbers Safari players get |
| `webkit` | Playwright's WebKit build | Same as Safari | A scriptable stand-in on machines without Safari. **It is not Safari**: a different WebKit build, without Safari's own GPU process settings, Metal shader cache and networking. Never quote it as Safari |

Chrome's trace adds overhead (the CPU sampler in particular: `CpuProfiler::StartProfiling` alone takes 0.3 s), so
**time with `--no-trace` and attribute with a separate traced run**. Never mix traced and untraced runs in one
comparison; `config.trace` makes compare.mts refuse.

### Safari setup (once per Mac)

1. Run `sudo safaridriver --enable` (it lives at `/System/Cryptexes/App/usr/bin/safaridriver` on recent macOS). This
   turns on Safari's developer features and "Allow remote automation" in Settings → Developer.
2. Quit Safari with Cmd-Q. A Safari that was already running does not accept automation until it restarts; the
   symptom is `session not created: The session timed out while connecting to a Safari instance`.
3. Each run opens a separate Safari window with an orange "automation" address bar. Don't touch it and keep it
   visible.
4. **Keep the Mac unlocked.** With the screen locked, Safari renders no frames and throttles timers while the page
   still reports itself `visible`. The game's boot waits on animation frames, so the load stalls: on Fuego Max every
   locked-screen load sat in `build:atmos` with 20-40 s main-thread gaps until the 240 s timeout. The helper refuses
   to start Safari on a locked screen, holds the display awake with `caffeinate -d -i` during Safari runs, and fails
   the `notThrottled` gate when a run saw a gap of 15 s or more.

A WebDriver session is an isolated, ephemeral browsing session, so every run starts cold; the warm load is a second
navigation in the same session. macOS's own Metal shader cache is system-wide and is not cleared, so Safari's "cold"
is cold for HTTP, IndexedDB and WebKit, not for compiled Metal code. Chrome's cold profile has its own empty ANGLE
program cache.

### What Safari doesn't have, and what to record instead

| Missing in Safari | Use instead |
|---|---|
| A scriptable performance trace (CDP `Tracing`) | The probe's phase timeline and main-thread blocks (every browser), plus a Web Inspector Timelines recording (below) |
| `longtask` / `long-animation-frame` entries | The probe's timer gaps (`main.*` metrics, `blockedByPhase`) |
| `EXT_disjoint_timer_query_webgl2` (no GPU timer queries in WebGL; `detail.gl.timerQuery` records it per browser) | Frame times from the probe (`match.*`). For GPU-side time, use Instruments' Metal System Trace (`xcrun xctrace record --template 'Metal System Trace'`) on the Safari GPU process |
| A CPU profile you can script | Web Inspector's JavaScript & Events timeline, or Instruments' Time Profiler on the `com.apple.WebKit.WebContent` and `com.apple.WebKit.GPU` processes (`xcrun xctrace record --template 'Time Profiler' --all-processes --time-limit 60s`) |
| Fine timers: `performance.now()` is coarsened in Safari | Use sums over many calls (they are unbiased) and never single sub-millisecond readings |
| `KHR_parallel_shader_compile`, on some versions | Check `detail.gl.parallelCompile` in result.json. Without it, every program links synchronously inside the first compile or draw, and the time lands in `gl.shaderMs` and in the `prewarm` phase |

## The manual deep dive

**Chrome.** Open `trace-cold.json.gz` in DevTools → Performance → "Load profile" (or ui.perfetto.dev). The
`kr:probe`, `kr:kr`, `kr:ready`, `kr:click` and `kr:inMatch` marks in the Timings track line the trace up with the
phases. `cpu-cold.cpuprofile` opens in the same panel. In a production build, function names are minified and
chunks are named `index-<hash>.js`. For names, profile the dev client once:
`npx tsx tools/performance/load-profile.mts run --url http://127.0.0.1:5417 --browsers chrome --runs 1` against
`kr-verify up` (dev). Its timings are not the production numbers.

**Safari, Web Inspector.** Either run the helper with `--browsers safari --inspect --runs 1`, which passes Safari's
`safari:automaticProfiling` capability so a Timelines recording starts with the session (check that Web Inspector
opened on the automation window; this path is not yet validated here), or by hand:

1. Open the game URL (your local server) in Safari, then Develop → Show Web Inspector → Timelines.
2. In the Timelines settings, enable Network Requests, Layout & Rendering, JavaScript & Events, CPU, Memory,
   Rendering Frames and Screenshots.
3. Start recording, then reload the page (Cmd-R): the recording continues across the reload. Wait for the title,
   click Play, wait 15 s, stop.
4. Export (the download button) to a `.json` recording and attach it to the issue.
5. Read: CPU shows main thread vs workers vs other threads. JavaScript & Events lists script evaluation, timers,
   animation frames and garbage collection, so sort by total time. Rendering Frames shows the long frames. The
   Graphics tab lists the WebGL canvas and its shader programs.

**Safari, Instruments.** For native attribution (JavaScriptCore, image decoders, ANGLE/Metal shader compiles in the
GPU process), record a Time Profiler trace of all processes while the helper runs a single Safari load, then open
the `.trace` in Instruments and filter to `com.apple.WebKit.WebContent` and `com.apple.WebKit.GPU`.

## What each number means

All times are milliseconds from navigation start (`performance.timeOrigin`) unless the name says otherwise. Each
case (`load/cold`, `load/warm`) has these metrics:

| Metric | Meaning |
|---|---|
| `readyMs` | **The headline.** `__kr.readyAt`: navigation start to the playable title. The loading screen is up until then. |
| `phase.mainScriptMs` | Navigation start to main.ts's first statement (`window.__kr` assigned): the HTML, then downloading, parsing and **evaluating the main bundle and its static imports** (module top-level code). |
| `phase.engineInitMs` | The renderer and engine setup before the terrain loads. |
| `phase.terrainMs` | `loadTerrain()`: the island heightfield. |
| `phase.worldBuildMs` | The title modules other than POIs: atmos, terrain visuals, water, veg, showcases. Each build's interval includes its own yields and the parallel shader compile it kicks off. |
| `phase.poiBuildMs` | POI builds before ready: the lobby islet plus the pre-ready stream (`__kr.preReady`, the biggest POIs that fit `READY_BY`). |
| `phase.afterBuildMs` | Every module's `afterBuild`, static and far-merge registration. |
| `phase.gameKitsMs` | The game's kits (`gameStage` `world` … `kits:wire`): view model, FX, audio, storm, HUD, title. |
| `phase.prewarmMs` | The game's prewarm (`prewarm:*`): asset loads, the parallel compile and its wait, the prewarm frames, kongs, first use. |
| `phase.settleMs` | The offscreen warm draw of everything built (`warmAllMs`), the settle holds (`settleHolds`, `settleHoldsMs`), then six frames. |
| `net.requests`, `net.MB` | Requests and wire bytes the proxy forwarded before ready. A warm load that still moves many MB is not caching. |
| `net.<class>.MB`, `net.<class>.lastByteMs` | Per asset class (`js`, `wasm`, `model`, `texture`, `audio`, `font`, `data`, `html`, `other`): bytes and when the last one arrived. A late `lastByteMs` for a class that a phase waits on is a download bottleneck. On loopback it rarely is: use `--net 50,40` (50 Mbit/s, 40 ms per response) to approximate a home connection. |
| `net.fromBrowserCache` | Resource Timing entries the proxy never saw: answered from the browser's cache. |
| `main.longTasks`, `main.blockedMs`, `main.maxBlockMs` | Main-thread blocks of 50 ms or more before ready, from the probe's timer: count, total, longest. `detail.blockedByPhase` splits the total by phase; `detail.topBlocks` lists the 20 longest with the boot step that was running. |
| `gl.shaderMs` | Time inside WebGL shader calls before ready (compile, link, status queries, uniform/attribute lookups). With parallel compile the cost shows up in the status query that waits for it. |
| `gl.textureMs`, `gl.bufferMs`, `gl.readbackMs` | Time inside texture uploads (including any synchronous image decode the browser does there), buffer uploads, and readbacks (`readPixels`, `getBufferSubData`, `clientWaitSync`) before ready. `detail.glSlow` lists calls of 8 ms or more. |
| `gl.programs` | Shader programs at ready (`__kr.programsAtReady`). |
| `trace.*Ms` (Chrome) | The page's main-thread self time before ready, by kind: `scripting` (JS and the WebGL calls made from it), `parseCompile`, `gc`, `decode` (image decode), `styleLayoutPaint`, `gpuWait` (the page blocked on the GPU process), `other`. `trace.jsSelfMs` is JS self time from the CPU profile, `trace.gpuMainBusyMs` the GPU process main thread's busy time. `detail.trace` has the top events, the long tasks with their biggest children, the GPU-process threads, and the top JS functions and scripts. |
| `match.startMs` | The Play click (recorded in the page, before the game's own click handler, so driver latency is not in it) to `inMatch`. `match.prepareMs` is the "preparing the island" card's share of it (`__kr.prepareMs`, 0 when the card did not show). |
| `match.framesOver100`, `match.p99FrameMs`, `match.maxFrameMs`, `match.blockedMs`, `match.shaderMs` | The first `--match-secs` seconds after `inMatch`: frames over 100 ms, the 99th percentile and longest frame, main-thread blocks, and WebGL shader time. This is the DEF-16 window. |
| `streamedMs` | When the island finished streaming in (`__kr.streamedAt`); invalid if it did not finish inside the run. |

The gates: `ready` (the title became ready), `noErrors` (`__kr.errors` empty), `hardwareGpu` (not SwiftShader or
another software renderer), `matchStarted`, `visible` (the page was never hidden) and `notThrottled` (no main-thread
gap of 15 s or more: a throttled window or a hang). A run with a failed gate is not a measurement.

`table` prints the median and range of the headline metrics and of `blockedByPhase` for each label and browser.
`--metrics a,b` picks others. It leaves every case with a failed gate out of the medians and lists it, with the
failed gates, under the table.

`--starts` picks the loads per run: `cold,warm` (the default), `cold`, or `warm`. A warm-only run first does one
untimed load to the title so the fresh profile's caches are filled; a cold load can only come first.

## Comparing a change (A/B)

1. Build both sides and serve them from two checkouts on two ports, for example base on 3140 and candidate on 3141.
2. Run interleaved, at least five runs a side:
   `npx tsx tools/performance/load-profile.mts run --url base=http://127.0.0.1:3140 --url cand=http://127.0.0.1:3141 --browsers chrome --runs 5 --no-trace`.
   Each round runs every label and browser, and the order flips every round (ABBA), so drift doesn't favour a side.
   A URL flag can be one side: `--url novs=http://127.0.0.1:3140/?vegsplat=0`.
3. `npx tsx tools/performance/compare.mts --base shots/load-profile/<stamp>/base-chrome-*/result.json --cand shots/load-profile/<stamp>/cand-chrome-*/result.json --metrics readyMs,match.startMs`.
   Name the primary metric before you run. compare.mts needs five runs a side for a verdict and refuses runs whose
   config differs (browser and version, headless, viewport, DPR, trace, network shaping, probe).
4. Load times vary more than tick times: a cold load on this Mac moves by a few hundred ms between runs. Report the
   range with the median, and treat a change inside the baseline's range as no change.

Don't run timed passes alongside another GPU job on the same machine. On Fuego Max, crews share
`~/.capy/work/fuego-gpu.lock`: check it, write your own (`owner`, `what`, `since`, `until`) and remove it after.

## From a profile to a ranked list of wins

A finding is worth doing when it saves many seconds for many players with good confidence. Rank by expected seconds
saved per load:

**value = seconds saved per affected load × share of loads that hit it × confidence**

- **Seconds saved**: the measured cost you can remove, not the whole phase. A phase that blocks the main thread for
  3 s but overlaps a 3 s download saves nothing until the download is also faster. Check with the timeline: is the
  phase on the critical path to `readyMs` (the boot is sequential: main script, terrain, title modules, pre-ready
  POIs, afterBuild, game, settle), and is the main thread busy (`blockedByPhase`) or waiting (network `lastByteMs`,
  a settle hold)? After ready, cost moves to the title (stream stalls) or the match (`match.*`), which players feel
  differently: a long load is annoying, a stall in a gunfight loses the round.
- **Share of loads**: cold vs warm (a first visit happens once per player and per deploy; warm loads happen every
  session), which browsers (Safari is every iPhone/iPad player and many Mac players), and which machines (the cost
  scales with GPU and CPU: an M3 Max is a best case).
- **Confidence**: high when an A/B removed the cost (`compare.mts` says better); medium when the trace attributes the
  time directly to one function or call; low when it is inferred from a phase total or estimated for other hardware.

Write each finding as one row: cause, evidence (metric, trace excerpt, file:line), seconds saved (cold and warm, per
browser), who hits it, confidence, proposed fix, and its risk. Sort by value. Fix the top row, re-measure, and
re-rank: a big fix often moves the next bottleneck.

## Gotchas

- `?seed=42` is added to every load so the title and the practice match are the same in every run.
- The viewport is 1600x900 at device pixel ratio 2 (Retina) in Chrome and WebKit. Safari uses the real display's
  ratio, so check `detail.dpr`: a Safari window on a non-Retina monitor renders a quarter of the pixels.
- **Play** asks for fullscreen. A headed Safari window goes fullscreen, so its match renders the whole display
  (`detail.gl.buffer` at the end of the run, 3840x2160 on a 1920x1080-point display) while headless Chrome stays at
  1600x900. Compare match frame times across browsers with that in mind; title numbers are unaffected.
- Headless Chrome on a Mac uses the real GPU (`hardwareGpu` shows `ANGLE Metal Renderer`). `--headed` shows the
  window.
- The proxy only forwards to `127.0.0.1` / `localhost`. Never point this tool at kongroyale.com or any server you did
  not start (AGENTS.md rule 7).
- The helper kills only the browsers, safaridriver and proxy it started. `kr-verify down` stops the server.
- Output: `shots/load-profile/<stamp>/<label>-<browser>-r<n>/` holds `result.json`, title and match screenshots, and
  (Chrome, traced) the trace and CPU profile. `shots/` is git-ignored.
