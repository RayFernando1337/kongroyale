# Private lobby

Two players on one game server: the host opens Friends, chooses Create lobby and gets a short code; the friend opens
Friends, types the code and chooses Join; the host presses Start match and both land in the same 50-player match (bots
fill the empty seats). This is the only browser path that exercises the real server, the wire protocol and
prediction against a live socket.

## Sub-features

- `room-create` Create lobby shows a room code in `.tn-play-roomcode` and "Private lobby · You're the host".
- `room-join` the guest joins by code and sees the same code.
- `room-start` Start match puts both clients in the match with a measured ping.

## How to get to it (user POV)

- Title, `Friends` (top right), `Create lobby`; the friend uses `Friends`, the `Lobby code` box and `Join`.
- An invite link from the host's copy button (not driven by the helper).

## Driving it with kr-verify

Preconditions:

- `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs up` started the game server with `KR_EVENT_MODE=0` (event mode refuses to create rooms). GPU profile.

- **Create.** Run `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs room`. The host page (`?debug&dev`) opens Friends and clicks Create lobby; the code is read from `.tn-play-roomcode`.
- **Join.** The guest page fills `Lobby code` and clicks Join, then waits for the same code.
- **Start.** The host clicks `button.tn-play-cta` (Start match); both pages must reach `inMatch`.
- **Proof.** `room-0-host-lobby.png`, `room-0-guest-lobby.png`, `room-1-host-match.png`, `room-1-guest-match.png`; `result.json` has `code` and both `state.ping` values (12 and 50 ms on the Mac).

## Gotchas

- `?dev` is needed on a built bundle: the playtest title hides Friends.
- Both clients share one GPU, so each runs at about half the fps of a single window.
- Two headed windows can leave the unfocused one on the pause menu; the helper's headless contexts avoid it.
