--------------------------- MODULE PoiResidency ---------------------------
(* Low-memory POI streaming on the client (client/src/low-mem.ts, client/src/main.ts stream()): which streamed
   locations hold memory, and when one is evicted. On by default in Safari and on devices reporting under 8 GB
   (low-mem-device.ts); this is what keeps a 16 GB Mac's Safari tab alive. Desktop Chrome builds every POI once and
   keeps it (no eviction), so it is not modelled.

   Abstracted: distances are four classes per POI (the camera is inside it, near enough to build, nearer or farther),
   the camera moves arbitrarily between ticks, and memory cost is a count (lowmemcap) rather than MB (lowmembudget,
   whose estimate starts at 400 MB a POI). Evicted is "queued again" (low-mem.ts:257). *)
EXTENDS Naturals, FiniteSets

CONSTANTS Pois, Cap

VARIABLES
  st,       \* per POI: queued | trimming (picked, eviction pass running) | building | integrating | live
  dist,     \* per POI: "inside" (camera inside it: d <= 0) | "near" | "far"
  inMatch,  \* kr.game.inMatch (nextNearModule picks only in a match)
  loop,     \* the stream loop: "pick" (nextNearModule) | "trim" | "build" | "wait" (inflight back-pressure)
  thrown,   \* (for the rules) a POI was evicted while still building or fading in
  outside   \* (for the rules) a POI was picked to build outside a match
vars == <<st, dist, inMatch, loop, thrown, outside>>

Held == {p \in Pois : st[p] \in {"building", "integrating", "live"}}   \* hold GPU/CPU memory
\* what residents() counts (low-mem.ts:231-244): in modOf and live, or in building; a POI inside its own build()
\* is not in modOf yet (main.ts:237) but is in building (added low-mem.ts:260), so it counts
Counted == {p \in Pois : st[p] \in {"building", "integrating", "live"}}
\* evictionsFor (low-mem.ts:165-169): only live POIs (integrating ones are -Infinity) the camera is not inside
Evictable == {p \in Pois : st[p] = "live" /\ dist[p] # "inside"}
Integrating == {p \in Pois : st[p] = "integrating"}

Init ==
  /\ st = [p \in Pois |-> "queued"]
  /\ dist \in [Pois -> {"inside", "near", "far"}] /\ Cardinality({p \in Pois : dist[p] = "inside"}) <= 1
  /\ inMatch = FALSE
  /\ loop = "pick"
  /\ thrown = FALSE /\ outside = FALSE

(* the camera moves: any POI's distance class changes; the camera is inside at most one POI *)
Move ==
  /\ \E p \in Pois, d \in {"inside", "near", "far"} :
       /\ dist' = [dist EXCEPT ![p] = d]
       /\ Cardinality({q \in Pois : dist'[q] = "inside"}) <= 1
  /\ UNCHANGED <<st, inMatch, loop, thrown, outside>>

EnterMatch == ~inMatch /\ inMatch' = TRUE /\ UNCHANGED <<st, dist, loop, thrown, outside>>
\* exitToRoom / leaveAll: nothing in main.ts or low-mem.ts listens (residents stay, builds in flight go on)
LeaveMatch == inMatch /\ inMatch' = FALSE /\ UNCHANGED <<st, dist, loop, thrown, outside>>

(* nextNearModule: in a match, a queued POI near the camera; the admission test (low-mem.ts:63-65) skips one that,
   counted lowmemhyst farther, would itself be evicted: in this abstraction, one that is not nearer than an evictable
   resident while the list is full *)
Pick ==
  /\ loop = "pick" /\ inMatch
  /\ \E p \in Pois :
       /\ st[p] = "queued" /\ dist[p] \in {"inside", "near"}
       /\ ~(Cardinality(Counted) >= Cap /\ dist[p] = "near" /\ \A q \in Evictable : dist[q] = "near")
       /\ st' = [st EXCEPT ![p] = "trimming"]
  /\ loop' = "trim" /\ outside' = (outside \/ ~inMatch)
  /\ UNCHANGED <<dist, inMatch, thrown>>

Incoming == CHOOSE p \in Pois : st[p] = "trimming"

(* trimStreamed(incoming), one pass of the loop (low-mem.ts:250-259): while the list with the incoming POI is over the
   cap, evict the farthest evictable resident; then building.add(incoming) *)
TrimEvict ==
  /\ loop = "trim"
  /\ Cardinality(Counted) + 1 > Cap
  /\ \E v \in Evictable :
       /\ \A q \in Evictable : dist[q] = "far" \/ dist[v] # "far"   \* the farthest first
       /\ st' = [st EXCEPT ![v] = "queued"] /\ thrown' = (thrown \/ st[v] # "live")
  /\ UNCHANGED <<dist, inMatch, loop, outside>>
TrimDone ==
  /\ loop = "trim"
  /\ (Cardinality(Counted) + 1 <= Cap \/ Evictable = {})
  /\ st' = [st EXCEPT ![Incoming] = "building"]
  /\ loop' = "build"
  /\ UNCHANGED <<dist, inMatch, thrown, outside>>

(* buildStreamed: build() returns, then integrateFresh runs in the background; the loop waits only when two
   integrations are in flight (main.ts:615-616) *)
Built ==
  /\ loop = "build"
  /\ \E p \in Pois : st[p] = "building" /\ st' = [st EXCEPT ![p] = "integrating"]
  /\ loop' = IF Cardinality(Integrating) + 1 > 1 THEN "wait" ELSE "pick"
  /\ UNCHANGED <<dist, inMatch, thrown, outside>>
Integrated ==
  /\ \E p \in Integrating : st' = [st EXCEPT ![p] = "live"]
  /\ loop' = IF loop = "wait" /\ Cardinality(Integrating) - 1 <= 1 THEN "pick" ELSE loop
  /\ UNCHANGED <<dist, inMatch, thrown, outside>>

(* the 2 s timer: trim(null), in a match or not (main.ts:590); serialized with the loop's own trim *)
Timer ==
  /\ loop # "trim"
  /\ Cardinality(Counted) > Cap
  /\ \E v \in Evictable :
       /\ \A q \in Evictable : dist[q] = "far" \/ dist[v] # "far"
       /\ st' = [st EXCEPT ![v] = "queued"] /\ thrown' = (thrown \/ st[v] # "live")
  /\ UNCHANGED <<dist, inMatch, loop, outside>>

Next == Move \/ EnterMatch \/ LeaveMatch \/ Pick \/ TrimEvict \/ TrimDone \/ Built \/ Integrated \/ Timer

Spec == Init /\ [][Next]_vars

(* --- the rules --- *)
\* At most lowmemcap streamed POIs hold memory at once, counting the one being built.
AtMostCap == Cardinality(Held) <= Cap
\* The same rule with one POI of slack: the one being built while the others still finish.
AtMostCapPlusOne == Cardinality(Held) <= Cap + 1
\* A location is never thrown away while it is still building or fading in.
NoEvictWhileBuilding == ~thrown
\* Nothing new is built outside a match (title, room, results lobby).
NothingBuiltOutsideMatch == ~outside
=============================================================================
