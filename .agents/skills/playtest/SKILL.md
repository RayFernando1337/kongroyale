---
name: playtest
description: "Read Kong Royale playtest bundles: what Ray (or a script) saved when he pressed the KONGBOT report or F8 during a ?perfhud session. Each bundle holds a per-second metrics timeline (fps, frame p95, GPU ms, ping, jitter, heap, textures, geometries, programs), the KONGBOT context and logs, the movement trail, the input replay of an offline bot match, the active flags, the build identity and a screenshot. Use when asked about lag, stalls, hitches, memory growth or a bug Ray marked while playing, or before and after a perf change to compare sessions."
---

# Read playtest bundles

Playtest mode is the `?perfhud` flag. It shows a small perf HUD in the top-left corner and records one row of metrics per
second for the whole session (up to 2 hours). To make it stick on a machine, set it once in the browser console:
`localStorage.setItem("kr.flags", "perfhud")`.

While it's on, every KONGBOT report (`/`, then `/kongbot <what went wrong>`) carries a bundle. **F8** sends a bundle at
once, with an automatic message ("F8 mark in match at 3:12"). F8 is the way to mark a lag spike without typing. Marks
are at least 5 s apart and share KONGBOT's per-address rate limit (20 reports per 10 minutes).

**Player diagnostics** (`?diag`, or a build made with `VITE_KR_DIAG=1`; `?diag=0` turns it off) records the same
timeline and replay without the HUD, for players on a stream (RAY-162). It also keeps `__kr.diag.snapshot()`:
`events` (long animation frames with the script that ran longest, phase changes, world modules streamed in or
evicted, shader-program jumps, 3D-resolution steps, heap drops over 50 MB, context loss, visibility, fullscreen, errors; times in page seconds,
the timeline's `t`), `path` (position and view once a second in a match) and `prev`, the last heartbeat of a session
that died without closing (a killed tab; Web Locks tell a dead session from a live tab, see docs/statecharts/diagnostics.md from #204). GPU timer queries run as they do under `?perfhud`. The
player's send sheet (a later PR) sends the snapshot as `ctx.diag`; the typed `/kongbot` bar and F8 don't.

## Where bundles land

The game server writes bundles to disk when `KR_PLAYTEST_BUNDLES` says so. `npm run server` (detected by npm's script name, so it works on every OS) and `tools/serve-channel.mts`
(stable and next) default it to `1`, so our own runs save bundles with nothing set. `npm start` and any other deploy leave
it unset: they still accept the report but save no bundle until the operator sets it. `KR_PLAYTEST_BUNDLES=0` switches it off everywhere.

| `KR_PLAYTEST_BUNDLES` | Folder |
|---|---|
| unset (`npm start`, other deploys), empty or `0` | none (reports go to MongoDB or the server queue as before) |
| `1` | `playtest-bundles/` in the server's checkout (git-ignored) |
| a path | that folder |

`tools/serve-channel.mts` writes to `playtest-bundles/` in the checkout you run it from, so stable and next served
side by side both write there. For the dev pair: `KR_EVENT_MODE=0 npm run server` and
`npm run dev`, then open <http://localhost:5317/?perfhud>.

Each bundle is a folder `<UTC time>-<report id>/` with `bundle.json` and `shot.jpg`. The server stops writing at
500 bundles or 1 GB, counted on disk before every write (so two servers sharing a folder share the cap), logs that once, and resumes as soon as the folder is cleared. MongoDB keeps the timeline but never
the replay log.

## Read them

```sh
npx tsx tools/playtest/cli.mts list                 # newest first: build, seconds, median fps, stall and lag seconds, message
npx tsx tools/playtest/cli.mts show latest          # a summary to read first
npx tsx tools/playtest/cli.mts show <folder> --json # the same summary as JSON, for comparing two bundles
```
`--dir` reads another folder. Without it, the CLI reads `KR_PLAYTEST_BUNDLES` when that's a path, else `playtest-bundles/`.

What the summary means:

- **Stalls**: seconds that held a frame over 50 ms, with the worst ones listed by time and match phase. The
  phase is title, warmup, plane, play or results.
- **Lag spikes**: seconds where ping exceeded twice the session median plus 40 ms, or jitter exceeded 15 ms.
  Ping is -1 outside a match.
- **Memory**: the JS heap at the start and end, its maximum, and a linear trend in MB/min. The renderer's
  texture, geometry and program counts are shown first to last. A heap or texture count that keeps climbing
  across matches is a leak lead, not a proof.
- **Replay**: present while an offline bot match runs. `bundle.replay` is a `ReplayLog` (`shared/net/replay.ts`), so
  `replayMatch(log, world)` plays the match again bit for bit, and you can step to the tick of a stall. JSON has no
  `Infinity`, so non-finite numbers are saved as the strings `"Infinity"` and `"-Infinity"` (practice matches set
  `opts.botAimRange` to `Infinity`). Turn them back into numbers before `replayMatch`, or the bots aim differently.

The raw timeline is `bundle.timeline` (`fields` plus one row per second). `ctx`, `logs` and `trail` are the
usual KONGBOT report (`client/src/kongbot/context.ts`).

## Triage

Once there are more bundles than you can read one by one, rank them. Triage is deterministic: no model call, no network.

```sh
npx tsx tools/playtest/triage.mts [--dir DIR] [--out DIR]    # writes index.jsonl, clusters.json, clusters.md (into DIR unless --out)
npx tsx tools/playtest/cli.mts watch [--dir DIR] [--ticker FILE]   # a line per new bundle, and the OBS ticker
```

- `index.jsonl`: one line per bundle with its build, kind (crash, F8 mark or report), symptoms (crash, stall, low-fps,
  hitchy, lag, memory, slow-load, error, other), config (browser, OS, GPU vendor and tier, preset, dpr and memory
  buckets, non-default flags), where it happened (phase, POI, 100 m grid cell), the worst stall and the diag event
  that overlaps it (a long frame's script, new shader programs, a stream module build or failure such as `Module build BANANA TEMPLE`, a heap drop or a context loss), a fingerprint and a severity. The install is a hash, never the raw id. The thresholds are named
  constants at the top of `triage.mts`.
- `clusters.json`: bundles grouped by fingerprint, ranked by distinct players x worst severity x recency (full weight
  for the last 24 h of the newest report, halved for every extra day), with up to three representative report ids.
  It also holds the players' own notes, for the step that files issues.
- `clusters.md`: the same ranking for reading and sharing. It has structured fields only: no callsigns, notes or
  screenshots. Rerunning on the same bundles writes the same files.
- `watch` polls the folder every 2 s, prints time, symptom, config, POI and report id for each new bundle (never the
  message or callsign) and keeps a one-line ticker file (`ticker.txt` in the folder by default), for example
  `37 reports this hour · top: Stall at banana-temple, Safari (6) · latest: Low FPS, Chrome, Windows`. In OBS add a
  Text (read from file) source on that file.
- Frame-rate symptoms (stall, low-fps, hitching) are skipped for SwiftShader bundles, as the rules below say. Only POI
  ids from `shared/world/map.ts` reach the output, and attribution text is cut down to plain characters.
- A crash is placed by the dead session's heartbeat (phase, and the POI and grid cell of its x and z, with the usual 150 m limit), never by the new session.
  A `module-failed` event that a later `module-built` of the same module cancelled is not an error, but still explains a stall it overlapped.
- A bundle.json that is cut off or not a bundle is skipped with a warning; `watch` retries it on the next poll, so a
  bundle caught mid-write still shows up.

`npm test -- --only triage` checks all of this against the hand-written bundles in `tools/playtest/fixtures/`.

## Rules

- A bundle from SwiftShader (`ctx.gpu.renderer` mentions SwiftShader) says nothing about frame rate. Use it for
  errors and logic only.
- Compare like with like. Check `bundle.build`, the flags, `ctx.video` and the GPU before you call one bundle
  faster than another, and follow the `perf` skill before you report a speedup.
- Bundles contain the player's callsign and a screenshot. Keep them out of commits and public text. `clusters.md` and
  the `watch` output are safe to show on stream; `clusters.json` notes and `cli.mts show` are not.
