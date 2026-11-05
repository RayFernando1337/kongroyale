---------------------------- MODULE DiagHeartbeat ----------------------------
(* KONG-71's planned crash heartbeat (Captain drive plans/player-diagnostics.md, "What gets captured" and "After a
   crash or tab kill"): every 5 s the page writes a heartbeat to localStorage and marks it clean on pagehide; on the
   next load, a heartbeat with no clean exit means the last session died, and the title asks "Send what we know?" (and
   the automatic variant sends a summary). Not built yet: this models the design as written ("plan") and one fix
   ("locks": one record per session, and a Web Lock each live page holds, so a load can tell a dead session from a live
   one in another tab).

   Tabs are browser tabs of one profile; they share localStorage. Sessions is a pool of page lifetimes: a tab that
   opens takes a fresh one, so "the crash of session 1" and "the page now open in tab a" are told apart. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Tabs, Sessions, Design

None == 0
VARIABLES
  cur,      \* the session open in each tab, None = no page
  bf,       \* the page is in the back/forward cache (pagehide persisted), not running
  used,     \* sessions already started
  dead,     \* sessions that ended by a kill or crash, not by a clean pagehide
  seen,     \* dead sessions some prompt or automatic summary has picked up
  prompt,   \* the dead session the crash prompt on this tab's title is about, None = no prompt
  reports,  \* crash reports sent about each session (the prompt's Send plus the automatic summary)
  autoOn,   \* the player ticked "send anonymous performance stats automatically"
  hb,       \* plan: the one heartbeat record in localStorage
  hbs       \* locks: one heartbeat record per session
vars == <<cur, bf, used, dead, seen, prompt, reports, autoOn, hb, hbs>>

Live(t) == cur[t] # None
Running(s) == \E t \in Tabs : cur[t] = s

Init ==
  /\ cur = [t \in Tabs |-> None] /\ bf = [t \in Tabs |-> FALSE]
  /\ used = {} /\ dead = {} /\ seen = {}
  /\ prompt = [t \in Tabs |-> None] /\ reports = [s \in Sessions |-> 0]
  /\ autoOn \in BOOLEAN
  /\ hb = [owner |-> None, clean |-> TRUE]
  /\ hbs = [s \in Sessions |-> "none"]

(* what a page sees when it loads: the session it will report as crashed, or None *)
PlanSuspect == IF hb.owner # None /\ ~hb.clean THEN hb.owner ELSE None
\* locks: a record still "running" whose session holds no lock is dead; "claimed" = another page is already asking
LockSuspects == {s \in Sessions : hbs[s] = "running" /\ ~Running(s)}

Report(s, n) == [reports EXCEPT ![s] = @ + n]

(* a tab loads the game: it may find a dead session, show the prompt, and (auto on) send the summary at once *)
Open(t) ==
  /\ ~Live(t)
  /\ \E s \in Sessions \ used :
       /\ cur' = [cur EXCEPT ![t] = s] /\ used' = used \cup {s} /\ bf' = bf
       /\ \E p \in IF Design = "plan" THEN {PlanSuspect} ELSE (IF LockSuspects = {} THEN {None} ELSE LockSuspects) :
            /\ prompt' = [prompt EXCEPT ![t] = p]
            /\ seen' = IF p = None THEN seen ELSE seen \cup {p}
            /\ reports' = IF p # None /\ autoOn THEN Report(p, 1) ELSE reports
            /\ hb' = hb   \* plan: the first beat comes up to 5 s later
            /\ hbs' = IF Design = "plan" THEN hbs
                      ELSE [x \in Sessions |-> IF x = s THEN "running" ELSE IF x = p THEN "claimed" ELSE hbs[x]]
  /\ UNCHANGED <<dead, autoOn>>

(* the 5 s heartbeat of a running page *)
Beat(t) ==
  /\ Live(t) /\ ~bf[t] /\ Design = "plan"
  /\ hb' = [owner |-> cur[t], clean |-> FALSE]
  /\ UNCHANGED <<cur, bf, used, dead, seen, prompt, reports, autoOn, hbs>>

(* the player closes the tab or navigates away: pagehide, not persisted *)
Close(t) ==
  /\ Live(t) /\ ~bf[t]
  /\ hb' = IF Design = "plan" THEN [owner |-> cur[t], clean |-> TRUE] ELSE hb
  /\ hbs' = IF Design = "plan" THEN hbs ELSE [hbs EXCEPT ![cur[t]] = "clean"]
  /\ cur' = [cur EXCEPT ![t] = None] /\ prompt' = [prompt EXCEPT ![t] = None]
  /\ UNCHANGED <<bf, used, dead, seen, reports, autoOn>>

(* the browser kills the tab (Safari out of memory, a crash): no pagehide *)
Kill(t) ==
  /\ Live(t) /\ ~bf[t]
  /\ dead' = dead \cup {cur[t]}
  /\ cur' = [cur EXCEPT ![t] = None] /\ prompt' = [prompt EXCEPT ![t] = None]
  /\ UNCHANGED <<bf, used, seen, reports, autoOn, hb, hbs>>

(* pagehide, persisted: the page goes into the back/forward cache, and pageshow brings it back *)
Freeze(t) ==
  /\ Live(t) /\ ~bf[t] /\ bf' = [bf EXCEPT ![t] = TRUE]
  /\ hb' = IF Design = "plan" THEN [owner |-> cur[t], clean |-> TRUE] ELSE hb
  /\ hbs' = IF Design = "plan" THEN hbs ELSE [hbs EXCEPT ![cur[t]] = "clean"]
  /\ UNCHANGED <<cur, used, dead, seen, prompt, reports, autoOn>>
Thaw(t) ==
  /\ Live(t) /\ bf[t] /\ bf' = [bf EXCEPT ![t] = FALSE]
  /\ hbs' = IF Design = "plan" THEN hbs ELSE [hbs EXCEPT ![cur[t]] = "running"]   \* locks: pageshow beats at once
  /\ UNCHANGED <<cur, used, dead, seen, prompt, reports, autoOn, hb>>
\* a cached page the browser drops is a normal end, not a crash
Drop(t) ==
  /\ Live(t) /\ bf[t] /\ bf' = [bf EXCEPT ![t] = FALSE]
  /\ cur' = [cur EXCEPT ![t] = None] /\ prompt' = [prompt EXCEPT ![t] = None]
  /\ UNCHANGED <<used, dead, seen, reports, autoOn, hb, hbs>>

(* the player answers the crash prompt: Send what we know, or dismiss it *)
Answer(t) ==
  /\ Live(t) /\ ~bf[t] /\ prompt[t] # None
  \* locks: the bundle carries the dead session's id, so triage merges it with an automatic summary of the same crash
  /\ \E send \in BOOLEAN : reports' = IF send /\ (Design = "plan" \/ reports[prompt[t]] = 0) THEN Report(prompt[t], 1) ELSE reports
  /\ hbs' = IF Design = "plan" THEN hbs ELSE [hbs EXCEPT ![prompt[t]] = "none"]
  /\ prompt' = [prompt EXCEPT ![t] = None]
  /\ UNCHANGED <<cur, bf, used, dead, seen, autoOn, hb>>

Settings ==
  /\ autoOn' = ~autoOn
  /\ UNCHANGED <<cur, bf, used, dead, seen, prompt, reports, hb, hbs>>

Done == used = Sessions /\ (\A t \in Tabs : ~Live(t)) /\ UNCHANGED vars

Next == \E t \in Tabs : Open(t) \/ Beat(t) \/ Close(t) \/ Kill(t) \/ Freeze(t) \/ Thaw(t) \/ Drop(t) \/ Answer(t)
  \/ Settings \/ Done

Spec == Init /\ [][Next]_vars

(* --- the rules, in the player's words --- *)
\* The title never says "your last session closed unexpectedly" about a session that is still open, or that ended cleanly.
NoFalseCrash == \A t \in Tabs : prompt[t] # None => prompt[t] \in dead
\* A session that dies is picked up by a later load: until then the evidence is still in localStorage.
NoLostCrash == \A s \in dead \ seen :
  IF Design = "plan" THEN hb.owner = s /\ ~hb.clean ELSE hbs[s] = "running"
\* One crash is reported at most once, however many tabs load and whatever the player taps.
OneReportPerCrash == \A s \in Sessions : reports[s] <= 1
=============================================================================
