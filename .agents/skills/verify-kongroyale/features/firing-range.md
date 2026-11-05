# Firing range

The firing range is a solo practice area with every weapon on the ground, infinite ammo, and targets from 10 to 205 m.
The HUD reads "Practice · Infinite ammo"; Esc opens the menu and the shooting analytics.

## Sub-features

- `range-open` the Firing range button starts the range (`__kr.game.render.range` set, `inMatch` true).
- `range-move` holding W moves the kong (position changes in `state()`).
- `range-hud` the practice HUD, weapon hotbar and ammo counter render.

## How to get to it (user POV)

- Choose `Firing range` under the Play button on the title.
- Training tab, then the Firing range tile, or Enter while the Training tab is open.

## Driving it with kr-verify

Preconditions:

- `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs doctor` is ok. GPU profile (not run on `nogpu`).

- **Open.** Run `node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs range`. The helper clicks the `Firing range` button in `.tn-play-links` and waits for the range.
- **Move.** It clicks the centre of the viewport, waits for pointer lock, holds W for 2 s, and compares `state().x/z` before and after. `pointerLocked` must be true and `walkedM` over 1 (about 9 m on the Mac).
- **Proof.** `range-0-spawn.png` and `range-1-after-walk.png` (practice HUD, weapon in hand, 30/300 ammo).

## Gotchas

- Headless Chrome and Playwright's headless shell both grant pointer lock to the canvas click (checked on Linux: Chrome 156 and headless shell 151). Keys move the kong without it, so a walk alone doesn't prove the click reached the game, which is why `range` also requires `pointerLocked`.
- The coaching card ("Sprint, slide and crouch...") overlays the bottom left on first visit; it is expected.
