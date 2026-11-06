---------------------------- MODULE DiagHeartbeat ----------------------------
(* KONG-71's crash heartbeat, two tabs of one browser profile (they share localStorage and Web Locks). Design = "locks"
   is the code on main (client/src/playtest/diag.ts, report.ts; built in #198 and #215 after this model found the bugs of
   the plan); Design = "plan" is the design as first written (one shared record, beaten every 5 s, marked clean on
   pagehide), kept for DiagHeartbeat.findings.cfg, where all three rules break.

   Tabs are browser tabs; Sessions is a pool of page lifetimes: a tab that opens takes a fresh one, so "the crash of
   session 1" and "the page now open in tab a" are told apart.

   Not modelled: time (a 5 s beat is a step that may or may not happen before a kill), the 7-day expiry of old records
   (KEEP_MS), browsers without Web Locks (they keep no heartbeat), and the automatic summary, which is not built (slice 2;
   when it is, add it back as the plan had it, git show e1e3509:tools/formal/DiagHeartbeat.tla). *)
EXTENDS Naturals, FiniteSets

CONSTANTS Tabs, Sessions, Design

None == 0
VARIABLES
  cur,      \* the session open in each tab, None = no page
  bf,       \* the page is in the back/forward cache (pagehide persisted), not running
  used,     \* sessions already started
  started,  \* locks: sessions whose diagnostics started (the playtest chunk ran goLive); plan: every opened session
  dead,     \* sessions that ended by a kill or crash, not by a clean pagehide
  seen,     \* dead sessions a load has picked up
  prompt,   \* the dead session the crash prompt on this tab's title is about, None = no prompt
  reports,  \* crash reports sent about each session
  hb,       \* plan: the one heartbeat record in localStorage
  hbs       \* locks: one heartbeat record per session, "none" | "running" | "clean" (kr.diag.hb.<sid>)
vars == <<cur, bf, used, started, dead, seen, prompt, reports, hb, hbs>>

Live(t) == cur[t] # None
\* a live page holds its session's Web Lock (goLive) until the page dies, the back/forward cache included
Running(s) == \E t \in Tabs : cur[t] = s

Init ==
  /\ cur = [t \in Tabs |-> None] /\ bf = [t \in Tabs |-> FALSE]
  /\ used = {} /\ started = {} /\ dead = {} /\ seen = {}
  /\ prompt = [t \in Tabs |-> None] /\ reports = [s \in Sessions |-> 0]
  /\ hb = [owner |-> None, clean |-> TRUE]
  /\ hbs = [s \in Sessions |-> "none"]

(* plan: what a load sees, the session it will report as crashed, or None *)
PlanSuspect == IF hb.owner # None /\ ~hb.clean THEN hb.owner ELSE None
\* locks (findDeadSession): a record not marked clean whose session holds no Web Lock is dead
LockSuspects == {s \in Sessions : hbs[s] = "running" /\ ~Running(s)}

Report(s) == [reports EXCEPT ![s] = @ + 1]

(* the page loads. plan: it looks for a dead session at once. locks: nothing yet; the heartbeat starts when the lazy
   playtest chunk runs (GoLive), after boot *)
Open(t) ==
  /\ ~Live(t)
  /\ \E s \in Sessions \ used :
       /\ cur' = [cur EXCEPT ![t] = s] /\ used' = used \cup {s}
       /\ IF Design = "plan"
            THEN /\ started' = started \cup {s}
                 /\ prompt' = [prompt EXCEPT ![t] = PlanSuspect]
                 /\ seen' = IF PlanSuspect = None THEN seen ELSE seen \cup {PlanSuspect}
            ELSE UNCHANGED <<started, prompt, seen>>
  /\ UNCHANGED <<bf, dead, reports, hb, hbs>>

(* locks: diag.ts installDiag -> goLive then findDeadSession. goLive takes this session's Web Lock and writes its record
   ("running"); findDeadSession, under the one kr.diag.claim lock, deletes every suspect record and keeps the newest as
   prev; report.ts installReport shows the crash card about it (crashCard) *)
GoLive(t) ==
  /\ Design = "locks" /\ Live(t) /\ ~bf[t] /\ cur[t] \notin started
  /\ started' = started \cup {cur[t]}
  /\ \E p \in IF LockSuspects = {} THEN {None} ELSE LockSuspects :
       /\ prompt' = [prompt EXCEPT ![t] = p]
       /\ seen' = seen \cup LockSuspects
       /\ hbs' = [x \in Sessions |-> IF x = cur[t] THEN "running" ELSE IF x \in LockSuspects THEN "none" ELSE hbs[x]]
  /\ UNCHANGED <<cur, bf, used, dead, reports, hb>>

(* plan: the 5 s heartbeat of a running page (locks: the 5 s beat rewrites a record that is already "running") *)
Beat(t) ==
  /\ Live(t) /\ ~bf[t] /\ Design = "plan"
  /\ hb' = [owner |-> cur[t], clean |-> FALSE]
  /\ UNCHANGED <<cur, bf, used, started, dead, seen, prompt, reports, hbs>>

(* the player closes the tab or navigates away: pagehide, not persisted (installDiag's pagehide listener) *)
Close(t) ==
  /\ Live(t) /\ ~bf[t]
  /\ hb' = IF Design = "plan" THEN [owner |-> cur[t], clean |-> TRUE] ELSE hb
  /\ hbs' = IF Design = "plan" \/ cur[t] \notin started THEN hbs ELSE [hbs EXCEPT ![cur[t]] = "clean"]
  /\ cur' = [cur EXCEPT ![t] = None] /\ prompt' = [prompt EXCEPT ![t] = None]
  /\ UNCHANGED <<bf, used, started, dead, seen, reports>>

(* the browser kills the tab (Safari out of memory, a crash): no pagehide, and its Web Lock is released *)
Kill(t) ==
  /\ Live(t) /\ ~bf[t]
  /\ dead' = dead \cup {cur[t]}
  /\ cur' = [cur EXCEPT ![t] = None] /\ prompt' = [prompt EXCEPT ![t] = None]
  /\ UNCHANGED <<bf, used, started, seen, reports, hb, hbs>>

(* pagehide, persisted: the page goes into the back/forward cache (installDiag's pagehide listener marks it clean), and
   pageshow brings it back (installDiag's pageshow listener: persisted, so it marks the record running at once) *)
Freeze(t) ==
  /\ Live(t) /\ ~bf[t] /\ bf' = [bf EXCEPT ![t] = TRUE]
  /\ hb' = IF Design = "plan" THEN [owner |-> cur[t], clean |-> TRUE] ELSE hb
  /\ hbs' = IF Design = "plan" \/ cur[t] \notin started THEN hbs ELSE [hbs EXCEPT ![cur[t]] = "clean"]
  /\ UNCHANGED <<cur, used, started, dead, seen, prompt, reports>>
Thaw(t) ==
  /\ Live(t) /\ bf[t] /\ bf' = [bf EXCEPT ![t] = FALSE]
  /\ hbs' = IF Design = "plan" \/ cur[t] \notin started THEN hbs ELSE [hbs EXCEPT ![cur[t]] = "running"]
  /\ UNCHANGED <<cur, used, started, dead, seen, prompt, reports, hb>>
\* a cached page the browser drops is a normal end, not a crash
Drop(t) ==
  /\ Live(t) /\ bf[t] /\ bf' = [bf EXCEPT ![t] = FALSE]
  /\ cur' = [cur EXCEPT ![t] = None] /\ prompt' = [prompt EXCEPT ![t] = None]
  /\ UNCHANGED <<used, started, dead, seen, reports, hb, hbs>>

(* the player answers the crash card (report.ts crashCard): SEND opens the sheet and sends a crash report carrying
   prev with its sid (report.ts body); NO THANKS, or a match starting, removes the card *)
Answer(t) ==
  /\ Live(t) /\ ~bf[t] /\ prompt[t] # None
  /\ \E send \in BOOLEAN : reports' = IF send THEN Report(prompt[t]) ELSE reports
  /\ prompt' = [prompt EXCEPT ![t] = None]
  /\ UNCHANGED <<cur, bf, used, started, dead, seen, hb, hbs>>

Done == used = Sessions /\ (\A t \in Tabs : ~Live(t)) /\ UNCHANGED vars

Next == \E t \in Tabs : Open(t) \/ GoLive(t) \/ Beat(t) \/ Close(t) \/ Kill(t) \/ Freeze(t) \/ Thaw(t) \/ Drop(t)
  \/ Answer(t)
  \/ Done

Spec == Init /\ [][Next]_vars

(* --- the rules, in the player's words --- *)
\* The title never says "your last session closed unexpectedly" about a session that is still open, or that ended cleanly.
NoFalseCrash == \A t \in Tabs : prompt[t] # None => prompt[t] \in dead
\* A session that dies after its diagnostics started is picked up by a later load: until then the evidence is still in
\* localStorage. A tab killed while it boots, before the playtest chunk runs, leaves no record (see the skill).
NoLostCrash == \A s \in (dead \cap started) \ seen :
  IF Design = "plan" THEN hb.owner = s /\ ~hb.clean ELSE hbs[s] = "running"
\* One crash is reported at most once, however many tabs load and whatever the player taps.
OneReportPerCrash == \A s \in Sessions : reports[s] <= 1
=============================================================================
