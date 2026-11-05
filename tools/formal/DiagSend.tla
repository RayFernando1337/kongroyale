------------------------------ MODULE DiagSend ------------------------------
(* KONG-71's planned player-side diagnostics flow, one tab (Captain drive plans/player-diagnostics.md, section 1): the
   Send diagnostics and Report a problem buttons, the consent sheet on the first send, the automatic variant, the
   crash prompt on the title, and what the player sees after a send. Not built yet: this models the design as
   written. The server's answer to an upload is accepted or refused (rate limit 20 per address per 10 min, 300 per hour,
   a full spool or bundle folder: section 2). *)
EXTENDS Naturals

CONSTANTS RefusedShown   \* the design as written says nothing about a refused send: FALSE; the proposed fix: TRUE

VARIABLES
  screen,     \* "title" | "crash" (title asking about the last session) | "match" | "menu" (match menu or results card)
              \* | "sheet" (consent sheet) | "note" (Report a problem: chip and note) | "sending" | "sent" | "refused"
  consented,  \* the player confirmed the consent sheet once (remembered)
  tick,       \* "Include my callsign" is ticked (remembered with the sheet)
  autoOn,     \* "Send anonymous performance stats automatically" (remembered, in Settings)
  sent,       \* what went to the server: a set of records
  back        \* where the toast returns to
vars == <<screen, consented, tick, autoOn, sent, back>>

Rec(kind, cs) == [kind |-> kind, callsign |-> cs, ticked |-> tick, consented |-> consented, auto |-> autoOn]
\* a send by hand: at once with the remembered ticks after the first time, else the sheet first
SendNow ==
  IF consented
    THEN screen' = "sending" /\ sent' = sent \cup {Rec("manual", tick)}
    ELSE screen' = "sheet" /\ sent' = sent

Init == screen \in {"title", "crash"} /\ consented = FALSE /\ tick = FALSE /\ autoOn = FALSE /\ sent = {} /\ back = "title"

Play == screen = "title" /\ screen' = "match" /\ UNCHANGED <<consented, tick, autoOn, sent, back>>
OpenMenu == screen = "match" /\ screen' = "menu" /\ UNCHANGED <<consented, tick, autoOn, sent, back>>
CloseMenu == screen = "menu" /\ screen' = "match" /\ UNCHANGED <<consented, tick, autoOn, sent, back>>
EndMatch == screen \in {"match", "menu"} /\ screen' = "title" /\ UNCHANGED <<consented, tick, autoOn, sent, back>>

(* Send diagnostics (menu, results) or the crash prompt's button: the first send opens the sheet; later sends go at
   once with the remembered ticks *)
Send ==
  /\ screen \in {"menu", "crash"}
  /\ back' = IF screen = "crash" THEN "title" ELSE "menu"
  /\ SendNow
  /\ UNCHANGED <<consented, tick, autoOn>>
\* Report a problem: a chip and a note first, then the same send
Report == screen = "menu" /\ screen' = "note" /\ back' = "menu" /\ UNCHANGED <<consented, tick, autoOn, sent>>
NoteDone ==
  /\ screen = "note"
  /\ SendNow
  /\ UNCHANGED <<consented, tick, autoOn, back>>
\* the sheet: Send (choosing the callsign tick) or Cancel
SheetSend == screen = "sheet" /\ \E t \in BOOLEAN :
  /\ consented' = TRUE /\ tick' = t
  /\ screen' = "sending" /\ sent' = sent \cup {[kind |-> "manual", callsign |-> t, ticked |-> t, consented |-> TRUE, auto |-> autoOn]}
  /\ UNCHANGED <<autoOn, back>>
SheetCancel == screen = "sheet" /\ screen' = back /\ UNCHANGED <<consented, tick, autoOn, sent, back>>
DismissCrash == screen = "crash" /\ screen' = "title" /\ UNCHANGED <<consented, tick, autoOn, sent, back>>

\* the server answers: "Sent, thanks. Report KB-123." only on an accepted upload
Accepted == screen = "sending" /\ screen' = "sent" /\ UNCHANGED <<consented, tick, autoOn, sent, back>>
Refused == screen = "sending" /\ screen' = (IF RefusedShown THEN "refused" ELSE back) /\ UNCHANGED <<consented, tick, autoOn, sent, back>>
ToastGone == screen \in {"sent", "refused"} /\ screen' = back /\ UNCHANGED <<consented, tick, autoOn, sent, back>>

\* the automatic variant: a long frame or a match end sends a summary, only with the setting on; never a callsign
Auto == screen = "match" /\ autoOn /\ sent' = sent \cup {[kind |-> "auto", callsign |-> FALSE, ticked |-> tick, consented |-> consented, auto |-> autoOn]}
  /\ UNCHANGED <<screen, consented, tick, autoOn, back>>
Settings == screen \in {"title", "menu"} /\ autoOn' = ~autoOn /\ UNCHANGED <<screen, consented, tick, sent, back>>

Next == Play \/ OpenMenu \/ CloseMenu \/ EndMatch \/ Send \/ Report \/ NoteDone \/ SheetSend \/ SheetCancel \/ DismissCrash
  \/ Accepted \/ Refused \/ ToastGone \/ Auto \/ Settings
Spec == Init /\ [][Next]_vars

(* --- the rules --- *)
\* Nothing a player sends by hand leaves the browser before they confirmed the consent sheet once.
NoManualSendWithoutConsent == \A r \in sent : r.kind = "manual" => r.consented
\* The callsign goes only in a send where "Include my callsign" was ticked; an automatic summary never has it.
CallsignOnlyWhenTicked == \A r \in sent : r.callsign => r.kind = "manual" /\ r.ticked
\* Automatic summaries go only while the setting is on.
AutoOnlyWhenOn == \A r \in sent : r.kind = "auto" => r.auto
\* Every send ends with something on screen: the thank-you with the report id, or a message that it did not go.
EverySendAnswered == [][screen = "sending" => screen' \in {"sent", "refused"}]_vars
=============================================================================
