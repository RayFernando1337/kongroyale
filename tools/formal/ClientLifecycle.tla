--------------------------- MODULE ClientLifecycle ---------------------------
(* The game client's life from page load to the next match (client/src/main.ts boot, client/src/game/index.ts
   sessions, client/src/game/render.ts GameRender and its "match" resource scope, client/src/engine/res/restore.ts
   context loss), with the server's side reduced to the messages the client gets (server/lobby.ts). One player, one
   tab. Abstracted: the match's phases are one step each; positions, loot and timers are left out; the reload timers
   are a step that can happen while the context is lost.

   Online: CREATE/JOIN, the room, host START. Offline: PLAY vs bots (a practice match on an OfflineLink). Left out: a
   link that drops mid-match and the reconnect card (index.ts linkLost, reconnectTry), which end in the same exitToRoom
   rewire as MatchOver. *)
EXTENDS Naturals

CONSTANTS Online   \* TRUE: include the online room paths; FALSE: practice only (a smaller chart)

VARIABLES
  boot,      \* "loading" | "ready" (window.__kr.ready)
  prefabs,   \* kits.viewModel exists (built after ready by kr.prefabWarmP, index.ts:88,817)
  view,      \* what the player sees: "title" | "room" | "match" | "results"
  phase,     \* the match phase the client shows: "warmup" | "plane" | "play" | "results"
  link,      \* "none" | "offline" | "online" | "closed" (an online socket that closed)
  scope,     \* live "match" resource scopes (resources.root.child("match"), render.ts:163): 0 or 1
  render,    \* a GameRender is wired (render !== null in index.ts)
  seated,    \* online: the server still has this client in the running match
  err,       \* an error text is on screen (lobbyState.error)
  why,       \* the server ended this client's match with a reason the player has not seen dismissed yet
  silent,    \* the player pressed a button and nothing happened (no busy state, no error, no screen)
  ctx,       \* WebGL: "ok" | "lost" | "restoring"
  restores   \* restoreAll() runs in flight (restore-run.ts:13-20)
vars == <<boot, prefabs, view, phase, link, scope, render, seated, err, why, silent, ctx, restores>>

Init ==
  /\ boot = "loading" /\ prefabs = FALSE /\ view = "title" /\ phase = "warmup" /\ link = "none"
  /\ scope = 0 /\ render = FALSE /\ seated = FALSE /\ err = FALSE /\ why = FALSE /\ silent = FALSE
  /\ ctx = "ok" /\ restores = 0

Ready == boot = "loading" /\ boot' = "ready" /\ UNCHANGED <<prefabs, view, phase, link, scope, render, seated, err, why, silent, ctx, restores>>
Prefabs == boot = "ready" /\ ~prefabs /\ prefabs' = TRUE /\ UNCHANGED <<boot, view, phase, link, scope, render, seated, err, why, silent, ctx, restores>>

(* wire(l) (index.ts:269-284): dispose the old GameRender, then new GameRender: its field initializer opens the
   "match" scope (throws if one is still live, scope.ts:130), then its constructor needs kits.viewModel (render.ts:233) *)
WireScope == IF render THEN 0 ELSE scope            \* after render?.dispose()
WireOk == WireScope = 0 /\ prefabs
WireScopeAfter == IF WireScope = 0 THEN 1 ELSE WireScope

(* PLAY vs bots: offline() (index.ts:251-266): leaveAll, new OfflineLink, wire, start in 50 ms. Before ready only
   Enter reaches the lobby (the loading screen swallows clicks, not Enter: index.html:389-404, ui/lobby.ts:333-350) *)
Play ==
  /\ view = "title" /\ ctx = "ok"
  /\ boot = "loading" \/ prefabs   \* after ready, kr.prepare() waits for the prefabs (main.ts:502-531); before, it is undefined
  /\ scope' = WireScopeAfter /\ render' = WireOk
  /\ link' = "offline"
  /\ view' = (IF WireOk THEN "match" ELSE "title") /\ phase' = "warmup"
  /\ silent' = ~WireOk
  /\ UNCHANGED <<boot, prefabs, seated, err, why, ctx, restores>>

(* CREATE/JOIN: online() (index.ts:230-244) reuses any online link without checking it is open (231) *)
Connect ==
  /\ Online /\ boot = "ready" /\ prefabs /\ view = "title" /\ ctx = "ok"
  /\ IF link = "closed"
       THEN /\ silent' = TRUE   \* link?.sendJSON does nothing on a closed socket (net.ts:42); no busy, no error
            /\ UNCHANGED <<view, link, scope, render>>
       ELSE /\ link' = "online" /\ scope' = WireScopeAfter /\ render' = WireOk
            /\ view' = (IF WireOk THEN "room" ELSE "title") /\ silent' = ~WireOk
  /\ UNCHANGED <<boot, prefabs, phase, seated, err, why, ctx, restores>>
\* a JOIN that fails ("NO SUCH LOBBY") leaves the socket open at the title
JoinFails ==
  /\ Online /\ boot = "ready" /\ view = "title" /\ link \in {"none", "offline"} /\ ctx = "ok"
  /\ link' = "online" /\ err' = TRUE
  /\ scope' = WireScopeAfter /\ render' = WireOk
  /\ UNCHANGED <<boot, prefabs, view, phase, seated, why, silent, ctx, restores>>
\* the socket closes at the title (server idle close, network drop): ignored unless in a match or a room (index.ts:283)
SocketClosesAtTitle ==
  /\ link = "online" /\ view = "title"
  /\ link' = "closed"
  /\ UNCHANGED <<boot, prefabs, view, phase, scope, render, seated, err, why, silent, ctx, restores>>

\* the host presses START: the "match" message, enterMatch
Start == Online /\ view = "room" /\ link = "online" /\ view' = "match" /\ phase' = "warmup" /\ seated' = TRUE
  /\ UNCHANGED <<boot, prefabs, link, scope, render, err, why, silent, ctx, restores>>

\* the server's match moves on: phase messages
NextPhase ==
  /\ view = "match" /\ phase # "results" /\ (link = "offline" \/ seated)
  /\ phase' = CASE phase = "warmup" -> "plane" [] phase = "plane" -> "play" [] OTHER -> "results"
  /\ view' = (IF phase = "play" THEN "results" ELSE view)
  /\ UNCHANGED <<boot, prefabs, link, scope, render, seated, err, why, silent, ctx, restores>>

(* the match is over: online, the room frame inMatch:false runs exitToRoom (dispose, wire: a new idle GameRender);
   offline, the results card stays until the player leaves *)
MatchOver ==
  /\ view = "results" /\ link = "online" /\ seated
  /\ view' = "room" /\ seated' = FALSE /\ err' = FALSE
  /\ scope' = WireScopeAfter /\ render' = WireOk
  /\ UNCHANGED <<boot, prefabs, phase, link, why, silent, ctx, restores>>

\* leaveAll(): back to the title from anywhere (pause menu Leave, BACK TO LOBBY offline, LEAVE in the room)
Leave ==
  /\ view \in {"room", "match", "results"}
  /\ view' = "title" /\ link' = "none" /\ seated' = FALSE /\ err' = FALSE /\ why' = FALSE /\ silent' = FALSE
  /\ scope' = (IF render THEN 0 ELSE scope) /\ render' = FALSE
  /\ UNCHANGED <<boot, prefabs, phase, ctx, restores>>

(* the server removes this client from a running match:
   AFK in a normal lobby (lobby.ts:157): error "REMOVED FOR INACTIVITY" without afk:true, no lobby frame;
   the client only shows the text (index.ts:322-328) *)
RemovedAfk ==
  /\ Online /\ view \in {"match", "results"} /\ link = "online" /\ seated
  /\ seated' = FALSE /\ err' = TRUE /\ why' = TRUE
  /\ UNCHANGED <<boot, prefabs, view, phase, link, scope, render, silent, ctx, restores>>
(* the match crashes on the server (lobby.ts:140-143): error "MATCH CRASHED", then the room frame, whose handler
   clears lobbyState.error (index.ts:317) and runs exitToRoom *)
Crashed ==
  /\ Online /\ view \in {"match", "results"} /\ link = "online" /\ seated
  /\ seated' = FALSE /\ why' = TRUE /\ view' = "room" /\ err' = FALSE
  /\ scope' = WireScopeAfter /\ render' = WireOk
  /\ UNCHANGED <<boot, prefabs, phase, link, silent, ctx, restores>>

\* the player reads the message and goes on: any button dismisses it
Dismiss == why /\ why' = FALSE /\ err' = FALSE /\ UNCHANGED <<boot, prefabs, view, phase, link, scope, render, seated, silent, ctx, restores>>

(* WebGL context loss (restore.ts:44-62): lost stops the frame loop; restored runs restoreAll; nothing stops a second
   loss and restore while restoreAll is still running (only its final bookkeeping checks loss === losses) *)
Lose == ctx # "lost" /\ boot = "ready" /\ ctx' = "lost" /\ UNCHANGED <<boot, prefabs, view, phase, link, scope, render, seated, err, why, silent, restores>>
Restored == ctx = "lost" /\ ctx' = "restoring" /\ restores' = restores + 1 /\ UNCHANGED <<boot, prefabs, view, phase, link, scope, render, seated, err, why, silent>>
RestoreDone == restores > 0 /\ restores' = restores - 1 /\ ctx' = (IF ctx = "restoring" /\ restores = 1 THEN "ok" ELSE ctx)
  /\ UNCHANGED <<boot, prefabs, view, phase, link, scope, render, seated, err, why, silent>>
\* no restore within 10 s of the loss (30 s after the restored event): location.reload(), a fresh page
Reload ==
  /\ ctx \in {"lost", "restoring"}
  /\ boot' = "loading" /\ prefabs' = FALSE /\ view' = "title" /\ phase' = "warmup" /\ link' = "none"
  /\ scope' = 0 /\ render' = FALSE /\ seated' = FALSE /\ err' = FALSE /\ why' = FALSE /\ silent' = FALSE
  /\ ctx' = "ok" /\ restores' = 0

Next == Ready \/ Prefabs \/ Play \/ Connect \/ JoinFails \/ SocketClosesAtTitle \/ Start \/ NextPhase \/ MatchOver
  \/ Leave \/ RemovedAfk \/ Crashed \/ Dismiss \/ Lose \/ Restored \/ RestoreDone \/ Reload

Spec == Init /\ [][Next]_vars

Bound == restores <= 2

(* --- the rules, in the player's words --- *)
\* The match's resource scope is open only while a match view (GameRender) owns it, so the next PLAY can open its own.
ScopeHasOwner == scope = 1 => render
\* Pressing PLAY, CREATE or JOIN always does something the player can see.
ButtonsAnswer == ~silent
\* A match on screen is one the server still plays for this player (offline matches always are).
NoFrozenMatch == view \in {"match", "results"} /\ link = "online" => seated
\* When the server ends the player's match with a reason, the reason stays on screen until the player moves on.
ReasonStays == why => err
\* One context restore at a time.
OneRestore == restores <= 1
\* A match on screen always has its renderer.
NoMatchWithoutRenderer == view \in {"match", "results"} => render
\* Once you are back on the title, the server no longer holds a seat in a match for you.
LeaveFreesTheSeat == view = "title" => ~seated
=============================================================================
