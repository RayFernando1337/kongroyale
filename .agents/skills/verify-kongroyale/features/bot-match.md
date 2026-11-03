# Bot match

Play starts an offline practice match against 49 bots, run by the simulation inside the browser. The player spawns on
the warm-up beach, boards the Banana Co. plane, and drops onto the island; the HUD shows players alive, kills, hp,
shield, the minimap and the storm timer.

## Sub-features

- `match-start` Play puts the page in a match (`__kr.game.inMatch`) with 50 players alive.
- `match-warmup` the warm-up on the beach while the island streams in.
- `match-plane` the plane phase follows (`state().phase` moves from 0 to 1 within about 30 s).
- `match-fps` frame rate recovers to the display rate once streaming ends.

## How to get to it (user POV)

- Press the yellow Play button on the title.
- Press Enter on the title with nothing focused.
- (Dev title only) pick Trios or Solo and Easy / Standard / Hard first.

## Driving it with kr-verify

Preconditions:

- `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs doctor` is ok.

- **Start.** Run `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs play --seed 42` (`--secs 60` default, 20 on `nogpu`). The helper clicks `button.tn-play-cta` and waits for `inMatch`.
- **Advance.** Samples at 5/15/30/60 s land in `result.json` `samples[]`: `fps`, `state.phase`, `alive`, `hp`, `actors`.
- **Proof.** `play-05s.png` (warm-up), `play-30s.png` / `play-60s.png` (plane, HUD with 50 alive and the auto-jump timer). Mac reference: fps 6 at 5 s, 60 from 15 s.

## Gotchas

- fps is 2-6 for the first ~15 s while the island streams; judge from the 30 s sample.
- Same `--seed`, same plane path, storm and loot: use it to compare before and after a change.
- Enter only plays when focus is on the page body; a focused input keeps its own Enter.
