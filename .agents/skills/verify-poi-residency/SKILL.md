---
name: verify-poi-residency
description: Model-check Kong Royale's low-memory POI streaming with TLA+ - which streamed locations hold memory, when one is evicted, and the cap - and draw it as a statechart (docs/statecharts/poi-residency.md). Use before calling done any change to client/src/low-mem.ts nearModule/nextNearModule/evictStreamed/over/evictionsFor/trimStreamed/residents, client/src/main.ts buildOne/buildStreamed/stream or its 2 s trim timer, or the lowmem flags (lowmemcap, lowmembudget, lowmemr, lowmemhyst).
---

# Verify POI residency

In low-memory mode the client streams locations: during a match it builds the nearest queued one and, first, evicts the
farthest live one while the list would go over the cap. Builds and fade-ins run in the background, the camera keeps
moving, a 2 s timer trims too, and a match can start or end at any point. This model checks every order of those events
for four locations and a cap of 2.

## The rules (tools/formal/PoiResidency.tla)

| Rule | In plain words | If it breaks |
|---|---|---|
| AtMostCapPlusOne | At most the cap + 1 streamed locations hold memory, counting the one being built. | Memory grows without bound as you move; Safari kills the tab. |
| NoEvictWhileBuilding | A location is never evicted while it is building or fading in. | A half-built location's resources are freed under it; errors or a leak. |
| NothingBuiltOutsideMatch | Nothing new is built at the title, in the room or on the results lobby. | Memory spent where no one plays. |
| AtMostCap | At most the cap, counting the one being built. | Today: one over, for the length of a fade-in. |

`PoiResidency.cfg` checks the first three, which hold. `PoiResidency.findings.cfg` adds AtMostCap, which breaks in 12
steps (docs/statecharts/poi-residency.md). If the code changes so that AtMostCap holds, move it into `PoiResidency.cfg`
and add a mutant that takes the change out.

## Run it

```sh
node tools/formal/tlc.mjs PoiResidency --mutants
```

Java 11 or newer on PATH; the first run downloads the pinned TLA+ tools jar. About 2 seconds, 19,680 distinct states.
Expected output: one `PASS PoiResidency` line and one `PASS ... mutant` line per entry in `PoiResidency.mutants.json`.
A mutant that passes means the model can no longer see the guard it removes: fix the model, not the mutant.

To see the AtMostCap path or redraw the chart, give the pstack `/statechart` skill the model and
`PoiResidency.findings.cfg`.

## When a rule breaks

- **A real bug.** Replay the path in the real client: `npm run build`, serve it, open a practice match with
  `?lowmem=1&lowmemcap=2` (and `?seed=N` to replay one plane path), and move the camera between locations in the
  path's order (the memory tool's `--tour` teleport in `tools/performance/memory.mts` does this from a script). Log
  `residents()` and the build queue, and compare with the path. On a no-GPU machine this runs on SwiftShader, slowly.
- **A modelling error.** A step the code cannot take. Fix the model to say what the code does, citing the line.

## Keep the model in step with the code

| Code | Model action |
|---|---|
| low-mem.ts `nearModule`, `nextNearModule` (in a match only; the admission test) | Pick |
| low-mem.ts `trimStreamed`, `evictionsFor`, `over`, `evictStreamed` | TrimEvict, TrimDone |
| main.ts `buildStreamed`, `buildOne`, the back-pressure in `stream` | Built, Integrated |
| main.ts `stream`'s 2 s timer (`trim(null)`) | Timer |
| the camera; `enterMatch` / leaving | Move, EnterMatch, LeaveMatch |

The caps' values live in client/src/flags.ts, which no region can name; the model takes the cap as a constant and
counts locations rather than megabytes, so the budget estimate (400 MB a location until measured) is not checked.

Coverage record: `tools/formal/PoiResidency.covers.json` names the functions above and the writes that change which
locations are queued, building, built or live (`building`, `streamMs`, `pending`, `modOf`), and records a token hash
of each region as of the last passing run. npm test's `formal` check fails when one changed or when other code writes
that state. The one listed exception is `__kr.rebuildModule`, a developer hook typed into the console. Read the change
against the table, fix the model or the regions (or the `allow` list: a function, each write it may make there, listed
once per occurrence, and why), then:

```sh
node tools/formal/tlc.mjs PoiResidency --mutants --record
```

## What it does not cover

Distances are four classes (inside, near, far) and the camera jumps between them at any time. Memory is a count of
locations, not bytes, so the `lowmembudget` path and how much memory an eviction actually frees are out of scope; the
`verify-memory` skill measures that. Desktop mode (no eviction) is not modelled.
