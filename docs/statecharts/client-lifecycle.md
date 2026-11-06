# The game client's lifecycle

This chart shows the client from page load to the next match: the loading screen, the title, a practice match, an online
room and match, and, beside them, the WebGL context (lost, restoring, back). It is drawn from the TLA+ model
`tools/formal/ClientLifecycle.tla` by the pstack `/statechart` skill, with every rule switched on, so TLC also marks the
states where a rule breaks. The `verify-client-lifecycle` skill (`.agents/skills/verify-client-lifecycle/`) says how
to run the check and keep the model in step with the code.

The model covers `client/src/game/index.ts` (`offline`, `online`, `wire`, `onJSON`, `enterMatch`, `exitToRoom`,
`leaveAll`), `client/src/game/render.ts` (the `GameRender` and its `match` resource scope),
`client/src/engine/res/restore.ts` and `restore-run.ts` (context loss and restore), and the messages
`server/lobby.ts` sends the client (AFK removal, a crashed match, the end of a match). One player, one tab. A link
that drops mid-match and the reconnect card are left out.

```mermaid
---
title: "The game client, from page load to the next match"
---
stateDiagram-v2
  direction LR
  state "Legend" as legend {
    lg0: Breaks ButtonsAnswer or NoFrozenMatch or OneRestore or ReasonStays or ScopeHasOwner
    lg1: Breaks ButtonsAnswer or NoFrozenMatch or OneRestore or ReasonStays or ScopeHasOwner in some cases
    lg2: Path to the ButtonsAnswer or NoFrozenMatch or OneRestore or ReasonStays or ScopeHasOwner bug
  }
  class lg0 breaks
  class lg1 mayBreak
  class lg2 bugPath
  state "At the same time" as all {
    state "Game" as r0 {
      s0: Loading screen
      s1: Title
      s2: Practice match
      s3: Waiting room
      s4: Online match
      s5: Practice results
      s6: Online results
      [*] --> s0
      s0 --> s1: the title is ready
      s1 --> s0: the page reloads [unless Drawing]
      s1 --> s2: you press PLAY
      s1 --> s3: you press CREATE or JOIN
      s2 --> s1: you leave
      s3 --> s1: you leave
      s3 --> s4: the host presses START
      s2 --> s0: the page reloads [unless Drawing]
      s3 --> s0: the page reloads [unless Drawing]
      s4 --> s1: you leave
      s4 --> s3: the match crashes on the server
      s2 --> s5: the match moves on
      s4 --> s0: the page reloads [unless Drawing]
      s4 --> s6: the match moves on
      s5 --> s1: you leave
      s5 --> s0: the page reloads [unless Drawing]
      s6 --> s1: you leave
      s6 --> s3: the match ends or the match crashes on the server
      s6 --> s0: the page reloads [unless Drawing]
    }
    --
    state "Graphics" as r1 {
      s7: Drawing
      s8: Context lost
      s9: Restoring
      s10: Two restores at once
      [*] --> s7
      s7 --> s8: the GPU context is lost [unless Loading screen]
      s8 --> s7: the page reloads
      s8 --> s9: the context comes back
      s9 --> s7: the page reloads or the restore finishes
      s9 --> s8: the GPU context is lost
      s8 --> s10: the context comes back
      s10 --> s7: the page reloads
      s10 --> s9: the restore finishes
      s10 --> s8: the GPU context is lost
    }
  }
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  classDef mayBreak fill:#fff3e6,stroke:#e8730c,stroke-width:2.5px,color:#b85a06
  class s0 mayBreak
  class s0 bugPath
  class s1 mayBreak
  class s1 bugPath
  class s3 mayBreak
  class s3 bugPath
  class s4 mayBreak
  class s4 bugPath
  class s6 mayBreak
  class s7 bugPath
  class s8 mayBreak
  class s8 bugPath
  class s9 bugPath
  class s10 breaks
  class s10 bugPath
```

Red states break a rule on every path through them, orange ones on some paths. Blue edges are the shortest path to a
broken rule.

## The rules

| Rule | In plain words | Holds today? |
|---|---|---|
| NoMatchWithoutRenderer | A match on screen always has its renderer. | Yes |
| LeaveFreesTheSeat | Once you are back on the title, the server no longer holds a seat in a match for you. | Yes |
| ScopeHasOwner | The match's resource scope is open only while a match view owns it, so the next PLAY can open its own. | No: Enter on the loading screen |
| ButtonsAnswer | Pressing PLAY, CREATE or JOIN always does something you can see. | No: Enter on the loading screen |
| NoFrozenMatch | A match on screen is one the server still plays for you. | No: removed for inactivity |
| ReasonStays | When the server ends your match with a reason, the reason stays on screen until you move on. | No: a crashed match |
| OneRestore | One context restore at a time. | No: lose, restore, lose, restore |

`tools/formal/ClientLifecycle.cfg` checks the two rules that hold, so `node tools/formal/tlc.mjs ClientLifecycle` passes
and catches a regression in them. `tools/formal/ClientLifecycle.findings.cfg` checks all seven; it is what this chart
and the paths below come from.

## The paths that break a rule

1. **Enter on the loading screen** (ScopeHasOwner, ButtonsAnswer), 1 step. The loading screen swallows clicks but not
   Enter, so Enter reaches the title's PLAY (or JOIN, on a page opened with an invite link). `offline()` calls `wire()` before the prefabs exist: the new
   `GameRender` opens the `match` scope, then its constructor reads `kits.viewModel`, which is still null, and throws.
   The scope stays open with no owner, so every later PLAY fails with "already has a live child named match". On a load
   that takes over 120 s (as on SwiftShader), the error also trips the loading screen's watchdog (errors before ready
   after 120 s, index.html), and "THE ISLAND COULDN'T LOAD" stays up for good. On the JOIN path, `online()` catches the same throw and shows "NO SERVER", which is visible but names the wrong cause.
2. **Removed for inactivity** (NoFrozenMatch), 5 steps: title, CREATE, START, then 180 s with no input. The server
   sends `REMOVED FOR INACTIVITY` without `afk: true` and no room frame. The client shows the text over a match that
   no longer updates.
3. **A crashed match** (ReasonStays), 5 steps. The server sends `MATCH CRASHED` and then the room frame, whose handler
   clears `lobbyState.error` as it returns to the room, so the reason can vanish before you read it.
4. **CREATE after the socket closed at the title** (ButtonsAnswer), fixed. A failed JOIN left a socket open at the
   title, and when the server closed it, `online()` reused the dead link, so CREATE sent nothing and showed nothing.
   `wire()`'s `onClose` now drops a link that closes at the title, and the model's SocketClosesAtTitle says so.
5. **Two restores at once** (OneRestore), 5 steps: lose, restore, lose, restore. Nothing stops a second
   `restoreAll` while the first is still running; only its final bookkeeping checks for a newer loss.

A path in the model is a lead, not a bug report. Each one is confirmed or refuted by running the real game (see the
skill), and the pull request that adds this chart says which.

## What Ray should check

- On a slow load, press Enter before the title appears, then press PLAY once it does. Does a practice match start?
- Start an online match in a private room and leave it without touching anything for 3 minutes. What does the screen
  show afterwards, and is there a way back to the room other than Leave?
- Type a wrong code into JOIN, wait 10 minutes on the title, then press CREATE. Does anything happen?
- Is the chart's order of screens how you think of the game? A screen you know but cannot find here is a gap in the
  model.
