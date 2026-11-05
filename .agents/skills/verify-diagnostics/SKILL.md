---
name: verify-diagnostics
description: Model-check Kong Royale's planned player diagnostics (KONG-71) with TLA+ - the crash heartbeat across tabs (no false crash prompt, no lost crash, one report per crash) and the send flow (consent first, callsign only when ticked, automatic summaries only when on, every send answered) - and draw them as statecharts (docs/statecharts/diagnostics.md). Use before changing the KONG-71 design, and before calling done any code that implements the heartbeat, the crash prompt, the consent sheet, Send diagnostics, Report a problem or the automatic summary.
---

# Verify player diagnostics

KONG-71's diagnostics are not built yet. These two models check the design so its bugs are fixed in the plan, and they
become the check for the code once it lands.

- `tools/formal/DiagHeartbeat.tla`: two tabs of one profile share `localStorage`; every order of loads, 5 s beats,
  closes, kills, back/forward-cache freezes and thaws, and crash-prompt answers. `Design` picks the plan as written
  (`"plan"`, one shared record) or the fix (`"locks"`, one record per session plus a Web Lock per live page).
- `tools/formal/DiagSend.tla`: one tab's screens around a send, and the server accepting or refusing it.
  `RefusedShown` picks the plan as written (`FALSE`) or the fix (`TRUE`, a refused send says so). `Spec` assumes every
  upload is answered in the end (weak fairness on Accepted or Refused), which the code must earn with a request timeout.

## The rules

| Model | Rule | In plain words |
|---|---|---|
| DiagHeartbeat | NoFalseCrash | The title never asks about a crash of a session that is still open or ended cleanly. |
| DiagHeartbeat | NoLostCrash | A session that dies stays detectable until a later load picks it up. |
| DiagHeartbeat | OneReportPerCrash | One crash is reported at most once, however many tabs load and whatever the player taps. |
| DiagSend | NoManualSendWithoutConsent | Nothing sent by hand leaves the browser before the consent sheet was confirmed once. |
| DiagSend | CallsignOnlyWhenTicked | The callsign goes only when ticked; an automatic summary never carries it. |
| DiagSend | AutoOnlyWhenOn | Automatic summaries go only while the setting is on. |
| DiagSend | EverySendAnswered | Every send ends with the thank-you and report id, or a message that it did not go. |
| DiagSend | SendEnds | A send never hangs: one of the two shows in the end (needs a request timeout). |

`DiagHeartbeat.cfg` and `DiagSend.cfg` check the fixed design, where every rule holds. The `.findings.cfg` files
check the design as written: all three heartbeat rules break, and EverySendAnswered and SendEnds break.

## Run it

```sh
node tools/formal/tlc.mjs DiagHeartbeat --mutants
node tools/formal/tlc.mjs DiagSend --mutants
```

Java 11 or newer on PATH. About a second each (2,452 and 352 distinct states). Each mutant takes one part of the fix or
one guard out of a scratch copy and must make TLC report the rule its entry names; a mutant that passes means the
model can no longer see it. To see the paths the plan as written takes, or to redraw the charts, give the pstack
`/statechart` skill a model with its `.findings.cfg`.

## When KONG-71 is built

Then these models describe code, and they need what the other models in tools/formal have:

1. Name each action's function in the action's comment (the heartbeat writer, the load-time check, the prompt, the
   sheet, the uploader, the automatic sender) and fix any action the code does differently. A difference is either a
   bug in the code or a model that was wrong about the plan; say which.
2. Add `<Model>.covers.json` with one region per function and `writes` patterns for the heartbeat records and the
   consent and settings flags, then run `node tools/formal/tlc.mjs <Model> --mutants --record`. From then on npm test's
   `formal` check fails when that code changes without the model being re-checked.
3. Confirm each rule against the real code: two tabs of one Playwright browser context share `localStorage` and Web
   Locks, a killed page is `page.close({ runBeforeUnload: false })` or a crashed renderer, and a refused upload is the
   local server's rate limit. Only test against a server you run.

## What it does not cover

Time is a step: "5 s" is a beat that may or may not happen before a kill. Bundle contents, sizes, the server's spool,
and the triage pipeline are out of scope; only whether a report is sent, and how many, is modelled. The send model is
one tab; the heartbeat model is the only place two tabs meet.
