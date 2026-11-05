# POI streaming and eviction in low-memory mode

In low-memory mode (on by default in Safari and on devices that report under 8 GB, `client/src/low-mem-device.ts`) the
client does not build every location at boot. During a match it builds the nearest queued location, and before each
build it evicts the farthest live one while the list would go over `lowmemcap` (3) or the `lowmembudget` estimate
(1500 MB). This is what keeps a 16 GB Mac's Safari tab alive. Desktop Chrome builds every location once and keeps it,
so none of this runs there.

The TLA+ model `tools/formal/PoiResidency.tla` checks every order of camera moves, builds, fade-ins, evictions and match
starts and ends for four locations with a cap of 2. The `verify-poi-residency` skill
(`.agents/skills/verify-poi-residency/`) says how to run it.

## One location's life

Drawn from the model's actions: `nextNearModule` picks it, `trimStreamed` makes room, `buildStreamed` builds it,
`integrateFresh` fades it in, and an eviction (by the loop's own trim or the 2 s timer) sends it back to the queue.

```mermaid
stateDiagram-v2
  direction LR
  queued: Queued (not in memory)
  trimming: Making room
  building: Building
  integrating: Fading in
  live: Live
  [*] --> queued
  queued --> trimming: in a match, it is the nearest queued location
  trimming --> building: the list is under the cap, or nothing more can be evicted
  building --> integrating: build() returns
  integrating --> live: the fade-in finishes
  live --> queued: evicted (farthest first, never the one you are in)
```

## The path to more than lowmemcap locations in memory

TLC reaches 19,680 states, too many to draw, so the chart below draws only the shortest path that breaks the strict
rule, made by the pstack `/statechart` skill.

```mermaid
---
title: "A streamed location in low-memory mode (lowmemcap = 2 in this model, 3 in the game)"
---
stateDiagram-v2
  direction LR
  state "Legend" as legend {
    lg0: Breaks AtMostCap
    lg1: Path to the AtMostCap bug
  }
  class lg0 breaks
  class lg1 bugPath
  state "At the same time" as all {
    state "Location 1" as r0 {
      s0: Not loaded (queued), you are in it
      s1: Making room, you are in it
      s2: Making room
      s3: Building
      s4: Fading in
      s5: Loaded
      s6: Loaded, you are in it
      [*] --> s0
      s0 --> s1: a location comes near
      s1 --> s2: you move
      s2 --> s3: the build starts
      s3 --> s4: the build finishes
      s4 --> s5: the fade-in finishes [when 2 locations]
      s5 --> s6: you move
    }
    --
    state "In memory" as r1 {
      s7: 0 locations
      s8: 1 locations
      s9: 2 locations
      s10: 3 locations
      [*] --> s7
      s7 --> s8: the build starts [when Making room]
      s8 --> s9: the build starts [when Fading in]
      s9 --> s10: the build starts [when Loaded, you are in it]
    }
  }
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  class s0 bugPath
  class s1 bugPath
  class s2 bugPath
  class s3 bugPath
  class s4 bugPath
  class s5 bugPath
  class s6 bugPath
  class s7 bugPath
  class s8 bugPath
  class s9 bugPath
  class s10 breaks
  class s10 bugPath
```

`trimStreamed` counts a location that is building or fading in, but only evicts live ones. A build that starts while
the previous one is still fading in therefore goes ahead with the list already full: for a short while the cap plus
one location holds memory. The back-pressure in `stream()` (the loop waits while two integrations are in flight) keeps
it at one over, never more.

## The rules

| Rule | In plain words | Holds today? |
|---|---|---|
| AtMostCapPlusOne | At most `lowmemcap` + 1 streamed locations hold memory, counting the one being built. | Yes |
| NoEvictWhileBuilding | A location is never thrown away while it is still building or fading in. | Yes |
| NothingBuiltOutsideMatch | Nothing new is built outside a match (title, room, results lobby). | Yes |
| AtMostCap | At most `lowmemcap` streamed locations hold memory, counting the one being built. | No: one over, briefly |

`tools/formal/PoiResidency.cfg` checks the three that hold; `PoiResidency.findings.cfg` adds AtMostCap.

One thing the model shows that is not a broken rule: nothing listens for the end of a match. After you leave, the
locations stay in memory and builds in flight finish; the 2 s timer only trims down to the cap.

## What Ray should check

- Is "at most one location over the cap, for the length of a fade-in" acceptable on a 16 GB Mac in Safari, or should
  the cap count the fading-in location as evictable or make the next build wait?
- Should leaving a match evict the streamed locations, so the title and the room hold less memory?
- Does the order of builds you see in Safari (nearest first, the one you are in never evicted) match this chart?
