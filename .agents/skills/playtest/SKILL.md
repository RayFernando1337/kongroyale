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

## Where bundles land

The game server writes bundles to disk only when `KR_PLAYTEST_BUNDLES` is set. Production never sets it.

| `KR_PLAYTEST_BUNDLES` | Folder |
|---|---|
| unset, empty or `0` | none (reports go to MongoDB or the server queue as before) |
| `1` | `playtest-bundles/` in the server's checkout (git-ignored) |
| a path | that folder |

`tools/serve-channel.mts` sets it to `playtest-bundles/` in the checkout you run it from, so stable and next served
side by side both write there. For the dev pair: `KR_PLAYTEST_BUNDLES=1 KR_EVENT_MODE=0 npm run server` and
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

## Rules

- A bundle from SwiftShader (`ctx.gpu.renderer` mentions SwiftShader) says nothing about frame rate. Use it for
  errors and logic only.
- Compare like with like. Check `bundle.build`, the flags, `ctx.video` and the GPU before you call one bundle
  faster than another, and follow the `perf` skill before you report a speedup.
- Bundles contain the player's callsign and a screenshot. Keep them out of commits and public text.
